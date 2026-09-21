import { describe, expect, it } from 'vitest';

import { classifyLap } from '../../src/coaching';
import type { ClassifiableLap, CornerLapSample } from '../../src/coaching';

import { SYNTHETIC_TOTAL_LENGTH_M } from './syntheticLap';
import { driveCircuitSession, motorpark, transilvania, type TestCircuit } from './circuits';

/**
 * Ticket P7D R3 — THE YAW SOURCE IS CHOSEN PER WINDOW, NOT ONCE PER LAP.
 *
 * `evaluateYaw` used to decide `useGyro = gyroCount >= 2` for the whole lap:
 * two finite `yawRateDps` samples ANYWHERE in it handed every window to the
 * gyro, and every window the gyro did not cover then measured nothing at all,
 * because a partly-covered integral returns `null`. An independent reviewer
 * measured the consequence, and the first test below reproduces it exactly: a
 * heading trace with a real 250 deg/s excursion reports `SLIDE_ROTATION`; add
 * two zero-yaw gyro samples at the very start and the label DISAPPEARS, the
 * excess goes `null`, and the check reports itself unavailable over 0.4 % of
 * a lap whose heading covers 99.6 %. A safety-relevant label deleted in
 * silence, by data that added information rather than removing any.
 *
 * The fix chooses per window: the gyro wherever it ADEQUATELY COVERS that
 * window (every interval inside it carrying a finite rate and a positive dt —
 * see `integratedGyroTurn` for why the threshold is 100 % and cannot
 * sensibly be anything else), GNSS heading everywhere else.
 *
 * The regression that would actually reach a user is the OPPOSITE direction,
 * so it gets the most evidence here: every lap this app has ever recorded has
 * NO `yawRateDps` at all, the flag having never been on. Those laps must come
 * out bit-identical, and the numbers pinned below were measured on the code
 * as it stood BEFORE this change.
 */

const LAP: ClassifiableLap = {
  lapNumber: 3,
  durationMs: 30_000,
  valid: true,
  invalidReasons: [],
  quality: 'good',
};

const OPTIONS = { totalLengthM: SYNTHETIC_TOTAL_LENGTH_M };

/** A constant-speed lap on a straight, at a chosen rate, carrying heading only. */
function straightLap(
  sampleRateHz: number,
  headingAt: (index: number) => number,
  speedMps = 40,
): CornerLapSample[] {
  const dt = 1 / sampleRateHz;
  const samples: CornerLapSample[] = [];
  for (let index = 0; index * speedMps * dt < SYNTHETIC_TOTAL_LENGTH_M; index += 1) {
    samples.push({
      tMonoMs: index * dt * 1_000,
      distanceM: index * speedMps * dt,
      speedKph: speedMps * 3.6,
      accuracyM: 4,
      lateralM: 0,
      headingDeg: headingAt(index),
    });
  }
  return samples;
}

/** Heading holds, then swings 100 deg over 400 ms (250 deg/s), then holds again. */
const SPIKE_HEADING = (index: number): number =>
  index < 20 ? 0 : index < 24 ? (index - 20 + 1) * 25 : 100;

/** A flat sweep no faster than the rule's 150 deg/s default. */
const SWEEP_HEADING = (index: number): number => index * 3;

const yawFacts = (result: ReturnType<typeof classifyLap>) => ({
  status: result.status,
  labels: result.labels,
  yawExcessDps: result.yawExcessDps,
  unavailableChecks: result.unavailableChecks,
  yawCoverage: result.checkCoverage.yawSpike,
});

