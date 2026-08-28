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

  it('adds the lap-end term for a segment that wraps the start/finish line (H2)', () => {
    const delta = deltaCurveMs(slower, reference);
    const segment = deltaOverSegmentMs(delta, 950, 50, { stepM: 1, totalLengthM: L });
    expect(segment).not.toBeNull();
    // A lap that is slower EVERYWHERE loses time across the 950 -> 50 m sector
    // too: the contribution is (end-of-lap - 950 m) + (50 m - start-of-lap).
    expect(segment ?? 0).toBeGreaterThan(0);
    const lapEnd = [...delta].reverse().find((value) => value !== null) ?? 0;
    const lapStart = delta.find((value) => value !== null) ?? 0;
    const expected = (lapEnd - (delta[950] ?? 0)) + ((delta[50] ?? 0) - lapStart);
    expect(segment ?? 0).toBeCloseTo(expected, 6);
  });

  it('still reports a plain forward segment as the plain delta change', () => {
    const delta = deltaCurveMs(slower, reference);
    const segment = deltaOverSegmentMs(delta, 100, 900, { stepM: 1, totalLengthM: L });
    expect(segment ?? 0).toBeCloseTo((delta[900] ?? 0) - (delta[100] ?? 0), 9);
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

/** Counts strictly decreasing steps, ignoring the single start/finish wrap. */
function backSteps(distances: readonly number[], totalLengthM: number): number {
  let count = 0;
  for (let index = 1; index < distances.length; index += 1) {
    const previous = distances[index - 1] ?? 0;
    const current = distances[index] ?? 0;
    if (current < previous && previous - current < totalLengthM / 2) count += 1;
  }
  return count;
}

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
      // "Monotone" is an assertion, not a claim: no consecutive pair may go
      // backwards (the one start/finish wrap aside).
      expect(
        backSteps(
          projected.samples.map((sample) => sample.distanceM),
          circuit.totalLengthM,
        ),
      ).toBe(0);
      // One lap of samples must sweep the whole centreline once.
      const grid = resampleLapToDistanceGrid(projected.samples, {
        totalLengthM: circuit.totalLengthM,
      });
      expect(grid.coverageFraction).toBeGreaterThan(0.95);
    });
  }

  it('clamps an accepted within-hysteresis back-step so distances never go back (M1)', () => {
    const circuit = transilvania();
    const raw = driveLap(circuit.profile, {
      seed: 5_107,
      sampleRateHz: 20,
      noiseSigmaM: 0,
      startDistanceM: 0,
      endPaddingM: 0,
    });
    // Re-play an earlier fix a few times: the projection steps ~2 m backwards,
    // well inside the 5 m hysteresis, so the sample is ACCEPTED.
    const withBackSteps = raw.flatMap((sample, index) => {
      const previous = raw[index - 1];
      if (index < 20 || index % 50 !== 0 || previous === undefined) return [sample];
      return [sample, { ...previous, tMono: sample.tMono + 20 }];
    });
    const projected = projectLapSamples(circuit.runtime, withBackSteps);
    expect(withBackSteps.length).toBeGreaterThan(raw.length);
    expect(projected.backSteps).toBe(0);
    expect(
      backSteps(
        projected.samples.map((sample) => sample.distanceM),
        circuit.totalLengthM,
      ),
    ).toBe(0);
  });

  it('reports the centreline heading so the yaw check has an implied-yaw reference (H6)', () => {
    const circuit = transilvania();
    const raw = driveLap(circuit.profile, {
      seed: 5_109,
      sampleRateHz: 5,
      noiseSigmaM: 0,
      startDistanceM: 0,
      endPaddingM: 0,
    });
    const projected = projectLapSamples(circuit.runtime, raw);
    const headings = projected.samples.map((sample) => sample.centrelineHeadingDeg);
    expect(headings.every((value) => value !== undefined && Number.isFinite(value))).toBe(true);
    // A driven lap follows the centreline: course and centreline agree closely.
    const offsets = projected.samples
      .filter((sample) => sample.headingDeg !== undefined)
      .map((sample) => {
        const delta = ((sample.centrelineHeadingDeg ?? 0) - (sample.headingDeg ?? 0) + 540) % 360;
        return Math.abs(delta - 180);
      });
    const median = [...offsets].sort((a, b) => a - b)[Math.floor(offsets.length / 2)] ?? 999;
    expect(median).toBeLessThan(10);
  });
});

