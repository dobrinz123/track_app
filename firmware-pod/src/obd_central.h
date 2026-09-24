#ifndef TRACE_POD_OBD_CENTRAL_H
#define TRACE_POD_OBD_CENTRAL_H

/*
 * PHASE 2 MODULE BOUNDARY -- NOT IMPLEMENTED IN THIS FIRMWARE.
 *
 * BLE central towards a BLE ELM327 OBD adapter (iKiKin V03H4 and similar;
 * hardware/gnss-pod/DESIGN.md §3 "the pod is the hub", §6). Nothing includes
 * this header yet; it fixes the interface the rest of the firmware will use
 * so the phase-2 work only adds obd_central.cpp + a protocol frame type.
 *
 * Planned contract:
 *  - obd_central_init(): enable the NimBLE central role (today disabled in
 *    platformio.ini via CONFIG_BT_NIMBLE_ROLE_CENTRAL_DISABLED and
 *    CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1 -> needs 2), scan for the adapter's
 *    UART-like service (FFE0/FFE1 on many clones: VERIFY on the actual unit,
 *    DESIGN.md §6), connect, run the ELM327 init.
 *  - obd_central_service(): non-blocking request/response state machine
 *    (ELM327 ASCII, reuse the framing ideas of firmware/src/elm_line_parser.c).
 *  - Every OBD sample carries two pod timestamps (request sent, response
 *    received, esp_timer us) so the app can place it at mid-flight on the
 *    same clock as GNSS and IMU (DESIGN.md §3 "Time base"). Optionally pulse
 *    GNSS EXTINT (GPIO41) at request time for a receiver-side time mark.
 *  - New pod_protocol.c frame type (e.g. 0x05 OBD) appended under the
 *    PROTOCOL.md versioning rules; no change to existing frames.
 *  - Read-only: only mode-01 / UDS 0x22 reads, mirroring the dongle's
 *    firmware/src/read_only_guard.c policy.
 */

#include <stdbool.h>
#include <stdint.h>

typedef struct {
  uint8_t pid;
  uint8_t len;
  uint8_t data[8];
  int64_t t_request_pod_us;
  int64_t t_response_pod_us;
} obd_sample_t;

bool obd_central_init(void);    /* phase 2 */
void obd_central_service(void); /* phase 2 */

#endif /* TRACE_POD_OBD_CENTRAL_H */
