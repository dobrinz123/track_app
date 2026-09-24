#include "wifi_test.h"

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "cn0_stats.h"
#include "gnss.h"
#include "pod_state.h"
#include "power.h"

/* esp_wifi_set_max_tx_power() takes units of 0.25 dBm (ESP-IDF esp_wifi.h). */
static constexpr int8_t kTxPowerCapQdBm = 52; /* 13 dBm: DESIGN-REV-A §10.3 WiFi cap */
static constexpr int8_t kTxPowerMaxQdBm = 80; /* 20 dBm */
static constexpr uint8_t kChannel = 6;

enum Phase { IDLE, OFF_PHASE, ON_PHASE };
static Phase s_phase = IDLE;
static uint32_t s_phase_end_ms = 0;
static uint32_t s_seconds = 0;
static bool s_max = false;
static cn0_phase_t s_off, s_on; /* ~3.6 kB each, static */
static TaskHandle_t s_tx_task = nullptr;
static volatile bool s_tx_run = false;
static volatile uint32_t s_frames = 0;
static volatile uint32_t s_nomem = 0;
static uint32_t s_last_progress_ms = 0;

static void on_sat(const ubx_nav_sat_t *sat) {
  if (s_phase == OFF_PHASE) cn0_phase_add(&s_off, sat);
  if (s_phase == ON_PHASE) cn0_phase_add(&s_on, sat);
}

/* Continuous broadcast non-QoS data frames (allowed by esp_wifi_80211_tx).
 * 1000-byte payload at 1 Mbit/s 802.11b = ~8 ms on air per frame. */
static void tx_task(void *) {
  static uint8_t frame[24 + 1000];
  memset(frame, 0, sizeof frame);
  uint8_t mac[6];
  esp_wifi_get_mac(WIFI_IF_STA, mac);
  frame[0] = 0x08; /* frame control: type data, subtype 0 */
  frame[1] = 0x00;
  memset(frame + 4, 0xFF, 6); /* addr1 broadcast */
  memcpy(frame + 10, mac, 6); /* addr2 transmitter */
  memcpy(frame + 16, mac, 6); /* addr3 BSSID */
  for (size_t i = 24; i < sizeof frame; i++) frame[i] = (uint8_t)i;
  while (s_tx_run) {
    esp_err_t e = esp_wifi_80211_tx(WIFI_IF_STA, frame, sizeof frame, true);
    if (e == ESP_OK)
      s_frames = s_frames + 1;
    else {
      s_nomem = s_nomem + 1;
      vTaskDelay(1);
    }
  }
  s_tx_task = nullptr;
  vTaskDelete(nullptr);
}

static bool radio_on() {
  if (!power_wifi_allowed()) {
    Serial.println("[wifi] REFUSED by the low-battery policy");
    return false;
  }
  WiFi.mode(WIFI_STA); /* starts the driver; no association */
  esp_wifi_set_channel(kChannel, WIFI_SECOND_CHAN_NONE);
  esp_wifi_config_80211_tx_rate(WIFI_IF_STA, WIFI_PHY_RATE_1M_L); /* 802.11b */
  esp_err_t e = esp_wifi_set_max_tx_power(s_max ? kTxPowerMaxQdBm : kTxPowerCapQdBm);
  int8_t q = 0;
  esp_wifi_get_max_tx_power(&q);
  Serial.printf("[wifi] radio ON ch %u, max TX power set %s -> reads %.2f dBm\n", kChannel,
                e == ESP_OK ? "ok" : "FAILED", q * 0.25);
  g_pod.wifi_on = true;
  s_frames = 0;
  s_nomem = 0;
  s_tx_run = true;
  xTaskCreatePinnedToCore(tx_task, "wifitx", 4096, nullptr, 1, &s_tx_task, 0);
  return true;
}

static void radio_off() {
  s_tx_run = false;
  for (int i = 0; i < 100 && s_tx_task != nullptr; i++) delay(5);
  WiFi.mode(WIFI_OFF);
  g_pod.wifi_on = false;
  Serial.println("[wifi] radio OFF");
}

void wifi_test_start(int seconds, bool max_power) {
  if (s_phase != IDLE) {
    Serial.println("tx-test already running");
    return;
  }
  if (!g_pod.gnss.comm_ok) {
    Serial.println("REFUSED: GNSS not communicating (the test needs NAV-SAT)");
    return;
  }
  s_seconds = (uint32_t)seconds;
  s_max = max_power;
  cn0_phase_init(&s_off);
  cn0_phase_init(&s_on);
  gnss_set_sat_listener(on_sat);
  s_phase = OFF_PHASE;
  s_phase_end_ms = millis() + s_seconds * 1000;
  s_last_progress_ms = millis();
  Serial.printf("[wifi] tx-test: %lu s WiFi OFF, then %lu s continuous TX at %s\n",
                (unsigned long)s_seconds, (unsigned long)s_seconds,
                s_max ? "MAX (20 dBm, test 2 load)" : "13 dBm cap (test 4)");
  Serial.println("       Keep the pod still, open sky, >= 10 min warm-up before (DESIGN-REV-A 10A test 4).");
}

bool wifi_test_active() { return s_phase != IDLE; }

static void report() {
  int off_c = 0, off_u = 0, on_c = 0, on_u = 0;
  bool a = cn0_phase_result(&s_off, &off_c, &off_u);
  bool b = cn0_phase_result(&s_on, &on_c, &on_u);
  Serial.println("=========== WiFi TX vs GNSS C/N0 (DESIGN-REV-A 10A test 4) ===========");
  Serial.printf("TX OFF: %u epochs (%u skipped <8 SVs)  median top-8 C/N0 %.1f dBHz, used SVs %d\n",
                s_off.n, s_off.skipped, off_c / 10.0, off_u);
  Serial.printf("TX ON : %u epochs (%u skipped <8 SVs)  median top-8 C/N0 %.1f dBHz, used SVs %d\n",
                s_on.n, s_on.skipped, on_c / 10.0, on_u);
  Serial.printf("frames sent %lu (tx queue full %lu), power %s\n", (unsigned long)s_frames,
                (unsigned long)s_nomem, s_max ? "20 dBm" : "13 dBm");
  if (!a || !b) {
    Serial.println("VERDICT: INCONCLUSIVE (not enough epochs with >= 8 satellites)");
  } else {
    bool pass = cn0_test4_pass(off_c, on_c, off_u, on_u);
    Serial.printf("drop %.1f dB (limit 2.0), used SVs %d -> %d\nVERDICT: %s\n",
                  (off_c - on_c) / 10.0, off_u, on_u, pass ? "PASS" : "FAIL");
  }
  Serial.println("=====================================================================");
}

void wifi_test_service() {
  if (s_phase == IDLE) return;
  uint32_t now = millis();
  if (now - s_last_progress_ms >= 10000) {
    s_last_progress_ms = now;
    Serial.printf("[wifi] %s phase, %ld s left, epochs %u/%u, frames %lu\n",
                  s_phase == OFF_PHASE ? "OFF" : "TX-ON", (long)((int32_t)(s_phase_end_ms - now) / 1000),
                  s_off.n, s_on.n, (unsigned long)s_frames);
  }
  if ((int32_t)(now - s_phase_end_ms) < 0) return;
  if (s_phase == OFF_PHASE) {
    if (!radio_on()) {
      s_phase = IDLE;
      gnss_set_sat_listener(nullptr);
      return;
    }
    s_phase = ON_PHASE;
    s_phase_end_ms = now + s_seconds * 1000;
    return;
  }
  radio_off();
  s_phase = IDLE;
  gnss_set_sat_listener(nullptr);
  report();
}
