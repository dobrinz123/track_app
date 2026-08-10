#ifndef TRACE_ELM_LINE_PARSER_H
#define TRACE_ELM_LINE_PARSER_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Longest command this rev-A subset accepts (custom hex requests are short;
 * this is generous headroom, not a protocol limit). */
#define ELM_LINE_MAX 32

/*
 * Incremental command-line framer for the TCP byte stream the app writes.
 * The app always sends `${command}\r` (elm327Session.ts's executeCommand),
 * but this framer tolerates bare \n and \r\n too, and -- per the transport
 * contract ("raw chunks, may split/merge arbitrarily", docs/architecture/
 * contracts.md) -- works one byte at a time so it never assumes a command
 * arrives whole in one TCP read.
 */
typedef struct {
  char buf[ELM_LINE_MAX];
  size_t len;
} ElmLineFramer;

void elm_line_framer_reset(ElmLineFramer *framer);

/*
 * Feed one incoming byte. Returns true when `line_out` now holds a complete,
 * trimmed, upper-cased command (the terminator is consumed, never included).
 * A bare terminator on an empty buffer (e.g. the second byte of "\r\n", or a
 * stray blank line) is swallowed and returns false rather than emitting an
 * empty command.
 */
bool elm_line_framer_push(ElmLineFramer *framer, char c, char *line_out, size_t line_out_cap);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_ELM_LINE_PARSER_H */
