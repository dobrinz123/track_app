/**
 * Ticket P11C -- the rule that replaced pit suppression, asserted rather than
 * argued.
 *
 * Three rounds tried to decide whether the car was in the pit lane and to
 * DELETE the timing-gate crossing when they believed it was:
 *
 *  - P9 suppressed on one flagged fix and silently deleted real laps
 *    (MotorPark lost one in six);
 *  - P9-FIX1 added a timed release and broke in both directions at once: a
 *    6000 ms perturbation invented two laps out of a genuine 233.777 s pit
 *    transit, and the same hold deleted a real 101.453 s boundary from two
 *    ordinary laps;
 *  - P9-FIX2 replaced the timeout with an occupancy latch confirmed by a
 *    `pitEntry` crossing. The reviewer beat it again in both directions: a
 *    flagged fix with no latch behind it graded as affirmative clearance
 *    (27 invented, UNMARKED laps), and a 10 m bias over 30 fixes satisfied the
 *    entry confirmation and deleted a real boundary (34 deletions).
 *
 * So the detector stops deciding. A start/finish or sector crossing is ALWAYS
 * emitted; where any pit evidence bears on it, the crossing and both adjacent
 * laps are MARKED and the laps are not valid. The property that buys -- a real
 * boundary can never be deleted -- is trivially true, because nothing is
 * deleted.
 *
 * The A/B against the old rules that this file used to run by configuration is
 * gone with the configuration: `pitSuppressionHoldMs`,
 * `pitSuppressionMinSamples`, `pitLimiterSpeedMps`, `pitEntryGateRequired` and
 * `pitUnflaggedFixSuppresses` were the machinery of the decision and were
 * deleted with it, so there is no longer a way to ask this detector to
 * suppress anything. What replaces the A/B is stronger and needs no legacy
 * mode: the pit flag is shown to change MARKS only, never which crossings
 * exist, across every scenario the repository ships. The reviewer's two
 * reproductions live in `p11c-pit-never-deletes.test.ts`.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type {
  CircuitProfile,
  CrossingEvent,
  Gate,
  LocationSample,
  TrackMatch,
} from '../../src/contracts';
import {
  cleanRecognitionLap,
  driveLap,
  impossibleJumpLap,
  lowQualitySamplesLap,
  motorparkCleanRecognitionLap,
  motorparkMultiLapSession,
  motorparkPitLaneTransitLap,
  multiLapSession,
  noisyGpsLap,
  outOfOrderTimestampsLap,
  pauseResumeSession,
  pbImprovementSession,
  pitLaneTransitLap,
  reverseTravelLap,
  signalLossLap,
  slowerLapSession,
  startLineJitterLap,
  stoppedOnLineSession,
  wraparoundSession,
} from '../../src/fixtures';
import { projectOntoPolyline } from '../../src/geometry';
import { TrackMatcher } from '../../src/matching';
import { loadProfileFromJson, type RuntimeProfile } from '../../src/profile';
import { runSessionPipeline } from '../../src/replay';
import { CrossingDetector, type ProjectedGate } from '../../src/timing/crossing-detector';

function load(file: string): { profile: CircuitProfile; runtime: RuntimeProfile } {
  const json = readFileSync(new URL(`../../assets/circuits/${file}`, import.meta.url), 'utf8');
  const loaded = loadProfileFromJson(json);
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return { profile: loaded.profile, runtime: loaded.runtime };
}

const tmr = load('transilvania-motor-ring.v2.json');
const motorpark = load('motorpark-romania.v1.json');

/**
 * A matcher that can never place a fix on the pit lane: the pit polyline would
 * have to beat the centerline by ten kilometres. Every pit-derived signal in
 * the stack -- the detector's evidence AND the pipeline's `inPit` state --
 * therefore goes away, which is what makes the comparison below a measurement
 * of the pit rule and nothing else. It is not reachable in production: the
 * shipped default is 4 m.
 */
const PIT_BLIND = { matcher: { pitPreferenceMarginM: 10_000 } } as const;

/** Everything a crossing carries except its instant and its pit mark. */
function identity(event: CrossingEvent): string {
  return [
    event.gateId,
    event.kind,
    event.direction,
    event.confidence.toFixed(12),
    event.lapDistanceM.toFixed(9),
  ].join('|');
}

