/**
 * TRACE GNSS Pod BLE wire protocol, version 1 -- pure bytes in / bytes out.
 *
 * The contract is `firmware-pod/PROTOCOL.md`; the reference implementation is
 * `firmware-pod/src/pod_protocol.{h,c}`. Where the two differ, THIS module
 * follows the C code (each such place is marked "C reference" below).
 *
 * No BLE library, no React Native: the app's BLE transport hands one GATT
 * notification (DATA characteristic) or one INFO read value to
 * `parsePodFrame`, and writes the bytes from the `encodePod*` functions to the
 * CONTROL characteristic, one frame per write.
 *
 * Every frame (both directions), multi-byte fields little-endian:
 *
 *   off 0   u8  version   POD_PROTOCOL_VERSION (1); anything else is rejected
 *   off 1   u8  type      POD_FRAME_TYPE
 *   off 2   u16 seq       pod->app: one connection-wide counter (see podSequence.ts)
 *                         app->pod: chosen by the app, echoed in CONTROL_RESULT
 *   off 4   u16 len       payload length N
 *   off 6   N   payload
 *   off 6+N u16 crc       CRC-16/CCITT-FALSE over bytes [0, 6+N)
 *
 * A frame is valid only when `len + 8` equals the notification length exactly
 * and the CRC matches (PROTOCOL.md §2). Frames with an unknown TYPE are not an
 * error: they parse to `kind: 'unknown'` so the caller can ignore them (§9).
 */

export const POD_PROTOCOL_VERSION = 1;
export const POD_HEADER_LEN = 6;
export const POD_CRC_LEN = 2;
export const POD_FRAME_OVERHEAD = POD_HEADER_LEN + POD_CRC_LEN;

/** GATT layout (PROTOCOL.md §1). Constants only -- the transport lives in the app. */
export const POD_GATT = {
  SERVICE_UUID: 'be030001-cb14-41a4-a6af-b14223e0a8cf',
  /** NOTIFY: one pod->app frame per notification. */
  DATA_UUID: 'be030002-cb14-41a4-a6af-b14223e0a8cf',
  /** WRITE / WRITE WITHOUT RESPONSE: one CONTROL frame per write. */
  CONTROL_UUID: 'be030003-cb14-41a4-a6af-b14223e0a8cf',
  /** READ: a STATUS frame with seq 0xFFFF (not part of the DATA sequence). */
  INFO_UUID: 'be030004-cb14-41a4-a6af-b14223e0a8cf',
  /** Advertising name prefix; the suffix is the last two MAC bytes in hex. */
  NAME_PREFIX: 'TRACE-Pod-',
} as const;

/** The seq an INFO-characteristic STATUS carries (§1, §7.1). */
export const POD_INFO_SEQ = 0xffff;

/**
 * Smallest ATT MTU at which a GNSS frame (86 bytes) fits in one notification
 * (MTU - 3). Below it the pod drops GNSS frames and counts them in `txDrops`.
 */
export const POD_MIN_ATT_MTU = 89;

export const POD_FRAME_TYPE = {
  GNSS: 0x01,
  IMU: 0x02,
  STATUS: 0x03,
  CONTROL_RESULT: 0x04,
  /** app -> pod */
  CONTROL: 0x80,
} as const;

export const POD_GNSS_PAYLOAD_LEN = 78;
export const POD_IMU_HEADER_LEN = 20;
export const POD_IMU_SAMPLE_LEN = 16;
export const POD_IMU_MAX_SAMPLES = 32;
export const POD_STATUS_PAYLOAD_LEN = 56;
export const POD_CONTROL_RESULT_PAYLOAD_LEN = 4;
/** C reference: `pod_control_t.args[16]` -- a CONTROL payload is 1 + at most 16 bytes. */
export const POD_CONTROL_MAX_ARGS = 16;

// ---------- CRC ----------

/**
 * CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0.
 * Check value: "123456789" -> 0x29B1. Covers `bytes[start, end)`.
 */
