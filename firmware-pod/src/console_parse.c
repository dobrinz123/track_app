#include "console_parse.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

const char *const CONSOLE_HELP_TEXT =
    "TRACE Pod rev A console\n"
    "  status                    everything at a glance\n"
    "  gnss rate <10|20|25>      nav rate; 20/25 need the high-perf OTP (SET)\n"
    "  gnss raw on|off           print every UBX frame received (class/id/len + hex)\n"
    "  gnss sat                  last UBX-NAV-SAT: C/N0 per satellite\n"
    "  gnss reset                pulse RESET_N (GPIO40) low 10 ms, then reconfigure\n"
    "  gnss bridge               USB<->GNSS UART bridge for u-center (OTP-writing frames blocked);\n"
    "                            press BOOT (after boot) or power-cycle to leave\n"
    "  gnss otp-status           poll the high-performance OTP state (IM 2.1.5 step 5)\n"
    "  gnss otp-highperf         preflight for the IRREVERSIBLE OTP write\n"
    "  gnss otp-highperf CONFIRM write it (only within 60 s after the preflight)\n"
    "  imu dump [n]              print n decoded IMU samples (default 10)\n"
    "  pps                       PPS / timebase state\n"
    "  ble info                  BLE address, connection, MTU, PHY, counters\n"
    "  wifi tx-test <s> [max]    DESIGN-REV-A 10A test 4: s seconds TX off, then s\n"
    "                            seconds continuous WiFi TX (13 dBm cap; 'max' = 20 dBm\n"
    "                            for test 2), C/N0 verdict at the end\n"
    "  reset                     restart the MCU\n";

#define MAX_TOK 6

static bool eq(const char *a, const char *b) { return a && strcmp(a, b) == 0; }

static bool parse_int(const char *s, int *out) {
  if (!s || !*s) return false;
  char *end = NULL;
  long v = strtol(s, &end, 10);
  if (*end != '\0') return false;
  if (v < -1000000 || v > 1000000) return false;
  *out = (int)v;
  return true;
}

static console_parsed_t err(const char *msg) {
  console_parsed_t r = {CMD_ERROR, 0, false, msg};
  return r;
}

static console_parsed_t ok(console_cmd_t c, int arg, bool flag) {
  console_parsed_t r = {c, arg, flag, NULL};
  return r;
}

console_parsed_t console_parse_line(char *line) {
  char *tok[MAX_TOK] = {0};
  int n = 0;
  char *p = line;
  while (*p && n < MAX_TOK) {
    while (*p && isspace((unsigned char)*p)) p++;
    if (!*p) break;
    tok[n++] = p;
    while (*p && !isspace((unsigned char)*p)) p++;
    if (*p) *p++ = '\0';
  }
  while (*p && isspace((unsigned char)*p)) p++;
  if (*p) return err("too many arguments");
  if (n == 0) return ok(CMD_NONE, 0, false);

  if (eq(tok[0], "help") || eq(tok[0], "?")) return ok(CMD_HELP, 0, false);
  if (eq(tok[0], "status")) return n == 1 ? ok(CMD_STATUS, 0, false) : err("usage: status");
  if (eq(tok[0], "pps")) return n == 1 ? ok(CMD_PPS, 0, false) : err("usage: pps");
  if (eq(tok[0], "reset")) return n == 1 ? ok(CMD_RESET, 0, false) : err("usage: reset");

  if (eq(tok[0], "gnss")) {
    if (n < 2) return err("usage: gnss rate|raw|sat|reset|bridge|otp-status|otp-highperf");
    if (eq(tok[1], "rate")) {
      int hz;
      if (n != 3 || !parse_int(tok[2], &hz) || (hz != 10 && hz != 20 && hz != 25))
        return err("usage: gnss rate <10|20|25>");
      return ok(CMD_GNSS_RATE, hz, false);
    }
    if (eq(tok[1], "raw")) {
      if (n == 3 && eq(tok[2], "on")) return ok(CMD_GNSS_RAW, 0, true);
      if (n == 3 && eq(tok[2], "off")) return ok(CMD_GNSS_RAW, 0, false);
      return err("usage: gnss raw on|off");
    }
    if (eq(tok[1], "sat")) return n == 2 ? ok(CMD_GNSS_SAT, 0, false) : err("usage: gnss sat");
    if (eq(tok[1], "reset")) return n == 2 ? ok(CMD_GNSS_RESET, 0, false) : err("usage: gnss reset");
    if (eq(tok[1], "bridge"))
      return n == 2 ? ok(CMD_GNSS_BRIDGE, 0, false) : err("usage: gnss bridge");
    if (eq(tok[1], "otp-status"))
      return n == 2 ? ok(CMD_GNSS_OTP_STATUS, 0, false) : err("usage: gnss otp-status");
    if (eq(tok[1], "otp-highperf")) {
      if (n == 2) return ok(CMD_GNSS_OTP_PREFLIGHT, 0, false);
      /* exact, upper-case token only: no abbreviations, no "confirm" */
      if (n == 3 && eq(tok[2], "CONFIRM")) return ok(CMD_GNSS_OTP_CONFIRM, 0, false);
      return err("usage: gnss otp-highperf [CONFIRM]  (CONFIRM is case-sensitive)");
    }
    return err("unknown gnss subcommand (try: help)");
  }

  if (eq(tok[0], "imu")) {
    if (n >= 2 && eq(tok[1], "dump")) {
      int cnt = 10;
      if (n == 3 && !parse_int(tok[2], &cnt)) return err("usage: imu dump [1..200]");
      if (n > 3 || cnt < 1 || cnt > 200) return err("usage: imu dump [1..200]");
      return ok(CMD_IMU_DUMP, cnt, false);
    }
    return err("usage: imu dump [n]");
  }

  if (eq(tok[0], "ble")) {
    if (n == 2 && eq(tok[1], "info")) return ok(CMD_BLE_INFO, 0, false);
    return err("usage: ble info");
  }

  if (eq(tok[0], "wifi")) {
    if (n >= 3 && eq(tok[1], "tx-test")) {
      int s;
      if (!parse_int(tok[2], &s) || s < 10 || s > 1800)
        return err("usage: wifi tx-test <10..1800 seconds> [max]");
      if (n == 3) return ok(CMD_WIFI_TX_TEST, s, false);
      if (n == 4 && eq(tok[3], "max")) return ok(CMD_WIFI_TX_TEST, s, true);
    }
    return err("usage: wifi tx-test <10..1800 seconds> [max]");
  }

  return err("unknown command (try: help)");
}
