#include "wifi_test.h"

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "cn0_stats.h"
#include "console_io.h"
#include "gnss.h"
#include "pod_state.h"
#include "power.h"

/* esp_wifi_set_max_tx_power() takes units of 0.25 dBm; the driver maps a
 * request to a table value and esp_wifi_get_max_tx_power() returns it
 * (ESP-IDF 4.4 esp_wifi.h: 52 -> 52 = 13 dBm, 80 -> 80 = 20 dBm). */
static constexpr int8_t kTxPowerCapQdBm = 52; /* 13 dBm: DESIGN-REV-A §10.3 WiFi cap */
static constexpr int8_t kTxPowerMaxQdBm = 80; /* 20 dBm */
static constexpr uint8_t kChannel = 6;

enum Phase { IDLE, OFF_PHASE, ON_PHASE };
static Phase s_phase = IDLE;
static uint32_t s_phase_start_ms = 0;
static uint32_t s_phase_end_ms = 0;
static uint32_t s_seconds = 0;
static bool s_max = false;
static cn0_phase_t s_off, s_on; /* ~3.6 kB each, static */
static TaskHandle_t s_tx_task = nullptr;
static volatile bool s_tx_run = false;
static volatile bool s_tx_exited = true;
static volatile uint32_t s_frames = 0; /* successful esp_wifi_80211_tx calls */
static volatile uint32_t s_nomem = 0;
static uint32_t s_last_progress_ms = 0;
/* per-second TX accounting in the ON phase */
static uint32_t s_sec_mark_ms = 0;
static uint32_t s_sec_mark_frames = 0;
static uint32_t s_idle_seconds = 0;
static bool s_setup_ok = false;
static const char *s_setup_error = "";
static bool s_in_service = false; /* reentrancy guard (called from pod_yield too) */

static void on_sat(const ubx_nav_sat_t *sat) {
  if (s_phase == OFF_PHASE) cn0_phase_add(&s_off, sat);
  if (s_phase == ON_PHASE) cn0_phase_add(&s_on, sat);
}

static void on_pvt(const ubx_nav_pvt_t *p) {
  bool fix = (p->flags & UBX_PVT_FLAGS_GNSS_FIX_OK) && (p->fix_type == 3 || p->fix_type == 4);
  if (s_phase == OFF_PHASE) cn0_phase_add_pvt(&s_off, fix);
  if (s_phase == ON_PHASE) cn0_phase_add_pvt(&s_on, fix);
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
  uint32_t since_delay = 0;
  while (s_tx_run) {
    esp_err_t e = esp_wifi_80211_tx(WIFI_IF_STA, frame, sizeof frame, true);
    if (e == ESP_OK) {
      s_frames = s_frames + 1;
      /* let the core-0 idle task run (task watchdog) at a negligible cost */
      if (++since_delay >= 16) {
        since_delay = 0;
        vTaskDelay(1);
      }
    } else {
      s_nomem = s_nomem + 1;
      vTaskDelay(1);
    }
  }
  s_tx_exited = true;
  vTaskDelete(nullptr);
}

static void fail_setup(const char *what) {
  s_setup_ok = false;
  s_setup_error = what;
  con_printf("[wifi] SETUP FAILED: %s\n", what);
}

static void radio_off() {
  s_tx_run = false;
  for (int i = 0; i < 200 && !s_tx_exited; i++) delay(5);
  if (!s_tx_exited) con_println("[wifi] WARNING: TX task did not stop within 1 s");
  WiFi.mode(WIFI_OFF);
  g_pod.wifi_on = false;
  con_println("[wifi] radio OFF");
}

/* Every call checked (review fix MEDIUM 6). Returns false and leaves the
 * radio off on any failure. */
static bool radio_on() {
  s_setup_ok = true;
  if (!power_wifi_allowed()) {
    fail_setup("refused by the low-battery policy");
    return false;
  }
  if (!WiFi.mode(WIFI_STA)) { /* starts the driver; no association */
    fail_setup("WiFi.mode(WIFI_STA)");
    return false;
  }
  g_pod.wifi_on = true;
  if (esp_wifi_set_channel(kChannel, WIFI_SECOND_CHAN_NONE) != ESP_OK) {
    fail_setup("esp_wifi_set_channel");
    radio_off();
    return false;
  }
  if (esp_wifi_config_80211_tx_rate(WIFI_IF_STA, WIFI_PHY_RATE_1M_L) != ESP_OK) {
    fail_setup("esp_wifi_config_80211_tx_rate(1M long, 802.11b)");
    radio_off();
    return false;
  }
  int8_t want = s_max ? kTxPowerMaxQdBm : kTxPowerCapQdBm;
  int8_t q = 0;
  if (esp_wifi_set_max_tx_power(want) != ESP_OK || esp_wifi_get_max_tx_power(&q) != ESP_OK ||
      q != want) {
    con_printf("[wifi] TX power requested %.2f dBm, reads %.2f dBm\n", want * 0.25, q * 0.25);
    fail_setup("esp_wifi_set/get_max_tx_power mismatch");
    radio_off();
    return false;
  }
  uint8_t ch = 0;
  wifi_second_chan_t sc;
  if (esp_wifi_get_channel(&ch, &sc) != ESP_OK || ch != kChannel) {
    fail_setup("esp_wifi_get_channel mismatch");
    radio_off();
    return false;
  }
  s_frames = 0;
  s_nomem = 0;
  s_tx_run = true;
  s_tx_exited = false;
  if (xTaskCreatePinnedToCore(tx_task, "wifitx", 4096, nullptr, 1, &s_tx_task, 0) != pdPASS) {
    s_tx_run = false;
    s_tx_exited = true;
    fail_setup("xTaskCreatePinnedToCore(wifitx)");
    radio_off();
    return false;
  }
  con_printf("[wifi] radio ON ch %u, 802.11b 1 Mbit/s, max TX power %.2f dBm (read back)\n", ch,
             q * 0.25);
  return true;
}

