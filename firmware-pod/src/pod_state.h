#ifndef TRACE_POD_STATE_H
#define TRACE_POD_STATE_H

/* Shared runtime state of the ESP32 firmware (single main loop task; the
 * only cross-task data are the ISR rings in pps.cpp / imu.cpp and the BLE
 * control queue in ble_link.cpp). */

#include <stdint.h>

#include "gnss_config.h"
#include "timebase.h"
#include "ubx.h"
#include "ubx_hp_otp.h"

#define FW_VERSION_MAJOR 0
#define FW_VERSION_MINOR 1
#define FW_VERSION_PATCH 0
#define FW_HW_REV 1 /* rev A */
#define FW_VERSION_STRING "0.1.0"

struct GnssState {
  bool comm_ok = false;        /* receiver answered at GNSS_BAUD_RUN */
  bool init_failed = false;
  uint32_t baud = 0;
  gnss_rate_mode_t rate = GNSS_RATE_10HZ_GPS_GAL;
  bool rate_verified = false; /* receiver readback matched `rate` (review fix MEDIUM 9) */
  hp_state_t hp = HP_STATE_UNKNOWN;
  int64_t last_frame_us = 0;
  int64_t last_pvt_us = 0;
  ubx_nav_pvt_t pvt{};
  bool have_pvt = false;
  ubx_nav_sat_t sat{};
  bool have_sat = false;
  uint32_t pvt_count = 0;
  uint32_t sat_count = 0;
  char mon_sw[31] = {0};
  char mon_hw[11] = {0};
  char mon_ext[6][31] = {{0}};
  uint8_t mon_ext_n = 0;
};

struct PodState {
  GnssState gnss;
  timebase_t tb{};
  bool imu_ok = false;
  bool usb_power = false;
  int vbat_mv = -1;
  bool wifi_on = false;
  uint8_t streams = 0; /* POD_STREAM_* mask, per BLE connection */
  uint8_t imu_decim = 4;
};

extern PodState g_pod;

/* Runs the time-critical background services (PPS drain, IMU FIFO) while a
 * foreground operation waits (GNSS ACK waits, OTP procedure, tx-test). */
void pod_yield();

#endif /* TRACE_POD_STATE_H */
