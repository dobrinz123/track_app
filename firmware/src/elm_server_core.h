#ifndef TRACE_ELM_SERVER_CORE_H
#define TRACE_ELM_SERVER_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum { ELM_CAN_OK, ELM_CAN_NO_DATA } ElmCanResult;

/*
 * Queries the CAN layer for one already-framed request line (e.g. "010C" or
 * "221E1C"). On ELM_CAN_OK, `response_hex_out` must hold a NUL-terminated,
 * space-separated upper-case hex string (e.g. "41 0C 1A F8" or
 * "62 1E 1C 87") ready to send back to the client verbatim. can_obd.cpp
 * (ESP32-only) is the real implementation; native tests inject a stub.
 */
typedef ElmCanResult (*ElmCanQueryFn)(const char *request_hex, char *response_hex_out,
                                       size_t response_cap, void *ctx);

typedef struct {
  bool echo_enabled;
} ElmServerState;

/* Real ELM327 power-on default: echo ON until the client sends ATE0. */
void elm_server_state_init(ElmServerState *state);

/*
 * Pure dispatch (EXPECTED OUTCOME 2b): given one already-framed, trimmed,
 * upper-case command line (elm_line_parser.c's job), produces the exact
 * bytes TRACE-OBD writes back to the TCP client -- including the command
 * echo (if enabled) and the terminating '>' prompt every response ends
 * with, per the app's Elm327ResponseFramer contract.
 *
 * Returns the number of bytes written to `out` (excluding the NUL),
 * truncated to `out_cap - 1` if the buffer is too small.
 */
size_t elm_server_handle_command(ElmServerState *state, const char *command,
                                  ElmCanQueryFn can_query, void *can_ctx, char *out,
                                  size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_ELM_SERVER_CORE_H */
