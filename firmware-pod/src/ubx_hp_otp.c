#include "ubx_hp_otp.h"

#include "ubx.h"

/* Byte strings copied verbatim from [IM] UBX-22020019 R02 §2.1.5 (see header).
 * The unit tests re-verify that every frame here has a valid UBX checksum, so
 * a transcription error cannot go unnoticed. */

const uint8_t HP_OTP_WRITE_SEQUENCE[60] = {
    /* frame 1: B5 62 06 41 10 00 | 03 00 04 1F 54 5E 79 BF 28 EF 12 05 FD FF FF FF | 8F 0D */
    0xB5, 0x62, 0x06, 0x41, 0x10, 0x00, 0x03, 0x00, 0x04, 0x1F, 0x54, 0x5E, 0x79, 0xBF, 0x28,
    0xEF, 0x12, 0x05, 0xFD, 0xFF, 0xFF, 0xFF, 0x8F, 0x0D,
    /* frame 2: B5 62 06 41 1C 00 | 04 01 A4 10 BD 34 F9 12 28 EF 12 05 05 00 A4 40
     *          00 B0 71 0B 0A 00 A4 40 00 D8 B8 05 | DE AE */
    0xB5, 0x62, 0x06, 0x41, 0x1C, 0x00, 0x04, 0x01, 0xA4, 0x10, 0xBD, 0x34, 0xF9, 0x12, 0x28,
    0xEF, 0x12, 0x05, 0x05, 0x00, 0xA4, 0x40, 0x00, 0xB0, 0x71, 0x0B, 0x0A, 0x00, 0xA4, 0x40,
    0x00, 0xD8, 0xB8, 0x05, 0xDE, 0xAE};

const uint8_t HP_OTP_EXPECTED_ACK[10] = {0xB5, 0x62, 0x05, 0x01, 0x02,
                                         0x00, 0x06, 0x41, 0x4F, 0x78};

const uint8_t HP_OTP_VERIFY_POLL[28] = {0xB5, 0x62, 0x06, 0x8B, 0x14, 0x00, 0x00, 0x04, 0x00, 0x00,
                                        0x01, 0x00, 0xA4, 0x40, 0x03, 0x00, 0xA4, 0x40, 0x05, 0x00,
                                        0xA4, 0x40, 0x0A, 0x00, 0xA4, 0x40, 0x4C, 0x15};

const uint8_t HP_OTP_VERIFY_EXPECTED_REPLY[44] = {
    0xB5, 0x62, 0x06, 0x8B, 0x24, 0x00, 0x01, 0x04, 0x00, 0x00, 0x01, 0x00, 0xA4, 0x40, 0x00,
    0xB0, 0x71, 0x0B, 0x03, 0x00, 0xA4, 0x40, 0x00, 0xB0, 0x71, 0x0B, 0x05, 0x00, 0xA4, 0x40,
    0x00, 0xB0, 0x71, 0x0B, 0x0A, 0x00, 0xA4, 0x40, 0x00, 0xD8, 0xB8, 0x05, 0x76, 0x81};

/* Poll layer and keys, taken from the IM poll bytes themselves so the
 * classifier is correlated with exactly what was sent. */
static bool poll_keys(uint8_t *layer, uint32_t keys[4]) {
  const uint8_t *pl = HP_OTP_VERIFY_POLL + UBX_HEADER_LEN;
  uint16_t len = ubx_u2(HP_OTP_VERIFY_POLL + 4);
  if (len != 4 + 4 * 4) return false;
  *layer = pl[1];
  for (int i = 0; i < 4; i++) keys[i] = ubx_u4(pl + 4 + 4 * i);
  return true;
}

hp_state_t hp_otp_classify_reply(const uint8_t *payload, uint16_t len) {
  uint8_t layer;
  uint32_t keys[4];
  uint64_t want[4], got[4];
  if (!poll_keys(&layer, keys)) return HP_STATE_UNKNOWN;
  /* expected values: the IM step-5 reply, parsed with the same strict rules */
  const uint8_t *exp = HP_OTP_VERIFY_EXPECTED_REPLY + UBX_HEADER_LEN;
  if (!ubx_valget_parse_strict(exp, ubx_u2(HP_OTP_VERIFY_EXPECTED_REPLY + 4), layer, keys, 4, want))
    return HP_STATE_UNKNOWN;
  if (!ubx_valget_parse_strict(payload, len, layer, keys, 4, got)) return HP_STATE_UNKNOWN;
  /* evaluate every key before deciding */
  int equal = 0;
  for (int i = 0; i < 4; i++)
    if (got[i] == want[i]) equal++;
  return equal == 4 ? HP_STATE_SET : HP_STATE_NOT_SET;
}

void hp_auth_arm(hp_auth_t *a, uint32_t now_ms) {
  a->armed = true;
  a->armed_ms = now_ms;
}

void hp_auth_clear(hp_auth_t *a) {
  a->armed = false;
  a->armed_ms = 0;
}

void hp_auth_tick(hp_auth_t *a, uint32_t now_ms) {
  if (a->armed && (uint32_t)(now_ms - a->armed_ms) >= HP_AUTH_WINDOW_MS) hp_auth_clear(a);
}

bool hp_auth_consume(hp_auth_t *a, uint32_t now_ms) {
  bool ok = a->armed && (uint32_t)(now_ms - a->armed_ms) < HP_AUTH_WINDOW_MS;
  hp_auth_clear(a);
  return ok;
}

const char *hp_state_name(hp_state_t s) {
  switch (s) {
    case HP_STATE_SET: return "SET (high CPU clock in OTP)";
    case HP_STATE_NOT_SET: return "NOT SET (default clock)";
    default: return "UNKNOWN";
  }
}
