#include "imu_fifo.h"

#include <math.h>
#include <string.h>

#include "lsm6dsv16x_regs.h"

void imu_fifo_dec_init(imu_fifo_dec_t *d, double ticks_per_slot) {
  memset(d, 0, sizeof(*d));
  d->ticks_per_slot = ticks_per_slot;
}

void imu_fifo_dec_resync(imu_fifo_dec_t *d) {
  d->have_slot = false;
  d->anchored = false;
  d->have_mask = 0;
}

static int16_t le16(const uint8_t *p) { return (int16_t)(uint16_t)(p[0] | (p[1] << 8)); }

static void close_slot(imu_fifo_dec_t *d, imu_sample_cb cb, void *ctx) {
  if (d->have_mask == 0) return;
  if (d->have_mask != 0x3) {
    d->dropped_incomplete++;
  } else if (!d->anchored) {
    d->dropped_unanchored++;
  } else {
    imu_raw_sample_t s;
    double off = ((double)(int64_t)(d->slot_idx - d->anchor_slot)) * d->ticks_per_slot;
    s.tick = (uint64_t)((int64_t)d->anchor_tick + (int64_t)llround(off));
    memcpy(s.acc, d->acc, sizeof(s.acc));
    memcpy(s.gyr, d->gyr, sizeof(s.gyr));
    d->samples++;
    if (cb) cb(&s, ctx);
  }
  d->have_mask = 0;
}

void imu_fifo_dec_word(imu_fifo_dec_t *d, const uint8_t w[7], imu_sample_cb cb, void *ctx) {
  uint8_t sensor = (uint8_t)(w[0] >> 3);
  uint8_t cnt = (uint8_t)((w[0] >> 1) & 0x3);
  if (sensor == LSM_TAG_EMPTY) return;
  d->words++;
  if (!d->have_slot) {
    d->have_slot = true;
    d->cur_cnt = cnt;
    d->slot_idx = 0;
  } else if (cnt != d->cur_cnt) {
    close_slot(d, cb, ctx);
    uint8_t step = (uint8_t)((cnt - d->cur_cnt) & 0x3);
    if (step != 1) d->slot_skips++;
    d->slot_idx += step;
    d->cur_cnt = cnt;
  }
  switch (sensor) {
    case LSM_TAG_GYRO_NC:
      for (int i = 0; i < 3; i++) d->gyr[i] = le16(w + 1 + 2 * i);
      d->have_mask |= 0x1;
      break;
    case LSM_TAG_ACC_NC:
      for (int i = 0; i < 3; i++) d->acc[i] = le16(w + 1 + 2 * i);
      d->have_mask |= 0x2;
      break;
    case LSM_TAG_TIMESTAMP: {
      uint32_t ts = (uint32_t)w[1] | ((uint32_t)w[2] << 8) | ((uint32_t)w[3] << 16) |
                    ((uint32_t)w[4] << 24);
      d->anchor_tick = tick_unwrap(&d->unwrap, ts);
      d->anchor_slot = d->slot_idx;
      d->anchored = true;
      d->timestamps++;
      break;
    }
    default:
      d->other_tags++;
      break;
  }
}

void imu_decim_init(imu_decim_t *z, uint8_t n) {
  memset(z, 0, sizeof(*z));
  z->n = (n < 1) ? 1 : (n > 16 ? 16 : n);
}

static int16_t avg16(int32_t sum, int n) {
  /* round half away from zero */
  int32_t q = sum >= 0 ? (sum + n / 2) / n : -((-sum + n / 2) / n);
  if (q > 32767) q = 32767;
  if (q < -32768) q = -32768;
  return (int16_t)q;
}

bool imu_decim_push(imu_decim_t *z, const imu_sample_t *in, imu_sample_t *out) {
  if (z->count == 0) z->t_first = in->pod_us;
  z->t_sum += in->pod_us - z->t_first;
  for (int i = 0; i < 3; i++) {
    z->acc_sum[i] += in->acc[i];
    z->gyr_sum[i] += in->gyr[i];
  }
  z->count++;
  if (z->count < z->n) return false;
  int n = z->n;
  out->pod_us = z->t_first + (z->t_sum + n / 2) / n; /* mean time of the block */
  for (int i = 0; i < 3; i++) {
    out->acc[i] = avg16(z->acc_sum[i], n);
    out->gyr[i] = avg16(z->gyr_sum[i], n);
  }
  uint8_t keep = z->n;
  memset(z, 0, sizeof(*z));
  z->n = keep;
  return true;
}
