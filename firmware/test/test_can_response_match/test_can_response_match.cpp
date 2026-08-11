// hardware/DESIGN.md sec8 item12 (rev A3 NO-GO fix): can_response_match.c is
// the pure, host-testable correlation check that replaces can_obd.cpp's old
// first-frame-wins behaviour (Codex NO-GO review, .foreman/scratch/
// hwpkg-review-out.log: "CAN responses are not correlated to the request").
#include <unity.h>

extern "C" {
#include "can_response_match.h"
}

void setUp() {}
void tearDown() {}

// Mode-01 request "010C" (RPM) -> payload bytes [0x01, 0x0C]; a matching
// positive response echoes PID 0x0C after service 0x41.
void test_mode01_matching_pid_is_accepted() {
  const uint8_t request[] = {0x01, 0x0C};
  const uint8_t response[] = {0x41, 0x0C, 0x1A, 0xF8};
  TEST_ASSERT_TRUE(can_response_matches_request(request, sizeof request, response,
                                                 sizeof response));
}

// Same request, but the frame answers a DIFFERENT PID (0x0D, speed) --
// this is exactly the busy/multi-ECU scenario the NO-GO review flagged:
// first-frame-wins would have silently reported the wrong channel's data.
void test_mode01_wrong_pid_frame_is_rejected() {
  const uint8_t request[] = {0x01, 0x0C};
  const uint8_t response[] = {0x41, 0x0D, 0xFF};
  TEST_ASSERT_FALSE(can_response_matches_request(request, sizeof request, response,
                                                  sizeof response));
}

// Custom read request "221E1C" (service 0x22, DID 0x1E1C) -> positive
// response service must be 0x62 with the DID echoed back.
void test_custom_read_matching_did_is_accepted() {
  const uint8_t request[] = {0x22, 0x1E, 0x1C};
  const uint8_t response[] = {0x62, 0x1E, 0x1C, 0x87};
  TEST_ASSERT_TRUE(can_response_matches_request(request, sizeof request, response,
                                                 sizeof response));
}

// A frame with the right service (0x62) but a DIFFERENT echoed DID must be
// rejected -- not just "any 0x62 frame from a 0x7E8-0x7EF ECU".
void test_custom_read_wrong_did_frame_is_rejected() {
  const uint8_t request[] = {0x22, 0x1E, 0x1C};
  const uint8_t response[] = {0x62, 0x1E, 0x1D, 0x87}; // DID low byte differs
  TEST_ASSERT_FALSE(can_response_matches_request(request, sizeof request, response,
                                                  sizeof response));
}

// A negative response (service 0x7F) must never be mistaken for a match,
// even if it happens to echo the requested service as its second byte
// (ISO 14229 NRC format: 7F <requested-service> <NRC>).
void test_negative_response_0x7F_is_rejected() {
  const uint8_t request[] = {0x22, 0x1E, 0x1C};
  const uint8_t response[] = {0x7F, 0x22, 0x31}; // NRC 0x31 = requestOutOfRange
  TEST_ASSERT_FALSE(can_response_matches_request(request, sizeof request, response,
                                                  sizeof response));
}

// Service 0x21 (single-byte local identifier) uses the same echo rule with
// a 1-byte echo instead of 0x22's 2-byte DID.
void test_service_0x21_matching_local_id_is_accepted() {
  const uint8_t request[] = {0x21, 0x05};
  const uint8_t response[] = {0x61, 0x05, 0x42};
  TEST_ASSERT_TRUE(can_response_matches_request(request, sizeof request, response,
                                                 sizeof response));
}

// A frame too short to even contain the echoed PID/DID must be rejected,
// not treated as an accidental match via out-of-bounds comparison.
void test_response_shorter_than_echo_is_rejected() {
  const uint8_t request[] = {0x22, 0x1E, 0x1C};
  const uint8_t response[] = {0x62, 0x1E}; // DID low byte missing entirely
  TEST_ASSERT_FALSE(can_response_matches_request(request, sizeof request, response,
                                                  sizeof response));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_mode01_matching_pid_is_accepted);
  RUN_TEST(test_mode01_wrong_pid_frame_is_rejected);
  RUN_TEST(test_custom_read_matching_did_is_accepted);
  RUN_TEST(test_custom_read_wrong_did_frame_is_rejected);
  RUN_TEST(test_negative_response_0x7F_is_rejected);
  RUN_TEST(test_service_0x21_matching_local_id_is_accepted);
  RUN_TEST(test_response_shorter_than_echo_is_rejected);
  return UNITY_END();
}
