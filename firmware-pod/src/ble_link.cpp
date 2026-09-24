#include "ble_link.h"

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

#include "console_io.h"
#include "ctrl_sched.h"
#include "gnss.h"
#include "imu.h"
#include "pod_state.h"
#include "timebase.h"

/*
 * Threading (review fixes MEDIUM 4 / 5 / 10):
 *  - NimBLE callbacks run in the NimBLE host task (core 0). They only touch:
 *    s_connected / s_conn_handle / s_subscribed / s_mtu (single words),
 *    s_conn_gen (incremented on every connect AND disconnect), the two
 *    FreeRTOS queues, and the INFO snapshot under s_snap_mux.
 *  - Everything else (g_pod, the timebase, the stream mask, the sequence
 *    counter, all counters) is owned by the Arduino loop task. The loop
 *    notices a new connection generation and resets streams and seq itself.
 *  - Every queued control carries the generation it was written in; a
 *    control from an older generation is dropped unexecuted, and a result is
 *    only sent if the generation is still current after execution.
 *  - The loop executes at most ONE queued item per iteration, so console,
 *    BOOT, WiFi-test deadlines etc. run between controls.
 *  - Control-queue overflow is answered with CONTROL_RESULT BUSY (via a
 *    second small queue); only if that overflows too is it just counted.
 *  - (PODFW-REV2 M1) The session {connected, subscribed, handle, generation}
 *    is written by the NimBLE callbacks ONLY under s_sess_mux and read by
 *    the loop as one snapshot under the same lock. A dequeued control is
 *    executed only if, at that moment, it belongs to the CURRENT connected
 *    generation; every frame is sent only if the session snapshot taken
 *    for that send still has the frame's generation (results: the control's
 *    generation; streams: the loop's adopted generation), using the handle
 *    from the same snapshot.
 *  - (PODFW-REV2 M2) The control and overflow queues are served round-robin.
 */

/* TX power cap: DESIGN-REV-A §10.3 mitigation 1, "BLE <= 9 dBm". */
static constexpr esp_power_level_t kBleTxPower = ESP_PWR_LVL_P9;
static constexpr uint16_t kPreferredMtu = 247;
static constexpr uint32_t kSnapshotPeriodMs = 100;

static NimBLEServer *s_server = nullptr;
static NimBLECharacteristic *s_data = nullptr;
static NimBLECharacteristic *s_info = nullptr;
/* session: written by the NimBLE task under s_sess_mux only */
static portMUX_TYPE s_sess_mux = portMUX_INITIALIZER_UNLOCKED;
static bool s_connected = false;
static uint16_t s_conn_handle = 0xFFFF;
static bool s_subscribed = false;
static uint32_t s_conn_gen = 0;
static volatile uint16_t s_mtu = 23;
static volatile uint32_t s_ctrl_lost = 0; /* overflowed both queues */
/* loop-owned */
static uint32_t s_loop_gen = 0;
static uint16_t s_seq = 0;
static uint32_t s_tx_ok = 0;
static uint32_t s_tx_drops = 0;
static uint32_t s_tx_too_big = 0;
static uint32_t s_ctrl_rx = 0;
static uint32_t s_ctrl_stale = 0;
static uint32_t s_ctrl_busy = 0;
static uint32_t s_last_status_ms = 0;
static uint32_t s_last_snap_ms = 0;
static QueueHandle_t s_ctrl_q = nullptr;
static QueueHandle_t s_ovf_q = nullptr;
static uint8_t s_sched_turn = 0; /* ctrl_sched.h round-robin state */
/* INFO snapshot (loop writes, NimBLE task reads) */
static portMUX_TYPE s_snap_mux = portMUX_INITIALIZER_UNLOCKED;
static uint8_t s_snap[POD_OVERHEAD + POD_STATUS_PAYLOAD_LEN];
static size_t s_snap_len = 0;

struct CtrlMsg {
  uint32_t gen;
  uint8_t len;
  uint8_t data[64];
};

struct OvfMsg {
  uint32_t gen;
  uint16_t seq;
  uint8_t opcode;
};

struct Session {
  bool connected;
  bool subscribed;
  uint16_t handle;
  uint32_t gen;
};

/* One consistent snapshot of the session (same lock as the callbacks). */
static Session session_get() {
  Session x;
  portENTER_CRITICAL(&s_sess_mux);
  x.connected = s_connected;
  x.subscribed = s_subscribed;
  x.handle = s_conn_handle;
  x.gen = s_conn_gen;
  portEXIT_CRITICAL(&s_sess_mux);
  return x;
}

