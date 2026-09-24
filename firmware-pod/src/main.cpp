/*
 * TRACE GNSS Pod rev A firmware -- ESP32 wiring.
 * Design: hardware/gnss-pod/DESIGN-REV-A.md (binding). Protocol: PROTOCOL.md.
 *
 * Single Arduino loop task (core 1): PPS drain, GNSS UART, IMU FIFO, BLE
 * control/status, console, WiFi test, power, LEDs. Blocking GNSS waits call
 * pod_yield() so PPS and the IMU FIFO keep being serviced. (The PPS-to-UTC
 * association does not depend on this order, see timebase.h.)
 */
#include <Arduino.h>

#include "console_io.h"

#include "ble_link.h"
#include "console.h"
#include "gnss.h"
#include "imu.h"
#include "leds.h"
#include "pod_state.h"
#include "power.h"
#include "pps.h"
#include "wifi_test.h"

PodState g_pod;

/* Called from every blocking wait (GNSS ACK/readback, OTP procedure): keeps
 * PPS, IMU FIFO, LEDs and the WiFi-test deadlines serviced (review fix
 * MEDIUM 10). Console, BOOT and BLE controls are NOT re-entered here; they
 * resume in loop(), which executes at most one BLE control per pass. */
void pod_yield() {
  pps_service();
  imu_service();
  wifi_test_service(); /* has its own reentrancy guard */
  leds_service();
}

void setup() {
  /* DESIGN-REV-A §6 (binding): CHG_EN low before anything else. */
  power_early_init();
  leds_init();
  console_init();
  delay(300); /* give a host a moment to open the CDC port; logs are not buffered */
  con_printf("\nTRACE GNSS Pod rev A, firmware %s (%s %s)\n", FW_VERSION_STRING, __DATE__,
                __TIME__);
  con_println("WiFi is OFF (only `wifi tx-test` starts it). Type `help`.");
  tb_init(&g_pod.tb);
  power_init();
  pps_init();
  imu_init();
  gnss_init();
  ble_link_init();
  console_print_status();
  con_print("> ");
}

void loop() {
  pps_service();
  gnss_service();
  imu_service();
  ble_link_service();
  console_service();
  wifi_test_service();
  power_service();
  leds_service();
  gnss_tick();
  if (boot_button_pressed()) {
    if (gnss_bridge_active())
      gnss_bridge_stop();
    else
      console_print_status();
  }
  delay(1); /* feed the idle task; the loop still runs at ~1 kHz */
}