describe('P7D R3 -- the reviewer scenario: two stray gyro samples must not delete a real rotation', () => {
  const headingOnly = straightLap(10, SPIKE_HEADING);
  /** The SAME lap with two zero-yaw gyro samples bolted onto the first two fixes. */
  const withTwoZeroGyroSamples = headingOnly.map((sample, index) =>
    index < 2 ? { ...sample, channels: { yawRateDps: 0 } } : sample,
  );

  it('the heading-only lap reports the 250 deg/s excursion (the behaviour being protected)', () => {
    const result = classifyLap(LAP, headingOnly, OPTIONS);
    expect(result.labels).toContain('SLIDE_ROTATION');
    expect(result.yawExcessDps).toBeCloseTo(250, 9);
    expect(result.unavailableChecks).not.toContain('yawSpike');
    expect(result.checkCoverage.yawSpike).toBeCloseTo(0.996, 12);
  });

  it('adding two zero-yaw gyro samples changes NOTHING -- it used to erase the label entirely', () => {
    const poisoned = classifyLap(LAP, withTwoZeroGyroSamples, OPTIONS);
    // Measured on the pre-fix code, for the record:
    //   labels []           (was ['SLIDE_ROTATION'])
    //   yawExcessDps null   (was 250.0000000000002)
    //   unavailableChecks ['yawSpike'], coverage 0.004 (was [], 0.996)
    expect(poisoned.labels).toContain('SLIDE_ROTATION');
    expect(poisoned.yawExcessDps).toBeCloseTo(250, 9);
    expect(poisoned.unavailableChecks).not.toContain('yawSpike');
    expect(poisoned.checkCoverage.yawSpike).toBeCloseTo(0.996, 12);
    // And not merely "close": the two laps are the same report.
    expect(yawFacts(poisoned)).toEqual(yawFacts(classifyLap(LAP, headingOnly, OPTIONS)));
  });

  it('ONE gyro sample missing inside the excursion falls back to heading, it does not under-integrate', () => {
    // A swing of exactly one 200 ms window: 50 deg over indices 20 -> 22, so
    // the ONLY window that can see 250 deg/s is [20, 22] (its neighbours span
    // 25 deg, i.e. 125 deg/s, under the 150 deg/s default). The gyro carries
    // every sample of the lap EXCEPT index 21, in the middle of that one
    // window. Its record of the swing is therefore a fragment, and there is
    // no honest way to integrate a fragment: the window is handed to the
    // heading, which observed the whole of it. Pre-fix, the lap-wide
    // `useGyro` skipped the window and reported nothing at all.
    const swing = (index: number): number => (index <= 20 ? 0 : index === 21 ? 25 : 50);
    const rateDps = (index: number): number => (swing(index + 1) - swing(index)) * 10;
    const holed = straightLap(10, swing).map((sample, index) =>
      index === 21 ? sample : { ...sample, channels: { yawRateDps: rateDps(index) } },
    );
    const result = classifyLap(LAP, holed, OPTIONS);
    expect(result.labels).toContain('SLIDE_ROTATION');
    expect(result.yawExcessDps).toBeCloseTo(250, 6);
    expect(result.unavailableChecks).not.toContain('yawSpike');
  });

  it('where the gyro DOES cover a window it still wins: a rotation only it saw is reported', () => {
    // Heading is flat for the whole lap; the gyro alone turns. If the window
    // preferred heading this would be invisible. (The complementary property
    // -- that the gyro is not consulted where it has no evidence -- is the
    // two tests above.)
    const flat = straightLap(10, () => 0);
    const gyroOnly = flat.map((sample, index) => ({
      ...sample,
      channels: { yawRateDps: index >= 20 && index < 24 ? 250 : 0 },
    }));
    const result = classifyLap(LAP, gyroOnly, OPTIONS);
    expect(result.labels).toContain('SLIDE_ROTATION');
    expect(result.yawExcessDps).toBeGreaterThan(150);
    expect(classifyLap(LAP, flat, OPTIONS).labels).not.toContain('SLIDE_ROTATION');
  });
});

/**
 * THE NO-GYRO INVARIANT. Every lap ever recorded by this app is in this shape,
 * and every number below was measured on the pre-P7D code.
 */
