import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { GRAVITY_MPS2, classifyLap } from '../../src/coaching';
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

  // R2-1 (contracts.md "Phase 5 REVISION 2", ticket P4c-A): a slide/rotation is
  // normal circuit driving, never an anomaly -- it becomes the informative
  // SLIDE_ROTATION label instead, and the lap stays clean.
  it('labels a yaw spike as SLIDE_ROTATION instead of anomalizing the lap (R2-1)', () => {
    // The car keeps rotating at ~400 deg/s past the apex: a spin, not a corner.
    const samples = syntheticLap({
      headingDeg: (distanceM, index) => (distanceM > 640 ? (index * 40) % 360 : 10),
    });
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.clean).toBe(true);
    expect(result.reasons).not.toContain('offTrack');
    expect(result.labels).toContain('SLIDE_ROTATION');
    expect(result.yawExcessDps).not.toBeNull();
  });

  // R2-1: heavy braking (any |longG|, the user has done 1.3 g on a GR86 and
  // cars reach 1.3-1.5 g on a circuit) is normal, never an anomaly -- it
  // becomes the informative HEAVY_BRAKING label instead.
  it('labels an implausible-looking deceleration as HEAVY_BRAKING instead of anomalizing the lap (R2-1)', () => {
    const samples: CornerLapSample[] = syntheticLap().map((sample, index) =>
      index === 120 ? { ...sample, speedKph: 5 } : sample,
    );
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.clean).toBe(true);
    expect(result.labels).toContain('HEAVY_BRAKING');
    expect(result.peakDecelG).not.toBeNull();
    expect(result.peakDecelG ?? 0).toBeGreaterThan(1.2);
  });

  it('is clean at 1.3 g (GR86 field fact) when on-track with good GPS (R2-1/A3)', () => {
    // A realistic, sustained 1.3 g braking event -- exactly the user's own
    // measured figure on a GR86 -- must never anomalize an otherwise clean lap.
    const samples = syntheticLap({
      accelAt: (distanceM) => (distanceM >= 200 && distanceM < 220 ? -1.3 * GRAVITY_MPS2 : 0),
    });
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.status).toBe('clean');
    expect(result.clean).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.labels).toContain('HEAVY_BRAKING');
    expect(result.peakDecelG ?? 0).toBeCloseTo(1.3, 1);
  });

  it('never puts yawSpike or decelSpike in reasons any more (R2-1)', () => {
    const withYaw = classifyLap(
      LAP,
      syntheticLap({ headingDeg: (distanceM, index) => (distanceM > 640 ? (index * 40) % 360 : 10) }),
      OPTIONS,
    );
    const withDecel = classifyLap(
      LAP,
      syntheticLap().map((sample, index) => (index === 120 ? { ...sample, speedKph: 5 } : sample)),
      OPTIONS,
    );
    for (const result of [withYaw, withDecel]) {
      expect(result.reasons).not.toContain('yawSpike' as never);
      expect(result.reasons).not.toContain('decelSpike' as never);
    }
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

  it('gives ~0 coverage from 90 isolated readings 61 m apart on a 6.1 km lap (Q1)', () => {
    // Each gap is 61 m -- 1 m over the 60 m bridge -- so NO pair of consecutive
    // readings is continuous evidence. A per-bucket presence flag would have
    // read this as ~90 % covered (one reading landing in each of 90 of the
    // 100 buckets); the metre-span rule reads it for what it is: a lap with no
    // bridgeable evidence anywhere.
    const totalLengthM = 6_100;
    const samples: CornerLapSample[] = Array.from({ length: 90 }, (_value, index) => ({
      tMonoMs: index * 10_000,
      distanceM: index * 61,
      speedKph: 144,
      accuracyM: 4,
      lateralM: 0,
    }));
    const result = classifyLap(LAP, samples, { totalLengthM });
    expect(result.coverageFraction).toBeLessThan(0.02);
    expect(result.reasons).toContain('incomplete');
    expect(result.status).not.toBe('clean');
  });

  it('gives >= 0.95 coverage for a dense 1 Hz lap at 40 m/s (Q1)', () => {
    // 40 m between fixes, well inside the 60 m bridge: nearly the whole lap is
    // one continuous bridged span.
    const result = classifyLap(LAP, straightLap(1, () => 30), OPTIONS);
    expect(result.coverageFraction).toBeGreaterThanOrEqual(0.95);
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
    // R2-1: a yaw spike is the informative SLIDE_ROTATION label now, never an
    // anomaly reason -- the lap stays clean and the numeric excess is exposed
    // directly rather than folded into the anomaly `detail` string.
    expect(result.labels).toContain('SLIDE_ROTATION');
    expect(result.clean).toBe(true);
    expect(result.yawExcessDps).not.toBeNull();
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
    expect(result.labels).not.toContain('SLIDE_ROTATION');
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
      expect(result.labels, `sampleRateHz=${sampleRateHz}`).toContain('SLIDE_ROTATION');
    }
  });

  it('evaluates the yaw check at 1 Hz instead of skipping every window (H6)', () => {
    const spinning = straightLap(1, (index) => (index >= 10 ? 200 : 30));
    const result = classifyLap(LAP, spinning, OPTIONS);
    expect(result.unavailableChecks).not.toContain('yawSpike');
    expect(result.labels).toContain('SLIDE_ROTATION');
  });

  it('leaves a clean 1 Hz lap clean of yaw (the rule evaluates, it does not fire)', () => {
    const result = classifyLap(LAP, straightLap(1, () => 30), OPTIONS);
    expect(result.unavailableChecks).not.toContain('yawSpike');
    expect(result.labels).not.toContain('SLIDE_ROTATION');
  });

  // R2-1 (changed from the pre-REVISION-2 behaviour): yawSpike is no longer a
  // required safety check -- it only feeds the informational SLIDE_ROTATION
  // label now, so its unavailability never blocks CLEAN status any more. The
  // coverage/availability MECHANISM itself is untouched (still reported via
  // `unavailableChecks`, per A4) -- only what GATES `status` changed.
  it('keeps the lap clean when only the (now informational) yaw check is unavailable below 1 Hz (H6, R2-1)', () => {
    // 0.8 Hz at 8 m/s: the fixes are 10 m and 1.25 s apart, so the lap is still
    // fully covered and inside the sample-gap limit -- only the yaw rule is
    // starved of the resolution a spin needs.
    const result = classifyLap(LAP, straightLap(0.8, () => 30, undefined, 8), OPTIONS);
    expect(result.unavailableChecks).toEqual(['yawSpike']);
    expect(result.status).toBe('clean');
    expect(result.labels).not.toContain('SLIDE_ROTATION');
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
    expect(result.labels).toContain('SLIDE_ROTATION');
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
    expect(result.labels).not.toContain('SLIDE_ROTATION');
  });

  it('marks yaw unavailable when >10% of the lap sits behind >1000 ms gaps, even though the MEDIAN interval is exactly 1000 ms (H6/Q2)', () => {
    // Repeating 1000/1000/1200 ms intervals: the median interval is 1000 ms --
    // AT the old threshold, not over it -- so the old median-gated rule left
    // the check silently "available". Judged per interval, the 1200 ms gaps
    // alone span well over 10 % of the lap distance, and every other check
    // (constant speed/lateral/accuracy, gaps always <= 48 m) stays available:
    // only the yaw check is starved of time resolution.
    const speedMps = 40;
    const pattern = [1000, 1000, 1200];
    const samples: CornerLapSample[] = [];
    let tMs = 0;
    let distanceM = 0;
    let index = 0;
    while (distanceM < SYNTHETIC_TOTAL_LENGTH_M) {
      samples.push({
        tMonoMs: tMs,
        distanceM,
        speedKph: speedMps * 3.6,
        accuracyM: 4,
        lateralM: 0,
        headingDeg: 30,
        centrelineHeadingDeg: 30,
      });
      const dtMs = pattern[index % pattern.length] ?? 1000;
      tMs += dtMs;
      distanceM += (dtMs / 1_000) * speedMps;
      index += 1;
    }
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.unavailableChecks).toContain('yawSpike');
    expect(result.unavailableChecks).not.toContain('offTrack');
    expect(result.unavailableChecks).not.toContain('decelSpike');
    expect(result.unavailableChecks).not.toContain('gnssPoor');
    // R2-1: yawSpike alone being unavailable no longer blocks CLEAN status --
    // only offTrack/gnssPoor/coverage still gate it (the per-interval coverage
    // MECHANISM this test protects is unchanged; only its consequence is).
    expect(result.status).toBe('clean');
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
    expect(result.labels).not.toContain('SLIDE_ROTATION');
  });
});

