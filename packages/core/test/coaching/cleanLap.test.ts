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
