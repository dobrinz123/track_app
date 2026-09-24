#ifndef TRACE_POD_UBX_H
#define TRACE_POD_UBX_H

/*
 * u-blox UBX protocol codec (framework-free, host-testable).
 *
 * EVERY constant in this file was checked against the u-blox primary document
 *   [IFD] u-blox M10 SPG 5.10 Interface description, UBX-21035062 R03
 *         (27-Jun-2023, protocol version 34.10), downloaded 2026-09-24 from
 *         https://content.u-blox.com/sites/default/files/u-blox-M10-SPG-5.10_InterfaceDescription_UBX-21035062.pdf
 * Section / page numbers refer to that revision. Nothing here is from memory.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* [IFD] 3.2 "UBX frame structure": preamble 0xb5 0x62, class, id, U2 LE
 * payload length, payload, CK_A, CK_B. */
#define UBX_SYNC1 0xB5u
#define UBX_SYNC2 0x62u
#define UBX_HEADER_LEN 6u   /* sync1 sync2 class id lenL lenH */
#define UBX_OVERHEAD 8u     /* header + CK_A + CK_B */

/* Largest payload this firmware accepts. UBX-NAV-SAT is 8 + numSvs*12
 * ([IFD] 3.15.13); 1016 bytes = 84 satellites, well above what an M10 tracks. */
#define UBX_MAX_PAYLOAD 1016u

/* Message classes / ids ([IFD] section headings, page given). */
#define UBX_CLS_NAV 0x01u
#define UBX_ID_NAV_PVT 0x07u      /* 3.15.11, p.98: length 92 */
#define UBX_ID_NAV_SAT 0x35u      /* 3.15.13, p.100: length 8 + numSvs*12 */
#define UBX_CLS_ACK 0x05u
#define UBX_ID_ACK_ACK 0x01u      /* 3.9.1, p.49: payload clsID, msgID */
#define UBX_ID_ACK_NAK 0x00u      /* 3.9.2, p.49 */
#define UBX_CLS_CFG 0x06u
#define UBX_ID_CFG_RST 0x04u      /* 3.10.2, p.50: length 4 */
#define UBX_ID_CFG_VALGET 0x8Bu   /* 3.10.4, p.53 */
#define UBX_ID_CFG_VALSET 0x8Au   /* 3.10.5, p.55 */
#define UBX_CLS_MON 0x0Au
#define UBX_ID_MON_VER 0x04u      /* 3.14.9, p.89: poll = 0 bytes; reply 40 + n*30 */

#define UBX_NAV_PVT_LEN 92u

/* UBX-CFG-VALSET / VALGET layer values ([IFD] 3.10.5.1 layers bitfield for SET;
 * 3.10.4.1 layer enum for GET). */
#define UBX_VALSET_LAYER_RAM 0x01u   /* bit 0 */
#define UBX_VALSET_LAYER_BBR 0x02u   /* bit 1 */
#define UBX_VALSET_LAYER_FLASH 0x04u /* bit 2 */
#define UBX_VALGET_LAYER_RAM 0u
#define UBX_VALGET_LAYER_DEFAULT 7u

/* UBX-CFG-RST resetMode ([IFD] 3.10.2, p.50/51). */
#define UBX_RST_MODE_HW_WATCHDOG_NOW 0x00u
#define UBX_RST_MODE_SW_CONTROLLED 0x01u
/* navBbrMask special sets ([IFD] 3.10.2): 0x0000 hot, 0x0001 warm, 0xFFFF cold. */
#define UBX_RST_BBR_HOT 0x0000u

/* ---------------------------------------------------------------- checksum */

/* [IFD] 3.4 "UBX checksum": 8-bit Fletcher over class, id, length and
 * payload (everything after the two sync chars, before CK_A). */
void ubx_checksum(const uint8_t *data, size_t len, uint8_t *ck_a, uint8_t *ck_b);

/* Build a complete frame into out. Returns the frame length, or 0 if it does
 * not fit in cap or len > UBX_MAX_PAYLOAD. payload may be NULL when len == 0. */
size_t ubx_build(uint8_t cls, uint8_t id, const uint8_t *payload, uint16_t len,
                 uint8_t *out, size_t cap);

