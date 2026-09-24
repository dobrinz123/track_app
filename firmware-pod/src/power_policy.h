#ifndef TRACE_POD_POWER_POLICY_H
#define TRACE_POD_POWER_POLICY_H

/*
 * Power policy (framework-free), DESIGN-REV-A §6 and §10.5 / §7.
 *
 * Charging (§6, binding, review rev3): on rev A the MCU keeps GPIO37
 * (CHG_EN) LOW AT ALL TIMES. There is intentionally no function here that
 * could return "enable charging": POWER_REV_A_CHARGING_ALLOWED is a
 * compile-time 0 and power.cpp drives the pin low unconditionally.
 *
 * Low-battery cutoff (§10.5, battery operation only): with PGOOD_N high (no
 * USB input) enter deep sleep, radios off, below VBAT 3.5 V under load; do
 * not start WiFi below 3.6 V. While PGOOD_N is low (USB present) it never
 * applies. On rev A (USB-only, no cell, J2 not fitted) it is NEVER applied:
 * the code path exists, POWER_HAS_CELL = 0 makes it inert. Thresholds are
 * §10.5's estimates; §10A test 2 decides them.
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define POWER_REV_A_CHARGING_ALLOWED 0
#ifndef POWER_HAS_CELL
#define POWER_HAS_CELL 0 /* rev A: no cell. Rev B sets 1 after §10A test 2 */
#endif

#define POWER_VBAT_CUTOFF_MV 3500
#define POWER_VBAT_NO_WIFI_MV 3600

/* VBAT divider R13/R14 = 1 MΩ / 1 MΩ (§2 "Battery divider"): VBAT = 2 * Vadc. */
#define POWER_VBAT_DIVIDER_NUM 2
#define POWER_VBAT_DIVIDER_DEN 1

typedef struct {
  bool deep_sleep_now; /* enter deep sleep, radios off */
  bool wifi_allowed;
} power_decision_t;

/* usb_present = PGOOD_N reads LOW. vbat_mv < 0 = unknown/not measured. */
power_decision_t power_policy_evaluate(bool has_cell, bool usb_present, int vbat_mv);

/* ADC pin millivolts -> VBAT millivolts through the 1:1 divider. */
int power_vbat_from_adc_mv(int adc_mv);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_POWER_POLICY_H */