describe('classifyLap: ABS-like oscillation (R2-1)', () => {
  /** A braking zone (400-600 m, matching syntheticLap's own profile) whose
   * accelerometer longG pulses rapidly between a strong bite and a release --
   * the signature of ABS modulation, not a single hard stop. */
  function absPulseAccelAt(distanceM: number): number {
    if (distanceM < 400 || distanceM >= 600) return 0;
    const cyclePos = ((distanceM - 400) / 8) % 1; // ~5 Hz worth of pulses at 40 m/s
    return cyclePos < 0.5 ? -1.4 * GRAVITY_MPS2 : -0.3 * GRAVITY_MPS2;
  }

  it('detects ABS-like oscillation from the accelerometer longG channel and labels it, without anomalizing the lap', () => {
    const samples = syntheticLap({ channels: 'imu', accelAt: absPulseAccelAt });
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.labels).toContain('ABS_SUSPECTED');
    expect(result.clean).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('does NOT detect ABS oscillation on a single smooth hard brake (no pulsing)', () => {
    const samples = syntheticLap({ channels: 'imu' }); // default profile: one steady -3 m/s^2 braking zone
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.labels).not.toContain('ABS_SUSPECTED');
    expect(result.absOscillationDetected).toBe(false);
  });

  it('does NOT detect ABS oscillation from noise while not braking', () => {
    const samples = syntheticLap({ channels: 'imu', accelAt: () => 0 });
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.labels).not.toContain('ABS_SUSPECTED');
  });

  it('is unavailable (never falsely detected) with no accelerometer longG channel at all', () => {
    const samples = syntheticLap({ accelAt: absPulseAccelAt }); // channels: 'none' (default)
    const result = classifyLap(LAP, samples, OPTIONS);
    expect(result.labels).not.toContain('ABS_SUSPECTED');
    expect(result.absOscillationDetected).toBe(false);
  });
});

