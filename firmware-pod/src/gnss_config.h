#ifndef TRACE_POD_GNSS_CONFIG_H
#define TRACE_POD_GNSS_CONFIG_H

/*
 * SAM-M10Q configuration: which UBX-CFG-VALSET messages the pod sends, and
 * the rate-mode policy. Framework-free; the ESP32 side only transmits the
 * bytes and waits for UBX-ACK-ACK.
 *
 * All configuration goes to the RAM layer ONLY (layers = 0x01). Nothing is
 * written to BBR or flash, so a receiver power cycle / RESET_N returns it to
 * factory defaults and the firmware re-applies this on every start.
 *
 * Key IDs: [IFD] u-blox M10 SPG 5.10 Interface description UBX-21035062 R03,
 * chapter 4.9 (page in the comment next to each key). Rates: [DS] SAM-M10Q
 * Data sheet UBX-22013293 R05 Tables 1 and 2 (page 4/5).
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ubx.h"
#include "ubx_hp_otp.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --- configuration key IDs ([IFD] chapter 4.9, R03) --- */
#define CFG_RATE_MEAS 0x30210001u               /* U2, 0.001 s    (4.9.17, Table 36) */
#define CFG_RATE_NAV 0x30210002u                /* U2             (4.9.17) */
#define CFG_RATE_TIMEREF 0x20210003u            /* E1: 0 UTC, 1 GPS (Table 37) */
#define CFG_UART1_BAUDRATE 0x40520001u          /* U4             (4.9.27) */
#define CFG_UART1INPROT_UBX 0x10730001u         /* L */
#define CFG_UART1INPROT_NMEA 0x10730002u        /* L */
#define CFG_UART1OUTPROT_UBX 0x10740001u        /* L */
#define CFG_UART1OUTPROT_NMEA 0x10740002u       /* L */
#define CFG_MSGOUT_UBX_NAV_PVT_UART1 0x20910007u /* U1 */
#define CFG_MSGOUT_UBX_NAV_SAT_UART1 0x20910016u /* U1 */
#define CFG_NAVSPG_DYNMODEL 0x20110021u         /* E1 (Table 23: 4 = AUTOMOT) */
#define CFG_SIGNAL_GPS_ENA 0x1031001Fu
#define CFG_SIGNAL_GPS_L1CA_ENA 0x10310001u
#define CFG_SIGNAL_SBAS_ENA 0x10310020u
#define CFG_SIGNAL_SBAS_L1CA_ENA 0x10310005u
#define CFG_SIGNAL_GAL_ENA 0x10310021u
#define CFG_SIGNAL_GAL_E1_ENA 0x10310007u
#define CFG_SIGNAL_BDS_ENA 0x10310022u
#define CFG_SIGNAL_QZSS_ENA 0x10310024u
#define CFG_SIGNAL_QZSS_L1CA_ENA 0x10310012u
#define CFG_SIGNAL_GLO_ENA 0x10310025u
#define CFG_TP_PULSE_DEF 0x20050023u        /* E1: 0 PERIOD, 1 FREQ (Table 47) */
#define CFG_TP_PULSE_LENGTH_DEF 0x20050030u /* E1: 0 RATIO, 1 LENGTH (Table 48) */
#define CFG_TP_PERIOD_TP1 0x40050002u       /* U4 us */
#define CFG_TP_PERIOD_LOCK_TP1 0x40050003u  /* U4 us */
#define CFG_TP_LEN_TP1 0x40050004u          /* U4 us */
#define CFG_TP_LEN_LOCK_TP1 0x40050005u     /* U4 us */
#define CFG_TP_TP1_ENA 0x10050007u          /* L */
#define CFG_TP_SYNC_GNSS_TP1 0x10050008u    /* L */
#define CFG_TP_USE_LOCKED_TP1 0x10050009u   /* L */
#define CFG_TP_ALIGN_TO_TOW_TP1 0x1005000Au /* L */
#define CFG_TP_POL_TP1 0x1005000Bu          /* L: 1 = rising edge at top of second */
#define CFG_TP_TIMEGRID_TP1 0x2005000Cu     /* E1: 0 UTC, 1 GPS (Table 49) */

#define DYNMODEL_AUTOMOTIVE 4u /* [IFD] Table 23 AUTOMOT = 4 */

