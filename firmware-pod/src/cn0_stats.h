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

typedef struct {
  int16_t med_x10[CN0_MAX_EPOCHS];
  uint8_t used[CN0_MAX_EPOCHS];
  uint16_t n;          /* NAV-SAT epochs with >= 8 satellites (C/N0 recorded) */
  uint16_t skipped;    /* NAV-SAT epochs with < 8 satellites */
  uint32_t sat_epochs; /* all NAV-SAT epochs received in the phase */
  uint32_t pvt_epochs; /* all NAV-PVT epochs received in the phase */
  uint32_t pvt_fix_ok; /* of which gnssFixOK with a 3-D (or GNSS+DR) fix */
} cn0_phase_t;

void cn0_phase_init(cn0_phase_t *p);
void cn0_phase_add(cn0_phase_t *p, const ubx_nav_sat_t *sat);
void cn0_phase_add_pvt(cn0_phase_t *p, bool fix_ok);
/* Median over epochs; returns false if no epoch was recorded. */
bool cn0_phase_result(const cn0_phase_t *p, int *median_cn0_x10, int *median_used);

/* C/N0 part of the §10A test 4 criterion: drop <= 2.0 dB and the used-SV
 * median does not drop. */
bool cn0_test4_pass(int off_cn0_x10, int on_cn0_x10, int off_used, int on_used);

/* Whole-test verdict (review fix MEDIUM 6). A PASS needs ALL of:
 *  - TX actually ran: every setup call succeeded, >= CN0_MIN_TX_FPS
 *    successful frames per second on average, and no whole second of the
 *    TX phase without a successful frame;
 *  - availability over the WHOLE window in both phases: NAV-SAT epochs
 *    >= 90 % of the seconds, epochs with >= 8 satellites >= 90 % of those,
 *    NAV-PVT epochs >= 90 % of the seconds and >= 99 % of them with a valid
 *    fix (gnssFixOK, fixType 3 or 4);
 *  - the C/N0 criterion (cn0_test4_pass).
 * If the TX-OFF baseline itself misses the availability bars the sky is not
 * good enough to judge: INCONCLUSIVE. TX failures or TX-ON availability
 * failures are FAIL. */
#define CN0_MIN_TX_FPS 30
#define CN0_MIN_COVERAGE_PCT 90
#define CN0_MIN_GE8_PCT 90
#define CN0_MIN_FIX_PCT 99
typedef enum { CN0_PASS = 0, CN0_FAIL = 1, CN0_INCONCLUSIVE = 2 } cn0_verdict_t;
typedef struct {
  bool setup_ok;
  uint32_t frames;       /* successful esp_wifi_80211_tx calls in the TX phase */
  uint32_t idle_seconds; /* seconds of the TX phase with zero successful frames */
} cn0_tx_info_t;
cn0_verdict_t cn0_test4_verdict(const cn0_phase_t *off, const cn0_phase_t *on, uint32_t seconds,
                                const cn0_tx_info_t *tx, const char **reason);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_CN0_STATS_H */