export function podCrc16(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= (bytes[i] ?? 0) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// ---------- Decoded payloads (documented units, see PROTOCOL.md §3/§4/§6) ----------

/** GNSS `flags` bits (§3). */
export const POD_GNSS_FLAG = {
  FIX_OK: 0x01,
  DIFF_SOLN: 0x02,
  INVALID_LLH: 0x04,
  VALID_DATE: 0x08,
  VALID_TIME: 0x10,
  FULLY_RESOLVED: 0x20,
  POD_TIME_FROM_PPS: 0x40,
  UNIX_VALID: 0x80,
} as const;

export const POD_FIX_TYPE = {
  NONE: 0,
  DEAD_RECKONING: 1,
  FIX_2D: 2,
  FIX_3D: 3,
  GNSS_DR: 4,
  TIME_ONLY: 5,
} as const;

/**
 * One GNSS epoch (UBX-NAV-PVT, u-blox units converted to the unit named in
 * each field). Integer time fields stay integer microseconds.
 */
export interface PodGnss {
  /** Epoch time on the POD clock, µs since pod boot (§7.2). Not the app's clock. */
  podUs: number;
  /** Epoch UTC, µs since 1970. 0 unless `flags.unixValid`. */
  unixUs: number;
  /** GPS time of week, ms. */
  itowMs: number;
  latDeg: number;
  lonDeg: number;
  /** Height above mean sea level, m. */
  hMslM: number;
  /** NED velocity, m/s. */
  velNMps: number;
  velEMps: number;
  velDMps: number;
  /** 2-D ground speed, m/s. */
  groundSpeedMps: number;
  /** Heading of motion, deg 0..360. */
  headMotDeg: number;
  /** Horizontal accuracy estimate, m. */
  hAccM: number;
  /** Vertical accuracy estimate, m. */
  vAccM: number;
  /** Speed accuracy estimate, m/s. */
  sAccMps: number;
  /** Heading accuracy estimate, deg. */
  headAccDeg: number;
  /** Time accuracy estimate, ns. */
  tAccNs: number;
  /** Position DOP (unitless). */
  pDop: number;
  /** POD_FIX_TYPE: 0 none, 1 DR, 2 2-D, 3 3-D, 4 GNSS+DR, 5 time only. */
  fixType: number;
  numSv: number;
  /** Raw flag byte; `flags` below decodes it. */
  flagsRaw: number;
  flags: {
    /** gnssFixOK. PROTOCOL.md: use only fixes with this bit set. */
    fixOk: boolean;
    diffSoln: boolean;
    invalidLlh: boolean;
    validDate: boolean;
    validTime: boolean;
    fullyResolved: boolean;
    /** pod_us comes from the PPS timebase; when false it is the RECEIVE time (20-100 ms late). */
    podTimeFromPps: boolean;
    unixValid: boolean;
  };
  /** Navigation rate at this epoch, Hz. 0 = the receiver's mode is UNVERIFIED (rate unknown). */
  rateHz: number;
}

export interface PodImuSample {
  /** Offset from `t0PodUs`, µs. */
  dtUs: number;
  /** Sample time on the pod clock: t0PodUs + dtUs. */
  tPodUs: number;
  /** Raw LSB, SENSOR axes x,y,z (no mounting correction on the pod). */
  accRaw: [number, number, number];
  gyrRaw: [number, number, number];
  /** accRaw x accGPerLsb, g, sensor axes. */
  accG: [number, number, number];
  /** gyrRaw x gyrDpsPerLsb, deg/s, sensor axes. */
  gyrDps: [number, number, number];
}

export interface PodImuBatch {
  t0PodUs: number;
  accGPerLsb: number;
  gyrDpsPerLsb: number;
  /** Nominal output rate (480 / decimation), Hz. Use `dtUs`, never 1/rate, for timing. */
  rateHz: number;
  count: number;
  flagsRaw: number;
  /** Bit 0: sample times come from the IMU hardware timestamp. */
  hwTimestamp: boolean;
  samples: PodImuSample[];
}

/** STATUS `flags` bits (§6). */
export const POD_STATUS_FLAG = {
  USB_POWER: 0x01,
  GNSS_OK: 0x02,
  IMU_OK: 0x04,
  STREAM_GNSS: 0x08,
  STREAM_IMU: 0x10,
  WIFI_ON: 0x20,
  CHARGING_EN: 0x40,
} as const;

export const POD_HP_STATE = { UNKNOWN: 0, NOT_SET: 1, SET: 2 } as const;
export const POD_PPS_STATE = { NONE: 0, ACQUIRING: 1, LOCKED: 2, HOLDOVER: 3 } as const;

export interface PodStatus {
  /** Pod time when the frame was built, µs. */
  podUs: number;
  fwMajor: number;
  fwMinor: number;
  fwPatch: number;
  /** 1 = rev A. */
  hwRev: number;
  /** Current GNSS rate verified by readback, Hz. 0 = unverified. */
  rateHz: number;
  /** POD_HP_STATE. */
  hpState: number;
  /** POD_PPS_STATE. */
  ppsState: number;
  flagsRaw: number;
  flags: {
    usbPower: boolean;
    gnssOk: boolean;
    imuOk: boolean;
    streamGnss: boolean;
    streamImu: boolean;
    wifiOn: boolean;
    chargingEnabled: boolean;
  };
  /** Timebase anchor: pod time of a PPS edge, µs (0 if none). */
  tbAnchorPodUs: number;
  /** UTC of that edge (whole second), µs since 1970. */
  tbAnchorUnixUs: number;
  /** Clock-rate correction, ppb. */
  tbRatePpb: number;
  /** Age of the last accepted PPS edge, ms; null when the wire value is 0xFFFFFFFF (none yet). */
  ppsAgeMs: number | null;
  fixType: number;
  numSv: number;
  imuDecim: number;
  reserved: number;
  txDrops: number;
  imuOverruns: number;
  ubxErrors: number;
}

export const POD_OPCODE = {
  SET_STREAMS: 0x01,
  SET_RATE: 0x02,
  SET_IMU_DECIM: 0x03,
  GET_STATUS: 0x04,
} as const;

/** SET_STREAMS mask bits (§5). */
export const POD_STREAM = { GNSS: 0x01, IMU: 0x02, STATUS: 0x04 } as const;

export const POD_RESULT = {
  OK: 0,
  BAD_FRAME: 1,
  BAD_ARG: 2,
  REFUSED_HP_NOT_SET: 3,
  BUSY: 4,
  UNKNOWN_OPCODE: 5,
  FAILED: 6,
} as const;

const RESULT_NAMES: Readonly<Record<number, string>> = {
  0: 'OK',
  1: 'BAD_FRAME',
  2: 'BAD_ARG',
  3: 'REFUSED_HP_NOT_SET',
  4: 'BUSY',
  5: 'UNKNOWN_OPCODE',
  6: 'FAILED',
};

/** Name of a CONTROL_RESULT code, or `UNKNOWN_<n>` for a code this version does not define. */
export function podResultName(code: number): string {
  return RESULT_NAMES[code] ?? `UNKNOWN_${code}`;
}

export interface PodControlResult {
  /** Opcode echo. */
  opcode: number;
  /** POD_RESULT code. */
  result: number;
  resultName: string;
  /** The `seq` of the CONTROL frame this answers. */
  echoSeq: number;
}

/** A decoded app->pod CONTROL frame (the app normally only encodes these). */
export interface PodControl {
  opcode: number;
  args: Uint8Array;
}

// ---------- Frame union ----------

interface PodFrameBase {
  seq: number;
  /** Declared payload length. May exceed the documented length for GNSS/STATUS/RESULT (§9). */
  payloadLength: number;
}

export type PodFrame =
  | (PodFrameBase & { kind: 'gnss'; type: typeof POD_FRAME_TYPE.GNSS; gnss: PodGnss })
  | (PodFrameBase & { kind: 'imu'; type: typeof POD_FRAME_TYPE.IMU; imu: PodImuBatch })
  | (PodFrameBase & { kind: 'status'; type: typeof POD_FRAME_TYPE.STATUS; status: PodStatus })
  | (PodFrameBase & {
      kind: 'controlResult';
      type: typeof POD_FRAME_TYPE.CONTROL_RESULT;
      result: PodControlResult;
    })
  | (PodFrameBase & { kind: 'control'; type: typeof POD_FRAME_TYPE.CONTROL; control: PodControl })
  /** A type this version does not know: ignore it (§9). Not counted as a bad frame. */
  | (PodFrameBase & { kind: 'unknown'; type: number; payload: Uint8Array });

/**
 * Why a frame was rejected. The C reference folds `TOO_SHORT`,
 * `TRUNCATED` and `TRAILING_BYTES` into one `POD_DEC_SHORT`; they are split
 * here only so a diagnostics counter can tell them apart.
 *
 *  - TOO_SHORT      fewer than 8 bytes (cannot hold header + CRC)
 *  - BAD_VERSION    byte 0 is not 1 -- the app should tell the user to update (§9)
 *  - TRUNCATED      declared `len` + 8 is MORE than the bytes received
 *  - TRAILING_BYTES declared `len` + 8 is LESS than the bytes received
 *  - BAD_CRC        CRC mismatch
 *  - BAD_PAYLOAD    CRC-valid frame whose payload length/content is wrong for its type
 */
export type PodParseErrorCode =
  'TOO_SHORT' | 'BAD_VERSION' | 'TRUNCATED' | 'TRAILING_BYTES' | 'BAD_CRC' | 'BAD_PAYLOAD';

export type PodParseResult =
  { ok: true; frame: PodFrame } | { ok: false; error: PodParseErrorCode; detail: string };

function fail(error: PodParseErrorCode, detail: string): PodParseResult {
  return { ok: false, error, detail };
}

class PayloadError extends Error {}

/** Little-endian reader over one payload; u64/i64 are returned as safe JS integers. */
class Reader {
  private off = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number {
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.off, true);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.off, true);
    this.off += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return v;
  }
  /**
   * u64 as a JS number. Every u64 in this protocol is a microsecond time
   * (pod time since boot, or Unix µs ~1.8e15), far below 2^53; a value that is
   * not a safe integer cannot be represented exactly and is rejected rather
   * than silently rounded (an app-side guard, not a protocol rule).
   */
  u64(field: string): number {
    return this.safe(this.view.getBigUint64(this.off, true), field);
  }
  i64(field: string): number {
    return this.safe(this.view.getBigInt64(this.off, true), field);
  }
  private safe(v: bigint, field: string): number {
    this.off += 8;
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new PayloadError(`${field} ${v} is not a safe integer`);
    return n;
  }
  get length(): number {
    return this.bytes.byteLength;
  }
}