/* True if `gen` is the current, connected session right now. */
static bool session_is(uint32_t gen) {
  Session x = session_get();
  return x.connected && x.gen == gen;
}

/* Streams may go out only on the connection the loop has adopted. */
static bool link_ready() {
  Session x = session_get();
  return x.connected && x.subscribed && s_data != nullptr && x.gen == s_loop_gen;
}

/* ------------------------------------------------------------ send */

/* Sends only if the session is still generation `gen` (and subscribed); the
 * connection handle comes from the same snapshot as the generation. */
static void send_frame(const uint8_t *buf, size_t len, uint32_t gen) {
  if (len == 0 || s_data == nullptr) return;
  Session x = session_get();
  if (!x.connected || !x.subscribed || x.gen != gen || x.gen != s_loop_gen) return;
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
  int rc = ble_gattc_notify_custom(x.handle, s_data->getHandle(), om);
  if (rc == 0)
    s_tx_ok++;
  else
    s_tx_drops++;
}

/* Taken for every frame generated for the connection, whether or not the
 * stack accepts it: a local drop shows up as a gap (PROTOCOL.md §7.1). Only
 * the loop task touches s_seq. */
static uint16_t next_seq() { return s_seq++; }

void ble_link_send_gnss(const pod_gnss_t *g) {
  if (!link_ready() || !(g_pod.streams & POD_STREAM_GNSS)) return;
  uint8_t buf[POD_OVERHEAD + POD_GNSS_PAYLOAD_LEN];
  size_t n = pod_encode_gnss(next_seq(), g, buf, sizeof buf);
  send_frame(buf, n, s_loop_gen);
}

void ble_link_send_imu(const pod_imu_batch_t *b) {
  if (!link_ready() || !(g_pod.streams & POD_STREAM_IMU)) return;
  uint8_t buf[POD_OVERHEAD + POD_IMU_HDR_LEN + POD_IMU_MAX_SAMPLES * POD_IMU_SAMPLE_LEN];
  size_t n = pod_encode_imu(next_seq(), b, buf, sizeof buf);
  send_frame(buf, n, s_loop_gen);
}

/* Loop task only (reads g_pod and the timebase, which the loop owns). */
void ble_link_fill_status(pod_status_t *s) {
  memset(s, 0, sizeof *s);
  int64_t now = esp_timer_get_time();
  s->pod_us = (uint64_t)now;
  s->fw_major = FW_VERSION_MAJOR;
  s->fw_minor = FW_VERSION_MINOR;
  s->fw_patch = FW_VERSION_PATCH;
  s->hw_rev = FW_HW_REV;
  s->rate_hz = g_pod.gnss.rate_verified ? (uint8_t)g_pod.gnss.rate : 0;
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

/* Publish a consistent STATUS snapshot for INFO reads (review fix MEDIUM 5):
 * built entirely in the loop task, copied under a spinlock. */
static void publish_snapshot() {
  s_last_snap_ms = millis();
  pod_status_t st;
  ble_link_fill_status(&st);
  uint8_t buf[sizeof s_snap];
  size_t n = pod_encode_status(0xFFFF, &st, buf, sizeof buf); /* reads: seq 0xFFFF */
  portENTER_CRITICAL(&s_snap_mux);
  memcpy(s_snap, buf, n);
  s_snap_len = n;
  portEXIT_CRITICAL(&s_snap_mux);
}

void ble_link_send_status_now() {
  if (!link_ready()) return;
  pod_status_t st;
  ble_link_fill_status(&st);
  uint8_t buf[POD_OVERHEAD + POD_STATUS_PAYLOAD_LEN];
  size_t n = pod_encode_status(next_seq(), &st, buf, sizeof buf);
  send_frame(buf, n, s_loop_gen);
}

/* A result belongs to the control's generation, never to a later session. */
static void send_result(uint8_t opcode, uint8_t result, uint16_t echo_seq, uint32_t gen) {
  pod_control_result_t r = {opcode, result, echo_seq};
  uint8_t buf[POD_OVERHEAD + 4];
  size_t n = pod_encode_control_result(next_seq(), &r, buf, sizeof buf);
  send_frame(buf, n, gen);
}

/* ------------------------------------------------------------ callbacks */

class ServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *srv, ble_gap_conn_desc *desc) override {
    s_mtu = 23;
    portENTER_CRITICAL(&s_sess_mux);
    s_conn_handle = desc->conn_handle;
    s_subscribed = false;
    s_conn_gen = s_conn_gen + 1; /* the loop resets streams + seq on this */
    s_connected = true;
    portEXIT_CRITICAL(&s_sess_mux);
    /* request 2M PHY both ways (falls back to 1M if the phone refuses) and a
     * 7.5-15 ms connection interval, 4 s supervision timeout */
    ble_gap_set_prefered_le_phy(desc->conn_handle, BLE_GAP_LE_PHY_2M_MASK, BLE_GAP_LE_PHY_2M_MASK,
                                BLE_GAP_LE_PHY_CODED_ANY);
    srv->updateConnParams(desc->conn_handle, 6, 12, 0, 400);
  }
  void onDisconnect(NimBLEServer *, ble_gap_conn_desc *) override {
    portENTER_CRITICAL(&s_sess_mux);
    s_connected = false;
    s_subscribed = false;
    s_conn_handle = 0xFFFF;
    s_conn_gen = s_conn_gen + 1; /* invalidates everything queued so far */
    portEXIT_CRITICAL(&s_sess_mux);
    if (s_ctrl_q) xQueueReset(s_ctrl_q);
    if (s_ovf_q) xQueueReset(s_ovf_q);
  }
  void onMTUChange(uint16_t mtu, ble_gap_conn_desc *) override { s_mtu = mtu; }
};

