#include "timebase.h"

#include <math.h>
#include <string.h>

int64_t tb_floor_div(int64_t a, int64_t b) {
  int64_t q = a / b;
  if ((a % b) != 0 && ((a < 0) != (b < 0))) q--;
  return q;
}

void tb_init(timebase_t *tb) { memset(tb, 0, sizeof(*tb)); }

bool tb_on_pps(timebase_t *tb, int64_t pod_us) {
  tb->pps_total++;
  if (!tb->have_pps) {
    tb->have_pps = true;
    tb->last_pps_pod_us = pod_us;
    tb->consecutive_good = 1;
    tb->anchor_is_last_pps = false;
    return true;
  }
  int64_t dt = pod_us - tb->last_pps_pod_us;
  if (dt <= 0) {
    tb->pps_rejected++;
    return false;
  }
  /* nearest whole number of seconds, corrected by the known rate */
  double scale = tb->have_rate ? (1.0 + tb->rate) : 1.0;
  int64_t n = (int64_t)llround((double)dt * scale / 1e6);
  if (n < 1) {
    /* a glitch shortly after a real edge: reject, keep the chain */
    tb->pps_rejected++;
    return false;
  }
  if (n > TB_PPS_MAX_GAP_S) {
    /* too long to bridge: restart the chain from this pulse. The UTC anchor
     * (if any) remains usable in holdover, but is no longer this pulse. */
    tb->last_pps_pod_us = pod_us;
    tb->consecutive_good = 1;
    tb->anchor_is_last_pps = false;
    return true;
  }
  double expected = (double)n * 1e6 / scale;
  double tol = TB_PPS_TOL_FIXED_US + (double)n * 1e6 * TB_PPS_TOL_PPM * 1e-6;
  if (fabs((double)dt - expected) > tol) {
    tb->pps_rejected++;
    return false;
  }
  /* accepted: update the rate estimate */
  double r = (double)n * 1e6 / (double)dt - 1.0;
  if (!tb->have_rate) {
    tb->rate = r;
    tb->have_rate = true;
  } else {
    tb->rate += (r - tb->rate) / TB_RATE_EMA_DIV;
  }
  /* carry the UTC anchor forward to this edge (exactly n seconds later) */
  if (tb->anchored && tb->anchor_is_last_pps) {
    tb->anchor_unix_us += n * 1000000;
    tb->anchor_pod_us = pod_us;
  } else {
    tb->anchor_is_last_pps = false;
  }
  tb->last_pps_pod_us = pod_us;
  tb->consecutive_good++;
  return true;
}

bool tb_on_pvt(timebase_t *tb, int64_t rx_pod_us, int64_t epoch_unix_us) {
  if (!tb->have_pps) return false;
  int64_t age = rx_pod_us - tb->last_pps_pod_us;
  if (age < 0 || age > TB_PVT_MAX_AGE_US) return false;
  /* S = ceil((E - age) / 1 s), in microseconds */
  int64_t cand = epoch_unix_us - age;
  int64_t s = -tb_floor_div(-cand, 1000000); /* ceil */
  int64_t pps_unix_us = s * 1000000;
  if (tb->anchored && tb->anchor_is_last_pps) {
    if (tb->anchor_unix_us == pps_unix_us) return true; /* confirmed */
    tb->anchor_mismatches++;
  }
  if (tb->anchored) tb->reanchors++;
  tb->anchored = true;
  tb->anchor_pod_us = tb->last_pps_pod_us;
  tb->anchor_unix_us = pps_unix_us;
  tb->anchor_is_last_pps = true;
  return true;
}

tb_state_t tb_state(const timebase_t *tb, int64_t now_pod_us) {
  if (!tb->anchored) return tb->have_pps ? TB_STATE_ACQUIRING : TB_STATE_NONE;
  int64_t age = now_pod_us - tb->last_pps_pod_us;
  if (tb->anchor_is_last_pps && age <= TB_LOCK_MAX_AGE_US &&
      tb->consecutive_good >= TB_LOCK_MIN_PULSES)
    return TB_STATE_LOCKED;
  if (tb->anchor_is_last_pps && age <= TB_LOCK_MAX_AGE_US) return TB_STATE_ACQUIRING;
  return TB_STATE_HOLDOVER;
}

const char *tb_state_name(tb_state_t s) {
  switch (s) {
    case TB_STATE_ACQUIRING: return "acquiring";
    case TB_STATE_LOCKED: return "locked";
    case TB_STATE_HOLDOVER: return "holdover";
    default: return "none";
  }
}

bool tb_pod_to_unix(const timebase_t *tb, int64_t pod_us, int64_t *unix_us) {
  if (!tb->anchored) return false;
  int64_t d = pod_us - tb->anchor_pod_us;
  double corr = tb->have_rate ? (double)d * tb->rate : 0.0;
  *unix_us = tb->anchor_unix_us + d + (int64_t)llround(corr);
  return true;
}

bool tb_unix_to_pod(const timebase_t *tb, int64_t unix_us, int64_t *pod_us) {
  if (!tb->anchored) return false;
  int64_t du = unix_us - tb->anchor_unix_us;
  double scale = tb->have_rate ? (1.0 + tb->rate) : 1.0;
  *pod_us = tb->anchor_pod_us + (int64_t)llround((double)du / scale);
  return true;
}

int32_t tb_rate_ppb(const timebase_t *tb) {
  if (!tb->have_rate) return 0;
  double ppb = tb->rate * 1e9;
  if (ppb > 2147483647.0) ppb = 2147483647.0;
  if (ppb < -2147483648.0) ppb = -2147483648.0;
  return (int32_t)llround(ppb);
}

int64_t tb_days_from_civil(int32_t y, uint32_t m, uint32_t d) {
  /* http://howardhinnant.github.io/date_algorithms.html#days_from_civil */
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const uint32_t yoe = (uint32_t)(y - era * 400);
  const uint32_t doy = (153 * (m + (m > 2 ? (uint32_t)-3 : 9)) + 2) / 5 + d - 1;
  const uint32_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int64_t)doe - 719468;
}

int64_t tb_utc_to_unix_us(uint16_t year, uint8_t month, uint8_t day, uint8_t hour, uint8_t min,
                          uint8_t sec, int32_t nano) {
  int64_t days = tb_days_from_civil(year, month, day);
  int64_t s = days * 86400 + (int64_t)hour * 3600 + (int64_t)min * 60 + sec;
  return s * 1000000 + tb_floor_div(nano, 1000);
}
