#ifndef TRACE_POD_ISR_GPIO_H
#define TRACE_POD_ISR_GPIO_H

/*
 * IRAM-safe GPIO interrupts (review fix MEDIUM 7).
 *
 * The installed arduino-esp32 2.0.17 builds without CONFIG_ARDUINO_ISR_IRAM
 * (esp32-hal.h: ARDUINO_ISR_FLAG = 0), so attachInterrupt() installs the
 * GPIO ISR service WITHOUT ESP_INTR_FLAG_IRAM and dispatches through
 * __onPinInterrupt, which the link map places in flash. During flash
 * operations (NVS writes by NimBLE/WiFi) such an interrupt is deferred, and
 * a PPS edge would be timestamped late.
 *
 * Choice: bypass Arduino's attachInterrupt entirely and use the ESP-IDF
 * driver directly: gpio_install_isr_service(ESP_INTR_FLAG_IRAM) +
 * gpio_isr_handler_add(). With the IRAM flag the IDF dispatcher runs with
 * the flash cache disabled, so the handlers and everything they touch must
 * be in IRAM/DRAM: pps_isr / imu_isr are IRAM_ATTR, they touch only static
 * (DRAM) variables and esp_timer_get_time() (IRAM, 0x40379ca0 in the link
 * map). Because an IRAM-flagged service must never get a flash handler,
 * attachInterrupt() must NOT be used anywhere in this firmware (it would
 * register Arduino's flash-resident __onPinInterrupt on the IRAM service).
 * Rebuilding the Arduino core with CONFIG_ARDUINO_ISR_IRAM was rejected: it
 * means a custom core/sdkconfig build for one flag.
 */

#include <stdint.h>

typedef void (*isr_gpio_handler_t)(void *arg);

/* Rising-edge interrupt on an input pin (no pull resistors; the pin is never
 * configured as an output). Returns false on any ESP-IDF error. */
bool isr_gpio_attach_rising(int pin, isr_gpio_handler_t handler, void *arg);

#endif
