#include "power_policy.h"

power_decision_t power_policy_evaluate(bool has_cell, bool usb_present, int vbat_mv) {
  power_decision_t d = {false, true};
  /* No cell (rev A) or USB present: the cutoff never applies. */
  if (!has_cell || usb_present) return d;
  /* On battery with an unknown VBAT: be conservative with WiFi, do not sleep. */
  if (vbat_mv < 0) {
    d.wifi_allowed = false;
    return d;
  }
  if (vbat_mv < POWER_VBAT_CUTOFF_MV) {
    d.deep_sleep_now = true;
    d.wifi_allowed = false;
    return d;
  }
  if (vbat_mv < POWER_VBAT_NO_WIFI_MV) d.wifi_allowed = false;
  return d;
}

int power_vbat_from_adc_mv(int adc_mv) {
  return adc_mv * POWER_VBAT_DIVIDER_NUM / POWER_VBAT_DIVIDER_DEN;
}
