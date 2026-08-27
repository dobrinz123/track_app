import { describe, expect, it } from 'vitest';

import { classifyLap } from '../../src/coaching';
import type { ClassifiableLap, CornerLapSample } from '../../src/coaching';

import { SYNTHETIC_TOTAL_LENGTH_M, syntheticLap } from './syntheticLap';

const OPTIONS = { totalLengthM: SYNTHETIC_TOTAL_LENGTH_M };

const LAP: ClassifiableLap = {
  lapNumber: 3,
  durationMs: 30_000,
  valid: true,
  invalidReasons: [],
  quality: 'good',
};

describe('classifyLap', () => {
  it('classifies a nominal, fully covered, on-track lap as clean', () => {
    const result = classifyLap(LAP, syntheticLap(), OPTIONS);
    expect(result.clean).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.reasons).toEqual([]);
    expect(result.lapNumber).toBe(3);
  });

  it('marks an invalid lap record incomplete without needing samples to prove it', () => {
    const result = classifyLap(
      { ...LAP, valid: false, invalidReasons: ['PIT_TRANSIT'] },
      syntheticLap(),
      OPTIONS,
    );
    expect(result.clean).toBe(false);
    expect(result.reason).toBe('incomplete');
    expect(result.detail).toContain('PIT_TRANSIT');
  });

  it('marks a lap whose samples cover only part of the track incomplete', () => {
    const partial = syntheticLap().filter((sample) => sample.distanceM < 600);
    const result = classifyLap(LAP, partial, OPTIONS);
    expect(result.clean).toBe(false);
    expect(result.reason).toBe('incomplete');
  });

  it('detects an off-track excursion from the signed lateral offset', () => {
    const samples = syntheticLap({
      lateralM: (distanceM) => (distanceM > 640 && distanceM < 660 ? -21 : 1.5),
    });
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.clean).toBe(false);
    expect(result.reason).toBe('offTrack');
    expect(result.reasons).toContain('offTrack');
  });

  it('detects a yaw spike (a real rotation far beyond what the corner implies)', () => {
    // The car keeps rotating at ~400 deg/s past the apex: a spin, not a corner.
    const samples = syntheticLap({
      headingDeg: (distanceM, index) => (distanceM > 640 ? (index * 40) % 360 : 10),
    });
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.clean).toBe(false);
    expect(result.reasons).toContain('yawSpike');
  });

  it('detects an implausible deceleration spike', () => {
    const samples: CornerLapSample[] = syntheticLap().map((sample, index) =>
      index === 120 ? { ...sample, speedKph: 5 } : sample,
    );
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.clean).toBe(false);
    expect(result.reasons).toContain('decelSpike');
  });

  it('detects poor GNSS quality over the lap', () => {
    const samples = syntheticLap({ accuracyM: (index) => (index % 2 === 0 ? 45 : 4) });
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.clean).toBe(false);
    expect(result.reasons).toContain('gnssPoor');
  });

  it('reports a deterministic primary reason when several anomalies coexist', () => {
    const samples = syntheticLap({
      accuracyM: 60,
      lateralM: () => 40,
    });
    const first = classifyLap(LAP, samples, OPTIONS);
    const second = classifyLap(LAP, samples, OPTIONS);
    expect(first).toEqual(second);
    expect(first.reasons).toContain('offTrack');
    expect(first.reasons).toContain('gnssPoor');
    // Documented priority: offTrack outranks gnssPoor.
    expect(first.reason).toBe('offTrack');
  });

  it('is UNVERIFIED, never clean, when a required safety check could not run (H5)', () => {
    const samples = syntheticLap().map(({ tMonoMs, distanceM, speedKph }) => ({
      tMonoMs,
      distanceM,
      speedKph,
    }));
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.unavailableChecks).toContain('offTrack');
    expect(result.unavailableChecks).toContain('yawSpike');
    // "On-track, no yaw anomaly, valid GNSS quality" was NOT established, so
    // the lap is not clean -- but it is not anomalous either.
    expect(result.status).toBe('unverified');
    expect(result.clean).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.reasons).toEqual([]);
  });

  it('stays anomalous (not merely unverified) when a check both ran and failed', () => {
    const samples = syntheticLap({ lateralM: () => 40 }).map(
      ({ tMonoMs, distanceM, speedKph, lateralM }) => ({ tMonoMs, distanceM, speedKph, lateralM }),
    );
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.status).toBe('anomalous');
    expect(result.reasons).toContain('offTrack');
  });

  it('marks a full-fidelity lap clean and says so in the status', () => {
    const result = classifyLap(LAP, syntheticLap(), OPTIONS);
    expect(result.status).toBe('clean');
    expect(result.unavailableChecks).toEqual([]);
  });

  it('rejects a lap whose duration is not a finite number (M6)', () => {
    for (const durationMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const result = classifyLap({ ...LAP, durationMs }, syntheticLap(), OPTIONS);
      expect(result.clean).toBe(false);
      expect(result.reasons).toContain('incomplete');
      expect(result.detail).not.toMatch(/NaN|undefined/);
    }
  });

  it('rejects a non-positive totalLengthM', () => {
    expect(() => classifyLap(LAP, [], { totalLengthM: -1 })).toThrow(RangeError);
  });
});

