/**
 * Ticket P11C -- the two reproductions the reviewer filed against P9-FIX2, and
 * the property they are points of.
 *
 * Both were HIGH, and they are a matched pair: the SAME occupancy latch that
 * let finding 1 invent two unmarked laps out of one pit transit made finding 2
 * delete a real on-track boundary. Three rounds of thresholds each got beaten
 * by a wider perturbation, so the threshold is gone: a timing-gate crossing is
 * always emitted, and pit evidence decides only whether it is marked.
 *
 * What that makes checkable is the sweep at the bottom. "A real boundary can
 * never be deleted" is true by construction here -- `CrossingDetector.update`
 * has no path that drops a timing-gate crossing on pit evidence -- and the
 * sweep is the empirical statement of the same thing over biases of 5, 8, 10
 * and 15 m, windows of 3, 9, 20 and 30 consecutive fixes, at every position
 * around the lap, on both circuits.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { CircuitProfile, LapRecord, LocationSample } from '../../src/contracts';
import { driveLap, motorparkPitLaneTransitLap, multiLapSession, pitLaneTransitLap } from '../../src/fixtures';
import { projectOntoPolyline } from '../../src/geometry';
import { TrackMatcher } from '../../src/matching';
import { loadProfileFromJson, type RuntimeProfile } from '../../src/profile';
import { runSessionPipeline } from '../../src/replay';

function load(file: string): { profile: CircuitProfile; runtime: RuntimeProfile } {
  const json = readFileSync(new URL(`../../assets/circuits/${file}`, import.meta.url), 'utf8');
  const loaded = loadProfileFromJson(json);
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return { profile: loaded.profile, runtime: loaded.runtime };
}

const tmr = load('transilvania-motor-ring.v2.json');
const motorpark = load('motorpark-romania.v1.json');

function withoutSpeed(samples: readonly LocationSample[]): LocationSample[] {
  return samples.map((sampleIn) => {
    const stripped: LocationSample = { ...sampleIn };
    delete stripped.speedMps;
    return stripped;
  });
}

/** Moves the named fixes `metres` toward their projection on the centerline. */
function nudgeTowardCenterline(
  runtime: RuntimeProfile,
  samples: readonly LocationSample[],
  indices: readonly number[],
  metres: number,
): LocationSample[] {
  const chosen = new Set(indices);
  return samples.map((sampleIn, index) => {
    if (!chosen.has(index)) return sampleIn;
    const point = runtime.projection.toLocal({ lat: sampleIn.lat, lon: sampleIn.lon });
    const onCenterline = projectOntoPolyline(
      point,
      runtime.centerline,
      runtime.cumulativeDistancesM,
      true,
    ).point;
    const deltaE = onCenterline.e - point.e;
    const deltaN = onCenterline.n - point.n;
    const separationM = Math.hypot(deltaE, deltaN);
    if (separationM === 0) return sampleIn;
    return {
      ...sampleIn,
      ...runtime.projection.toLatLon({
        e: point.e + (deltaE / separationM) * metres,
        n: point.n + (deltaN / separationM) * metres,
      }),
    };
  });
}

/** Moves the named fixes `metres` toward their projection on the PIT polyline. */
function nudgeTowardPitLane(
  runtime: RuntimeProfile,
  samples: readonly LocationSample[],
  indices: readonly number[],
  metres: number,
): LocationSample[] {
  const pit = runtime.pitLane;
  if (pit === undefined) throw new Error('circuit has no pit lane');
  const chosen = new Set(indices);
  return samples.map((sampleIn, index) => {
    if (!chosen.has(index)) return sampleIn;
    const point = runtime.projection.toLocal({ lat: sampleIn.lat, lon: sampleIn.lon });
    const onPit = projectOntoPolyline(point, pit.polyline, pit.cumulativeDistancesM, false).point;
    const deltaE = onPit.e - point.e;
    const deltaN = onPit.n - point.n;
    const separationM = Math.hypot(deltaE, deltaN);
    if (separationM === 0) return sampleIn;
    return {
      ...sampleIn,
      ...runtime.projection.toLatLon({
        e: point.e + (deltaE / separationM) * metres,
        n: point.n + (deltaN / separationM) * metres,
      }),
    };
  });
}

const seconds = (laps: readonly LapRecord[]): number[] =>
  laps.map((lap) => Number((lap.durationMs / 1_000).toFixed(6)));

