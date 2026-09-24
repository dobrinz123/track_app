#ifndef TRACE_POD_CONSOLE_PARSE_H
#define TRACE_POD_CONSOLE_PARSE_H

/*
 * USB console command parser (framework-free). Turns one text line into a
 * command + validated arguments; execution lives in console.cpp.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  CMD_NONE = 0, /* empty line */
  CMD_ERROR,    /* see .error */
  CMD_HELP,
  CMD_STATUS,
  CMD_GNSS_RATE,          /* int_arg = 10|20|25 */
  CMD_GNSS_RAW,           /* flag = on/off */
  CMD_GNSS_SAT,
  CMD_GNSS_RESET,
  CMD_GNSS_BRIDGE,
  CMD_GNSS_OTP_STATUS,
  CMD_GNSS_OTP_PREFLIGHT, /* `gnss otp-highperf` */
  CMD_GNSS_OTP_CONFIRM,   /* `gnss otp-highperf CONFIRM` (exact, case-sensitive) */
  CMD_IMU_DUMP,           /* int_arg = samples (default 10, 1..200) */
  CMD_PPS,
  CMD_BLE_INFO,
  CMD_WIFI_TX_TEST,       /* int_arg = seconds (10..1200), flag = "max" power */
  CMD_RESET
} console_cmd_t;

typedef struct {
  console_cmd_t cmd;
  int int_arg;
  bool flag;
  const char *error; /* static string when cmd == CMD_ERROR */
} console_parsed_t;

/* Parses a NUL-terminated line (modified in place: tokens are split). */
console_parsed_t console_parse_line(char *line);

extern const char *const CONSOLE_HELP_TEXT;

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_CONSOLE_PARSE_H */