function decodeGnss(p: Uint8Array): PodGnss {
  // C reference `pod_decode_gnss`: len < 78 is bad; longer is a newer minor revision.
  if (p.byteLength < POD_GNSS_PAYLOAD_LEN) {
    throw new PayloadError(`GNSS payload ${p.byteLength} < ${POD_GNSS_PAYLOAD_LEN}`);
  }
  const r = new Reader(p);
  const podUs = r.u64('pod_us');
  const unixUs = r.i64('unix_us');
  const itowMs = r.u32();
  const latE7 = r.i32();
  const lonE7 = r.i32();
  const hmslMm = r.i32();
  const velN = r.i32();
  const velE = r.i32();
  const velD = r.i32();
  const gSpeed = r.i32();
  const headMotE5 = r.i32();
  const hAccMm = r.u32();
  const vAccMm = r.u32();
  const sAccMmS = r.u32();
  const headAccE5 = r.u32();
  const tAccNs = r.u32();
  const pDopE2 = r.u16();
  const fixType = r.u8();
  const numSv = r.u8();
  const f = r.u8();
  const rateHz = r.u8();
  return {
    podUs,
    unixUs,
    itowMs,
    latDeg: latE7 / 1e7,
    lonDeg: lonE7 / 1e7,
    hMslM: hmslMm / 1000,
    velNMps: velN / 1000,
    velEMps: velE / 1000,
    velDMps: velD / 1000,
    groundSpeedMps: gSpeed / 1000,
    headMotDeg: headMotE5 / 1e5,
    hAccM: hAccMm / 1000,
    vAccM: vAccMm / 1000,
    sAccMps: sAccMmS / 1000,
    headAccDeg: headAccE5 / 1e5,
    tAccNs,
    pDop: pDopE2 / 100,
    fixType,
    numSv,
    flagsRaw: f,
    flags: {
      fixOk: (f & POD_GNSS_FLAG.FIX_OK) !== 0,
      diffSoln: (f & POD_GNSS_FLAG.DIFF_SOLN) !== 0,
      invalidLlh: (f & POD_GNSS_FLAG.INVALID_LLH) !== 0,
      validDate: (f & POD_GNSS_FLAG.VALID_DATE) !== 0,
      validTime: (f & POD_GNSS_FLAG.VALID_TIME) !== 0,
      fullyResolved: (f & POD_GNSS_FLAG.FULLY_RESOLVED) !== 0,
      podTimeFromPps: (f & POD_GNSS_FLAG.POD_TIME_FROM_PPS) !== 0,
      unixValid: (f & POD_GNSS_FLAG.UNIX_VALID) !== 0,
    },
    rateHz,
  };
}

