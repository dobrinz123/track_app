import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GRID_STEP_M,
  deltaCurveMs,
  deltaOverSegmentMs,
  forwardDistance,
  inDistanceWindow,
  joinTelemetryChannels,
  normalizeDistance,
  projectLapSamples,
  resampleLapToDistanceGrid,
  windowWraps,
} from '../../src/coaching';
import type { CornerLapSample } from '../../src/coaching';
import { driveLap } from '../../src/fixtures';
import type { TelemetrySample } from '../../src/telemetry';

import { motorpark, transilvania } from './circuits';
import { SYNTHETIC_TOTAL_LENGTH_M, syntheticLap } from './syntheticLap';

const L = SYNTHETIC_TOTAL_LENGTH_M;
const OPTIONS = { totalLengthM: L };

describe('distance helpers', () => {
  it('normalizes and measures forward distance across the start/finish line', () => {
    expect(normalizeDistance(-10, L)).toBe(990);
    expect(normalizeDistance(1_010, L)).toBe(10);
    expect(forwardDistance(980, 20, L)).toBe(40);
    expect(forwardDistance(20, 980, L)).toBe(960);
  });

  it('answers window membership and wrap for windows that span the line', () => {
    expect(inDistanceWindow(990, 950, 50, L)).toBe(true);
    expect(inDistanceWindow(10, 950, 50, L)).toBe(true);
    expect(inDistanceWindow(500, 950, 50, L)).toBe(false);
    expect(windowWraps(950, 50, L)).toBe(true);
    expect(windowWraps(100, 500, L)).toBe(false);
  });
});

describe('resampleLapToDistanceGrid', () => {
  it('puts one grid point per metre and covers a full lap', () => {
    const grid = resampleLapToDistanceGrid(syntheticLap(), OPTIONS);
    expect(grid.stepM).toBe(DEFAULT_GRID_STEP_M);
    expect(grid.distanceM).toHaveLength(L);
    expect(grid.coverageFraction).toBeGreaterThan(0.99);
    expect(grid.elapsedMs[0]).toBe(0);
  });

  it('reproduces the analytic time-at-distance of the constant-speed section', () => {
    const grid = resampleLapToDistanceGrid(syntheticLap(), OPTIONS);
    const at100 = grid.elapsedMs[100];
    const at300 = grid.elapsedMs[300];
    expect(at100).not.toBeNull();
    expect(at300).not.toBeNull();
    // 200 m at a constant 40 m/s = exactly 5 s.
    expect((at300 ?? 0) - (at100 ?? 0)).toBeCloseTo(5_000, 6);
    expect(grid.speedKph[200] ?? 0).toBeCloseTo(144, 6);
  });

  it('resamples channels and leaves uncovered distance null instead of guessing', () => {
    const partial = syntheticLap({ channels: 'pedal' }).filter((sample) => sample.distanceM < 600);
    const grid = resampleLapToDistanceGrid(partial, OPTIONS);
    expect(grid.channels.accelPedalPct?.[100]).toBeCloseTo(90, 6);
    expect(grid.channels.accelPedalPct?.[500]).toBeCloseTo(0, 6);
    expect(grid.elapsedMs[800]).toBeNull();
    expect(grid.covered[800]).toBe(false);
    expect(grid.coverageFraction).toBeGreaterThan(0.55);
    expect(grid.coverageFraction).toBeLessThan(0.65);
  });

  it('refuses a non-positive length or step and a non-finite sample', () => {
    expect(() => resampleLapToDistanceGrid([], { totalLengthM: 0 })).toThrow(RangeError);
    expect(() => resampleLapToDistanceGrid([], { ...OPTIONS, stepM: 0 })).toThrow(RangeError);
    expect(() =>
      resampleLapToDistanceGrid([{ tMonoMs: 0, distanceM: Number.NaN }], OPTIONS),
    ).toThrow(RangeError);
  });

  it('returns an empty, fully-uncovered grid for a lap with no samples', () => {
    const grid = resampleLapToDistanceGrid([], OPTIONS);
    expect(grid.coverageFraction).toBe(0);
    expect(grid.elapsedMs.every((value) => value === null)).toBe(true);
  });
});

