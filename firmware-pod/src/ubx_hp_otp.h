#ifndef TRACE_POD_UBX_HP_OTP_H
#define TRACE_POD_UBX_HP_OTP_H

/*
 * SAM-M10Q "high performance navigation update rate" one-time-programmable
 * (OTP) configuration.  *** IRREVERSIBLE ***
 *
 * Source (quoted byte for byte, nothing derived or recomputed):
 *   [IM] u-blox SAM-M10Q Integration manual UBX-22020019 R02 (01-Jun-2023),
 *        section 2.1.5 "High performance navigation update rate
 *        configuration", Table 3 (page 12) and the 6-step procedure that
 *        follows it (pages 12-13).
 *        https://content.u-blox.com/sites/default/files/documents/SAM-M10Q_IntegrationManual_UBX-22020019.pdf
 *   [IM] quote: "Changes made in the OTP configuration are permanent and
 *        cannot be reverted." "This occupies 18 bytes of OTP memory space."
 *   [IM] 2.3: total OTP use "must not exceed 69 bytes".
 *
 * NOTE: message 0x06 0x41, the 0x40A4xxxx key IDs and VALGET layer 4 used
 * below are NOT documented in the public interface description
 * UBX-21035062 R03 (searched: no match). They are used here exactly as the
 * integration manual prints them, and only through the explicit, confirmed
 * console command (never automatically, never over BLE).
 *
 * The firmware only ever sends HP_OTP_WRITE_SEQUENCE after the operator
 * typed `gnss otp-highperf` (preflight) and then `gnss otp-highperf CONFIRM`,
 * and only when the verification poll does NOT already report the
 * high-clock values (so OTP space is never spent twice).
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* [IM] Table 3, "High CPU clock" configuration string: two UBX frames,
 * class 0x06 id 0x41, 16 + 28 byte payloads, 60 bytes in total. */
extern const uint8_t HP_OTP_WRITE_SEQUENCE[60];

/* [IM] step 3: "The device returns two UBX-ACK-ACK messages with sequence of
 * bytes B5 62 05 01 02 00 06 41 4F 78." */
extern const uint8_t HP_OTP_EXPECTED_ACK[10];
#define HP_OTP_EXPECTED_ACK_COUNT 2

/* [IM] step 5, first bullet: verification poll (UBX-CFG-VALGET). */
extern const uint8_t HP_OTP_VERIFY_POLL[28];

/* [IM] step 5, second bullet: expected UBX-CFG-VALGET reply. */
extern const uint8_t HP_OTP_VERIFY_EXPECTED_REPLY[44];

typedef enum {
  HP_STATE_UNKNOWN = 0, /* no reply / NAK: cannot tell */
  HP_STATE_NOT_SET = 1, /* reply received, values differ from Table 3 */
  HP_STATE_SET = 2      /* reply carries the high-clock values of step 5 */
} hp_state_t;

/*
 * Classify a UBX-CFG-VALGET reply payload (class 0x06 id 0x8B) to the
 * verification poll. The reply must be COMPLETE and structurally valid and
 * correlate with HP_OTP_VERIFY_POLL (ubx_valget_parse_strict: version 1,
 * the polled layer 4, position 0, each of the 4 polled keys exactly once,
 * nothing else, no trailing bytes). Only then, after evaluating ALL keys:
 *   every value EQUAL to the step-5 expected reply   -> HP_STATE_SET
 *   every value DIFFERENT from the expected reply    -> HP_STATE_NOT_SET
 *   any mix of equal and different values            -> HP_STATE_UNKNOWN
 * Anything malformed, truncated, oversized or uncorrelated -> UNKNOWN
 * (and the firmware never writes OTP from UNKNOWN).
 */
hp_state_t hp_otp_classify_reply(const uint8_t *payload, uint16_t len);

/* One-shot, wrap-safe authorisation for `gnss otp-highperf CONFIRM`:
 * armed by a successful preflight, valid HP_AUTH_WINDOW_MS, consumed by the
 * first CONFIRM attempt, cleared on expiry (hp_auth_tick, called every main
 * loop), on GNSS reset/re-init and on bridge entry. */
#define HP_AUTH_WINDOW_MS 60000u
typedef struct {
  bool armed;
  uint32_t armed_ms;
} hp_auth_t;
void hp_auth_arm(hp_auth_t *a, uint32_t now_ms);
void hp_auth_clear(hp_auth_t *a);
/* Clears the authorisation once the window has elapsed. */
void hp_auth_tick(hp_auth_t *a, uint32_t now_ms);
/* True if armed and inside the window; ALWAYS disarms. */
bool hp_auth_consume(hp_auth_t *a, uint32_t now_ms);

const char *hp_state_name(hp_state_t s);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_UBX_HP_OTP_H */
