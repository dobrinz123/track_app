#ifndef TRACE_POD_WIFI_TEST_H
#define TRACE_POD_WIFI_TEST_H

/*
 * WiFi is OFF in this firmware (the product does not use the MHD adapter,
 * DESIGN.md §3 owner decision 2026-09-24). The ONLY place the radio is
 * started is this bring-up test:
 *
 *   `wifi tx-test <s>`      DESIGN-REV-A §10A test 4: s seconds with WiFi
 *                           off, then s seconds of continuous 802.11b TX at
 *                           the firmware cap (13 dBm, §10.3 mitigation 1),
 *                           NAV-SAT C/N0 compared; PASS if the median C/N0 of
 *                           the 8 strongest SVs drops <= 2 dB and the used-SV
 *                           count does not drop.
 *   `wifi tx-test <s> max`  the same at the S3's maximum (20 dBm) -- the load
 *                           for §10A test 2 (3V3 during WiFi TX bursts, scope).
 * WiFi is stopped again at the end.
 */

void wifi_test_start(int seconds, bool max_power);
void wifi_test_service();
bool wifi_test_active();

#endif
