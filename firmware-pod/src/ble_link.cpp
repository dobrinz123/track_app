#include "ble_link.h"

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

#include "gnss.h"
#include "imu.h"
#include "pod_state.h"
#include "timebase.h"

/* TX power cap: DESIGN-REV-A §10.3 mitigation 1, "BLE <= 9 dBm". */
static constexpr esp_power_level_t kBleTxPower = ESP_PWR_LVL_P9;
static constexpr uint16_t kPreferredMtu = 247;

static NimBLEServer *s_server = nullptr;
static NimBLECharacteristic *s_data = nullptr;
static NimBLECharacteristic *s_info = nullptr;
static volatile bool s_connected = false;
static volatile uint16_t s_conn_handle = 0xFFFF;
static volatile uint16_t s_mtu = 23;
static volatile bool s_subscribed = false;
static uint16_t s_seq = 0;
static uint32_t s_tx_ok = 0;
static uint32_t s_tx_drops = 0;
static uint32_t s_tx_too_big = 0;
static uint32_t s_ctrl_rx = 0;
static uint32_t s_last_status_ms = 0;
static QueueHandle_t s_ctrl_q = nullptr;

struct CtrlMsg {
  uint8_t len;
  uint8_t data[64];
};

/* ------------------------------------------------------------ send */

static void send_frame(const uint8_t *buf, size_t len) {
  if (!s_connected || !s_subscribed || s_data == nullptr) return;
  if (len == 0) return;
  if (len > (size_t)(s_mtu - 3)) { /* ATT notification payload = MTU - 3 */
    s_tx_too_big++;
    s_tx_drops++;
    return;
  }
  struct os_mbuf *om = ble_hs_mbuf_from_flat(buf, (uint16_t)len);
  if (om == nullptr) {
    s_tx_drops++;
    return;
  }
  /* consumes om on every path (NimBLE ble_gatts_notify_custom) */
  int rc = ble_gattc_notify_custom(s_conn_handle, s_data->getHandle(), om);
  if (rc == 0)
    s_tx_ok++;
  else
    s_tx_drops++;
}

/* The sequence number is taken for every frame the pod generates for the
 * connection, whether or not the stack accepts it: a local drop therefore
 * shows up as a gap on the phone (PROTOCOL.md "Loss detection"). */
static uint16_t next_seq() { return s_seq++; }

void ble_link_send_gnss(const pod_gnss_t *g) {
  if (!s_connected || !s_subscribed || !(g_pod.streams & POD_STREAM_GNSS)) return;
  uint8_t buf[POD_OVERHEAD + POD_GNSS_PAYLOAD_LEN];
  size_t n = pod_encode_gnss(next_seq(), g, buf, sizeof buf);
  send_frame(buf, n);
}

void ble_link_send_imu(const pod_imu_batch_t *b) {
  if (!s_connected || !s_subscribed || !(g_pod.streams & POD_STREAM_IMU)) return;
  uint8_t buf[POD_OVERHEAD + POD_IMU_HDR_LEN + POD_IMU_MAX_SAMPLES * POD_IMU_SAMPLE_LEN];
  size_t n = pod_encode_imu(next_seq(), b, buf, sizeof buf);
  send_frame(buf, n);
}

void ble_link_fill_status(pod_status_t *s) {
  memset(s, 0, sizeof *s);
  int64_t now = esp_timer_get_time();
  s->pod_us = (uint64_t)now;
  s->fw_major = FW_VERSION_MAJOR;
  s->fw_minor = FW_VERSION_MINOR;
  s->fw_patch = FW_VERSION_PATCH;
  s->hw_rev = FW_HW_REV;
  s->rate_hz = (uint8_t)g_pod.gnss.rate;
  s->hp_state = (uint8_t)g_pod.gnss.hp;
  s->pps_state = (uint8_t)tb_state(&g_pod.tb, now);
  uint8_t f = 0;
  if (g_pod.usb_power) f |= POD_ST_F_USB_POWER;
  if (g_pod.gnss.comm_ok) f |= POD_ST_F_GNSS_OK;
  if (g_pod.imu_ok) f |= POD_ST_F_IMU_OK;
  if (g_pod.streams & POD_STREAM_GNSS) f |= POD_ST_F_STREAM_GNSS;
  if (g_pod.streams & POD_STREAM_IMU) f |= POD_ST_F_STREAM_IMU;
  if (g_pod.wifi_on) f |= POD_ST_F_WIFI_ON;
  /* POD_ST_F_CHARGING_EN is never set on rev A */
  s->flags = f;
  if (g_pod.tb.anchored) {
    s->tb_anchor_pod_us = (uint64_t)g_pod.tb.anchor_pod_us;
    s->tb_anchor_unix_us = g_pod.tb.anchor_unix_us;
    s->tb_rate_ppb = tb_rate_ppb(&g_pod.tb);
  }
  if (g_pod.tb.have_pps) {
    int64_t age = (now - g_pod.tb.last_pps_pod_us) / 1000;
    s->pps_age_ms = age > 0xFFFFFFFELL ? 0xFFFFFFFEu : (uint32_t)age;
  } else {
    s->pps_age_ms = 0xFFFFFFFFu;
  }
  s->fix_type = g_pod.gnss.have_pvt ? g_pod.gnss.pvt.fix_type : 0;
  s->num_sv = g_pod.gnss.have_pvt ? g_pod.gnss.pvt.num_sv : 0;
  s->imu_decim = g_pod.imu_decim;
  s->tx_drops = s_tx_drops;
  s->imu_overruns = imu_overrun_count();
  s->ubx_errors = gnss_ubx_errors();
}

