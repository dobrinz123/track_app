#include "gnss.h"

#include <Arduino.h>
#include <esp_timer.h>
#include <string.h>

#include "ble_link.h"
#include "board_pins.h"
#include "gnss_config.h"
#include "pod_protocol.h"
#include "pod_state.h"
#include "timebase.h"

static HardwareSerial &GnssSerial = Serial1;

static ubx_parser_t s_parser;
static bool s_raw_monitor = false;
static bool s_bridge = false;
static gnss_sat_listener_t s_sat_listener = nullptr;

/* ACK wait state */
static bool s_wait_active = false;
static uint8_t s_wait_cls = 0, s_wait_id = 0;
static int s_wait_result = 0; /* 0 pending, 1 ACK, -1 NAK */
/* OTP ACK counter (IM step 3 expects two identical ACK-ACK frames) */
static int s_otp_acks = 0;
/* VALGET / MON-VER capture */
static bool s_valget_got = false;
static uint8_t s_valget_payload[128];
static uint16_t s_valget_len = 0;
static bool s_monver_got = false;
/* OTP preflight window */
static uint32_t s_preflight_until_ms = 0;
static bool s_preflight_valid = false;

/* ------------------------------------------------------------ helpers */

static void print_hex(const uint8_t *p, size_t n) {
  for (size_t i = 0; i < n; i++) Serial.printf("%02X%s", p[i], (i + 1) % 24 == 0 ? "\n" : " ");
  if (n % 24) Serial.println();
}

static void send_bytes(const uint8_t *p, size_t n) {
  GnssSerial.write(p, n);
  GnssSerial.flush(); /* wait until shifted out */
}

static void handle_pvt(const ubx_frame_t *f) {
  int64_t rx = esp_timer_get_time();
  ubx_nav_pvt_t p;
  if (!ubx_decode_nav_pvt(f->payload, f->len, &p)) return;
  GnssState &g = g_pod.gnss;
  g.pvt = p;
  g.have_pvt = true;
  g.pvt_count++;
  g.last_pvt_us = rx;

  const uint8_t dt = UBX_PVT_VALID_DATE | UBX_PVT_VALID_TIME;
  bool unix_valid = (p.valid & dt) == dt;
  int64_t unix_us = 0;
  if (unix_valid) {
    unix_us = tb_utc_to_unix_us(p.year, p.month, p.day, p.hour, p.min, p.sec, p.nano);
    /* only a fully resolved time may (re)anchor the PPS second */
    if (p.valid & UBX_PVT_FULLY_RESOLVED) tb_on_pvt(&g_pod.tb, rx, unix_us);
  }

  pod_gnss_t o;
  memset(&o, 0, sizeof o);
  int64_t pod_us = rx;
  uint8_t flags = 0;
  if (unix_valid && tb_unix_to_pod(&g_pod.tb, unix_us, &pod_us)) flags |= POD_GNSS_F_POD_TIME_FROM_PPS;
  else pod_us = rx;
  o.pod_us = (uint64_t)pod_us;
  o.unix_us = unix_valid ? unix_us : 0;
  o.itow_ms = p.itow_ms;
  o.lat_e7 = p.lat_e7;
  o.lon_e7 = p.lon_e7;
  o.hmsl_mm = p.hmsl_mm;
  o.vel_n_mm_s = p.vel_n_mm_s;
  o.vel_e_mm_s = p.vel_e_mm_s;
  o.vel_d_mm_s = p.vel_d_mm_s;
  o.g_speed_mm_s = p.g_speed_mm_s;
  o.head_mot_e5 = p.head_mot_e5;
  o.h_acc_mm = p.h_acc_mm;
  o.v_acc_mm = p.v_acc_mm;
  o.s_acc_mm_s = p.s_acc_mm_s;
  o.head_acc_e5 = p.head_acc_e5;
  o.t_acc_ns = p.t_acc_ns;
  o.p_dop_e2 = p.p_dop_e2;
  o.fix_type = p.fix_type;
  o.num_sv = p.num_sv;
  if (p.flags & UBX_PVT_FLAGS_GNSS_FIX_OK) flags |= POD_GNSS_F_FIX_OK;
  if (p.flags & UBX_PVT_FLAGS_DIFF_SOLN) flags |= POD_GNSS_F_DIFF_SOLN;
  if (p.flags3 & UBX_PVT_FLAGS3_INVALID_LLH) flags |= POD_GNSS_F_INVALID_LLH;
  if (p.valid & UBX_PVT_VALID_DATE) flags |= POD_GNSS_F_VALID_DATE;
  if (p.valid & UBX_PVT_VALID_TIME) flags |= POD_GNSS_F_VALID_TIME;
  if (p.valid & UBX_PVT_FULLY_RESOLVED) flags |= POD_GNSS_F_FULLY_RESOLVED;
  if (unix_valid) flags |= POD_GNSS_F_UNIX_VALID;
  o.flags = flags;
  o.rate_hz = (uint8_t)g.rate;
  ble_link_send_gnss(&o);
}