function decodeImu(p: Uint8Array): PodImuBatch {
  if (p.byteLength < POD_IMU_HEADER_LEN) {
    throw new PayloadError(`IMU payload ${p.byteLength} < header ${POD_IMU_HEADER_LEN}`);
  }
  const r = new Reader(p);
  const t0PodUs = r.u64('t0_pod_us');
  const accGPerLsb = r.f32();
  const gyrDpsPerLsb = r.f32();
  const rateHz = r.u16();
  const count = r.u8();
  const flagsRaw = r.u8();
  // C reference `pod_decode_imu`: count 1..32 and the payload EXACTLY 20 + 16*count
  // (no trailing bytes accepted for IMU, unlike GNSS/STATUS -- see PROTOCOL.md §4).
  if (count === 0 || count > POD_IMU_MAX_SAMPLES) {
    throw new PayloadError(`IMU count ${count} outside 1..${POD_IMU_MAX_SAMPLES}`);
  }
  const want = POD_IMU_HEADER_LEN + count * POD_IMU_SAMPLE_LEN;
  if (p.byteLength !== want) {
    throw new PayloadError(`IMU payload ${p.byteLength} != 20 + 16*${count} = ${want}`);
  }
  const samples: PodImuSample[] = [];
  for (let i = 0; i < count; i++) {
    const dtUs = r.u32();
    const accRaw: [number, number, number] = [r.i16(), r.i16(), r.i16()];
    const gyrRaw: [number, number, number] = [r.i16(), r.i16(), r.i16()];
    samples.push({
      dtUs,
      tPodUs: t0PodUs + dtUs,
      accRaw,
      gyrRaw,
      accG: [accRaw[0] * accGPerLsb, accRaw[1] * accGPerLsb, accRaw[2] * accGPerLsb],
      gyrDps: [gyrRaw[0] * gyrDpsPerLsb, gyrRaw[1] * gyrDpsPerLsb, gyrRaw[2] * gyrDpsPerLsb],
    });
  }
  return {
    t0PodUs,
    accGPerLsb,
    gyrDpsPerLsb,
    rateHz,
    count,
    flagsRaw,
    hwTimestamp: (flagsRaw & 0x01) !== 0,
    samples,
  };
}