describe('P7D R3 -- laps with no yawRateDps at all are untouched (pinned against pre-fix values)', () => {
  const RATES = [1, 2, 5, 10, 25] as const;
  /** Pre-fix `checkCoverage.yawSpike` for a heading-only lap at each rate. */
  const COVERAGE: Record<number, number> = { 1: 0.96, 2: 0.98, 5: 0.992, 10: 0.996, 25: 0.9984 };

  for (const hz of RATES) {
    it(`heading-only at ${hz} Hz: coverage, labels and excess are the pre-fix ones`, () => {
      const straight = classifyLap(LAP, straightLap(hz, () => 0), OPTIONS);
      const sweep = classifyLap(LAP, straightLap(hz, SWEEP_HEADING), OPTIONS);
      const spike = classifyLap(LAP, straightLap(hz, SPIKE_HEADING), OPTIONS);
      for (const result of [straight, sweep, spike]) {
        expect(result.status).toBe('clean');
        expect(result.unavailableChecks).toEqual([]);
        expect(result.checkCoverage.yawSpike).toBeCloseTo(COVERAGE[hz]!, 12);
      }
      expect(straight.labels).toEqual([]);
      expect(straight.yawExcessDps).toBeNull();
      expect(sweep.labels).toEqual([]);
      expect(sweep.yawExcessDps).toBeNull();
      // The spike is only resolvable once the rate can see inside 400 ms.
      if (hz >= 10) {
        expect(spike.labels).toEqual(['SLIDE_ROTATION']);
        expect(spike.yawExcessDps).toBeCloseTo(hz === 10 ? 250 : 500, 9);
      } else {
        expect(spike.labels).toEqual([]);
        expect(spike.yawExcessDps).toBeNull();
      }
    });
  }

  const CIRCUITS: readonly { name: string; load: () => TestCircuit }[] = [
    { name: 'transilvania-motor-ring', load: transilvania },
    { name: 'motorpark-romania', load: motorpark },
  ];

  for (const { name, load } of CIRCUITS) {
    // `'none'`/`'tier1'` carry NO gyro; `'tier2'` carries it on every sample.
    // Both ends of the range are pinned: the laps that exist today, and the
    // continuous-coverage laps whose behaviour the fix had to preserve.
    for (const tier of ['none', 'tier1', 'tier2'] as const) {
      it(`${name} / channels=${tier}: the same clean report as before the change`, () => {
        const circuit = load();
        const session = driveCircuitSession(circuit, { laps: 2, channels: tier, seed: 6_301 });
        const gyroSamples = session
          .flatMap((input) => input.samples)
          .filter((sample) => Number.isFinite(sample.channels?.yawRateDps)).length;
        // The fixture has to BE what the case claims it is.
        if (tier === 'tier2') expect(gyroSamples).toBeGreaterThan(1_000);
        else expect(gyroSamples).toBe(0);

        const results = session.map((input) =>
          classifyLap(input.lap, input.samples, { totalLengthM: circuit.totalLengthM }),
        );
        for (const result of results) {
          expect(result.status).toBe('clean');
          expect(result.labels).toEqual([]);
          expect(result.yawExcessDps).toBeNull();
          expect(result.unavailableChecks).toEqual([]);
          expect(result.checkCoverage.yawSpike).toBeGreaterThan(0.99);
        }
        // Pre-fix coverage, to 12 places: lap 0 of motorpark is the only one
        // of the four that is not exactly 1.
        //
        // The motorpark figure moved once since this pin was written, and NOT
        // because R3's behaviour changed: ticket P7G resampled that circuit's
        // centerline along fitted arcs (102 -> 230 points, longest segment
        // 237 m -> 21.9 m), which raised coverage from 0.9989086979942551 to
        // the value below. Coverage going UP on a denser centerline is the
        // expected direction. The pin is kept at 12 places deliberately -- it
        // is here to catch a silent regression in R3, so it should fail loudly
        // whenever anything moves it, and be re-pinned only with a reason like
        // this one recorded beside it.
        const coverages = results.map((result) => result.checkCoverage.yawSpike);
        const expected =
          name === 'motorpark-romania' ? [0.9999660637603721, 1] : [1, 1];
        coverages.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 12));
      });
    }
  }
});