static void copy_str(char *dst, const uint8_t *src, size_t n) {
  size_t i = 0;
  for (; i < n && src[i]; i++) dst[i] = (char)src[i];
  dst[i] = 0;
}

static void on_frame(const ubx_frame_t *f, void *) {
  GnssState &g = g_pod.gnss;
  g.last_frame_us = esp_timer_get_time();

  if (s_raw_monitor) {
    Serial.printf("[ubx] %02X %02X len %u:", f->cls, f->id, f->len);
    size_t n = f->len > 32 ? 32 : f->len;
    for (size_t i = 0; i < n; i++) Serial.printf(" %02X", f->payload[i]);
    Serial.println(f->len > 32 ? " ..." : "");
  }

  bool is_ack;
  uint8_t acls, aid;
  if (ubx_decode_ack(f, &is_ack, &acls, &aid)) {
    if (s_wait_active && acls == s_wait_cls && aid == s_wait_id && s_wait_result == 0)
      s_wait_result = is_ack ? 1 : -1;
    /* literal comparison with IM step 3: B5 62 05 01 02 00 06 41 4F 78 */
    uint8_t rebuilt[10];
    if (ubx_build(f->cls, f->id, f->payload, f->len, rebuilt, sizeof rebuilt) == 10 &&
        memcmp(rebuilt, HP_OTP_EXPECTED_ACK, 10) == 0)
      s_otp_acks++;
    return;
  }
  if (f->cls == UBX_CLS_NAV && f->id == UBX_ID_NAV_PVT) {
    handle_pvt(f);
    return;
  }
  if (f->cls == UBX_CLS_NAV && f->id == UBX_ID_NAV_SAT) {
    if (ubx_decode_nav_sat(f->payload, f->len, &g.sat)) {
      g.have_sat = true;
      g.sat_count++;
      if (s_sat_listener) s_sat_listener(&g.sat);
    }
    return;
  }
  if (f->cls == UBX_CLS_CFG && f->id == UBX_ID_CFG_VALGET) {
    s_valget_len = f->len > sizeof s_valget_payload ? sizeof s_valget_payload : f->len;
    memcpy(s_valget_payload, f->payload, s_valget_len);
    s_valget_got = true;
    return;
  }
  if (f->cls == UBX_CLS_MON && f->id == UBX_ID_MON_VER && f->len >= 40) {
    copy_str(g.mon_sw, f->payload, 30);
    copy_str(g.mon_hw, f->payload + 30, 10);
    g.mon_ext_n = 0;
    for (size_t off = 40; off + 30 <= f->len && g.mon_ext_n < 6; off += 30)
      copy_str(g.mon_ext[g.mon_ext_n++], f->payload + off, 30);
    s_monver_got = true;
    return;
  }
}

static void pump_uart() {
  uint8_t buf[256];
  int avail;
  while ((avail = GnssSerial.available()) > 0) {
    int n = GnssSerial.readBytes(buf, avail > (int)sizeof buf ? sizeof buf : avail);
    if (n <= 0) break;
    ubx_parser_push(&s_parser, buf, (size_t)n, on_frame, nullptr);
  }
}

