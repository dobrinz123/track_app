/* GNSS configuration builder tests (env:native). */
#include <string.h>
#include <unity.h>

#include "gnss_config.h"
#include "ubx.h"

void setUp(void) {}
void tearDown(void) {}

/* Extract key=value from a VALSET frame; returns false if absent. Also checks
 * the frame is RAM-layer only. */
static bool valset_get(const uint8_t *frame, size_t n, uint32_t key, uint64_t *val) {
  TEST_ASSERT_TRUE(ubx_frame_is_valid(frame, n));
  TEST_ASSERT_EQUAL_UINT8(0x06, frame[2]);
  TEST_ASSERT_EQUAL_UINT8(0x8A, frame[3]);
  const uint8_t *pl = frame + 6;
  uint16_t len = ubx_u2(frame + 4);
  TEST_ASSERT_EQUAL_UINT8(0x00, pl[0]); /* version 0 */
  TEST_ASSERT_EQUAL_UINT8(UBX_VALSET_LAYER_RAM, pl[1]);
  /* VALSET and VALGET-reply share the key/value layout after 4 bytes */
  return ubx_valget_find(pl, len, key, val);
}

void test_rate_policy(void) {
  TEST_ASSERT_TRUE(gnss_rate_allowed(GNSS_RATE_10HZ_GPS_GAL, HP_STATE_UNKNOWN));
  TEST_ASSERT_TRUE(gnss_rate_allowed(GNSS_RATE_10HZ_GPS_GAL, HP_STATE_NOT_SET));
  TEST_ASSERT_FALSE(gnss_rate_allowed(GNSS_RATE_20HZ_GPS_GAL, HP_STATE_NOT_SET));
  TEST_ASSERT_FALSE(gnss_rate_allowed(GNSS_RATE_20HZ_GPS_GAL, HP_STATE_UNKNOWN));
  TEST_ASSERT_FALSE(gnss_rate_allowed(GNSS_RATE_25HZ_GPS, HP_STATE_UNKNOWN));
  TEST_ASSERT_TRUE(gnss_rate_allowed(GNSS_RATE_20HZ_GPS_GAL, HP_STATE_SET));
  TEST_ASSERT_TRUE(gnss_rate_allowed(GNSS_RATE_25HZ_GPS, HP_STATE_SET));
  TEST_ASSERT_FALSE(gnss_rate_allowed((gnss_rate_mode_t)15, HP_STATE_SET));
}

void test_rate_frames(void) {
  uint8_t f[128];
  uint64_t v;
  const struct {
    gnss_rate_mode_t m;
    uint16_t meas;
  } cases[] = {{GNSS_RATE_10HZ_GPS_GAL, 100}, {GNSS_RATE_20HZ_GPS_GAL, 50}, {GNSS_RATE_25HZ_GPS, 40}};
  for (int i = 0; i < 3; i++) {
    size_t n = gnss_cfg_build_rate(cases[i].m, f, sizeof f);
    TEST_ASSERT_TRUE(n > 0);
    TEST_ASSERT_TRUE(valset_get(f, n, CFG_RATE_MEAS, &v));
    TEST_ASSERT_EQUAL_UINT64(cases[i].meas, v);
    TEST_ASSERT_TRUE(valset_get(f, n, CFG_RATE_NAV, &v));
    TEST_ASSERT_EQUAL_UINT64(1, v);
    TEST_ASSERT_TRUE(valset_get(f, n, CFG_MSGOUT_UBX_NAV_SAT_UART1, &v));
    TEST_ASSERT_EQUAL_UINT64((uint64_t)cases[i].m, v); /* NAV-SAT ~1 Hz */
  }
}

