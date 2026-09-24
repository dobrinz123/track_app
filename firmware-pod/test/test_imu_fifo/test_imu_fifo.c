/* LSM6DSV16X FIFO tag decoding tests (env:native).
 * Word format per DS13510 Rev 4 §9.84 (TAG_SENSOR[7:3], TAG_CNT[2:1]) and
 * AN5763 Rev 2 Table 89 (timestamp word: X_L..Y_H = TIMESTAMP[31:0]). */
#include <string.h>
#include <unity.h>

#include "imu_fifo.h"
#include "lsm6dsv16x_regs.h"

void setUp(void) {}
void tearDown(void) {}

typedef struct {
  int n;
  imu_raw_sample_t s[64];
} sink_t;

static void on_sample(const imu_raw_sample_t *s, void *ctx) {
  sink_t *k = (sink_t *)ctx;
  if (k->n < 64) k->s[k->n] = *s;
  k->n++;
}

static void mkword(uint8_t w[7], uint8_t sensor, uint8_t cnt, int16_t x, int16_t y, int16_t z) {
  w[0] = (uint8_t)((sensor << 3) | ((cnt & 3) << 1));
  w[1] = (uint8_t)x;
  w[2] = (uint8_t)((uint16_t)x >> 8);
  w[3] = (uint8_t)y;
  w[4] = (uint8_t)((uint16_t)y >> 8);
  w[5] = (uint8_t)z;
  w[6] = (uint8_t)((uint16_t)z >> 8);
}

static void mkts(uint8_t w[7], uint8_t cnt, uint32_t ts) {
  w[0] = (uint8_t)((LSM_TAG_TIMESTAMP << 3) | ((cnt & 3) << 1));
  w[1] = (uint8_t)ts;
  w[2] = (uint8_t)(ts >> 8);
  w[3] = (uint8_t)(ts >> 16);
  w[4] = (uint8_t)(ts >> 24);
  w[5] = 0x08; /* BDR_SHUB etc. (ignored) */
  w[6] = 0x88; /* BDR_GY | BDR_XL = 480 Hz meta-info (ignored) */
}

/* feed slots [from, to): ts every 8th slot (ts_first => ts word before data) */
static void feed(imu_fifo_dec_t *d, sink_t *k, int from, int to, uint32_t ts0, bool ts_first) {
  uint8_t w[7];
  for (int slot = from; slot < to; slot++) {
    uint8_t cnt = (uint8_t)(slot & 3);
    bool ts = (slot % 8) == 0;
    if (ts && ts_first) {
      mkts(w, cnt, ts0 + 96u * (uint32_t)slot);
      imu_fifo_dec_word(d, w, on_sample, k);
    }
    mkword(w, LSM_TAG_GYRO_NC, cnt, (int16_t)(slot * 10), -1, 2);
    imu_fifo_dec_word(d, w, on_sample, k);
    mkword(w, LSM_TAG_ACC_NC, cnt, (int16_t)slot, 0, 2049);
    imu_fifo_dec_word(d, w, on_sample, k);
    if (ts && !ts_first) {
      mkts(w, cnt, ts0 + 96u * (uint32_t)slot);
      imu_fifo_dec_word(d, w, on_sample, k);
    }
  }
}

void test_tag_fields(void) {
  uint8_t w[7];
  mkword(w, LSM_TAG_ACC_NC, 2, 0, 0, 0);
  TEST_ASSERT_EQUAL_HEX8(0x14, w[0]); /* 00010 10 0 */
  mkts(w, 3, 0);
  TEST_ASSERT_EQUAL_HEX8(0x26, w[0]); /* 00100 11 0 */
}

void test_slots_get_interpolated_timestamps(void) {
  imu_fifo_dec_t d;
  sink_t k = {0};
  imu_fifo_dec_init(&d, LSM_TICKS_PER_SLOT_480HZ);
  feed(&d, &k, 0, 24, 1000, true);
  TEST_ASSERT_EQUAL_INT(23, k.n); /* the last slot is still open */
  for (int i = 0; i < 23; i++) {
    TEST_ASSERT_EQUAL_UINT64(1000u + 96u * (unsigned)i, k.s[i].tick);
    TEST_ASSERT_EQUAL_INT16(i, k.s[i].acc[0]);
    TEST_ASSERT_EQUAL_INT16(2049, k.s[i].acc[2]);
    TEST_ASSERT_EQUAL_INT16(i * 10, k.s[i].gyr[0]);
    TEST_ASSERT_EQUAL_INT16(-1, k.s[i].gyr[1]);
  }
  TEST_ASSERT_EQUAL_UINT32(3, d.timestamps);
  TEST_ASSERT_EQUAL_UINT32(0, d.slot_skips);
}

void test_timestamp_word_after_data_in_same_slot(void) {
  imu_fifo_dec_t d;
  sink_t k = {0};
  imu_fifo_dec_init(&d, LSM_TICKS_PER_SLOT_480HZ);
  feed(&d, &k, 0, 17, 5000, false);
  TEST_ASSERT_EQUAL_INT(16, k.n);
  TEST_ASSERT_EQUAL_UINT64(5000u, k.s[0].tick);
  TEST_ASSERT_EQUAL_UINT64(5000u + 96u * 15u, k.s[15].tick);
}