/* Wait for a condition while keeping PPS/IMU serviced and the UART parsed. */
template <typename F>
static bool wait_for(F cond, uint32_t timeout_ms) {
  uint32_t t0 = millis();
  while (millis() - t0 < timeout_ms) {
    pump_uart();
    if (cond()) return true;
    pod_yield();
    delay(1);
  }
  pump_uart();
  return cond();
}

/* Send a CFG message and wait for its ACK. Returns 1 ACK, -1 NAK, 0 timeout. */
static int send_cfg_wait_ack(const uint8_t *frame, size_t n, uint32_t timeout_ms = 1500) {
  if (n < 8) return 0;
  s_wait_cls = frame[2];
  s_wait_id = frame[3];
  s_wait_result = 0;
  s_wait_active = true;
  send_bytes(frame, n);
  wait_for([] { return s_wait_result != 0; }, timeout_ms);
  s_wait_active = false;
  return s_wait_result;
}

static bool poll_monver(uint32_t timeout_ms) {
  uint8_t f[8];
  size_t n = ubx_build(UBX_CLS_MON, UBX_ID_MON_VER, nullptr, 0, f, sizeof f);
  s_monver_got = false;
  send_bytes(f, n);
  return wait_for([] { return s_monver_got; }, timeout_ms);
}

static bool probe_baud(uint32_t baud) {
  GnssSerial.updateBaudRate(baud);
  delay(20);
  while (GnssSerial.available()) GnssSerial.read();
  ubx_parser_init(&s_parser);
  /* MON-VER reply is ~250 bytes: ~260 ms at 9600 baud */
  return poll_monver(baud <= 9600 ? 1500 : 600);
}

/* ------------------------------------------------------------ public */

static bool configure(gnss_rate_mode_t mode) {
  uint8_t f[300];
  size_t n;
  bool ok = true;
  n = gnss_cfg_build_base(mode, f, sizeof f);
  if (send_cfg_wait_ack(f, n) != 1) {
    Serial.println("[gnss] base config not ACKed");
    ok = false;
  }
  n = gnss_cfg_build_signals(mode, f, sizeof f);
  if (send_cfg_wait_ack(f, n) != 1) {
    Serial.println("[gnss] signal config not ACKed");
    ok = false;
  }
  /* IM 2.1.2: signal changes restart the GNSS subsystem; wait 0.5 s */
  wait_for([] { return false; }, 500);
  n = gnss_cfg_build_rate(mode, f, sizeof f);
  if (send_cfg_wait_ack(f, n) != 1) {
    Serial.println("[gnss] rate config not ACKed");
    ok = false;
  }
  return ok;
}

bool gnss_init() {
  GnssState &g = g_pod.gnss;
  static bool uart_started = false;
  if (!uart_started) {
    GnssSerial.setRxBufferSize(4096);
    GnssSerial.begin(GNSS_BAUD_RUN, SERIAL_8N1, PIN_GNSS_UART_RX, PIN_GNSS_UART_TX);
    uart_started = true;
  }
  g.comm_ok = false;
  g.init_failed = false;
  const uint32_t bauds[] = {GNSS_BAUD_RUN, GNSS_BAUD_DEFAULT, 115200, 38400, 921600};
  uint32_t found = 0;
  for (uint32_t b : bauds) {
    if (probe_baud(b)) {
      found = b;
      break;
    }
  }
  if (!found) {
    Serial.println("[gnss] no UBX reply at any baud (9600..921600): check U2 power/UART");
    g.init_failed = true;
    return false;
  }
  if (found != GNSS_BAUD_RUN) {
    uint8_t f[32];
    size_t n = gnss_cfg_build_baud(GNSS_BAUD_RUN, f, sizeof f);
    send_bytes(f, n); /* the ACK may come at either baud: not awaited */
    delay(100);
    if (!probe_baud(GNSS_BAUD_RUN)) {
      Serial.printf("[gnss] found at %lu but switch to %lu failed\n", (unsigned long)found,
                    (unsigned long)GNSS_BAUD_RUN);
      g.init_failed = true;
      return false;
    }
  }
  g.baud = GNSS_BAUD_RUN;
  g.comm_ok = true;
  Serial.printf("[gnss] receiver sw '%s' hw '%s' at %lu baud (found at %lu)\n", g.mon_sw, g.mon_hw,
                (unsigned long)GNSS_BAUD_RUN, (unsigned long)found);
  g.hp = gnss_poll_hp_state();
  gnss_rate_mode_t mode = g.rate;
  if (!gnss_rate_allowed(mode, g.hp)) mode = GNSS_RATE_10HZ_GPS_GAL;
  bool ok = configure(mode);
  g.rate = mode;
  g.init_failed = !ok;
  Serial.printf("[gnss] configured %d Hz (%s), HP OTP %s\n", (int)mode,
                mode == GNSS_RATE_25HZ_GPS ? "GPS+SBAS+QZSS" : "GPS+GAL+SBAS+QZSS",
                hp_state_name(g.hp));
  return ok;
}

