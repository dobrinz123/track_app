#ifndef TRACE_POD_PROTOCOL_H
#define TRACE_POD_PROTOCOL_H

/*
 * TRACE Pod BLE wire protocol, version 1 (framework-free).
 * PROTOCOL.md in this folder is the normative description for the app; this
 * header and pod_protocol.c are the reference implementation (encoder AND
 * decoder, round-trip tested under env:native).
 *
 * Every frame (both directions), all multi-byte fields little-endian:
 *   off 0  u8   version  (POD_PROTO_VERSION)
 *   off 1  u8   type
 *   off 2  u16  seq      pod->app: one counter across all frame types,
 *                        +1 per frame generated, wraps; a gap = lost frame(s)
 *                        app->pod: chosen by the app, echoed in CONTROL_RESULT
 *   off 4  u16  payload length N
 *   off 6  N    payload
 *   off 6+N u16 CRC-16/CCITT-FALSE over bytes [0, 6+N)
 * One frame per GATT notification / write.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define POD_PROTO_VERSION 1
#define POD_HDR_LEN 6
#define POD_CRC_LEN 2
#define POD_OVERHEAD (POD_HDR_LEN + POD_CRC_LEN)

enum {
  POD_TYPE_GNSS = 0x01,
  POD_TYPE_IMU = 0x02,
  POD_TYPE_STATUS = 0x03,
  POD_TYPE_CONTROL_RESULT = 0x04,
  POD_TYPE_CONTROL = 0x80 /* app -> pod */
};

/* CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0.
 * Check value for "123456789" is 0x29B1. */
uint16_t pod_crc16(const uint8_t *data, size_t len);

/* ---------------- GNSS (type 0x01), payload 78 bytes ---------------- */
#define POD_GNSS_PAYLOAD_LEN 78
#define POD_GNSS_F_FIX_OK 0x01      /* NAV-PVT gnssFixOK */
#define POD_GNSS_F_DIFF_SOLN 0x02   /* NAV-PVT diffSoln */
#define POD_GNSS_F_INVALID_LLH 0x04 /* NAV-PVT flags3.invalidLlh */
#define POD_GNSS_F_VALID_DATE 0x08
#define POD_GNSS_F_VALID_TIME 0x10
#define POD_GNSS_F_FULLY_RESOLVED 0x20
#define POD_GNSS_F_POD_TIME_FROM_PPS 0x40 /* pod_us derived via the PPS timebase */
#define POD_GNSS_F_UNIX_VALID 0x80

typedef struct {
  uint64_t pod_us;  /* epoch time on the pod clock */
  int64_t unix_us;  /* epoch UTC, Unix microseconds (0 if !UNIX_VALID) */
  uint32_t itow_ms;
  int32_t lat_e7, lon_e7;
  int32_t hmsl_mm;
  int32_t vel_n_mm_s, vel_e_mm_s, vel_d_mm_s;
  int32_t g_speed_mm_s;
  int32_t head_mot_e5;
  uint32_t h_acc_mm, v_acc_mm, s_acc_mm_s, head_acc_e5, t_acc_ns;
  uint16_t p_dop_e2;
  uint8_t fix_type;
  uint8_t num_sv;
  uint8_t flags;
  uint8_t rate_hz;
} pod_gnss_t;

/* ---------------- IMU batch (type 0x02) ---------------- */
#define POD_IMU_HDR_LEN 20
#define POD_IMU_SAMPLE_LEN 16
#define POD_IMU_MAX_SAMPLES 32
typedef struct {
  uint32_t dt_us; /* from t0_pod_us */
  int16_t acc[3]; /* raw LSB, sensor axes */
  int16_t gyr[3];
} pod_imu_sample_t;

typedef struct {
  uint64_t t0_pod_us;
  float acc_g_per_lsb;
  float gyr_dps_per_lsb;
  uint16_t rate_hz; /* nominal output rate after decimation */
  uint8_t count;
  uint8_t flags; /* bit0: sample times from the IMU hardware timestamp */
  pod_imu_sample_t s[POD_IMU_MAX_SAMPLES];
} pod_imu_batch_t;

/* Max samples per frame for a given ATT MTU (notification payload = MTU-3). */
uint8_t pod_imu_samples_per_frame(uint16_t att_mtu);

/* ---------------- STATUS (type 0x03), payload 56 bytes ---------------- */
#define POD_STATUS_PAYLOAD_LEN 56
#define POD_ST_F_USB_POWER 0x01
#define POD_ST_F_GNSS_OK 0x02
#define POD_ST_F_IMU_OK 0x04
#define POD_ST_F_STREAM_GNSS 0x08
#define POD_ST_F_STREAM_IMU 0x10
#define POD_ST_F_WIFI_ON 0x20
#define POD_ST_F_CHARGING_EN 0x40 /* always 0 on rev A */

