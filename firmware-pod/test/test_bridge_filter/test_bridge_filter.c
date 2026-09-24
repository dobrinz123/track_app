/* `gnss bridge` host->GNSS filter tests (review fix HIGH 1). */
#include <string.h>
#include <unity.h>

#include "bridge_filter.h"
#include "ubx.h"
#include "ubx_hp_otp.h"

void setUp(void) {}
void tearDown(void) {}

typedef struct {
  uint8_t d[4096];
  size_t n;
} sink_t;

static void out(const uint8_t *p, size_t n, void *ctx) {
  sink_t *s = (sink_t *)ctx;
  TEST_ASSERT_TRUE(s->n + n <= sizeof s->d);
  memcpy(s->d + s->n, p, n);
  s->n += n;
}

/* The receiver must never see an OTP frame start. */
static void assert_no_otp_start(const sink_t *s) {
  for (size_t i = 0; i + 3 < s->n; i++)
    TEST_ASSERT_FALSE(s->d[i] == 0xB5 && s->d[i + 1] == 0x62 && s->d[i + 2] == 0x06 &&
                      s->d[i + 3] == 0x41);
}

static const uint8_t ACK[] = {0xB5, 0x62, 0x05, 0x01, 0x02, 0x00, 0x06, 0x41, 0x4F, 0x78};

void test_table3_otp_bytes_fragmented_are_never_forwarded(void) {
  /* every chunk size from 1 to 60, including splits inside the header */
  for (size_t chunk = 1; chunk <= sizeof HP_OTP_WRITE_SEQUENCE; chunk++) {
    bridge_filter_t f;
    sink_t s = {{0}, 0};
    bf_init(&f);
    for (size_t k = 0; k < sizeof HP_OTP_WRITE_SEQUENCE; k += chunk) {
      size_t n = sizeof HP_OTP_WRITE_SEQUENCE - k < chunk ? sizeof HP_OTP_WRITE_SEQUENCE - k : chunk;
      bf_push(&f, HP_OTP_WRITE_SEQUENCE + k, n, out, &s);
    }
    TEST_ASSERT_EQUAL_UINT(0, s.n); /* nothing at all forwarded */
    TEST_ASSERT_EQUAL_UINT32(2, f.frames_blocked);
    TEST_ASSERT_EQUAL_HEX8(0x06, f.last_blocked_cls);
    TEST_ASSERT_EQUAL_HEX8(0x41, f.last_blocked_id);
  }
}

void test_allowed_frames_and_nmea_pass_unchanged(void) {
  bridge_filter_t f;
  sink_t s = {{0}, 0};
  bf_init(&f);
  const char *nmea = "$PUBX,40,GLL,0,0,0,0*5C\r\n";
  bf_push(&f, (const uint8_t *)nmea, strlen(nmea), out, &s);
  bf_push(&f, ACK, 4, out, &s); /* fragmented allowed frame */
  bf_push(&f, ACK + 4, 6, out, &s);
  uint8_t valset[32];
  ubx_valset_t v;
  ubx_valset_init(&v, UBX_VALSET_LAYER_RAM | UBX_VALSET_LAYER_BBR | UBX_VALSET_LAYER_FLASH);
  ubx_valset_add(&v, 0x30210001u, 100);
  size_t vn = ubx_valset_frame(&v, valset, sizeof valset);
  bf_push(&f, valset, vn, out, &s);
  size_t nl = strlen(nmea);
  TEST_ASSERT_EQUAL_UINT(nl + 10 + vn, s.n);
  TEST_ASSERT_EQUAL_MEMORY(nmea, s.d, nl);
  TEST_ASSERT_EQUAL_MEMORY(ACK, s.d + nl, 10);
  TEST_ASSERT_EQUAL_MEMORY(valset, s.d + nl + 10, vn);
  TEST_ASSERT_EQUAL_UINT32(2, f.frames_forwarded);
  TEST_ASSERT_EQUAL_UINT32(0, f.frames_blocked);
}

void test_otp_between_allowed_traffic(void) {
  bridge_filter_t f;
  sink_t s = {{0}, 0};
  bf_init(&f);
  bf_push(&f, ACK, 10, out, &s);
  bf_push(&f, HP_OTP_WRITE_SEQUENCE, 60, out, &s);
  bf_push(&f, ACK, 10, out, &s);
  TEST_ASSERT_EQUAL_UINT(20, s.n);
  assert_no_otp_start(&s);
  TEST_ASSERT_EQUAL_UINT32(2, f.frames_blocked);
}

