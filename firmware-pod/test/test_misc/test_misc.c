/* C/N0 statistics, console parser and power policy tests (env:native). */
#include <string.h>
#include <unity.h>

#include "cn0_stats.h"
#include "console_parse.h"
#include "ctrl_sched.h"
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
  cn0_phase_begin(&off, 0, 20, 10);
  cn0_phase_begin(&on, 0, 20, 10);
  ubx_nav_sat_t s;
  for (int e = 0; e < 11; e++) {
    uint8_t c[10];
    for (int i = 0; i < 10; i++) c[i] = (uint8_t)(40 + i % 5 + (e == 3 ? 5 : 0));
    mksat(&s, c, 10, 10);
    s.itow_ms = (uint32_t)(1000 * e);
    cn0_phase_add(&off, &s, (uint32_t)(1000 * e));
    for (int i = 0; i < 10; i++) c[i] = (uint8_t)(c[i] - 2);
    mksat(&s, c, 10, 10);
    s.itow_ms = (uint32_t)(1000 * e);
    cn0_phase_add(&on, &s, (uint32_t)(1000 * e));
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
  cn0_phase_begin(&empty, 0, 10, 10);
  TEST_ASSERT_FALSE(cn0_phase_result(&empty, &mo, &uo));
}

/* Simulated phase of `seconds` at `rate` Hz NAV-PVT + 1 Hz NAV-SAT. The phase
 * starts 0.3 s into a GPS second (not aligned), messages arrive 60 ms after
 * their epoch. Windows are given in phase seconds [from, from+len). */
typedef struct {
  int silent_from, silent_len;   /* no output at all */
  int nofix_from, nofix_len;     /* PVTs without a valid fix */
  int lowsv_from, lowsv_len;     /* NAV-SAT with only 6 satellites */
} sim_t;

static bool in(int x, int from, int len) { return x >= from && x < from + len; }

static void fill(cn0_phase_t *p, int seconds, int rate, int cno_base, sim_t w) {
  const uint32_t start_ms = 5000;
  const uint64_t g0 = 400000300ull; /* GPS ms of the phase start */
  cn0_phase_begin(p, start_ms, (uint16_t)seconds, (uint8_t)rate);
  uint32_t step = 1000u / (uint32_t)rate;
  uint64_t t = (g0 + step - 1) / step * step;
  for (; t < g0 + (uint64_t)seconds * 1000u; t += step) {
    int ps = (int)((t - g0) / 1000u); /* phase second of this epoch */
    if (in(ps, w.silent_from, w.silent_len)) continue;
    uint32_t arrive = start_ms + (uint32_t)(t - g0) + 60u;
    cn0_phase_add_pvt(p, !in(ps, w.nofix_from, w.nofix_len), (uint32_t)t, arrive);
    if (t % 1000u == 0) {
      ubx_nav_sat_t s;
      uint8_t c[10];
      int nsv = in(ps, w.lowsv_from, w.lowsv_len) ? 6 : 10;
      for (int i = 0; i < 10; i++) c[i] = i < nsv ? (uint8_t)(cno_base + i % 5) : 0;
      mksat(&s, c, 10, nsv);
      s.itow_ms = (uint32_t)t;
      cn0_phase_add(p, &s, arrive);
    }
  }
}

static const sim_t CLEAN = {0, 0, 0, 0, 0, 0};