/** A lap's BOUNDARIES -- the thing no pit rule may ever move or remove. */
function boundaries(laps: readonly { lapNumber: number; tStart: number; tEnd: number }[]): string[] {
  return laps.map((lap) => `${lap.lapNumber}|${lap.tStart.toFixed(6)}|${lap.tEnd.toFixed(6)}`);
}

interface Case {
  name: string;
  runtime: RuntimeProfile;
  samples: readonly LocationSample[];
}

/** The same 21 fixture and replay scenarios `p8-detection-unchanged` covers. */
const CASES: Case[] = [
  { name: 'cleanRecognitionLap', runtime: tmr.runtime, samples: cleanRecognitionLap(tmr.profile) },
  { name: 'driveLap', runtime: tmr.runtime, samples: driveLap(tmr.profile) },
  {
    name: 'driveLap 10 Hz',
    runtime: tmr.runtime,
    samples: driveLap(tmr.profile, { sampleRateHz: 10 }),
  },
  {
    name: 'driveLap heavy braking profile',
    runtime: tmr.runtime,
    samples: driveLap(tmr.profile, {
      speedMps: ({ progress }) => 20 + 35 * Math.abs(Math.sin(progress * Math.PI * 6)),
    }),
  },
  { name: 'impossibleJumpLap', runtime: tmr.runtime, samples: impossibleJumpLap(tmr.profile) },
  { name: 'lowQualitySamplesLap', runtime: tmr.runtime, samples: lowQualitySamplesLap(tmr.profile) },
  { name: 'multiLapSession', runtime: tmr.runtime, samples: multiLapSession(tmr.profile, 3) },
  { name: 'noisyGpsLap', runtime: tmr.runtime, samples: noisyGpsLap(tmr.profile) },
  {
    name: 'outOfOrderTimestampsLap',
    runtime: tmr.runtime,
    samples: outOfOrderTimestampsLap(tmr.profile),
  },
  { name: 'pauseResumeSession', runtime: tmr.runtime, samples: pauseResumeSession(tmr.profile) },
  { name: 'pbImprovementSession', runtime: tmr.runtime, samples: pbImprovementSession(tmr.profile) },
  { name: 'pitLaneTransitLap', runtime: tmr.runtime, samples: pitLaneTransitLap(tmr.profile) },
  { name: 'reverseTravelLap', runtime: tmr.runtime, samples: reverseTravelLap(tmr.profile) },
  { name: 'signalLossLap', runtime: tmr.runtime, samples: signalLossLap(tmr.profile) },
  { name: 'slowerLapSession', runtime: tmr.runtime, samples: slowerLapSession(tmr.profile) },
  { name: 'startLineJitterLap', runtime: tmr.runtime, samples: startLineJitterLap(tmr.profile) },
  { name: 'stoppedOnLineSession', runtime: tmr.runtime, samples: stoppedOnLineSession(tmr.profile) },
  { name: 'wraparoundSession', runtime: tmr.runtime, samples: wraparoundSession(tmr.profile) },
  {
    name: 'motorparkCleanRecognitionLap',
    runtime: motorpark.runtime,
    samples: motorparkCleanRecognitionLap(motorpark.profile),
  },
  {
    name: 'motorparkMultiLapSession',
    runtime: motorpark.runtime,
    samples: motorparkMultiLapSession(motorpark.profile, 3),
  },
  {
    name: 'motorparkPitLaneTransitLap',
    runtime: motorpark.runtime,
    samples: motorparkPitLaneTransitLap(motorpark.profile),
  },
];

