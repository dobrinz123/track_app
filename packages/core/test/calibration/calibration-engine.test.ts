import { describe, expect, it } from 'vitest';

import type { LocalPoint, LocationSample } from '../../src/contracts';
import { CalibrationEngine } from '../../src/calibration';
import { makeTestProfile, validateProfile, type RuntimeProfile } from '../../src/profile';

interface LapFixture {
  runtime: RuntimeProfile;
  samples: (options?: {
    bias?: LocalPoint;
    reverse?: boolean;
    intervalMs?: number;
    accuracy?: (index: number) => number;
    lateralNoiseM?: number;
  }) => LocationSample[];
}

function lapFixture(): LapFixture {
  const validated = validateProfile(makeTestProfile());
  if (!validated.ok) throw new Error(validated.errors.join(','));
  const { runtime } = validated;
  return {
    runtime,
    samples: (options = {}) => {
      const bias = options.bias ?? { e: 0, n: 0 };
      const intervalMs = options.intervalMs ?? 1_000;
      const lateralNoiseM = options.lateralNoiseM ?? 3;
      const spatialSamples: Array<{ point: LocalPoint; next: LocalPoint }> = [];
      for (let centerlineIndex = 0; centerlineIndex < runtime.centerline.length; centerlineIndex += 1) {
        const point = runtime.centerline[centerlineIndex] as LocalPoint;
        const next = runtime.centerline[(centerlineIndex + 1) % runtime.centerline.length] as LocalPoint;
        const segmentLength = Math.hypot(next.e - point.e, next.n - point.n);
        const steps = Math.ceil(segmentLength / 20);
        for (let step = 0; step < steps; step += 1) {
          const ratio = step / steps;
          spatialSamples.push({
            point: {
              e: point.e + (next.e - point.e) * ratio,
              n: point.n + (next.n - point.n) * ratio,
            },
            next,
          });
        }
      }
      const ordered = options.reverse
        ? [spatialSamples[0] as { point: LocalPoint; next: LocalPoint }, ...spatialSamples.slice(1).reverse()]
        : spatialSamples;
      const closed = [...ordered, ordered[0] as { point: LocalPoint; next: LocalPoint }];
      return closed.map(({ point, next }, sampleIndex) => {
        const segmentLength = Math.hypot(next.e - point.e, next.n - point.n);
        const normal = { e: -(next.n - point.n) / segmentLength, n: (next.e - point.e) / segmentLength };
        const noise = lateralNoiseM * Math.sin((sampleIndex * Math.PI * 2) / 11);
        const local = {
          e: point.e + normal.e * noise + bias.e,
          n: point.n + normal.n * noise + bias.n,
        };
        return {
          ...runtime.projection.toLatLon(local),
          tMono: sampleIndex * intervalMs,
          accuracyM: options.accuracy?.(sampleIndex) ?? 3,
          source: 'replay' as const,
        };
      });
    },
  };
}

function feedAll(engine: CalibrationEngine, samples: LocationSample[]): void {
  for (const sample of samples) engine.feed(sample);
}