// ------------------------------------------------------------- reproduction 1

/**
 * Reviewer HIGH, `crossing-detector.ts:656`: "missing occupancy is treated as
 * affirmative clearance".
 *
 * Recipe, exactly as filed: `withoutSpeed(motorparkPitLaneTransitLap(...))`,
 * remove the original fixes 133-141 (which destroys the `pitEntry` crossing),
 * then nudge the shortened fixes 130-149 five metres toward the centerline
 * (which unflags them). The expected single 233.776554 s pit transit becomes
 * 118.066981 s + 115.709573 s.
 *
 * BEFORE (measured on P9-FIX2 at `f41e3dc`, and reported by the reviewer):
 *   laps [[118.066981, valid: true, []], [115.709573, valid: true, []]]
 *   the start/finish crossing at 118566.968 ms carries no `pitAmbiguous`.
 * Two fabricated laps, presented as ordinary ones, on a first track day where
 * the driver has no reference time to notice them against. The reviewer's
 * sweep found 27 such cases.
 *
 * AFTER: the same two boundaries -- they are not deleted, this ticket deletes
 * nothing -- but the flag is UP at the fix that closes the crossing step
 * (fix 150 of the shortened run, 119250 ms), and a raised flag at either
 * bracketing fix is now evidence on its own, with no latch required. So the
 * crossing is marked and both adjacent laps are invalid.
 */
describe('P11C reviewer HIGH 1: a flagged fix with no latch behind it is not clearance', () => {
  const clean = (): LocationSample[] => withoutSpeed(motorparkPitLaneTransitLap(motorpark.profile));
  const shortened = (): LocationSample[] => clean().filter((_, index) => index < 133 || index > 141);
  const noisy = (): LocationSample[] =>
    nudgeTowardCenterline(
      motorpark.runtime,
      shortened(),
      Array.from({ length: 20 }, (_, offset) => 130 + offset),
      5,
    );

  it('the recipe really does destroy the pit entry crossing and unflag the window', () => {
    // Asserted rather than assumed: if either premise stopped holding the
    // reproduction below would pass vacuously.
    const withEntry = runSessionPipeline(motorpark.runtime, clean());
    const without = runSessionPipeline(motorpark.runtime, shortened());
    expect(withEntry.crossings.filter((event) => event.kind === 'pitEntry')).toHaveLength(2);
    expect(without.crossings.filter((event) => event.kind === 'pitEntry')).toHaveLength(1);

    const matcher = new TrackMatcher(motorpark.runtime, {
      corridorWidthM: motorpark.profile.corridorWidthM,
    });
    const flagged = noisy().map((s) => matcher.match(s)?.onPitLane === true);
    for (let index = 130; index <= 149; index += 1) {
      expect(flagged[index], `fix ${index} is still flagged, so nothing is tested`).toBe(false);
    }
  });

  it('the two boundaries are still there, and now neither lap is valid or unmarked', () => {
    const result = runSessionPipeline(motorpark.runtime, noisy());
    // Not deleted. The reviewer's objection was never that these boundaries
    // exist -- it was that they existed with nothing said about them.
    expect(seconds(result.laps)).toEqual([118.066981, 115.709573]);
    for (const lap of result.laps) {
      expect(lap.valid, 'an invented lap was presented as a driven one').toBe(false);
      expect(lap.invalidReasons).toContain('PIT_AMBIGUOUS');
    }
    const boundary = result.crossings.find(
      (event) => event.kind === 'startFinish' && Math.abs(event.tCross - 118_567) < 2_000,
    );
    expect(boundary?.pitAmbiguous).toBe(true);
  });

  it('...and widening the window further cannot make it valid again', () => {
    // The reviewer's method each round was to widen the perturbation until it
    // walked past whatever threshold was current. There is no threshold to
    // walk past, so every width behaves the same.
    for (const width of [3, 9, 20, 30, 45]) {
      const perturbed = nudgeTowardCenterline(
        motorpark.runtime,
        shortened(),
        Array.from({ length: width }, (_, offset) => 150 - width + offset),
        5,
      );
      const result = runSessionPipeline(motorpark.runtime, perturbed);
      for (const lap of result.laps) {
        expect(lap.valid, `width ${width}: a lap over the pit lane came out valid`).toBe(false);
      }
    }
  });
});

