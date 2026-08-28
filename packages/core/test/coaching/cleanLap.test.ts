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

/**
 * A constant-speed lap on a straight, at a chosen sample rate: the yaw rule has
 * to behave the same way at 1 Hz and at 25 Hz, so the tests drive it directly.
 */
function straightLap(
  sampleRateHz: number,
  headingAt: (index: number) => number,
  centrelineAt?: (distanceM: number) => number,
  speedMps = 40,
): CornerLapSample[] {
  const dt = 1 / sampleRateHz;
  const samples: CornerLapSample[] = [];
  for (let index = 0; index * speedMps * dt < SYNTHETIC_TOTAL_LENGTH_M; index += 1) {
    const distanceM = index * speedMps * dt;
    samples.push({
      tMonoMs: index * dt * 1_000,
      distanceM,
      speedKph: speedMps * 3.6,
      accuracyM: 4,
      lateralM: 0,
      headingDeg: headingAt(index),
      ...(centrelineAt === undefined ? {} : { centrelineHeadingDeg: centrelineAt(distanceM) }),
    });
  }
  return samples;
}

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

  it('calls a 1 Hz lap COMPLETE: 40 m between fixes is bridged, not a hole', () => {
    // The shipped app records ~1 Hz on iPhone. A rule that needs a fix in every
    // 1 % of the lap would declare every real lap incomplete.
    const result = classifyLap(LAP, straightLap(1, () => 30), OPTIONS);
    expect(result.coverageFraction).toBeGreaterThan(0.9);
    expect(result.reasons).not.toContain('incomplete');
    expect(result.status).toBe('clean');
  });

  it('calls a 5 Hz lap complete too (the rule is not a sample-rate rule)', () => {
    const result = classifyLap(LAP, straightLap(5, () => 30), OPTIONS);
    expect(result.coverageFraction).toBeGreaterThan(0.95);
    expect(result.reasons).not.toContain('incomplete');
  });

  it('still calls a lap with a real 150 m hole incomplete', () => {
    const samples = straightLap(5, () => 30).filter(
      (sample) => !(sample.distanceM > 400 && sample.distanceM < 550),
    );
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.coverageFraction).toBeLessThan(0.9);
    expect(result.reasons).toContain('incomplete');
    expect(result.detail).toMatch(/cover/);
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

  it('needs the safety channels over the LAP, not just its first 10 % (H5)', () => {
    // Lateral offset, accuracy and heading stop after 100 m of a 1000 m lap;
    // the speed channel keeps running, so only the checks that lost their
    // evidence go unavailable.
    const samples = syntheticLap().map((sample) =>
      sample.distanceM <= 100
        ? sample
        : { tMonoMs: sample.tMonoMs, distanceM: sample.distanceM, speedKph: sample.speedKph },
    );
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.status).toBe('unverified');
    expect(result.unavailableChecks).toContain('offTrack');
    expect(result.unavailableChecks).toContain('gnssPoor');
    expect(result.unavailableChecks).toContain('yawSpike');
    expect(result.unavailableChecks).not.toContain('decelSpike');
    expect(result.checkCoverage.offTrack).toBeLessThan(0.15);
    expect(result.checkCoverage.decelSpike).toBeGreaterThan(0.9);
    // The report must be able to say HOW MUCH of the lap was covered.
    expect(result.detail).toMatch(/1[01] %/);
  });

  it('keeps a check available when its channel covers the whole lap', () => {
    const result = classifyLap(LAP, syntheticLap(), OPTIONS);
    expect(result.unavailableChecks).toEqual([]);
    for (const check of ['offTrack', 'gnssPoor', 'decelSpike', 'yawSpike', 'coverage'] as const) {
      expect(result.checkCoverage[check], check).toBeGreaterThan(0.9);
    }
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

  it('evaluates the yaw check at 1 Hz instead of skipping every window (H6)', () => {
    const spinning = straightLap(1, (index) => (index >= 10 ? 200 : 30));
    const result = classifyLap(LAP, spinning, OPTIONS);
    expect(result.unavailableChecks).not.toContain('yawSpike');
    expect(result.reasons).toContain('yawSpike');
  });

  it('leaves a clean 1 Hz lap clean of yaw (the rule evaluates, it does not fire)', () => {
    const result = classifyLap(LAP, straightLap(1, () => 30), OPTIONS);
    expect(result.unavailableChecks).not.toContain('yawSpike');
    expect(result.reasons).not.toContain('yawSpike');
  });

  it('marks the yaw check unavailable below 1 Hz instead of calling the lap clean (H6)', () => {
    // 0.8 Hz at 8 m/s: the fixes are 10 m and 1.25 s apart, so the lap is still
    // fully covered and inside the sample-gap limit -- only the yaw rule is
    // starved of the resolution a spin needs.
    const result = classifyLap(LAP, straightLap(0.8, () => 30, undefined, 8), OPTIONS);
    expect(result.unavailableChecks).toEqual(['yawSpike']);
    expect(result.status).toBe('unverified');
  });

  it('tolerates the projection lag in METRES, so a 5 Hz slide next to a vertex still counts', () => {
    // A single 35 deg OSM vertex at 388 m: the car follows it, then slides
    // 60 deg in 0.2 s two samples (16 m) later on the straight after it.
    const vertexAt = (distanceM: number): number => (distanceM >= 388 ? 35 : 0);
    const samples = straightLap(
      5,
      (index) => (index >= 51 ? 95 : index >= 49 ? 35 : 0),
      (distanceM) => vertexAt(distanceM),
    );
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.reasons).toContain('yawSpike');
  });

  it('does not invent a spike at a 35 deg vertex the car really drove, at 25 Hz', () => {
    // The centreline steps 35 deg at one vertex; the car turns the same 35 deg
    // over ~5 m around it. Two step functions, one metre out of phase.
    const samples = straightLap(
      25,
      (index) => Math.min(35, Math.max(0, (index - 248) * 11.667)),
      (distanceM) => (distanceM >= 400 ? 35 : 0),
    );
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.unavailableChecks).not.toContain('yawSpike');
    expect(result.reasons).not.toContain('yawSpike');
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