function decodeStatus(p: Uint8Array): PodStatus {
  if (p.byteLength < POD_STATUS_PAYLOAD_LEN) {
    throw new PayloadError(`STATUS payload ${p.byteLength} < ${POD_STATUS_PAYLOAD_LEN}`);
  }
  const r = new Reader(p);
  const podUs = r.u64('pod_us');
  const fwMajor = r.u8();
  const fwMinor = r.u8();
  const fwPatch = r.u8();
  const hwRev = r.u8();
  const rateHz = r.u8();
  const hpState = r.u8();
  const ppsState = r.u8();
  const f = r.u8();
  const tbAnchorPodUs = r.u64('tb_anchor_pod_us');
  const tbAnchorUnixUs = r.i64('tb_anchor_unix_us');
  const tbRatePpb = r.i32();
  const ppsAgeRaw = r.u32();
  const fixType = r.u8();
  const numSv = r.u8();
  const imuDecim = r.u8();
  const reserved = r.u8();
  const txDrops = r.u32();
  const imuOverruns = r.u32();
  const ubxErrors = r.u32();
  return {
    podUs,
    fwMajor,
    fwMinor,
    fwPatch,
    hwRev,
    rateHz,
    hpState,
    ppsState,
    flagsRaw: f,
    flags: {
      usbPower: (f & POD_STATUS_FLAG.USB_POWER) !== 0,
      gnssOk: (f & POD_STATUS_FLAG.GNSS_OK) !== 0,
      imuOk: (f & POD_STATUS_FLAG.IMU_OK) !== 0,
      streamGnss: (f & POD_STATUS_FLAG.STREAM_GNSS) !== 0,
      streamImu: (f & POD_STATUS_FLAG.STREAM_IMU) !== 0,
      wifiOn: (f & POD_STATUS_FLAG.WIFI_ON) !== 0,
      chargingEnabled: (f & POD_STATUS_FLAG.CHARGING_EN) !== 0,
    },
    tbAnchorPodUs,
    tbAnchorUnixUs,
    tbRatePpb,
    ppsAgeMs: ppsAgeRaw === 0xffffffff ? null : ppsAgeRaw,
    fixType,
    numSv,
    imuDecim,
    reserved,
    txDrops,
    imuOverruns,
    ubxErrors,
  };
}

