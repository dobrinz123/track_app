#include "gnss_config.h"

bool gnss_rate_mode_valid(int hz) { return hz == 10 || hz == 20 || hz == 25; }

bool gnss_rate_requires_hp(gnss_rate_mode_t mode) { return mode != GNSS_RATE_10HZ_GPS_GAL; }

bool gnss_rate_allowed(gnss_rate_mode_t mode, hp_state_t hp) {
  if (!gnss_rate_mode_valid((int)mode)) return false;
  return !gnss_rate_requires_hp(mode) || hp == HP_STATE_SET;
}

uint16_t gnss_rate_meas_ms(gnss_rate_mode_t mode) { return (uint16_t)(1000 / (int)mode); }

size_t gnss_cfg_mode_items(gnss_rate_mode_t mode, uint32_t *keys, uint64_t *vals, size_t cap) {
  if (!gnss_rate_mode_valid((int)mode) || cap < 14) return 0;
  const uint64_t gal = mode != GNSS_RATE_25HZ_GPS ? 1 : 0;
  const struct {
    uint32_t k;
    uint64_t v;
  } items[14] = {
      {CFG_SIGNAL_GPS_ENA, 1},       {CFG_SIGNAL_GPS_L1CA_ENA, 1},
      {CFG_SIGNAL_SBAS_ENA, 1},      {CFG_SIGNAL_SBAS_L1CA_ENA, 1},
      {CFG_SIGNAL_QZSS_ENA, 1},      {CFG_SIGNAL_QZSS_L1CA_ENA, 1},
      {CFG_SIGNAL_GAL_ENA, gal},     {CFG_SIGNAL_GAL_E1_ENA, gal},
      {CFG_SIGNAL_BDS_ENA, 0},       {CFG_SIGNAL_GLO_ENA, 0},
      {CFG_RATE_MEAS, gnss_rate_meas_ms(mode)},
      {CFG_RATE_NAV, 1},
      {CFG_RATE_TIMEREF, 1},
      {CFG_MSGOUT_UBX_NAV_SAT_UART1, (uint64_t)(int)mode},
  };
  for (size_t i = 0; i < 14; i++) {
    keys[i] = items[i].k;
    vals[i] = items[i].v;
  }
  return 14;
}

size_t gnss_cfg_build_mode(gnss_rate_mode_t mode, uint8_t *out, size_t cap) {
  uint32_t keys[GNSS_MODE_MAX_ITEMS];
  uint64_t vals[GNSS_MODE_MAX_ITEMS];
  size_t n = gnss_cfg_mode_items(mode, keys, vals, GNSS_MODE_MAX_ITEMS);
  if (n == 0) return 0;
  ubx_valset_t v;
  ubx_valset_init(&v, UBX_VALSET_LAYER_RAM);
  for (size_t i = 0; i < n; i++) ubx_valset_add(&v, keys[i], vals[i]);
  return ubx_valset_frame(&v, out, cap);
}

size_t gnss_cfg_build_mode_poll(gnss_rate_mode_t mode, uint8_t *out, size_t cap) {
  uint32_t keys[GNSS_MODE_MAX_ITEMS];
  uint64_t vals[GNSS_MODE_MAX_ITEMS];
  size_t n = gnss_cfg_mode_items(mode, keys, vals, GNSS_MODE_MAX_ITEMS);
  if (n == 0) return 0;
  return ubx_valget_poll_frame(UBX_VALGET_LAYER_RAM, keys, n, out, cap);
}

bool gnss_cfg_verify_mode(const uint8_t *payload, uint16_t len, gnss_rate_mode_t mode) {
  uint32_t keys[GNSS_MODE_MAX_ITEMS];
  uint64_t want[GNSS_MODE_MAX_ITEMS], got[GNSS_MODE_MAX_ITEMS];
  size_t n = gnss_cfg_mode_items(mode, keys, want, GNSS_MODE_MAX_ITEMS);
  if (n == 0) return false;
  if (!ubx_valget_parse_strict(payload, len, UBX_VALGET_LAYER_RAM, keys, n, got)) return false;
  bool ok = true;
  for (size_t i = 0; i < n; i++) ok &= got[i] == want[i];
  return ok;
}

size_t gnss_cfg_build_baud(uint32_t baud, uint8_t *out, size_t cap) {
  ubx_valset_t v;
  ubx_valset_init(&v, UBX_VALSET_LAYER_RAM);
  ubx_valset_add(&v, CFG_UART1_BAUDRATE, baud);
  return ubx_valset_frame(&v, out, cap);
}