void gnss_service() {
  if (s_bridge) {
    uint8_t buf[256];
    int n;
    while ((n = GnssSerial.available()) > 0) {
      n = GnssSerial.readBytes(buf, n > (int)sizeof buf ? sizeof buf : n);
      if (n > 0) Serial.write(buf, n);
    }
    while ((n = Serial.available()) > 0) {
      n = Serial.readBytes(buf, n > (int)sizeof buf ? sizeof buf : n);
      if (n > 0) GnssSerial.write(buf, n);
    }
    return;
  }
  pump_uart();
}

uint8_t gnss_set_rate(int hz) {
  GnssState &g = g_pod.gnss;
  if (!gnss_rate_mode_valid(hz)) return POD_RES_BAD_ARG;
  gnss_rate_mode_t mode = (gnss_rate_mode_t)hz;
  if (!gnss_rate_allowed(mode, g.hp)) return POD_RES_REFUSED_HP_NOT_SET;
  if (!g.comm_ok || s_bridge) return POD_RES_BUSY;
  uint8_t f[160];
  size_t n;
  bool gal_changes = (g.rate == GNSS_RATE_25HZ_GPS) != (mode == GNSS_RATE_25HZ_GPS);
  if (gal_changes) {
    n = gnss_cfg_build_signals(mode, f, sizeof f);
    if (send_cfg_wait_ack(f, n) != 1) return POD_RES_FAILED;
    wait_for([] { return false; }, 500);
  }
  n = gnss_cfg_build_rate(mode, f, sizeof f);
  if (send_cfg_wait_ack(f, n) != 1) return POD_RES_FAILED;
  g.rate = mode;
  return POD_RES_OK;
}

void gnss_set_raw_monitor(bool on) { s_raw_monitor = on; }

void gnss_set_sat_listener(gnss_sat_listener_t fn) { s_sat_listener = fn; }

uint32_t gnss_ubx_errors() {
  return s_parser.checksum_errors + s_parser.sync_errors + s_parser.oversize_errors;
}

static const char *gnss_name(uint8_t id) {
  /* gnssId values: UBX-21035062 R03 §1.5.2 "GNSS identifiers" */
  switch (id) {
    case 0: return "GPS";
    case 1: return "SBAS";
    case 2: return "GAL";
    case 3: return "BDS";
    case 5: return "QZSS";
    case 6: return "GLO";
    default: return "?";
  }
}

void gnss_print_sat() {
  const GnssState &g = g_pod.gnss;
  if (!g.have_sat) {
    Serial.println("no UBX-NAV-SAT received yet");
    return;
  }
  Serial.printf("NAV-SAT iTOW %lu ms, %u SVs (gnss sv cno[dBHz] elev used)\n",
                (unsigned long)g.sat.itow_ms, g.sat.num_svs);
  for (int i = 0; i < g.sat.num_svs; i++) {
    const ubx_sat_t &s = g.sat.sats[i];
    Serial.printf("  %-4s %3u %2u %3d %s\n", gnss_name(s.gnss_id), s.sv_id, s.cno_dbhz, s.elev_deg,
                  s.used ? "used" : "");
  }
}