describe('P11C the pit rule changes marks, never boundaries', () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s: blinding the pit lane entirely changes no crossing and no lap boundary',
    (name, testCase) => {
      const withPit = runSessionPipeline(testCase.runtime, testCase.samples);
      const blind = runSessionPipeline(testCase.runtime, testCase.samples, PIT_BLIND);

      // Not a subset argument -- EQUALITY. Whatever the pit lane does to this
      // stream, it does not add, remove or move a single crossing, because
      // there is no code path left through which it could.
      expect(withPit.crossings.map(identity), `${name}: the pit rule moved a crossing`).toEqual(
        blind.crossings.map(identity),
      );
      expect(boundaries(withPit.laps), `${name}: the pit rule moved a lap boundary`).toEqual(
        boundaries(blind.laps),
      );
      // The pit rule may only ever ADD invalid reasons.
      withPit.laps.forEach((lap, index) => {
        const blindReasons = blind.laps[index]?.invalidReasons ?? [];
        for (const reason of blindReasons) expect(lap.invalidReasons).toContain(reason);
      });
    },
  );

  it('the pit path is actually exercised, so the equality above is not vacuous', () => {
    const marked: string[] = [];
    for (const testCase of CASES) {
      const withPit = runSessionPipeline(testCase.runtime, testCase.samples);
      const blind = runSessionPipeline(testCase.runtime, testCase.samples, PIT_BLIND);
      const reasons = (result: typeof withPit): number =>
        result.laps.reduce((sum, lap) => sum + lap.invalidReasons.length, 0);
      const ambiguous = withPit.crossings.filter((event) => event.pitAmbiguous === true).length;
      if (ambiguous > 0 || reasons(withPit) !== reasons(blind)) {
        marked.push(`${testCase.name}: ${ambiguous} marked crossing(s)`);
      }
    }
    console.log(`P11C scenarios where pit evidence marked something:\n  ${marked.join('\n  ')}`);
    expect(marked.length).toBeGreaterThan(0);
  });
});

describe('P11C the one thing the amount of evidence still decides', () => {
  /**
   * Whether a mark OUTLIVES the fixes that produced it -- and the A/B that
   * says why that is not another suppression threshold in disguise.
   *
   * The pit lane and the centerline are OSM ways that share their junction
   * nodes, so an ordinary lap has a fix or two flagged beside the pit entry
   * and pit exit joins. A flagged fix always marks a timing gate on its own
   * step (that is the reviewer's first HIGH, and it needs no hold), but if one
   * stray fix also raised the 200 m standing evidence, every lap at both
   * circuits would come out invalid -- which is what this run measures.
   */
  const EAGER = { crossings: { pitEvidenceHoldMs: 0, pitEvidenceMinSamples: 1 } } as const;

  it('one stray flagged fix must not mark the laps around it', () => {
    const marked = (result: ReturnType<typeof runSessionPipeline>): number =>
      result.laps.filter((lap) => lap.invalidReasons.includes('PIT_AMBIGUOUS')).length;
    const report: string[] = [];
    let eagerTotal = 0;
    // The 21 shipped scenarios, plus the seeded `pauseResumeSession(113)` from
    // `replay-harness.integration` test 11 -- a clean TMR session with no pit
    // visit at all, which under an unheld latch has BOTH of its laps marked.
    const cases: Case[] = [
      ...CASES,
      {
        name: 'pauseResumeSession(113)',
        runtime: tmr.runtime,
        samples: pauseResumeSession(tmr.profile, 113),
      },
    ];
    for (const testCase of cases) {
      const shipped = runSessionPipeline(testCase.runtime, testCase.samples);
      const eager = runSessionPipeline(testCase.runtime, testCase.samples, EAGER);
      // Same boundaries either way -- the hold cannot move one, in either
      // direction, which is what keeps it out of the class of rule this
      // ticket removed.
      expect(boundaries(shipped.laps), `${testCase.name}`).toEqual(boundaries(eager.laps));
      if (marked(eager) > marked(shipped)) {
        report.push(`${testCase.name}: ${marked(shipped)} -> ${marked(eager)} marked laps`);
        eagerTotal += marked(eager) - marked(shipped);
      }
    }
    console.log(
      'P11C laps that would be marked with the evidence hold removed: ' +
        (report.length === 0 ? '(none)' : report.join('; ')),
    );
    // Ordinary sessions with no pit visit at all pick up marks purely from the
    // fixes beside the pit joins, which is the whole reason the hold exists.
    expect(eagerTotal).toBeGreaterThan(0);
  });

  it('...but the hold never decides whether the flagged step itself is marked', () => {
    // A single flagged fix beside the line still marks its own crossing under
    // the shipped configuration; see the unit tests below. Here the same thing
    // at fixture scale: the MotorPark pit transit is marked with the hold in
    // place, because its flag is up for 16.5 s by the time it reaches the line.
    const result = runSessionPipeline(
      motorpark.runtime,
      motorparkPitLaneTransitLap(motorpark.profile),
    );
    expect(result.crossings.some((event) => event.pitAmbiguous === true)).toBe(true);
  });
});

