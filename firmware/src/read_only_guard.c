#include "read_only_guard.h"

#include <stdio.h>

static GuardLogFn s_logger = NULL;

void guard_set_logger(GuardLogFn logger) { s_logger = logger; }

static void guard_log(const char *msg) {
  if (s_logger != NULL) s_logger(msg);
}

static bool is_whitelisted_service(uint8_t service) {
  return service == 0x01 || service == 0x21 || service == 0x22;
}

bool guard_can_transmit(const uint8_t *data, uint8_t dlc) {
  if (data == NULL || dlc < 2) {
    guard_log("guard: rejected malformed frame (dlc < 2)");
    return false;
  }

  uint8_t length_nibble = data[0] & 0x0F;
  if (length_nibble == 0 || length_nibble > (uint8_t)(dlc - 1)) {
    guard_log("guard: rejected frame with invalid ISO-TP length");
    return false;
  }

  uint8_t service = data[1];
  if (!is_whitelisted_service(service)) {
    char buf[56];
    snprintf(buf, sizeof buf, "guard: rejected non-whitelisted service 0x%02X", service);
    guard_log(buf);
    return false;
  }

  return true;
}