void ble_link_send_status_now() {
  if (!s_connected || !s_subscribed) return;
  pod_status_t st;
  ble_link_fill_status(&st);
  uint8_t buf[POD_OVERHEAD + POD_STATUS_PAYLOAD_LEN];
  size_t n = pod_encode_status(next_seq(), &st, buf, sizeof buf);
  send_frame(buf, n);
}

static void send_result(uint8_t opcode, uint8_t result, uint16_t echo_seq) {
  pod_control_result_t r = {opcode, result, echo_seq};
  uint8_t buf[POD_OVERHEAD + 4];
  size_t n = pod_encode_control_result(next_seq(), &r, buf, sizeof buf);
  send_frame(buf, n);
}

/* ------------------------------------------------------------ callbacks */

class ServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *srv, ble_gap_conn_desc *desc) override {
    s_conn_handle = desc->conn_handle;
    s_connected = true;
    s_subscribed = false;
    s_mtu = 23;
    s_seq = 0;
    /* request 2M PHY both ways (falls back to 1M if the phone refuses) and a
     * 7.5-15 ms connection interval, 4 s supervision timeout */
    ble_gap_set_prefered_le_phy(desc->conn_handle, BLE_GAP_LE_PHY_2M_MASK, BLE_GAP_LE_PHY_2M_MASK,
                                BLE_GAP_LE_PHY_CODED_ANY);
    srv->updateConnParams(desc->conn_handle, 6, 12, 0, 400);
  }
  void onDisconnect(NimBLEServer *, ble_gap_conn_desc *) override {
    s_connected = false;
    s_subscribed = false;
    s_conn_handle = 0xFFFF;
    g_pod.streams = 0; /* streams are per connection */
  }
  void onMTUChange(uint16_t mtu, ble_gap_conn_desc *) override { s_mtu = mtu; }
};

class DataCb : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic *, ble_gap_conn_desc *, uint16_t sub_value) override {
    s_subscribed = (sub_value & 0x0001) != 0; /* notifications bit */
  }
};

class ControlCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c) override {
    /* runs in the NimBLE host task: hand over to the main loop */
    NimBLEAttValue v = c->getValue();
    CtrlMsg m;
    m.len = (uint8_t)(v.length() > sizeof m.data ? sizeof m.data : v.length());
    memcpy(m.data, v.data(), m.len);
    if (s_ctrl_q) xQueueSend(s_ctrl_q, &m, 0);
  }
};

class InfoCb : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic *c) override {
    pod_status_t st;
    ble_link_fill_status(&st);
    uint8_t buf[POD_OVERHEAD + POD_STATUS_PAYLOAD_LEN];
    /* reads are not part of the notification sequence: seq = 0xFFFF */
    size_t n = pod_encode_status(0xFFFF, &st, buf, sizeof buf);
    c->setValue(buf, n);
  }
};

static ServerCb s_server_cb;
static DataCb s_data_cb;
static ControlCb s_ctrl_cb;
static InfoCb s_info_cb;