void wifi_test_start(int seconds, bool max_power) {
  if (s_phase != IDLE) {
    con_println("tx-test already running");
    return;
  }
  if (!g_pod.gnss.comm_ok) {
    con_println("REFUSED: GNSS not communicating (the test needs NAV-SAT / NAV-PVT)");
    return;
  }
  s_seconds = (uint32_t)seconds;
  s_max = max_power;
  s_setup_ok = false;
  s_setup_error = "";
  s_idle_seconds = 0;
  s_frames = 0;
  cn0_phase_init(&s_off);
  cn0_phase_init(&s_on);
  gnss_set_sat_listener(on_sat);
  gnss_set_pvt_listener(on_pvt);
  s_phase = OFF_PHASE;
  s_phase_start_ms = millis();
  s_phase_end_ms = s_phase_start_ms + s_seconds * 1000;
  s_last_progress_ms = millis();
  con_printf("[wifi] tx-test: %lu s WiFi OFF, then %lu s continuous TX at %s\n",
             (unsigned long)s_seconds, (unsigned long)s_seconds,
             s_max ? "MAX (20 dBm, test 2 load)" : "13 dBm cap (test 4)");
  con_println("       Keep the pod still, open sky, >= 10 min warm-up before (DESIGN-REV-A 10A test 4).");
  con_println("       GNSS rate changes are refused (BUSY) until the test ends.");
}

bool wifi_test_active() { return s_phase != IDLE; }

static void report() {
  int off_c = 0, off_u = 0, on_c = 0, on_u = 0;
  bool a = cn0_phase_result(&s_off, &off_c, &off_u);
  bool b = cn0_phase_result(&s_on, &on_c, &on_u);
  cn0_tx_info_t tx = {s_setup_ok, s_frames, s_idle_seconds};
  const char *why = "";
  cn0_verdict_t v = cn0_test4_verdict(&s_off, &s_on, s_seconds, &tx, &why);
  con_println("=========== WiFi TX vs GNSS C/N0 (DESIGN-REV-A 10A test 4) ===========");
  con_printf("TX OFF: NAV-SAT %lu epochs (%u with >=8 SVs), NAV-PVT %lu (%lu valid fix)\n",
             (unsigned long)s_off.sat_epochs, s_off.n, (unsigned long)s_off.pvt_epochs,
             (unsigned long)s_off.pvt_fix_ok);
  if (a) con_printf("        median top-8 C/N0 %.1f dBHz, used SVs %d\n", off_c / 10.0, off_u);
  con_printf("TX ON : NAV-SAT %lu epochs (%u with >=8 SVs), NAV-PVT %lu (%lu valid fix)\n",
             (unsigned long)s_on.sat_epochs, s_on.n, (unsigned long)s_on.pvt_epochs,
             (unsigned long)s_on.pvt_fix_ok);
  if (b) con_printf("        median top-8 C/N0 %.1f dBHz, used SVs %d\n", on_c / 10.0, on_u);
  con_printf("TX: setup %s%s%s, frames sent %lu (min %lu), seconds without TX %lu, queue full %lu, "
             "power %s\n",
             s_setup_ok ? "ok" : "FAILED", s_setup_ok ? "" : ": ", s_setup_error,
             (unsigned long)s_frames, (unsigned long)(CN0_MIN_TX_FPS * s_seconds),
             (unsigned long)s_idle_seconds, (unsigned long)s_nomem, s_max ? "20 dBm" : "13 dBm");
  if (a && b) con_printf("C/N0 drop %.1f dB (limit 2.0)\n", (off_c - on_c) / 10.0);
  con_printf("VERDICT: %s (%s)\n",
             v == CN0_PASS ? "PASS" : (v == CN0_FAIL ? "FAIL" : "INCONCLUSIVE"), why);
  con_println("=====================================================================");
}

static void finish() {
  s_phase = IDLE;
  gnss_set_sat_listener(nullptr);
  gnss_set_pvt_listener(nullptr);
  report();
}

void wifi_test_service() {
  if (s_phase == IDLE || s_in_service) return;
  s_in_service = true;
  uint32_t now = millis();
  if (s_phase == ON_PHASE && now - s_sec_mark_ms >= 1000) {
    uint32_t f = s_frames;
    if (f == s_sec_mark_frames) s_idle_seconds++;
    s_sec_mark_frames = f;
    s_sec_mark_ms += 1000;
  }
  if (now - s_last_progress_ms >= 10000) {
    s_last_progress_ms = now;
    con_printf("[wifi] %s phase, %ld s left, NAV-SAT epochs %lu/%lu, frames %lu\n",
               s_phase == OFF_PHASE ? "OFF" : "TX-ON",
               (long)((int32_t)(s_phase_end_ms - now) / 1000), (unsigned long)s_off.sat_epochs,
               (unsigned long)s_on.sat_epochs, (unsigned long)s_frames);
  }
  if ((int32_t)(now - s_phase_end_ms) >= 0) {
    if (s_phase == OFF_PHASE) {
      if (!radio_on()) {
        finish(); /* verdict FAIL: setup */
      } else {
        s_phase = ON_PHASE;
        s_phase_start_ms = millis();
        s_phase_end_ms = s_phase_start_ms + s_seconds * 1000;
        s_sec_mark_ms = s_phase_start_ms;
        s_sec_mark_frames = s_frames;
      }
    } else {
      radio_off();
      finish();
    }
  }
  s_in_service = false;
}