describe('P11C a genuine pit transit', () => {
  /**
   * CONTRACT CHANGE, stated rather than quietly re-pinned. Through P9-FIX2
   * this test asserted that the start/finish line crossed INSIDE the MotorPark
   * pit lane produced no timing crossing at all: two crossings out of the
   * three that exist geometrically, and one 233.777 s "lap" spanning the whole
   * visit.
   *
   * That deletion is what the reviewer kept defeating from the other side, so
   * it is gone. The third crossing is now emitted and marked, and the pit
   * visit reads as two marked, invalid laps of 118.067 s and 115.710 s. The
   * cost is real and is the trade this ticket makes: a driver who pits sees
   * two invalid laps in the ledger instead of one. The benefit is that no
   * input can make a lap disappear.
   */
  it('MotorPark: the start/finish line crossed inside the pit lane is emitted, marked, and invalid', () => {
    const result = runSessionPipeline(
      motorpark.runtime,
      motorparkPitLaneTransitLap(motorpark.profile),
    );
    const startFinish = result.crossings.filter((event) => event.kind === 'startFinish');
    expect(startFinish).toHaveLength(3);
    // The middle one is the one inside the pit lane, and it says so.
    expect(startFinish[1]?.pitAmbiguous).toBe(true);
    expect(result.crossings.some((event) => event.kind === 'pitEntry')).toBe(true);
    expect(result.crossings.some((event) => event.kind === 'pitExit')).toBe(true);

    // The two halves of the visit, split at the line inside the pit lane.
    // (The reviewer's reported 118.066981 / 115.709573 are the same two laps
    // measured on the speed-stripped stream this fixture is usually replayed
    // with; with the fixture's own Doppler the instants differ by ~2 ms.)
    expect(result.laps.map((lap) => Number((lap.durationMs / 1_000).toFixed(6)))).toEqual([
      118.065061, 115.711492,
    ]);
    for (const lap of result.laps) {
      expect(lap.valid, 'a pit-lane transit was reported as a driven lap').toBe(false);
      expect(lap.invalidReasons).toContain('PIT_TRANSIT');
      expect(lap.invalidReasons).toContain('PIT_AMBIGUOUS');
    }
  });

  it('TMR: the pit transit is marked, and its lap boundaries are the pit-blind ones', () => {
    const result = runSessionPipeline(tmr.runtime, pitLaneTransitLap(tmr.profile));
    const blind = runSessionPipeline(tmr.runtime, pitLaneTransitLap(tmr.profile), PIT_BLIND);
    expect(result.crossings.map(identity)).toEqual(blind.crossings.map(identity));
    expect(boundaries(result.laps)).toEqual(boundaries(blind.laps));
    expect(result.laps.some((lap) => lap.invalidReasons.includes('PIT_TRANSIT'))).toBe(true);
    expect(result.laps.every((lap) => lap.valid)).toBe(false);
  });

  it('every fix of a real pit transit still carries the flag, on both circuits', () => {
    // The matcher margin is only defensible if it cannot unflag a car that is
    // actually in the pit lane. Measured over both fixtures, the smallest
    // margin a genuine pit fix shows is 4.9 m (TMR) and 5.1 m (MotorPark) --
    // the 4 m default sits under both.
    for (const [name, { profile, runtime }, samples] of [
      ['TMR', tmr, pitLaneTransitLap(tmr.profile)],
      ['MotorPark', motorpark, motorparkPitLaneTransitLap(motorpark.profile)],
    ] as const) {
      const strict = new TrackMatcher(runtime, { corridorWidthM: profile.corridorWidthM });
      const legacy = new TrackMatcher(runtime, {
        corridorWidthM: profile.corridorWidthM,
        pitPreferenceMarginM: 0,
      });
      let legacyFlags = 0;
      let strictFlags = 0;
      for (const sample of samples) {
        if (legacy.match(sample)?.onPitLane === true) legacyFlags += 1;
        if (strict.match(sample)?.onPitLane === true) strictFlags += 1;
      }
      expect(legacyFlags, `${name}: fixture has no pit-lane fixes`).toBeGreaterThan(20);
      // At most the single terminal fix at the exit join, where the pit
      // polyline touches the centerline and the car is already rejoining.
      expect(strictFlags, `${name}: the margin unflagged a real pit transit`).toBeGreaterThanOrEqual(
        legacyFlags - 1,
      );
    }
  });
});

