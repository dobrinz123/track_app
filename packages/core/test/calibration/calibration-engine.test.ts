import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { LocalPoint, LocationSample } from '../../src/contracts';
import { CalibrationEngine } from '../../src/calibration';
import {
  loadProfileFromJson,
  makeTestProfile,
  validateProfile,
  type RuntimeProfile,
} from '../../src/profile';

/** Loads the real, current (v2) Transilvania Motor Ring asset -- same pattern used by
 * `test/replay/replay-harness.integration.test.ts` and `test/soak/track-day.soak.test.ts`.
 * D5 (field calibration fix) scenarios run against this real, curved geometry rather
 * than the synthetic superellipse `makeTestProfile()` fixture, since the bug they pin
 * is specific to a real, unvalidated OSM centerline. */
function tmrRuntime(): RuntimeProfile {
  const json = readFileSync(
    new URL('../../assets/circuits/transilvania-motor-ring.v2.json', import.meta.url),
    'utf8',
  );
  const loaded = loadProfileFromJson(json);
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return loaded.runtime;
}

/** Deterministic xorshift32 PRNG (seeded) -- used only to generate the reproducible
 * Gaussian noise D5's binding design calls for. */
function seededUniform(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4_294_967_296;
  };
}

/** Box-Muller transform over `seededUniform`, giving a deterministic standard-normal
 * generator so tests stay reproducible without needing `Math.random()`. */