class DataCb : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic *, ble_gap_conn_desc *, uint16_t sub_value) override {
    portENTER_CRITICAL(&s_sess_mux);
    s_subscribed = (sub_value & 0x0001) != 0; /* notifications bit */
    portEXIT_CRITICAL(&s_sess_mux);
  }
};

class ControlCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c) override {
    /* NimBLE host task: tag with the connection generation, hand to the loop */
    NimBLEAttValue v = c->getValue();
    CtrlMsg m;
    portENTER_CRITICAL(&s_sess_mux);
    m.gen = s_conn_gen;
    portEXIT_CRITICAL(&s_sess_mux);
    m.len = (uint8_t)(v.length() > sizeof m.data ? sizeof m.data : v.length());
    memcpy(m.data, v.data(), m.len);
    if (s_ctrl_q && xQueueSend(s_ctrl_q, &m, 0) == pdTRUE) return;
    /* queue full: answer BUSY from the loop (seq/opcode from the raw bytes) */
    OvfMsg o;
    o.gen = m.gen;
    o.seq = m.len >= 4 ? (uint16_t)(m.data[2] | (m.data[3] << 8)) : 0;
    o.opcode = m.len >= 7 ? m.data[6] : 0;
    if (!(s_ovf_q && xQueueSend(s_ovf_q, &o, 0) == pdTRUE)) s_ctrl_lost = s_ctrl_lost + 1;
  }
};

class InfoCb : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic *c) override {
    uint8_t buf[sizeof s_snap];
    size_t n;
    portENTER_CRITICAL(&s_snap_mux);
    n = s_snap_len;
    memcpy(buf, s_snap, n);
    portEXIT_CRITICAL(&s_snap_mux);
    c->setValue(buf, n);
  }
};

static ServerCb s_server_cb;
static DataCb s_data_cb;
static ControlCb s_ctrl_cb;
static InfoCb s_info_cb;

void ble_link_init() {
  s_ctrl_q = xQueueCreate(8, sizeof(CtrlMsg));
  s_ovf_q = xQueueCreate(8, sizeof(OvfMsg));
  publish_snapshot();
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
  con_printf("[ble] advertising as %s (TX cap +9 dBm, preferred MTU %u, 2M PHY requested)\n",
             name, kPreferredMtu);
}