function decodeControlResult(p: Uint8Array): PodControlResult {
  // C reference: len >= 4 (extra bytes = newer minor revision).
  if (p.byteLength < POD_CONTROL_RESULT_PAYLOAD_LEN) {
    throw new PayloadError(`CONTROL_RESULT payload ${p.byteLength} < 4`);
  }
  const r = new Reader(p);
  const opcode = r.u8();
  const result = r.u8();
  const echoSeq = r.u16();
  return { opcode, result, resultName: podResultName(result), echoSeq };
}

function decodeControl(p: Uint8Array): PodControl {
  // C reference `pod_decode_control`: 1 opcode byte + at most 16 argument bytes.
  if (p.byteLength < 1 || p.byteLength - 1 > POD_CONTROL_MAX_ARGS) {
    throw new PayloadError(
      `CONTROL payload ${p.byteLength} outside 1..${1 + POD_CONTROL_MAX_ARGS}`,
    );
  }
  return { opcode: p[0] ?? 0, args: p.slice(1) };
}

/**
 * Parse ONE frame: one DATA notification, one INFO read value, or (for tests /
 * tooling) one CONTROL write. Validation order follows the C reference
 * `pod_decode_frame`: size >= 8, version, `len + 8 == size`, CRC; then the
 * type-specific payload checks.
 */
