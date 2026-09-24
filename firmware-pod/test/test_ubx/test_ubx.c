/* UBX codec tests (env:native).
 *
 * Vectors:
 *  - IM_*: byte strings printed in the u-blox SAM-M10Q Integration manual
 *    UBX-22020019 R02 §2.1.5 (real receiver traffic, checksums by u-blox).
 *  - PVT_FRAME: the u-blox documents contain NO captured NAV-PVT frame, so
 *    this vector was generated independently of this code (Python
 *    struct.pack at the offsets of UBX-21035062 R03 §3.15.11.1, Fletcher
 *    checksum computed separately); every field value is asserted below.
 */
#include <string.h>
#include <unity.h>

#include "ubx.h"

void setUp(void) {}
void tearDown(void) {}

static const uint8_t IM_ACK_ACK_0641[] = {0xB5, 0x62, 0x05, 0x01, 0x02, 0x00, 0x06, 0x41, 0x4F, 0x78};
static const uint8_t IM_ACK_ACK_068B[] = {0xB5, 0x62, 0x05, 0x01, 0x02, 0x00, 0x06, 0x8B, 0x99, 0xC2};
static const uint8_t IM_VALGET_POLL[] = {0xB5, 0x62, 0x06, 0x8B, 0x14, 0x00, 0x00, 0x04, 0x00, 0x00,
                                         0x01, 0x00, 0xA4, 0x40, 0x03, 0x00, 0xA4, 0x40, 0x05, 0x00,
                                         0xA4, 0x40, 0x0A, 0x00, 0xA4, 0x40, 0x4C, 0x15};

/* 2026-09-24 11:59:42 UTC, iTOW 388800100 */
static const uint8_t PVT_FRAME[100] = {
    0xB5, 0x62, 0x01, 0x07, 0x5C, 0x00, 0x64, 0x9E, 0x2C, 0x17, 0xEA, 0x07, 0x09, 0x18, 0x0B,
    0x3B, 0x2A, 0x07, 0x19, 0x00, 0x00, 0x00, 0xF3, 0xE0, 0xF5, 0x05, 0x03, 0x01, 0xE0, 0x0E,
    0x40, 0x07, 0x8D, 0x0E, 0x87, 0xEA, 0xBA, 0x1B, 0xB9, 0x4A, 0x06, 0x00, 0xDF, 0xBE, 0x05,
    0x00, 0xD2, 0x04, 0x00, 0x00, 0x29, 0x09, 0x00, 0x00, 0x2E, 0xFB, 0xFF, 0xFF, 0xA0, 0x5B,
    0x00, 0x00, 0xF4, 0xFF, 0xFF, 0xFF, 0xC0, 0x5B, 0x00, 0x00, 0xF2, 0xEC, 0x8D, 0x00, 0x96,
    0x00, 0x00, 0x00, 0xEA, 0x49, 0x08, 0x00, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xF2, 0xEC, 0x8D, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3E, 0x65};

/* ---- frame capture helper ---- */
typedef struct {
  int n;
  uint8_t cls[16], id[16];
  uint16_t len[16];
  uint8_t first[16];
} cap_t;

static void on_frame(const ubx_frame_t *f, void *ctx) {
  cap_t *c = (cap_t *)ctx;
  if (c->n < 16) {
    c->cls[c->n] = f->cls;
    c->id[c->n] = f->id;
    c->len[c->n] = f->len;
    c->first[c->n] = f->len ? f->payload[0] : 0;
  }
  c->n++;
}

void test_checksum_matches_u_blox_printed_frames(void) {
  TEST_ASSERT_TRUE(ubx_frame_is_valid(IM_ACK_ACK_0641, sizeof IM_ACK_ACK_0641));
  TEST_ASSERT_TRUE(ubx_frame_is_valid(IM_ACK_ACK_068B, sizeof IM_ACK_ACK_068B));
  TEST_ASSERT_TRUE(ubx_frame_is_valid(IM_VALGET_POLL, sizeof IM_VALGET_POLL));
  TEST_ASSERT_TRUE(ubx_frame_is_valid(PVT_FRAME, sizeof PVT_FRAME));
}

