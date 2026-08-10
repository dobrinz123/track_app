// The single-chokepoint read-only guard (EXPECTED OUTCOME 2d): whitelist
// mode 01 (show current data) and the two read-only custom services (21/22)
// the app's custom-PID contract uses; reject everything else, explicitly
// including 04 (clear DTCs), 08 (actuation), 2F (IO control), 3E (tester
// present).
#include <unity.h>

#include <cstring>
#include <string>
#include <vector>

extern "C" {
#include "read_only_guard.h"
}

namespace {
std::vector<std::string> g_logged;
void capture_log(const char *msg) { g_logged.push_back(msg); }
} // namespace

void setUp() {
  g_logged.clear();
  guard_set_logger(capture_log);
}
void tearDown() { guard_set_logger(nullptr); }

struct GuardCase {
  const char *name;
  uint8_t service;
  bool expected_allowed;
};

// The binding whitelist/blacklist table (also reproduced in the delegation
// report per ticket MUST DO).
static const GuardCase kTable[] = {
    {"mode 01 (show current data)", 0x01, true},
    {"service 21 (read by local id)", 0x21, true},
    {"service 22 (read data by identifier)", 0x22, true},
    {"mode 03 (read DTCs)", 0x03, false},
    {"mode 04 (clear DTCs)", 0x04, false},
    {"mode 08 (request control / actuation)", 0x08, false},
    {"service 2F (IO control by identifier)", 0x2F, false},
    {"service 3E (tester present)", 0x3E, false},
    {"service 3D (write data by identifier)", 0x3D, false},
    {"service 10 (diagnostic session control)", 0x10, false},
};

void test_whitelist_and_blacklist_table() {
  for (const auto &c : kTable) {
    uint8_t frame[8] = {0x02, c.service, 0x00};
    bool allowed = guard_can_transmit(frame, sizeof frame);
    TEST_ASSERT_EQUAL_MESSAGE(c.expected_allowed, allowed, c.name);
  }
}

void test_rejects_null_frame() {
  TEST_ASSERT_FALSE(guard_can_transmit(nullptr, 8));
}

void test_rejects_dlc_below_two() {
  uint8_t frame[8] = {0x01, 0x01};
  TEST_ASSERT_FALSE(guard_can_transmit(frame, 1));
}

void test_rejects_zero_length_nibble() {
  uint8_t frame[8] = {0x00, 0x01};
  TEST_ASSERT_FALSE(guard_can_transmit(frame, 8));
}

void test_rejects_length_nibble_exceeding_payload() {
  // Claims 7 payload bytes but dlc only covers 2.
  uint8_t frame[8] = {0x07, 0x01};
  TEST_ASSERT_FALSE(guard_can_transmit(frame, 2));
}

void test_allows_well_formed_mode01_request() {
  // "01 0C" -- exactly what can_obd.cpp sends for the rpm PID.
  uint8_t frame[8] = {0x02, 0x01, 0x0C, 0, 0, 0, 0, 0};
  TEST_ASSERT_TRUE(guard_can_transmit(frame, 8));
}

void test_rejection_is_logged() {
  uint8_t frame[8] = {0x02, 0x04, 0x00}; // mode 04 clear DTCs
  guard_can_transmit(frame, 8);
  TEST_ASSERT_EQUAL_INT(1, (int)g_logged.size());
  TEST_ASSERT_TRUE(g_logged[0].find("0x04") != std::string::npos);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_whitelist_and_blacklist_table);
  RUN_TEST(test_rejects_null_frame);
  RUN_TEST(test_rejects_dlc_below_two);
  RUN_TEST(test_rejects_zero_length_nibble);
  RUN_TEST(test_rejects_length_nibble_exceeding_payload);
  RUN_TEST(test_allows_well_formed_mode01_request);
  RUN_TEST(test_rejection_is_logged);
  return UNITY_END();
}