typedef struct {
  uint64_t pod_us;
  uint8_t fw_major, fw_minor, fw_patch, hw_rev;
  uint8_t rate_hz;
  uint8_t hp_state;  /* 0 unknown, 1 not set, 2 set */
  uint8_t pps_state; /* 0 none, 1 acquiring, 2 locked, 3 holdover */
  uint8_t flags;
  uint64_t tb_anchor_pod_us;
  int64_t tb_anchor_unix_us;
  int32_t tb_rate_ppb;
  uint32_t pps_age_ms; /* 0xFFFFFFFF = no PPS yet */
  uint8_t fix_type, num_sv, imu_decim, reserved;
  uint32_t tx_drops;
  uint32_t imu_overruns;
  uint32_t ubx_errors;
} pod_status_t;

/* ---------------- CONTROL (type 0x80) / RESULT (0x04) ---------------- */
enum {
  POD_OP_SET_STREAMS = 0x01, /* u8 mask: bit0 GNSS, bit1 IMU, bit2 STATUS(1 Hz) */
  POD_OP_SET_RATE = 0x02,    /* u8 hz: 10, 20, 25 */
  POD_OP_SET_IMU_DECIM = 0x03, /* u8: 1, 2, 4, 8 */
  POD_OP_GET_STATUS = 0x04     /* no args; a STATUS frame follows the result */
};
#define POD_STREAM_GNSS 0x01
#define POD_STREAM_IMU 0x02
#define POD_STREAM_STATUS 0x04

enum {
  POD_RES_OK = 0,
  POD_RES_BAD_FRAME = 1,
  POD_RES_BAD_ARG = 2,
  POD_RES_REFUSED_HP_NOT_SET = 3,
  POD_RES_BUSY = 4,
  POD_RES_UNKNOWN_OPCODE = 5,
  POD_RES_FAILED = 6
};

typedef struct {
  uint16_t seq;
  uint8_t opcode;
  uint8_t arg_len;
  uint8_t args[16];
} pod_control_t;

typedef struct {
  uint8_t opcode;
  uint8_t result;
  uint16_t echo_seq;
} pod_control_result_t;

/* ---------------- encoders: return frame length, 0 if it does not fit ---- */
size_t pod_encode_gnss(uint16_t seq, const pod_gnss_t *g, uint8_t *out, size_t cap);
size_t pod_encode_imu(uint16_t seq, const pod_imu_batch_t *b, uint8_t *out, size_t cap);
size_t pod_encode_status(uint16_t seq, const pod_status_t *s, uint8_t *out, size_t cap);
size_t pod_encode_control_result(uint16_t seq, const pod_control_result_t *r, uint8_t *out,
                                 size_t cap);
size_t pod_encode_control(const pod_control_t *c, uint8_t *out, size_t cap);

/* ---------------- decoders ---------------- */
typedef enum {
  POD_DEC_OK = 0,
  POD_DEC_SHORT,       /* shorter than header+crc or than declared length */
  POD_DEC_BAD_VERSION,
  POD_DEC_BAD_CRC,
  POD_DEC_BAD_TYPE,
  POD_DEC_BAD_PAYLOAD  /* length wrong for the type */
} pod_dec_result_t;

typedef struct {
  uint8_t version, type;
  uint16_t seq;
  uint16_t len;
  const uint8_t *payload;
} pod_frame_t;

/* Validates header, length and CRC. Trailing bytes beyond the frame are an
 * error (one frame per notification). */
pod_dec_result_t pod_decode_frame(const uint8_t *buf, size_t len, pod_frame_t *f);
pod_dec_result_t pod_decode_gnss(const pod_frame_t *f, pod_gnss_t *g);
pod_dec_result_t pod_decode_imu(const pod_frame_t *f, pod_imu_batch_t *b);
pod_dec_result_t pod_decode_status(const pod_frame_t *f, pod_status_t *s);
pod_dec_result_t pod_decode_control(const pod_frame_t *f, pod_control_t *c);
pod_dec_result_t pod_decode_control_result(const pod_frame_t *f, pod_control_result_t *r);

/* Sequence-gap helper for receivers: number of frames lost between prev and
 * cur (0 if cur == prev + 1). */
uint16_t pod_seq_gap(uint16_t prev, uint16_t cur);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_PROTOCOL_H */
