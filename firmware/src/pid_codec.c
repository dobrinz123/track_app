#include "pid_codec.h"

#include <stdio.h>

typedef struct {
  uint8_t pid;
  int byte_count;
} PidEntry;

/* Binding table -- mirrors PID_BY_CHANNEL in
 * packages/core/src/telemetry/pidCodec.ts. Only the channels this dongle
 * serves over the ELM327-subset TCP link (see elm_server_core.c); transOilC
 * has no standard PID and is handled entirely as an app-configured custom
 * (mode 21/22) request, never through this table. */
static const PidEntry PID_TABLE[] = {
    {0x0C, 2}, /* rpm */
    {0x0D, 1}, /* speedKph */
    {0x11, 1}, /* throttlePct */
    {0x05, 1}, /* coolantC */
    {0x0F, 1}, /* intakeC */
    {0x04, 1}, /* engineLoadPct */
    {0x5C, 1}, /* engineOilC */
};
#define PID_TABLE_LEN (sizeof(PID_TABLE) / sizeof(PID_TABLE[0]))

int pid_codec_mode01_byte_count(uint8_t pid) {
  for (size_t i = 0; i < PID_TABLE_LEN; i++) {
    if (PID_TABLE[i].pid == pid) return PID_TABLE[i].byte_count;
  }
  return 0;
}

size_t pid_codec_format_mode01_response(uint8_t pid, const uint8_t *data, size_t data_len,
                                         char *out, size_t out_cap) {
  int expected = pid_codec_mode01_byte_count(pid);
  if (expected <= 0 || (size_t)expected != data_len || out == NULL || out_cap == 0) return 0;

  int written = snprintf(out, out_cap, "41 %02X", pid);
  if (written < 0 || (size_t)written >= out_cap) return 0;
  size_t pos = (size_t)written;

  for (size_t i = 0; i < data_len; i++) {
    int n = snprintf(out + pos, out_cap - pos, " %02X", data[i]);
    if (n < 0 || (size_t)n >= out_cap - pos) return 0;
    pos += (size_t)n;
  }
  return pos;
}
