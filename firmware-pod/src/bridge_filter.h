#ifndef TRACE_POD_BRIDGE_FILTER_H
#define TRACE_POD_BRIDGE_FILTER_H

/*
 * Host -> GNSS filter for `gnss bridge` (review fix HIGH 1; framework-free).
 *
 * The bridge must never become a path around the confirmed OTP procedure.
 * Rules, applied to the byte stream coming from the USB host:
 *
 *  1. A byte outside any UBX frame candidate is forwarded unchanged, EXCEPT
 *     0xB5 (UBX sync char 1), which only ever leaves the filter as the first
 *     byte of a complete, checksum-valid, allowed UBX frame. NMEA (ASCII)
 *     therefore passes untouched. Consequence: the receiver can only see a
 *     frame start where the filter has validated a whole frame, so dropping
 *     a frame can never splice surrounding bytes into a new one.
 *  2. A candidate (0xB5 0x62 cls id len...) is buffered until complete.
 *     Valid checksum + allowed -> forwarded as one unit.
 *     Valid checksum + blocked -> dropped entirely, blocked counter++.
 *     Bad sync / oversize length / bad checksum -> the leading 0xB5 is
 *     dropped and the rest is re-scanned under rule 1/2 (so a frame hidden
 *     inside a corrupt one is still examined).
 *  3. Blocked frames:
 *     - class 0x06 id 0x41: the only message the u-blox documents list as
 *       writing OTP (SAM-M10Q Integration manual UBX-22020019 R02 §2.1.5
 *       Table 3; it is not in the public interface description UBX-21035062).
 *     - class 0x06 id 0x8A (CFG-VALSET) whose layers byte has any bit other
 *       than RAM/BBR/Flash (bits 0..2, [IFD] 3.10.5): an undocumented layer
 *       could address OTP (the IM verification reads a layer 4).
 *     - any allowed-looking frame whose payload contains the byte sequence
 *       B5 62 06 41, in case the receiver's maximum frame length is shorter
 *       than ours and it re-scans inside the payload.
 *  4. Frames with a payload > UBX_MAX_PAYLOAD (1016 bytes) are dropped
 *     (includes firmware-update traffic: not supported over the bridge).
 * The GNSS -> host direction is not filtered.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ubx.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*bf_out_cb)(const uint8_t *data, size_t n, void *ctx);

typedef struct {
  uint8_t buf[UBX_MAX_PAYLOAD + UBX_OVERHEAD];
  size_t len;
  uint32_t frames_forwarded;
  uint32_t frames_blocked;
  uint32_t invalid_dropped; /* failed candidates (their 0xB5 dropped) */
  uint32_t stray_b5_dropped;
  uint32_t bytes_forwarded;
  uint8_t last_blocked_cls, last_blocked_id;
} bridge_filter_t;

void bf_init(bridge_filter_t *f);
void bf_push(bridge_filter_t *f, const uint8_t *data, size_t n, bf_out_cb out, void *ctx);
/* Policy only (exposed for tests): would this complete, valid frame be blocked? */
bool bf_frame_blocked(uint8_t cls, uint8_t id, const uint8_t *payload, uint16_t len);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_BRIDGE_FILTER_H */
