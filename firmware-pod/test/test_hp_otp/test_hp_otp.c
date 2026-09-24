/* High-performance OTP sequence tests (env:native). The byte strings are
 * u-blox's (IM UBX-22020019 R02 §2.1.5 Table 3 and steps 3/5); these tests
 * make sure the transcription is intact and the classifier is strict. */
#include <string.h>
#include <unity.h>

#include "ubx.h"
#include "ubx_hp_otp.h"

void setUp(void) {}
void tearDown(void) {}

void test_write_sequence_is_two_valid_0641_frames(void) {
  const uint8_t *s = HP_OTP_WRITE_SEQUENCE;
  TEST_ASSERT_EQUAL_UINT(60, sizeof HP_OTP_WRITE_SEQUENCE);
  TEST_ASSERT_TRUE(ubx_frame_is_valid(s, 24));
  TEST_ASSERT_TRUE(ubx_frame_is_valid(s + 24, 36));
  TEST_ASSERT_EQUAL_UINT8(0x06, s[2]);
  TEST_ASSERT_EQUAL_UINT8(0x41, s[3]);
  TEST_ASSERT_EQUAL_UINT8(0x06, s[26]);
  TEST_ASSERT_EQUAL_UINT8(0x41, s[27]);
}

void test_verify_frames_are_valid(void) {
  TEST_ASSERT_TRUE(ubx_frame_is_valid(HP_OTP_EXPECTED_ACK, sizeof HP_OTP_EXPECTED_ACK));
  TEST_ASSERT_TRUE(ubx_frame_is_valid(HP_OTP_VERIFY_POLL, sizeof HP_OTP_VERIFY_POLL));
  TEST_ASSERT_TRUE(
      ubx_frame_is_valid(HP_OTP_VERIFY_EXPECTED_REPLY, sizeof HP_OTP_VERIFY_EXPECTED_REPLY));
}

void test_first_bytes_quoted_from_im_table3(void) {
  /* "B5 62 06 41 10 00 03 00 04 1F 54 5E 79 BF 28 EF 12 05 FD FF FF FF 8F 0D B5 62 06 41 1C" */
  const uint8_t head[] = {0xB5, 0x62, 0x06, 0x41, 0x10, 0x00, 0x03, 0x00, 0x04, 0x1F,
                          0x54, 0x5E, 0x79, 0xBF, 0x28, 0xEF, 0x12, 0x05, 0xFD, 0xFF,
                          0xFF, 0xFF, 0x8F, 0x0D, 0xB5, 0x62, 0x06, 0x41, 0x1C};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(head, HP_OTP_WRITE_SEQUENCE, sizeof head);
  /* "... 0A 00 A4 40 00 D8 B8 05 DE AE" */
  const uint8_t tail[] = {0x0A, 0x00, 0xA4, 0x40, 0x00, 0xD8, 0xB8, 0x05, 0xDE, 0xAE};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(tail, HP_OTP_WRITE_SEQUENCE + 50, sizeof tail);
}

void test_classify_expected_reply_is_set(void) {
  const uint8_t *r = HP_OTP_VERIFY_EXPECTED_REPLY;
  TEST_ASSERT_EQUAL_INT(HP_STATE_SET, hp_otp_classify_reply(r + 6, ubx_u2(r + 4)));
}

void test_classify_default_clock_is_not_set(void) {
  uint8_t pl[36];
  memcpy(pl, HP_OTP_VERIFY_EXPECTED_REPLY + 6, 36);
  /* change the first 192 MHz value (0x0B71B000) to 96 MHz (0x05B8D800) */
  pl[8] = 0x00;
  pl[9] = 0xD8;
  pl[10] = 0xB8;
  pl[11] = 0x05;
  TEST_ASSERT_EQUAL_INT(HP_STATE_NOT_SET, hp_otp_classify_reply(pl, 36));
}

void test_classify_missing_key_is_unknown(void) {
  /* only the first key/value pair present */
  uint8_t pl[12];
  memcpy(pl, HP_OTP_VERIFY_EXPECTED_REPLY + 6, 12);
  TEST_ASSERT_EQUAL_INT(HP_STATE_UNKNOWN, hp_otp_classify_reply(pl, 12));
  TEST_ASSERT_EQUAL_INT(HP_STATE_UNKNOWN, hp_otp_classify_reply(pl, 2));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_write_sequence_is_two_valid_0641_frames);
  RUN_TEST(test_verify_frames_are_valid);
  RUN_TEST(test_first_bytes_quoted_from_im_table3);
  RUN_TEST(test_classify_expected_reply_is_set);
  RUN_TEST(test_classify_default_clock_is_not_set);
  RUN_TEST(test_classify_missing_key_is_unknown);
  return UNITY_END();
}
