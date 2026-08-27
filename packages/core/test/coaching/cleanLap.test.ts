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

  it('detects a yaw spike (heading rate far beyond a driven corner)', () => {
    const samples = syntheticLap({
      headingDeg: (distanceM, index) => (index % 2 === 0 && distanceM > 640 ? 200 : 10),
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

  it('states which checks it could not run when the inputs lack those fields', () => {
    const samples = syntheticLap().map(({ tMonoMs, distanceM, speedKph }) => ({
      tMonoMs,
      distanceM,
      speedKph,
    }));
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.unavailableChecks).toContain('offTrack');
    expect(result.unavailableChecks).toContain('yawSpike');
    expect(result.clean).toBe(true);
  });

  it('rejects a non-positive totalLengthM', () => {
    expect(() => classifyLap(LAP, [], { totalLengthM: -1 })).toThrow(RangeError);
  });
});
