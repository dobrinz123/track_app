/* Pod BLE protocol tests (env:native): CRC, byte layout (golden offsets from
 * PROTOCOL.md), encode/decode round trips, corruption and gap detection. */
#include <string.h>
#include <unity.h>

#include "pod_protocol.h"

void setUp(void) {}
void tearDown(void) {}

void test_crc16_ccitt_false_check_value(void) {
  /* catalogue check value of CRC-16/CCITT-FALSE for "123456789" */
  TEST_ASSERT_EQUAL_HEX16(0x29B1, pod_crc16((const uint8_t *)"123456789", 9));
  TEST_ASSERT_EQUAL_HEX16(0xFFFF, pod_crc16(NULL, 0));
}

static pod_gnss_t sample_gnss(void) {
  pod_gnss_t g;
  memset(&g, 0, sizeof g);
  g.pod_us = 0x0102030405060708ull;
  g.unix_us = 1790251182099999LL;
  g.itow_ms = 388800100;
  g.lat_e7 = 465234567;
  g.lon_e7 = 244123456;
  g.hmsl_mm = -1234;
  g.vel_n_mm_s = -1234;
  g.vel_e_mm_s = 23456;
  g.vel_d_mm_s = -12;
  g.g_speed_mm_s = 23488;
  g.head_mot_e5 = 9301234;
  g.h_acc_mm = 1234;
  g.v_acc_mm = 2345;
  g.s_acc_mm_s = 150;
  g.head_acc_e5 = 543210;
  g.t_acc_ns = 25;
  g.p_dop_e2 = 132;
  g.fix_type = 3;
  g.num_sv = 14;
  g.flags = POD_GNSS_F_FIX_OK | POD_GNSS_F_POD_TIME_FROM_PPS | POD_GNSS_F_UNIX_VALID;
  g.rate_hz = 20;
  return g;
}

void test_gnss_layout_golden_offsets(void) {
  pod_gnss_t g = sample_gnss();
  uint8_t buf[128];
  size_t n = pod_encode_gnss(0xBEEF, &g, buf, sizeof buf);
  TEST_ASSERT_EQUAL_UINT(POD_OVERHEAD + POD_GNSS_PAYLOAD_LEN, n);
  TEST_ASSERT_EQUAL_UINT(86, n);
  /* header */
  TEST_ASSERT_EQUAL_HEX8(POD_PROTO_VERSION, buf[0]);
  TEST_ASSERT_EQUAL_HEX8(POD_TYPE_GNSS, buf[1]);
  TEST_ASSERT_EQUAL_HEX8(0xEF, buf[2]);
  TEST_ASSERT_EQUAL_HEX8(0xBE, buf[3]);
  TEST_ASSERT_EQUAL_HEX8(78, buf[4]);
  TEST_ASSERT_EQUAL_HEX8(0, buf[5]);
  const uint8_t *p = buf + 6;
  /* pod_us LE at 0 */
  TEST_ASSERT_EQUAL_HEX8(0x08, p[0]);
  TEST_ASSERT_EQUAL_HEX8(0x01, p[7]);
  /* lat_e7 at 20: 465234567 = 0x1BBAEA87 */
  const uint8_t lat[4] = {0x87, 0xEA, 0xBA, 0x1B};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(lat, p + 20, 4);
  /* vel_n at 32: -1234 = 0xFFFFFB2E */
  const uint8_t vn[4] = {0x2E, 0xFB, 0xFF, 0xFF};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(vn, p + 32, 4);
  TEST_ASSERT_EQUAL_HEX8(132, p[72]);
  TEST_ASSERT_EQUAL_HEX8(3, p[74]);
  TEST_ASSERT_EQUAL_HEX8(14, p[75]);
  TEST_ASSERT_EQUAL_HEX8(0xC1, p[76]);
  TEST_ASSERT_EQUAL_HEX8(20, p[77]);
  /* CRC is LE after the payload */
  uint16_t crc = pod_crc16(buf, 6 + 78);
  TEST_ASSERT_EQUAL_HEX8(crc & 0xFF, buf[84]);
  TEST_ASSERT_EQUAL_HEX8(crc >> 8, buf[85]);
}

