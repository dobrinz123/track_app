#include "ubx.h"

#include <string.h>

/* See ubx.h for the source of every constant ([IFD] = UBX-21035062 R03). */

uint16_t ubx_u2(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }

uint32_t ubx_u4(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

int32_t ubx_i4(const uint8_t *p) { return (int32_t)ubx_u4(p); }

void ubx_checksum(const uint8_t *data, size_t len, uint8_t *ck_a, uint8_t *ck_b) {
  /* [IFD] 3.4: CK_A = CK_A + Buffer[I]; CK_B = CK_B + CK_A, both 8-bit. */
  uint8_t a = 0, b = 0;
  for (size_t i = 0; i < len; i++) {
    a = (uint8_t)(a + data[i]);
    b = (uint8_t)(b + a);
  }
  *ck_a = a;
  *ck_b = b;
}

size_t ubx_build(uint8_t cls, uint8_t id, const uint8_t *payload, uint16_t len, uint8_t *out,
                 size_t cap) {
  size_t total = (size_t)len + UBX_OVERHEAD;
  if (len > UBX_MAX_PAYLOAD || cap < total) return 0;
  out[0] = UBX_SYNC1;
  out[1] = UBX_SYNC2;
  out[2] = cls;
  out[3] = id;
  out[4] = (uint8_t)(len & 0xFF);
  out[5] = (uint8_t)(len >> 8);
  if (len) memcpy(out + UBX_HEADER_LEN, payload, len);
  ubx_checksum(out + 2, 4u + len, &out[6 + len], &out[7 + len]);
  return total;
}

bool ubx_frame_is_valid(const uint8_t *buf, size_t len) {
  if (len < UBX_OVERHEAD || buf[0] != UBX_SYNC1 || buf[1] != UBX_SYNC2) return false;
  uint16_t plen = ubx_u2(buf + 4);
  if ((size_t)plen + UBX_OVERHEAD != len) return false;
  uint8_t a, b;
  ubx_checksum(buf + 2, 4u + plen, &a, &b);
  return a == buf[6 + plen] && b == buf[7 + plen];
}

/* ------------------------------------------------------------ parser */

void ubx_parser_init(ubx_parser_t *p) { memset(p, 0, sizeof(*p)); }

/* Drop buf[0] (a failed frame start) and move to the next 0xB5 candidate. */
static void resync(ubx_parser_t *p) {
  size_t i = 1;
  while (i < p->len && p->buf[i] != UBX_SYNC1) i++;
  p->skipped_bytes += (uint32_t)i;
  memmove(p->buf, p->buf + i, p->len - i);
  p->len -= i;
}

/* Process whatever is buffered: emit complete frames, resync on errors, stop
 * when more bytes are needed. buf always starts with 0xB5 when len > 0. */
static void process(ubx_parser_t *p, ubx_frame_cb cb, void *ctx) {
  for (;;) {
    if (p->len == 0) return;
    if (p->len >= 2 && p->buf[1] != UBX_SYNC2) {
      p->sync_errors++;
      resync(p);
      continue;
    }
    if (p->len < UBX_HEADER_LEN) return;
    uint16_t plen = ubx_u2(p->buf + 4);
    if (plen > UBX_MAX_PAYLOAD) {
      p->oversize_errors++;
      resync(p);
      continue;
    }
    size_t total = (size_t)plen + UBX_OVERHEAD;
    if (p->len < total) return;
    uint8_t a, b;
    ubx_checksum(p->buf + 2, 4u + plen, &a, &b);
    if (a != p->buf[6 + plen] || b != p->buf[7 + plen]) {
      p->checksum_errors++;
      resync(p);
      continue;
    }
    p->frames_ok++;
    if (cb) {
      ubx_frame_t f;
      f.cls = p->buf[2];
      f.id = p->buf[3];
      f.len = plen;
      f.payload = p->buf + UBX_HEADER_LEN;
      cb(&f, ctx);
    }
    memmove(p->buf, p->buf + total, p->len - total);
    p->len -= total;
    /* leftover bytes (only possible after a resync) may not start with 0xB5 */
    if (p->len && p->buf[0] != UBX_SYNC1) {
      size_t i = 0;
      while (i < p->len && p->buf[i] != UBX_SYNC1) i++;
      p->skipped_bytes += (uint32_t)i;
      memmove(p->buf, p->buf + i, p->len - i);
      p->len -= i;
    }
  }
}

void ubx_parser_push(ubx_parser_t *p, const uint8_t *data, size_t n, ubx_frame_cb cb, void *ctx) {
  for (size_t k = 0; k < n; k++) {
    uint8_t byte = data[k];
    if (p->len == 0 && byte != UBX_SYNC1) {
      p->skipped_bytes++;
      continue;
    }
    /* process() guarantees len < total frame size <= sizeof(buf) here */
    p->buf[p->len++] = byte;
    process(p, cb, ctx);
  }
}

/* ---------------------------------------------------------- VALSET/GET */

size_t ubx_cfg_key_value_size(uint32_t key) {
  switch ((key >> 28) & 0x7u) { /* [IFD] 4.2: bits 30..28 */
    case 0x1: return 1;         /* one bit, stored as one byte */
    case 0x2: return 1;
    case 0x3: return 2;
    case 0x4: return 4;
    case 0x5: return 8;
    default: return 0;
  }
}

void ubx_valset_init(ubx_valset_t *v, uint8_t layers) {
  memset(v, 0, sizeof(*v));
  v->payload[0] = 0x00; /* version 0: transactionless ([IFD] 3.10.5.1) */
  v->payload[1] = layers;
  v->payload[2] = 0; /* reserved0[2] */
  v->payload[3] = 0;
  v->len = 4;
}

void ubx_valset_add(ubx_valset_t *v, uint32_t key, uint64_t value) {
  size_t vs = ubx_cfg_key_value_size(key);
  if (vs == 0 || v->nkeys >= UBX_VALSET_MAX_KEYS || v->len + 4 + vs > sizeof(v->payload)) {
    v->error = true;
    return;
  }
  if (vs < 8 && (value >> (8 * vs)) != 0) {
    v->error = true; /* value does not fit the key's storage size */
    return;
  }
  uint8_t *p = v->payload + v->len;
  for (int i = 0; i < 4; i++) p[i] = (uint8_t)(key >> (8 * i));
  for (size_t i = 0; i < vs; i++) p[4 + i] = (uint8_t)(value >> (8 * i));
  v->len = (uint16_t)(v->len + 4 + vs);
  v->nkeys++;
}

size_t ubx_valset_frame(const ubx_valset_t *v, uint8_t *out, size_t cap) {
  if (v->error || v->nkeys == 0) return 0;
  return ubx_build(UBX_CLS_CFG, UBX_ID_CFG_VALSET, v->payload, v->len, out, cap);
}

size_t ubx_valget_poll_frame(uint8_t layer, const uint32_t *keys, size_t nkeys, uint8_t *out,
                             size_t cap) {
  uint8_t payload[4 + 64 * 4];
  if (nkeys == 0 || nkeys > 64) return 0; /* [IFD] 3.10.4.1: max 64 keys */
  payload[0] = 0x00;                      /* version 0 */
  payload[1] = layer;
  payload[2] = 0; /* position U2 = 0 */
  payload[3] = 0;
  for (size_t i = 0; i < nkeys; i++)
    for (int b = 0; b < 4; b++) payload[4 + i * 4 + b] = (uint8_t)(keys[i] >> (8 * b));
  return ubx_build(UBX_CLS_CFG, UBX_ID_CFG_VALGET, payload, (uint16_t)(4 + nkeys * 4), out, cap);
}

bool ubx_valget_find(const uint8_t *payload, uint16_t len, uint32_t key, uint64_t *value) {
  if (len < 4) return false;
  size_t off = 4;
  while (off + 4 <= len) {
    uint32_t k = ubx_u4(payload + off);
    size_t vs = ubx_cfg_key_value_size(k);
    if (vs == 0 || off + 4 + vs > len) return false; /* malformed */
    if (k == key) {
      uint64_t v = 0;
      for (size_t i = 0; i < vs; i++) v |= (uint64_t)payload[off + 4 + i] << (8 * i);
      *value = v;
      return true;
    }
    off += 4 + vs;
  }
  return false;
}

size_t ubx_cfg_rst_frame(uint16_t nav_bbr_mask, uint8_t reset_mode, uint8_t *out, size_t cap) {
  uint8_t payload[4];
  payload[0] = (uint8_t)(nav_bbr_mask & 0xFF);
  payload[1] = (uint8_t)(nav_bbr_mask >> 8);
  payload[2] = reset_mode;
  payload[3] = 0; /* reserved0 */
  return ubx_build(UBX_CLS_CFG, UBX_ID_CFG_RST, payload, 4, out, cap);
}

/* ------------------------------------------------------------ decoders */

bool ubx_decode_nav_pvt(const uint8_t *p, uint16_t len, ubx_nav_pvt_t *o) {
  if (len != UBX_NAV_PVT_LEN) return false;
  o->itow_ms = ubx_u4(p + 0);
  o->year = ubx_u2(p + 4);
  o->month = p[6];
  o->day = p[7];
  o->hour = p[8];
  o->min = p[9];
  o->sec = p[10];
  o->valid = p[11];
  o->t_acc_ns = ubx_u4(p + 12);
  o->nano = ubx_i4(p + 16);
  o->fix_type = p[20];
  o->flags = p[21];
  o->flags2 = p[22];
  o->num_sv = p[23];
  o->lon_e7 = ubx_i4(p + 24);
  o->lat_e7 = ubx_i4(p + 28);
  o->height_mm = ubx_i4(p + 32);
  o->hmsl_mm = ubx_i4(p + 36);
  o->h_acc_mm = ubx_u4(p + 40);
  o->v_acc_mm = ubx_u4(p + 44);
  o->vel_n_mm_s = ubx_i4(p + 48);
  o->vel_e_mm_s = ubx_i4(p + 52);
  o->vel_d_mm_s = ubx_i4(p + 56);
  o->g_speed_mm_s = ubx_i4(p + 60);
  o->head_mot_e5 = ubx_i4(p + 64);
  o->s_acc_mm_s = ubx_u4(p + 68);
  o->head_acc_e5 = ubx_u4(p + 72);
  o->p_dop_e2 = ubx_u2(p + 76);
  o->flags3 = ubx_u2(p + 78);
  return true;
}

bool ubx_decode_nav_sat(const uint8_t *p, uint16_t len, ubx_nav_sat_t *o) {
  if (len < 8) return false;
  uint8_t n = p[5];
  if ((size_t)len != 8u + (size_t)n * 12u) return false;
  o->itow_ms = ubx_u4(p);
  o->num_svs = n > UBX_NAV_SAT_MAX_SV ? UBX_NAV_SAT_MAX_SV : n;
  for (uint8_t i = 0; i < o->num_svs; i++) {
    const uint8_t *s = p + 8 + i * 12;
    uint32_t flags = ubx_u4(s + 8);
    o->sats[i].gnss_id = s[0];
    o->sats[i].sv_id = s[1];
    o->sats[i].cno_dbhz = s[2];
    o->sats[i].elev_deg = (int8_t)s[3];
    o->sats[i].quality = (uint8_t)(flags & 0x7u);
    o->sats[i].used = (flags & 0x8u) != 0;
  }
  return true;
}

bool ubx_decode_ack(const ubx_frame_t *f, bool *is_ack, uint8_t *ack_cls, uint8_t *ack_id) {
  if (f->cls != UBX_CLS_ACK || f->len != 2) return false;
  if (f->id != UBX_ID_ACK_ACK && f->id != UBX_ID_ACK_NAK) return false;
  *is_ack = f->id == UBX_ID_ACK_ACK;
  *ack_cls = f->payload[0];
  *ack_id = f->payload[1];
  return true;
}
