/* Wire-level OTP guard tests (blind-verifier bypass of c607c3c).
 * The property under test: the byte stream that reaches the GNSS UART never
 * contains B5 62 06 41, whatever the host sends through the bridge and
 * whatever the firmware sent before. */
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unity.h>

#include "bridge_filter.h"
#include "gnss_tx_guard.h"
#include "ubx.h"
#include "ubx_hp_otp.h"

void setUp(void) {}
void tearDown(void) {}

/* ---- the firmware's TX path, modelled: bridge filter -> guard -> wire ---- */
typedef struct {
  uint8_t wire[1 << 16];
  size_t n;
  txg_t g;
  bridge_filter_t f;
} pod_t;

static void wire_tx(pod_t *p, const uint8_t *d, size_t n) { /* = gnss.cpp uart_tx() */
  size_t ok = txg_allow(&p->g, d, n);
  TEST_ASSERT_TRUE(p->n + ok <= sizeof p->wire);
  memcpy(p->wire + p->n, d, ok);
  p->n += ok;
}
static void bridge_cb(const uint8_t *d, size_t n, void *ctx) { wire_tx((pod_t *)ctx, d, n); }
static void host(pod_t *p, const uint8_t *d, size_t n) { bf_push(&p->f, d, n, bridge_cb, p); }
static void pod_init(pod_t *p) {
  p->n = 0;
  txg_init(&p->g);
  bf_init(&p->f);
}

static void assert_wire_clean(const pod_t *p) {
  for (size_t i = 0; i + 3 < p->n; i++)
    if (p->wire[i] == 0xB5 && p->wire[i + 1] == 0x62 && p->wire[i + 2] == 0x06 && p->wire[i + 3] == 0x41)
      TEST_FAIL_MESSAGE("B5 62 06 41 reached the wire");
}

/* An allowed (MON class 0x0A id 0x04), checksum-valid frame whose payload is
 * `pl` (len 4) with pl[0], pl[1] searched so that CK_A/CK_B hit the targets
 * (target < 0 = don't care). */
static size_t crafted(uint8_t *out, uint8_t tail2, uint8_t tail3, int ck_a, int ck_b) {
  for (int x = 0; x < 256; x++)
    for (int y = 0; y < 256; y++) {
      uint8_t pl[4] = {(uint8_t)x, (uint8_t)y, tail2, tail3};
      size_t n = ubx_build(0x0A, 0x04, pl, 4, out, 16);
      if ((ck_a < 0 || out[n - 2] == ck_a) && (ck_b < 0 || out[n - 1] == ck_b)) return n;
    }
  TEST_FAIL_MESSAGE("no payload found for the requested checksum");
  return 0;
}

/* Table-3 frame 1 from byte k on */
static const uint8_t *T3 = HP_OTP_WRITE_SEQUENCE;

void test_guard_unit(void) {
  txg_t g;
  txg_init(&g);
  const uint8_t a[] = {0x11, 0xB5, 0x62, 0x06};
  TEST_ASSERT_EQUAL_UINT(4, txg_allow(&g, a, 4));
  const uint8_t b[] = {0x41, 0x10, 0x00};
  TEST_ASSERT_EQUAL_UINT(0, txg_allow(&g, b, 3)); /* completes the sequence: refused */
  TEST_ASSERT_EQUAL_UINT32(1, g.refused_chunks);
  TEST_ASSERT_EQUAL_UINT32(3, g.refused_bytes);
  const uint8_t c[] = {0x41};
  TEST_ASSERT_EQUAL_UINT(0, txg_allow(&g, c, 1)); /* history unchanged: still refused */
  const uint8_t d[] = {0x8A, 0x41};
  TEST_ASSERT_EQUAL_UINT(2, txg_allow(&g, d, 2)); /* other ids pass */
  /* the raw writer's bytes enter the history */
  txg_note_raw(&g, T3, 24);
  TEST_ASSERT_EQUAL_HEX8(0x0D, g.last[2]);
}

void test_verifier_splice_ckb_b5(void) {
  pod_t *p = malloc(sizeof *p);
  pod_init(p);
  uint8_t fr[16];
  size_t n = crafted(fr, 0x00, 0x00, -1, 0xB5);
  host(p, fr, n);
  host(p, T3 + 1, 23); /* 62 06 41 10 00 ... rest of Table-3 frame 1 */
  assert_wire_clean(p);
  TEST_ASSERT_TRUE(p->g.refused_chunks >= 1);
  TEST_ASSERT_EQUAL_MEMORY(fr, p->wire, n); /* the allowed frame itself went out */
  free(p);
}