/* UART baud the firmware runs the receiver at. [DS] Table 16: 9600..921600.
 * 460800 leaves 18x margin over the 25 Hz NAV-PVT load (~2.5 kB/s) while
 * keeping a wider baud-error margin than 921600. Factory default is 9600
 * ([DS] Table 18). */
#define GNSS_BAUD_DEFAULT 9600u
#define GNSS_BAUD_RUN 460800u

/* Rate modes. Nav-rate maxima from [DS] Tables 1/2 (default firmware clock /
 * after the high-performance OTP):
 *   GPS+GAL:   10 Hz / 20 Hz        GPS only: 18 Hz / 25 Hz
 * [DS] footnote 5: "GPS is always in combination with SBAS and QZSS". */
typedef enum {
  GNSS_RATE_10HZ_GPS_GAL = 10, /* default, no OTP needed */
  GNSS_RATE_20HZ_GPS_GAL = 20, /* needs HP OTP */
  GNSS_RATE_25HZ_GPS = 25      /* needs HP OTP; GPS(+SBAS+QZSS) only */
} gnss_rate_mode_t;

bool gnss_rate_mode_valid(int hz);
/* true if the mode needs the high-performance OTP to be SET */
bool gnss_rate_requires_hp(gnss_rate_mode_t mode);
/* Policy gate: mode allowed given the verified OTP state? Only HP_STATE_SET
 * unlocks 20/25 Hz (UNKNOWN does not). */
bool gnss_rate_allowed(gnss_rate_mode_t mode, hp_state_t hp);
/* Measurement period in ms (CFG-RATE-MEAS). */
uint16_t gnss_rate_meas_ms(gnss_rate_mode_t mode);

/* VALSET #0 (sent at the receiver's current baud): switch UART1 to
 * GNSS_BAUD_RUN. */
size_t gnss_cfg_build_baud(uint32_t baud, uint8_t *out, size_t cap);

/* VALSET #1: protocols, dynamic model, messages, time pulse. See .c for
 * the per-key rationale (PPS only while locked to GNSS time). */
size_t gnss_cfg_build_base(gnss_rate_mode_t mode, uint8_t *out, size_t cap);

/* VALSET #2: constellation/signal set for a rate mode. [IM] 2.1.2: changing
 * signals restarts the GNSS subsystem; wait for the ACK plus 0.5 s. */
size_t gnss_cfg_build_signals(gnss_rate_mode_t mode, uint8_t *out, size_t cap);

/* VALSET #3: CFG-RATE-MEAS/NAV/TIMEREF + NAV-SAT output divider (NAV-SAT at
 * ~1 Hz whatever the nav rate). */
size_t gnss_cfg_build_rate(gnss_rate_mode_t mode, uint8_t *out, size_t cap);

/* ---- atomic mode change (review fix MEDIUM 9) ----
 * One mode = constellation/signal keys + CFG-RATE-* + NAV-SAT divider, sent
 * as ONE transactionless VALSET: [IFD] 3.10.5.1 "This message returns a
 * UBX-ACK-NAK and no configuration is applied" on any error, so the receiver
 * either takes the whole mode or none of it. The firmware then reads the
 * same keys back from the RAM layer (VALGET) and only reports the mode when
 * the readback matches exactly. */
#define GNSS_MODE_MAX_ITEMS 16
/* Key/value list of a mode; returns the number of items (0 if invalid). */
size_t gnss_cfg_mode_items(gnss_rate_mode_t mode, uint32_t *keys, uint64_t *vals, size_t cap);
/* The single VALSET (RAM layer) carrying the whole mode. */
size_t gnss_cfg_build_mode(gnss_rate_mode_t mode, uint8_t *out, size_t cap);
/* VALGET poll (RAM layer, position 0) for exactly the mode's keys. */
size_t gnss_cfg_build_mode_poll(gnss_rate_mode_t mode, uint8_t *out, size_t cap);
/* Strict readback check of the VALGET reply payload for that poll. */
bool gnss_cfg_verify_mode(const uint8_t *payload, uint16_t len, gnss_rate_mode_t mode);

#ifdef __cplusplus
}
#endif

#endif /* TRACE_POD_GNSS_CONFIG_H */
