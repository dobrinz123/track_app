#include "gnss.h"

#include <Arduino.h>

#include "console_io.h"
#include <esp_timer.h>
#include <string.h>

#include "ble_link.h"
#include "board_pins.h"
#include "bridge_filter.h"
#include "gnss_config.h"
#include "pod_protocol.h"
#include "pod_state.h"
#include "timebase.h"
#include "wifi_test.h"

static HardwareSerial &GnssSerial = Serial1;

static ubx_parser_t s_parser;
static bool s_raw_monitor = false;
static bool s_bridge = false;
static gnss_sat_listener_t s_sat_listener = nullptr;
static gnss_pvt_listener_t s_pvt_listener = nullptr;

/* ACK wait state */
static bool s_wait_active = false;
static uint8_t s_wait_cls = 0, s_wait_id = 0;
static int s_wait_result = 0; /* 0 pending, 1 ACK, -1 NAK */
/* OTP ACK counter (IM step 3 expects two identical ACK-ACK frames) */
static int s_otp_acks = 0;
/* VALGET capture: only while a poll of ours is outstanding (armed), only the
 * first reply, never truncated (an oversized reply is flagged and treated as
 * invalid) -- review fix HIGH 2. */
static bool s_valget_armed = false;
static bool s_valget_got = false;
static bool s_valget_oversize = false;
static uint8_t s_valget_payload[256];
static uint16_t s_valget_len = 0;
static bool s_monver_got = false;
/* OTP CONFIRM authorisation (one-shot, 60 s, cleared on expiry/reset/bridge) */
static hp_auth_t s_auth = {false, 0};
/* bridge host->GNSS filter (review fix HIGH 1) */
static bridge_filter_t s_bf;
static uint32_t s_bf_reported_blocked = 0;
static uint32_t s_bridge_rx_dropped = 0;

/* ------------------------------------------------------------ helpers */

static void print_hex(const uint8_t *p, size_t n) {
  for (size_t i = 0; i < n; i++) con_printf("%02X%s", p[i], (i + 1) % 24 == 0 ? "\n" : " ");
  if (n % 24) con_println();
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
  if (s_pvt_listener) s_pvt_listener(&p);

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
  o.rate_hz = g.rate_verified ? (uint8_t)g.rate : 0; /* 0 = mode unverified */
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
    con_printf("[ubx] %02X %02X len %u:", f->cls, f->id, f->len);
    size_t n = f->len > 32 ? 32 : f->len;
    for (size_t i = 0; i < n; i++) con_printf(" %02X", f->payload[i]);
    con_println(f->len > 32 ? " ..." : "");
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
    if (!s_valget_armed || s_valget_got) return; /* unsolicited or a second reply */
    if (f->len > sizeof s_valget_payload) {
      s_valget_oversize = true; /* never truncate: the reply is invalid */
      s_valget_len = 0;
    } else {
      memcpy(s_valget_payload, f->payload, f->len);
      s_valget_len = f->len;
    }
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

/* Send a VALGET poll and capture exactly its reply. Returns true only if a
 * complete (non-oversized) reply arrived; the caller validates it strictly. */
static bool valget_request(const uint8_t *poll, size_t n) {
  s_valget_got = false;
  s_valget_oversize = false;
  s_valget_len = 0;
  s_wait_cls = UBX_CLS_CFG;
  s_wait_id = UBX_ID_CFG_VALGET;
  s_wait_result = 0;
  s_wait_active = true; /* a NAK to the poll ends the wait early */
  s_valget_armed = true;
  send_bytes(poll, n);
  wait_for([] { return s_valget_got || s_wait_result == -1; }, 1500);
  s_valget_armed = false;
  s_wait_active = false;
  return s_valget_got && !s_valget_oversize;
}

/* Read the mode keys back from the RAM layer and compare exactly. */
static bool verify_mode(gnss_rate_mode_t mode) {
  uint8_t poll[128];
  size_t n = gnss_cfg_build_mode_poll(mode, poll, sizeof poll);
  if (n == 0 || !valget_request(poll, n)) return false;
  return gnss_cfg_verify_mode(s_valget_payload, s_valget_len, mode);
}

/* Review fix MEDIUM 9: constellations + rate in ONE VALSET (all or nothing,
 * [IFD] 3.10.5.1), then readback verification. */
static bool apply_mode(gnss_rate_mode_t mode) {
  uint8_t f[256];
  size_t n = gnss_cfg_build_mode(mode, f, sizeof f);
  if (n == 0 || send_cfg_wait_ack(f, n) != 1) return false;
  /* IM 2.1.2: signal changes restart the GNSS subsystem; wait 0.5 s */
  wait_for([] { return false; }, 500);
  return verify_mode(mode);
}

static bool configure(gnss_rate_mode_t mode) {
  uint8_t f[300];
  size_t n = gnss_cfg_build_base(mode, f, sizeof f);
  bool ok = true;
  if (send_cfg_wait_ack(f, n) != 1) {
    con_println("[gnss] base config not ACKed");
    ok = false;
  }
  if (!apply_mode(mode)) {
    con_println("[gnss] mode (constellations + rate) not ACKed or readback mismatch");
    ok = false;
  }
  return ok;
}

/* ------------------------------------------------------------ public */

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
  g.rate_verified = false;
  hp_auth_clear(&s_auth); /* any receiver re-init revokes a pending CONFIRM */
  const uint32_t bauds[] = {GNSS_BAUD_RUN, GNSS_BAUD_DEFAULT, 115200, 38400, 921600};
  uint32_t found = 0;
  for (uint32_t b : bauds) {
    if (probe_baud(b)) {
      found = b;
      break;
    }
  }
  if (!found) {
    con_println("[gnss] no UBX reply at any baud (9600..921600): check U2 power/UART");
    g.init_failed = true;
    return false;
  }
  if (found != GNSS_BAUD_RUN) {
    uint8_t f[32];
    size_t n = gnss_cfg_build_baud(GNSS_BAUD_RUN, f, sizeof f);
    send_bytes(f, n); /* the ACK may come at either baud: not awaited */
    delay(100);
    if (!probe_baud(GNSS_BAUD_RUN)) {
      con_printf("[gnss] found at %lu but switch to %lu failed\n", (unsigned long)found,
                    (unsigned long)GNSS_BAUD_RUN);
      g.init_failed = true;
      return false;
    }
  }
  g.baud = GNSS_BAUD_RUN;
  g.comm_ok = true;
  con_printf("[gnss] receiver sw '%s' hw '%s' at %lu baud (found at %lu)\n", g.mon_sw, g.mon_hw,
                (unsigned long)GNSS_BAUD_RUN, (unsigned long)found);
  g.hp = gnss_poll_hp_state();
  gnss_rate_mode_t mode = g.rate;
  if (!gnss_rate_allowed(mode, g.hp)) mode = GNSS_RATE_10HZ_GPS_GAL;
  bool ok = configure(mode);
  g.rate = mode;
  g.rate_verified = ok;
  g.init_failed = !ok;
  con_printf("[gnss] configured %d Hz (%s) %s, HP OTP %s\n", (int)mode,
             mode == GNSS_RATE_25HZ_GPS ? "GPS+SBAS+QZSS" : "GPS+GAL+SBAS+QZSS",
             ok ? "verified by readback" : "NOT VERIFIED", hp_state_name(g.hp));
  return ok;
}

