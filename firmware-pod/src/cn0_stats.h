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
  uint16_t n;
  uint16_t skipped; /* epochs with < 8 satellites */
} cn0_phase_t;

void cn0_phase_init(cn0_phase_t *p);
void cn0_phase_add(cn0_phase_t *p, const ubx_nav_sat_t *sat);
/* Median over epochs; returns false if no epoch was recorded. */
bool cn0_phase_result(const cn0_phase_t *p, int *median_cn0_x10, int *median_used);

/* §10A test 4 verdict: drop <= 2.0 dB and used-SV median unchanged. */
bool cn0_test4_pass(int off_cn0_x10, int on_cn0_x10, int off_used, int on_used);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_CN0_STATS_H */