void test_availability_is_temporal(void) {
  static cn0_phase_t p;
  cn0_avail_t a;
  fill(&p, 600, 10, 40, CLEAN);
  cn0_phase_availability(&p, &a);
  TEST_ASSERT_EQUAL_UINT32(598, a.judged); /* first/last partial seconds excluded */
  TEST_ASSERT_EQUAL_UINT32(598, a.good);
  TEST_ASSERT_EQUAL_UINT32(1000, a.pct_x10);
  TEST_ASSERT_TRUE(a.longest_gap_ms <= 100); /* only edge rounding */
  sim_t gap = {100, 3, 0, 0, 0, 0};
  fill(&p, 600, 20, 40, gap); /* 20 Hz, 3 s silent, not aligned to GPS seconds */
  cn0_phase_availability(&p, &a);
  TEST_ASSERT_EQUAL_UINT32(3000, a.longest_gap_ms);
  TEST_ASSERT_EQUAL_UINT32(598 - 4, a.good); /* it touches 4 GPS seconds */
  sim_t nofix = {0, 0, 200, 1, 0, 0}; /* one second without a valid fix */
  fill(&p, 600, 25, 40, nofix);
  cn0_phase_availability(&p, &a);
  TEST_ASSERT_EQUAL_UINT32(1000, a.longest_gap_ms);
  sim_t tail = {595, 5, 0, 0, 0, 0}; /* silent last 5 s: trailing edge counts */
  fill(&p, 600, 10, 40, tail);
  cn0_phase_availability(&p, &a);
  TEST_ASSERT_TRUE(a.longest_gap_ms >= 4900);
  sim_t head = {0, 4, 0, 0, 0, 0}; /* silent first 4 s: leading edge counts */
  fill(&p, 600, 10, 40, head);
  cn0_phase_availability(&p, &a);
  TEST_ASSERT_TRUE(a.longest_gap_ms >= 3000);
}

void test_test4_verdict_rules(void) {
  static cn0_phase_t off, on;
  const char *why;
  const int S = 600;
  cn0_tx_info_t tx = {true, 600u * 100u, 0, true};
  fill(&off, S, 10, 40, CLEAN);
  fill(&on, S, 10, 39, CLEAN);
  TEST_ASSERT_EQUAL_INT(CN0_PASS, cn0_test4_verdict(&off, &on, S, &tx, &why));
  cn0_tx_info_t none = {true, 0, 0, true}; /* TX never ran */
  TEST_ASSERT_EQUAL_INT(CN0_FAIL, cn0_test4_verdict(&off, &on, S, &none, &why));
  cn0_tx_info_t bad = {false, 60000, 0, true}; /* a setup call failed */
  TEST_ASSERT_EQUAL_INT(CN0_FAIL, cn0_test4_verdict(&off, &on, S, &bad, &why));
  cn0_tx_info_t few = {true, 30u * 600u - 1u, 0, true};
  TEST_ASSERT_EQUAL_INT(CN0_FAIL, cn0_test4_verdict(&off, &on, S, &few, &why));
  cn0_tx_info_t stall = {true, 60000, 1, true};
  TEST_ASSERT_EQUAL_INT(CN0_FAIL, cn0_test4_verdict(&off, &on, S, &stall, &why));
  cn0_tx_info_t noshut = {true, 60000, 0, false}; /* M4: shutdown unverified */
  TEST_ASSERT_EQUAL_INT(CN0_FAIL, cn0_test4_verdict(&off, &on, S, &noshut, &why));

  /* Codex PODFW-REV2 M3: 540 good seconds, then 60 s of silence at 10 Hz */
  sim_t tail = {540, 60, 0, 0, 0, 0};
  fill(&on, S, 10, 39, tail);
  TEST_ASSERT_EQUAL_INT(CN0_FAIL, cn0_test4_verdict(&off, &on, S, &tx, &why));
  /* a single 3 s gap with everything else perfect */
  sim_t g3 = {300, 3, 0, 0, 0, 0};
  fill(&on, S, 10, 39, g3);
  TEST_ASSERT_EQUAL_INT(CN0_FAIL, cn0_test4_verdict(&off, &on, S, &tx, &why));
  /* 2 s gap is tolerated (limit is > 2 s) */
  sim_t g2 = {300, 2, 0, 0, 0, 0};
  fill(&on, S, 10, 39, g2);
  TEST_ASSERT_EQUAL_INT(CN0_PASS, cn0_test4_verdict(&off, &on, S, &tx, &why));
  /* many short (1 s) outages: no long gap, but availability drops > 2 %
   * below the baseline */
  fill(&on, S, 10, 39, CLEAN);
  for (int k = 10; k < S - 10; k += 20) on.b_pvt_fix[k] = 0; /* 1 second in 20 */
  TEST_ASSERT_EQUAL_INT(CN0_FAIL, cn0_test4_verdict(&off, &on, S, &tx, &why));
  /* a silent tail of 5 s (only ~0.8 % availability) is caught as a gap */
  sim_t tail5 = {595, 5, 0, 0, 0, 0};
  fill(&on, S, 10, 39, tail5);
  TEST_ASSERT_EQUAL_INT(CN0_FAIL, cn0_test4_verdict(&off, &on, S, &tx, &why));
  /* < 8 satellites for a stretch */
  sim_t lowsv = {0, 0, 0, 0, 100, 30};
  fill(&on, S, 10, 39, lowsv);
  TEST_ASSERT_EQUAL_INT(CN0_FAIL, cn0_test4_verdict(&off, &on, S, &tx, &why));
  /* bad baseline sky -> inconclusive */
  fill(&on, S, 10, 39, CLEAN);
  sim_t offgap = {50, 5, 0, 0, 0, 0};
  fill(&off, S, 10, 40, offgap);
  TEST_ASSERT_EQUAL_INT(CN0_INCONCLUSIVE, cn0_test4_verdict(&off, &on, S, &tx, &why));
  /* 3 dB C/N0 drop */
  fill(&off, S, 10, 42, CLEAN);
  fill(&on, S, 10, 39, CLEAN);
  TEST_ASSERT_EQUAL_INT(CN0_FAIL, cn0_test4_verdict(&off, &on, S, &tx, &why));
}