// ------------------------------------------------ unit level: the evidence

const projection = {
  toLocal: ({ lat, lon }: { lat: number; lon: number }) => ({ e: lon, n: lat }),
};

function projectedGate(id: string, kind: Gate['kind'] = 'startFinish'): ProjectedGate {
  return {
    gate: { id, kind, a: { lat: 0, lon: 0 }, b: { lat: 0, lon: 10 } },
    aLocal: { e: 0, n: 0 },
    bLocal: { e: 10, n: 0 },
  };
}

function match(tMono: number, progressM: number, onPitLane: boolean): TrackMatch {
  return {
    tMono,
    distanceM: progressM % 1_000,
    progress: (progressM % 1_000) / 1_000,
    unwrappedProgressM: progressM,
    lateralM: 0,
    confidence: 0.9,
    sectorIndex: 0,
    quality: { level: 'good', reasons: [] },
    onPitLane,
  };
}

function sample(tMono: number, north: number, speedMps?: number): LocationSample {
  return {
    tMono,
    lat: north,
    lon: 5,
    source: 'replay',
    ...(speedMps === undefined ? {} : { speedMps }),
  };
}

/**
 * Drives a straight run of fixes northwards at 10 m/s past the gate at n = 0,
 * flagging `onPitLane` on the fixes named by `pit`. Returns the crossings.
 */
function run(
  detector: CrossingDetector,
  options: { count: number; crossAt: number; pit: (index: number) => boolean; speedMps?: number },
): CrossingEvent[] {
  const events: CrossingEvent[] = [];
  let prevMatch: TrackMatch | null = null;
  let prevSample: LocationSample | null = null;
  for (let index = 0; index < options.count; index += 1) {
    const tMono = index * 1_000;
    const north = (index - options.crossAt) * 10 - 5;
    const currMatch = match(tMono, index * 10, options.pit(index));
    const currSample = sample(tMono, north, options.speedMps);
    events.push(...detector.update(prevMatch, currMatch, prevSample, currSample));
    prevMatch = currMatch;
    prevSample = currSample;
  }
  return events;
}

