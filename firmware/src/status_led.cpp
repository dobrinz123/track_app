#include "status_led.h"

#include <Arduino.h>

namespace {

constexpr int kLedGpio = 7; // hardware/DESIGN.md sec8 item7 (rev A3): LED2 moved off
                            // strapping pin IO8 -> IO7 (non-strapping)
constexpr uint32_t kSlowBlinkMs = 500;
constexpr uint32_t kFastBlinkMs = 100;

LedState g_state = LedState::kApNoClient;
uint32_t g_last_toggle_ms = 0;
bool g_led_on = false;

} // namespace

void status_led_init() {
  pinMode(kLedGpio, OUTPUT);
  digitalWrite(kLedGpio, LOW);
}

void status_led_set_state(LedState state) { g_state = state; }

void status_led_update() {
  if (g_state == LedState::kClientConnected) {
    if (!g_led_on) {
      g_led_on = true;
      digitalWrite(kLedGpio, HIGH);
    }
    return;
  }

  uint32_t period = g_state == LedState::kCanError ? kFastBlinkMs : kSlowBlinkMs;
  uint32_t now = millis();
  if (now - g_last_toggle_ms >= period) {
    g_last_toggle_ms = now;
    g_led_on = !g_led_on;
    digitalWrite(kLedGpio, g_led_on ? HIGH : LOW);
  }
}