void gnss_print_status() {
  const GnssState &g = g_pod.gnss;
  int64_t now = esp_timer_get_time();
  Serial.printf("gnss: %s, baud %lu, rate %d Hz, HP OTP %s, sw '%s'\n",
                g.comm_ok ? "ok" : "NO COMM", (unsigned long)g.baud, (int)g.rate,
                hp_state_name(g.hp), g.mon_sw);
  Serial.printf("      frames ok %lu, checksum err %lu, sync err %lu, last frame %lld ms ago\n",
                (unsigned long)s_parser.frames_ok, (unsigned long)s_parser.checksum_errors,
                (unsigned long)s_parser.sync_errors,
                g.last_frame_us ? (long long)((now - g.last_frame_us) / 1000) : -1LL);
  if (g.have_pvt) {
    const ubx_nav_pvt_t &p = g.pvt;
    Serial.printf("      PVT fix %u ok %u sv %u lat %.7f lon %.7f hAcc %.2f m speed %.2f m/s "
                  "UTC %04u-%02u-%02u %02u:%02u:%02u valid 0x%02X\n",
                  p.fix_type, p.flags & 1, p.num_sv, p.lat_e7 * 1e-7, p.lon_e7 * 1e-7,
                  p.h_acc_mm / 1000.0, p.g_speed_mm_s / 1000.0, p.year, p.month, p.day, p.hour,
                  p.min, p.sec, p.valid);
  }
}

void gnss_hw_reset() {
  /* DESIGN-REV-A §6: open-drain low only, >= 1 ms; clears BBR. */
  Serial.println("[gnss] RESET_N low 10 ms (clears BBR: expect a cold start)");
  digitalWrite(PIN_GNSS_RESET_N, LOW);
  pinMode(PIN_GNSS_RESET_N, OUTPUT_OPEN_DRAIN);
  delay(10);
  pinMode(PIN_GNSS_RESET_N, INPUT); /* release: the module's pull-up takes it high */
  delay(1000);
  gnss_init();
}

hp_state_t gnss_poll_hp_state() {
  /* IM UBX-22020019 R02 §2.1.5 step 5: exact poll bytes, exact reply check */
  s_valget_got = false;
  s_wait_cls = UBX_CLS_CFG;
  s_wait_id = UBX_ID_CFG_VALGET;
  s_wait_result = 0;
  s_wait_active = true;
  send_bytes(HP_OTP_VERIFY_POLL, sizeof HP_OTP_VERIFY_POLL);
  wait_for([] { return s_valget_got || s_wait_result == -1; }, 1500);
  s_wait_active = false;
  if (!s_valget_got) return HP_STATE_UNKNOWN;
  return hp_otp_classify_reply(s_valget_payload, s_valget_len);
}

void gnss_otp_status() {
  if (!g_pod.gnss.comm_ok) {
    Serial.println("gnss not communicating");
    return;
  }
  g_pod.gnss.hp = gnss_poll_hp_state();
  Serial.printf("high-performance OTP: %s\n", hp_state_name(g_pod.gnss.hp));
}

