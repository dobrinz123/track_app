#ifndef TRACE_POD_IMU_FIFO_H
#define TRACE_POD_IMU_FIFO_H

/*
 * LSM6DSV16X FIFO stream decoder + decimator (framework-free).
 *
 * FIFO words are 7 bytes: TAG then X_L X_H Y_L Y_H Z_L Z_H.
 *   TAG_SENSOR = tag >> 3, TAG_CNT = (tag >> 1) & 3   (DS13510 §9.84)
 * "A batch event of the fastest main sensor also increments the TAG counter
 *  ... to identify different time slots" (AN5763 §9.2.x, Figure 26).
 * The timestamp word (tag 0x04) carries TIMESTAMP[31:0] in X_L..Y_H
 * (AN5763 Table 89) for its time slot. With DEC_TS_BATCH = 8 a timestamp is
 * written every 8th slot; the decoder anchors on it and gives each slot
 * anchor_tick + (slot - anchor_slot) * ticks_per_slot.
 *
 * Output samples are emitted when their slot is closed (the next slot's
 * first word arrives), so one slot of latency is added. A gyro + accel pair
 * in the same slot forms one sample; incomplete slots are counted and
 * dropped. Samples before the first timestamp (or after an overrun, which
 * breaks slot continuity: call imu_fifo_dec_resync) are dropped.
 */

#include <stdbool.h>
#include <stdint.h>

#include "clockmap.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint64_t tick; /* IMU timestamp counter (unwrapped) */
  int16_t acc[3];
  int16_t gyr[3];
} imu_raw_sample_t;

typedef void (*imu_sample_cb)(const imu_raw_sample_t *s, void *ctx);

typedef struct {
  double ticks_per_slot;
  bool have_slot;
  uint8_t cur_cnt;
  uint64_t slot_idx;
  bool anchored;
  uint64_t anchor_slot;
  uint64_t anchor_tick;
  tick_unwrap_t unwrap;
  /* pending (current) slot */
  uint8_t have_mask; /* bit0 gyro, bit1 acc */
  int16_t acc[3];
  int16_t gyr[3];
  /* stats */
  uint32_t words;
  uint32_t samples;
  uint32_t timestamps;
  uint32_t dropped_unanchored;
  uint32_t dropped_incomplete;
  uint32_t other_tags;
  uint32_t slot_skips; /* TAG_CNT advanced by more than one */
} imu_fifo_dec_t;

void imu_fifo_dec_init(imu_fifo_dec_t *d, double ticks_per_slot);
/* Forget slot continuity and the anchor (after a FIFO overrun/reconfig). */
void imu_fifo_dec_resync(imu_fifo_dec_t *d);
/* Feed one 7-byte FIFO word. */
void imu_fifo_dec_word(imu_fifo_dec_t *d, const uint8_t word[7], imu_sample_cb cb, void *ctx);

/* ---- decimator: box-car average of N samples (crude anti-alias) ---- */

typedef struct {
  int64_t pod_us;
  int16_t acc[3];
  int16_t gyr[3];
} imu_sample_t;

typedef struct {
  uint8_t n;     /* decimation factor, 1..16 */
  uint8_t count; /* samples accumulated */
  int64_t t_sum;
  int64_t t_first;
  int32_t acc_sum[3];
  int32_t gyr_sum[3];
} imu_decim_t;

void imu_decim_init(imu_decim_t *z, uint8_t n);
/* Returns true and fills *out when N samples have been accumulated. */
bool imu_decim_push(imu_decim_t *z, const imu_sample_t *in, imu_sample_t *out);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_IMU_FIFO_H */
