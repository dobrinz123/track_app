#include "console_io.h"

#include <Arduino.h>
#include <stdarg.h>
#include <string.h>

static uint32_t s_drop_msgs = 0;
static uint32_t s_drop_bytes = 0;

void con_begin() {
  Serial.setTxBufferSize(CON_TX_RING); /* recreates the TX ring (HWCDC.cpp setTxBufferSize) */
  Serial.begin(115200);
  Serial.setTxTimeoutMs(CON_TX_TIMEOUT_MS);
}

size_t con_write(const uint8_t *p, size_t n) {
  if (n == 0) return 0;
  int room = Serial.availableForWrite();
  if (room < 0 || (size_t)room < n) {
    s_drop_msgs++;
    s_drop_bytes += (uint32_t)n;
    return 0;
  }
  return Serial.write(p, n);
}

void con_printf(const char *fmt, ...) {
  char buf[CON_MSG_MAX];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  size_t len = (size_t)n < sizeof buf ? (size_t)n : sizeof buf - 1;
  con_write((const uint8_t *)buf, len);
}

void con_print(const char *s) { con_write((const uint8_t *)s, strlen(s)); }

void con_println(const char *s) {
  char buf[CON_MSG_MAX];
  size_t n = strlen(s);
  if (n > sizeof buf - 3) n = sizeof buf - 3;
  memcpy(buf, s, n);
  buf[n++] = '\r';
  buf[n++] = '\n';
  con_write((const uint8_t *)buf, n);
}

uint32_t con_dropped_msgs() { return s_drop_msgs; }
uint32_t con_dropped_bytes() { return s_drop_bytes; }
