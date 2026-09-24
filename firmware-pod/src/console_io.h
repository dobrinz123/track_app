#ifndef TRACE_POD_CON_H
#define TRACE_POD_CON_H

/*
 * Non-blocking USB-CDC output (review fix HIGH 3).
 *
 * Installed arduino-esp32 2.0.17 cores/esp32/HWCDC.cpp (read 2026-09-24):
 *  - HWCDC::write(buf, n) first pushes min(n, free ring space) with a zero
 *    timeout (non-blocking), then, only if bytes remain, loops
 *    "while (connected && to_send)" with `uint32_t tries = tx_timeout_ms`,
 *    decrementing tries (and delay(1)) on every pass without progress and
 *    giving up at tries == 0. With tx_timeout_ms = 0 the first decrement
 *    wraps tries to UINT32_MAX, so a host that is connected but not draining
 *    traps the caller for ~49 days (Codex POD-FW REV1 HIGH 3 confirmed).
 *  - HWCDC::availableForWrite() returns xRingbufferGetCurFreeSize() of the
 *    TX ring (after taking tx_lock with the tx timeout).
 * Therefore:
 *  - every console write goes through con_write(), which writes a message
 *    ONLY if availableForWrite() >= its length, so HWCDC::write always
 *    completes in its non-blocking first step and never enters the retry
 *    loop; otherwise the message is dropped whole and counted;
 *  - the TX timeout is set to a small non-zero value (CON_TX_TIMEOUT_MS) as
 *    a backstop (it also bounds the tx_lock wait), never 0;
 *  - the TX ring is enlarged to CON_TX_RING bytes so normal bursts fit;
 *  - HWCDC::flush() (a draining wait) is only used right before a restart.
 */

#include <stddef.h>
#include <stdint.h>

#define CON_TX_TIMEOUT_MS 5
#define CON_TX_RING 4096
#define CON_MSG_MAX 256

void con_begin();
/* Whole message or nothing; returns bytes written (0 = dropped). */
size_t con_write(const uint8_t *p, size_t n);
void con_printf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void con_print(const char *s);
void con_println(const char *s = "");
uint32_t con_dropped_msgs();
uint32_t con_dropped_bytes();

#endif