/* Codex PODFW-REV2 M2: a permanently full overflow queue must not starve
 * accepted controls. */
void test_control_queues_are_served_fairly(void) {
  uint8_t turn = 0;
  int controls = 0, busy = 0;
  int ctrl_left = 8;
  for (int pass = 0; pass < 16; pass++) {
    cs_pick_t p = ctrl_sched_next(ctrl_left > 0, true /* overflow always full */, &turn);
    if (p == CS_CONTROL) {
      controls++;
      ctrl_left--;
    } else if (p == CS_OVERFLOW) {
      busy++;
    }
  }
  TEST_ASSERT_EQUAL_INT(8, controls); /* all 8 accepted controls ran within 16 passes */
  TEST_ASSERT_EQUAL_INT(8, busy);
  /* strict alternation while both have work */
  turn = 0;
  TEST_ASSERT_EQUAL_INT(CS_CONTROL, ctrl_sched_next(true, true, &turn));
  TEST_ASSERT_EQUAL_INT(CS_OVERFLOW, ctrl_sched_next(true, true, &turn));
  TEST_ASSERT_EQUAL_INT(CS_CONTROL, ctrl_sched_next(true, true, &turn));
  /* single queue: always that one; none: nothing */
  TEST_ASSERT_EQUAL_INT(CS_OVERFLOW, ctrl_sched_next(false, true, &turn));
  TEST_ASSERT_EQUAL_INT(CS_OVERFLOW, ctrl_sched_next(false, true, &turn));
  TEST_ASSERT_EQUAL_INT(CS_CONTROL, ctrl_sched_next(true, false, &turn));
  TEST_ASSERT_EQUAL_INT(CS_NONE, ctrl_sched_next(false, false, &turn));
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
  RUN_TEST(test_availability_is_temporal);
  RUN_TEST(test_control_queues_are_served_fairly);
  RUN_TEST(test_test4_verdict_rules);
  RUN_TEST(test_console_commands);
  RUN_TEST(test_console_otp_needs_exact_confirm);
  RUN_TEST(test_power_policy_inert_on_rev_a);
  RUN_TEST(test_power_policy_with_cell);
  return UNITY_END();
}
