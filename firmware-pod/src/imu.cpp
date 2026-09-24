#include "imu.h"

#include <Arduino.h>

#include "console_io.h"
#include <Wire.h>
#include <esp_timer.h>
#include <string.h>

#include "ble_link.h"
#include "board_pins.h"
#include "clockmap.h"
#include "isr_gpio.h"
#include "imu_fifo.h"
#include "lsm6dsv16x_regs.h"
#include "pod_protocol.h"
#include "pod_state.h"

/* Watermark: 64 words ~ 63 ms at 1020 words/s (480 Hz gyro + 480 Hz accel +
 * 60 Hz timestamps), about 30 % of the 219-word FIFO, so a 150 ms stall of
 * the main loop still does not overrun. */
static constexpr uint8_t kWatermarkWords = 64;
static constexpr uint32_t kPollIntervalUs = 20000; /* fallback poll if INT1 is missed */
static constexpr uint32_t kMaxWordsPerService = 200;

static volatile bool s_int_flag = false;
static imu_fifo_dec_t s_dec;
static clockmap_t s_map;
static imu_decim_t s_decim;
static int8_t s_freq_fine = 0;
static uint32_t s_overruns = 0;
static uint32_t s_i2c_errors = 0;
static int64_t s_last_service_us = 0;
static int s_dump_remaining = 0;
static uint32_t s_int_count = 0;

/* BLE batch under construction */
static pod_imu_batch_t s_batch;
static int64_t s_batch_t0 = 0;
static int64_t s_batch_started_us = 0;

static void IRAM_ATTR imu_isr(void *) {
  s_int_flag = true;
  s_int_count++;
}

static bool wr(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(LSM6DSV16X_I2C_ADDR);
  Wire.write(reg);
  Wire.write(val);
  bool ok = Wire.endTransmission() == 0;
  if (!ok) s_i2c_errors++;
  return ok;
}

static bool rd(uint8_t reg, uint8_t *buf, size_t n) {
  Wire.beginTransmission(LSM6DSV16X_I2C_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    s_i2c_errors++;
    return false;
  }
  size_t got = Wire.requestFrom((uint16_t)LSM6DSV16X_I2C_ADDR, (uint8_t)n, (bool)true);
  if (got != n) {
    s_i2c_errors++;
    return false;
  }
  for (size_t i = 0; i < n; i++) buf[i] = (uint8_t)Wire.read();
  return true;
}

