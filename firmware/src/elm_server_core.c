#include "elm_server_core.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include "pid_codec.h"

void elm_server_state_init(ElmServerState *state) { state->echo_enabled = true; }

static void append(char *out, size_t out_cap, size_t *pos, const char *s) {
  if (out_cap == 0 || *pos >= out_cap - 1) return;
  size_t avail = out_cap - *pos - 1;
  size_t n = strlen(s);
  if (n > avail) n = avail;
  memcpy(out + *pos, s, n);
  *pos += n;
  out[*pos] = '\0';
}

static bool is_hex_string(const char *s, size_t len) {
  if (len == 0 || (len % 2) != 0) return false;
  for (size_t i = 0; i < len; i++) {
    if (!isxdigit((unsigned char)s[i])) return false;
  }
  return true;
}

/* hardware/DESIGN.md sec8 item12 (rev A3 NO-GO fix): the app stores/sends
 * custom-PID requests with internal spaces verbatim (e.g. "22 1E 0C" --
 * packages/core/src/telemetry/pidCodec.ts's buildCustomPids keeps the raw
 * spacing; elm327Session.ts writes entry.command to the wire unmodified).
 * elm_line_parser.c only trims leading/trailing whitespace and upper-cases,
 * so internal spaces reach here. Strip them before hex validation / forward
 * to the CAN layer, which expects a contiguous hex-pair string. */
static size_t compact_whitespace(const char *in, char *out, size_t out_cap) {
  size_t n = 0;
  for (const char *p = in; *p != '\0' && n + 1 < out_cap; p++) {
    if (!isspace((unsigned char)*p)) out[n++] = *p;
  }
  out[n] = '\0';
  return n;
}

/* Handles a mode-01 ("01xx") or custom read (any other even-length hex)
 * request identically: ask the CAN layer, forward its response verbatim, or
 * "NO DATA" on failure. The read-only whitelist itself lives ONE layer
 * down, in read_only_guard.c's single chokepoint -- this dispatcher never
 * decides what may reach the bus, it only relays. */
static void handle_data_request(const char *command, ElmCanQueryFn can_query, void *can_ctx,
                                 char *out, size_t out_cap, size_t *pos) {
  char response_hex[64];
  ElmCanResult result =
      can_query != NULL ? can_query(command, response_hex, sizeof response_hex, can_ctx)
                         : ELM_CAN_NO_DATA;
  if (result == ELM_CAN_OK) {
    append(out, out_cap, pos, response_hex);
  } else {
    append(out, out_cap, pos, "NO DATA");
  }
}

size_t elm_server_handle_command(ElmServerState *state, const char *command,
                                  ElmCanQueryFn can_query, void *can_ctx, char *out,
                                  size_t out_cap) {
  size_t pos = 0;
  if (out_cap == 0) return 0;
  out[0] = '\0';

  if (state->echo_enabled) {
    append(out, out_cap, &pos, command);
    append(out, out_cap, &pos, "\r");
  }

  size_t cmd_len = strlen(command);

  /* Space-stripped view of `command`, used only for hex validation/dispatch
   * (see compact_whitespace() above) -- AT commands never contain hex
   * payload spacing and are matched against `command` directly below. */
  char compact[40];
  size_t compact_len = compact_whitespace(command, compact, sizeof compact);

  if (cmd_len >= 2 && command[0] == 'A' && command[1] == 'T') {
    if (strcmp(command, "ATZ") == 0) {
      elm_server_state_init(state); /* full reset, including echo back on */
      append(out, out_cap, &pos, "ELM327 v1.5 compatible TRACE");
    } else if (strcmp(command, "ATE0") == 0) {
      state->echo_enabled = false;
      append(out, out_cap, &pos, "OK");
    } else if (strcmp(command, "ATE1") == 0) {
      state->echo_enabled = true;
      append(out, out_cap, &pos, "OK");
    } else {
      /* ATL0/ATS0/ATSP0/any other AT command: unconditional OK -- this is a
       * deliberately minimal rev-A subset (CONSTRAINTS), not a full ELM327
       * clone. */
      append(out, out_cap, &pos, "OK");
    }
  } else if (compact_len == 4 && compact[0] == '0' && compact[1] == '1' &&
             is_hex_string(compact, compact_len)) {
    uint8_t pid = (uint8_t)strtoul(&compact[2], NULL, 16);
    if (pid_codec_mode01_byte_count(pid) > 0) {
      handle_data_request(compact, can_query, can_ctx, out, out_cap, &pos);
    } else {
      /* Well-formed mode-01 request, but not one of the seven PIDs this
       * dongle serves (EXPECTED OUTCOME 2b list). */
      append(out, out_cap, &pos, "NO DATA");
    }
  } else if (compact_len >= 2 && is_hex_string(compact, compact_len)) {
    /* Custom raw hex request (e.g. "221E1C" or spaced "22 1E 1C") --
     * forwarded to the CAN layer as the compacted hex string; the raw
     * response is echoed back untouched so the app's last-byte-minus-40
     * decode contract (elm327Session.ts's decodeCustomResponse) sees
     * exactly what the ECU returned. */
    handle_data_request(compact, can_query, can_ctx, out, out_cap, &pos);
  } else {
    append(out, out_cap, &pos, "NO DATA");
  }

  append(out, out_cap, &pos, "\r>");
  return pos;
}