/* True if buf holds exactly one well-formed frame with a correct checksum. */
bool ubx_frame_is_valid(const uint8_t *buf, size_t len);

/* ------------------------------------------------------------ frame parser */

typedef struct {
  uint8_t cls;
  uint8_t id;
  uint16_t len;
  const uint8_t *payload; /* valid only during the callback */
} ubx_frame_t;

typedef void (*ubx_frame_cb)(const ubx_frame_t *frame, void *ctx);

typedef struct {
  uint8_t buf[UBX_MAX_PAYLOAD + UBX_OVERHEAD];
  size_t len;
  /* statistics */
  uint32_t frames_ok;
  uint32_t checksum_errors;
  uint32_t sync_errors;     /* 0xB5 not followed by 0x62 */
  uint32_t oversize_errors; /* length field > UBX_MAX_PAYLOAD */
  uint32_t skipped_bytes;   /* bytes outside any frame (NMEA, noise) */
} ubx_parser_t;

void ubx_parser_init(ubx_parser_t *p);

/*
 * Feed received bytes. Calls cb once per valid frame, in order. Robust to
 * fragmentation (any split across calls), leading garbage/NMEA, and
 * corruption: on a checksum/sync/length failure the parser re-scans the bytes
 * it had buffered for the next 0xB5, so a good frame that was swallowed by a
 * corrupted length field is still recovered.
 */
void ubx_parser_push(ubx_parser_t *p, const uint8_t *data, size_t n, ubx_frame_cb cb,
                     void *ctx);

/* -------------------------------------------------------------- CFG-VALSET */

/* Key size from key-ID bits 30..28 ([IFD] 4.2, p.123/124):
 * 0x01 one bit (stored as one byte), 0x02 one byte, 0x03 two bytes,
 * 0x04 four bytes, 0x05 eight bytes. Returns 0 for an invalid size field. */
size_t ubx_cfg_key_value_size(uint32_t key);

#define UBX_VALSET_MAX_KEYS 64u /* [IFD] 3.10.5.1: max 64 key-value pairs */

typedef struct {
  uint8_t payload[4 + UBX_VALSET_MAX_KEYS * 12];
  uint16_t len;
  uint8_t nkeys;
  bool error; /* too many keys / bad key size / value does not fit */
} ubx_valset_t;

/* Version 0 (transactionless) VALSET, [IFD] 3.10.5.1: version=0, layers,
 * reserved0[2]=0. */
void ubx_valset_init(ubx_valset_t *v, uint8_t layers);
/* Appends key + little-endian value using the key's own size field. */
void ubx_valset_add(ubx_valset_t *v, uint32_t key, uint64_t value);
/* Serialises the VALSET frame. Returns frame length or 0 on error. */
size_t ubx_valset_frame(const ubx_valset_t *v, uint8_t *out, size_t cap);

/* UBX-CFG-VALGET poll, version 0 ([IFD] 3.10.4.1). */
size_t ubx_valget_poll_frame(uint8_t layer, const uint32_t *keys, size_t nkeys,
                             uint8_t *out, size_t cap);

/* Look up one key's value in a UBX-CFG-VALGET response payload
 * ([IFD] 3.10.4.2: version(=1), layer, position U2, then key/value pairs).
 * Returns true and writes *value if found. */
bool ubx_valget_find(const uint8_t *payload, uint16_t len, uint32_t key, uint64_t *value);

/* UBX-CFG-RST ([IFD] 3.10.2): navBbrMask X2, resetMode U1, reserved0 U1. */
size_t ubx_cfg_rst_frame(uint16_t nav_bbr_mask, uint8_t reset_mode, uint8_t *out, size_t cap);

/* ------------------------------------------------------------- NAV-PVT */