void test_signal_sets(void) {
  uint8_t f[160];
  uint64_t v;
  size_t n = gnss_cfg_build_signals(GNSS_RATE_10HZ_GPS_GAL, f, sizeof f);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_SIGNAL_GAL_ENA, &v));
  TEST_ASSERT_EQUAL_UINT64(1, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_SIGNAL_GPS_ENA, &v));
  TEST_ASSERT_EQUAL_UINT64(1, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_SIGNAL_BDS_ENA, &v));
  TEST_ASSERT_EQUAL_UINT64(0, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_SIGNAL_GLO_ENA, &v));
  TEST_ASSERT_EQUAL_UINT64(0, v);
  n = gnss_cfg_build_signals(GNSS_RATE_25HZ_GPS, f, sizeof f);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_SIGNAL_GAL_ENA, &v));
  TEST_ASSERT_EQUAL_UINT64(0, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_SIGNAL_QZSS_ENA, &v));
  TEST_ASSERT_EQUAL_UINT64(1, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_SIGNAL_SBAS_ENA, &v));
  TEST_ASSERT_EQUAL_UINT64(1, v);
}

void test_base_config_timepulse_locked_only(void) {
  uint8_t f[256];
  uint64_t v;
  size_t n = gnss_cfg_build_base(GNSS_RATE_10HZ_GPS_GAL, f, sizeof f);
  TEST_ASSERT_TRUE(n > 0);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_TP_LEN_TP1, &v));
  TEST_ASSERT_EQUAL_UINT64(0, v); /* no pulse while unlocked */
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_TP_LEN_LOCK_TP1, &v));
  TEST_ASSERT_EQUAL_UINT64(100000, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_TP_PERIOD_LOCK_TP1, &v));
  TEST_ASSERT_EQUAL_UINT64(1000000, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_TP_USE_LOCKED_TP1, &v));
  TEST_ASSERT_EQUAL_UINT64(1, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_TP_POL_TP1, &v));
  TEST_ASSERT_EQUAL_UINT64(1, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_UART1OUTPROT_NMEA, &v));
  TEST_ASSERT_EQUAL_UINT64(0, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_NAVSPG_DYNMODEL, &v));
  TEST_ASSERT_EQUAL_UINT64(4, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_MSGOUT_UBX_NAV_PVT_UART1, &v));
  TEST_ASSERT_EQUAL_UINT64(1, v);
}

void test_baud_frame(void) {
  uint8_t f[32];
  uint64_t v;
  size_t n = gnss_cfg_build_baud(GNSS_BAUD_RUN, f, sizeof f);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_UART1_BAUDRATE, &v));
  TEST_ASSERT_EQUAL_UINT64(460800, v);
}

void test_no_frame_writes_bbr_or_flash(void) {
  uint8_t f[256];
  size_t n;
  n = gnss_cfg_build_base(GNSS_RATE_10HZ_GPS_GAL, f, sizeof f);
  TEST_ASSERT_EQUAL_UINT8(0x01, f[7]);
  n = gnss_cfg_build_signals(GNSS_RATE_20HZ_GPS_GAL, f, sizeof f);
  TEST_ASSERT_EQUAL_UINT8(0x01, f[7]);
  n = gnss_cfg_build_rate(GNSS_RATE_25HZ_GPS, f, sizeof f);
  TEST_ASSERT_EQUAL_UINT8(0x01, f[7]);
  n = gnss_cfg_build_baud(GNSS_BAUD_RUN, f, sizeof f);
  TEST_ASSERT_EQUAL_UINT8(0x01, f[7]);
  (void)n;
}

/* The VALGET reply a receiver would send for a mode poll; corrupt_index >= 0
 * flips bit 0 of that item's value. */
static size_t reply_for(gnss_rate_mode_t m, uint8_t *pl, size_t cap, int corrupt_index) {
  uint32_t k[GNSS_MODE_MAX_ITEMS];
  uint64_t v[GNSS_MODE_MAX_ITEMS];
  size_t n = gnss_cfg_mode_items(m, k, v, GNSS_MODE_MAX_ITEMS);
  size_t off = 4;
  pl[0] = 0x01;
  pl[1] = 0x00;
  pl[2] = pl[3] = 0;
  for (size_t i = 0; i < n; i++) {
    size_t vs = ubx_cfg_key_value_size(k[i]);
    TEST_ASSERT_TRUE(off + 4 + vs <= cap);
    for (int b = 0; b < 4; b++) pl[off + b] = (uint8_t)(k[i] >> (8 * b));
    uint64_t val = v[i] ^ ((int)i == corrupt_index ? 1u : 0u);
    for (size_t b = 0; b < vs; b++) pl[off + 4 + b] = (uint8_t)(val >> (8 * b));
    off += 4 + vs;
  }
  return off;
}

