/* Timebase tests (env:native): civil time conversion, PPS discipline, UTC
 * association, holdover, glitch rejection. Reference Unix times were
 * computed with Python's datetime (UTC), independently of this code. */
#include <math.h>
#include <stdlib.h>
#include <unity.h>

#include "clockmap.h"
#include "timebase.h"

void setUp(void) {}
void tearDown(void) {}

void test_days_from_civil_reference_dates(void) {
  TEST_ASSERT_EQUAL_INT64(0, tb_days_from_civil(1970, 1, 1));
  TEST_ASSERT_EQUAL_INT64(11016, tb_days_from_civil(2000, 2, 29));
  TEST_ASSERT_EQUAL_INT64(20720, tb_days_from_civil(2026, 9, 24));
  TEST_ASSERT_EQUAL_INT64(47541, tb_days_from_civil(2100, 3, 1));
  TEST_ASSERT_EQUAL_INT64(-1, tb_days_from_civil(1969, 12, 31));
}

void test_utc_to_unix_us(void) {
  /* the NAV-PVT vector of test_ubx: 2026-09-24 11:59:42, nano 99999987 */
  TEST_ASSERT_EQUAL_INT64(1790251182LL * 1000000 + 99999,
                          tb_utc_to_unix_us(2026, 9, 24, 11, 59, 42, 99999987));
  TEST_ASSERT_EQUAL_INT64(951868799LL * 1000000, tb_utc_to_unix_us(2000, 2, 29, 23, 59, 59, 0));
  /* negative nano (allowed range -1e9..1e9) floors correctly */
  TEST_ASSERT_EQUAL_INT64(951868799LL * 1000000 - 1, tb_utc_to_unix_us(2000, 2, 29, 23, 59, 59, -1));
}

/* ---- simulation: the pod clock runs slow by 20 ppm vs UTC ---- */
#define R_TRUE 20e-6 /* unix_elapsed = pod_elapsed * (1 + R_TRUE) */
static const int64_t U0 = 1790251100LL * 1000000; /* a whole UTC second */
static const int64_t P0 = 5000000;                /* pod time at U0 */

static int64_t pod_at(int64_t unix_us) {
  return P0 + (int64_t)llround((double)(unix_us - U0) / (1.0 + R_TRUE));
}

/* Runs seconds [first, last) with 10 Hz PVT, PPS on each second unless
 * listed in skip[], PVT latency lat_us. */
static void run(timebase_t *tb, int first, int last, int64_t lat_us, const int *skip, int nskip) {
  for (int s = first; s < last; s++) {
    bool skipped = false;
    for (int k = 0; k < nskip; k++) skipped |= skip[k] == s;
    int64_t sec_unix = U0 + (int64_t)s * 1000000;
    if (!skipped) tb_on_pps(tb, pod_at(sec_unix));
    for (int e = 0; e < 10; e++) {
      int64_t epoch = sec_unix + e * 100000;
      tb_on_pvt(tb, pod_at(epoch) + lat_us, epoch);
    }
  }
}

void test_locks_and_maps_within_microseconds(void) {
  timebase_t tb;
  tb_init(&tb);
  TEST_ASSERT_EQUAL_INT(TB_STATE_NONE, tb_state(&tb, 0));
  run(&tb, 0, 20, 45000, NULL, 0);
  int64_t now = pod_at(U0 + 19 * 1000000 + 950000);
  TEST_ASSERT_EQUAL_INT(TB_STATE_LOCKED, tb_state(&tb, now));
  /* rate estimate */
  TEST_ASSERT_INT_WITHIN(200, 20000, tb_rate_ppb(&tb));
  /* map an arbitrary pod time 0.73 s after the last PPS */
  int64_t truth = U0 + 19 * 1000000 + 730000;
  int64_t u;
  TEST_ASSERT_TRUE(tb_pod_to_unix(&tb, pod_at(truth), &u));
  TEST_ASSERT_INT64_WITHIN(2, truth, u);
  int64_t p;
  TEST_ASSERT_TRUE(tb_unix_to_pod(&tb, truth, &p));
  TEST_ASSERT_INT64_WITHIN(2, pod_at(truth), p);
  TEST_ASSERT_EQUAL_UINT32(0, tb.anchor_mismatches);
  TEST_ASSERT_EQUAL_UINT32(0, tb.pps_rejected);
}

void test_association_with_large_latency_and_missed_pulses(void) {
  timebase_t tb;
  tb_init(&tb);
  const int skip[] = {5, 6, 7, 12};
  run(&tb, 0, 15, 900000, skip, 4); /* 0.9 s latency, 4 pulses missing */
  int64_t truth = U0 + 14 * 1000000 + 500000;
  int64_t u;
  TEST_ASSERT_TRUE(tb_pod_to_unix(&tb, pod_at(truth), &u));
  TEST_ASSERT_INT64_WITHIN(5, truth, u);
  TEST_ASSERT_EQUAL_UINT32(0, tb.anchor_mismatches);
}

void test_pvt_older_than_latest_pps_still_associates(void) {
  /* PPS of second 3 is drained before the PVT of epoch 2.9 s (150 ms
   * latency) is parsed: the association must still give the right second. */
  timebase_t tb;
  tb_init(&tb);
  for (int s = 0; s <= 3; s++) tb_on_pps(&tb, pod_at(U0 + s * 1000000));
  int64_t epoch = U0 + 2900000;
  TEST_ASSERT_TRUE(tb_on_pvt(&tb, pod_at(epoch) + 150000, epoch));
  TEST_ASSERT_EQUAL_INT64(U0 + 3000000, tb.anchor_unix_us);
  TEST_ASSERT_EQUAL_INT64(pod_at(U0 + 3000000), tb.anchor_pod_us);
}