/* Field names, offsets, types and scales: [IFD] 3.15.11.1, pp.98-99. */
typedef struct {
  uint32_t itow_ms;      /* 0  U4 ms   GPS time of week of the epoch */
  uint16_t year;         /* 4  U2 */
  uint8_t month;         /* 6  U1 */
  uint8_t day;           /* 7  U1 */
  uint8_t hour;          /* 8  U1 */
  uint8_t min;           /* 9  U1 */
  uint8_t sec;           /* 10 U1 (0..60) */
  uint8_t valid;         /* 11 X1 bit0 validDate, bit1 validTime, bit2 fullyResolved */
  uint32_t t_acc_ns;     /* 12 U4 ns */
  int32_t nano;          /* 16 I4 ns, -1e9..1e9 */
  uint8_t fix_type;      /* 20 U1 0 no fix,1 DR,2 2D,3 3D,4 GNSS+DR,5 time only */
  uint8_t flags;         /* 21 X1 bit0 gnssFixOK, bit1 diffSoln, bit5 headVehValid */
  uint8_t flags2;        /* 22 X1 */
  uint8_t num_sv;        /* 23 U1 */
  int32_t lon_e7;        /* 24 I4 1e-7 deg */
  int32_t lat_e7;        /* 28 I4 1e-7 deg */
  int32_t height_mm;     /* 32 I4 mm above ellipsoid */
  int32_t hmsl_mm;       /* 36 I4 mm above MSL */
  uint32_t h_acc_mm;     /* 40 U4 */
  uint32_t v_acc_mm;     /* 44 U4 */
  int32_t vel_n_mm_s;    /* 48 I4 */
  int32_t vel_e_mm_s;    /* 52 I4 */
  int32_t vel_d_mm_s;    /* 56 I4 */
  int32_t g_speed_mm_s;  /* 60 I4 */
  int32_t head_mot_e5;   /* 64 I4 1e-5 deg */
  uint32_t s_acc_mm_s;   /* 68 U4 */
  uint32_t head_acc_e5;  /* 72 U4 1e-5 deg */
  uint16_t p_dop_e2;     /* 76 U2 0.01 */
  uint16_t flags3;       /* 78 X2 bit0 invalidLlh */
} ubx_nav_pvt_t;

#define UBX_PVT_VALID_DATE 0x01u
#define UBX_PVT_VALID_TIME 0x02u
#define UBX_PVT_FULLY_RESOLVED 0x04u
#define UBX_PVT_FLAGS_GNSS_FIX_OK 0x01u
#define UBX_PVT_FLAGS_DIFF_SOLN 0x02u
#define UBX_PVT_FLAGS3_INVALID_LLH 0x0001u

/* Returns false if len != 92. */
bool ubx_decode_nav_pvt(const uint8_t *payload, uint16_t len, ubx_nav_pvt_t *out);

/* ------------------------------------------------------------- NAV-SAT */

/* [IFD] 3.15.13.1 p.100: iTOW U4, version U1, numSvs U1, reserved U1[2], then
 * per SV (12 bytes): gnssId U1, svId U1, cno U1 dBHz, elev I1, azim I2,
 * prRes I2 (0.1 m), flags X4 (bits 2..0 qualityInd, bit 3 svUsed). */
#define UBX_NAV_SAT_MAX_SV 84u

typedef struct {
  uint8_t gnss_id;
  uint8_t sv_id;
  uint8_t cno_dbhz;
  int8_t elev_deg;
  bool used;
  uint8_t quality;
} ubx_sat_t;

typedef struct {
  uint32_t itow_ms;
  uint8_t num_svs; /* number decoded into sats[] */
  ubx_sat_t sats[UBX_NAV_SAT_MAX_SV];
} ubx_nav_sat_t;

/* Returns false on a length that does not match 8 + numSvs*12. */
bool ubx_decode_nav_sat(const uint8_t *payload, uint16_t len, ubx_nav_sat_t *out);

/* ------------------------------------------------------------- helpers */

/* ACK-ACK / ACK-NAK payload: acknowledged class + id. Returns false if the
 * frame is not an ACK class frame with a 2-byte payload. */
bool ubx_decode_ack(const ubx_frame_t *f, bool *is_ack, uint8_t *ack_cls, uint8_t *ack_id);

/* Little-endian readers (also used by other modules). */
uint16_t ubx_u2(const uint8_t *p);
uint32_t ubx_u4(const uint8_t *p);
int32_t ubx_i4(const uint8_t *p);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_UBX_H */
