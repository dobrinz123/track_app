import { describe, expect, it } from 'vitest';

import {
  podGnssToLocationSample,
  podImuBatchToRaw,
  podImuToTelemetrySamples,
  podUsToUnixUs,
  type PodClockMapper,
  type PodMountTransform,
} from '../../../src/telemetry/pod/podMapping';
import {
  parsePodFrame,
  type PodGnss,
  type PodImuBatch,
  type PodStatus,
} from '../../../src/telemetry/pod/podProtocol';
import {
  frame,
  sampleGnssPayload,
  sampleImuPayload,
  sampleStatusPayload,
} from './podFrameBuilders';

function gnssFrom(payload: Uint8Array): PodGnss {
  const r = parsePodFrame(frame(0x01, 1, payload));
  if (!r.ok || r.frame.kind !== 'gnss') throw new Error('not gnss');
  return r.frame.gnss;
}
function imuFrom(payload: Uint8Array): PodImuBatch {
  const r = parsePodFrame(frame(0x02, 1, payload));
  if (!r.ok || r.frame.kind !== 'imu') throw new Error('not imu');
  return r.frame.imu;
}
function statusFrom(payload: Uint8Array): PodStatus {
  const r = parsePodFrame(frame(0x03, 1, payload));
  if (!r.ok || r.frame.kind !== 'status') throw new Error('not status');
  return r.frame.status;
}

/** A stand-in for the app's clock seam: fixed offset, µs -> ms. */
const clock: PodClockMapper = { podUsToMonoMs: (us) => us / 1000 + 5000 };

function gnssPayload(podUs: number, flags: number): Uint8Array {
  const p = sampleGnssPayload();
  const v = new DataView(p.buffer);
  v.setBigUint64(0, BigInt(podUs), true);
  v.setUint8(76, flags);
  return p;
}

describe('podGnssToLocationSample', () => {
  it('maps units: deg, m/s, deg, m; tMono through the clock seam; tUtc in ms', () => {
    const r = podGnssToLocationSample(gnssFrom(gnssPayload(2_000_000, 0xc1)), clock);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sample.tMono).toBe(7000);
    expect(r.sample.tUtc).toBeCloseTo(1790251182099.999, 3);
    expect(r.sample.lat).toBeCloseTo(46.5234567, 9);
    expect(r.sample.lon).toBeCloseTo(24.4123456, 9);
    expect(r.sample.speedMps).toBeCloseTo(23.488, 9);
    expect(r.sample.headingDeg).toBeCloseTo(93.01234, 9);
    expect(r.sample.accuracyM).toBeCloseTo(1.234, 9);
    expect(r.sample.altitudeM).toBeCloseTo(-1.234, 9);
    expect(r.sample.source).toBe('gnss');
    expect(r.podUs).toBe(2_000_000);
    expect(r.podTimeFromPps).toBe(true);
  });

  it('omits tUtc when unix_us is not valid, and reports receive-time stamping', () => {
    const r = podGnssToLocationSample(gnssFrom(gnssPayload(1000, 0x01)), clock);
    expect(r.ok && r.sample.tUtc).toBeUndefined();
    expect(r.ok && r.podTimeFromPps).toBe(false);
  });

  it('rejects fixes without gnssFixOK and with invalidLlh', () => {
    expect(podGnssToLocationSample(gnssFrom(gnssPayload(1, 0xc0)), clock)).toEqual({
      ok: false,
      reason: 'NO_FIX_OK',
    });
    expect(podGnssToLocationSample(gnssFrom(gnssPayload(1, 0x05)), clock)).toEqual({
      ok: false,
      reason: 'INVALID_LLH',
    });
  });
});

describe('podUsToUnixUs (§7.2 formula)', () => {
  it('locked: anchor + d + d*ppb/1e9', () => {
    const s = statusFrom(sampleStatusPayload()); // pps locked, anchor 5 s, -20123 ppb
    const d = 1_000_000;
    expect(podUsToUnixUs(5_000_000 + d, s)).toBeCloseTo(1790251100000000 + d - 20.123, 3);
    expect(podUsToUnixUs(5_000_000, s)).toBe(1790251100000000);
  });
  it('holdover free-runs; none/acquiring or no anchor -> null', () => {
    const base = statusFrom(sampleStatusPayload());
    expect(podUsToUnixUs(6_000_000, { ...base, ppsState: 3 })).not.toBeNull();
    expect(podUsToUnixUs(6_000_000, { ...base, ppsState: 0 })).toBeNull();
    expect(podUsToUnixUs(6_000_000, { ...base, ppsState: 1 })).toBeNull();
    expect(podUsToUnixUs(6_000_000, { ...base, tbAnchorPodUs: 0 })).toBeNull();
  });
});

describe('IMU mapping', () => {
  it('raw axes in g and deg/s, times in pod µs, no rotation', () => {
    const b = imuFrom(sampleImuPayload(2));
    const raw = podImuBatchToRaw(b);
    expect(raw).toHaveLength(2);
    expect(raw[1]!.tPodUs).toBe(123456789012 + 8333);
    expect(raw[0]!.accG.x).toBeCloseTo(-32768 * b.accGPerLsb, 12);
    expect(raw[0]!.accG.z).toBeCloseTo(-32766 * b.accGPerLsb, 12);
    expect(raw[1]!.gyrDps.y).toBeCloseTo((32767 - 1000 - 1) * b.gyrDpsPerLsb, 12);
  });

  it('writes latG / longG / yawRateDps rows through the mount-transform seam', () => {
    const b = imuFrom(sampleImuPayload(3));
    const raw = podImuBatchToRaw(b);
    // an example transform only (the real one is the app's): x lateral, y longitudinal,
    // compass-sense yaw = -gyro z; returns null for the first sample ("not solved yet")
    let n = 0;
    const toVehicle: PodMountTransform = (s) =>
      n++ === 0 ? null : { latG: s.accG.x, longG: s.accG.y, yawRateDps: -s.gyrDps.z };
    const rows = podImuToTelemetrySamples(raw, clock, toVehicle);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.channel)).toEqual([
      'latG',
      'longG',
      'yawRateDps',
      'latG',
      'longG',
      'yawRateDps',
    ]);
    const t1 = (123456789012 + 8333) / 1000 + 5000;
    expect(rows[0]!.tMonoMs).toBeCloseTo(t1, 9);
    expect(rows[0]!.value).toBeCloseTo(raw[1]!.accG.x, 12);
    expect(rows[1]!.value).toBeCloseTo(raw[1]!.accG.y, 12);
    expect(rows[2]!.value).toBeCloseTo(-raw[1]!.gyrDps.z, 12);
  });
});
