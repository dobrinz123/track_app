#include "can_response_match.h"

static uint8_t positive_response_service(uint8_t request_service) {
  switch (request_service) {
    case 0x01:
      return 0x41;
    case 0x21:
      return 0x61;
    case 0x22:
      return 0x62;
    default:
      return 0x00; /* not a read_only_guard-whitelisted service; no valid reply */
  }
}

bool can_response_matches_request(const uint8_t *request, size_t request_len,
                                   const uint8_t *response, size_t response_len) {
  if (request == NULL || response == NULL) return false;
  if (request_len < 1 || response_len < 1) return false;

  uint8_t want_service = positive_response_service(request[0]);
  if (want_service == 0x00 || response[0] != want_service) return false;

  size_t echo_len = request_len - 1;
  if (response_len < 1 + echo_len) return false;

  for (size_t i = 0; i < echo_len; i++) {
    if (response[1 + i] != request[1 + i]) return false;
  }
  return true;
}
