#ifndef TRACE_POD_BOARD_PINS_H
#define TRACE_POD_BOARD_PINS_H

/*
 * TRACE GNSS Pod rev A pin map. Every number below is from
 * hardware/gnss-pod/DESIGN-REV-A.md §4 (netlist) and §6 (GPIO assignment and
 * binding firmware rules). Change nothing here without changing the design.
 */

/* §6: "Never configure GPIO21 as an output." SAM-M10Q TIMEPULSE, which is
 * internally tied to SAFEBOOT_N through 1 kΩ: driving it low at GNSS
 * power-up would put the receiver into safeboot. INPUT ONLY, no pulls. */
#define PIN_PPS 21

/* §6: UART1 on GPIO38 (MCU TX -> GNSS RXD) / GPIO39 (GNSS TXD -> MCU RX). */
#define PIN_GNSS_UART_TX 38
#define PIN_GNSS_UART_RX 39

/* §6: "Drive GPIO40 only as open-drain low for >= 1 ms to reset the GNSS,
 * and remember that reset clears BBR." */
#define PIN_GNSS_RESET_N 40
/* GNSS EXTINT: output-capable, unused on rev A (OBD time-marking is phase 2).
 * Left untouched (reset state = input); the GNSS pull-up keeps it inactive. */
#define PIN_GNSS_EXTINT 41

/* §6 (review fix wave): IMU I2C on GPIO9 (SDA) / GPIO10 (SCL), INT1 on
 * GPIO8; INT2 is NOT connected, so every interrupt source goes to INT1. */
#define PIN_I2C_SDA 9
#define PIN_I2C_SCL 10
#define PIN_IMU_INT1 8
#define I2C_FREQ_HZ 400000 /* 400 kHz Fast-mode, R7/R8 4.7 kΩ pull-ups (§3) */

/* §6 (binding, review rev3): GPIO37 = CHG_EN -> Q1 gate. Rev A: LOW AT ALL
 * TIMES (no cell, charging never enabled). R19 holds it low when undriven. */
#define PIN_CHG_EN 37

/* §4: PGOOD_N from the BQ24073 (open-drain, R12 100 kΩ to 3V3).
 * LOW = valid USB input present. */
#define PIN_PGOOD_N 2

/* §2 / §6: VBAT_SENSE on GPIO1 = ADC1_CH0, 1 MΩ/1 MΩ divider; ADC1 only,
 * ATTEN3 (11 dB, 0-2900 mV). On rev A (J2 not fitted) it reads ~0 V. */
#define PIN_VBAT_SENSE 1

/* §3 / §4: LED1 yellow on GPIO12, LED2 red on GPIO13 (active high, 1 kΩ). */
#define PIN_LED_YELLOW 12
#define PIN_LED_RED 13

/* §4: SW1 BOOT on GPIO0 (strap, R6 10 kΩ pull-up, button to GND). Read as a
 * plain input only after boot; never driven, never given a capacitor-like
 * load (§4 "no capacitor on IO0"). Holding it during reset/power-up selects
 * the ROM download mode, which is its intended strap use. */
#define PIN_BOOT_BUTTON 0

/* Strapping pins GPIO3 / GPIO45 / GPIO46 are NC and never touched (§6). */

#endif /* TRACE_POD_BOARD_PINS_H */
