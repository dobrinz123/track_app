#include "clockmap.h"

#include <math.h>
#include <string.h>

void clockmap_init(clockmap_t *cm, double nominal_us_per_tick) {
  memset(cm, 0, sizeof(*cm));
  cm->nominal_us_per_tick = nominal_us_per_tick;
  cm->us_per_tick = nominal_us_per_tick;
}

static void restart(clockmap_t *cm, uint64_t tick, int64_t pod_us) {
  cm->valid = true;
  cm->ref_tick = tick;
  cm->ref_pod_us = (double)pod_us;
  cm->base_tick = tick;
  cm->base_pod_us = pod_us;
}

void clockmap_add_pair(clockmap_t *cm, uint64_t tick, int64_t pod_us) {
  cm->pairs++;
  if (!cm->valid) {
    restart(cm, tick, pod_us);
    return;
  }
  if (tick < cm->ref_tick) { /* counter reset (IMU re-init) */
    cm->resets++;
    cm->us_per_tick = cm->nominal_us_per_tick;
    restart(cm, tick, pod_us);
    return;
  }
  double pred = cm->ref_pod_us + (double)(tick - cm->ref_tick) * cm->us_per_tick;
  double resid = (double)pod_us - pred;
  if (fabs(resid) > CLOCKMAP_RESET_US) {
    cm->resets++;
    restart(cm, tick, pod_us);
    return;
  }
  cm->ref_pod_us = pred + resid * CLOCKMAP_OFFSET_ALPHA;
  cm->ref_tick = tick;
  int64_t span = pod_us - cm->base_pod_us;
  if (span >= CLOCKMAP_SLOPE_MIN_US && tick > cm->base_tick) {
    double meas = (double)span / (double)(tick - cm->base_tick);
    if (fabs(meas / cm->nominal_us_per_tick - 1.0) <= CLOCKMAP_MAX_SLOPE_ERR)
      cm->us_per_tick += (meas - cm->us_per_tick) * CLOCKMAP_SLOPE_ALPHA;
    cm->base_tick = tick;
    cm->base_pod_us = pod_us;
  }
}

bool clockmap_map(const clockmap_t *cm, uint64_t tick, int64_t *pod_us) {
  if (!cm->valid) return false;
  double d = (double)((int64_t)(tick - cm->ref_tick)) * cm->us_per_tick;
  *pod_us = (int64_t)llround(cm->ref_pod_us + d);
  return true;
}

uint64_t tick_unwrap(tick_unwrap_t *u, uint32_t raw) {
  /* Pick the 64-bit value congruent to raw (mod 2^32) that is closest to the
   * newest value seen so far. This tolerates interleaving of older readings
   * (FIFO timestamps) with newer ones (register reads) across a wrap. */
  if (!u->init) {
    u->init = true;
    u->high = raw; /* newest 64-bit value seen */
    return raw;
  }
  uint64_t ref = u->high;
  uint64_t cand = (ref & 0xFFFFFFFF00000000ull) | raw;
  if (cand > ref && cand - ref > 0x80000000ull && cand >= 0x100000000ull)
    cand -= 0x100000000ull;
  else if (cand < ref && ref - cand > 0x80000000ull)
    cand += 0x100000000ull;
  if (cand > u->high) u->high = cand;
  return cand;
}

double lsm6dsv16x_ts_us_per_tick(int8_t freq_fine) {
  return 1e6 / (46080.0 * (1.0 + 0.0013 * (double)freq_fine));
}