void test_build_reproduces_u_blox_ack_frame(void) {
  uint8_t out[16];
  const uint8_t pl[2] = {0x06, 0x41};
  size_t n = ubx_build(0x05, 0x01, pl, 2, out, sizeof out);
  TEST_ASSERT_EQUAL_UINT(10, n);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(IM_ACK_ACK_0641, out, 10);
}

void test_build_rejects_small_buffer(void) {
  uint8_t out[9];
  const uint8_t pl[2] = {0x06, 0x41};
  TEST_ASSERT_EQUAL_UINT(0, ubx_build(0x05, 0x01, pl, 2, out, sizeof out));
}

void test_valget_builder_reproduces_im_poll(void) {
  const uint32_t keys[4] = {0x40A40001u, 0x40A40003u, 0x40A40005u, 0x40A4000Au};
  uint8_t out[64];
  size_t n = ubx_valget_poll_frame(4, keys, 4, out, sizeof out);
  TEST_ASSERT_EQUAL_UINT(sizeof IM_VALGET_POLL, n);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(IM_VALGET_POLL, out, n);
}

void test_parser_whole_frame(void) {
  ubx_parser_t p;
  cap_t c = {0};
  ubx_parser_init(&p);
  ubx_parser_push(&p, PVT_FRAME, sizeof PVT_FRAME, on_frame, &c);
  TEST_ASSERT_EQUAL_INT(1, c.n);
  TEST_ASSERT_EQUAL_UINT8(0x01, c.cls[0]);
  TEST_ASSERT_EQUAL_UINT8(0x07, c.id[0]);
  TEST_ASSERT_EQUAL_UINT16(92, c.len[0]);
  TEST_ASSERT_EQUAL_UINT32(1, p.frames_ok);
}

void test_parser_byte_by_byte_fragmentation(void) {
  ubx_parser_t p;
  cap_t c = {0};
  ubx_parser_init(&p);
  for (size_t i = 0; i < sizeof PVT_FRAME; i++) ubx_parser_push(&p, &PVT_FRAME[i], 1, on_frame, &c);
  TEST_ASSERT_EQUAL_INT(1, c.n);
  /* odd split points across two frames */
  uint8_t two[110];
  memcpy(two, IM_ACK_ACK_0641, 10);
  memcpy(two + 10, PVT_FRAME, 100);
  ubx_parser_push(&p, two, 3, on_frame, &c);
  ubx_parser_push(&p, two + 3, 50, on_frame, &c);
  ubx_parser_push(&p, two + 53, 57, on_frame, &c);
  TEST_ASSERT_EQUAL_INT(3, c.n);
  TEST_ASSERT_EQUAL_UINT8(0x05, c.cls[1]);
  TEST_ASSERT_EQUAL_UINT8(0x01, c.cls[2]);
}

void test_parser_skips_nmea_and_noise(void) {
  const char *nmea = "$GNRMC,115942.10,A,4631.40740,N,02424.74073,E,84.4,93.0,240926,,,A*6E\r\n";
  ubx_parser_t p;
  cap_t c = {0};
  ubx_parser_init(&p);
  ubx_parser_push(&p, (const uint8_t *)nmea, strlen(nmea), on_frame, &c);
  ubx_parser_push(&p, IM_ACK_ACK_0641, 10, on_frame, &c);
  TEST_ASSERT_EQUAL_INT(1, c.n);
  TEST_ASSERT_EQUAL_UINT32(strlen(nmea), p.skipped_bytes);
}

void test_parser_rejects_corrupted_then_recovers(void) {
  uint8_t bad[100];
  memcpy(bad, PVT_FRAME, 100);
  bad[40] ^= 0x10; /* payload bit flip -> checksum error */
  ubx_parser_t p;
  cap_t c = {0};
  ubx_parser_init(&p);
  ubx_parser_push(&p, bad, 100, on_frame, &c);
  ubx_parser_push(&p, IM_ACK_ACK_0641, 10, on_frame, &c);
  TEST_ASSERT_EQUAL_INT(1, c.n);
  TEST_ASSERT_EQUAL_UINT8(0x05, c.cls[0]);
  TEST_ASSERT_EQUAL_UINT32(1, p.checksum_errors);
}