static void bridge_to_gnss(const uint8_t *p, size_t n, void *) { GnssSerial.write(p, n); }

void gnss_tick() { hp_auth_tick(&s_auth, millis()); /* expiry clears the authorisation */ }

void gnss_service() {
  gnss_tick();
  if (s_bridge) {
    uint8_t buf[256];
    int n;
    /* GNSS -> host: non-blocking; chunks that do not fit the USB TX ring
     * are dropped and counted (never block the loop, review fix HIGH 3) */
    for (int budget = 8; budget > 0 && (n = GnssSerial.available()) > 0; budget--) {
      n = GnssSerial.readBytes(buf, n > (int)sizeof buf ? sizeof buf : n);
      if (n > 0 && con_write(buf, (size_t)n) == 0) s_bridge_rx_dropped += (uint32_t)n;
    }
    /* host -> GNSS: through the OTP-blocking filter (review fix HIGH 1) */
    for (int budget = 8; budget > 0 && (n = Serial.available()) > 0; budget--) {
      n = Serial.readBytes(buf, n > (int)sizeof buf ? sizeof buf : n);
      if (n > 0) bf_push(&s_bf, buf, (size_t)n, bridge_to_gnss, nullptr);
    }
    if (s_bf.frames_blocked != s_bf_reported_blocked) {
      s_bf_reported_blocked = s_bf.frames_blocked;
      con_printf("\r\n[bridge] BLOCKED UBX %02X %02X from the host (OTP write / undocumented "
                 "VALSET layer). OTP is only writable via `gnss otp-highperf` + CONFIRM. "
                 "Blocked so far: %lu\r\n",
                 s_bf.last_blocked_cls, s_bf.last_blocked_id, (unsigned long)s_bf.frames_blocked);
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
  /* no reconfiguration while the C/N0 coexistence test is measuring */
  if (!g.comm_ok || s_bridge || wifi_test_active()) return POD_RES_BUSY;
  gnss_rate_mode_t prev = g.rate;
  if (apply_mode(mode)) {
    g.rate = mode;
    g.rate_verified = true;
    return POD_RES_OK;
  }
  /* explicit rollback to the previous mode, again verified by readback */
  con_printf("[gnss] %d Hz not applied/verified; restoring %d Hz\n", (int)mode, (int)prev);
  bool back = apply_mode(prev);
  g.rate = prev;
  g.rate_verified = back;
  if (!back)
    con_println("[gnss] WARNING: receiver mode UNVERIFIED (reported as rate 0); run `gnss reset`");
  return POD_RES_FAILED;
}

void gnss_set_raw_monitor(bool on) { s_raw_monitor = on; }

void gnss_set_sat_listener(gnss_sat_listener_t fn) { s_sat_listener = fn; }
void gnss_set_pvt_listener(gnss_pvt_listener_t fn) { s_pvt_listener = fn; }

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
    con_println("no UBX-NAV-SAT received yet");
    return;
  }
  con_printf("NAV-SAT iTOW %lu ms, %u SVs (gnss sv cno[dBHz] elev used)\n",
                (unsigned long)g.sat.itow_ms, g.sat.num_svs);
  for (int i = 0; i < g.sat.num_svs; i++) {
    const ubx_sat_t &s = g.sat.sats[i];
    con_printf("  %-4s %3u %2u %3d %s\n", gnss_name(s.gnss_id), s.sv_id, s.cno_dbhz, s.elev_deg,
                  s.used ? "used" : "");
  }
}