describe('P11C any pit evidence marks, and nothing suppresses', () => {
  const gates = [projectedGate('sf', 'startFinish'), projectedGate('entry', 'pitEntry')];

  it('one flagged fix on the line: the lap is kept AND marked', () => {
    // P9 deleted this lap. P9-FIX2 emitted it with no mark at all, because no
    // occupancy had formed -- the reviewer's first HIGH, in miniature.
    const detector = new CrossingDetector(gates, projection);
    const events = run(detector, { count: 8, crossAt: 4, pit: (i) => i === 4 });
    expect(events.map((event) => event.gateId)).toContain('sf');
    expect(events.find((event) => event.gateId === 'sf')?.pitAmbiguous).toBe(true);
    expect(detector.pitEvidenceDiagnostics().ambiguousCrossings).toBe(1);
  });

  it('a flagged fix on EITHER side of the step is enough', () => {
    for (const flagged of [3, 4]) {
      const detector = new CrossingDetector(gates, projection);
      const events = run(detector, { count: 8, crossAt: 4, pit: (i) => i === flagged });
      expect(events.find((event) => event.gateId === 'sf')?.pitAmbiguous).toBe(true);
    }
  });

  it('a sustained transit is emitted and marked, not deleted', () => {
    const detector = new CrossingDetector(gates, projection);
    const events = run(detector, { count: 12, crossAt: 8, pit: (i) => i >= 2 });
    const sf = events.find((event) => event.gateId === 'sf');
    expect(sf, 'the lap boundary must exist however strong the pit evidence is').toBeDefined();
    expect(sf?.pitAmbiguous).toBe(true);
    const diagnostics = detector.pitEvidenceDiagnostics();
    expect(diagnostics.ambiguousCrossings).toBe(1);
    expect(diagnostics.lastAmbiguousGateId).toBe('sf');
    expect(diagnostics.lastAmbiguousTMono).toBe(9_000);
    expect(diagnostics.evidenceStanding).toBe(true);
  });

  it('a completely clear run is untouched: no mark, no diagnostics, no change', () => {
    // No pit gate in this detector: a `pitEntry` crossing is itself evidence,
    // and in this fixture it sits on the same step as the timing gate.
    const detector = new CrossingDetector([projectedGate('sf', 'startFinish')], projection);
    const events = run(detector, { count: 8, crossAt: 4, pit: () => false });
    expect(events.find((event) => event.gateId === 'sf')?.pitAmbiguous).toBeUndefined();
    expect(detector.pitEvidenceDiagnostics()).toEqual({
      ambiguousCrossings: 0,
      lastAmbiguousGateId: null,
      lastAmbiguousTMono: null,
      flagUp: false,
      evidenceStanding: false,
      pitEntryPending: false,
      assessment: 'clear',
    });
  });

  it('speed no longer takes part: the mark is the same at pit-lane and racing speed', () => {
    // `pitLimiterSpeedMps` was deleted with the suppression it accelerated.
    // The slowest corners at both circuits are driven under the 20 m/s it read
    // as pit-lane speed, and a rule that reads slow-and-near-the-pits as proof
    // is a single-sample deletion by another name.
    for (const speedMps of [12, 45, -1, undefined]) {
      const detector = new CrossingDetector(gates, projection);
      const events = run(detector, { count: 8, crossAt: 4, pit: (i) => i === 4, ...(speedMps === undefined ? {} : { speedMps }) });
      const sf = events.find((event) => event.gateId === 'sf');
      expect(sf, `speed ${String(speedMps)}: the boundary must exist`).toBeDefined();
      expect(sf?.pitAmbiguous, `speed ${String(speedMps)}: the mark must not depend on speed`).toBe(
        true,
      );
    }
  });

  it('pit entry and exit gates are themselves never marked, however long the evidence', () => {
    const detector = new CrossingDetector(
      [projectedGate('entry', 'pitEntry'), projectedGate('exit', 'pitExit')],
      projection,
    );
    const events = run(detector, { count: 12, crossAt: 8, pit: () => true });
    expect(events.map((event) => event.gateId)).toEqual(['entry', 'exit']);
    expect(events.every((event) => event.pitAmbiguous === undefined)).toBe(true);
  });

  it('reset() clears the evidence and the record', () => {
    const detector = new CrossingDetector(gates, projection);
    run(detector, { count: 12, crossAt: 8, pit: () => true });
    expect(detector.pitEvidenceDiagnostics().ambiguousCrossings).toBe(1);
    detector.reset();
    expect(detector.pitEvidenceDiagnostics()).toEqual({
      ambiguousCrossings: 0,
      lastAmbiguousGateId: null,
      lastAmbiguousTMono: null,
      flagUp: false,
      evidenceStanding: false,
      pitEntryPending: false,
      assessment: 'clear',
    });
  });
});

// ------------------------------------- evidence that outlives the flag

/**
 * A run with gates at DIFFERENT places along the straight, so a pit entry, a
 * timing gate and a pit exit can be crossed at different fixes and the order
 * between them matters -- which the single-position `run()` above cannot
 * express.
 */
function gateAt(id: string, kind: Gate['kind'], north: number): ProjectedGate {
  return {
    gate: { id, kind, a: { lat: north, lon: 0 }, b: { lat: north, lon: 10 } },
    aLocal: { e: 0, n: north },
    bLocal: { e: 10, n: north },
  };
}

/**
 * Drives north at 10 m/s, 1 Hz, from n = -5. Fix `i` sits at `n = 10i - 5`, so
 * a gate at `n = 10k` is crossed on the step that ends at fix `k`, halfway
 * through it. Progress advances with position.
 */
function drive(
  detector: CrossingDetector,
  options: { count: number; pit: (index: number) => boolean; speedMps?: number },
): CrossingEvent[] {
  const events: CrossingEvent[] = [];
  let prevMatch: TrackMatch | null = null;
  let prevSample: LocationSample | null = null;
  for (let index = 0; index < options.count; index += 1) {
    const tMono = index * 1_000;
    const currMatch = match(tMono, index * 10, options.pit(index));
    const currSample = sample(tMono, index * 10 - 5, options.speedMps);
    events.push(...detector.update(prevMatch, currMatch, prevSample, currSample));
    prevMatch = currMatch;
    prevSample = currSample;
  }
  return events;
}