void test_parser_recovers_frame_swallowed_by_corrupt_length(void) {
  /* A truncated frame whose length field claims 60 bytes is followed by a
   * complete ACK: the ACK lies inside the bogus frame's span, so a naive
   * parser loses it. Ours must re-scan and deliver it. */
  uint8_t s[80];
  size_t k = 0;
  const uint8_t hdr[] = {0xB5, 0x62, 0x01, 0x07, 60, 0x00, 1, 2, 3};
  memcpy(s + k, hdr, sizeof hdr);
  k += sizeof hdr;
  memcpy(s + k, IM_ACK_ACK_0641, 10);
  k += 10;
  memset(s + k, 0x00, 60); /* filler so the bogus frame completes (bad checksum) */
  k += 60;
  ubx_parser_t p;
  cap_t c = {0};
  ubx_parser_init(&p);
  ubx_parser_push(&p, s, k, on_frame, &c);
  TEST_ASSERT_EQUAL_INT(1, c.n);
  TEST_ASSERT_EQUAL_UINT8(0x05, c.cls[0]);
  TEST_ASSERT_EQUAL_UINT8(0x06, c.first[0]);
  TEST_ASSERT_EQUAL_UINT32(1, p.checksum_errors);
}

void test_parser_oversize_length_and_bad_sync(void) {
  const uint8_t junk[] = {0xB5, 0x62, 0x01, 0x07, 0xFF, 0xFF, /* len 65535: oversize */
                          0xB5, 0x00,                         /* bad second sync */
                          0xB5, 0xB5};                        /* double sync char */
  ubx_parser_t p;
  cap_t c = {0};
  ubx_parser_init(&p);
  ubx_parser_push(&p, junk, sizeof junk, on_frame, &c);
  /* the trailing 0xB5 must be usable as the start of the next frame */
  ubx_parser_push(&p, IM_ACK_ACK_0641 + 1, 9, on_frame, &c);
  TEST_ASSERT_EQUAL_INT(1, c.n);
  TEST_ASSERT_EQUAL_UINT32(1, p.oversize_errors);
  TEST_ASSERT_TRUE(p.sync_errors >= 2);
}

void test_decode_nav_pvt_vector(void) {
  ubx_nav_pvt_t v;
  TEST_ASSERT_TRUE(ubx_decode_nav_pvt(PVT_FRAME + 6, 92, &v));
  TEST_ASSERT_EQUAL_UINT32(388800100u, v.itow_ms);
  TEST_ASSERT_EQUAL_UINT16(2026, v.year);
  TEST_ASSERT_EQUAL_UINT8(9, v.month);
  TEST_ASSERT_EQUAL_UINT8(24, v.day);
  TEST_ASSERT_EQUAL_UINT8(11, v.hour);
  TEST_ASSERT_EQUAL_UINT8(59, v.min);
  TEST_ASSERT_EQUAL_UINT8(42, v.sec);
  TEST_ASSERT_EQUAL_UINT8(0x07, v.valid);
  TEST_ASSERT_EQUAL_UINT32(25, v.t_acc_ns);
  TEST_ASSERT_EQUAL_INT32(99999987, v.nano);
  TEST_ASSERT_EQUAL_UINT8(3, v.fix_type);
  TEST_ASSERT_EQUAL_UINT8(0x01, v.flags);
  TEST_ASSERT_EQUAL_UINT8(0xE0, v.flags2);
  TEST_ASSERT_EQUAL_UINT8(14, v.num_sv);
  TEST_ASSERT_EQUAL_INT32(244123456, v.lon_e7);
  TEST_ASSERT_EQUAL_INT32(465234567, v.lat_e7);
  TEST_ASSERT_EQUAL_INT32(412345, v.height_mm);
  TEST_ASSERT_EQUAL_INT32(376543, v.hmsl_mm);
  TEST_ASSERT_EQUAL_UINT32(1234, v.h_acc_mm);
  TEST_ASSERT_EQUAL_UINT32(2345, v.v_acc_mm);
  TEST_ASSERT_EQUAL_INT32(-1234, v.vel_n_mm_s);
  TEST_ASSERT_EQUAL_INT32(23456, v.vel_e_mm_s);
  TEST_ASSERT_EQUAL_INT32(-12, v.vel_d_mm_s);
  TEST_ASSERT_EQUAL_INT32(23488, v.g_speed_mm_s);
  TEST_ASSERT_EQUAL_INT32(9301234, v.head_mot_e5);
  TEST_ASSERT_EQUAL_UINT32(150, v.s_acc_mm_s);
  TEST_ASSERT_EQUAL_UINT32(543210, v.head_acc_e5);
  TEST_ASSERT_EQUAL_UINT16(132, v.p_dop_e2);
  TEST_ASSERT_EQUAL_UINT16(0, v.flags3);
}

