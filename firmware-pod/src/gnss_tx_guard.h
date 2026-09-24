#ifndef TRACE_POD_GNSS_TX_GUARD_H
#define TRACE_POD_GNSS_TX_GUARD_H

/*
 * Wire-level OTP guard for the GNSS UART (framework-free).
 *
 * The frame-level bridge filter (bridge_filter.h) only judges frames it can
 * see. A blind verifier showed that the WIRE can still carry an OTP frame
 * start: an allowed, checksum-valid frame whose CK_B (or CK_A, or payload
 * tail) is 0xB5, followed by plain bytes `62 06 41 ...`. The receiver sees
 * the concatenation, not our frame boundaries.
 *
 * So EVERY byte sent to the GNSS UART goes through txg_filter(), which
 * remembers the last 3 bytes actually transmitted and refuses to emit any
 * byte that would complete `B5 62 06 41` (UBX sync + CFG class 0x06 + id
 * 0x41, the OTP write of SAM-M10Q IM UBX-22020019 §2.1.5 Table 3) on the
 * wire. The refused byte and the rest of that chunk (a chunk = one frame or
 * one plain run) are dropped and counted.
 *
 * The only path that may put `B5 62 06 41` on the wire is the confirmed
 * `gnss otp-highperf CONFIRM` procedure, through a raw writer that is
 * `static` in gnss.cpp and called only from gnss_otp_confirm(); it still
 * records what it sent here (txg_note_raw) so the history stays true.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint8_t last[3]; /* last 3 transmitted bytes, oldest first */
  uint8_t nlast;   /* how many of them are valid (0..3) */
  uint32_t refused_chunks;
  uint32_t refused_bytes;
} txg_t;

void txg_init(txg_t *g);

/* Returns how many bytes of in[0..n) may be transmitted: the longest prefix
 * that does not complete B5 62 06 41 on the wire. If it returns < n the
 * caller must drop the remaining bytes of that chunk. The history is
 * updated with the allowed prefix (the caller must transmit exactly it). */
size_t txg_allow(txg_t *g, const uint8_t *in, size_t n);

/* Record bytes transmitted outside the guard (confirmed OTP raw writer). */
void txg_note_raw(txg_t *g, const uint8_t *in, size_t n);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_GNSS_TX_GUARD_H */