void test_mode_is_one_atomic_valset(void) {
  uint8_t f[256];
  uint64_t v;
  size_t n = gnss_cfg_build_mode(GNSS_RATE_25HZ_GPS, f, sizeof f);
  TEST_ASSERT_TRUE(n > 0);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_SIGNAL_GAL_ENA, &v)); /* constellations ... */
  TEST_ASSERT_EQUAL_UINT64(0, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_RATE_MEAS, &v)); /* ... and rate together */
  TEST_ASSERT_EQUAL_UINT64(40, v);
  n = gnss_cfg_build_mode(GNSS_RATE_20HZ_GPS_GAL, f, sizeof f);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_SIGNAL_GAL_ENA, &v));
  TEST_ASSERT_EQUAL_UINT64(1, v);
  TEST_ASSERT_TRUE(valset_get(f, n, CFG_RATE_MEAS, &v));
  TEST_ASSERT_EQUAL_UINT64(50, v);
  TEST_ASSERT_EQUAL_UINT(0, gnss_cfg_build_mode((gnss_rate_mode_t)15, f, sizeof f));
}

void test_mode_poll_and_readback_verification(void) {
  uint8_t poll[128], pl[256];
  size_t n = gnss_cfg_build_mode_poll(GNSS_RATE_20HZ_GPS_GAL, poll, sizeof poll);
  TEST_ASSERT_TRUE(ubx_frame_is_valid(poll, n));
  TEST_ASSERT_EQUAL_HEX8(0x8B, poll[3]);
  TEST_ASSERT_EQUAL_HEX8(0x00, poll[7]); /* RAM layer */
  size_t r = reply_for(GNSS_RATE_20HZ_GPS_GAL, pl, sizeof pl, -1);
  TEST_ASSERT_TRUE(gnss_cfg_verify_mode(pl, (uint16_t)r, GNSS_RATE_20HZ_GPS_GAL));
  /* Codex MEDIUM 9 scenario: receiver really runs GPS+GAL, firmware thinks 25 Hz */
  TEST_ASSERT_FALSE(gnss_cfg_verify_mode(pl, (uint16_t)r, GNSS_RATE_25HZ_GPS));
  for (int i = 0; i < 14; i++) {
    r = reply_for(GNSS_RATE_20HZ_GPS_GAL, pl, sizeof pl, i);
    TEST_ASSERT_FALSE(gnss_cfg_verify_mode(pl, (uint16_t)r, GNSS_RATE_20HZ_GPS_GAL));
  }
  r = reply_for(GNSS_RATE_10HZ_GPS_GAL, pl, sizeof pl, -1);
  TEST_ASSERT_FALSE(gnss_cfg_verify_mode(pl, (uint16_t)(r - 1), GNSS_RATE_10HZ_GPS_GAL));
  pl[1] = 0x07; /* default layer instead of RAM */
  TEST_ASSERT_FALSE(gnss_cfg_verify_mode(pl, (uint16_t)r, GNSS_RATE_10HZ_GPS_GAL));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_rate_policy);
  RUN_TEST(test_rate_frames);
  RUN_TEST(test_signal_sets);
  RUN_TEST(test_base_config_timepulse_locked_only);
  RUN_TEST(test_baud_frame);
  RUN_TEST(test_no_frame_writes_bbr_or_flash);
  RUN_TEST(test_mode_is_one_atomic_valset);
  RUN_TEST(test_mode_poll_and_readback_verification);
  return UNITY_END();
}