void test_decode_nav_pvt_wrong_length(void) {
  ubx_nav_pvt_t v;
  TEST_ASSERT_FALSE(ubx_decode_nav_pvt(PVT_FRAME + 6, 84, &v));
}

void test_decode_nav_sat(void) {
  uint8_t pl[8 + 3 * 12];
  memset(pl, 0, sizeof pl);
  pl[0] = 0x10; /* iTOW = 16 */
  pl[4] = 1;    /* version */
  pl[5] = 3;    /* numSvs */
  for (int i = 0; i < 3; i++) {
    uint8_t *s = pl + 8 + 12 * i;
    s[0] = (uint8_t)(i == 2 ? 2 : 0); /* gnssId: GPS, GPS, Galileo */
    s[1] = (uint8_t)(5 + i);
    s[2] = (uint8_t)(40 + i); /* cno */
    s[3] = (uint8_t)(int8_t)-5;
    s[8] = (uint8_t)(i == 1 ? (0x8 | 0x7) : 0x4); /* svUsed + quality 7 on #1 */
  }
  ubx_nav_sat_t sat;
  TEST_ASSERT_TRUE(ubx_decode_nav_sat(pl, sizeof pl, &sat));
  TEST_ASSERT_EQUAL_UINT32(16, sat.itow_ms);
  TEST_ASSERT_EQUAL_UINT8(3, sat.num_svs);
  TEST_ASSERT_EQUAL_UINT8(41, sat.sats[1].cno_dbhz);
  TEST_ASSERT_TRUE(sat.sats[1].used);
  TEST_ASSERT_EQUAL_UINT8(7, sat.sats[1].quality);
  TEST_ASSERT_FALSE(sat.sats[0].used);
  TEST_ASSERT_EQUAL_UINT8(2, sat.sats[2].gnss_id);
  TEST_ASSERT_EQUAL_INT8(-5, sat.sats[0].elev_deg);
  TEST_ASSERT_FALSE(ubx_decode_nav_sat(pl, sizeof pl - 1, &sat));
}

void test_key_sizes_from_key_id(void) {
  TEST_ASSERT_EQUAL_UINT(1, ubx_cfg_key_value_size(0x10740002u)); /* L */
  TEST_ASSERT_EQUAL_UINT(1, ubx_cfg_key_value_size(0x20110021u)); /* E1 */
  TEST_ASSERT_EQUAL_UINT(2, ubx_cfg_key_value_size(0x30210001u)); /* U2 */
  TEST_ASSERT_EQUAL_UINT(4, ubx_cfg_key_value_size(0x40520001u)); /* U4 */
  TEST_ASSERT_EQUAL_UINT(8, ubx_cfg_key_value_size(0x5005002Au)); /* R8 */
  TEST_ASSERT_EQUAL_UINT(0, ubx_cfg_key_value_size(0x00000001u));
}

