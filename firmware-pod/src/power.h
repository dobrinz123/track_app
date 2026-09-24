#ifndef TRACE_POD_POWER_H
#define TRACE_POD_POWER_H

/* Charger / supply handling (ESP32 side of power_policy.c).
 * power_early_init() MUST be the first thing setup() does: it drives
 * GPIO37 (CHG_EN) LOW (DESIGN-REV-A §6, binding for rev A). */

void power_early_init();
void power_init();
/* 1 Hz: re-assert CHG_EN low, read PGOOD_N and VBAT, apply the (inert on
 * rev A) low-battery policy. */
void power_service();
bool power_wifi_allowed();

#endif
