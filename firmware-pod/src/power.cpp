#include "power.h"

#include <Arduino.h>

#include "console_io.h"
#include <esp_sleep.h>

#include "board_pins.h"
#include "pod_state.h"
#include "power_policy.h"

static uint32_t s_last_ms = 0;
static bool s_wifi_allowed = true;

static void chg_en_low() {
  /* Rev A: charging is never enabled. There is deliberately no code path in
   * this firmware that writes HIGH to PIN_CHG_EN. */
  static_assert(POWER_REV_A_CHARGING_ALLOWED == 0, "rev A must never enable charging");
  digitalWrite(PIN_CHG_EN, LOW);
}

void power_early_init() {
  digitalWrite(PIN_CHG_EN, LOW); /* output latch low before enabling the driver */
  pinMode(PIN_CHG_EN, OUTPUT);
  chg_en_low();
}

void power_init() {
  pinMode(PIN_PGOOD_N, INPUT); /* external R12 pull-up */
  /* ADC1_CH0, 11 dB attenuation = IDF ADC_ATTEN_DB_11 ("ATTEN3", 0-2900 mV
   * effective range per the S3 datasheet, DESIGN-REV-A §2). */
  analogSetPinAttenuation(PIN_VBAT_SENSE, ADC_11db);
  power_service();
}

void power_service() {
  uint32_t now = millis();
  if (s_last_ms != 0 && now - s_last_ms < 1000) return;
  s_last_ms = now;
  chg_en_low();
  g_pod.usb_power = digitalRead(PIN_PGOOD_N) == LOW;
  int adc_mv = (int)analogReadMilliVolts(PIN_VBAT_SENSE);
  g_pod.vbat_mv = power_vbat_from_adc_mv(adc_mv);
  /* §10.5 low-battery cutoff. POWER_HAS_CELL is 0 on rev A, so this never
   * sleeps and never blocks WiFi; the path exists for rev B. */
  power_decision_t d = power_policy_evaluate(POWER_HAS_CELL, g_pod.usb_power,
                                             POWER_HAS_CELL ? g_pod.vbat_mv : -1);
  s_wifi_allowed = d.wifi_allowed;
  if (d.deep_sleep_now) {
    con_println("[power] VBAT below cutoff on battery: deep sleep, radios off");
    Serial.flush(); /* bounded by CON_TX_TIMEOUT_MS; deep sleep follows */
    esp_deep_sleep_start(); /* no wake source: USB/switch cycle restarts */
  }
}

bool power_wifi_allowed() { return s_wifi_allowed; }