describe('P11C standing evidence outlives a flag that flickers', () => {
  // Pit entry crossed on the step into fix 1; the timing gate on the step into
  // fix 12; the pit exit on the step into fix 20.
  const gates = [
    gateAt('entry', 'pitEntry', 0),
    gateAt('sf', 'startFinish', 120),
    gateAt('exit', 'pitExit', 200),
  ];
  /** Flagged from the entry on, EXCEPT three unflagged fixes over the line. */
  const noisyTransit = (index: number): boolean =>
    index >= 1 && !(index === 10 || index === 11 || index === 12);

  it('three unflagged fixes in the middle of a transit still leave the crossing marked', () => {
    const detector = new CrossingDetector(gates, projection);
    const events = drive(detector, { count: 24, pit: noisyTransit });
    const sf = events.find((event) => event.gateId === 'sf');
    expect(sf, 'the boundary must exist').toBeDefined();
    expect(sf?.pitAmbiguous).toBe(true);
  });

  it('the length of the unflagged stretch does not change the answer', () => {
    // This is where P9-FIX1's timeout lived, and where each round of review
    // walked past whatever number was current. There is no number left: 3
    // unflagged fixes and 60 of them are marked alike, because the mark is
    // held by standing evidence and by the pending entry, not by a clock.
    for (const span of [3, 6, 12, 30, 60]) {
      const detector = new CrossingDetector(gates, projection);
      const events = drive(detector, {
        count: 24,
        pit: (index) => index >= 1 && !(index > 12 - span && index <= 12),
      });
      const sf = events.find((event) => event.gateId === 'sf');
      expect(sf, `span ${span}: the boundary must exist`).toBeDefined();
      expect(sf?.pitAmbiguous, `span ${span}: the mark must not depend on the span`).toBe(true);
    }
  });

  it('marking is bounded: once the car has plainly rejoined, crossings are ordinary again', () => {
    const detector = new CrossingDetector(
      [gateAt('entry', 'pitEntry', 0), gateAt('sf', 'startFinish', 120), gateAt('late', 'sector', 1_000)],
      projection,
    );
    const events = drive(detector, { count: 140, pit: (index) => index >= 1 && index <= 9 });
    expect(events.find((event) => event.gateId === 'sf')?.pitAmbiguous).toBe(true);
    // 800 m of progress past the last flagged fix (at 90 m) resolves evidence a
    // `pitEntry` crossing stands behind, so the gate at 1000 m is an ordinary
    // crossing again -- nothing latches forever.
    const late = events.find((event) => event.gateId === 'late');
    expect(late).toBeDefined();
    expect(late?.pitAmbiguous).toBeUndefined();
    expect(detector.pitEvidenceDiagnostics().evidenceStanding).toBe(false);
  });

  it('a forward pit exit resolves the evidence at once, without waiting out the range', () => {
    // The exit gate is crossed on the step into fix 12 and the timing gate on
    // the step into fix 14, two seconds later. The car has demonstrably
    // rejoined the track, so the timing gate fires unmarked.
    const detector = new CrossingDetector(
      [gateAt('entry', 'pitEntry', 0), gateAt('exit', 'pitExit', 120), gateAt('sf', 'startFinish', 140)],
      projection,
    );
    const events = drive(detector, { count: 24, pit: (index) => index >= 1 && index <= 12 });
    const ids = events.map((event) => event.gateId);
    expect(ids).toContain('exit');
    expect(ids).toContain('sf');
    expect(events.find((event) => event.gateId === 'sf')?.pitAmbiguous).toBeUndefined();
  });

  it('a timing gate on the very step that carries the exit is still marked', () => {
    // The exit resolves the evidence AFTER the step, so the step the car left
    // on stays marked. That is the conservative direction and costs a lap
    // nothing: it is a mark, not a deletion.
    const detector = new CrossingDetector(
      [gateAt('entry', 'pitEntry', 0), gateAt('exit', 'pitExit', 120), gateAt('sf', 'startFinish', 122)],
      projection,
    );
    const events = drive(detector, { count: 24, pit: (index) => index >= 1 && index <= 12 });
    const ids = events.map((event) => event.gateId);
    expect(ids).toContain('exit');
    expect(ids).toContain('sf');
    expect(events.find((event) => event.gateId === 'sf')?.pitAmbiguous).toBe(true);
  });

  it('a pit entry with no exit after it marks on its own, and expires after 200 m', () => {
    // An entry crossing nothing corroborates is still evidence -- it marks the
    // gate right behind it -- but it stops being evidence 200 m later, exactly
    // as `SessionPipelineCore` drops its own pending entry.
    const near = new CrossingDetector(
      [gateAt('entry', 'pitEntry', 0), gateAt('sf', 'startFinish', 100)],
      projection,
    );
    expect(
      drive(near, { count: 60, pit: () => false }).find((event) => event.gateId === 'sf')
        ?.pitAmbiguous,
    ).toBe(true);

    const far = new CrossingDetector(
      [gateAt('entry', 'pitEntry', 0), gateAt('sf', 'startFinish', 400)],
      projection,
    );
    expect(
      drive(far, { count: 60, pit: () => false }).find((event) => event.gateId === 'sf')
        ?.pitAmbiguous,
    ).toBeUndefined();
  });

  it('reset() clears the standing evidence and the pending pit entry too', () => {
    const detector = new CrossingDetector(gates, projection);
    drive(detector, { count: 12, pit: noisyTransit });
    expect(detector.pitEvidenceDiagnostics().evidenceStanding).toBe(true);
    detector.reset();
    expect(detector.pitEvidenceDiagnostics().pitEntryPending).toBe(false);
    // ...and a reused detector then behaves exactly like a fresh one, which is
    // what proves the release window and the pending entry went with it.
    const reused = drive(detector, { count: 24, pit: noisyTransit });
    const fresh = drive(new CrossingDetector(gates, projection), { count: 24, pit: noisyTransit });
    expect(reused.map(identity)).toEqual(fresh.map(identity));
    expect(reused.map((event) => event.pitAmbiguous ?? false)).toEqual(
      fresh.map((event) => event.pitAmbiguous ?? false),
    );
  });
});

