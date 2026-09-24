/* C/N0 statistics, console parser and power policy tests (env:native). */
#include <string.h>
#include <unity.h>

#include "cn0_stats.h"
#include "console_parse.h"
#include "power_policy.h"

void setUp(void) {}
void tearDown(void) {}

static void mksat(ubx_nav_sat_t *s, const uint8_t *cno, int n, int used) {
  memset(s, 0, sizeof *s);
  s->num_svs = (uint8_t)n;
  for (int i = 0; i < n; i++) {
    s->sats[i].cno_dbhz = cno[i];
    s->sats[i].used = i < used;
  }
}

void test_top8_median(void) {
  ubx_nav_sat_t s;
  const uint8_t c[] = {10, 45, 0, 44, 43, 42, 41, 40, 39, 38, 20, 0};
  mksat(&s, c, 12, 9);
  /* top 8: 45 44 43 42 41 40 39 38 -> median (42+41)/2 = 41.5 */
  TEST_ASSERT_EQUAL_INT(415, cn0_epoch_top8_median_x10(&s));
  TEST_ASSERT_EQUAL_INT(9, cn0_epoch_used(&s));
  const uint8_t few[] = {40, 41, 42, 0, 0, 0, 0, 0, 43, 44, 45, 46};
  mksat(&s, few, 12, 3); /* only 7 with cno > 0 */
  TEST_ASSERT_EQUAL_INT(-1, cn0_epoch_top8_median_x10(&s));
}

void test_phase_and_verdict(void) {
  static cn0_phase_t off, on;
  cn0_phase_init(&off);
  cn0_phase_init(&on);
  ubx_nav_sat_t s;
  for (int e = 0; e < 11; e++) {
    uint8_t c[10];
    for (int i = 0; i < 10; i++) c[i] = (uint8_t)(40 + i % 5 + (e == 3 ? 5 : 0));
    mksat(&s, c, 10, 10);
    cn0_phase_add(&off, &s);
    for (int i = 0; i < 10; i++) c[i] = (uint8_t)(c[i] - 2);
    mksat(&s, c, 10, 10);
    cn0_phase_add(&on, &s);
  }
  int mo, uo, mn, un;
  TEST_ASSERT_TRUE(cn0_phase_result(&off, &mo, &uo));
  TEST_ASSERT_TRUE(cn0_phase_result(&on, &mn, &un));
  TEST_ASSERT_EQUAL_INT(20, mo - mn);
  TEST_ASSERT_EQUAL_INT(10, uo);
  TEST_ASSERT_TRUE(cn0_test4_pass(mo, mn, uo, un));   /* exactly 2.0 dB: pass */
  TEST_ASSERT_FALSE(cn0_test4_pass(mo, mn - 1, uo, un)); /* 2.1 dB: fail */
  TEST_ASSERT_FALSE(cn0_test4_pass(mo, mn, uo, un - 1)); /* fewer SVs used: fail */
  cn0_phase_t empty;
  cn0_phase_init(&empty);
  TEST_ASSERT_FALSE(cn0_phase_result(&empty, &mo, &uo));
}

static console_parsed_t P(const char *s) {
  static char buf[128];
  strncpy(buf, s, sizeof buf - 1);
  buf[sizeof buf - 1] = 0;
  return console_parse_line(buf);
}