/**
 * Ticket P5-FIX-ABS (Codex P5-REV finding 13): `evaluateAbsOscillation` /
 * `countSwings` were rewritten as a single-pass monotonic two-pointer /
 * streaming window (persisted `end`, O(1) prefix-sum average, no per-window
 * slice/map allocation, early exit at `minCycles`) instead of the OLD version,
 * which re-derived `end` from `start` and re-sliced/re-reduced the window on
 * every outer step -- worst-case O(n^2) when many samples land within one
 * `absWindowMs` of each other.
 *
 * The OLD implementation is ported here VERBATIM (renamed) as an oracle: it
 * is deliberately kept exactly as it was, including its own quadratic cost,
 * so the property test below can assert the two versions agree on the
 * VERDICT (`absOscillationDetected`) across random series without asserting
 * anything about the old version's performance.
 */
function oldCountSwings(values: readonly number[], minSwing: number): number {
  if (values.length === 0) return 0;
  let cycles = 0;
  let lastExtreme = values[0] ?? 0;
  let direction: -1 | 0 | 1 = 0;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1] ?? 0;
    const current = values[index] ?? 0;
    const delta = current - previous;
    if (delta === 0) continue;
    const dir: 1 | -1 = delta > 0 ? 1 : -1;
    if (direction === 0) {
      lastExtreme = previous;
    } else if (dir !== direction) {
      const swing = Math.abs(previous - lastExtreme);
      if (swing >= minSwing) {
        cycles += 1;
        lastExtreme = previous;
      }
    }
    direction = dir;
  }
  return cycles;
}

function oldFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function oldEvaluateAbsOscillation(
  samples: readonly CornerLapSample[],
  swingG: number,
  minCycles: number,
  windowMs: number,
  minAvgDecelG: number,
): { available: boolean; detected: boolean } {
  const series: { tMonoMs: number; g: number }[] = [];
  for (const sample of samples) {
    const g = sample.channels?.longG;
    if (oldFinite(g)) series.push({ tMonoMs: sample.tMonoMs, g });
  }
  if (series.length < minCycles + 2) return { available: false, detected: false };

  for (let start = 0; start < series.length; start += 1) {
    let end = start;
    const startEntry = series[start];
    if (startEntry === undefined) continue;
    while (end + 1 < series.length && (series[end + 1]?.tMonoMs ?? 0) - startEntry.tMonoMs <= windowMs) {
      end += 1;
    }
    if (end === start) continue;
    const windowValues = series.slice(start, end + 1);
    const avgG = windowValues.reduce((sum, entry) => sum + entry.g, 0) / windowValues.length;
    if (avgG > -minAvgDecelG) continue;
    const cycles = oldCountSwings(
      windowValues.map((entry) => entry.g),
      swingG,
    );
    if (cycles >= minCycles) return { available: true, detected: true };
  }
  return { available: true, detected: false };
}

