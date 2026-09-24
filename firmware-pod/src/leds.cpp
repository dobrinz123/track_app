#include "leds.h"

#include <Arduino.h>
#include <esp_timer.h>

#include "ble_link.h"
#include "board_pins.h"
#include "pod_state.h"
#include "wifi_test.h"

void leds_init() {
  digitalWrite(PIN_LED_YELLOW, LOW);
  digitalWrite(PIN_LED_RED, LOW);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  /* GPIO0 is a strapping pin: only ever an input, and only configured after
   * the ROM has sampled it. R6 is the pull-up; no internal pull needed. */
  pinMode(PIN_BOOT_BUTTON, INPUT);
}

static bool blink(uint32_t now, uint32_t period_ms) { return (now % period_ms) < period_ms / 2; }

void leds_service() {
  uint32_t now = millis();
  int64_t now_us = esp_timer_get_time();
  const GnssState &g = g_pod.gnss;

  bool y;
  bool alive = g.last_frame_us != 0 && now_us - g.last_frame_us < 2000000;
  if (!alive)
    y = false;
  else if (tb_state(&g_pod.tb, now_us) == TB_STATE_LOCKED)
    y = true;
  else if (g.have_pvt && g.pvt.fix_type >= 3 && (g.pvt.flags & UBX_PVT_FLAGS_GNSS_FIX_OK))
    y = blink(now, 250);
  else
    y = blink(now, 1000);

  bool r;
  if (g.init_failed || !g_pod.imu_ok)
    r = blink(now, 125);
  else if (wifi_test_active())
    r = blink(now, 500);
  else if (ble_link_connected())
    r = true;
  else
    r = (now % 2000) < 60;

  digitalWrite(PIN_LED_YELLOW, y ? HIGH : LOW);
  digitalWrite(PIN_LED_RED, r ? HIGH : LOW);
}

bool boot_button_pressed() {
  static bool last = false;
  static uint32_t since = 0;
  bool down = digitalRead(PIN_BOOT_BUTTON) == LOW;
  uint32_t now = millis();
  if (down != last) {
    last = down;
    since = now;
    return false;
  }
  static bool reported = false;
  if (down && !reported && now - since > 40) {
    reported = true;
    return true;
  }
  if (!down) reported = false;
  return false;
}