void test_glitch_pulse_is_rejected(void) {
  timebase_t tb;
  tb_init(&tb);
  run(&tb, 0, 5, 30000, NULL, 0);
  /* spurious edge 0.4 s after the last good one */
  TEST_ASSERT_FALSE(tb_on_pps(&tb, pod_at(U0 + 4 * 1000000 + 400000)));
  /* and one 2.3 s later: not an integer number of seconds */
  TEST_ASSERT_FALSE(tb_on_pps(&tb, pod_at(U0 + 6 * 1000000 + 300000)));
  run(&tb, 5, 8, 30000, NULL, 0);
  int64_t truth = U0 + 7 * 1000000 + 250000;
  int64_t u;
  TEST_ASSERT_TRUE(tb_pod_to_unix(&tb, pod_at(truth), &u));
  TEST_ASSERT_INT64_WITHIN(2, truth, u);
  TEST_ASSERT_EQUAL_UINT32(2, tb.pps_rejected);
}

void test_holdover_then_relock(void) {
  timebase_t tb;
  tb_init(&tb);
  run(&tb, 0, 10, 30000, NULL, 0);
  int64_t later = pod_at(U0 + 13 * 1000000);
  TEST_ASSERT_EQUAL_INT(TB_STATE_HOLDOVER, tb_state(&tb, later));
  /* holdover still maps with the learned rate */
  int64_t u;
  TEST_ASSERT_TRUE(tb_pod_to_unix(&tb, later, &u));
  TEST_ASSERT_INT64_WITHIN(20, U0 + 13 * 1000000, u);
  /* pulses resume after a 40 s gap (> TB_PPS_MAX_GAP_S): chain restarts,
   * the next PVT re-anchors, lock returns after TB_LOCK_MIN_PULSES */
  run(&tb, 50, 55, 30000, NULL, 0);
  TEST_ASSERT_EQUAL_INT(TB_STATE_LOCKED, tb_state(&tb, pod_at(U0 + 54 * 1000000 + 500000)));
  TEST_ASSERT_TRUE(tb_pod_to_unix(&tb, pod_at(U0 + 54 * 1000000 + 500000), &u));
  TEST_ASSERT_INT64_WITHIN(2, U0 + 54 * 1000000 + 500000, u);
}

void test_pvt_without_pps_does_not_anchor(void) {
  timebase_t tb;
  tb_init(&tb);
  TEST_ASSERT_FALSE(tb_on_pvt(&tb, 1000, U0));
  int64_t u;
  TEST_ASSERT_FALSE(tb_pod_to_unix(&tb, 1000, &u));
}

/* ---- clock map (IMU ticks -> pod us) ---- */
void test_clockmap_converges_with_noisy_pairs(void) {
  const double true_us_per_tick = 21.70 * (1.0 + 300e-6); /* IMU osc 300 ppm off */
  clockmap_t cm;
  clockmap_init(&cm, lsm6dsv16x_ts_us_per_tick(0));
  srand(1);
  int64_t err_max = 0;
  for (int i = 0; i < 2000; i++) { /* 20 Hz pairs for 100 s */
    uint64_t tick = 1000 + (uint64_t)i * 2304;  /* 50 ms */
    double pod = 7e6 + (double)(tick - 1000) * true_us_per_tick;
    int noise = (rand() % 201) - 100; /* +-100 us I2C bracket noise */
    clockmap_add_pair(&cm, tick, (int64_t)pod + noise);
    if (i > 600) {
      int64_t m;
      clockmap_map(&cm, tick + 1000, &m);
      int64_t want = (int64_t)(pod + 1000 * true_us_per_tick);
      int64_t e = llabs(m - want);
      if (e > err_max) err_max = e;
    }
  }
  TEST_ASSERT_TRUE(err_max < 60);
  TEST_ASSERT_EQUAL_UINT32(0, cm.resets);
}

void test_lsm_tick_period_formula(void) {
  /* DS13510 §9.52: 1 / (46080 * (1 + 0.0013*FF)) s */
  TEST_ASSERT_DOUBLE_WITHIN(1e-6, 21.7013888, lsm6dsv16x_ts_us_per_tick(0));
  TEST_ASSERT_DOUBLE_WITHIN(1e-4, 1e6 / (46080.0 * (1 - 0.0013 * 10)), lsm6dsv16x_ts_us_per_tick(-10));
}

void test_tick_unwrap(void) {
  tick_unwrap_t u = {0};
  TEST_ASSERT_EQUAL_UINT64(0xFFFFFF00u, tick_unwrap(&u, 0xFFFFFF00u));
  TEST_ASSERT_EQUAL_UINT64(0x100000010ull, tick_unwrap(&u, 0x00000010u)); /* wrapped */
  /* an older reading from before the wrap still maps below 2^32 */
  TEST_ASSERT_EQUAL_UINT64(0xFFFFFFF0u, tick_unwrap(&u, 0xFFFFFFF0u));
  TEST_ASSERT_EQUAL_UINT64(0x100000020ull, tick_unwrap(&u, 0x00000020u));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_days_from_civil_reference_dates);
  RUN_TEST(test_utc_to_unix_us);
  RUN_TEST(test_locks_and_maps_within_microseconds);
  RUN_TEST(test_association_with_large_latency_and_missed_pulses);
  RUN_TEST(test_pvt_older_than_latest_pps_still_associates);
  RUN_TEST(test_glitch_pulse_is_rejected);
  RUN_TEST(test_holdover_then_relock);
  RUN_TEST(test_pvt_without_pps_does_not_anchor);
  RUN_TEST(test_clockmap_converges_with_noisy_pairs);
  RUN_TEST(test_lsm_tick_period_formula);
  RUN_TEST(test_tick_unwrap);
  return UNITY_END();
}