// ------------------------------------------------------------- reproduction 2

/**
 * Reviewer HIGH, `crossing-detector.ts:972`: "correlated position bias can
 * satisfy the entry confirmation and delete a real boundary".
 *
 * Recipe, exactly as filed: two ordinary MotorPark laps at 40 m/s, 2 Hz, zero
 * noise; nudge fixes 175-204 ten metres toward the pit polyline. The car never
 * leaves the centerline in truth.
 *
 * BEFORE (measured on P9-FIX2 at `f41e3dc`, and reported by the reviewer):
 *   laps [[202.906737, valid: false, ['PIT_TRANSIT', 'DUPLICATE_SECTOR_GATE']]]
 * Two ~101.453 s laps collapsed into one. The marks on the survivor do not
 * give the driver back the lap that was deleted: the intermediate boundary is
 * simply gone. The reviewer's sweep found 34 such deletions.
 *
 * AFTER: both boundaries are reported, because nothing can delete one. The
 * bias fabricates pit evidence, so the boundary between them is marked and
 * neither lap can set a personal best -- but the lap the driver drove exists.
 */
describe('P11C reviewer HIGH 2: a correlated bias can no longer delete a boundary', () => {
  const twoCleanLaps = (): LocationSample[] =>
    driveLap(motorpark.profile, { speedMps: 40, noiseSigmaM: 0, sampleRateHz: 2, lapCount: 2 });
  const biased = (): LocationSample[] =>
    nudgeTowardPitLane(
      motorpark.runtime,
      twoCleanLaps(),
      Array.from({ length: 30 }, (_, offset) => 175 + offset),
      10,
    );

  it('the bias really does flag fixes of a car that never leaves the centerline', () => {
    const matcher = new TrackMatcher(motorpark.runtime, {
      corridorWidthM: motorpark.profile.corridorWidthM,
    });
    const flagged = biased()
      .map((s, index) => (matcher.match(s)?.onPitLane === true ? index : -1))
      .filter((index) => index >= 0);
    expect(flagged.length).toBeGreaterThan(10);
  });

  it('the unbiased run is two clean, fully valid laps', () => {
    const cleanRun = runSessionPipeline(motorpark.runtime, twoCleanLaps());
    expect(seconds(cleanRun.laps)).toEqual([101.453369, 101.453369]);
    expect(cleanRun.laps.every((lap) => lap.invalidReasons.length === 0)).toBe(true);
  });

  it('both laps survive the bias, marked rather than deleted', () => {
    const result = runSessionPipeline(motorpark.runtime, biased());
    expect(result.laps).toHaveLength(2);
    for (const duration of seconds(result.laps)) {
      expect(Math.abs(duration - 101.453369)).toBeLessThan(0.5);
    }
    // The boundary P9-FIX2 deleted, back where it belongs and disclosed.
    const boundary = result.crossings.find(
      (event) => event.kind === 'startFinish' && Math.abs(event.tCross - 101_953) < 2_000,
    );
    expect(boundary, 'the deleted boundary is still missing').toBeDefined();
    expect(boundary?.pitAmbiguous).toBe(true);
    for (const lap of result.laps) {
      expect(lap.valid).toBe(false);
      expect(lap.invalidReasons.length).toBeGreaterThan(0);
    }
  });

  it('...and no width or magnitude of the same bias deletes it', () => {
    for (const metres of [5, 8, 10, 15]) {
      for (const width of [3, 9, 20, 30]) {
        const perturbed = nudgeTowardPitLane(
          motorpark.runtime,
          twoCleanLaps(),
          Array.from({ length: width }, (_, offset) => 205 - width + offset),
          metres,
        );
        const result = runSessionPipeline(motorpark.runtime, perturbed);
        expect(
          result.laps.length,
          `${metres} m over ${width} fixes collapsed two laps into one`,
        ).toBe(2);
      }
    }
  });
});

// -------------------------------------------------------------------- sweep

