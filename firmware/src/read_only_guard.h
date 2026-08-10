#ifndef TRACE_READ_ONLY_GUARD_H
#define TRACE_READ_ONLY_GUARD_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Logging hook: production wires this to Serial.println (can_obd.cpp);
 * native tests capture it to assert on rejection messages. NULL = no-op. */
typedef void (*GuardLogFn)(const char *message);
void guard_set_logger(GuardLogFn logger);

/*
 * THE chokepoint (EXPECTED OUTCOME 2d). This is the ONLY function in the
 * firmware that decides whether a CAN frame may be transmitted onto the
 * vehicle bus -- can_obd.cpp's single twai_transmit() call site is gated
 * exclusively behind this returning true. Nothing else in the firmware may
 * call twai_transmit() directly.
 *
 * `data`/`dlc` is the ISO-TP single-frame OBD payload as it will be placed
 * in the CAN frame: data[0] low nibble = payload length (1..7), data[1] =
 * service id (mode), data[2..] = PID/sub-function/DID bytes.
 *
 * Whitelisted: 0x01 (show current data -- mode-01 PID reads) and the two
 * read-only UDS services the app's custom-PID contract uses, 0x21 (read by
 * local identifier) and 0x22 (read data by identifier). Everything else is
 * rejected and logged -- explicitly including 0x04 (clear DTCs), 0x08
 * (request control of onboard system / actuation), 0x2F (IO control by
 * identifier), 0x3E (tester present), and any multi-frame or malformed
 * ISO-TP payload.
 */
bool guard_can_transmit(const uint8_t *data, uint8_t dlc);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_READ_ONLY_GUARD_H */
