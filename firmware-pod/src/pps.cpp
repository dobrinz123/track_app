#include "pps.h"

#include <Arduino.h>
#include <esp_timer.h>

#include "board_pins.h"
#include "pod_state.h"

/* single-producer (ISR) / single-consumer (loop) ring */
static constexpr uint32_t kRing = 8;
static volatile int64_t s_ring[kRing];
static volatile uint32_t s_head = 0; /* written by ISR */
static uint32_t s_tail = 0;          /* written by loop */
static volatile uint32_t s_isr_count = 0;
static volatile uint32_t s_overflow = 0;
static volatile int64_t s_last_edge = 0;

static void IRAM_ATTR pps_isr() {
  int64_t t = esp_timer_get_time();
  uint32_t h = s_head;
  if (h - s_tail >= kRing) {
    s_overflow = s_overflow + 1;
    return;
  }
  s_ring[h % kRing] = t;
  s_head = h + 1; /* publish after the slot is written */
  s_isr_count = s_isr_count + 1;
  s_last_edge = t;
}

void pps_init() {
  /* DESIGN-REV-A §6: GPIO21 is never an output. INPUT, no pull-up/down: the
   * receiver drives TIMEPULSE, and SAFEBOOT_N shares the net. */
  pinMode(PIN_PPS, INPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_PPS), pps_isr, RISING);
}

void pps_service() {
  while (s_tail != s_head) {
    int64_t t = s_ring[s_tail % kRing];
    s_tail++;
    tb_on_pps(&g_pod.tb, t);
  }
}

uint32_t pps_isr_count() { return s_isr_count; }
uint32_t pps_overflow_count() { return s_overflow; }
int64_t pps_last_edge_us() { return s_last_edge; }