size_t gnss_cfg_build_base(gnss_rate_mode_t mode, uint8_t *out, size_t cap) {
  (void)mode;
  ubx_valset_t v;
  ubx_valset_init(&v, UBX_VALSET_LAYER_RAM);
  /* UBX in and out on UART1; NMEA output off (bandwidth at 25 Hz, [IM] 2.1.5:
   * "reduce the number of enabled messages"). NMEA input left at default. */
  ubx_valset_add(&v, CFG_UART1INPROT_UBX, 1);
  ubx_valset_add(&v, CFG_UART1OUTPROT_UBX, 1);
  ubx_valset_add(&v, CFG_UART1OUTPROT_NMEA, 0);
  /* Car dynamics. [IM] Table 4: automotive = max 100 m/s horizontal,
   * 15 m/s vertical. */
  ubx_valset_add(&v, CFG_NAVSPG_DYNMODEL, DYNMODEL_AUTOMOTIVE);
  /* NAV-PVT every epoch. */
  ubx_valset_add(&v, CFG_MSGOUT_UBX_NAV_PVT_UART1, 1);
  /* Time pulse = the pod's PPS. [IFD] 4.9.25 Table 46.
   * - period 1 s, aligned to the top of the second, rising edge.
   * - GPS time grid: GPS seconds coincide with UTC seconds (integer leap
   *   seconds), and a UTC grid can delay the first pulse by up to 12.5 min
   *   after a cold start ([IM] 3.6.2 note on UTC parameters).
   * - LEN_TP1 = 0 while NOT locked, 100 ms once locked (USE_LOCKED_TP1):
   *   the pin only pulses when the receiver is locked to GNSS time ([IM]
   *   3.8.2 "This mode can be used ... to disable time pulse if the time is
   *   not locked"). So every edge the pod sees is a GNSS-locked second.
   * - PULSE_LENGTH_DEF = 1 (LENGTH) per [IFD] Table 48. The [IM] 3.8.2.1
   *   example writes "PULSE_LENGTH_DEF = 0 (Period)", which contradicts the
   *   IFD enum (0 = RATIO); the IFD is followed here.
   * The pulse is an OUTPUT of the receiver on TIMEPULSE; the MCU pin (GPIO21)
   * is input-only (SAFEBOOT_N shares the net). */
  ubx_valset_add(&v, CFG_TP_TP1_ENA, 1);
  ubx_valset_add(&v, CFG_TP_PULSE_DEF, 0);        /* PERIOD */
  ubx_valset_add(&v, CFG_TP_PULSE_LENGTH_DEF, 1); /* LENGTH */
  ubx_valset_add(&v, CFG_TP_PERIOD_TP1, 1000000);
  ubx_valset_add(&v, CFG_TP_PERIOD_LOCK_TP1, 1000000);
  ubx_valset_add(&v, CFG_TP_LEN_TP1, 0);
  ubx_valset_add(&v, CFG_TP_LEN_LOCK_TP1, 100000);
  ubx_valset_add(&v, CFG_TP_SYNC_GNSS_TP1, 1);
  ubx_valset_add(&v, CFG_TP_USE_LOCKED_TP1, 1);
  ubx_valset_add(&v, CFG_TP_ALIGN_TO_TOW_TP1, 1);
  ubx_valset_add(&v, CFG_TP_POL_TP1, 1);
  ubx_valset_add(&v, CFG_TP_TIMEGRID_TP1, 1); /* GPS */
  return ubx_valset_frame(&v, out, cap);
}

size_t gnss_cfg_build_signals(gnss_rate_mode_t mode, uint8_t *out, size_t cap) {
  bool gal = mode != GNSS_RATE_25HZ_GPS;
  ubx_valset_t v;
  ubx_valset_init(&v, UBX_VALSET_LAYER_RAM);
  ubx_valset_add(&v, CFG_SIGNAL_GPS_ENA, 1);
  ubx_valset_add(&v, CFG_SIGNAL_GPS_L1CA_ENA, 1);
  /* [DS] footnote 5 + [IM] 2.1.2 ("recommended to enable QZSS L1C/A when GPS
   * L1C/A is enabled"): SBAS and QZSS stay on in every mode. */
  ubx_valset_add(&v, CFG_SIGNAL_SBAS_ENA, 1);
  ubx_valset_add(&v, CFG_SIGNAL_SBAS_L1CA_ENA, 1);
  ubx_valset_add(&v, CFG_SIGNAL_QZSS_ENA, 1);
  ubx_valset_add(&v, CFG_SIGNAL_QZSS_L1CA_ENA, 1);
  ubx_valset_add(&v, CFG_SIGNAL_GAL_ENA, gal ? 1 : 0);
  ubx_valset_add(&v, CFG_SIGNAL_GAL_E1_ENA, gal ? 1 : 0);
  /* BeiDou and GLONASS off: with them on, the default-clock maximum drops to
   * 8 / 6 Hz ([DS] Table 1). */
  ubx_valset_add(&v, CFG_SIGNAL_BDS_ENA, 0);
  ubx_valset_add(&v, CFG_SIGNAL_GLO_ENA, 0);
  return ubx_valset_frame(&v, out, cap);
}

size_t gnss_cfg_build_rate(gnss_rate_mode_t mode, uint8_t *out, size_t cap) {
  if (!gnss_rate_mode_valid((int)mode)) return 0;
  ubx_valset_t v;
  ubx_valset_init(&v, UBX_VALSET_LAYER_RAM);
  /* [IM] 2.1.4: change the rate via CFG-RATE-MEAS with CFG-RATE-NAV = 1. */
  ubx_valset_add(&v, CFG_RATE_MEAS, gnss_rate_meas_ms(mode));
  ubx_valset_add(&v, CFG_RATE_NAV, 1);
  ubx_valset_add(&v, CFG_RATE_TIMEREF, 1); /* GPS, same grid as the PPS */
  /* NAV-SAT once per second: the CFG-MSGOUT value is "per epoch" ([IM]
   * 2.1.4), so the divider equals the nav rate in Hz. */
  ubx_valset_add(&v, CFG_MSGOUT_UBX_NAV_SAT_UART1, (uint64_t)(int)mode);
  return ubx_valset_frame(&v, out, cap);
}