function seededGaussian(seed: number): () => number {
  const uniform = seededUniform(seed);
  return () => {
    const u1 = Math.max(uniform(), 1e-9);
    const u2 = uniform();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

interface WalkStep {
  point: LocalPoint;
  next: LocalPoint;
  distanceAlongM: number;
}

interface WalkOptions {
  /** Distance-along-centerline range to emit no samples for at all -- simulates a real
   * GPS dropout (D5c: "no GPS at all there"), not just an off-corridor stretch. */
  excludeRangeM?: { startM: number; endM: number };
}

/** Walks `runtime`'s centerline once (~20m spacing, matching `lapFixture`'s spacing
 * below), closing the loop back to the first step, and returns each step's point, its
 * segment's far endpoint (for the local tangent/normal), and its distance-along-
 * centerline. Shared by `buildDisplacedLap` and `buildTranslatedLap`. */
function walkCenterline(runtime: RuntimeProfile, options: WalkOptions = {}): WalkStep[] {
  const steps: WalkStep[] = [];
  for (let centerlineIndex = 0; centerlineIndex < runtime.centerline.length; centerlineIndex += 1) {
    const point = runtime.centerline[centerlineIndex] as LocalPoint;
    const next = runtime.centerline[(centerlineIndex + 1) % runtime.centerline.length] as LocalPoint;
    const startM = runtime.cumulativeDistancesM[centerlineIndex] ?? 0;
    const segmentLength = Math.hypot(next.e - point.e, next.n - point.n);
    const stepCount = Math.ceil(segmentLength / 20);
    for (let step = 0; step < stepCount; step += 1) {
      const ratio = step / stepCount;
      const distanceAlongM = startM + segmentLength * ratio;
      if (
        options.excludeRangeM !== undefined &&
        distanceAlongM >= options.excludeRangeM.startM &&
        distanceAlongM < options.excludeRangeM.endM
      ) {
        continue;
      }
      steps.push({
        point: {
          e: point.e + (next.e - point.e) * ratio,
          n: point.n + (next.n - point.n) * ratio,
        },
        next,
        distanceAlongM,
      });
    }
  }
  return [...steps, steps[0] as WalkStep];
}

/**
 * Walks `runtime`'s centerline, displacing each point along its own local outward
 * normal by `lateralOffsetAtM(distanceAlongM)` plus independent seeded Gaussian noise.
 * This is a geometrically uniform lateral offset (constant reading regardless of local
 * heading) -- used where the scenario itself, not bias RECOVERY, is under test (D5c's
 * clean dropout, D5d's off-corridor-but-in-wide-corridor bookkeeping). For scenarios
 * where the engine's bias estimator (a single global (e,n) translation, same model
 * `estimateBias`/`lapFixture({ bias })` already use) must recover the offset, see
 * `buildTranslatedLap` instead -- a per-point-normal offset isn't the shape that model
 * fits.
 */
function buildDisplacedLap(
  runtime: RuntimeProfile,
  lateralOffsetAtM: (distanceAlongM: number) => number,
  options: { gaussianNoiseM?: number; seed?: number; intervalMs?: number } & WalkOptions = {},
): LocationSample[] {
  const intervalMs = options.intervalMs ?? 1_000;
  const gaussian = seededGaussian(options.seed ?? 1);
  const gaussianNoiseM = options.gaussianNoiseM ?? 0;
  const closed = walkCenterline(runtime, options);
  return closed.map(({ point, next, distanceAlongM }, sampleIndex) => {
    const segmentLength = Math.hypot(next.e - point.e, next.n - point.n);
    const normal = { e: -(next.n - point.n) / segmentLength, n: (next.e - point.e) / segmentLength };
    const offset = lateralOffsetAtM(distanceAlongM) + gaussianNoiseM * gaussian();
    const local = {
      e: point.e + normal.e * offset,
      n: point.n + normal.n * offset,
    };
    return {
      ...runtime.projection.toLatLon(local),
      tMono: sampleIndex * intervalMs,
      accuracyM: 3,
      source: 'replay' as const,
    };
  });
}

/**
 * Walks `runtime`'s centerline, translating each point by a constant/sectional
 * `(e,n)` vector from `translationAtM(distanceAlongM)`, plus independent seeded
 * Gaussian noise along the local normal. A fixed `(e,n)` translation is the actual
 * shape a real "unvalidated OSM centerline vs. real driven positions" mismatch takes
 * (a coordinate-level shift, direction-independent) and is what `estimateBias` /
 * `estimateBiasFromWide` are built to recover -- so this, not `buildDisplacedLap`, is
 * what D5a/D5b (bias-recovery scenarios) use. Because the translation is a single
 * vector, its PROJECTION onto each point's local lateral direction still varies
 * (largest where local heading is perpendicular to it, near zero where heading is
 * parallel to it) -- same as the existing `lapFixture({ bias })` scenarios and exactly
 * what makes only a CONTIGUOUS stretch of a real track fall outside the corridor, as
 * the field failure this ticket fixes described.
 */
function buildTranslatedLap(
  runtime: RuntimeProfile,
  translationAtM: (distanceAlongM: number) => LocalPoint,
  options: { gaussianNoiseM?: number; seed?: number; intervalMs?: number } = {},
): LocationSample[] {
  const intervalMs = options.intervalMs ?? 1_000;
  const gaussian = seededGaussian(options.seed ?? 1);
  const gaussianNoiseM = options.gaussianNoiseM ?? 0;
  const closed = walkCenterline(runtime);
  return closed.map(({ point, next, distanceAlongM }, sampleIndex) => {
    const segmentLength = Math.hypot(next.e - point.e, next.n - point.n);
    const normal = { e: -(next.n - point.n) / segmentLength, n: (next.e - point.e) / segmentLength };
    const translation = translationAtM(distanceAlongM);
    const noise = gaussianNoiseM * gaussian();
    const local = {
      e: point.e + translation.e + normal.e * noise,
      n: point.n + translation.n + normal.n * noise,
    };
    return {
      ...runtime.projection.toLatLon(local),
      tMono: sampleIndex * intervalMs,
      accuracyM: 3,
      source: 'replay' as const,
    };
  });
}

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

  it('rejects heavy GNSS noise when more than 50% of samples are unreliable (D2: POOR_GNSS relaxed to >0.5, judged against the wide-corridor accept set)', () => {
    const { runtime, samples } = lapFixture();
    const engine = new CalibrationEngine(runtime, { direction: 'counterclockwise' });
    // 2 unreliable (accuracyM 40) for every 1 good sample -- comfortably past the new
    // 0.5 bar (a bare 50/50 split, the old pin's ratio, no longer trips it -- that's the
    // intended D2 relaxation, not a regression).
    feedAll(engine, samples({ accuracy: (index) => (index % 3 === 0 ? 3 : 40) }));
    const result = engine.finish();
    expect(result.accepted).toBe(false);
    expect(result.failureReasons).toContain('POOR_GNSS');
    const total = result.diagnostics.samplesAccepted + result.diagnostics.samplesRejected;
    expect(result.diagnostics.samplesRejected / total).toBeGreaterThan(0.5);
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

/**
 * D1/D2/D3/D5 (field calibration fix): the driver-reported failure was a systematic
 * lateral mismatch between the unvalidated OSM centerline and the real racing line
 * (see `ticket-calib-field-fix.md`), which made >=0.95 tight-corridor coverage
 * unreachable no matter how clean the lap was. These scenarios run against the real,
 * current TMR asset (`transilvania-motor-ring.v2.json`, corridorWidthM=15 in production
 * -- untouched here per D6) rather than the synthetic `makeTestProfile()` fixture.
 */
describe('CalibrationEngine — field calibration fix (wide-corridor bias correction)', () => {
  it('D5a: recovers from a constant +12m centerline offset via wide-corridor bias correction', () => {
    const runtime = tmrRuntime();
    // Tighter than the real 15m TMR corridor so the systematic offset genuinely exceeds
    // it around the whole lap -- the failure mode this ticket fixes.
    const engine = new CalibrationEngine(runtime, { corridorWidthM: 6 });
    const samples = buildTranslatedLap(runtime, () => ({ e: 12, n: 0 }), {
      gaussianNoiseM: 1.5,
      seed: 42,
    });
    for (const sample of samples) engine.feed(sample);
    const result = engine.finish();

    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(result.diagnostics.coverageFraction).toBeGreaterThanOrEqual(0.95);
    // Tight-corridor acceptedPoints stays under the <50 fallback threshold here (a
    // systematic offset exceeding corridorWidthM everywhere leaves it near-empty),
    // so this genuinely exercises `estimateBiasFromWide()`, not just `estimateBias()`.
    expect(result.diagnostics.samplesAccepted).toBeLessThan(50);
    const biasMagnitudeM = Math.hypot(result.appliedBias.e, result.appliedBias.n);
    expect(biasMagnitudeM).toBeGreaterThan(10);
    expect(biasMagnitudeM).toBeLessThan(14);
  });

  it('D5b: recovers a sectional +18m offset over a contiguous 600m stretch (5m elsewhere)', () => {
    const runtime = tmrRuntime();
    const engine = new CalibrationEngine(runtime, { corridorWidthM: 15 });
    const anomalyStartM = 1_000;
    const anomalyEndM = 1_600; // 600m contiguous
    const samples = buildTranslatedLap(
      runtime,
      (distanceAlongM) =>
        distanceAlongM >= anomalyStartM && distanceAlongM < anomalyEndM
          ? { e: 18, n: 0 }
          : { e: 5, n: 0 },
      { gaussianNoiseM: 0.8, seed: 7 },
    );
    for (const sample of samples) engine.feed(sample);
    const result = engine.finish();

    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(result.diagnostics.coverageFraction).toBeGreaterThanOrEqual(0.85);
    // Looser than a clean lap -- the (unchanged) confidence formula reflects the wider
    // lateral spread from the still-imperfectly-corrected anomalous stretch.
    expect(result.confidence).toBeLessThan(0.95);
  });

  it('D5c: a genuine 700m GPS dropout still fails INSUFFICIENT_COVERAGE + COVERAGE_GAP, gap pointing at the missing stretch', () => {
    const runtime = tmrRuntime();
    const engine = new CalibrationEngine(runtime, { corridorWidthM: 15 });
    const gapStartM = 1_500;
    const gapEndM = 2_200; // 700m with literally no samples -- bias correction cannot invent data
    const samples = buildDisplacedLap(runtime, () => 0, {
      excludeRangeM: { startM: gapStartM, endM: gapEndM },
    });
    for (const sample of samples) engine.feed(sample);
    const result = engine.finish();

    expect(result.accepted).toBe(false);
    expect(result.failureReasons).toEqual(
      expect.arrayContaining(['INSUFFICIENT_COVERAGE', 'COVERAGE_GAP']),
    );
    // Bin quantization (coverageBinM=25) plus the nearest surviving samples straddling
    // the dropout means the reported gap tracks, but need not exactly equal, the
    // excluded range -- assert it lands in the right neighborhood, not to the meter.
    const gapStartReportedM = result.diagnostics.uncoveredGapStartM as number;
    const gapEndReportedM = result.diagnostics.uncoveredGapEndM as number;
    expect(gapStartReportedM).toBeGreaterThanOrEqual(gapStartM - 150);
    expect(gapStartReportedM).toBeLessThanOrEqual(gapEndM);
    expect(gapEndReportedM).toBeGreaterThan(gapStartReportedM);
    expect(gapEndReportedM).toBeLessThanOrEqual(gapEndM + 150);
    expect(gapEndReportedM - gapStartReportedM).toBeGreaterThanOrEqual(500);
  });

  it('D5d: tight-corridor-only rejections (offset within the 40m wide corridor) do not trigger POOR_GNSS', () => {
    const runtime = tmrRuntime();
    const engine = new CalibrationEngine(runtime, { corridorWidthM: 15 });
    // ~25m off centerline everywhere -- inside the 40m wide Learn corridor, but always
    // outside the 15m tight corridor, so every sample is tight-rejected (OFF_CORRIDOR)
    // even though none of it is actually bad GNSS.
    const samples = buildDisplacedLap(runtime, () => 25, { gaussianNoiseM: 1, seed: 3 });
    for (const sample of samples) engine.feed(sample);
    const result = engine.finish();

    expect(result.diagnostics.samplesRejected).toBeGreaterThan(0);
    expect(result.diagnostics.rejectionReasons.OFF_CORRIDOR).toBeGreaterThan(0);
    expect(result.failureReasons).not.toContain('POOR_GNSS');
  });
});
