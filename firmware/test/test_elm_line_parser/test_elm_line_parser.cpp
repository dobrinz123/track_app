// ELM line framer: input framing across arbitrary chunk/byte boundaries
// (docs/architecture/contracts.md's ObdTransport contract applies
// symmetrically to what the server must tolerate reading from the client).
#include <unity.h>

#include <cstring>

extern "C" {
#include "elm_line_parser.h"
}

void setUp() {}
void tearDown() {}

static bool push_string(ElmLineFramer *f, const char *s, char *out, size_t out_cap) {
  bool ready = false;
  for (const char *p = s; *p != '\0'; p++) {
    ready = elm_line_framer_push(f, *p, out, out_cap);
  }
  return ready;
}

void test_frames_a_simple_cr_terminated_command() {
  ElmLineFramer f;
  elm_line_framer_reset(&f);
  char out[ELM_LINE_MAX];
  TEST_ASSERT_TRUE(push_string(&f, "ATZ\r", out, sizeof out));
  TEST_ASSERT_EQUAL_STRING("ATZ", out);
}

void test_lowercase_input_is_uppercased() {
  ElmLineFramer f;
  elm_line_framer_reset(&f);
  char out[ELM_LINE_MAX];
  TEST_ASSERT_TRUE(push_string(&f, "atz\r", out, sizeof out));
  TEST_ASSERT_EQUAL_STRING("ATZ", out);
}

void test_tolerates_lf_terminator() {
  ElmLineFramer f;
  elm_line_framer_reset(&f);
  char out[ELM_LINE_MAX];
  TEST_ASSERT_TRUE(push_string(&f, "010C\n", out, sizeof out));
  TEST_ASSERT_EQUAL_STRING("010C", out);
}

void test_bare_crlf_pair_swallows_the_empty_second_line() {
  ElmLineFramer f;
  elm_line_framer_reset(&f);
  char out[ELM_LINE_MAX];
  // "010C\r\n" -- CR completes the command, the following bare LF must not
  // surface a second, empty "command".
  bool ready_after_cr = false;
  bool ready_after_lf = false;
  ready_after_cr = elm_line_framer_push(&f, '0', out, sizeof out);
  ready_after_cr = elm_line_framer_push(&f, '1', out, sizeof out) || ready_after_cr;
  ready_after_cr = elm_line_framer_push(&f, '0', out, sizeof out) || ready_after_cr;
  ready_after_cr = elm_line_framer_push(&f, 'C', out, sizeof out) || ready_after_cr;
  ready_after_cr = elm_line_framer_push(&f, '\r', out, sizeof out);
  TEST_ASSERT_TRUE(ready_after_cr);
  TEST_ASSERT_EQUAL_STRING("010C", out);
  ready_after_lf = elm_line_framer_push(&f, '\n', out, sizeof out);
  TEST_ASSERT_FALSE(ready_after_lf);
}

void test_survives_being_split_at_every_possible_byte_boundary() {
  // The command "ATE0\r" delivered one byte at a time (worst-case TCP
  // fragmentation) must still frame to exactly one command.
  const char *command = "ATE0\r";
  int ready_count = 0;
  ElmLineFramer f;
  elm_line_framer_reset(&f);
  char out[ELM_LINE_MAX];
  for (const char *p = command; *p != '\0'; p++) {
    if (elm_line_framer_push(&f, *p, out, sizeof out)) ready_count++;
  }
  TEST_ASSERT_EQUAL_INT(1, ready_count);
  TEST_ASSERT_EQUAL_STRING("ATE0", out);
}

void test_trims_surrounding_whitespace() {
  ElmLineFramer f;
  elm_line_framer_reset(&f);
  char out[ELM_LINE_MAX];
  TEST_ASSERT_TRUE(push_string(&f, "  010C  \r", out, sizeof out));
  TEST_ASSERT_EQUAL_STRING("010C", out);
}

void test_overflow_truncates_but_still_terminates() {
  ElmLineFramer f;
  elm_line_framer_reset(&f);
  char out[ELM_LINE_MAX];
  // ELM_LINE_MAX is 32; feed well past it before the terminator.
  char long_cmd[64];
  for (int i = 0; i < 63; i++) long_cmd[i] = 'A';
  long_cmd[63] = '\0';
  bool ready = false;
  for (const char *p = long_cmd; *p != '\0'; p++) ready = elm_line_framer_push(&f, *p, out, sizeof out);
  TEST_ASSERT_FALSE(ready); // terminator not sent yet
  ready = elm_line_framer_push(&f, '\r', out, sizeof out);
  TEST_ASSERT_TRUE(ready);
  TEST_ASSERT_EQUAL_UINT(ELM_LINE_MAX - 1, strlen(out));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_frames_a_simple_cr_terminated_command);
  RUN_TEST(test_lowercase_input_is_uppercased);
  RUN_TEST(test_tolerates_lf_terminator);
  RUN_TEST(test_bare_crlf_pair_swallows_the_empty_second_line);
  RUN_TEST(test_survives_being_split_at_every_possible_byte_boundary);
  RUN_TEST(test_trims_surrounding_whitespace);
  RUN_TEST(test_overflow_truncates_but_still_terminates);
  return UNITY_END();
}