void test_gnss_round_trip(void) {
  pod_gnss_t g = sample_gnss(), d;
  memset(&d, 0, sizeof d); /* struct padding must compare equal */
  uint8_t buf[128];
  size_t n = pod_encode_gnss(7, &g, buf, sizeof buf);
  pod_frame_t f;
  TEST_ASSERT_EQUAL_INT(POD_DEC_OK, pod_decode_frame(buf, n, &f));
  TEST_ASSERT_EQUAL_UINT16(7, f.seq);
  TEST_ASSERT_EQUAL_INT(POD_DEC_OK, pod_decode_gnss(&f, &d));
  TEST_ASSERT_EQUAL_MEMORY(&g, &d, sizeof g);
}

void test_imu_round_trip_and_mtu_sizing(void) {
  TEST_ASSERT_EQUAL_UINT8(13, pod_imu_samples_per_frame(247));
  TEST_ASSERT_EQUAL_UINT8(9, pod_imu_samples_per_frame(185));
  TEST_ASSERT_EQUAL_UINT8(0, pod_imu_samples_per_frame(23));
  TEST_ASSERT_EQUAL_UINT8(30, pod_imu_samples_per_frame(517)); /* BLE max ATT MTU */
  TEST_ASSERT_EQUAL_UINT8(POD_IMU_MAX_SAMPLES, pod_imu_samples_per_frame(1000));

  pod_imu_batch_t b, d;
  memset(&b, 0, sizeof b);
  b.t0_pod_us = 123456789012ull;
  b.acc_g_per_lsb = 0.000488f;
  b.gyr_dps_per_lsb = 0.070f;
  b.rate_hz = 120;
  b.count = 13;
  b.flags = 1;
  for (int i = 0; i < 13; i++) {
    b.s[i].dt_us = (uint32_t)(i * 8333);
    for (int k = 0; k < 3; k++) {
      b.s[i].acc[k] = (int16_t)(-32768 + i * 1000 + k);
      b.s[i].gyr[k] = (int16_t)(32767 - i * 1000 - k);
    }
  }
  uint8_t buf[256];
  size_t n = pod_encode_imu(9, &b, buf, sizeof buf);
  TEST_ASSERT_EQUAL_UINT(POD_OVERHEAD + POD_IMU_HDR_LEN + 13 * POD_IMU_SAMPLE_LEN, n);
  TEST_ASSERT_TRUE(n <= 247 - 3); /* fits one notification at MTU 247 */
  /* float at payload offset 8 is IEEE-754 LE: 0.000488f = 0x39FFDA40 (Python struct) */
  const uint8_t fa[4] = {0x40, 0xDA, 0xFF, 0x39};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(fa, buf + 6 + 8, 4);
  pod_frame_t f;
  TEST_ASSERT_EQUAL_INT(POD_DEC_OK, pod_decode_frame(buf, n, &f));
  memset(&d, 0, sizeof d);
  TEST_ASSERT_EQUAL_INT(POD_DEC_OK, pod_decode_imu(&f, &d));
  TEST_ASSERT_EQUAL_UINT64(b.t0_pod_us, d.t0_pod_us);
  TEST_ASSERT_EQUAL_FLOAT(b.acc_g_per_lsb, d.acc_g_per_lsb);
  TEST_ASSERT_EQUAL_FLOAT(b.gyr_dps_per_lsb, d.gyr_dps_per_lsb);
  TEST_ASSERT_EQUAL_UINT8(13, d.count);
  TEST_ASSERT_EQUAL_MEMORY(b.s, d.s, 13 * sizeof(pod_imu_sample_t));
  /* too small a buffer must fail cleanly */
  TEST_ASSERT_EQUAL_UINT(0, pod_encode_imu(9, &b, buf, n - 1));
}

