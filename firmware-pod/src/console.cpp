#include "console.h"

#include <Arduino.h>
#include <esp_timer.h>

#include "ble_link.h"
#include "board_pins.h"
#include "console_parse.h"
#include "gnss.h"
#include "imu.h"
#include "pod_state.h"
#include "pps.h"
#include "timebase.h"
#include "wifi_test.h"

static char s_line[128];
static size_t s_len = 0;

void console_init() {
  Serial.begin(115200);
  /* never block the main loop on a USB host that is not reading */
  Serial.setTxTimeoutMs(0);
}

static void print_utc(int64_t unix_us) {
  int64_t s = tb_floor_div(unix_us, 1000000);
  int64_t us = unix_us - s * 1000000;
  int64_t days = tb_floor_div(s, 86400);
  int64_t sod = s - days * 86400;
  /* civil_from_days (H. Hinnant) */
  int64_t z = days + 719468;
  int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  int64_t doe = z - era * 146097;
  int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t y = yoe + era * 400;
  int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  int64_t mp = (5 * doy + 2) / 153;
  int64_t d = doy - (153 * mp + 2) / 5 + 1;
  int64_t m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y++;
  Serial.printf("%04lld-%02lld-%02lld %02lld:%02lld:%02lld.%06lld UTC", (long long)y, (long long)m,
                (long long)d, (long long)(sod / 3600), (long long)(sod / 60 % 60),
                (long long)(sod % 60), (long long)us);
}

static void print_pps() {
  const timebase_t &tb = g_pod.tb;
  int64_t now = esp_timer_get_time();
  tb_state_t st = tb_state(&tb, now);
  Serial.printf("pps: state %s, edges %lu (isr %lu, ring overflow %lu), rejected %lu\n",
                tb_state_name(st), (unsigned long)tb.pps_total, (unsigned long)pps_isr_count(),
                (unsigned long)pps_overflow_count(), (unsigned long)tb.pps_rejected);
  if (tb.have_pps)
    Serial.printf("     last edge %lld ms ago, consecutive good %lu\n",
                  (long long)((now - tb.last_pps_pod_us) / 1000), (unsigned long)tb.consecutive_good);
  else
    Serial.println("     no edge yet (the receiver pulses only when locked to GNSS time)");
  if (tb.anchored) {
    int64_t u;
    tb_pod_to_unix(&tb, now, &u);
    Serial.printf("     rate %+ld ppb (pod clock vs GNSS), reanchors %lu, mismatches %lu\n",
                  (long)tb_rate_ppb(&tb), (unsigned long)tb.reanchors,
                  (unsigned long)tb.anchor_mismatches);
    Serial.print("     now = ");
    print_utc(u);
    Serial.printf("  (pod %lld us)\n", (long long)now);
  }
}

void console_print_status() {
  int64_t now = esp_timer_get_time();
  Serial.printf("TRACE Pod rev A fw %s, up %lld s, free heap %lu\n", FW_VERSION_STRING,
                (long long)(now / 1000000), (unsigned long)ESP.getFreeHeap());
  Serial.printf("power: USB %s (PGOOD_N %s), CHG_EN %s (held low on rev A), VBAT %d mV (no cell on rev A)\n",
                g_pod.usb_power ? "present" : "absent", g_pod.usb_power ? "low" : "high",
                digitalRead(PIN_CHG_EN) ? "HIGH!" : "low", g_pod.vbat_mv);
  gnss_print_status();
  print_pps();
  imu_print_status();
  ble_link_print_info();
  Serial.printf("wifi: %s%s\n", g_pod.wifi_on ? "ON" : "off", wifi_test_active() ? " (tx-test running)" : "");
}

static void execute(char *line) {
  console_parsed_t c = console_parse_line(line);
  switch (c.cmd) {
    case CMD_NONE: break;
    case CMD_ERROR: Serial.printf("error: %s\n", c.error); break;
    case CMD_HELP: Serial.print(CONSOLE_HELP_TEXT); break;
    case CMD_STATUS: console_print_status(); break;
    case CMD_GNSS_RATE: {
      uint8_t r = gnss_set_rate(c.int_arg);
      static const char *names[] = {"ok", "bad frame", "bad argument",
                                    "REFUSED: high-performance OTP not SET (see gnss otp-status)",
                                    "busy (no receiver / bridge active)", "unknown", "FAILED (no ACK)"};
      Serial.printf("gnss rate %d: %s\n", c.int_arg, r < 7 ? names[r] : "?");
      break;
    }
    case CMD_GNSS_RAW:
      gnss_set_raw_monitor(c.flag);
      Serial.printf("raw UBX monitor %s\n", c.flag ? "on" : "off");
      break;
    case CMD_GNSS_SAT: gnss_print_sat(); break;
    case CMD_GNSS_RESET: gnss_hw_reset(); break;
    case CMD_GNSS_BRIDGE: gnss_bridge_start(); break;
    case CMD_GNSS_OTP_STATUS: gnss_otp_status(); break;
    case CMD_GNSS_OTP_PREFLIGHT: gnss_otp_preflight(); break;
    case CMD_GNSS_OTP_CONFIRM: gnss_otp_confirm(); break;
    case CMD_IMU_DUMP:
      if (!g_pod.imu_ok) {
        Serial.println("imu not initialised");
        break;
      }
      imu_print_status();
      imu_request_dump(c.int_arg);
      break;
    case CMD_PPS: print_pps(); break;
    case CMD_BLE_INFO: ble_link_print_info(); break;
    case CMD_WIFI_TX_TEST: wifi_test_start(c.int_arg, c.flag); break;
    case CMD_RESET:
      Serial.println("restarting");
      Serial.flush();
      delay(50);
      ESP.restart();
      break;
  }
}

void console_service() {
  if (gnss_bridge_active()) return; /* the bridge owns the USB port */
  while (Serial.available() > 0) {
    int ch = Serial.read();
    if (ch < 0) break;
    if (ch == '\r' || ch == '\n') {
      if (s_len == 0 && ch == '\n') continue; /* CRLF */
      Serial.println();
      s_line[s_len] = 0;
      s_len = 0;
      execute(s_line);
      Serial.print("> ");
      if (gnss_bridge_active()) return;
    } else if (ch == 0x08 || ch == 0x7F) {
      if (s_len) {
        s_len--;
        Serial.print("\b \b");
      }
    } else if (ch >= 0x20 && ch < 0x7F && s_len < sizeof s_line - 1) {
      s_line[s_len++] = (char)ch;
      Serial.write((uint8_t)ch);
    }
  }
}