void test_verifier_splice_cka_b5(void) {
  pod_t *p = malloc(sizeof *p);
  pod_init(p);
  uint8_t fr[16];
  size_t n = crafted(fr, 0x00, 0x00, 0xB5, 0x62);
  host(p, fr, n);
  host(p, T3 + 2, 22); /* 06 41 10 00 ... */
  assert_wire_clean(p);
  TEST_ASSERT_TRUE(p->g.refused_chunks >= 1);
  free(p);
}

void test_verifier_splice_payload_tail(void) {
  pod_t *p = malloc(sizeof *p);
  pod_init(p);
  uint8_t fr[16];
  /* payload ends B5, CK_A 62, CK_B 06; host continues 41 10 ... */
  size_t n = crafted(fr, 0x00, 0xB5, 0x62, 0x06);
  host(p, fr, n);
  host(p, T3 + 3, 21);
  assert_wire_clean(p);
  /* payload ends B5 62, checksum 06 41: the frame itself carries the start */
  pod_init(p);
  n = crafted(fr, 0xB5, 0x62, 0x06, 0x41);
  host(p, fr, n);
  assert_wire_clean(p);
  TEST_ASSERT_EQUAL_UINT32(1, p->g.refused_chunks);
  free(p);
}

void test_splice_across_bridge_entry(void) {
  pod_t *p = malloc(sizeof *p);
  pod_init(p);
  uint8_t fr[16];
  /* the firmware's own last frame (e.g. a VALGET poll) ends in 0xB5 ... */
  size_t n = crafted(fr, 0x00, 0x00, -1, 0xB5);
  wire_tx(p, fr, n);
  /* ... then `gnss bridge` starts (fresh frame filter, SAME wire guard) */
  bf_init(&p->f);
  host(p, T3 + 1, 23);
  assert_wire_clean(p);
  TEST_ASSERT_TRUE(p->g.refused_chunks >= 1);
  /* and the plain Table-3 sequence through the bridge after that */
  host(p, HP_OTP_WRITE_SEQUENCE, 60);
  assert_wire_clean(p);
  free(p);
}

/* ---- fuzzing ---- */
static uint32_t rng = 0x12345678u;
static uint32_t rnd(void) { /* xorshift32 */
  rng ^= rng << 13;
  rng ^= rng >> 17;
  rng ^= rng << 5;
  return rng;
}
static uint8_t rbyte(void) { /* biased towards the dangerous values */
  static const uint8_t hot[] = {0xB5, 0x62, 0x06, 0x41, 0x10, 0x00};
  return (rnd() & 1) ? hot[rnd() % sizeof hot] : (uint8_t)rnd();
}

static size_t gen_piece(uint8_t *b) {
  uint8_t fr[64];
  switch (rnd() % 7) {
    case 0: /* allowed valid frame, random payload */
    {
      uint8_t pl[40];
      uint16_t len = (uint16_t)(rnd() % 40);
      for (int i = 0; i < len; i++) pl[i] = rbyte();
      uint8_t cls = (uint8_t)(rnd() % 3 == 0 ? 0x06 : rnd()), id = (uint8_t)rnd();
      size_t n = ubx_build(cls, id, pl, len, b, 64);
      return n;
    }
    case 1: memcpy(b, HP_OTP_WRITE_SEQUENCE, 60); return 60;
    case 2: { /* crafted checksum splices */
      size_t n = crafted(fr, rbyte(), rbyte(), rnd() & 1 ? 0xB5 : -1, 0xB5);
      memcpy(b, fr, n);
      return n;
    }
    case 3: { /* a Table-3 fragment */
      size_t k = rnd() % 24, m = 1 + rnd() % (24 - k);
      memcpy(b, HP_OTP_WRITE_SEQUENCE + k, m);
      return m;
    }
    default: { /* garbage */
      size_t m = 1 + rnd() % 12;
      for (size_t i = 0; i < m; i++) b[i] = rbyte();
      return m;
    }
  }
}

