// PID response-formatting vectors, byte-for-byte identical to the strings
// packages/core's decode side already asserts on. Provenance is per-vector
// below; every string here must round-trip through
// packages/core/src/telemetry/pidCodec.ts's decodeMode01Response() to the
// value cited in the source test.
#include <unity.h>

#include <cstring>

extern "C" {
#include "pid_codec.h"
}

void setUp() {}
void tearDown() {}

static void assert_format(uint8_t pid, const uint8_t *data, size_t data_len,
                           const char *expected) {
  char out[32];
  size_t n = pid_codec_format_mode01_response(pid, data, data_len, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING(expected, out);
  TEST_ASSERT_EQUAL_UINT(strlen(expected), n);
}

// Source: packages/core/test/telemetry/pidCodec.test.ts `boundaries` table
// (rpm 0x00 0x00 -> 0, rpm 0xFF 0xFF -> 16383.75).
void test_rpm_boundaries() {
  assert_format(0x0C, (const uint8_t[]){0x00, 0x00}, 2, "41 0C 00 00");
  assert_format(0x0C, (const uint8_t[]){0xFF, 0xFF}, 2, "41 0C FF FF");
}

// Source: packages/core/test/telemetry/elm327Session.test.ts `normalReply()`
// -- the scripted transport's canned '010C' reply, decodeMode01Response('rpm', ...) == 1726.
void test_rpm_matches_elm327Session_scripted_reply() {
  assert_format(0x0C, (const uint8_t[]){0x1A, 0xF8}, 2, "41 0C 1A F8");
}

// Source: pidCodec.test.ts `boundaries` (speedKph 0x00 -> 0, 0xFF -> 255).
void test_speed_boundaries() {
  assert_format(0x0D, (const uint8_t[]){0x00}, 1, "41 0D 00");
  assert_format(0x0D, (const uint8_t[]){0xFF}, 1, "41 0D FF");
}

// Source: pidCodec.test.ts `boundaries` (throttlePct 0x00 -> 0, 0xFF -> 100).
void test_throttle_boundaries() {
  assert_format(0x11, (const uint8_t[]){0x00}, 1, "41 11 00");
  assert_format(0x11, (const uint8_t[]){0xFF}, 1, "41 11 FF");
}

// Source: pidCodec.test.ts `boundaries` (coolantC 0x00 -> -40, 0xFF -> 215).
void test_coolant_boundaries() {
  assert_format(0x05, (const uint8_t[]){0x00}, 1, "41 05 00");
  assert_format(0x05, (const uint8_t[]){0xFF}, 1, "41 05 FF");
}

// Source: elm327Session.test.ts `normalReply()` scripted '0105' reply.
void test_coolant_matches_elm327Session_scripted_reply() {
  assert_format(0x05, (const uint8_t[]){0x78}, 1, "41 05 78");
}

// Source: pidCodec.test.ts `boundaries` (intakeC 0x00 -> -40, 0xFF -> 215).
void test_intake_boundaries() {
  assert_format(0x0F, (const uint8_t[]){0x00}, 1, "41 0F 00");
  assert_format(0x0F, (const uint8_t[]){0xFF}, 1, "41 0F FF");
}

// Source: pidCodec.test.ts `boundaries` (engineLoadPct 0x00 -> 0, 0xFF -> 100).
void test_engine_load_boundaries() {
  assert_format(0x04, (const uint8_t[]){0x00}, 1, "41 04 00");
  assert_format(0x04, (const uint8_t[]){0xFF}, 1, "41 04 FF");
}

// Source: pidCodec.test.ts `boundaries` comment "Hand-computed A-40
// boundaries: 0x00 - 40 = -40; 0xFF - 40 = 215" (engineOilC).
void test_engine_oil_boundaries() {
  assert_format(0x5C, (const uint8_t[]){0x00}, 1, "41 5C 00");
  assert_format(0x5C, (const uint8_t[]){0xFF}, 1, "41 5C FF");
}

void test_unknown_pid_reports_zero_bytes_and_formats_nothing() {
  TEST_ASSERT_EQUAL_INT(0, pid_codec_mode01_byte_count(0x99));
  char out[32] = "unchanged";
  size_t n = pid_codec_format_mode01_response(0x99, (const uint8_t[]){0x00}, 1, out, sizeof out);
  TEST_ASSERT_EQUAL_UINT(0, n);
}

void test_wrong_byte_count_is_rejected() {
  // rpm expects 2 bytes; passing 1 must fail closed rather than mis-format.
  char out[32] = "unchanged";
  size_t n = pid_codec_format_mode01_response(0x0C, (const uint8_t[]){0x1A}, 1, out, sizeof out);
  TEST_ASSERT_EQUAL_UINT(0, n);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_rpm_boundaries);
  RUN_TEST(test_rpm_matches_elm327Session_scripted_reply);
  RUN_TEST(test_speed_boundaries);
  RUN_TEST(test_throttle_boundaries);
  RUN_TEST(test_coolant_boundaries);
  RUN_TEST(test_coolant_matches_elm327Session_scripted_reply);
  RUN_TEST(test_intake_boundaries);
  RUN_TEST(test_engine_load_boundaries);
  RUN_TEST(test_engine_oil_boundaries);
  RUN_TEST(test_unknown_pid_reports_zero_bytes_and_formats_nothing);
  RUN_TEST(test_wrong_byte_count_is_rejected);
  return UNITY_END();
}