void test_status_round_trip(void) {
  pod_status_t s, d;
  memset(&s, 0, sizeof s);
  s.pod_us = 99;
  s.fw_major = 0;
  s.fw_minor = 1;
  s.fw_patch = 2;
  s.hw_rev = 1;
  s.rate_hz = 10;
  s.hp_state = 1;
  s.pps_state = 2;
  s.flags = POD_ST_F_USB_POWER | POD_ST_F_GNSS_OK;
  s.tb_anchor_pod_us = 5000000;
  s.tb_anchor_unix_us = 1790251100000000LL;
  s.tb_rate_ppb = -20123;
  s.pps_age_ms = 0xFFFFFFFFu;
  s.fix_type = 3;
  s.num_sv = 12;
  s.imu_decim = 4;
  s.tx_drops = 5;
  s.imu_overruns = 6;
  s.ubx_errors = 7;
  uint8_t buf[80];
  size_t n = pod_encode_status(1, &s, buf, sizeof buf);
  TEST_ASSERT_EQUAL_UINT(POD_OVERHEAD + POD_STATUS_PAYLOAD_LEN, n);
  pod_frame_t f;
  TEST_ASSERT_EQUAL_INT(POD_DEC_OK, pod_decode_frame(buf, n, &f));
  memset(&d, 0, sizeof d);
  TEST_ASSERT_EQUAL_INT(POD_DEC_OK, pod_decode_status(&f, &d));
  TEST_ASSERT_EQUAL_MEMORY(&s, &d, sizeof s);
}

void test_control_golden_bytes_and_result(void) {
  pod_control_t c = {0x1234, POD_OP_SET_RATE, 1, {20}};
  uint8_t buf[32];
  size_t n = pod_encode_control(&c, buf, sizeof buf);
  TEST_ASSERT_EQUAL_UINT(10, n);
  const uint8_t want_head[] = {0x01, 0x80, 0x34, 0x12, 0x02, 0x00, 0x02, 0x14};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(want_head, buf, sizeof want_head);
  pod_frame_t f;
  pod_control_t d;
  TEST_ASSERT_EQUAL_INT(POD_DEC_OK, pod_decode_frame(buf, n, &f));
  TEST_ASSERT_EQUAL_INT(POD_DEC_OK, pod_decode_control(&f, &d));
  TEST_ASSERT_EQUAL_UINT16(0x1234, d.seq);
  TEST_ASSERT_EQUAL_UINT8(POD_OP_SET_RATE, d.opcode);
  TEST_ASSERT_EQUAL_UINT8(1, d.arg_len);
  TEST_ASSERT_EQUAL_UINT8(20, d.args[0]);

  pod_control_result_t r = {POD_OP_SET_RATE, POD_RES_REFUSED_HP_NOT_SET, 0x1234}, rd;
  n = pod_encode_control_result(55, &r, buf, sizeof buf);
  TEST_ASSERT_EQUAL_UINT(12, n);
  TEST_ASSERT_EQUAL_INT(POD_DEC_OK, pod_decode_frame(buf, n, &f));
  TEST_ASSERT_EQUAL_INT(POD_DEC_OK, pod_decode_control_result(&f, &rd));
  TEST_ASSERT_EQUAL_UINT8(POD_RES_REFUSED_HP_NOT_SET, rd.result);
  TEST_ASSERT_EQUAL_UINT16(0x1234, rd.echo_seq);
}

