#include "console_line.h"

#include <string.h>

void cl_init(console_line_t *cl) { memset(cl, 0, sizeof(*cl)); }

static void reset_line(console_line_t *cl) {
  cl->len = 0;
  cl->too_long = false;
  cl->bad_byte = false;
  cl->line[0] = 0;
}

cl_event_t cl_feed(console_line_t *cl, uint8_t b) {
  if (b == '\n' && cl->last_was_cr) { /* LF of CRLF */
    cl->last_was_cr = false;
    return CL_NONE;
  }
  cl->last_was_cr = (b == '\r');
  if (b == '\r' || b == '\n') {
    cl_event_t ev;
    if (cl->bad_byte) {
      ev = CL_REJECT_BYTE;
      cl->rejected++;
    } else if (cl->too_long) {
      ev = CL_REJECT_LONG;
      cl->rejected++;
    } else {
      cl->line[cl->len] = 0;
      ev = CL_LINE;
    }
    if (ev != CL_LINE) reset_line(cl);
    else cl->len = 0; /* line[] keeps the text for the caller until next feed */
    return ev;
  }
  if (cl->too_long || cl->bad_byte) return CL_NONE; /* discard to terminator */
  if (b == 0x08 || b == 0x7F) {
    if (cl->len) {
      cl->len--;
      cl->line[cl->len] = 0;
      return CL_ERASE;
    }
    return CL_NONE;
  }
  if ((b >= 0x20 && b <= 0x7E) || b == '\t') {
    if (cl->len >= CONSOLE_LINE_MAX) {
      cl->too_long = true;
      return CL_NONE;
    }
    cl->line[cl->len++] = (char)b;
    cl->line[cl->len] = 0;
    return CL_ECHO;
  }
  cl->bad_byte = true;
  return CL_NONE;
}
