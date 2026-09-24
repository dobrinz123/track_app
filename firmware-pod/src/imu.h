#ifndef TRACE_POD_IMU_H
#define TRACE_POD_IMU_H

#include <stdint.h>

/* LSM6DSV16X on I2C (GPIO9 SDA / GPIO10 SCL, 0x6A), INT1 on GPIO8.
 * ±16 g, ±2000 dps, 480 Hz accel + gyro, FIFO continuous mode with a
 * hardware timestamp every 8th time slot, FIFO-threshold + overrun routed to
 * INT1 (INT2 is not connected on rev A). */
bool imu_init();
void imu_service();
void imu_set_decimation(uint8_t n); /* 1, 2, 4, 8 */
void imu_request_dump(int samples); /* prints n decoded samples */
void imu_print_status();
uint32_t imu_overrun_count();

#endif