void test_fuzz_bridge_and_firmware_writes(void) {
  pod_t *p = malloc(sizeof *p);
  pod_init(p);
  uint8_t stream[4096];
  for (int round = 0; round < 400; round++) {
    size_t len = 0;
    while (len < sizeof stream - 64) len += gen_piece(stream + len);
    for (size_t k = 0; k < len;) {
      size_t c = 1 + rnd() % 17;
      if (c > len - k) c = len - k;
      host(p, stream + k, c);
      k += c;
      if (rnd() % 23 == 0) { /* firmware-originated write between host chunks */
        uint8_t fw[64];
        size_t m = gen_piece(fw);
        wire_tx(p, fw, m);
      }
      if (rnd() % 97 == 0) bf_init(&p->f); /* bridge re-entry */
    }
    assert_wire_clean(p);
    if (p->n > sizeof p->wire - 8192) p->n = 0; /* keep history in guard, reset buffer */
  }
  TEST_ASSERT_TRUE(p->g.refused_chunks > 0);
  TEST_ASSERT_TRUE(p->f.frames_blocked > 0);
  free(p);
}

void test_fuzz_guard_alone_any_input(void) {
  /* the guard by itself must hold for arbitrary bytes and chunking */
  pod_t *p = malloc(sizeof *p);
  pod_init(p);
  for (int round = 0; round < 3000; round++) {
    uint8_t d[32];
    size_t m = 1 + rnd() % 32;
    for (size_t i = 0; i < m; i++) d[i] = rbyte();
    wire_tx(p, d, m);
    if (p->n > sizeof p->wire - 64) {
      assert_wire_clean(p);
      p->n = 0;
    }
  }
  assert_wire_clean(p);
  free(p);
}

/* ---- the raw OTP writer is reachable from exactly one place ---- */
static char *slurp(const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *b = malloc((size_t)n + 1);
  size_t got = fread(b, 1, (size_t)n, f);
  b[got] = 0;
  fclose(f);
  return b;
}
static int count(const char *hay, const char *needle) {
  int c = 0;
  for (const char *q = hay; (q = strstr(q, needle)) != NULL; q++) c++;
  return c;
}

void test_raw_writer_and_uart_writes_are_confined(void) {
  DIR *d = opendir("src");
  TEST_ASSERT_NOT_NULL_MESSAGE(d, "run from the firmware-pod folder (pio test does)");
  struct dirent *e;
  int files = 0;
  while ((e = readdir(d)) != NULL) {
    if (e->d_name[0] == '.') continue;
    char path[512];
    snprintf(path, sizeof path, "src/%s", e->d_name);
    char *s = slurp(path);
    if (!s) continue;
    files++;
    if (strcmp(e->d_name, "gnss.cpp") == 0) {
      TEST_ASSERT_EQUAL_INT(1, count(s, "static void otp_raw_write_confirmed("));
      TEST_ASSERT_EQUAL_INT(1, count(s, "otp_raw_write_confirmed(HP_OTP_WRITE_SEQUENCE"));
      /* definition + that call + the one doc-comment mention */
      TEST_ASSERT_EQUAL_INT(3, count(s, "otp_raw_write_confirmed"));
      /* exactly two UART writes: uart_tx() (guarded) and the raw writer */
      TEST_ASSERT_EQUAL_INT(2, count(s, "GnssSerial.write("));
      TEST_ASSERT_EQUAL_INT(1, count(s, "= Serial1;"));
      /* the call sits inside gnss_otp_confirm() */
      const char *fn = strstr(s, "void gnss_otp_confirm()");
      const char *call = strstr(s, "otp_raw_write_confirmed(HP_OTP_WRITE_SEQUENCE");
      TEST_ASSERT_NOT_NULL(fn);
      TEST_ASSERT_TRUE(call > fn);
      const char *next_fn = strstr(fn + 1, "\nvoid ");
      TEST_ASSERT_TRUE(next_fn == NULL || call < next_fn);
    } else {
      TEST_ASSERT_EQUAL_INT_MESSAGE(0, count(s, "otp_raw_write_confirmed"), e->d_name);
      TEST_ASSERT_EQUAL_INT_MESSAGE(0, count(s, "Serial1"), e->d_name);
      TEST_ASSERT_EQUAL_INT_MESSAGE(0, count(s, "GnssSerial"), e->d_name);
    }
    free(s);
  }
  closedir(d);
  TEST_ASSERT_TRUE(files > 20);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_guard_unit);
  RUN_TEST(test_verifier_splice_ckb_b5);
  RUN_TEST(test_verifier_splice_cka_b5);
  RUN_TEST(test_verifier_splice_payload_tail);
  RUN_TEST(test_splice_across_bridge_entry);
  RUN_TEST(test_fuzz_bridge_and_firmware_writes);
  RUN_TEST(test_fuzz_guard_alone_any_input);
  RUN_TEST(test_raw_writer_and_uart_writes_are_confined);
  return UNITY_END();
}