bool imu_init() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_FREQ_HZ);
  Wire.setTimeOut(10);
  uint8_t who = 0;
  if (!rd(LSM_REG_WHO_AM_I, &who, 1) || who != LSM_WHO_AM_I_VALUE) {
    con_printf("[imu] WHO_AM_I = 0x%02X (expected 0x70): LSM6DSV16X not found at 0x6A\n", who);
    g_pod.imu_ok = false;
    return false;
  }
  /* software reset, wait for SW_RESET to self-clear (DS13510 §9.16) */
  wr(LSM_REG_CTRL3, LSM_CTRL3_SW_RESET);
  uint8_t c3 = LSM_CTRL3_SW_RESET;
  for (int i = 0; i < 50 && (c3 & LSM_CTRL3_SW_RESET); i++) {
    delay(1);
    rd(LSM_REG_CTRL3, &c3, 1);
  }
  bool ok = true;
  /* IF_CFG survives SW_RESET (§9.3): force the documented default 0x00 =
   * INT pins active-high push-pull, I2C enabled, no SDA pull-up. */
  ok &= wr(LSM_REG_IF_CFG, 0x00);
  ok &= wr(LSM_REG_CTRL3, LSM_CTRL3_BDU | LSM_CTRL3_IF_INC);
  ok &= wr(LSM_REG_CTRL8, LSM_FS_XL_16G);    /* ±16 g, LPF2 off */
  ok &= wr(LSM_REG_CTRL6, LSM_FS_G_2000DPS); /* ±2000 dps, LPF1 BW code 000 */
  ok &= wr(LSM_REG_FIFO_CTRL1, kWatermarkWords);
  ok &= wr(LSM_REG_FIFO_CTRL2, 0x00); /* no compression, no stop-on-WTM */
  ok &= wr(LSM_REG_FIFO_CTRL3, (uint8_t)((LSM_BDR_480HZ << 4) | LSM_BDR_480HZ));
  ok &= wr(LSM_REG_FIFO_CTRL4, (uint8_t)(LSM_DEC_TS_BATCH_8 | LSM_FIFO_MODE_CONTINUOUS));
  ok &= wr(LSM_REG_FUNCTIONS_ENABLE, LSM_FUNC_TIMESTAMP_EN);
  ok &= wr(LSM_REG_INT1_CTRL, LSM_INT1_FIFO_TH | LSM_INT1_FIFO_OVR);
  uint8_t ff = 0;
  ok &= rd(LSM_REG_INTERNAL_FREQ_FINE, &ff, 1);
  s_freq_fine = (int8_t)ff;
  /* start the sensors last: 480 Hz high-performance mode */
  ok &= wr(LSM_REG_CTRL1, (uint8_t)((LSM_OP_MODE_HP << 4) | LSM_ODR_480HZ));
  ok &= wr(LSM_REG_CTRL2, (uint8_t)((LSM_OP_MODE_HP << 4) | LSM_ODR_480HZ));

  imu_fifo_dec_init(&s_dec, LSM_TICKS_PER_SLOT_480HZ);
  clockmap_init(&s_map, lsm6dsv16x_ts_us_per_tick(s_freq_fine));
  imu_decim_init(&s_decim, g_pod.imu_decim);
  memset(&s_batch, 0, sizeof s_batch);

  /* push-pull, active-high INT1 (IF_CFG = 0x00); IRAM-safe ISR service
   * (isr_gpio.h). The 20 ms poll in imu_service() covers a missed edge. */
  if (!isr_gpio_attach_rising(PIN_IMU_INT1, imu_isr, nullptr))
    con_println("[imu] INT1 interrupt setup failed: polling every 20 ms only");
  g_pod.imu_ok = ok;
  con_printf("[imu] LSM6DSV16X ok=%d, FREQ_FINE %d -> %.4f us/tick\n", ok, s_freq_fine,
                lsm6dsv16x_ts_us_per_tick(s_freq_fine));
  return ok;
}

void imu_set_decimation(uint8_t n) {
  g_pod.imu_decim = n;
  imu_decim_init(&s_decim, n);
  s_batch.count = 0;
}

void imu_request_dump(int samples) { s_dump_remaining = samples; }

uint32_t imu_overrun_count() { return s_overruns; }

static void flush_batch() {
  if (s_batch.count == 0) return;
  s_batch.t0_pod_us = (uint64_t)s_batch_t0;
  s_batch.acc_g_per_lsb = LSM_ACC_G_PER_LSB_16G;
  s_batch.gyr_dps_per_lsb = LSM_GYR_DPS_PER_LSB_2000;
  s_batch.rate_hz = (uint16_t)(480 / (g_pod.imu_decim ? g_pod.imu_decim : 1));
  s_batch.flags = 0x01; /* times from the IMU hardware timestamp */
  ble_link_send_imu(&s_batch);
  s_batch.count = 0;
}

static void on_output_sample(const imu_sample_t *s) {
  if (s_dump_remaining > 0) {
    s_dump_remaining--;
    con_printf("imu t=%lld us  acc[g] %+.4f %+.4f %+.4f  gyr[dps] %+8.3f %+8.3f %+8.3f\n",
                  (long long)s->pod_us, s->acc[0] * LSM_ACC_G_PER_LSB_16G,
                  s->acc[1] * LSM_ACC_G_PER_LSB_16G, s->acc[2] * LSM_ACC_G_PER_LSB_16G,
                  s->gyr[0] * LSM_GYR_DPS_PER_LSB_2000, s->gyr[1] * LSM_GYR_DPS_PER_LSB_2000,
                  s->gyr[2] * LSM_GYR_DPS_PER_LSB_2000);
  }
  if (!(g_pod.streams & POD_STREAM_IMU) || !ble_link_connected()) {
    s_batch.count = 0;
    return;
  }
  uint8_t cap = pod_imu_samples_per_frame(ble_link_mtu());
  if (cap == 0) return;
  if (s_batch.count == 0) {
    s_batch_t0 = s->pod_us;
    s_batch_started_us = esp_timer_get_time();
  }
  pod_imu_sample_t &o = s_batch.s[s_batch.count++];
  int64_t dt = s->pod_us - s_batch_t0;
  o.dt_us = dt < 0 ? 0 : (uint32_t)dt;
  memcpy(o.acc, s->acc, sizeof o.acc);
  memcpy(o.gyr, s->gyr, sizeof o.gyr);
  if (s_batch.count >= cap) flush_batch();
}

