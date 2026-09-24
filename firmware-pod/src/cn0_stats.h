#ifndef TRACE_POD_CN0_STATS_H
#define TRACE_POD_CN0_STATS_H

/*
 * C/N0 statistics for DESIGN-REV-A §10A test 4 ("GNSS C/N0 with WiFi TX on
 * vs off"): pass = "Median C/N0 of the 8 strongest satellites drops by
 * <= 2 dB with TX on, and fix/satellite count is unchanged."
 *
 * Per NAV-SAT epoch: take the 8 highest cno values (cno > 0) and their
 * median (mean of the 4th and 5th). Per phase (TX off / TX on): median of
 * the per-epoch values, plus the median number of SVs used. Framework-free.
 */

#include <stdbool.h>
#include <stdint.h>

#include "ubx.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CN0_TOP_N 8
#define CN0_MAX_EPOCHS 1200 /* 20 min at 1 Hz per phase */

/* Median C/N0 (dBHz, x10 for one decimal) of the CN0_TOP_N strongest
 * satellites with cno > 0. Returns -1 if fewer than CN0_TOP_N are present. */
int cn0_epoch_top8_median_x10(const ubx_nav_sat_t *sat);
/* Number of SVs flagged svUsed. */
int cn0_epoch_used(const ubx_nav_sat_t *sat);

/* Per-phase record. Availability is TEMPORAL (review PODFW-REV2 M3):
 * every NAV-SAT / NAV-PVT is put into a one-second bucket of GNSS time
 * (floor(iTOW / 1000) relative to the phase start), so arrival jitter cannot
 * move a message into the wrong second and a silent stretch shows up as
 * empty seconds, whatever the total message count. */
typedef struct {
  int16_t med_x10[CN0_MAX_EPOCHS];
  uint8_t used[CN0_MAX_EPOCHS];
  uint16_t n;          /* NAV-SAT epochs with >= 8 satellites (C/N0 recorded) */
  uint16_t skipped;    /* NAV-SAT epochs with < 8 satellites */
  uint32_t sat_epochs; /* all NAV-SAT epochs received in the phase */
  uint32_t pvt_epochs; /* all NAV-PVT epochs received in the phase */
  uint32_t pvt_fix_ok; /* of which gnssFixOK with a 3-D (or GNSS+DR) fix */
  /* temporal buckets */
  uint32_t start_ms;   /* local time the phase started */
  uint16_t seconds;    /* phase length = number of buckets */
  uint8_t rate_hz;     /* configured NAV-PVT rate (expected PVTs per second) */
  bool have_base;
  uint32_t base_sec;   /* GPS second (iTOW/1000) of bucket 0 */
  uint32_t outside;    /* messages that fell outside the window */
  uint32_t win_start;  /* GNSS ms of the phase start (iTOW domain) */
  int64_t last_pvt_rel; /* ms into the window of the last valid-fix PVT, -1 none */
  int64_t last_sat_rel; /* ms into the window of the last NAV-SAT with >= 8 SVs */
  uint32_t max_gap_ms;  /* longest interval between them, minus the nominal period */
  uint8_t b_sat_ok[CN0_MAX_EPOCHS]; /* NAV-SAT epochs with >= 8 SVs in the second */
  uint8_t b_pvt_fix[CN0_MAX_EPOCHS]; /* valid-fix NAV-PVTs in the second */
} cn0_phase_t;

/* Start a phase: seconds (<= CN0_MAX_EPOCHS) long, starting at local time
 * start_ms, with NAV-PVT expected at rate_hz. */
void cn0_phase_begin(cn0_phase_t *p, uint32_t start_ms, uint16_t seconds, uint8_t rate_hz);
/* t_ms = local arrival time (used once, to align GNSS seconds to the phase). */
void cn0_phase_add(cn0_phase_t *p, const ubx_nav_sat_t *sat, uint32_t t_ms);
void cn0_phase_add_pvt(cn0_phase_t *p, bool fix_ok, uint32_t itow_ms, uint32_t t_ms);
/* Median over epochs; returns false if no epoch was recorded. */
bool cn0_phase_result(const cn0_phase_t *p, int *median_cn0_x10, int *median_used);

/* Temporal availability of a phase. A second is GOOD when it holds >= 1
 * NAV-SAT epoch with >= 8 satellites AND >= 90 % of the expected NAV-PVTs
 * (ceil(0.9 * rate_hz)) with a valid fix. The first and the last bucket are
 * partial (the phase does not start on a GPS second) and are not judged. */
typedef struct {
  uint32_t judged;      /* seconds judged (seconds - 2) */
  uint32_t good;        /* good seconds */
  uint32_t pct_x10;     /* good / judged, in 0.1 % */
  uint32_t longest_gap_ms; /* longest time without a valid-fix NAV-PVT or without a
                              NAV-SAT with >= 8 SVs, beyond the nominal period,
                              including both window edges */
} cn0_avail_t;
void cn0_phase_availability(const cn0_phase_t *p, cn0_avail_t *a);

/* C/N0 part of the §10A test 4 criterion: drop <= 2.0 dB and the used-SV
 * median does not drop. */
bool cn0_test4_pass(int off_cn0_x10, int on_cn0_x10, int off_used, int on_used);

/* Whole-test verdict. A PASS needs ALL of:
 *  - TX really ran: every setup call succeeded, >= CN0_MIN_TX_FPS successful
 *    frames per second on average, no whole second without a frame, and the
 *    radio was verifiably switched off again (shutdown_ok);
 *  - TX-OFF baseline: availability >= CN0_MIN_AVAIL_PCT and no gap longer
 *    than CN0_MAX_GAP_S (else the sky is not good enough: INCONCLUSIVE);
 *  - TX-ON: no gap longer than CN0_MAX_GAP_S and availability >= baseline
 *    availability - CN0_AVAIL_TOL_PCT (else FAIL);
 *  - the C/N0 criterion (cn0_test4_pass). */
#define CN0_MIN_TX_FPS 30
#define CN0_MIN_AVAIL_PCT 90
#define CN0_AVAIL_TOL_PCT 2
/* Valid-fix fraction (valid-fix NAV-PVT / all NAV-PVT) with TX on: at least
 * CN0_MIN_FIX_PCT_X10, and at most CN0_FIX_TOL_PCT_X10 below the TX-off
 * baseline (Codex PODFW-REV3: one invalid fix in ten every second kept
 * every second "good" at the 90 % per-second threshold). */
#define CN0_MIN_FIX_PCT_X10 990
#define CN0_FIX_TOL_PCT_X10 5
#define CN0_MAX_GAP_MS 2000
typedef enum { CN0_PASS = 0, CN0_FAIL = 1, CN0_INCONCLUSIVE = 2 } cn0_verdict_t;
typedef struct {
  bool setup_ok;
  uint32_t frames;       /* successful esp_wifi_80211_tx calls in the TX phase */
  uint32_t idle_seconds; /* seconds of the TX phase with zero successful frames */
  bool shutdown_ok;      /* WiFi.mode(WIFI_OFF) succeeded and the TX task stopped */
} cn0_tx_info_t;
cn0_verdict_t cn0_test4_verdict(const cn0_phase_t *off, const cn0_phase_t *on, uint32_t seconds,
                                const cn0_tx_info_t *tx, const char **reason);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_CN0_STATS_H */
