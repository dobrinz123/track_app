#include "elm_line_parser.h"

#include <ctype.h>
#include <string.h>

void elm_line_framer_reset(ElmLineFramer *framer) { framer->len = 0; }

static void trim_and_upper(char *s, size_t *len) {
  size_t start = 0;
  while (start < *len && isspace((unsigned char)s[start])) start++;
  size_t end = *len;
  while (end > start && isspace((unsigned char)s[end - 1])) end--;

  size_t n = end - start;
  if (start > 0 && n > 0) memmove(s, s + start, n);
  for (size_t i = 0; i < n; i++) s[i] = (char)toupper((unsigned char)s[i]);
  s[n] = '\0';
  *len = n;
}

bool elm_line_framer_push(ElmLineFramer *framer, char c, char *line_out, size_t line_out_cap) {
  if (c == '\r' || c == '\n') {
    if (framer->len == 0 || line_out_cap == 0) {
      framer->len = 0;
      return false;
    }
    size_t n = framer->len;
    if (n >= line_out_cap) n = line_out_cap - 1;
    memcpy(line_out, framer->buf, n);
    line_out[n] = '\0';
    framer->len = 0;

    size_t out_len = n;
    trim_and_upper(line_out, &out_len);
    return out_len > 0;
  }

  if (framer->len < sizeof(framer->buf) - 1) {
    framer->buf[framer->len++] = c;
  }
  /* Overflow bytes are silently dropped; the framer keeps waiting for the
   * terminator so it can never desync the stream. */
  return false;
}
