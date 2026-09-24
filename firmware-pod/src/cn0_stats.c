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

void cn0_phase_init(cn0_phase_t *p) { memset(p, 0, sizeof(*p)); }

void cn0_phase_add(cn0_phase_t *p, const ubx_nav_sat_t *sat) {
  int m = cn0_epoch_top8_median_x10(sat);
  if (m < 0) {
    p->skipped++;
    return;
  }
  if (p->n >= CN0_MAX_EPOCHS) return;
  p->med_x10[p->n] = (int16_t)m;
  int u = cn0_epoch_used(sat);
  p->used[p->n] = (uint8_t)(u > 255 ? 255 : u);
  p->n++;
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
