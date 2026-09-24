#ifndef TRACE_POD_TIMEBASE_H
#define TRACE_POD_TIMEBASE_H

/*
 * Pod time base disciplined to GNSS time (framework-free).
 *
 * "Pod time" = the ESP32 esp_timer microsecond counter (int64, monotonic
 * since boot). Every frame the pod emits is stamped in pod time. This module
 * maintains the mapping pod time -> UTC (Unix microseconds):
 *
 *   unix_us(pod) = anchor_unix_us + d + d * rate_ppb / 1e9,  d = pod - anchor_pod_us
 *
 * Inputs:
 *  - tb_on_pps(pod_us): the pod time of every rising PPS edge, captured in
 *    the GPIO21 ISR. The receiver is configured to pulse only while locked
 *    to GNSS time, on the top of each second (gnss_config.c).
 *  - tb_on_pvt(rx_pod_us, epoch_unix_us): the UTC epoch of each NAV-PVT with
 *    valid date+time, and the pod time the frame was fully received.
 *
 * Which UTC second does a PPS edge mark? Let the edge be at UTC second S
 * (pod time pps), the NAV-PVT epoch at UTC time E, received at pod time
 * rx = pod(E) + L (L = output + UART + loop latency). Ignoring the ppm-level
 * clock difference, E - (rx - pps) = S - L, so with 0 <= L < 1 s:
 *   S = ceil((E - (rx - pps)) / 1 s).
 * This does not depend on whether the edge is older or newer than the
 * epoch, nor on missed pulses in between (the PPS may be up to
 * TB_PVT_MAX_AGE_US old); the only requirement is L < 1 s.
 *
 * Rate: from consecutive accepted pulses n seconds apart,
 *   r = n*1e6 / (pod_i - pod_{i-1}) - 1, exponentially averaged.
 * Pulses whose spacing is not an integer number of seconds within tolerance
 * are rejected as glitches.
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  TB_STATE_NONE = 0,      /* never anchored to UTC */
  TB_STATE_ACQUIRING = 1, /* pulses seen, not yet anchored / not enough pulses */
  TB_STATE_LOCKED = 2,    /* anchored, recent pulses */
  TB_STATE_HOLDOVER = 3   /* anchored, but no accepted pulse for > 1.5 s */
} tb_state_t;

typedef struct {
  /* last accepted PPS */
  bool have_pps;
  int64_t last_pps_pod_us;
  uint32_t consecutive_good;
  /* UTC anchor: the pod time of a PPS edge and the Unix time it marks */
  bool anchored;
  int64_t anchor_pod_us;
  int64_t anchor_unix_us;
  bool anchor_is_last_pps; /* anchor_pod_us == last_pps_pod_us */
  /* rate: unix seconds per pod second - 1, in ppb */
  bool have_rate;
  double rate; /* dimensionless */
  /* statistics */
  uint32_t pps_total;
  uint32_t pps_rejected;
  uint32_t reanchors;
  uint32_t anchor_mismatches;
} timebase_t;

/* tolerance on a PPS interval: fixed jitter + proportional clock error */
#define TB_PPS_TOL_FIXED_US 300
#define TB_PPS_TOL_PPM 200
#define TB_PPS_MAX_GAP_S 30   /* longer gaps restart the pulse chain */
#define TB_PVT_MAX_AGE_US 5000000 /* use a PPS for association only if < 5 s old */
#define TB_LOCK_MIN_PULSES 3
#define TB_LOCK_MAX_AGE_US 1500000
#define TB_RATE_EMA_DIV 8.0

void tb_init(timebase_t *tb);

/* Returns true if the pulse was accepted. */
bool tb_on_pps(timebase_t *tb, int64_t pod_us);

/* Returns true if this PVT (re)anchored or confirmed the anchor. */
bool tb_on_pvt(timebase_t *tb, int64_t rx_pod_us, int64_t epoch_unix_us);

tb_state_t tb_state(const timebase_t *tb, int64_t now_pod_us);
const char *tb_state_name(tb_state_t s);

/* Mapping; both return false if not anchored. */
bool tb_pod_to_unix(const timebase_t *tb, int64_t pod_us, int64_t *unix_us);
bool tb_unix_to_pod(const timebase_t *tb, int64_t unix_us, int64_t *pod_us);

int32_t tb_rate_ppb(const timebase_t *tb);

/* ---- civil time helpers ---- */

/* Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's
 * days_from_civil algorithm). */
int64_t tb_days_from_civil(int32_t y, uint32_t m, uint32_t d);

/* UTC date/time + NAV-PVT `nano` (-1e9..1e9 ns) -> Unix microseconds.
 * Floors the nanoseconds. sec may be 60 (leap second): it is treated as
 * 60 s after the minute, i.e. equal to the next minute's 0 s. */
int64_t tb_utc_to_unix_us(uint16_t year, uint8_t month, uint8_t day, uint8_t hour, uint8_t min,
                          uint8_t sec, int32_t nano);

/* floor division for int64 by a positive divisor */
int64_t tb_floor_div(int64_t a, int64_t b);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_TIMEBASE_H */
