#include "bridge_filter.h"

#include <string.h>

void bf_init(bridge_filter_t *f) { memset(f, 0, sizeof(*f)); }

bool bf_frame_blocked(uint8_t cls, uint8_t id, const uint8_t *payload, uint16_t len) {
  if (cls == 0x06 && id == 0x41) return true; /* OTP write (IM §2.1.5 Table 3) */
  if (cls == UBX_CLS_CFG && id == UBX_ID_CFG_VALSET) {
    if (len < 2) return true;                    /* malformed VALSET */
    if (payload[1] & (uint8_t)~0x07u) return true; /* undocumented layer bits */
  }
  for (uint16_t i = 0; i + 3 < len; i++)
    if (payload[i] == 0xB5 && payload[i + 1] == 0x62 && payload[i + 2] == 0x06 &&
        payload[i + 3] == 0x41)
      return true;
  return false;
}

/* Emit bytes that are outside any candidate: everything except 0xB5. */
static void emit_plain(bridge_filter_t *f, const uint8_t *p, size_t n, bf_out_cb out, void *ctx) {
  size_t i = 0;
  while (i < n) {
    size_t j = i;
    while (j < n && p[j] != UBX_SYNC1) j++;
    if (j > i) {
      out(p + i, j - i, ctx);
      f->bytes_forwarded += (uint32_t)(j - i);
    }
    i = j;
    if (i < n) { /* never reached for candidates: callers split at 0xB5 */
      f->stray_b5_dropped++;
      i++;
    }
  }
}

/* Candidate at buf[0] failed: drop its 0xB5, forward the plain bytes up to
 * the next 0xB5, keep the rest buffered for re-scanning. */
static void fail_candidate(bridge_filter_t *f, bf_out_cb out, void *ctx) {
  f->invalid_dropped++;
  size_t i = 1;
  while (i < f->len && f->buf[i] != UBX_SYNC1) i++;
  if (i > 1) {
    out(f->buf + 1, i - 1, ctx);
    f->bytes_forwarded += (uint32_t)(i - 1);
  }
  memmove(f->buf, f->buf + i, f->len - i);
  f->len -= i;
}

static void process(bridge_filter_t *f, bf_out_cb out, void *ctx) {
  for (;;) {
    if (f->len == 0) return;
    if (f->len >= 2 && f->buf[1] != UBX_SYNC2) {
      fail_candidate(f, out, ctx);
      continue;
    }
    if (f->len < UBX_HEADER_LEN) return;
    uint16_t plen = ubx_u2(f->buf + 4);
    if (plen > UBX_MAX_PAYLOAD) {
      fail_candidate(f, out, ctx);
      continue;
    }
    size_t total = (size_t)plen + UBX_OVERHEAD;
    if (f->len < total) return;
    if (!ubx_frame_is_valid(f->buf, total)) {
      fail_candidate(f, out, ctx);
      continue;
    }
    if (bf_frame_blocked(f->buf[2], f->buf[3], f->buf + UBX_HEADER_LEN, plen)) {
      f->frames_blocked++;
      f->last_blocked_cls = f->buf[2];
      f->last_blocked_id = f->buf[3];
    } else {
      out(f->buf, total, ctx);
      f->frames_forwarded++;
      f->bytes_forwarded += (uint32_t)total;
    }
    memmove(f->buf, f->buf + total, f->len - total);
    f->len -= total;
    /* whatever follows may not be a candidate: forward plain bytes */
    if (f->len && f->buf[0] != UBX_SYNC1) {
      size_t i = 0;
      while (i < f->len && f->buf[i] != UBX_SYNC1) i++;
      out(f->buf, i, ctx);
      f->bytes_forwarded += (uint32_t)i;
      memmove(f->buf, f->buf + i, f->len - i);
      f->len -= i;
    }
  }
}

void bf_push(bridge_filter_t *f, const uint8_t *data, size_t n, bf_out_cb out, void *ctx) {
  size_t k = 0;
  while (k < n) {
    if (f->len == 0) {
      /* fast path: forward the plain run up to the next 0xB5 */
      size_t j = k;
      while (j < n && data[j] != UBX_SYNC1) j++;
      if (j > k) emit_plain(f, data + k, j - k, out, ctx);
      k = j;
      if (k >= n) return;
    }
    /* invariant (process): len < total frame size <= sizeof(buf) */
    f->buf[f->len++] = data[k++];
    process(f, out, ctx);
  }
}