describe('grid speed and t(s) (M2)', () => {
  it('derives the grid speed from ds/dt when the fixes carry no Doppler speed', () => {
    const grid = resampleLapToDistanceGrid(syntheticLap({ withoutDopplerSpeed: true }), OPTIONS);
    const coveredSpeeds = grid.speedKph.filter((_, index) => grid.covered[index] === true);
    expect(coveredSpeeds.length).toBeGreaterThan(900);
    expect(coveredSpeeds.every((value) => value !== null && Number.isFinite(value))).toBe(true);
    // The constant-speed section really is 144 km/h.
    expect(grid.speedKph[200] ?? 0).toBeCloseTo(144, 0);
    // ... and the braking section really is slower.
    expect(grid.speedKph[560] ?? 999).toBeLessThan(120);
  });

  it('keeps t(s) monotone and finite across a zero-speed interval', () => {
    const moving = syntheticLap();
    const pivot = moving.findIndex((sample) => sample.distanceM > 300);
    const source = moving[pivot];
    const stopped: CornerLapSample[] = [];
    if (source !== undefined) {
      for (let index = 1; index <= 20; index += 1) {
        stopped.push({ ...source, tMonoMs: source.tMonoMs + index * 100, speedKph: 0 });
      }
    }
    const shifted = moving
      .slice(pivot + 1)
      .map((sample) => ({ ...sample, tMonoMs: sample.tMonoMs + 2_000 }));
    const grid = resampleLapToDistanceGrid(
      [...moving.slice(0, pivot + 1), ...stopped, ...shifted],
      OPTIONS,
    );
    const covered = grid.elapsedMs.filter((value): value is number => value !== null);
    expect(covered.length).toBeGreaterThan(900);
    expect(covered.every((value) => Number.isFinite(value))).toBe(true);
    for (let index = 1; index < covered.length; index += 1) {
      expect(covered[index] ?? 0).toBeGreaterThanOrEqual(covered[index - 1] ?? 0);
    }
    // The 2 s standstill is still in the elapsed time.
    expect(covered[covered.length - 1] ?? 0).toBeGreaterThan(26_000);
  });

  it('reproduces the analytic constant-speed time exactly through the integrated profile', () => {
    const grid = resampleLapToDistanceGrid(syntheticLap(), OPTIONS);
    expect((grid.elapsedMs[300] ?? 0) - (grid.elapsedMs[100] ?? 0)).toBeCloseTo(5_000, 3);
  });
});

/**
 * A lap as lap detection really hands it over: the first fix lands a few metres
 * AFTER the start/finish line and the last one a few metres after the next
 * crossing. `t(s)` must still be measured from the crossing itself.
 */
function lapSlicedAt(startM: number, options: Parameters<typeof syntheticLap>[0] = {}) {
  const base = syntheticLap(options);
  const last = base[base.length - 1];
  const lapMs = (last?.tMonoMs ?? 0) + 100;
  return [
    ...base.filter((sample) => sample.distanceM >= startM),
    ...base
      .filter((sample) => sample.distanceM < startM)
      .map((sample) => ({ ...sample, tMonoMs: sample.tMonoMs + lapMs })),
  ];
}

describe('t(s) anchored at the start/finish crossing (H2 + M2)', () => {
  it('measures time from the S/F crossing, not from the lap’s first recorded fix', () => {
    const whole = resampleLapToDistanceGrid(syntheticLap({ speedScale: 0.9 }), OPTIONS);
    const sliced = resampleLapToDistanceGrid(lapSlicedAt(20, { speedScale: 0.9 }), OPTIONS);
    // Both grids describe the same lap; only the slicing point differs, so the
    // time at a distance must agree to within the back-extrapolated 20 m.
    for (const index of [100, 500, 900]) {
      expect(sliced.elapsedMs[index], `s=${index}`).not.toBeNull();
      expect(Math.abs((sliced.elapsedMs[index] ?? 0) - (whole.elapsedMs[index] ?? 0))).toBeLessThan(
        5,
      );
    }
    // The 20 m that belong to the NEXT lap never become "0 m of this one".
    expect(sliced.elapsedMs[0]).toBeNull();
  });

  it('reports a small positive loss on a 950 -> 50 m sector, never a full-lap negative', () => {
    const reference = resampleLapToDistanceGrid(syntheticLap(), OPTIONS);
    const slower = resampleLapToDistanceGrid(lapSlicedAt(20, { speedScale: 0.9 }), OPTIONS);
    const delta = deltaCurveMs(slower, reference);
    const segment = deltaOverSegmentMs(delta, 950, 50, { stepM: 1, totalLengthM: L });
    expect(segment).not.toBeNull();
    // 100 m at 36 m/s instead of 40 m/s is ~0.28 s lost, not a lap's worth gained.
    expect(segment ?? 0).toBeGreaterThan(100);
    expect(segment ?? 0).toBeLessThan(1_000);
  });

  it('gives 10 m at 20 m/s 0.5 s even inside a 2 s timestamp gap', () => {
    const samples: CornerLapSample[] = [];
    let tMonoMs = 0;
    for (let distanceM = 0; distanceM <= 990; distanceM += distanceM === 500 ? 10 : 20) {
      samples.push({ tMonoMs, distanceM, speedKph: 72, accuracyM: 4, lateralM: 0 });
      // The fix after 500 m arrives 2 s late although the car covered only 10 m.
      tMonoMs += distanceM === 500 ? 2_000 : 1_000;
    }
    const grid = resampleLapToDistanceGrid(samples, OPTIONS);
    expect((grid.elapsedMs[510] ?? 0) - (grid.elapsedMs[500] ?? 0)).toBeCloseTo(500, 3);
    expect((grid.elapsedMs[520] ?? 0) - (grid.elapsedMs[500] ?? 0)).toBeCloseTo(1_000, 3);
    // ... and the disagreement with the measured span is reported, not hidden.
    expect(grid.timeIntegrationDriftMs ?? 0).toBeCloseTo(-1_500, 0);
    expect(grid.timeIntegrationDriftExceeded).toBe(true);
  });

  it('reports no drift for a lap whose speed and timestamps agree', () => {
    const grid = resampleLapToDistanceGrid(syntheticLap(), OPTIONS);
    expect(grid.timeIntegrationDriftExceeded).toBe(false);
    expect(Math.abs(grid.timeIntegrationDriftMs ?? 0)).toBeLessThan(500);
  });
});
