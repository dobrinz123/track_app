#include "cn0_stats.h"

#include <string.h>

static void sort_desc_u8(uint8_t *a, int n) {
  for (int i = 1; i < n; i++) {
    uint8_t v = a[i];
    int j = i - 1;
    while (j >= 0 && a[j] < v) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = v;
  }
}

static void sort_asc_i16(int16_t *a, int n) {
  for (int i = 1; i < n; i++) {
    int16_t v = a[i];
    int j = i - 1;
    while (j >= 0 && a[j] > v) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = v;
  }
}

int cn0_epoch_top8_median_x10(const ubx_nav_sat_t *sat) {
  uint8_t c[UBX_NAV_SAT_MAX_SV];
  int n = 0;
  for (int i = 0; i < sat->num_svs; i++)
    if (sat->sats[i].cno_dbhz > 0) c[n++] = sat->sats[i].cno_dbhz;
  if (n < CN0_TOP_N) return -1;
  sort_desc_u8(c, n);
  /* median of 8 values = mean of the 4th and 5th, x10 */
  return (c[3] + c[4]) * 10 / 2;
}

int cn0_epoch_used(const ubx_nav_sat_t *sat) {
  int u = 0;
  for (int i = 0; i < sat->num_svs; i++)
    if (sat->sats[i].used) u++;
  return u;
}

void cn0_phase_begin(cn0_phase_t *p, uint32_t start_ms, uint16_t seconds, uint8_t rate_hz) {
  memset(p, 0, sizeof(*p));
  p->start_ms = start_ms;
  p->seconds = seconds > CN0_MAX_EPOCHS ? CN0_MAX_EPOCHS : seconds;
  p->rate_hz = rate_hz ? rate_hz : 1;
  p->last_pvt_rel = -1;
  p->last_sat_rel = -1;
}

#define WEEK_S 604800u

/* Map a GNSS time of week to a bucket; -1 if outside the window. The first
 * message fixes the relation between GPS seconds and the phase start. */
#define WEEK_MS (WEEK_S * 1000u)

static int bucket(cn0_phase_t *p, uint32_t itow_ms, uint32_t t_ms) {
  uint32_t sec = itow_ms / 1000u;
  if (!p->have_base) {
    uint32_t elapsed_ms = (uint32_t)(t_ms - p->start_ms);
    uint32_t elapsed_s = elapsed_ms / 1000u;
    p->base_sec = (sec + WEEK_S - (elapsed_s % WEEK_S)) % WEEK_S;
    /* GNSS time of the phase start (arrival latency, tens of ms, ignored) */
    p->win_start = (itow_ms + WEEK_MS - (elapsed_ms % WEEK_MS)) % WEEK_MS;
    p->have_base = true;
  }
  uint32_t k = (sec + WEEK_S - p->base_sec) % WEEK_S; /* handles the week rollover */
  if (k >= p->seconds) {
    p->outside++;
    return -1;
  }
  return (int)k;
}

/* ms into the window, or -1 if outside */
static int64_t rel_ms(const cn0_phase_t *p, uint32_t itow_ms) {
  uint32_t r = (itow_ms + WEEK_MS - p->win_start) % WEEK_MS;
  return r < (uint32_t)p->seconds * 1000u ? (int64_t)r : -1;
}

static void track_gap(cn0_phase_t *p, int64_t *last, int64_t now, uint32_t nominal) {
  if (now < 0) return;
  int64_t prev = *last < 0 ? 0 : *last; /* first one: gap from the window start */
  int64_t g = now - prev - (int64_t)nominal;
  if (g > (int64_t)p->max_gap_ms) p->max_gap_ms = (uint32_t)g;
  if (now > *last) *last = now;
}

void cn0_phase_add_pvt(cn0_phase_t *p, bool fix_ok, uint32_t itow_ms, uint32_t t_ms) {
  p->pvt_epochs++;
  if (fix_ok) p->pvt_fix_ok++;
  int k = bucket(p, itow_ms, t_ms);
  if (k >= 0 && fix_ok && p->b_pvt_fix[k] < 255) p->b_pvt_fix[k]++;
  if (fix_ok) track_gap(p, &p->last_pvt_rel, rel_ms(p, itow_ms), 1000u / p->rate_hz);
}

void cn0_phase_add(cn0_phase_t *p, const ubx_nav_sat_t *sat, uint32_t t_ms) {
  p->sat_epochs++;
  int m = cn0_epoch_top8_median_x10(sat);
  int k = bucket(p, sat->itow_ms, t_ms);
  if (m < 0) {
    p->skipped++;
    return;
  }
  if (k >= 0 && p->b_sat_ok[k] < 255) p->b_sat_ok[k]++;
  track_gap(p, &p->last_sat_rel, rel_ms(p, sat->itow_ms), 1000u);
  if (p->n >= CN0_MAX_EPOCHS) return;
  p->med_x10[p->n] = (int16_t)m;
  int u = cn0_epoch_used(sat);
  p->used[p->n] = (uint8_t)(u > 255 ? 255 : u);
  p->n++;
}

