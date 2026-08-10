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
  } else if (cmd_len == 4 && command[0] == '0' && command[1] == '1' &&
             is_hex_string(command, cmd_len)) {
    uint8_t pid = (uint8_t)strtoul(&command[2], NULL, 16);
    if (pid_codec_mode01_byte_count(pid) > 0) {
      handle_data_request(command, can_query, can_ctx, out, out_cap, &pos);
    } else {
      /* Well-formed mode-01 request, but not one of the seven PIDs this
       * dongle serves (EXPECTED OUTCOME 2b list). */
      append(out, out_cap, &pos, "NO DATA");
    }
  } else if (cmd_len >= 2 && is_hex_string(command, cmd_len)) {
    /* Custom raw hex request (e.g. "221E1C") -- forwarded to the CAN layer;
     * the raw response is echoed back untouched so the app's
     * last-byte-minus-40 decode contract (elm327Session.ts's
     * decodeCustomResponse) sees exactly what the ECU returned. */
    handle_data_request(command, can_query, can_ctx, out, out_cap, &pos);
  } else {
    append(out, out_cap, &pos, "NO DATA");
  }

  append(out, out_cap, &pos, "\r>");
  return pos;
}