void gnss_print_status() {
  const GnssState &g = g_pod.gnss;
  int64_t now = esp_timer_get_time();
  con_printf("gnss: %s, baud %lu, rate %d Hz (%s), HP OTP %s, sw '%s'\n",
             g.comm_ok ? "ok" : "NO COMM", (unsigned long)g.baud, (int)g.rate,
             g.rate_verified ? "verified" : "UNVERIFIED", hp_state_name(g.hp), g.mon_sw);
  con_printf("      frames ok %lu, checksum err %lu, sync err %lu, last frame %lld ms ago\n",
                (unsigned long)s_parser.frames_ok, (unsigned long)s_parser.checksum_errors,
                (unsigned long)s_parser.sync_errors,
                g.last_frame_us ? (long long)((now - g.last_frame_us) / 1000) : -1LL);
  if (g.have_pvt) {
    const ubx_nav_pvt_t &p = g.pvt;
    con_printf("      PVT fix %u ok %u sv %u lat %.7f lon %.7f hAcc %.2f m speed %.2f m/s "
                  "UTC %04u-%02u-%02u %02u:%02u:%02u valid 0x%02X\n",
                  p.fix_type, p.flags & 1, p.num_sv, p.lat_e7 * 1e-7, p.lon_e7 * 1e-7,
                  p.h_acc_mm / 1000.0, p.g_speed_mm_s / 1000.0, p.year, p.month, p.day, p.hour,
                  p.min, p.sec, p.valid);
  }
}

void gnss_hw_reset() {
  /* DESIGN-REV-A §6: open-drain low only, >= 1 ms; clears BBR. */
  con_println("[gnss] RESET_N low 10 ms (clears BBR: expect a cold start)");
  hp_auth_clear(&s_auth);
  digitalWrite(PIN_GNSS_RESET_N, LOW);
  pinMode(PIN_GNSS_RESET_N, OUTPUT_OPEN_DRAIN);
  delay(10);
  pinMode(PIN_GNSS_RESET_N, INPUT); /* release: the module's pull-up takes it high */
  delay(1000);
  gnss_init();
}

hp_state_t gnss_poll_hp_state() {
  /* IM UBX-22020019 R02 §2.1.5 step 5: exact poll bytes; the reply must be
   * complete, correlated and strictly valid, else UNKNOWN (review fix HIGH 2) */
  if (!valget_request(HP_OTP_VERIFY_POLL, sizeof HP_OTP_VERIFY_POLL)) return HP_STATE_UNKNOWN;
  return hp_otp_classify_reply(s_valget_payload, s_valget_len);
}

void gnss_otp_status() {
  if (!g_pod.gnss.comm_ok) {
    con_println("gnss not communicating");
    return;
  }
  g_pod.gnss.hp = gnss_poll_hp_state();
  con_printf("high-performance OTP: %s\n", hp_state_name(g_pod.gnss.hp));
}