describe('P11C matcher margin', () => {
  it('rejects a coin-flip pit call and keeps a decisive one', () => {
    const { profile, runtime } = motorpark;
    const pit = runtime.pitLane;
    if (pit === undefined) throw new Error('MotorPark profile lost its pit lane');
    const strict = new TrackMatcher(runtime, { corridorWidthM: profile.corridorWidthM });
    const legacy = new TrackMatcher(runtime, {
      corridorWidthM: profile.corridorWidthM,
      pitPreferenceMarginM: 0,
    });
    const flagged = (matcher: TrackMatcher, point: { e: number; n: number }): boolean => {
      matcher.reset();
      const geo = runtime.projection.toLatLon(point);
      return matcher.match({ tMono: 0, ...geo, accuracyM: 3, source: 'replay' })?.onPitLane === true;
    };

    let decisive = 0;
    let coinFlips = 0;
    for (const vertex of pit.polyline) {
      const onCenterline = projectOntoPolyline(
        vertex,
        runtime.centerline,
        runtime.cumulativeDistancesM,
        true,
      ).point;
      const separationM = Math.hypot(vertex.e - onCenterline.e, vertex.n - onCenterline.n);
      if (separationM < 6) continue;
      // Decisive: the car is ON the pit polyline, the full separation away
      // from the centerline.
      if (flagged(strict, vertex)) decisive += 1;
      // Coin flip: 55 % of the way across, so the pit polyline wins by only
      // 10 % of the separation -- about a metre, well inside the noise. The
      // old rule believed it; the margin does not.
      const ambiguous = {
        e: onCenterline.e + (vertex.e - onCenterline.e) * 0.55,
        n: onCenterline.n + (vertex.n - onCenterline.n) * 0.55,
      };
      if (flagged(legacy, ambiguous) && !flagged(strict, ambiguous)) coinFlips += 1;
    }
    expect(decisive).toBeGreaterThan(0);
    expect(coinFlips).toBeGreaterThan(0);
  });

  it('a negative margin, which would be more eager than the old rule, is refused', () => {
    expect(
      () => new TrackMatcher(tmr.runtime, { pitPreferenceMarginM: -1 }),
    ).toThrow(RangeError);
  });
});