void test_valset_with_undocumented_layer_is_blocked(void) {
  uint8_t fr[32];
  ubx_valset_t v;
  ubx_valset_init(&v, 0x08); /* bit 3: not RAM/BBR/Flash */
  ubx_valset_add(&v, 0x30210001u, 100);
  size_t n = ubx_valset_frame(&v, fr, sizeof fr);
  bridge_filter_t f;
  sink_t s = {{0}, 0};
  bf_init(&f);
  bf_push(&f, fr, n, out, &s);
  TEST_ASSERT_EQUAL_UINT(0, s.n);
  TEST_ASSERT_EQUAL_UINT32(1, f.frames_blocked);
}

void test_otp_embedded_in_allowed_payload_is_blocked(void) {
  /* a valid NAV-class frame whose payload carries the OTP frame */
  uint8_t fr[128];
  size_t n = ubx_build(0x01, 0x07, HP_OTP_WRITE_SEQUENCE, 24, fr, sizeof fr);
  bridge_filter_t f;
  sink_t s = {{0}, 0};
  bf_init(&f);
  bf_push(&f, fr, n, out, &s);
  TEST_ASSERT_EQUAL_UINT(0, s.n);
  TEST_ASSERT_EQUAL_UINT32(1, f.frames_blocked);
}

void test_otp_inside_corrupt_candidate_is_rescanned_and_blocked(void) {
  /* bogus header claiming 60 bytes, then the OTP sequence, then filler */
  uint8_t s_in[160];
  size_t k = 0;
  const uint8_t hdr[] = {0xB5, 0x62, 0x01, 0x07, 60, 0x00};
  memcpy(s_in, hdr, 6);
  k = 6;
  memcpy(s_in + k, HP_OTP_WRITE_SEQUENCE, 60);
  k += 60;
  memset(s_in + k, 0x11, 10);
  k += 10;
  bridge_filter_t f;
  sink_t s = {{0}, 0};
  bf_init(&f);
  bf_push(&f, s_in, k, out, &s);
  assert_no_otp_start(&s);
  TEST_ASSERT_EQUAL_UINT32(2, f.frames_blocked);
  for (size_t i = 0; i < s.n; i++) TEST_ASSERT_NOT_EQUAL(0xB5, s.d[i]);
}

void test_splice_attempt_cannot_create_a_frame_start(void) {
  /* "B5 62 06" + OTP frame + "41 ..." : dropping the middle must not let the
   * receiver see B5 62 06 41; the leading partial candidate is never
   * forwarded with its 0xB5. */
  uint8_t in[80];
  const uint8_t pre[] = {0xB5, 0x62, 0x06};
  memcpy(in, pre, 3);
  memcpy(in + 3, HP_OTP_WRITE_SEQUENCE, 24);
  const uint8_t post[] = {0x41, 0x10, 0x00, 0x03, 0x00};
  memcpy(in + 27, post, sizeof post);
  bridge_filter_t f;
  sink_t s = {{0}, 0};
  bf_init(&f);
  bf_push(&f, in, 27 + sizeof post, out, &s);
  for (size_t i = 0; i < s.n; i++) TEST_ASSERT_NOT_EQUAL(0xB5, s.d[i]);
  assert_no_otp_start(&s);
}

void test_stray_b5_in_plain_data_is_dropped(void) {
  const uint8_t in[] = {'A', 0xB5, 'B', 'C'};
  bridge_filter_t f;
  sink_t s = {{0}, 0};
  bf_init(&f);
  bf_push(&f, in, sizeof in, out, &s);
  const uint8_t want[] = {'A', 'B', 'C'};
  TEST_ASSERT_EQUAL_UINT(3, s.n);
  TEST_ASSERT_EQUAL_MEMORY(want, s.d, 3);
}

void test_policy_function(void) {
  TEST_ASSERT_TRUE(bf_frame_blocked(0x06, 0x41, NULL, 0));
  const uint8_t ram[] = {0x00, 0x01, 0x00, 0x00};
  TEST_ASSERT_FALSE(bf_frame_blocked(0x06, 0x8A, ram, 4));
  const uint8_t odd[] = {0x00, 0x10, 0x00, 0x00};
  TEST_ASSERT_TRUE(bf_frame_blocked(0x06, 0x8A, odd, 4));
  TEST_ASSERT_FALSE(bf_frame_blocked(0x0A, 0x04, NULL, 0)); /* MON-VER poll */
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_table3_otp_bytes_fragmented_are_never_forwarded);
  RUN_TEST(test_allowed_frames_and_nmea_pass_unchanged);
  RUN_TEST(test_otp_between_allowed_traffic);
  RUN_TEST(test_valset_with_undocumented_layer_is_blocked);
  RUN_TEST(test_otp_embedded_in_allowed_payload_is_blocked);
  RUN_TEST(test_otp_inside_corrupt_candidate_is_rescanned_and_blocked);
  RUN_TEST(test_splice_attempt_cannot_create_a_frame_start);
  RUN_TEST(test_stray_b5_in_plain_data_is_dropped);
  RUN_TEST(test_policy_function);
  return UNITY_END();
}
