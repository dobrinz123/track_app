#ifndef TRACE_POD_CONSOLE_LINE_H
#define TRACE_POD_CONSOLE_LINE_H

/*
 * Console line assembler (review fix MEDIUM 8; framework-free).
 *
 * A line is either executed EXACTLY as typed or rejected ENTIRELY:
 *  - accepted bytes: printable ASCII 0x20..0x7E and TAB;
 *  - BS (0x08) / DEL (0x7F) edit the line (visible editing, not stripping);
 *  - CR or LF terminates; the LF of a CRLF pair is swallowed;
 *  - more than CONSOLE_LINE_MAX characters, or any other byte (control
 *    characters, ESC sequences, bytes >= 0x80), marks the line bad: every
 *    further byte up to the terminator is discarded and the line is reported
 *    as rejected, never executed in truncated or filtered form. This is what
 *    keeps `gnss otp-highperf CONFIRM<102 spaces>CANCEL` from executing.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CONSOLE_LINE_MAX 120

typedef enum {
  CL_NONE = 0,     /* byte consumed, nothing to do */
  CL_ECHO,         /* echo the byte (printable, accepted) */
  CL_ERASE,        /* echo "\b \b" */
  CL_LINE,         /* complete accepted line in cl->line (NUL-terminated) */
  CL_REJECT_LONG,  /* line rejected: too long */
  CL_REJECT_BYTE   /* line rejected: disallowed byte */
} cl_event_t;

typedef struct {
  char line[CONSOLE_LINE_MAX + 1];
  size_t len;
  bool too_long;
  bool bad_byte;
  bool last_was_cr;
  uint32_t rejected;
} console_line_t;

void cl_init(console_line_t *cl);
cl_event_t cl_feed(console_line_t *cl, uint8_t byte);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_CONSOLE_LINE_H */