describe('classifyLap: ABS oscillation streaming rewrite (P5-FIX-ABS, property + perf)', () => {
  const rawSampleArb = fc.record({
    dtMs: fc.integer({ min: 0, max: 400 }),
    g: fc.double({ min: Math.fround(-3), max: Math.fround(3), noNaN: true }),
    present: fc.boolean(),
  });

  const absParamsArb = fc.record({
    absSwingG: fc.double({ min: Math.fround(0.05), max: Math.fround(1), noNaN: true }),
    absMinCycles: fc.integer({ min: 1, max: 6 }),
    absWindowMs: fc.integer({ min: 20, max: 2_000 }),
    absMinAvgDecelG: fc.double({ min: 0, max: Math.fround(1), noNaN: true }),
  });

  function buildSamples(spec: readonly { dtMs: number; g: number; present: boolean }[]): CornerLapSample[] {
    let tMonoMs = 0;
    return spec.map((entry, index) => {
      tMonoMs += entry.dtMs;
      return {
        tMonoMs,
        distanceM: index,
        ...(entry.present ? { channels: { longG: entry.g } } : {}),
      };
    });
  }

  it('matches the OLD from-scratch implementation on random series (property, oracle)', () => {
    fc.assert(
      fc.property(
        fc.array(rawSampleArb, { minLength: 0, maxLength: 250 }),
        absParamsArb,
        (spec, params) => {
          const samples = buildSamples(spec);
          const oracle = oldEvaluateAbsOscillation(
            samples,
            params.absSwingG,
            params.absMinCycles,
            params.absWindowMs,
            params.absMinAvgDecelG,
          );
          const result = classifyLap(
            LAP,
            samples,
            { totalLengthM: Math.max(1, samples.length), ...params },
          );
          expect(result.absOscillationDetected).toBe(oracle.detected);
          expect(result.labels.includes('ABS_SUSPECTED')).toBe(oracle.detected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('handles 50 000 samples of realistic, ABS-pulsing telemetry in well under 2 s', () => {
    const n = 50_000;
    const samples: CornerLapSample[] = new Array(n);
    // 200 Hz (5 ms apart) -- a realistic high-rate accelerometer feed -- with
    // a sustained ~5 Hz brake-release-reapply pulse throughout, so genuine
    // detections are found (and the swing scan can early-exit) rather than
    // scanning every window to exhaustion.
    for (let index = 0; index < n; index += 1) {
      const tMonoMs = index * 5;
      const cyclePos = (index % 40) / 40; // ~5 Hz worth of pulses at 200 Hz
      const g = cyclePos < 0.5 ? -1.4 * GRAVITY_MPS2 : -0.3 * GRAVITY_MPS2;
      samples[index] = { tMonoMs, distanceM: index, channels: { longG: g } };
    }
    const start = Date.now();
    const result = classifyLap(LAP, samples, { totalLengthM: n });
    const elapsedMs = Date.now() - start;
    expect(result.absOscillationDetected).toBe(true);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('handles 50 000 samples clustered within one window (the exact worst case the rewrite targets) in well under 2 s', () => {
    // Every sample sits within `absWindowMs` (700 ms default) of every other
    // one, at a CONSTANT (non-braking) g -- the pathological input where the
    // OLD implementation re-derived and re-scanned an ~n-sized window from
    // scratch for every one of the n starting points (O(n^2)). The average
    // guard fails immediately here, so this isolates the two-pointer +
    // prefix-sum fix (the window-boundary/average side of the rewrite) from
    // the swing-scan side.
    const n = 50_000;
    const samples: CornerLapSample[] = new Array(n);
    // Strictly increasing (monotonic, as real telemetry always is) but the
    // WHOLE 50 000-sample span is under 700 ms, so every start's window
    // reaches all the way to the end -- the exact shape that made the OLD
    // per-start `end = start; while (...) end += 1` re-derivation quadratic.
    for (let index = 0; index < n; index += 1) {
      samples[index] = { tMonoMs: index * 0.01, distanceM: index, channels: { longG: 0 } };
    }
    const start = Date.now();
    const result = classifyLap(LAP, samples, { totalLengthM: n });
    const elapsedMs = Date.now() - start;
    expect(result.absOscillationDetected).toBe(false);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