describe('classifyLap: yaw anomaly vs the implied yaw (H6)', () => {
  it('uses the recorded gyro yaw rate even when the course heading is steady', () => {
    const samples = syntheticLap({
      headingDeg: () => 30,
      centrelineHeadingDeg: () => 30,
    }).map((sample, index) =>
      index >= 40 && index <= 45
        ? { ...sample, channels: { ...(sample.channels ?? {}), yawRateDps: 320 } }
        : { ...sample, channels: { ...(sample.channels ?? {}), yawRateDps: 0 } },
    );
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.reasons).toContain('yawSpike');
    expect(result.detail).toMatch(/yaw/i);
  });

  it('does NOT flag a fast but geometrically implied yaw (a tight corner)', () => {
    // Course heading swings ~163 deg/s -- and so does the centreline: the car
    // is simply following the track, which is what the spec compares against.
    const swing = (distanceM: number): number =>
      distanceM < 620 ? 0 : distanceM > 680 ? 480 : (distanceM - 620) * 8;
    const samples = syntheticLap({
      headingDeg: (distanceM) => swing(distanceM),
      centrelineHeadingDeg: (distanceM) => swing(distanceM),
    });
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.reasons).not.toContain('yawSpike');
  });

  it('detects a 0.2 s spike at 5 Hz as well as at 20 Hz (sample-rate independent)', () => {
    for (const sampleRateHz of [5, 20]) {
      const spikeMs = 200;
      const samples = syntheticLap({
        sampleRateHz,
        headingDeg: () => 30,
        centrelineHeadingDeg: () => 30,
      }).map((sample, index) => {
        const spikeSamples = Math.max(2, Math.round((spikeMs / 1_000) * sampleRateHz) + 1);
        const spiking = index >= 40 && index < 40 + spikeSamples;
        return { ...sample, channels: { ...(sample.channels ?? {}), yawRateDps: spiking ? 320 : 0 } };
      });
      const result = classifyLap(LAP, samples, OPTIONS);
      expect(result.reasons, `sampleRateHz=${sampleRateHz}`).toContain('yawSpike');
    }
  });

  it('keeps the implausible-lateral-g guard: crawling-speed heading noise is not a spike', () => {
    // 0.5 m/s in the pit lane: turning the car on the spot at 200 deg/s implies
    // only ~0.2 g of lateral acceleration, which is not physically impossible.
    const samples: CornerLapSample[] = Array.from({ length: 200 }, (_value, index) => ({
      tMonoMs: index * 100,
      distanceM: index * 0.05,
      speedKph: 1.8,
      accuracyM: 4,
      lateralM: 0,
      headingDeg: (index * 20) % 360,
      centrelineHeadingDeg: 30,
    }));
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.reasons).not.toContain('yawSpike');
  });
});
