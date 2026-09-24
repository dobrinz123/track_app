#include "pps.h"

#include <Arduino.h>
#include <esp_timer.h>

#include "board_pins.h"
#include "console_io.h"
#include "isr_gpio.h"
#include "pod_state.h"

/* Single-producer (ISR) / single-consumer (loop) ring. The ISR writes the
 * slot, then publishes it by advancing s_head (32-bit, atomic on Xtensa);
 * the loop reads the slot before releasing it by advancing s_tail, so a
 * 64-bit slot is never read while being written. All in DRAM (static). */
static constexpr uint32_t kRing = 8;
static volatile int64_t s_ring[kRing];
static volatile uint32_t s_head = 0; /* written by ISR only */
static volatile uint32_t s_tail = 0; /* written by loop only */
static volatile uint32_t s_isr_count = 0;
static volatile uint32_t s_overflow = 0;

static void IRAM_ATTR pps_isr(void *) {
  int64_t t = esp_timer_get_time(); /* IRAM (link map 0x40379ca0) */
  uint32_t h = s_head;
  if (h - s_tail >= kRing) {
    s_overflow = s_overflow + 1;
    return;
  }
  s_ring[h & (kRing - 1)] = t;
  s_head = h + 1;
  s_isr_count = s_isr_count + 1;
}

void pps_init() {
  /* DESIGN-REV-A §6: GPIO21 is never an output; input, no pulls (the
   * receiver drives TIMEPULSE, SAFEBOOT_N shares the net). IRAM-safe ISR
   * service: see isr_gpio.h (review fix MEDIUM 7). */
  if (!isr_gpio_attach_rising(PIN_PPS, pps_isr, nullptr))
    con_println("[pps] interrupt setup FAILED: no PPS timebase");
}

void pps_service() {
  while (s_tail != s_head) {
    int64_t t = s_ring[s_tail & (kRing - 1)];
    s_tail = s_tail + 1;
    tb_on_pps(&g_pod.tb, t);
  }
}

uint32_t pps_isr_count() { return s_isr_count; }
uint32_t pps_overflow_count() { return s_overflow; }
