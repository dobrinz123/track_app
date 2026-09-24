#ifndef TRACE_POD_LEDS_H
#define TRACE_POD_LEDS_H

/*
 * LED1 yellow (GPIO12) = GNSS / time:
 *   off            no UBX traffic from the receiver
 *   1 Hz blink     receiver alive, no 3D fix
 *   4 Hz blink     fix, PPS timebase not locked
 *   solid          PPS timebase locked
 * LED2 red (GPIO13) = link / faults:
 *   8 Hz blink     fault: GNSS or IMU did not initialise
 *   2 Hz blink     WiFi TX test running
 *   solid          BLE central connected
 *   blip every 2 s advertising
 * BOOT button (GPIO0, read only after boot): a press prints a one-line
 * status and leaves `gnss bridge` mode.
 */

void leds_init();
void leds_service();
/* true once per debounced press of BOOT */
bool boot_button_pressed();

#endif