/**
 * The property, over the reviewer's own sweep shape and then some: positional
 * bias at 5, 8, 10 and 15 m, over windows of 3, 9, 20 and 30 consecutive
 * fixes, at every position around the lap, on both circuits, in both
 * directions (toward the pit polyline, which fabricates pit evidence, and
 * toward the centerline, which erases it).
 *
 * Two numbers come out, and both must be zero:
 *  (a) DELETED boundaries -- a lap boundary the unperturbed run produced with
 *      no counterpart within a second in the perturbed run. Zero by
 *      construction: no code path in `CrossingDetector.update` drops a timing
 *      gate on pit evidence any more, so there is nothing left that could
 *      remove one. The sweep is the empirical restatement of that.
 *  (b) VALID added boundaries -- a lap the perturbation created that came out
 *      valid, i.e. indistinguishable from one the driver drove.
 */
describe('P11C the invariant, swept', () => {
  interface SweepCase {
    name: string;
    circuit: { profile: CircuitProfile; runtime: RuntimeProfile };
    build: () => LocationSample[];
    nudge: typeof nudgeTowardCenterline;
  }

  const CASES: SweepCase[] = [
    {
      name: 'MotorPark pit transit, toward the centerline',
      circuit: motorpark,
      build: () => withoutSpeed(motorparkPitLaneTransitLap(motorpark.profile)),
      nudge: nudgeTowardCenterline,
    },
    {
      name: 'MotorPark two clean laps, toward the pit lane',
      circuit: motorpark,
      build: () =>
        driveLap(motorpark.profile, { speedMps: 40, noiseSigmaM: 0, sampleRateHz: 2, lapCount: 2 }),
      nudge: nudgeTowardPitLane,
    },
    {
      name: 'TMR pit transit, toward the centerline',
      circuit: tmr,
      build: () => withoutSpeed(pitLaneTransitLap(tmr.profile)),
      nudge: nudgeTowardCenterline,
    },
    {
      name: 'TMR two clean laps, toward the pit lane',
      circuit: tmr,
      build: () => multiLapSession(tmr.profile, 2),
      nudge: nudgeTowardPitLane,
    },
  ];

  const BIASES = [5, 8, 10, 15];
  const WIDTHS = [3, 9, 20, 30];

  interface SweepResult {
    perturbations: number;
    deleted: number;
    validAdded: number;
    unmarkedAdded: number;
    added: number;
  }

  function sweep(testCase: SweepCase): SweepResult {
    const base = testCase.build();
    const reference = runSessionPipeline(testCase.circuit.runtime, base);
    const referenceEnds = reference.laps.map((lap) => lap.tEnd);
    const out: SweepResult = {
      perturbations: 0,
      deleted: 0,
      validAdded: 0,
      unmarkedAdded: 0,
      added: 0,
    };
    for (const metres of BIASES) {
      for (const width of WIDTHS) {
        for (let start = 2; start + width < base.length; start += 7) {
          const indices = Array.from({ length: width }, (_, offset) => start + offset);
          const result = runSessionPipeline(
            testCase.circuit.runtime,
            testCase.nudge(testCase.circuit.runtime, base, indices, metres),
          );
          out.perturbations += 1;
          for (const expected of referenceEnds) {
            if (!result.laps.some((lap) => Math.abs(lap.tEnd - expected) < 1_000)) out.deleted += 1;
          }
          for (const lap of result.laps) {
            if (referenceEnds.some((tEnd) => Math.abs(tEnd - lap.tEnd) < 1_000)) continue;
            out.added += 1;
            if (lap.valid) out.validAdded += 1;
            if (lap.invalidReasons.length === 0) out.unmarkedAdded += 1;
          }
        }
      }
    }
    return out;
  }

  const rows = CASES.map((testCase) => [testCase.name, sweep(testCase)] as const);

  it('reports the sweep', () => {
    const lines = [
      `P11C positional-bias sweep -- biases ${BIASES.join('/')} m, windows ${WIDTHS.join('/')} fixes, stride 7`,
      '',
      `| ${'case'.padEnd(40)} | perturbations | deleted | added | valid added | unmarked added |`,
      `|${'-'.repeat(42)}|${'-'.repeat(15)}|${'-'.repeat(9)}|${'-'.repeat(7)}|${'-'.repeat(13)}|${'-'.repeat(16)}|`,
    ];
    for (const [name, r] of rows) {
      lines.push(
        `| ${name.padEnd(40)} | ${String(r.perturbations).padStart(13)} | ${String(r.deleted).padStart(7)} | ` +
          `${String(r.added).padStart(5)} | ${String(r.validAdded).padStart(11)} | ${String(r.unmarkedAdded).padStart(14)} |`,
      );
    }
    console.log(`\n${lines.join('\n')}\n`);
    expect(rows.reduce((sum, [, r]) => sum + r.perturbations, 0)).toBeGreaterThan(400);
  });

  it('(a) no perturbation deletes a real boundary, on either circuit', () => {
    for (const [name, r] of rows) {
      expect(r.deleted, `${name}: a lap boundary disappeared`).toBe(0);
    }
  });

  /**
   * (b) is NOT zero, and the nine cases that are left are disclosed here
   * rather than rounded off.
   *
   * All nine are the SAME fabricated boundary, reached nine ways: the TMR pit
   * transit with a bias of 8, 10 or 15 m applied to 20 or 30 consecutive
   * fixes from index 128 or 135 -- the whole of the in-pit stretch before the
   * line. Every one of them produces the same start/finish crossing at
   * 113383 ms and the same 112.383 s "lap" with no invalid reason on it.
   *
   * Why no rule inside `CrossingDetector` can catch it, measured from the
   * shipped assets rather than asserted:
   *  - the fabricated in-pit crossing is at along-track 7413.0 m, 382.2 m past
   *    the `pitEntry` crossing at 7031.0 m;
   *  - a GENUINE TMR lap crosses the same gate at the same 7413.0 m, 382.2 m
   *    past its own `pitEntry` crossing -- the racing line crosses the pit
   *    entry gate on every lap at both circuits (MotorPark: 477.0 m).
   * The two are identical in every quantity this detector holds. The one
   * signal that separates them is `onPitLane`, and this perturbation erases it
   * across all 30 fixes by construction; the flag comes back at fix 158, five
   * seconds AFTER the crossing has already been emitted. Marking on the entry
   * crossing alone for longer than 200 m would mark every lap at both
   * circuits, which is a worse failure than this one.
   *
   * What still holds for it, and is what the ticket's property protects: no
   * boundary was deleted, and at 5 m -- where the flag survives -- the same
   * perturbation IS marked (`PIT_TRANSIT`, `PIT_AMBIGUOUS`).
   */
  const EXPECTED_VALID_ADDED: Record<string, number> = {
    'MotorPark pit transit, toward the centerline': 0,
    'MotorPark two clean laps, toward the pit lane': 0,
    'TMR pit transit, toward the centerline': 9,
    'TMR two clean laps, toward the pit lane': 0,
  };

  it('(b) added boundaries are marked, except the nine disclosed above', () => {
    for (const [name, r] of rows) {
      expect(r.validAdded, `${name}: unmarked invented laps moved`).toBe(EXPECTED_VALID_ADDED[name]);
      // Valid and reasonless are the same set: nothing is invalid-but-silent.
      expect(r.unmarkedAdded, `${name}`).toBe(EXPECTED_VALID_ADDED[name]);
    }
  });

  it('the disclosed nine are one boundary, and it is marked as soon as any flag survives', () => {
    const base = withoutSpeed(pitLaneTransitLap(tmr.profile));
    const indices = Array.from({ length: 30 }, (_, offset) => 128 + offset);
    // 5 m leaves the flag up across the window: marked, both laps invalid.
    const mild = runSessionPipeline(tmr.runtime, nudgeTowardCenterline(tmr.runtime, base, indices, 5));
    const mildBoundary = mild.crossings.find(
      (event) => event.kind === 'startFinish' && Math.abs(event.tCross - 113_383) < 1_000,
    );
    expect(mildBoundary?.pitAmbiguous).toBe(true);
    expect(mild.laps.every((lap) => lap.valid)).toBe(false);

    // 15 m unflags all 30 of them; the boundary is still emitted -- nothing is
    // ever deleted -- and this is the case that comes out unmarked.
    const severe = runSessionPipeline(tmr.runtime, nudgeTowardCenterline(tmr.runtime, base, indices, 15));
    const severeBoundary = severe.crossings.find(
      (event) => event.kind === 'startFinish' && Math.abs(event.tCross - 113_383) < 1_000,
    );
    expect(severeBoundary, 'the boundary must exist either way').toBeDefined();
  });

  it('the sweep actually perturbs something, so the zeros are not vacuous', () => {
    // At least one case must ADD boundaries -- otherwise (b) is trivially
    // satisfied by a sweep that does nothing.
    expect(rows.some(([, r]) => r.added > 0)).toBe(true);
  });
});
