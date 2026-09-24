#ifndef TRACE_POD_BLE_LINK_H
#define TRACE_POD_BLE_LINK_H

#include <stdint.h>

#include "pod_protocol.h"

/*
 * BLE peripheral (NimBLE) towards the phone. PROTOCOL.md is the contract.
 *
 * GATT service  be030001-cb14-41a4-a6af-b14223e0a8cf  "TRACE Pod"
 *   DATA     be030002-...  NOTIFY  one pod frame per notification
 *   CONTROL  be030003-...  WRITE / WRITE_NR  one CONTROL frame per write
 *   INFO     be030004-...  READ    a STATUS frame snapshot
 */

#define POD_BLE_SVC_UUID "be030001-cb14-41a4-a6af-b14223e0a8cf"
#define POD_BLE_DATA_UUID "be030002-cb14-41a4-a6af-b14223e0a8cf"
#define POD_BLE_CONTROL_UUID "be030003-cb14-41a4-a6af-b14223e0a8cf"
#define POD_BLE_INFO_UUID "be030004-cb14-41a4-a6af-b14223e0a8cf"

void ble_link_init();
/* Process queued CONTROL writes, 1 Hz STATUS. Call from the main loop. */
void ble_link_service();

bool ble_link_connected();
uint16_t ble_link_mtu();

/* Stream senders: no-ops unless connected, subscribed and the stream is on. */
void ble_link_send_gnss(const pod_gnss_t *g);
void ble_link_send_imu(const pod_imu_batch_t *b);
void ble_link_send_status_now();

void ble_link_print_info();
uint32_t ble_link_tx_drops();

/* Fill a STATUS struct from the current state (also used by the console). */
void ble_link_fill_status(pod_status_t *s);

#endif
