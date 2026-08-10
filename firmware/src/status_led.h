#ifndef TRACE_STATUS_LED_H
#define TRACE_STATUS_LED_H

// EXPECTED OUTCOME 2e: IO8 status LED.
//   AP up, no client  -> slow blink
//   client connected  -> solid on
//   CAN error         -> fast blink
enum class LedState { kApNoClient, kClientConnected, kCanError };

void status_led_init();
void status_led_set_state(LedState state);
// Non-blocking; call every loop() iteration.
void status_led_update();

#endif // TRACE_STATUS_LED_H