void test_samples_before_first_timestamp_are_dropped(void) {
  imu_fifo_dec_t d;
  sink_t k = {0};
  imu_fifo_dec_init(&d, LSM_TICKS_PER_SLOT_480HZ);
  feed(&d, &k, 3, 17, 0, true); /* first ts at slot 8 */
  TEST_ASSERT_EQUAL_UINT32(5, d.dropped_unanchored); /* slots 3..7 */
  TEST_ASSERT_EQUAL_INT(8, k.n);                     /* slots 8..15 */
  TEST_ASSERT_EQUAL_UINT64(96u * 8u, k.s[0].tick);
}

void test_split_across_bursts_and_incomplete_slot(void) {
  imu_fifo_dec_t d;
  sink_t k = {0};
  uint8_t w[7];
  imu_fifo_dec_init(&d, LSM_TICKS_PER_SLOT_480HZ);
  mkts(w, 0, 100);
  imu_fifo_dec_word(&d, w, on_sample, &k);
  mkword(w, LSM_TAG_GYRO_NC, 0, 1, 1, 1);
  imu_fifo_dec_word(&d, w, on_sample, &k);
  /* burst ends here; next burst continues the same slot */
  mkword(w, LSM_TAG_ACC_NC, 0, 2, 2, 2);
  imu_fifo_dec_word(&d, w, on_sample, &k);
  /* slot 1 has only a gyro word */
  mkword(w, LSM_TAG_GYRO_NC, 1, 3, 3, 3);
  imu_fifo_dec_word(&d, w, on_sample, &k);
  mkword(w, LSM_TAG_GYRO_NC, 2, 4, 4, 4);
  imu_fifo_dec_word(&d, w, on_sample, &k);
  TEST_ASSERT_EQUAL_INT(1, k.n);
  TEST_ASSERT_EQUAL_UINT64(100, k.s[0].tick);
  TEST_ASSERT_EQUAL_UINT32(1, d.dropped_incomplete);
}

void test_empty_and_unknown_tags(void) {
  imu_fifo_dec_t d;
  sink_t k = {0};
  uint8_t w[7] = {0};
  imu_fifo_dec_init(&d, LSM_TICKS_PER_SLOT_480HZ);
  imu_fifo_dec_word(&d, w, on_sample, &k); /* 0x00 = FIFO empty */
  TEST_ASSERT_EQUAL_UINT32(0, d.words);
  mkword(w, LSM_TAG_CFG_CHANGE, 0, 0, 0, 0);
  imu_fifo_dec_word(&d, w, on_sample, &k);
  TEST_ASSERT_EQUAL_UINT32(1, d.other_tags);
}

void test_resync_after_overrun(void) {
  imu_fifo_dec_t d;
  sink_t k = {0};
  imu_fifo_dec_init(&d, LSM_TICKS_PER_SLOT_480HZ);
  feed(&d, &k, 0, 10, 0, true);
  imu_fifo_dec_resync(&d);
  int before = k.n;
  /* after an overrun the stream resumes at an unknown slot: slots are
   * only emitted again once a new timestamp arrives */
  feed(&d, &k, 37, 50, 0, true);
  TEST_ASSERT_EQUAL_UINT32(3, d.dropped_unanchored); /* 37,38,39 */
  TEST_ASSERT_EQUAL_UINT64(96u * 40u, k.s[before].tick);
}

void test_decimator_box_average(void) {
  imu_decim_t z;
  imu_decim_init(&z, 4);
  imu_sample_t in, out;
  int outs = 0;
  for (int i = 0; i < 8; i++) {
    in.pod_us = 1000000 + i * 2083;
    for (int a = 0; a < 3; a++) {
      in.acc[a] = (int16_t)(i * 4 + a);
      in.gyr[a] = (int16_t)(-i);
    }
    if (imu_decim_push(&z, &in, &out)) {
      outs++;
      if (outs == 1) {
        /* mean of 0,4,8,12 = 6 ; time = mean of the 4 times */
        TEST_ASSERT_EQUAL_INT16(6, out.acc[0]);
        TEST_ASSERT_EQUAL_INT16(8, out.acc[2]);
        TEST_ASSERT_EQUAL_INT16(-2, out.gyr[0]); /* mean -1.5 rounds away from 0 */
        TEST_ASSERT_EQUAL_INT64(1000000 + (0 + 2083 + 4166 + 6249 + 2) / 4, out.pod_us);
      }
    }
  }
  TEST_ASSERT_EQUAL_INT(2, outs);
  imu_decim_init(&z, 1);
  TEST_ASSERT_TRUE(imu_decim_push(&z, &in, &out));
  TEST_ASSERT_EQUAL_INT64(in.pod_us, out.pod_us);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_tag_fields);
  RUN_TEST(test_slots_get_interpolated_timestamps);
  RUN_TEST(test_timestamp_word_after_data_in_same_slot);
  RUN_TEST(test_samples_before_first_timestamp_are_dropped);
  RUN_TEST(test_split_across_bursts_and_incomplete_slot);
  RUN_TEST(test_empty_and_unknown_tags);
  RUN_TEST(test_resync_after_overrun);
  RUN_TEST(test_decimator_box_average);
  return UNITY_END();
}
