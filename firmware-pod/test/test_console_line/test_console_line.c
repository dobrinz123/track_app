/* Console line assembler tests (review fix MEDIUM 8). */
#include <string.h>
#include <unity.h>

#include "console_line.h"

void setUp(void) {}
void tearDown(void) {}

/* Feed a string; return the last non-NONE/ECHO/ERASE event and count lines. */
static cl_event_t feed(console_line_t *cl, const char *s, size_t n, int *lines, char *last) {
  cl_event_t last_ev = CL_NONE;
  for (size_t i = 0; i < n; i++) {
    cl_event_t e = cl_feed(cl, (uint8_t)s[i]);
    if (e == CL_LINE) {
      (*lines)++;
      strcpy(last, cl->line);
    }
    if (e == CL_LINE || e == CL_REJECT_LONG || e == CL_REJECT_BYTE) last_ev = e;
  }
  return last_ev;
}

void test_normal_line_crlf(void) {
  console_line_t cl;
  cl_init(&cl);
  int lines = 0;
  char last[200] = "";
  const char *s = "status\r\n";
  TEST_ASSERT_EQUAL_INT(CL_LINE, feed(&cl, s, strlen(s), &lines, last));
  TEST_ASSERT_EQUAL_INT(1, lines); /* LF of CRLF swallowed */
  TEST_ASSERT_EQUAL_STRING("status", last);
}

void test_overlong_confirm_is_rejected_whole(void) {
  console_line_t cl;
  cl_init(&cl);
  int lines = 0;
  char last[200] = "";
  char buf[300];
  strcpy(buf, "gnss otp-highperf CONFIRM");
  memset(buf + strlen(buf), ' ', 102);
  buf[25 + 102] = 0;
  strcat(buf, "CANCEL\n");
  TEST_ASSERT_EQUAL_INT(CL_REJECT_LONG, feed(&cl, buf, strlen(buf), &lines, last));
  TEST_ASSERT_EQUAL_INT(0, lines);
  /* the assembler recovers for the next line */
  const char *s = "pps\n";
  TEST_ASSERT_EQUAL_INT(CL_LINE, feed(&cl, s, strlen(s), &lines, last));
  TEST_ASSERT_EQUAL_STRING("pps", last);
}

void test_control_byte_rejects_line(void) {
  console_line_t cl;
  cl_init(&cl);
  int lines = 0;
  char last[200] = "";
  const char s[] = "gnss otp-highperf CON\x1b[AFIRM\n";
  TEST_ASSERT_EQUAL_INT(CL_REJECT_BYTE, feed(&cl, s, sizeof s - 1, &lines, last));
  TEST_ASSERT_EQUAL_INT(0, lines);
  const char h[] = "gnss otp-highperf CONFIRM\xC3\xA9\n"; /* non-ASCII */
  TEST_ASSERT_EQUAL_INT(CL_REJECT_BYTE, feed(&cl, h, sizeof h - 1, &lines, last));
  TEST_ASSERT_EQUAL_INT(0, lines);
}

void test_backspace_edits_visibly(void) {
  console_line_t cl;
  cl_init(&cl);
  int lines = 0;
  char last[200] = "";
  const char s[] = "resex\b\bet\n";
  feed(&cl, s, sizeof s - 1, &lines, last);
  TEST_ASSERT_EQUAL_STRING("reset", last);
}

void test_exact_max_length_accepted(void) {
  console_line_t cl;
  cl_init(&cl);
  int lines = 0;
  char last[200] = "";
  char buf[CONSOLE_LINE_MAX + 2];
  memset(buf, 'a', CONSOLE_LINE_MAX);
  buf[CONSOLE_LINE_MAX] = '\n';
  TEST_ASSERT_EQUAL_INT(CL_LINE, feed(&cl, buf, CONSOLE_LINE_MAX + 1, &lines, last));
  TEST_ASSERT_EQUAL_UINT(CONSOLE_LINE_MAX, strlen(last));
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_normal_line_crlf);
  RUN_TEST(test_overlong_confirm_is_rejected_whole);
  RUN_TEST(test_control_byte_rejects_line);
  RUN_TEST(test_backspace_edits_visibly);
  RUN_TEST(test_exact_max_length_accepted);
  return UNITY_END();
}
