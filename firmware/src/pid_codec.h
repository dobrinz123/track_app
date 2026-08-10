#ifndef TRACE_PID_CODEC_H
#define TRACE_PID_CODEC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Server-side mirror of packages/core/src/telemetry/pidCodec.ts's
 * PID_BY_CHANNEL table. The app is the client of exactly this data; the
 * firmware only needs pid -> byte-count (to know how many CAN response
 * bytes to wait for) and a formatter that produces the same ASCII the app's
 * decodeMode01Response() parses.
 */

/* Returns the number of data bytes a mode-01 response for this PID carries,
 * or 0 if `pid` is not one of the standard channels this dongle serves. */
int pid_codec_mode01_byte_count(uint8_t pid);

/*
 * Formats "41 <PID> <data...>" -- space-separated, upper-case hex -- exactly
 * as pidCodec.ts's decodeMode01Response() expects to parse it (it also
 * tolerates compact/no-space hex, but the firmware always emits the spaced
 * form for readability over the wire, per the real ELM327's default ATS1
 * behavior).
 *
 * Returns the formatted length (excluding the NUL), or 0 if `pid` is
 * unknown, `data_len` doesn't match the PID's expected byte count, or
 * `out_cap` is too small.
 */
size_t pid_codec_format_mode01_response(uint8_t pid, const uint8_t *data, size_t data_len,
                                         char *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_PID_CODEC_H */