void test_protocol_md_examples(void) {
  /* the example frames printed in PROTOCOL.md (CRC computed there with an
   * independent Python implementation) */
  uint8_t buf[32];
  pod_control_t c1 = {1, POD_OP_SET_STREAMS, 1, {7}};
  const uint8_t e1[] = {0x01, 0x80, 0x01, 0x00, 0x02, 0x00, 0x01, 0x07, 0x0A, 0x36};
  TEST_ASSERT_EQUAL_UINT(sizeof e1, pod_encode_control(&c1, buf, sizeof buf));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(e1, buf, sizeof e1);
  pod_control_t c2 = {2, POD_OP_SET_RATE, 1, {20}};
  const uint8_t e2[] = {0x01, 0x80, 0x02, 0x00, 0x02, 0x00, 0x02, 0x14, 0xEB, 0x8F};
  TEST_ASSERT_EQUAL_UINT(sizeof e2, pod_encode_control(&c2, buf, sizeof buf));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(e2, buf, sizeof e2);
  pod_control_t c4 = {4, POD_OP_GET_STATUS, 0, {0}};
  const uint8_t e4[] = {0x01, 0x80, 0x04, 0x00, 0x01, 0x00, 0x04, 0x3D, 0x63};
  TEST_ASSERT_EQUAL_UINT(sizeof e4, pod_encode_control(&c4, buf, sizeof buf));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(e4, buf, sizeof e4);
  pod_control_result_t r = {POD_OP_SET_RATE, POD_RES_OK, 2};
  const uint8_t er[] = {0x01, 0x04, 0x11, 0x00, 0x04, 0x00, 0x02, 0x00, 0x02, 0x00, 0x5F, 0xE5};
  TEST_ASSERT_EQUAL_UINT(sizeof er, pod_encode_control_result(17, &r, buf, sizeof buf));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(er, buf, sizeof er);
}

void test_corruption_is_detected(void) {
  pod_gnss_t g = sample_gnss();
  uint8_t buf[128];
  size_t n = pod_encode_gnss(1, &g, buf, sizeof buf);
  pod_frame_t f;
  for (size_t i = 0; i < n; i++) {
    uint8_t save = buf[i];
    buf[i] ^= 0x01;
    TEST_ASSERT_NOT_EQUAL(POD_DEC_OK, pod_decode_frame(buf, n, &f));
    buf[i] = save;
  }
  TEST_ASSERT_EQUAL_INT(POD_DEC_SHORT, pod_decode_frame(buf, n - 1, &f));
  TEST_ASSERT_EQUAL_INT(POD_DEC_SHORT, pod_decode_frame(buf, 5, &f));
  buf[0] = 2;
  TEST_ASSERT_EQUAL_INT(POD_DEC_BAD_VERSION, pod_decode_frame(buf, n, &f));
}

void test_type_mismatch_and_bad_imu_count(void) {
  pod_gnss_t g = sample_gnss();
  uint8_t buf[128];
  size_t n = pod_encode_gnss(1, &g, buf, sizeof buf);
  pod_frame_t f;
  pod_status_t s;
  pod_decode_frame(buf, n, &f);
  TEST_ASSERT_EQUAL_INT(POD_DEC_BAD_TYPE, pod_decode_status(&f, &s));
  pod_imu_batch_t b;
  memset(&b, 0, sizeof b);
  TEST_ASSERT_EQUAL_UINT(0, pod_encode_imu(1, &b, buf, sizeof buf)); /* count 0 */
}

void test_seq_gap(void) {
  TEST_ASSERT_EQUAL_UINT16(0, pod_seq_gap(10, 11));
  TEST_ASSERT_EQUAL_UINT16(2, pod_seq_gap(10, 13));
  TEST_ASSERT_EQUAL_UINT16(0, pod_seq_gap(0xFFFF, 0));
  TEST_ASSERT_EQUAL_UINT16(1, pod_seq_gap(0xFFFF, 1));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_crc16_ccitt_false_check_value);
  RUN_TEST(test_gnss_layout_golden_offsets);
  RUN_TEST(test_gnss_round_trip);
  RUN_TEST(test_imu_round_trip_and_mtu_sizing);
  RUN_TEST(test_status_round_trip);
  RUN_TEST(test_control_golden_bytes_and_result);
  RUN_TEST(test_protocol_md_examples);
  RUN_TEST(test_corruption_is_detected);
  RUN_TEST(test_type_mismatch_and_bad_imu_count);
  RUN_TEST(test_seq_gap);
  return UNITY_END();
}
