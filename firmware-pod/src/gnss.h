#ifndef TRACE_POD_GNSS_H
#define TRACE_POD_GNSS_H

#include <stdint.h>

#include "ubx.h"
#include "ubx_hp_otp.h"

/* SAM-M10Q on UART1 (GPIO38 TX / GPIO39 RX). All protocol bytes come from
 * the framework-free modules (ubx.c, gnss_config.c, ubx_hp_otp.c). */

bool gnss_init();    /* autobaud, RAM-layer config, HP-OTP state poll */
void gnss_service(); /* read UART, parse, dispatch; bridge mode */
void gnss_tick();    /* housekeeping every loop pass (OTP authorisation expiry) */

/* Returns a POD_RES_* code (pod_protocol.h). */
uint8_t gnss_set_rate(int hz);

void gnss_set_raw_monitor(bool on);
void gnss_print_sat();
void gnss_print_status();

/* RESET_N (GPIO40) open-drain low 10 ms, then gnss_init(). Clears BBR. */
void gnss_hw_reset();

/* High-performance OTP (IRREVERSIBLE, console only). */
hp_state_t gnss_poll_hp_state();
void gnss_otp_status();
void gnss_otp_preflight();
void gnss_otp_confirm();

/* Transparent USB <-> GNSS UART bridge for u-center. */
void gnss_bridge_start();
bool gnss_bridge_active();
void gnss_bridge_stop(); /* also re-initialises the receiver */

/* checksum + sync + oversize errors of the UBX parser */
uint32_t gnss_ubx_errors();

typedef void (*gnss_sat_listener_t)(const ubx_nav_sat_t *sat);
void gnss_set_sat_listener(gnss_sat_listener_t fn);
typedef void (*gnss_pvt_listener_t)(const ubx_nav_pvt_t *pvt);
void gnss_set_pvt_listener(gnss_pvt_listener_t fn);

#endif
