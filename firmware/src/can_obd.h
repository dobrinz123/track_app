#ifndef TRACE_CAN_OBD_H
#define TRACE_CAN_OBD_H

#include "elm_server_core.h"

/* IO4/IO5 TWAI, IO6 = TCAN330DR S (silent) pin, package pin 5 -- the earlier
 * TJA1051T/3 was dropped in REV A3 because it needs 4.5-5.5 V and this board
 * has a single 3.3 V rail; see hardware/DESIGN.md section 8. Pins and CAN
 * topology are
 * binding per hardware/DESIGN.md section 1/3. Installs the TWAI driver at
 * 500 kbit/s and drives S LOW (normal mode) so the transceiver can actually
 * see the bus for OBD polling -- unless SNIFF_ONLY is defined at compile
 * time, in which case S is held HIGH and the driver is installed in
 * TWAI_MODE_LISTEN_ONLY, and can_obd_query() never transmits (future
 * passive-sniff firmware; DESIGN.md section 1 note). */
void can_obd_init();

/* ElmCanQueryFn implementation (elm_server_core.h). `ctx` is unused (NULL).
 * Sends a standard OBD functional-broadcast request (0x7DF) built from
 * `request_hex`, awaits a response on 0x7E8-0x7EF within 100 ms, and
 * formats it for the ELM server. Every transmit funnels through the single
 * read_only_guard.c chokepoint first. */
ElmCanResult can_obd_query(const char *request_hex, char *response_hex_out, size_t response_cap,
                            void *ctx);

/* True when the TWAI peripheral is BUS_OFF/recovering (status_led.cpp's
 * fast-blink "CAN error" indicator, EXPECTED OUTCOME 2e). */
bool can_obd_has_bus_error();

#endif /* TRACE_CAN_OBD_H */
