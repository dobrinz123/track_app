#include "gnss_tx_guard.h"

#include <string.h>

void txg_init(txg_t *g) { memset(g, 0, sizeof(*g)); }

static void push(txg_t *g, uint8_t b) {
  if (g->nlast < 3) {
    g->last[g->nlast++] = b;
  } else {
    g->last[0] = g->last[1];
    g->last[1] = g->last[2];
    g->last[2] = b;
  }
}

size_t txg_allow(txg_t *g, const uint8_t *in, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (in[i] == 0x41 && g->nlast == 3 && g->last[0] == 0xB5 && g->last[1] == 0x62 &&
        g->last[2] == 0x06) {
      g->refused_chunks++;
      g->refused_bytes += (uint32_t)(n - i);
      return i;
    }
    push(g, in[i]);
  }
  return n;
}

void txg_note_raw(txg_t *g, const uint8_t *in, size_t n) {
  for (size_t i = 0; i < n; i++) push(g, in[i]);
}