static void handle_control(const CtrlMsg &m) {
  pod_frame_t f;
  pod_control_t c;
  s_ctrl_rx++;
  if (pod_decode_frame(m.data, m.len, &f) != POD_DEC_OK || pod_decode_control(&f, &c) != POD_DEC_OK) {
    uint16_t seq = m.len >= 4 ? (uint16_t)(m.data[2] | (m.data[3] << 8)) : 0;
    send_result(m.len >= 7 ? m.data[6] : 0, POD_RES_BAD_FRAME, seq, m.gen);
    return;
  }
  uint8_t res = POD_RES_OK;
  switch (c.opcode) {
    case POD_OP_SET_STREAMS:
      if (c.arg_len != 1 || (c.args[0] & ~0x07)) {
        res = POD_RES_BAD_ARG;
        break;
      }
      if (session_is(m.gen)) g_pod.streams = c.args[0]; /* never into another session */
      break;
    case POD_OP_SET_RATE:
      if (c.arg_len != 1) {
        res = POD_RES_BAD_ARG;
        break;
      }
      res = gnss_set_rate(c.args[0]); /* may block ~2.5 s (PPS/IMU still serviced) */
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
  /* the peer may have gone (or a new one come) during a blocking operation:
   * then no result, and the new connection starts clean */
  if (!session_is(m.gen)) {
    s_ctrl_stale++;
    return;
  }
  send_result(c.opcode, res, c.seq, m.gen); /* refused by send_frame if the session changed */
  if (c.opcode == POD_OP_GET_STATUS && res == POD_RES_OK) ble_link_send_status_now();
}

void ble_link_service() {
  /* adopt a new connection generation: streams off, seq from 0 */
  uint32_t gen = session_get().gen;
  if (gen != s_loop_gen) {
    s_loop_gen = gen;
    g_pod.streams = 0;
    s_seq = 0;
  }
  /* at most ONE queued item per loop iteration (MEDIUM 10), the two queues
   * served round-robin (PODFW-REV2 M2) */
  bool has_ctrl = s_ctrl_q && uxQueueMessagesWaiting(s_ctrl_q) > 0;
  bool has_ovf = s_ovf_q && uxQueueMessagesWaiting(s_ovf_q) > 0;
  OvfMsg o;
  CtrlMsg m;
  switch (ctrl_sched_next(has_ctrl, has_ovf, &s_sched_turn)) {
    case CS_OVERFLOW:
      if (xQueueReceive(s_ovf_q, &o, 0) == pdTRUE) {
        s_ctrl_busy++;
        send_result(o.opcode, POD_RES_BUSY, o.seq, o.gen);
      }
      break;
    case CS_CONTROL:
      if (xQueueReceive(s_ctrl_q, &m, 0) == pdTRUE) {
        /* PODFW-REV2 M1: bound to the CURRENT connected generation at the
         * moment of execution (same lock as the callbacks) */
        if (session_is(m.gen) && m.gen == s_loop_gen)
          handle_control(m);
        else
          s_ctrl_stale++; /* from an earlier connection: dropped unexecuted */
      }
      break;
    default: break;
  }
  uint32_t now = millis();
  if (now - s_last_status_ms >= 1000) {
    s_last_status_ms = now;
    if (g_pod.streams & POD_STREAM_STATUS) ble_link_send_status_now();
  }
  ble_link_publish_if_due();
}

/* PODFW-REV2 L1: also called from pod_yield(), so INFO stays <= ~100 ms old
 * during blocking GNSS operations. Loop task only. */
void ble_link_publish_if_due() {
  if (millis() - s_last_snap_ms >= kSnapshotPeriodMs) publish_snapshot();
}

bool ble_link_connected() { return session_get().connected; }
uint16_t ble_link_mtu() { return s_mtu; }
uint32_t ble_link_tx_drops() { return s_tx_drops; }

void ble_link_print_info() {
  Session x = session_get();
  con_printf("ble: addr %s, %s", NimBLEDevice::getAddress().toString().c_str(),
             x.connected ? "CONNECTED" : "advertising");
  if (x.connected) {
    uint8_t tx = 0, rx = 0;
    ble_gap_read_le_phy(x.handle, &tx, &rx);
    con_printf(", MTU %u, PHY tx %uM rx %uM, subscribed %d", s_mtu, tx, rx, x.subscribed);
  }
  con_printf("\n     streams 0x%02X, seq %u, notified %lu, drops %lu (too big %lu)\n", g_pod.streams,
             s_seq, (unsigned long)s_tx_ok, (unsigned long)s_tx_drops,
             (unsigned long)s_tx_too_big);
  con_printf("     control rx %lu, stale dropped %lu, busy (queue full) %lu, lost %lu, gen %lu\n",
             (unsigned long)s_ctrl_rx, (unsigned long)s_ctrl_stale, (unsigned long)s_ctrl_busy,
             (unsigned long)s_ctrl_lost, (unsigned long)s_loop_gen);
}