void gnss_otp_preflight() {
  GnssState &g = g_pod.gnss;
  hp_auth_clear(&s_auth);
  if (!g.comm_ok) {
    con_println("REFUSED: receiver not communicating");
    return;
  }
  /* IM step 2: test the interface by polling UBX-MON-VER */
  if (!poll_monver(1000)) {
    con_println("REFUSED: UBX-MON-VER poll failed (IM step 2)");
    return;
  }
  con_printf("MON-VER sw '%s' hw '%s'\n", g.mon_sw, g.mon_hw);
  for (int i = 0; i < g.mon_ext_n; i++) con_printf("        ext '%s'\n", g.mon_ext[i]);
  g.hp = gnss_poll_hp_state();
  con_printf("current OTP state: %s\n", hp_state_name(g.hp));
  if (g.hp == HP_STATE_SET) {
    con_println("Already set. Nothing to do (writing again would waste OTP space).");
    return;
  }
  if (g.hp == HP_STATE_UNKNOWN) {
    con_println("REFUSED: the verification poll got no usable reply; not writing OTP blind.");
    return;
  }
  con_println("*** IRREVERSIBLE *** This writes the SAM-M10Q one-time-programmable memory:");
  con_println("  source: u-blox SAM-M10Q Integration manual UBX-22020019 R02, section 2.1.5,");
  con_println("  Table 3 'High CPU clock'. Uses 18 of the 69 OTP bytes. \"Changes made in the");
  con_println("  OTP configuration are permanent and cannot be reverted.\"");
  con_println("Bytes that will be sent (60):");
  print_hex(HP_OTP_WRITE_SEQUENCE, sizeof HP_OTP_WRITE_SEQUENCE);
  con_println("Afterwards the receiver is reset (UBX-CFG-RST hardware reset, IM step 4) and");
  con_println("the result is verified (IM step 5).");
  con_println("To proceed type within 60 s:  gnss otp-highperf CONFIRM");
  hp_auth_arm(&s_auth, millis());
}

void gnss_otp_confirm() {
  GnssState &g = g_pod.gnss;
  bool window = hp_auth_consume(&s_auth, millis()); /* one CONFIRM per preflight */
  if (!window) {
    con_println("REFUSED: run `gnss otp-highperf` (preflight) first; CONFIRM is valid 60 s.");
    return;
  }
  /* re-check right before writing */
  g.hp = gnss_poll_hp_state();
  if (g.hp != HP_STATE_NOT_SET) {
    con_printf("REFUSED: OTP state is now %s\n", hp_state_name(g.hp));
    return;
  }
  con_println("[otp] IM step 3: sending Table 3 configuration string ...");
  s_otp_acks = 0;
  send_bytes(HP_OTP_WRITE_SEQUENCE, sizeof HP_OTP_WRITE_SEQUENCE);
  wait_for([] { return s_otp_acks >= HP_OTP_EXPECTED_ACK_COUNT; }, 3000);
  con_printf("[otp] received %d of %d expected ACK-ACK (B5 62 05 01 02 00 06 41 4F 78)\n",
                s_otp_acks, HP_OTP_EXPECTED_ACK_COUNT);
  con_println("[otp] IM step 4: UBX-CFG-RST hardware reset");
  uint8_t f[16];
  size_t n = ubx_cfg_rst_frame(UBX_RST_BBR_HOT, UBX_RST_MODE_HW_WATCHDOG_NOW, f, sizeof f);
  send_bytes(f, n);
  delay(1500); /* receiver reboots at 9600 baud with RAM config lost */
  gnss_init();
  con_println("[otp] IM step 5: verification poll");
  g.hp = gnss_poll_hp_state();
  con_printf("[otp] result: %s\n", hp_state_name(g.hp));
  if (g.hp == HP_STATE_SET) con_println("[otp] done: `gnss rate 20` / `gnss rate 25` now allowed");
}

void gnss_bridge_start() {
  con_println("[gnss] bridge ON: USB <-> GNSS UART at 460800 baud. Point u-center at this");
  con_println("       port. Do not change the receiver baud. Press BOOT to leave.");
  con_println("       Host->GNSS UBX frames that could write OTP (06 41, VALSET to an");
  con_println("       undocumented layer) are BLOCKED; stray 0xB5 bytes are dropped.");
  hp_auth_clear(&s_auth);
  bf_init(&s_bf);
  s_bf_reported_blocked = 0;
  s_bridge_rx_dropped = 0;
  s_bridge = true;
}

bool gnss_bridge_active() { return s_bridge; }

void gnss_bridge_stop() {
  if (!s_bridge) return;
  s_bridge = false;
  con_printf("\r\n[gnss] bridge OFF: host frames forwarded %lu, blocked %lu, invalid dropped %lu, "
             "GNSS->USB bytes dropped %lu; re-initialising the receiver\r\n",
             (unsigned long)s_bf.frames_forwarded, (unsigned long)s_bf.frames_blocked,
             (unsigned long)s_bf.invalid_dropped, (unsigned long)s_bridge_rx_dropped);
  bf_init(&s_bf); /* a partial host frame is discarded, never forwarded */
  gnss_init();
}