void ble_link_init() {
  s_ctrl_q = xQueueCreate(8, sizeof(CtrlMsg));
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_BT);
  char name[20];
  snprintf(name, sizeof name, "TRACE-Pod-%02X%02X", mac[4], mac[5]);
  NimBLEDevice::init(name);
  NimBLEDevice::setPower(kBleTxPower);
  NimBLEDevice::setMTU(kPreferredMtu);
  ble_gap_set_prefered_default_le_phy(BLE_GAP_LE_PHY_2M_MASK, BLE_GAP_LE_PHY_2M_MASK);

  s_server = NimBLEDevice::createServer();
  s_server->setCallbacks(&s_server_cb);
  s_server->advertiseOnDisconnect(true);
  NimBLEService *svc = s_server->createService(POD_BLE_SVC_UUID);
  s_data = svc->createCharacteristic(POD_BLE_DATA_UUID, NIMBLE_PROPERTY::NOTIFY);
  s_data->setCallbacks(&s_data_cb);
  NimBLECharacteristic *ctrl = svc->createCharacteristic(
      POD_BLE_CONTROL_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  ctrl->setCallbacks(&s_ctrl_cb);
  s_info = svc->createCharacteristic(POD_BLE_INFO_UUID, NIMBLE_PROPERTY::READ);
  s_info->setCallbacks(&s_info_cb);
  svc->start();

  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(POD_BLE_SVC_UUID);
  adv->setScanResponse(true);
  adv->start();
  Serial.printf("[ble] advertising as %s (TX cap +9 dBm, preferred MTU %u, 2M PHY requested)\n",
                name, kPreferredMtu);
}

static void handle_control(const CtrlMsg &m) {
  pod_frame_t f;
  pod_control_t c;
  s_ctrl_rx++;
  if (pod_decode_frame(m.data, m.len, &f) != POD_DEC_OK || pod_decode_control(&f, &c) != POD_DEC_OK) {
    uint16_t seq = m.len >= 4 ? (uint16_t)(m.data[2] | (m.data[3] << 8)) : 0;
    send_result(m.len >= 7 ? m.data[6] : 0, POD_RES_BAD_FRAME, seq);
    return;
  }
  uint8_t res = POD_RES_OK;
  switch (c.opcode) {
    case POD_OP_SET_STREAMS:
      if (c.arg_len != 1 || (c.args[0] & ~0x07)) {
        res = POD_RES_BAD_ARG;
        break;
      }
      g_pod.streams = c.args[0];
      break;
    case POD_OP_SET_RATE:
      if (c.arg_len != 1) {
        res = POD_RES_BAD_ARG;
        break;
      }
      res = gnss_set_rate(c.args[0]);
      break;
    case POD_OP_SET_IMU_DECIM:
      if (c.arg_len != 1 || !(c.args[0] == 1 || c.args[0] == 2 || c.args[0] == 4 || c.args[0] == 8)) {
        res = POD_RES_BAD_ARG;
        break;
      }
      imu_set_decimation(c.args[0]);
      break;
    case POD_OP_GET_STATUS:
      if (c.arg_len != 0) res = POD_RES_BAD_ARG;
      break;
    default:
      res = POD_RES_UNKNOWN_OPCODE;
      break;
  }
  send_result(c.opcode, res, c.seq);
  if (c.opcode == POD_OP_GET_STATUS && res == POD_RES_OK) ble_link_send_status_now();
}

void ble_link_service() {
  CtrlMsg m;
  while (s_ctrl_q && xQueueReceive(s_ctrl_q, &m, 0) == pdTRUE) handle_control(m);
  uint32_t now = millis();
  if (now - s_last_status_ms >= 1000) {
    s_last_status_ms = now;
    if (g_pod.streams & POD_STREAM_STATUS) ble_link_send_status_now();
  }
}

bool ble_link_connected() { return s_connected; }
uint16_t ble_link_mtu() { return s_mtu; }
uint32_t ble_link_tx_drops() { return s_tx_drops; }

void ble_link_print_info() {
  Serial.printf("ble: addr %s, %s", NimBLEDevice::getAddress().toString().c_str(),
                s_connected ? "CONNECTED" : "advertising");
  if (s_connected) {
    uint8_t tx = 0, rx = 0;
    ble_gap_read_le_phy(s_conn_handle, &tx, &rx);
    Serial.printf(", MTU %u, PHY tx %uM rx %uM, subscribed %d", s_mtu, tx, rx, s_subscribed);
  }
  Serial.printf("\n     streams 0x%02X, seq %u, notified %lu, drops %lu (too big %lu), control rx %lu\n",
                g_pod.streams, s_seq, (unsigned long)s_tx_ok, (unsigned long)s_tx_drops,
                (unsigned long)s_tx_too_big, (unsigned long)s_ctrl_rx);
}
