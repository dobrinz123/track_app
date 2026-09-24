#ifndef TRACE_POD_CLOCKMAP_H
#define TRACE_POD_CLOCKMAP_H

/*
 * Linear map from a foreign hardware counter (the LSM6DSV16X timestamp
 * counter) to pod microseconds, fitted from noisy (tick, pod_us) pairs
 * (framework-free).
 *
 * The IMU timestamp counter runs from the IMU's own oscillator (nominal LSB
 * 21.75 us; actual 1 / (46080 * (1 + 0.0013 * FREQ_FINE)) s, ST DS13510 Rev 4
 * §9.52 / AN5763 Rev 2 §6.4). The ESP32 reads TIMESTAMP0..3 bracketed by two
 * esp_timer reads and feeds the midpoint here; I2C latency makes each pair
 * noisy by ~±100 us, so the offset is low-pass filtered and the slope is
 * measured over >= 1 s baselines.
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  bool valid;
  uint64_t ref_tick;
  double ref_pod_us; /* filtered pod time at ref_tick */
  double us_per_tick;
  double nominal_us_per_tick;
  /* slope baseline */
  uint64_t base_tick;
  int64_t base_pod_us;
  uint32_t pairs;
  uint32_t resets;
} clockmap_t;

#define CLOCKMAP_OFFSET_ALPHA 0.1
#define CLOCKMAP_SLOPE_ALPHA 0.2
#define CLOCKMAP_RESET_US 5000.0      /* residual that means "discontinuity" */
#define CLOCKMAP_SLOPE_MIN_US 1000000 /* 1 s baseline for slope updates */
#define CLOCKMAP_MAX_SLOPE_ERR 0.005  /* reject slope estimates > 0.5 % off nominal */

void clockmap_init(clockmap_t *cm, double nominal_us_per_tick);
void clockmap_add_pair(clockmap_t *cm, uint64_t tick, int64_t pod_us);
/* returns false until the first pair */
bool clockmap_map(const clockmap_t *cm, uint64_t tick, int64_t *pod_us);

/* 32-bit counter -> monotonic 64-bit (handles wrap; the LSM6DSV16X counter
 * wraps after ~26 h, AN5763 §6.4). */
typedef struct {
  bool init;
  uint64_t high; /* newest unwrapped value */
} tick_unwrap_t;
uint64_t tick_unwrap(tick_unwrap_t *u, uint32_t raw);

/* LSM6DSV16X timestamp LSB in microseconds from INTERNAL_FREQ_FINE (signed
 * byte): 1e6 / (46080 * (1 + 0.0013 * freq_fine)). DS13510 §9.52. */
double lsm6dsv16x_ts_us_per_tick(int8_t freq_fine);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_CLOCKMAP_H */