static void on_raw_sample(const imu_raw_sample_t *r, void *) {
  imu_sample_t s;
  if (!clockmap_map(&s_map, r->tick, &s.pod_us)) return;
  memcpy(s.acc, r->acc, sizeof s.acc);
  memcpy(s.gyr, r->gyr, sizeof s.gyr);
  imu_sample_t out;
  if (imu_decim_push(&s_decim, &s, &out)) on_output_sample(&out);
}

void imu_service() {
  if (!g_pod.imu_ok) return;
  int64_t now = esp_timer_get_time();
  bool due = s_int_flag || (now - s_last_service_us) >= (int64_t)kPollIntervalUs;
  if (!due) {
    /* a partially filled BLE batch must not wait forever at low rates */
    if (s_batch.count && now - s_batch_started_us > 100000) flush_batch();
    return;
  }
  s_int_flag = false;
  s_last_service_us = now;

  /* clock pair: TIMESTAMP0..3 bracketed by two esp_timer reads */
  uint8_t ts[4];
  int64_t t0 = esp_timer_get_time();
  if (rd(LSM_REG_TIMESTAMP0, ts, 4)) {
    int64_t t1 = esp_timer_get_time();
    uint32_t raw = (uint32_t)ts[0] | ((uint32_t)ts[1] << 8) | ((uint32_t)ts[2] << 16) |
                   ((uint32_t)ts[3] << 24);
    clockmap_add_pair(&s_map, tick_unwrap(&s_dec.unwrap, raw), (t0 + t1) / 2);
  }

  uint8_t st[2];
  if (!rd(LSM_REG_FIFO_STATUS1, st, 2)) return;
  uint16_t diff = (uint16_t)(st[0] | ((st[1] & LSM_FIFO_ST2_DIFF8) << 8));
  if (st[1] & LSM_FIFO_ST2_OVR_IA) {
    /* continuous mode overwrote old words: slot continuity is lost */
    s_overruns++;
    imu_fifo_dec_resync(&s_dec);
  }
  if (diff > kMaxWordsPerService) diff = kMaxWordsPerService;
  uint8_t w[LSM_FIFO_WORD_LEN];
  for (uint16_t i = 0; i < diff; i++) {
    if (!rd(LSM_REG_FIFO_DATA_OUT_TAG, w, LSM_FIFO_WORD_LEN)) {
      imu_fifo_dec_resync(&s_dec);
      break;
    }
    imu_fifo_dec_word(&s_dec, w, on_raw_sample, nullptr);
  }
}

void imu_print_status() {
  uint8_t regs[2] = {0};
  rd(LSM_REG_FIFO_STATUS1, regs, 2);
  con_printf("imu: %s, 480 Hz, ±16 g / ±2000 dps, decim %u -> %u Hz, INT1 %lu, overruns %lu, "
                "i2c err %lu\n",
                g_pod.imu_ok ? "ok" : "NOT OK", g_pod.imu_decim,
                480u / (g_pod.imu_decim ? g_pod.imu_decim : 1), (unsigned long)s_int_count,
                (unsigned long)s_overruns, (unsigned long)s_i2c_errors);
  con_printf("     fifo words %lu, samples %lu, ts %lu, drop(unanchored %lu, incomplete %lu), "
                "slot skips %lu, fifo level %u, status2 0x%02X\n",
                (unsigned long)s_dec.words, (unsigned long)s_dec.samples,
                (unsigned long)s_dec.timestamps, (unsigned long)s_dec.dropped_unanchored,
                (unsigned long)s_dec.dropped_incomplete, (unsigned long)s_dec.slot_skips,
                (unsigned)(regs[0] | ((regs[1] & 1) << 8)), regs[1]);
  con_printf("     clock map: %.5f us/tick (nominal %.5f), pairs %lu, resets %lu\n",
                s_map.us_per_tick, s_map.nominal_us_per_tick, (unsigned long)s_map.pairs,
                (unsigned long)s_map.resets);
}
