#include "pod_protocol.h"

#include <string.h>

/* ---------------------------------------------------------------- CRC */

uint16_t pod_crc16(const uint8_t *data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (int b = 0; b < 8; b++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

/* ---------------------------------------------------------- LE writer */

typedef struct {
  uint8_t *p;
  size_t len, cap;
  bool err;
} wr_t;

static void w_bytes(wr_t *w, const void *src, size_t n) {
  if (w->len + n > w->cap) {
    w->err = true;
    return;
  }
  memcpy(w->p + w->len, src, n);
  w->len += n;
}
static void w_u8(wr_t *w, uint8_t v) { w_bytes(w, &v, 1); }
static void w_u16(wr_t *w, uint16_t v) {
  uint8_t b[2] = {(uint8_t)v, (uint8_t)(v >> 8)};
  w_bytes(w, b, 2);
}
static void w_u32(wr_t *w, uint32_t v) {
  uint8_t b[4];
  for (int i = 0; i < 4; i++) b[i] = (uint8_t)(v >> (8 * i));
  w_bytes(w, b, 4);
}
static void w_u64(wr_t *w, uint64_t v) {
  uint8_t b[8];
  for (int i = 0; i < 8; i++) b[i] = (uint8_t)(v >> (8 * i));
  w_bytes(w, b, 8);
}
static void w_f32(wr_t *w, float f) {
  uint32_t u;
  memcpy(&u, &f, 4); /* IEEE-754 binary32 on both ESP32 and hosts */
  w_u32(w, u);
}

/* ---------------------------------------------------------- LE reader */

typedef struct {
  const uint8_t *p;
  size_t len, off;
} rd_t;
static uint8_t r_u8(rd_t *r) { return r->p[r->off++]; }
static uint16_t r_u16(rd_t *r) {
  uint16_t v = (uint16_t)(r->p[r->off] | (r->p[r->off + 1] << 8));
  r->off += 2;
  return v;
}
static uint32_t r_u32(rd_t *r) {
  uint32_t v = 0;
  for (int i = 0; i < 4; i++) v |= (uint32_t)r->p[r->off + i] << (8 * i);
  r->off += 4;
  return v;
}
static uint64_t r_u64(rd_t *r) {
  uint64_t v = 0;
  for (int i = 0; i < 8; i++) v |= (uint64_t)r->p[r->off + i] << (8 * i);
  r->off += 8;
  return v;
}
static float r_f32(rd_t *r) {
  uint32_t u = r_u32(r);
  float f;
  memcpy(&f, &u, 4);
  return f;
}

/* ---------------------------------------------------------- framing */

static void begin(wr_t *w, uint8_t *out, size_t cap, uint8_t type, uint16_t seq) {
  w->p = out;
  w->cap = cap;
  w->len = 0;
  w->err = false;
  w_u8(w, POD_PROTO_VERSION);
  w_u8(w, type);
  w_u16(w, seq);
  w_u16(w, 0); /* length, patched in finish() */
}

static size_t finish(wr_t *w) {
  if (w->err || w->len < POD_HDR_LEN) return 0;
  size_t plen = w->len - POD_HDR_LEN;
  if (plen > 0xFFFF) return 0;
  w->p[4] = (uint8_t)plen;
  w->p[5] = (uint8_t)(plen >> 8);
  uint16_t crc = pod_crc16(w->p, w->len);
  w_u16(w, crc);
  return w->err ? 0 : w->len;
}

size_t pod_encode_gnss(uint16_t seq, const pod_gnss_t *g, uint8_t *out, size_t cap) {
  wr_t w;
  begin(&w, out, cap, POD_TYPE_GNSS, seq);
  w_u64(&w, g->pod_us);           /* 0 */
  w_u64(&w, (uint64_t)g->unix_us); /* 8 */
  w_u32(&w, g->itow_ms);          /* 16 */
  w_u32(&w, (uint32_t)g->lat_e7); /* 20 */
  w_u32(&w, (uint32_t)g->lon_e7); /* 24 */
  w_u32(&w, (uint32_t)g->hmsl_mm);      /* 28 */
  w_u32(&w, (uint32_t)g->vel_n_mm_s);   /* 32 */
  w_u32(&w, (uint32_t)g->vel_e_mm_s);   /* 36 */
  w_u32(&w, (uint32_t)g->vel_d_mm_s);   /* 40 */
  w_u32(&w, (uint32_t)g->g_speed_mm_s); /* 44 */
  w_u32(&w, (uint32_t)g->head_mot_e5);  /* 48 */
  w_u32(&w, g->h_acc_mm);         /* 52 */
  w_u32(&w, g->v_acc_mm);         /* 56 */
  w_u32(&w, g->s_acc_mm_s);       /* 60 */
  w_u32(&w, g->head_acc_e5);      /* 64 */
  w_u32(&w, g->t_acc_ns);         /* 68 */
  w_u16(&w, g->p_dop_e2);         /* 72 */
  w_u8(&w, g->fix_type);          /* 74 */
  w_u8(&w, g->num_sv);            /* 75 */
  w_u8(&w, g->flags);             /* 76 */
  w_u8(&w, g->rate_hz);           /* 77 */
  return finish(&w);
}

uint8_t pod_imu_samples_per_frame(uint16_t att_mtu) {
  if (att_mtu < 3 + POD_OVERHEAD + POD_IMU_HDR_LEN + POD_IMU_SAMPLE_LEN) return 0;
  size_t n = (size_t)(att_mtu - 3 - POD_OVERHEAD - POD_IMU_HDR_LEN) / POD_IMU_SAMPLE_LEN;
  return (uint8_t)(n > POD_IMU_MAX_SAMPLES ? POD_IMU_MAX_SAMPLES : n);
}

size_t pod_encode_imu(uint16_t seq, const pod_imu_batch_t *b, uint8_t *out, size_t cap) {
  if (b->count == 0 || b->count > POD_IMU_MAX_SAMPLES) return 0;
  wr_t w;
  begin(&w, out, cap, POD_TYPE_IMU, seq);
  w_u64(&w, b->t0_pod_us);      /* 0 */
  w_f32(&w, b->acc_g_per_lsb);  /* 8 */
  w_f32(&w, b->gyr_dps_per_lsb); /* 12 */
  w_u16(&w, b->rate_hz);        /* 16 */
  w_u8(&w, b->count);           /* 18 */
  w_u8(&w, b->flags);           /* 19 */
  for (uint8_t i = 0; i < b->count; i++) { /* 20 + 16*i */
    w_u32(&w, b->s[i].dt_us);
    for (int k = 0; k < 3; k++) w_u16(&w, (uint16_t)b->s[i].acc[k]);
    for (int k = 0; k < 3; k++) w_u16(&w, (uint16_t)b->s[i].gyr[k]);
  }
  return finish(&w);
}

size_t pod_encode_status(uint16_t seq, const pod_status_t *s, uint8_t *out, size_t cap) {
  wr_t w;
  begin(&w, out, cap, POD_TYPE_STATUS, seq);
  w_u64(&w, s->pod_us);     /* 0 */
  w_u8(&w, s->fw_major);    /* 8 */
  w_u8(&w, s->fw_minor);    /* 9 */
  w_u8(&w, s->fw_patch);    /* 10 */
  w_u8(&w, s->hw_rev);      /* 11 */
  w_u8(&w, s->rate_hz);     /* 12 */
  w_u8(&w, s->hp_state);    /* 13 */
  w_u8(&w, s->pps_state);   /* 14 */
  w_u8(&w, s->flags);       /* 15 */
  w_u64(&w, s->tb_anchor_pod_us);            /* 16 */
  w_u64(&w, (uint64_t)s->tb_anchor_unix_us); /* 24 */
  w_u32(&w, (uint32_t)s->tb_rate_ppb);       /* 32 */
  w_u32(&w, s->pps_age_ms); /* 36 */
  w_u8(&w, s->fix_type);    /* 40 */
  w_u8(&w, s->num_sv);      /* 41 */
  w_u8(&w, s->imu_decim);   /* 42 */
  w_u8(&w, s->reserved);    /* 43 */
  w_u32(&w, s->tx_drops);   /* 44 */
  w_u32(&w, s->imu_overruns); /* 48 */
  w_u32(&w, s->ubx_errors); /* 52 */
  return finish(&w);
}

size_t pod_encode_control_result(uint16_t seq, const pod_control_result_t *r, uint8_t *out,
                                 size_t cap) {
  wr_t w;
  begin(&w, out, cap, POD_TYPE_CONTROL_RESULT, seq);
  w_u8(&w, r->opcode);
  w_u8(&w, r->result);
  w_u16(&w, r->echo_seq);
  return finish(&w);
}

size_t pod_encode_control(const pod_control_t *c, uint8_t *out, size_t cap) {
  if (c->arg_len > sizeof(c->args)) return 0;
  wr_t w;
  begin(&w, out, cap, POD_TYPE_CONTROL, c->seq);
  w_u8(&w, c->opcode);
  w_bytes(&w, c->args, c->arg_len);
  return finish(&w);
}

/* ---------------------------------------------------------- decoding */

pod_dec_result_t pod_decode_frame(const uint8_t *buf, size_t len, pod_frame_t *f) {
  if (len < POD_OVERHEAD) return POD_DEC_SHORT;
  if (buf[0] != POD_PROTO_VERSION) return POD_DEC_BAD_VERSION;
  uint16_t plen = (uint16_t)(buf[4] | (buf[5] << 8));
  if ((size_t)plen + POD_OVERHEAD != len) return POD_DEC_SHORT;
  uint16_t crc = (uint16_t)(buf[POD_HDR_LEN + plen] | (buf[POD_HDR_LEN + plen + 1] << 8));
  if (crc != pod_crc16(buf, POD_HDR_LEN + (size_t)plen)) return POD_DEC_BAD_CRC;
  f->version = buf[0];
  f->type = buf[1];
  f->seq = (uint16_t)(buf[2] | (buf[3] << 8));
  f->len = plen;
  f->payload = buf + POD_HDR_LEN;
  return POD_DEC_OK;
}

pod_dec_result_t pod_decode_gnss(const pod_frame_t *f, pod_gnss_t *g) {
  if (f->type != POD_TYPE_GNSS) return POD_DEC_BAD_TYPE;
  if (f->len < POD_GNSS_PAYLOAD_LEN) return POD_DEC_BAD_PAYLOAD; /* longer = newer minor */
  rd_t r = {f->payload, f->len, 0};
  g->pod_us = r_u64(&r);
  g->unix_us = (int64_t)r_u64(&r);
  g->itow_ms = r_u32(&r);
  g->lat_e7 = (int32_t)r_u32(&r);
  g->lon_e7 = (int32_t)r_u32(&r);
  g->hmsl_mm = (int32_t)r_u32(&r);
  g->vel_n_mm_s = (int32_t)r_u32(&r);
  g->vel_e_mm_s = (int32_t)r_u32(&r);
  g->vel_d_mm_s = (int32_t)r_u32(&r);
  g->g_speed_mm_s = (int32_t)r_u32(&r);
  g->head_mot_e5 = (int32_t)r_u32(&r);
  g->h_acc_mm = r_u32(&r);
  g->v_acc_mm = r_u32(&r);
  g->s_acc_mm_s = r_u32(&r);
  g->head_acc_e5 = r_u32(&r);
  g->t_acc_ns = r_u32(&r);
  g->p_dop_e2 = r_u16(&r);
  g->fix_type = r_u8(&r);
  g->num_sv = r_u8(&r);
  g->flags = r_u8(&r);
  g->rate_hz = r_u8(&r);
  return POD_DEC_OK;
}

pod_dec_result_t pod_decode_imu(const pod_frame_t *f, pod_imu_batch_t *b) {
  if (f->type != POD_TYPE_IMU) return POD_DEC_BAD_TYPE;
  if (f->len < POD_IMU_HDR_LEN) return POD_DEC_BAD_PAYLOAD;
  rd_t r = {f->payload, f->len, 0};
  b->t0_pod_us = r_u64(&r);
  b->acc_g_per_lsb = r_f32(&r);
  b->gyr_dps_per_lsb = r_f32(&r);
  b->rate_hz = r_u16(&r);
  b->count = r_u8(&r);
  b->flags = r_u8(&r);
  if (b->count == 0 || b->count > POD_IMU_MAX_SAMPLES ||
      f->len != POD_IMU_HDR_LEN + (size_t)b->count * POD_IMU_SAMPLE_LEN)
    return POD_DEC_BAD_PAYLOAD;
  for (uint8_t i = 0; i < b->count; i++) {
    b->s[i].dt_us = r_u32(&r);
    for (int k = 0; k < 3; k++) b->s[i].acc[k] = (int16_t)r_u16(&r);
    for (int k = 0; k < 3; k++) b->s[i].gyr[k] = (int16_t)r_u16(&r);
  }
  return POD_DEC_OK;
}

pod_dec_result_t pod_decode_status(const pod_frame_t *f, pod_status_t *s) {
  if (f->type != POD_TYPE_STATUS) return POD_DEC_BAD_TYPE;
  if (f->len < POD_STATUS_PAYLOAD_LEN) return POD_DEC_BAD_PAYLOAD;
  rd_t r = {f->payload, f->len, 0};
  s->pod_us = r_u64(&r);
  s->fw_major = r_u8(&r);
  s->fw_minor = r_u8(&r);
  s->fw_patch = r_u8(&r);
  s->hw_rev = r_u8(&r);
  s->rate_hz = r_u8(&r);
  s->hp_state = r_u8(&r);
  s->pps_state = r_u8(&r);
  s->flags = r_u8(&r);
  s->tb_anchor_pod_us = r_u64(&r);
  s->tb_anchor_unix_us = (int64_t)r_u64(&r);
  s->tb_rate_ppb = (int32_t)r_u32(&r);
  s->pps_age_ms = r_u32(&r);
  s->fix_type = r_u8(&r);
  s->num_sv = r_u8(&r);
  s->imu_decim = r_u8(&r);
  s->reserved = r_u8(&r);
  s->tx_drops = r_u32(&r);
  s->imu_overruns = r_u32(&r);
  s->ubx_errors = r_u32(&r);
  return POD_DEC_OK;
}

pod_dec_result_t pod_decode_control(const pod_frame_t *f, pod_control_t *c) {
  if (f->type != POD_TYPE_CONTROL) return POD_DEC_BAD_TYPE;
  if (f->len < 1 || f->len - 1 > sizeof(c->args)) return POD_DEC_BAD_PAYLOAD;
  c->seq = f->seq;
  c->opcode = f->payload[0];
  c->arg_len = (uint8_t)(f->len - 1);
  memcpy(c->args, f->payload + 1, c->arg_len);
  return POD_DEC_OK;
}

pod_dec_result_t pod_decode_control_result(const pod_frame_t *f, pod_control_result_t *r) {
  if (f->type != POD_TYPE_CONTROL_RESULT) return POD_DEC_BAD_TYPE;
  if (f->len < 4) return POD_DEC_BAD_PAYLOAD;
  r->opcode = f->payload[0];
  r->result = f->payload[1];
  r->echo_seq = (uint16_t)(f->payload[2] | (f->payload[3] << 8));
  return POD_DEC_OK;
}

uint16_t pod_seq_gap(uint16_t prev, uint16_t cur) { return (uint16_t)(cur - prev - 1); }
