#ifndef TRACE_CAN_RESPONSE_MATCH_H
#define TRACE_CAN_RESPONSE_MATCH_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * hardware/DESIGN.md sec8 item12 (rev A3 NO-GO remediation): can_obd.cpp
 * previously accepted the FIRST frame from any 0x7E8-0x7EF ECU as the
 * answer to whatever request was just sent, with no check that the frame
 * was actually a positive response to THAT request. On a busy/multi-ECU
 * bus this can silently report an unrelated frame's data.
 *
 * `request` is the payload bytes as sent on the wire: request[0] is the
 * OBD/UDS service byte (0x01/0x21/0x22 -- read_only_guard.c's whitelist),
 * request[1..] is the PID (mode 01) or DID (UDS 0x21/0x22) being asked
 * for. `response` is a candidate reply's data bytes with the ISO-TP
 * length byte already stripped off: response[0] is the service byte the
 * ECU replied with, response[1..] is whatever it echoed back plus data.
 *
 * Returns true only when:
 *   1. response[0] is the correct positive-response service for
 *      request[0] (0x01->0x41, 0x21->0x61, 0x22->0x62 -- ISO 14229/15031
 *      convention: positive response = request service | 0x40); and
 *   2. every byte after the service byte in `request` (the PID/DID) is
 *      echoed back byte-for-byte at the start of `response`'s payload.
 *
 * A negative response (0x7F ...), a response to a different PID/DID, or
 * traffic from an unrelated request all fail one of these checks and are
 * rejected -- the caller must keep waiting for the real match or time
 * out.
 */
bool can_response_matches_request(const uint8_t *request, size_t request_len,
                                   const uint8_t *response, size_t response_len);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_CAN_RESPONSE_MATCH_H */