void cn0_phase_availability(const cn0_phase_t *p, cn0_avail_t *a) {
  memset(a, 0, sizeof(*a));
  if (p->seconds < 3) return;
  uint32_t need_pvt = ((uint32_t)p->rate_hz * 9u + 9u) / 10u; /* ceil(0.9 * rate) */
  for (uint32_t k = 1; k + 1 < p->seconds; k++) { /* interior seconds only */
    a->judged++;
    if (p->b_sat_ok[k] >= 1 && p->b_pvt_fix[k] >= need_pvt) a->good++;
  }
  a->pct_x10 = a->judged ? (uint32_t)((uint64_t)a->good * 1000u / a->judged) : 0;
  /* gaps: the recorded ones plus the trailing edge of each stream */
  uint32_t end = (uint32_t)p->seconds * 1000u;
  uint32_t g = p->max_gap_ms;
  int64_t tp = end - (p->last_pvt_rel < 0 ? 0 : p->last_pvt_rel) - (int64_t)(1000u / p->rate_hz);
  int64_t ts = end - (p->last_sat_rel < 0 ? 0 : p->last_sat_rel) - 1000;
  if (tp > (int64_t)g) g = (uint32_t)tp;
  if (ts > (int64_t)g) g = (uint32_t)ts;
  a->longest_gap_ms = g;
}

bool cn0_phase_result(const cn0_phase_t *p, int *median_cn0_x10, int *median_used) {
  if (p->n == 0) return false;
  static int16_t tmp[CN0_MAX_EPOCHS];
  memcpy(tmp, p->med_x10, p->n * sizeof(int16_t));
  sort_asc_i16(tmp, p->n);
  int n = p->n;
  *median_cn0_x10 = (n % 2) ? tmp[n / 2] : (tmp[n / 2 - 1] + tmp[n / 2]) / 2;
  for (int i = 0; i < n; i++) tmp[i] = p->used[i];
  sort_asc_i16(tmp, n);
  *median_used = (n % 2) ? tmp[n / 2] : (tmp[n / 2 - 1] + tmp[n / 2]) / 2;
  return true;
}

bool cn0_test4_pass(int off_cn0_x10, int on_cn0_x10, int off_used, int on_used) {
  return (off_cn0_x10 - on_cn0_x10) <= 20 && on_used >= off_used;
}

cn0_verdict_t cn0_test4_verdict(const cn0_phase_t *off, const cn0_phase_t *on, uint32_t seconds,
                                const cn0_tx_info_t *tx, const char **reason) {
  const char *why = "ok";
  cn0_verdict_t v = CN0_PASS;
  int off_c, off_u, on_c, on_u;
  cn0_avail_t aoff, aon;
  cn0_phase_availability(off, &aoff);
  cn0_phase_availability(on, &aon);
  if (seconds < 3 || aoff.judged == 0 || aon.judged == 0) {
    why = "test too short to judge";
    v = CN0_INCONCLUSIVE;
  } else if (!tx->setup_ok) {
    why = "WiFi TX setup failed";
    v = CN0_FAIL;
  } else if (tx->frames < (uint64_t)CN0_MIN_TX_FPS * seconds) {
    why = "too few successful TX frames (TX did not run at the requested load)";
    v = CN0_FAIL;
  } else if (tx->idle_seconds > 0) {
    why = "TX stalled for at least one whole second";
    v = CN0_FAIL;
  } else if (!tx->shutdown_ok) {
    why = "WiFi shutdown not verified (radio state unknown)";
    v = CN0_FAIL;
  } else if (aoff.pct_x10 < CN0_MIN_AVAIL_PCT * 10u) {
    why = "TX-OFF baseline availability < 90 % (sky not good enough)";
    v = CN0_INCONCLUSIVE;
  } else if (aoff.longest_gap_ms > CN0_MAX_GAP_MS) {
    why = "TX-OFF baseline has a GNSS gap > 2 s (sky not good enough)";
    v = CN0_INCONCLUSIVE;
  } else if (aon.longest_gap_ms > CN0_MAX_GAP_MS) {
    why = "GNSS gap > 2 s with TX on";
    v = CN0_FAIL;
  } else if (aon.pct_x10 + CN0_AVAIL_TOL_PCT * 10u < aoff.pct_x10) {
    why = "availability with TX on below the TX-off baseline minus 2 %";
    v = CN0_FAIL;
  } else if (!cn0_phase_result(off, &off_c, &off_u) || !cn0_phase_result(on, &on_c, &on_u)) {
    why = "no C/N0 epochs";
    v = CN0_INCONCLUSIVE;
  } else if (!cn0_test4_pass(off_c, on_c, off_u, on_u)) {
    why = "C/N0 drop > 2.0 dB or fewer satellites used with TX on";
    v = CN0_FAIL;
  }
  if (reason) *reason = why;
  return v;
}