export function parsePodFrame(bytes: Uint8Array): PodParseResult {
  if (bytes.byteLength < POD_FRAME_OVERHEAD) {
    return fail('TOO_SHORT', `${bytes.byteLength} bytes < ${POD_FRAME_OVERHEAD}`);
  }
  const version = bytes[0] ?? 0;
  if (version !== POD_PROTOCOL_VERSION) {
    return fail('BAD_VERSION', `version ${version}, expected ${POD_PROTOCOL_VERSION}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(1);
  const seq = view.getUint16(2, true);
  const len = view.getUint16(4, true);
  if (len + POD_FRAME_OVERHEAD > bytes.byteLength) {
    return fail('TRUNCATED', `len ${len} + 8 > ${bytes.byteLength} bytes`);
  }
  if (len + POD_FRAME_OVERHEAD < bytes.byteLength) {
    return fail('TRAILING_BYTES', `len ${len} + 8 < ${bytes.byteLength} bytes`);
  }
  const crcWire = view.getUint16(POD_HEADER_LEN + len, true);
  const crcCalc = podCrc16(bytes, 0, POD_HEADER_LEN + len);
  if (crcWire !== crcCalc) {
    return fail('BAD_CRC', `crc 0x${hex4(crcWire)} != computed 0x${hex4(crcCalc)}`);
  }
  const payload = bytes.subarray(POD_HEADER_LEN, POD_HEADER_LEN + len);
  const base = { seq, payloadLength: len };
  try {
    switch (type) {
      case POD_FRAME_TYPE.GNSS:
        return { ok: true, frame: { ...base, kind: 'gnss', type, gnss: decodeGnss(payload) } };
      case POD_FRAME_TYPE.IMU:
        return { ok: true, frame: { ...base, kind: 'imu', type, imu: decodeImu(payload) } };
      case POD_FRAME_TYPE.STATUS:
        return {
          ok: true,
          frame: { ...base, kind: 'status', type, status: decodeStatus(payload) },
        };
      case POD_FRAME_TYPE.CONTROL_RESULT:
        return {
          ok: true,
          frame: { ...base, kind: 'controlResult', type, result: decodeControlResult(payload) },
        };
      case POD_FRAME_TYPE.CONTROL:
        return {
          ok: true,
          frame: { ...base, kind: 'control', type, control: decodeControl(payload) },
        };
      default:
        return { ok: true, frame: { ...base, kind: 'unknown', type, payload: payload.slice() } };
    }
  } catch (e) {
    if (e instanceof PayloadError) return fail('BAD_PAYLOAD', e.message);
    throw e;
  }
}

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

// ---------- CONTROL encoders (app -> pod) ----------

function assertU16(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
    throw new RangeError(`${name} must be an integer 0..65535, got ${v}`);
  }
}

/**
 * Generic CONTROL frame: `[opcode][args...]` wrapped in the common header +
 * CRC. The typed encoders below are the ones the app should use; this one is
 * exported for tooling and for opcodes a later minor revision adds.
 */
export function encodePodControl(
  seq: number,
  opcode: number,
  args: ArrayLike<number> = [],
): Uint8Array {
  assertU16('seq', seq);
  if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0xff) {
    throw new RangeError(`opcode must be a byte, got ${opcode}`);
  }
  if (args.length > POD_CONTROL_MAX_ARGS) {
    throw new RangeError(`at most ${POD_CONTROL_MAX_ARGS} argument bytes, got ${args.length}`);
  }
  const len = 1 + args.length;
  const out = new Uint8Array(POD_FRAME_OVERHEAD + len);
  const view = new DataView(out.buffer);
  view.setUint8(0, POD_PROTOCOL_VERSION);
  view.setUint8(1, POD_FRAME_TYPE.CONTROL);
  view.setUint16(2, seq, true);
  view.setUint16(4, len, true);
  view.setUint8(6, opcode);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? 0;
    if (!Number.isInteger(a) || a < 0 || a > 0xff) {
      throw new RangeError(`argument byte ${i} must be 0..255, got ${a}`);
    }
    view.setUint8(7 + i, a);
  }
  view.setUint16(POD_HEADER_LEN + len, podCrc16(out, 0, POD_HEADER_LEN + len), true);
  return out;
}

/**
 * SET_STREAMS: REPLACES the stream mask (POD_STREAM bits: GNSS 1, IMU 2,
 * STATUS-at-1-Hz 4). Streams are OFF on every new connection; subscribe to DATA
 * first, then send this. The pod answers BAD_ARG to any bit outside 0x07
 * (firmware ble_link.cpp), so this encoder refuses such a mask up front.
 */
export function encodePodSetStreams(seq: number, mask: number): Uint8Array {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0x07) {
    throw new RangeError(`stream mask must be 0..7, got ${mask}`);
  }
  return encodePodControl(seq, POD_OPCODE.SET_STREAMS, [mask]);
}

export type PodGnssRateHz = 10 | 20 | 25;
export const POD_GNSS_RATES_HZ: readonly PodGnssRateHz[] = [10, 20, 25];

/**
 * SET_RATE: GNSS navigation rate. 20/25 Hz need the high-performance OTP
 * (STATUS hpState 2), else REFUSED_HP_NOT_SET. Can take ~5 s; wait for its
 * CONTROL_RESULT before sending the next control (§5).
 */
export function encodePodSetRate(seq: number, hz: PodGnssRateHz): Uint8Array {
  if (!POD_GNSS_RATES_HZ.includes(hz)) {
    throw new RangeError(`GNSS rate must be 10, 20 or 25 Hz, got ${hz}`);
  }
  return encodePodControl(seq, POD_OPCODE.SET_RATE, [hz]);
}

export type PodImuDecimation = 1 | 2 | 4 | 8;
export const POD_IMU_DECIMATIONS: readonly PodImuDecimation[] = [1, 2, 4, 8];

/** SET_IMU_DECIM: IMU output rate = 480 / N Hz. */
export function encodePodSetImuDecim(seq: number, n: PodImuDecimation): Uint8Array {
  if (!POD_IMU_DECIMATIONS.includes(n)) {
    throw new RangeError(`IMU decimation must be 1, 2, 4 or 8, got ${n}`);
  }
  return encodePodControl(seq, POD_OPCODE.SET_IMU_DECIM, [n]);
}

/** GET_STATUS: no arguments; a STATUS frame follows the CONTROL_RESULT. */
export function encodePodGetStatus(seq: number): Uint8Array {
  return encodePodControl(seq, POD_OPCODE.GET_STATUS);
}

/**
 * IMU samples per frame for a given ATT MTU (notification payload = MTU - 3),
 * capped at 32. Mirrors C `pod_imu_samples_per_frame`: 9 at MTU 185, 13 at 247.
 */
export function podImuSamplesPerFrame(attMtu: number): number {
  const room = attMtu - 3 - POD_FRAME_OVERHEAD - POD_IMU_HEADER_LEN;
  if (room < POD_IMU_SAMPLE_LEN) return 0;
  return Math.min(POD_IMU_MAX_SAMPLES, Math.floor(room / POD_IMU_SAMPLE_LEN));
}