void test_console_commands(void) {
  TEST_ASSERT_EQUAL_INT(CMD_NONE, P("   ").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_STATUS, P("status").cmd);
  console_parsed_t r = P("gnss rate 20");
  TEST_ASSERT_EQUAL_INT(CMD_GNSS_RATE, r.cmd);
  TEST_ASSERT_EQUAL_INT(20, r.int_arg);
  TEST_ASSERT_EQUAL_INT(CMD_ERROR, P("gnss rate 15").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_ERROR, P("gnss rate 20x").cmd);
  TEST_ASSERT_TRUE(P("gnss raw on").flag);
  TEST_ASSERT_FALSE(P("gnss raw off").flag);
  TEST_ASSERT_EQUAL_INT(CMD_ERROR, P("gnss raw maybe").cmd);
  r = P("imu dump");
  TEST_ASSERT_EQUAL_INT(CMD_IMU_DUMP, r.cmd);
  TEST_ASSERT_EQUAL_INT(10, r.int_arg);
  TEST_ASSERT_EQUAL_INT(50, P("imu dump 50").int_arg);
  TEST_ASSERT_EQUAL_INT(CMD_ERROR, P("imu dump 0").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_PPS, P("pps").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_BLE_INFO, P("ble info").cmd);
  r = P("wifi tx-test 600");
  TEST_ASSERT_EQUAL_INT(CMD_WIFI_TX_TEST, r.cmd);
  TEST_ASSERT_EQUAL_INT(600, r.int_arg);
  TEST_ASSERT_FALSE(r.flag);
  TEST_ASSERT_TRUE(P("wifi tx-test 60 max").flag);
  TEST_ASSERT_EQUAL_INT(CMD_ERROR, P("wifi tx-test 5").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_ERROR, P("wifi tx-test 60 loud").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_RESET, P("reset").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_ERROR, P("reboot").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_ERROR, P("a b c d e f g").cmd);
}

void test_console_otp_needs_exact_confirm(void) {
  TEST_ASSERT_EQUAL_INT(CMD_GNSS_OTP_PREFLIGHT, P("gnss otp-highperf").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_GNSS_OTP_CONFIRM, P("gnss otp-highperf CONFIRM").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_ERROR, P("gnss otp-highperf confirm").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_ERROR, P("gnss otp-highperf CONFIRMED").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_ERROR, P("gnss otp-highperf yes").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_ERROR, P("gnss otp-highperf CONFIRM now").cmd);
  TEST_ASSERT_EQUAL_INT(CMD_GNSS_OTP_STATUS, P("gnss otp-status").cmd);
}

void test_power_policy_inert_on_rev_a(void) {
  TEST_ASSERT_EQUAL_INT(0, POWER_HAS_CELL);
  TEST_ASSERT_EQUAL_INT(0, POWER_REV_A_CHARGING_ALLOWED);
  /* rev A: no cell -> never sleeps, WiFi allowed, whatever VBAT reads */
  power_decision_t d = power_policy_evaluate(false, false, 2000);
  TEST_ASSERT_FALSE(d.deep_sleep_now);
  TEST_ASSERT_TRUE(d.wifi_allowed);
}

void test_power_policy_with_cell(void) {
  power_decision_t d;
  d = power_policy_evaluate(true, true, 3000); /* USB present: never applies */
  TEST_ASSERT_FALSE(d.deep_sleep_now);
  TEST_ASSERT_TRUE(d.wifi_allowed);
  d = power_policy_evaluate(true, false, 3499);
  TEST_ASSERT_TRUE(d.deep_sleep_now);
  d = power_policy_evaluate(true, false, 3500);
  TEST_ASSERT_FALSE(d.deep_sleep_now);
  TEST_ASSERT_FALSE(d.wifi_allowed);
  d = power_policy_evaluate(true, false, 3600);
  TEST_ASSERT_TRUE(d.wifi_allowed);
  d = power_policy_evaluate(true, false, -1);
  TEST_ASSERT_FALSE(d.deep_sleep_now);
  TEST_ASSERT_FALSE(d.wifi_allowed);
  TEST_ASSERT_EQUAL_INT(4200, power_vbat_from_adc_mv(2100));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_top8_median);
  RUN_TEST(test_phase_and_verdict);
  RUN_TEST(test_console_commands);
  RUN_TEST(test_console_otp_needs_exact_confirm);
  RUN_TEST(test_power_policy_inert_on_rev_a);
  RUN_TEST(test_power_policy_with_cell);
  return UNITY_END();
}