void gnss_otp_preflight() {
  GnssState &g = g_pod.gnss;
  s_preflight_valid = false;
  if (!g.comm_ok) {
    Serial.println("REFUSED: receiver not communicating");
    return;
  }
  /* IM step 2: test the interface by polling UBX-MON-VER */
  if (!poll_monver(1000)) {
    Serial.println("REFUSED: UBX-MON-VER poll failed (IM step 2)");
    return;
  }
  Serial.printf("MON-VER sw '%s' hw '%s'\n", g.mon_sw, g.mon_hw);
  for (int i = 0; i < g.mon_ext_n; i++) Serial.printf("        ext '%s'\n", g.mon_ext[i]);
  g.hp = gnss_poll_hp_state();
  Serial.printf("current OTP state: %s\n", hp_state_name(g.hp));
  if (g.hp == HP_STATE_SET) {
    Serial.println("Already set. Nothing to do (writing again would waste OTP space).");
    return;
  }
  if (g.hp == HP_STATE_UNKNOWN) {
    Serial.println("REFUSED: the verification poll got no usable reply; not writing OTP blind.");
    return;
  }
  Serial.println("*** IRREVERSIBLE *** This writes the SAM-M10Q one-time-programmable memory:");
  Serial.println("  source: u-blox SAM-M10Q Integration manual UBX-22020019 R02, section 2.1.5,");
  Serial.println("  Table 3 'High CPU clock'. Uses 18 of the 69 OTP bytes. \"Changes made in the");
  Serial.println("  OTP configuration are permanent and cannot be reverted.\"");
  Serial.println("Bytes that will be sent (60):");
  print_hex(HP_OTP_WRITE_SEQUENCE, sizeof HP_OTP_WRITE_SEQUENCE);
  Serial.println("Afterwards the receiver is reset (UBX-CFG-RST hardware reset, IM step 4) and");
  Serial.println("the result is verified (IM step 5).");
  Serial.println("To proceed type within 60 s:  gnss otp-highperf CONFIRM");
  s_preflight_valid = true;
  s_preflight_until_ms = millis() + 60000;
}

void gnss_otp_confirm() {
  GnssState &g = g_pod.gnss;
  bool window = s_preflight_valid && (int32_t)(s_preflight_until_ms - millis()) > 0;
  s_preflight_valid = false; /* one CONFIRM per preflight */
  if (!window) {
    Serial.println("REFUSED: run `gnss otp-highperf` (preflight) first; CONFIRM is valid 60 s.");
    return;
  }
  /* re-check right before writing */
  g.hp = gnss_poll_hp_state();
  if (g.hp != HP_STATE_NOT_SET) {
    Serial.printf("REFUSED: OTP state is now %s\n", hp_state_name(g.hp));
    return;
  }
  Serial.println("[otp] IM step 3: sending Table 3 configuration string ...");
  s_otp_acks = 0;
  send_bytes(HP_OTP_WRITE_SEQUENCE, sizeof HP_OTP_WRITE_SEQUENCE);
  wait_for([] { return s_otp_acks >= HP_OTP_EXPECTED_ACK_COUNT; }, 3000);
  Serial.printf("[otp] received %d of %d expected ACK-ACK (B5 62 05 01 02 00 06 41 4F 78)\n",
                s_otp_acks, HP_OTP_EXPECTED_ACK_COUNT);
  Serial.println("[otp] IM step 4: UBX-CFG-RST hardware reset");
  uint8_t f[16];
  size_t n = ubx_cfg_rst_frame(UBX_RST_BBR_HOT, UBX_RST_MODE_HW_WATCHDOG_NOW, f, sizeof f);
  send_bytes(f, n);
  delay(1500); /* receiver reboots at 9600 baud with RAM config lost */
  gnss_init();
  Serial.println("[otp] IM step 5: verification poll");
  g.hp = gnss_poll_hp_state();
  Serial.printf("[otp] result: %s\n", hp_state_name(g.hp));
  if (g.hp == HP_STATE_SET) Serial.println("[otp] done: `gnss rate 20` / `gnss rate 25` now allowed");
}

void gnss_bridge_start() {
  Serial.println("[gnss] bridge ON: USB <-> GNSS UART at 460800 baud. Point u-center at this");
  Serial.println("       port. Do not change the receiver baud. Press BOOT to leave.");
  Serial.flush();
  /* u-center traffic is binary: block briefly instead of dropping bytes */
  Serial.setTxTimeoutMs(100);
  s_bridge = true;
}

bool gnss_bridge_active() { return s_bridge; }

void gnss_bridge_stop() {
  if (!s_bridge) return;
  s_bridge = false;
  Serial.setTxTimeoutMs(0);
  Serial.println("\n[gnss] bridge OFF, re-initialising the receiver");
  gnss_init();
}