describe('CalibrationEngine', () => {
  it('accepts a complete clean 1 Hz recognition lap without inventing bias', () => {
    const { runtime, samples } = lapFixture();
    const engine = new CalibrationEngine(runtime, { corridorWidthM: 20, direction: 'counterclockwise' });
    feedAll(engine, samples());
    const result = engine.finish();
    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(result.failureReasons).toEqual([]);
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.diagnostics.coverageFraction).toBeGreaterThanOrEqual(0.95);
    expect(Math.hypot(result.appliedBias.e, result.appliedBias.n)).toBeLessThan(1.5);
  });

  it('accepts a clean lap and recovers a bounded constant 3 m east bias', () => {
    const { runtime, samples } = lapFixture();
    const engine = new CalibrationEngine(runtime, { corridorWidthM: 20, direction: 'counterclockwise' });
    feedAll(engine, samples({ bias: { e: 3, n: 0 } }));
    const result = engine.finish();
    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.appliedBias.e).toBeGreaterThan(2.25);
    expect(result.appliedBias.e).toBeLessThan(3.75);
    expect(result.appliedBias.n).toBeCloseTo(0, 0);
    expect(Math.hypot(result.appliedBias.e, result.appliedBias.n)).toBeLessThanOrEqual(8);
  });

  it('rejects a partial lap for insufficient and discontinuous coverage', () => {
    const { runtime, samples } = lapFixture();
    const engine = new CalibrationEngine(runtime, { direction: 'counterclockwise' });
    feedAll(engine, samples().slice(0, 41));
    const result = engine.finish();
    expect(result.accepted).toBe(false);
    expect(result.failureReasons).toEqual(
      expect.arrayContaining(['INSUFFICIENT_COVERAGE', 'COVERAGE_GAP']),
    );
  });

  it('rejects a complete lap driven in the direction opposite to the profile', () => {
    const { runtime, samples } = lapFixture();
    const engine = new CalibrationEngine(runtime, { direction: 'counterclockwise' });
    feedAll(engine, samples({ reverse: true }));
    const result = engine.finish();
    expect(result.accepted).toBe(false);
    expect(result.failureReasons).toContain('WRONG_DIRECTION');
    expect(result.diagnostics.directionDetected).toBe('clockwise');
  });

  it('rejects heavy GNSS noise when more than 30% of samples are unreliable', () => {
    const { runtime, samples } = lapFixture();
    const engine = new CalibrationEngine(runtime, { direction: 'counterclockwise' });
    feedAll(engine, samples({ accuracy: (index) => (index % 2 === 0 ? 3 : 40) }));
    const result = engine.finish();
    expect(result.accepted).toBe(false);
    expect(result.failureReasons).toContain('POOR_GNSS');
    const total = result.diagnostics.samplesAccepted + result.diagnostics.samplesRejected;
    expect(result.diagnostics.samplesRejected / total).toBeGreaterThan(0.3);
    expect(result.diagnostics.rejectionReasons.ACCURACY_ABOVE_25M).toBeGreaterThan(0);
  });

  it('does not let off-corridor pit or paddock loitering cover centerline bins', () => {
    const { runtime, samples } = lapFixture();
    const engine = new CalibrationEngine(runtime, { direction: 'counterclockwise' });
    const loiter = samples({ bias: { e: 60, n: 60 }, lateralNoiseM: 0 });
    feedAll(engine, loiter);
    const live = engine.progress();
    const result = engine.finish();
    expect(live.coverageFraction).toBeLessThan(0.5);
    expect(result.accepted).toBe(false);
    expect(result.failureReasons).toContain('INSUFFICIENT_COVERAGE');
    expect(result.diagnostics.rejectionReasons.OFF_CORRIDOR).toBeGreaterThan(0);
  });

  it('rejects a fully covered lap observed below 0.5 Hz', () => {
    const { runtime, samples } = lapFixture();
    const engine = new CalibrationEngine(runtime, { direction: 'counterclockwise' });
    feedAll(engine, samples({ intervalMs: 2_500 }));
    const result = engine.finish();
    expect(result.diagnostics.coverageFraction).toBeGreaterThanOrEqual(0.95);
    expect(result.diagnostics.observedRateHz).toBeCloseTo(0.4, 5);
    expect(result.accepted).toBe(false);
    expect(result.failureReasons).toContain('RATE_TOO_LOW');
  });

  /** Feeds `iterations` clean, on-track samples walking repeatedly around the centerline (not all are necessarily accepted -- the odd wraparound sample can be rejected by continuity checks -- so callers read back `diagnostics.samplesAccepted` for the true count). */
  function feedClean(engine: CalibrationEngine, runtime: RuntimeProfile, iterations: number): void {
    const centerline = runtime.centerline;
    for (let index = 0; index < iterations; index += 1) {
      const point = centerline[index % centerline.length] as LocalPoint;
      engine.feed({
        ...runtime.projection.toLatLon(point),
        tMono: index * 1_000,
        accuracyM: 3,
        source: 'replay',
      });
    }
  }

  it('does not overrun while accepted samples stay under the 10,000 cap (L1 fix)', () => {
    const { runtime } = lapFixture();
    const engine = new CalibrationEngine(runtime, { corridorWidthM: 20, direction: 'counterclockwise' });
    feedClean(engine, runtime, 10_000);
    const result = engine.finish();
    expect(result.diagnostics.samplesAccepted).toBeLessThan(10_000);
    expect(result.failureReasons).not.toContain('CALIBRATION_OVERRUN');
  });

  it('caps acceptedPoints at 10,000 and force-fails with CALIBRATION_OVERRUN once exceeded (L1 fix)', () => {
    const { runtime } = lapFixture();
    const engine = new CalibrationEngine(runtime, { corridorWidthM: 20, direction: 'counterclockwise' });
    feedClean(engine, runtime, 20_000);
    const result = engine.finish();
    // Comfortably more than 10,000 samples were accepted by the pipeline
    // (proving the array would have grown past the cap without it)...
    expect(result.diagnostics.samplesAccepted).toBeGreaterThan(10_000);
    // ...yet calibration is force-failed with the overrun reason, not just
    // silently truncated.
    expect(result.accepted).toBe(false);
    expect(result.failureReasons).toContain('CALIBRATION_OVERRUN');
  });

  it('reset clears accumulated observations and progress exposes last feed state', () => {
    const { runtime, samples } = lapFixture();
    const engine = new CalibrationEngine(runtime);
    engine.feed(samples()[0] as LocationSample);
    expect(engine.progress()).toMatchObject({ onTrack: true, qualityOk: true });
    engine.reset();
    expect(engine.progress()).toEqual({ coverageFraction: 0, onTrack: false, qualityOk: false });
  });
});
