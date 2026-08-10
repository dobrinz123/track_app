#include <Arduino.h>
#include <WiFiClient.h>

#include "can_obd.h"
#include "elm_server.h"
#include "status_led.h"
#include "wifi_ap.h"

namespace {
WiFiClient g_client; // single client only (EXPECTED OUTCOME 2a)
}

void setup() {
  Serial.begin(115200);
  status_led_init();
  status_led_set_state(LedState::kApNoClient);
  wifi_ap_begin();
  can_obd_init();
}

void loop() {
  WiFiServer &server = wifi_ap_tcp_server();

  // Accept-or-reject check runs every iteration, independent of whether a
  // client is already being served, so a second connection attempt while
  // one is active is always seen and refused (EXPECTED OUTCOME 2a: single
  // client).
  WiFiClient incoming = server.available();
  if (incoming) {
    if (g_client && g_client.connected()) {
      incoming.stop(); // single-client policy: refuse a second connection outright
    } else {
      g_client = incoming;
      elm_server_reset();
    }
  }

  if (g_client && g_client.connected()) {
    status_led_set_state(LedState::kClientConnected);
    elm_server_service(g_client);
  } else {
    status_led_set_state(LedState::kApNoClient);
  }

  // CAN bus error overrides the AP/client indication -- a bench-relevant
  // fault takes priority over "everything looks fine at the WiFi layer".
  if (can_obd_has_bus_error()) {
    status_led_set_state(LedState::kCanError);
  }

  status_led_update();
}