describe('deltaCurveMs / deltaOverSegmentMs', () => {
  const reference = resampleLapToDistanceGrid(syntheticLap(), OPTIONS);
  const slower = resampleLapToDistanceGrid(syntheticLap({ speedScale: 0.9 }), OPTIONS);

  it('grows monotonically for a lap that is slower everywhere', () => {
    const delta = deltaCurveMs(slower, reference);
    const at200 = delta[200] ?? 0;
    const at800 = delta[800] ?? 0;
    expect(at200).toBeGreaterThan(0);
    expect(at800).toBeGreaterThan(at200);
  });

  it('is zero against itself, at every covered point', () => {
    const delta = deltaCurveMs(reference, reference);
    expect(delta.filter((value) => value !== null && value !== 0)).toEqual([]);
  });

  it('reports the segment contribution as the change of the delta curve', () => {
    const delta = deltaCurveMs(slower, reference);
    const segment = deltaOverSegmentMs(delta, 320, 680, { stepM: 1, totalLengthM: L });
    expect(segment).not.toBeNull();
    expect(segment ?? 0).toBeCloseTo((delta[680] ?? 0) - (delta[320] ?? 0), 9);
    expect(segment ?? 0).toBeGreaterThan(0);
  });

  it('handles a segment that wraps the start/finish line', () => {
    const delta = deltaCurveMs(slower, reference);
    const segment = deltaOverSegmentMs(delta, 950, 50, { stepM: 1, totalLengthM: L });
    expect(segment).not.toBeNull();
  });

  it('refuses grids that disagree on step or circuit length', () => {
    const other = resampleLapToDistanceGrid(syntheticLap(), { ...OPTIONS, stepM: 2 });
    expect(() => deltaCurveMs(other, reference)).toThrow(RangeError);
  });
});

describe('joinTelemetryChannels', () => {
  const samples: CornerLapSample[] = [
    { tMonoMs: 1_000, distanceM: 10 },
    { tMonoMs: 2_000, distanceM: 20 },
    { tMonoMs: 6_000, distanceM: 30 },
  ];
  const telemetry: TelemetrySample[] = [
    { channel: 'accelPedalPct', value: 80, tMonoMs: 900 },
    { channel: 'accelPedalPct', value: 12, tMonoMs: 1_900 },
    { channel: 'latG', value: 0.8, tMonoMs: 1_950 },
  ];

  it('attaches the most recent value at or before each sample', () => {
    const joined = joinTelemetryChannels(samples, telemetry);
    expect(joined[0]?.channels?.accelPedalPct).toBe(80);
    expect(joined[1]?.channels?.accelPedalPct).toBe(12);
    expect(joined[1]?.channels?.latG).toBeCloseTo(0.8, 9);
  });

  it('drops a value that has gone stale instead of carrying it forward', () => {
    const joined = joinTelemetryChannels(samples, telemetry, { maxStalenessMs: 1_000 });
    expect(joined[2]?.channels?.accelPedalPct).toBeUndefined();
    expect(joined[2]?.channels).toBeUndefined();
  });

  it('refuses a negative staleness window', () => {
    expect(() => joinTelemetryChannels(samples, telemetry, { maxStalenessMs: -1 })).toThrow(
      RangeError,
    );
  });
});

describe('projectLapSamples on real circuit geometry', () => {
  for (const circuit of [transilvania(), motorpark()]) {
    it(`projects a driven lap onto ${circuit.profile.circuitId} with monotone distances`, () => {
      const raw = driveLap(circuit.profile, {
        seed: 5_101,
        sampleRateHz: 5,
        noiseSigmaM: 1.5,
        startDistanceM: 0,
        endPaddingM: 0,
      });
      const projected = projectLapSamples(circuit.runtime, raw);
      expect(projected.samples.length).toBeGreaterThan(raw.length * 0.9);
      expect(projected.backSteps).toBe(0);
      for (const sample of projected.samples) {
        expect(sample.distanceM).toBeGreaterThanOrEqual(0);
        expect(sample.distanceM).toBeLessThan(circuit.totalLengthM);
        expect(Number.isFinite(sample.lateralM ?? 0)).toBe(true);
      }
      // One lap of samples must sweep the whole centreline once.
      const grid = resampleLapToDistanceGrid(projected.samples, {
        totalLengthM: circuit.totalLengthM,
      });
      expect(grid.coverageFraction).toBeGreaterThan(0.95);
    });
  }
});
