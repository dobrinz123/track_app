import { describe, expect, it } from 'vitest';

import {
  encodePodControl,
  encodePodGetStatus,
  encodePodSetImuDecim,
  encodePodSetRate,
  encodePodSetStreams,
  parsePodFrame,
  podCrc16,
  podImuSamplesPerFrame,
  POD_OPCODE,
  POD_RESULT,
  POD_STREAM,
  type PodFrame,
  type PodGnssRateHz,
  type PodImuDecimation,
} from '../../../src/telemetry/pod/podProtocol';
import {
  C_SAMPLE_GNSS_POD_US,
  frame,
  hex,
  sampleGnssPayload,
  sampleImuPayload,
  sampleStatusPayload,
} from './podFrameBuilders';

function parseOk(bytes: Uint8Array): PodFrame {
  const r = parsePodFrame(bytes);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}: ${r.detail}`);
  return r.frame;
}

describe('podCrc16 (CRC-16/CCITT-FALSE)', () => {
  it('catalogue check value "123456789" -> 0x29B1', () => {
    const bytes = Uint8Array.from('123456789', (c) => c.charCodeAt(0));
    expect(podCrc16(bytes)).toBe(0x29b1);
  });
  it('empty input -> init value 0xFFFF (C test)', () => {
    expect(podCrc16(new Uint8Array(0))).toBe(0xffff);
  });
  it('honours the [start, end) range', () => {
    const bytes = Uint8Array.from('xx123456789yy', (c) => c.charCodeAt(0));
    expect(podCrc16(bytes, 2, 11)).toBe(0x29b1);
  });
});

describe('PROTOCOL.md §8 example frames, byte for byte', () => {
  const EX_SET_STREAMS = hex('01 80 01 00 02 00 01 07 0A 36');
  const EX_SET_RATE = hex('01 80 02 00 02 00 02 14 EB 8F');
  const EX_SET_IMU_DECIM = hex('01 80 03 00 02 00 03 04 4B EB');
  const EX_GET_STATUS = hex('01 80 04 00 01 00 04 3D 63');
  const EX_RESULT = hex('01 04 11 00 04 00 02 00 02 00 5F E5');

  it('encoders reproduce every CONTROL example exactly', () => {
    expect(encodePodSetStreams(1, POD_STREAM.GNSS | POD_STREAM.IMU | POD_STREAM.STATUS)).toEqual(
      EX_SET_STREAMS,
    );
    expect(encodePodSetRate(2, 20)).toEqual(EX_SET_RATE);
    expect(encodePodSetImuDecim(3, 4)).toEqual(EX_SET_IMU_DECIM);
    expect(encodePodGetStatus(4)).toEqual(EX_GET_STATUS);
  });

  it('CONTROL examples decode to the documented opcode/args/seq', () => {
    const cases: Array<[Uint8Array, number, number, number[]]> = [
      [EX_SET_STREAMS, 1, POD_OPCODE.SET_STREAMS, [7]],
      [EX_SET_RATE, 2, POD_OPCODE.SET_RATE, [20]],
      [EX_SET_IMU_DECIM, 3, POD_OPCODE.SET_IMU_DECIM, [4]],
      [EX_GET_STATUS, 4, POD_OPCODE.GET_STATUS, []],
    ];
    for (const [bytes, seq, opcode, args] of cases) {
      const f = parseOk(bytes);
      expect(f.kind).toBe('control');
      if (f.kind !== 'control') continue;
      expect(f.seq).toBe(seq);
      expect(f.control.opcode).toBe(opcode);
      expect(Array.from(f.control.args)).toEqual(args);
    }
  });

  it('CONTROL_RESULT example: pod seq 17, SET_RATE OK, echo seq 2', () => {
    const f = parseOk(EX_RESULT);
    expect(f).toEqual({
      kind: 'controlResult',
      type: 0x04,
      seq: 17,
      payloadLength: 4,
      result: { opcode: POD_OPCODE.SET_RATE, result: POD_RESULT.OK, resultName: 'OK', echoSeq: 2 },
    });
  });
});

describe('CONTROL encoders vs the C reference vectors', () => {
  it('C test_control_golden_bytes: seq 0x1234 SET_RATE 20 header bytes', () => {
    const b = encodePodSetRate(0x1234, 20);
    expect(b.byteLength).toBe(10);
    expect(Array.from(b.subarray(0, 8))).toEqual([0x01, 0x80, 0x34, 0x12, 0x02, 0x00, 0x02, 0x14]);
    const f = parseOk(b);
    expect(f.kind === 'control' && f.seq).toBe(0x1234);
  });

  it('round-trips every opcode and argument the pod accepts', () => {
    for (let mask = 0; mask <= 7; mask++) {
      const f = parseOk(encodePodSetStreams(mask, mask));
      expect(f.kind === 'control' && [f.seq, f.control.opcode, ...f.control.args]).toEqual([
        mask,
        1,
        mask,
      ]);
    }
    for (const hz of [10, 20, 25] as PodGnssRateHz[]) {
      const f = parseOk(encodePodSetRate(0xffff, hz));
      expect(f.kind === 'control' && [f.seq, f.control.opcode, ...f.control.args]).toEqual([
        0xffff,
        2,
        hz,
      ]);
    }
    for (const n of [1, 2, 4, 8] as PodImuDecimation[]) {
      const f = parseOk(encodePodSetImuDecim(0, n));
      expect(f.kind === 'control' && [f.control.opcode, ...f.control.args]).toEqual([3, n]);
    }
    const g = parseOk(encodePodGetStatus(65535));
    expect(g.kind === 'control' && [g.seq, g.control.opcode, g.control.args.length]).toEqual([
      65535, 4, 0,
    ]);
  });

  it('refuses arguments the pod would answer BAD_ARG to, and bad seq', () => {
    expect(() => encodePodSetStreams(1, 8)).toThrow(RangeError);
    expect(() => encodePodSetStreams(1, -1)).toThrow(RangeError);
    expect(() => encodePodSetRate(1, 15 as PodGnssRateHz)).toThrow(RangeError);
    expect(() => encodePodSetImuDecim(1, 3 as PodImuDecimation)).toThrow(RangeError);
    expect(() => encodePodGetStatus(65536)).toThrow(RangeError);
    expect(() => encodePodGetStatus(-1)).toThrow(RangeError);
    expect(() => encodePodGetStatus(1.5)).toThrow(RangeError);
    expect(() => encodePodControl(1, 0x05, new Array(17).fill(0))).toThrow(RangeError);
    expect(() => encodePodControl(1, 0x100)).toThrow(RangeError);
    expect(() => encodePodControl(1, 0x05, [256])).toThrow(RangeError);
  });

  it('generic encoder carries up to 16 argument bytes (C args[16])', () => {
    const args = Array.from({ length: 16 }, (_, i) => i);
    const f = parseOk(encodePodControl(9, 0x42, args));
    expect(f.kind === 'control' && Array.from(f.control.args)).toEqual(args);
  });
});

describe('GNSS frame (type 0x01)', () => {
  it('decodes the C sample_gnss vector to the documented units', () => {
    const bytes = frame(0x01, 0xbeef, sampleGnssPayload());
    expect(bytes.byteLength).toBe(86);
    // golden offsets from the C test
    expect(Array.from(bytes.subarray(6 + 20, 6 + 24))).toEqual([0x87, 0xea, 0xba, 0x1b]);
    expect(Array.from(bytes.subarray(6 + 32, 6 + 36))).toEqual([0x2e, 0xfb, 0xff, 0xff]);
    const f = parseOk(bytes);
    expect(f.kind).toBe('gnss');
    if (f.kind !== 'gnss') return;
    expect(f.seq).toBe(0xbeef);
    expect(f.payloadLength).toBe(78);
    const g = f.gnss;
    expect(g.podUs).toBe(0x030405060708);
    expect(g.unixUs).toBe(1790251182099999);
    expect(g.itowMs).toBe(388800100);
    expect(g.latDeg).toBeCloseTo(46.5234567, 9);
    expect(g.lonDeg).toBeCloseTo(24.4123456, 9);
    expect(g.hMslM).toBeCloseTo(-1.234, 9);
    expect(g.velNMps).toBeCloseTo(-1.234, 9);
    expect(g.velEMps).toBeCloseTo(23.456, 9);
    expect(g.velDMps).toBeCloseTo(-0.012, 9);
    expect(g.groundSpeedMps).toBeCloseTo(23.488, 9);
    expect(g.headMotDeg).toBeCloseTo(93.01234, 9);
    expect(g.hAccM).toBeCloseTo(1.234, 9);
    expect(g.vAccM).toBeCloseTo(2.345, 9);
    expect(g.sAccMps).toBeCloseTo(0.15, 9);
    expect(g.headAccDeg).toBeCloseTo(5.4321, 9);
    expect(g.tAccNs).toBe(25);
    expect(g.pDop).toBeCloseTo(1.32, 9);
    expect(g.fixType).toBe(3);
    expect(g.numSv).toBe(14);
    expect(g.flagsRaw).toBe(0xc1);
    expect(g.flags).toEqual({
      fixOk: true,
      diffSoln: false,
      invalidLlh: false,
      validDate: false,
      validTime: false,
      fullyResolved: false,
      podTimeFromPps: true,
      unixValid: true,
    });
    expect(g.rateHz).toBe(20);
  });

  it('the C vector pod_us 0x0102030405060708 (> 2^53) is refused, not rounded', () => {
    const r = parsePodFrame(frame(0x01, 1, sampleGnssPayload(0, C_SAMPLE_GNSS_POD_US)));
    expect(r).toMatchObject({ ok: false, error: 'BAD_PAYLOAD' });
    expect(r.ok === false && r.detail).toContain('pod_us');
  });

  it('accepts a longer payload from a newer minor revision (§9) and ignores the extra', () => {
    const f = parseOk(frame(0x01, 1, sampleGnssPayload(6)));
    expect(f.kind === 'gnss' && [f.payloadLength, f.gnss.numSv]).toEqual([84, 14]);
  });

  it('rejects a CRC-valid GNSS frame with a short payload', () => {
    const r = parsePodFrame(frame(0x01, 1, sampleGnssPayload().subarray(0, 77)));
    expect(r.ok === false && r.error).toBe('BAD_PAYLOAD');
  });

  it('decodes negative lat/lon and rate 0 (unverified)', () => {
    const p = sampleGnssPayload();
    const v = new DataView(p.buffer);
    v.setInt32(20, -335000000, true);
    v.setInt32(24, -1800000000, true);
    v.setUint8(77, 0);
    const f = parseOk(frame(0x01, 1, p));
    expect(f.kind === 'gnss' && [f.gnss.latDeg, f.gnss.lonDeg, f.gnss.rateHz]).toEqual([
      -33.5, -180, 0,
    ]);
  });
});

describe('IMU batch frame (type 0x02)', () => {
  it('decodes the C 13-sample vector (fits one MTU-247 notification)', () => {
    const bytes = frame(0x02, 9, sampleImuPayload(13));
    expect(bytes.byteLength).toBe(8 + 20 + 13 * 16);
    expect(bytes.byteLength).toBeLessThanOrEqual(247 - 3);
    // 0.000488f is 0x39FFDA40, LE at payload offset 8 (C test)
    expect(Array.from(bytes.subarray(6 + 8, 6 + 12))).toEqual([0x40, 0xda, 0xff, 0x39]);
    const f = parseOk(bytes);
    expect(f.kind).toBe('imu');
    if (f.kind !== 'imu') return;
    const b = f.imu;
    expect(b.t0PodUs).toBe(123456789012);
    expect(b.accGPerLsb).toBeCloseTo(0.000488, 9);
    expect(b.gyrDpsPerLsb).toBeCloseTo(0.07, 7);
    expect(b.rateHz).toBe(120);
    expect(b.count).toBe(13);
    expect(b.hwTimestamp).toBe(true);
    expect(b.samples).toHaveLength(13);
    for (let i = 0; i < 13; i++) {
      const s = b.samples[i]!;
      expect(s.dtUs).toBe(i * 8333);
      expect(s.tPodUs).toBe(123456789012 + i * 8333);
      expect(s.accRaw).toEqual([0, 1, 2].map((k) => -32768 + i * 1000 + k));
      expect(s.gyrRaw).toEqual([0, 1, 2].map((k) => 32767 - i * 1000 - k));
      expect(s.accG[0]).toBeCloseTo(s.accRaw[0] * b.accGPerLsb, 12);
      expect(s.gyrDps[2]).toBeCloseTo(s.gyrRaw[2] * b.gyrDpsPerLsb, 12);
    }
    // sample 0 acc x: -32768 LSB x 0.000488 g/LSB = -15.99 g
    expect(b.samples[0]!.accG[0]).toBeCloseTo(-15.99, 2);
  });

  it('rejects count 0, count > 32, and a payload that is not exactly 20 + 16*count', () => {
    const zero = sampleImuPayload(1);
    zero[18] = 0;
    expect(parsePodFrame(frame(0x02, 1, zero.subarray(0, 20)))).toMatchObject({
      ok: false,
      error: 'BAD_PAYLOAD',
    });
    const big = sampleImuPayload(33);
    expect(parsePodFrame(frame(0x02, 1, big))).toMatchObject({ ok: false, error: 'BAD_PAYLOAD' });
    const short = sampleImuPayload(4).subarray(0, 20 + 16 * 3);
    expect(parsePodFrame(frame(0x02, 1, short))).toMatchObject({ ok: false, error: 'BAD_PAYLOAD' });
    const long = new Uint8Array(20 + 16 * 4 + 1);
    long.set(sampleImuPayload(4));
    expect(parsePodFrame(frame(0x02, 1, long))).toMatchObject({ ok: false, error: 'BAD_PAYLOAD' });
    expect(parsePodFrame(frame(0x02, 1, new Uint8Array(19)))).toMatchObject({
      ok: false,
      error: 'BAD_PAYLOAD',
    });
  });

  it('accepts the 32-sample maximum', () => {
    const f = parseOk(frame(0x02, 1, sampleImuPayload(32)));
    expect(f.kind === 'imu' && f.imu.samples.length).toBe(32);
  });

  it('samples per frame follow the MTU (C test values)', () => {
    expect(podImuSamplesPerFrame(247)).toBe(13);
    expect(podImuSamplesPerFrame(185)).toBe(9);
    expect(podImuSamplesPerFrame(23)).toBe(0);
    expect(podImuSamplesPerFrame(517)).toBe(30);
    expect(podImuSamplesPerFrame(1000)).toBe(32);
  });
});

describe('STATUS frame (type 0x03)', () => {
  it('decodes the C status vector', () => {
    const f = parseOk(frame(0x03, 1, sampleStatusPayload()));
    expect(f.kind).toBe('status');
    if (f.kind !== 'status') return;
    expect(f.status).toEqual({
      podUs: 99,
      fwMajor: 0,
      fwMinor: 1,
      fwPatch: 2,
      hwRev: 1,
      rateHz: 10,
      hpState: 1,
      ppsState: 2,
      flagsRaw: 0x03,
      flags: {
        usbPower: true,
        gnssOk: true,
        imuOk: false,
        streamGnss: false,
        streamImu: false,
        wifiOn: false,
        chargingEnabled: false,
      },
      tbAnchorPodUs: 5000000,
      tbAnchorUnixUs: 1790251100000000,
      tbRatePpb: -20123,
      ppsAgeMs: null,
      fixType: 3,
      numSv: 12,
      imuDecim: 4,
      reserved: 0,
      txDrops: 5,
      imuOverruns: 6,
      ubxErrors: 7,
    });
  });

  it('INFO read value (seq 0xFFFF) parses like any STATUS', () => {
    const f = parseOk(frame(0x03, 0xffff, sampleStatusPayload()));
    expect(f.kind === 'status' && f.seq).toBe(0xffff);
  });

  it('pps_age_ms other than 0xFFFFFFFF is a number; longer payload accepted; short rejected', () => {
    const p = sampleStatusPayload(4);
    new DataView(p.buffer).setUint32(36, 0xfffffffe, true);
    const f = parseOk(frame(0x03, 2, p));
    expect(f.kind === 'status' && f.status.ppsAgeMs).toBe(0xfffffffe);
    expect(parsePodFrame(frame(0x03, 2, sampleStatusPayload().subarray(0, 55)))).toMatchObject({
      ok: false,
      error: 'BAD_PAYLOAD',
    });
  });

  it('rejects a u64 time that is not a safe JS integer instead of rounding it', () => {
    const p = sampleStatusPayload();
    new DataView(p.buffer).setBigUint64(0, 0xffffffffffffffffn, true);
    expect(parsePodFrame(frame(0x03, 2, p))).toMatchObject({ ok: false, error: 'BAD_PAYLOAD' });
  });
});

describe('CONTROL_RESULT (type 0x04)', () => {
  it('C vector: REFUSED_HP_NOT_SET, echo 0x1234, pod seq 55', () => {
    const f = parseOk(frame(0x04, 55, Uint8Array.from([0x02, 0x03, 0x34, 0x12])));
    expect(f.kind === 'controlResult' && f.result).toEqual({
      opcode: 2,
      result: POD_RESULT.REFUSED_HP_NOT_SET,
      resultName: 'REFUSED_HP_NOT_SET',
      echoSeq: 0x1234,
    });
  });
  it('unknown result code gets a synthetic name; short payload rejected', () => {
    const f = parseOk(frame(0x04, 1, Uint8Array.from([0x01, 0x09, 0, 0])));
    expect(f.kind === 'controlResult' && f.result.resultName).toBe('UNKNOWN_9');
    expect(parsePodFrame(frame(0x04, 1, Uint8Array.from([1, 0, 0])))).toMatchObject({
      ok: false,
      error: 'BAD_PAYLOAD',
    });
  });
});

describe('frame-level rejection', () => {
  const good = frame(0x01, 1, sampleGnssPayload());

  it('accepts the untouched frame', () => {
    expect(parsePodFrame(good).ok).toBe(true);
  });

  it('bad version (byte 0 = 2, and 0)', () => {
    for (const ver of [0, 2, 0xff]) {
      const b = good.slice();
      b[0] = ver;
      expect(parsePodFrame(b)).toMatchObject({ ok: false, error: 'BAD_VERSION' });
      // even with a CRC recomputed over the new version byte
      expect(parsePodFrame(frame(0x01, 1, sampleGnssPayload(), ver))).toMatchObject({
        ok: false,
        error: 'BAD_VERSION',
      });
    }
  });

  it('bad CRC: every single-bit flip anywhere in the frame is rejected (C test)', () => {
    for (let i = 0; i < good.byteLength; i++) {
      for (let bit = 0; bit < 8; bit++) {
        const b = good.slice();
        b[i]! ^= 1 << bit;
        expect(parsePodFrame(b).ok).toBe(false);
      }
    }
    const b = good.slice();
    b[b.byteLength - 1]! ^= 0xff;
    expect(parsePodFrame(b)).toMatchObject({ ok: false, error: 'BAD_CRC' });
    const c = good.slice();
    c[10]! ^= 0x01; // payload byte
    expect(parsePodFrame(c)).toMatchObject({ ok: false, error: 'BAD_CRC' });
  });

  it('truncated: fewer than 8 bytes, or fewer than len + 8', () => {
    expect(parsePodFrame(good.subarray(0, 5))).toMatchObject({ ok: false, error: 'TOO_SHORT' });
    expect(parsePodFrame(new Uint8Array(0))).toMatchObject({ ok: false, error: 'TOO_SHORT' });
    expect(parsePodFrame(good.subarray(0, good.byteLength - 1))).toMatchObject({
      ok: false,
      error: 'TRUNCATED',
    });
  });

  it('len overflow: declared len larger than the notification', () => {
    const b = good.slice();
    new DataView(b.buffer).setUint16(4, 0xffff, true);
    expect(parsePodFrame(b)).toMatchObject({ ok: false, error: 'TRUNCATED' });
  });

  it('trailing bytes beyond len + 8 are rejected (one frame per notification)', () => {
    const b = new Uint8Array(good.byteLength + 1);
    b.set(good);
    expect(parsePodFrame(b)).toMatchObject({ ok: false, error: 'TRAILING_BYTES' });
  });

  it('parses from a subarray with a non-zero byteOffset', () => {
    const buf = new Uint8Array(good.byteLength + 3);
    buf.set(good, 3);
    expect(parsePodFrame(buf.subarray(3)).ok).toBe(true);
  });

  it('unknown frame type is not an error: kind "unknown" carries the payload', () => {
    const f = parseOk(frame(0x05, 7, Uint8Array.from([1, 2, 3])));
    expect(f).toEqual({
      kind: 'unknown',
      type: 0x05,
      seq: 7,
      payloadLength: 3,
      payload: Uint8Array.from([1, 2, 3]),
    });
  });

  it('empty-payload frame of unknown type is valid (8 bytes)', () => {
    const f = parseOk(frame(0x7f, 0, new Uint8Array(0)));
    expect(f.kind === 'unknown' && f.payloadLength).toBe(0);
  });

  it('CONTROL with an empty payload or > 16 argument bytes is BAD_PAYLOAD (C decoder)', () => {
    expect(parsePodFrame(frame(0x80, 1, new Uint8Array(0)))).toMatchObject({
      ok: false,
      error: 'BAD_PAYLOAD',
    });
    expect(parsePodFrame(frame(0x80, 1, new Uint8Array(18)))).toMatchObject({
      ok: false,
      error: 'BAD_PAYLOAD',
    });
  });
});