void test_valset_layout_and_value_range(void) {
  ubx_valset_t v;
  ubx_valset_init(&v, UBX_VALSET_LAYER_RAM);
  ubx_valset_add(&v, 0x30210001u, 100);    /* CFG-RATE-MEAS = 100 ms */
  ubx_valset_add(&v, 0x40520001u, 460800); /* CFG-UART1-BAUDRATE */
  uint8_t out[64];
  size_t n = ubx_valset_frame(&v, out, sizeof out);
  const uint8_t want_payload[] = {0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x21, 0x30, 0x64, 0x00,
                                  0x01, 0x00, 0x52, 0x40, 0x00, 0x08, 0x07, 0x00};
  TEST_ASSERT_EQUAL_UINT(8 + sizeof want_payload, n);
  TEST_ASSERT_EQUAL_UINT8(0x06, out[2]);
  TEST_ASSERT_EQUAL_UINT8(0x8A, out[3]);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(want_payload, out + 6, sizeof want_payload);
  TEST_ASSERT_TRUE(ubx_frame_is_valid(out, n));
  /* value too large for a U1 key must be refused, not truncated */
  ubx_valset_add(&v, 0x20910007u, 300);
  TEST_ASSERT_TRUE(v.error);
  TEST_ASSERT_EQUAL_UINT(0, ubx_valset_frame(&v, out, sizeof out));
}

void test_valget_find(void) {
  /* payload of the IM step-5 expected reply */
  const uint8_t pl[] = {0x01, 0x04, 0x00, 0x00, 0x01, 0x00, 0xA4, 0x40, 0x00, 0xB0, 0x71, 0x0B,
                        0x03, 0x00, 0xA4, 0x40, 0x00, 0xB0, 0x71, 0x0B, 0x05, 0x00, 0xA4, 0x40,
                        0x00, 0xB0, 0x71, 0x0B, 0x0A, 0x00, 0xA4, 0x40, 0x00, 0xD8, 0xB8, 0x05};
  uint64_t v = 0;
  TEST_ASSERT_TRUE(ubx_valget_find(pl, sizeof pl, 0x40A4000Au, &v));
  TEST_ASSERT_EQUAL_UINT32(96000000u, (uint32_t)v);
  TEST_ASSERT_TRUE(ubx_valget_find(pl, sizeof pl, 0x40A40001u, &v));
  TEST_ASSERT_EQUAL_UINT32(192000000u, (uint32_t)v);
  TEST_ASSERT_FALSE(ubx_valget_find(pl, sizeof pl, 0x40A40002u, &v));
}

void test_cfg_rst_frame(void) {
  uint8_t out[16];
  size_t n = ubx_cfg_rst_frame(UBX_RST_BBR_HOT, UBX_RST_MODE_HW_WATCHDOG_NOW, out, sizeof out);
  const uint8_t want[] = {0xB5, 0x62, 0x06, 0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00};
  TEST_ASSERT_EQUAL_UINT(12, n);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(want, out, sizeof want);
  TEST_ASSERT_TRUE(ubx_frame_is_valid(out, n));
}

void test_decode_ack(void) {
  ubx_parser_t p;
  ubx_parser_init(&p);
  struct {
    bool got, is_ack;
    uint8_t c, i;
  } r = {0};
  ubx_frame_t f = {0x05, 0x00, 2, (const uint8_t[]){0x06, 0x8A}};
  TEST_ASSERT_TRUE(ubx_decode_ack(&f, &r.is_ack, &r.c, &r.i));
  TEST_ASSERT_FALSE(r.is_ack);
  TEST_ASSERT_EQUAL_UINT8(0x8A, r.i);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_checksum_matches_u_blox_printed_frames);
  RUN_TEST(test_build_reproduces_u_blox_ack_frame);
  RUN_TEST(test_build_rejects_small_buffer);
  RUN_TEST(test_valget_builder_reproduces_im_poll);
  RUN_TEST(test_parser_whole_frame);
  RUN_TEST(test_parser_byte_by_byte_fragmentation);
  RUN_TEST(test_parser_skips_nmea_and_noise);
  RUN_TEST(test_parser_rejects_corrupted_then_recovers);
  RUN_TEST(test_parser_recovers_frame_swallowed_by_corrupt_length);
  RUN_TEST(test_parser_oversize_length_and_bad_sync);
  RUN_TEST(test_decode_nav_pvt_vector);
  RUN_TEST(test_decode_nav_pvt_wrong_length);
  RUN_TEST(test_decode_nav_sat);
  RUN_TEST(test_key_sizes_from_key_id);
  RUN_TEST(test_valset_layout_and_value_range);
  RUN_TEST(test_valget_find);
  RUN_TEST(test_cfg_rst_frame);
  RUN_TEST(test_decode_ack);
  return UNITY_END();
}
