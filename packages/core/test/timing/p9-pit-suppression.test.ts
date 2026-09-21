/**
 * Ticket P9 -- the asymmetric guarantee, asserted rather than argued.
 *
 * Before P9 a SINGLE fix flagged `onPitLane` suppressed every timing gate for
 * that step. Both shipped circuits have a pit lane that runs within a few
 * metres of the centerline (they are OSM ways that share their junction
 * nodes), so one noisy fix beside the start/finish line deleted the whole lap
 * -- silently. The P8 harness measured that at 2-6 % of simulated laps.
 *
 * P9 makes the suppression require SUSTAINED evidence and makes the matcher's
 * pit test require a real margin. The guarantee that governs both halves:
 *
 *   the change may only ever ADD crossings that were being wrongly
 *   suppressed, and may NEVER remove a suppression that was correct.
 *
 * Half one is a subset property and is proved here by construction and by
 * replay. Half two is proved on the only fixtures in the repository where a
 * car genuinely transits a pit lane.
 *
 * TICKET P9-FIX1. Codex showed that half one does not imply half two, and it
 * was right: a subset argument covers ENGAGEMENT and says nothing about
 * RELEASE, and P9 released on the first unflagged fix. Three ambiguous fixes
 * in the middle of a genuine 16.5 s pit transit therefore dropped a
 * suppression that had been fully earned, the pit crossing fired, and one
 * 233.777 s MotorPark lap became two INVENTED ones of 118.067 s and
 * 115.710 s. That replay is now `describe('P9-FIX1 ...')` at the bottom of
 * this file, and release has its own evidence requirement:
 *
 *   an occupancy that earned the full hold ends only on a forward `pitExit`
 *   crossing -- the same event the pipeline dispatches `PIT_EXITED` on -- or
 *   on the flag staying DOWN for 6 s across at least 3 fixes.
 *
 * Engagement is untouched, so nothing in half one moves.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type {
  CircuitProfile,
  CrossingEvent,
  Gate,
  LapRecord,
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
 * The pre-P9 behaviour, reachable by configuration alone: the matcher's pit
 * test back to `pitDistanceM < centerlineDistanceM`, and the detector back to
 * suppressing on the first flagged fix. Both are bit-exact restorations, which
 * is what makes the A/B below a measurement of this ticket and nothing else.
 */
const LEGACY = {
  matcher: { pitPreferenceMarginM: 0 },
  crossings: {
    pitSuppressionHoldMs: 0,
    pitSuppressionMinSamples: 1,
    pitLimiterSpeedMps: 0,
    // Ticket P9-FIX2. The restoration needs three more keys now, because
    // P9-FIX2 added two more things suppression depends on and both have to
    // be switched off for this to be the PRE-P9 rule and not a subset of it:
    // an occupancy no `pitEntry` crossing confirms may no longer suppress
    // (`pitEntryGateRequired`), and one unflagged fix no longer ends an
    // occupancy (`pitReleaseHoldMs`/`pitReleaseMinSamples`/
    // `pitAmbiguityClearRangeM`). With all of them off the grade is exactly
    // `prev.onPitLane || curr.onPitLane`, which is the line P9 replaced.
    pitEntryGateRequired: false,
    pitReleaseHoldMs: 0,
    pitReleaseMinSamples: 1,
    pitAmbiguityClearRangeM: 0,
    pitConfirmedClearRangeM: 0,
  },
} as const;

/**
 * Ticket P9-FIX1. P9 exactly as it shipped: sustained engagement, immediate
 * release. Reachable by configuration alone, which is what makes the
 * invented-lap replay at the bottom of this file an A/B of THIS fix and
 * nothing else. A zero hold already keeps occupancy provisional, so
 * {@link LEGACY} above needs no new key and the subset proof is unchanged.
 */
const P9_AS_SHIPPED = {
  crossings: {
    pitReleaseHoldMs: 0,
    pitReleaseMinSamples: 1,
    pitAmbiguityClearRangeM: 0,
    pitConfirmedClearRangeM: 0,
    pitEntryGateRequired: false,
  },
} as const;

/**
 * Ticket P9-FIX2. P9-FIX1 exactly as it stood at `21f601b`: sustained
 * engagement, and a RELEASE that keeps suppressing for 6 s / 3 fixes after
 * the flag drops. Reachable by configuration, which is what lets the two
 * findings below state a before number as well as an after one. The one
 * production-forbidden key is `pitUnflaggedFixSuppresses`; see its doc.
 */
const P9_FIX1_RELEASE_HOLD = {
  crossings: {
    pitUnflaggedFixSuppresses: true,
    pitEntryGateRequired: false,
    pitAmbiguityClearRangeM: 0,
    pitConfirmedClearRangeM: 0,
  },
} as const;

function identity(event: CrossingEvent): string {
  return [
    event.gateId,
    event.kind,
    event.direction,
    event.confidence.toFixed(12),
    event.lapDistanceM.toFixed(9),
  ].join('|');
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

describe('P9 only ever adds crossings the pit rule was wrongly suppressing', () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s keeps every crossing the pre-P9 rule produced',
    (_name, testCase) => {
      const before = runSessionPipeline(testCase.runtime, testCase.samples, LEGACY);
      const after = runSessionPipeline(testCase.runtime, testCase.samples);

      // Every pre-P9 crossing is still there, in order, field for field. The
      // new run may hold extra crossings between them -- those are the laps
      // that were being deleted -- but nothing the old rule emitted may be
      // missing, which is the half of the guarantee that protects the pit
      // lane.
      const beforeIds = before.crossings.map(identity);
      const afterIds = after.crossings.map(identity);
      let cursor = 0;
      for (const wanted of beforeIds) {
        const found = afterIds.indexOf(wanted, cursor);
        expect(found, `${_name}: P9 dropped a crossing the old rule emitted: ${wanted}`).toBeGreaterThanOrEqual(0);
        cursor = found + 1;
      }
      expect(afterIds.length).toBeGreaterThanOrEqual(beforeIds.length);
    },
  );

  it('exactly one shipped scenario changes, and it changes by GAINING the lap it was losing', () => {
    const changed: string[] = [];
    for (const testCase of CASES) {
      const before = runSessionPipeline(testCase.runtime, testCase.samples, LEGACY);
      const after = runSessionPipeline(testCase.runtime, testCase.samples);
      if (
        before.crossings.length !== after.crossings.length ||
        before.laps.length !== after.laps.length
      ) {
        changed.push(
          `${testCase.name}: ${before.crossings.length} -> ${after.crossings.length} crossings, ` +
            `${before.laps.length} -> ${after.laps.length} laps`,
        );
      }
    }
    console.log(
      `P9 change set across ${CASES.length} shipped scenarios:\n` +
        (changed.length === 0 ? '  (none)' : changed.map((line) => `  ${line}`).join('\n')),
    );
    // `noisyGpsLap` is the one fixture in the corpus that already reproduced
    // the defect: under its 8 m noise one fix beside the main straight fell
    // on the pit side of the ambiguity and the lap vanished. It is the whole
    // change set, and it moves in the only direction this ticket allows.
    expect(changed).toEqual(['noisyGpsLap: 5 -> 6 crossings, 0 -> 1 laps']);
  });

  it('the recovered noisyGpsLap lap is a real lap, not an artefact', () => {
    const recovered = runSessionPipeline(tmr.runtime, noisyGpsLap(tmr.profile));
    const lap = recovered.laps[0];
    expect(lap).toBeDefined();
    // A TMR lap at the fixture's speed profile, not a spurious two-second one.
    expect(lap?.durationMs).toBeGreaterThan(60_000);
    expect(lap?.durationMs).toBeLessThan(180_000);
  });
});

describe('P9 still suppresses a genuine pit-lane transit', () => {
  /**
   * MotorPark is the only circuit in the repository whose pit lane geometry
   * actually carries the car across a timing gate: `motorparkPitLaneTransitLap`
   * crosses the start/finish line 16.5 s / 23 fixes into a continuously
   * flagged pit transit. If P9 let that through it would invent a lap time for
   * a car driving down the pit lane, which is the failure this rule exists to
   * prevent.
   */
  it('MotorPark: the start/finish line crossed inside the pit lane produces no timing crossing', () => {
    const result = runSessionPipeline(
      motorpark.runtime,
      motorparkPitLaneTransitLap(motorpark.profile),
    );
    const legacy = runSessionPipeline(
      motorpark.runtime,
      motorparkPitLaneTransitLap(motorpark.profile),
      LEGACY,
    );
    // Same crossings as the old rule: the suppression that mattered is intact.
    expect(result.crossings.map(identity)).toEqual(legacy.crossings.map(identity));
    // Three start/finish crossings exist geometrically in this fixture (one
    // before the pit, one INSIDE the pit lane, one after rejoining); only two
    // are reported, and the pit one is the missing middle.
    const startFinish = result.crossings.filter((event) => event.kind === 'startFinish');
    expect(startFinish).toHaveLength(2);
    expect(result.crossings.some((event) => event.kind === 'pitEntry')).toBe(true);
    expect(result.crossings.some((event) => event.kind === 'pitExit')).toBe(true);
    expect(result.laps.every((lap) => lap.valid)).toBe(false);
  });

  it('TMR: the pit transit fixture is unchanged end to end', () => {
    const result = runSessionPipeline(tmr.runtime, pitLaneTransitLap(tmr.profile));
    const legacy = runSessionPipeline(tmr.runtime, pitLaneTransitLap(tmr.profile), LEGACY);
    expect(result.crossings.map(identity)).toEqual(legacy.crossings.map(identity));
    expect(result.laps.map((lap) => [lap.lapNumber, lap.valid, [...lap.invalidReasons].sort()])).toEqual(
      legacy.laps.map((lap) => [lap.lapNumber, lap.valid, [...lap.invalidReasons].sort()]),
    );
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

// ------------------------------------------------------- unit level: the latch

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
 * flagging `onPitLane` on the fixes named by `pitAt`. Returns the crossings.
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

describe('P9 pit-lane suppression needs sustained evidence', () => {
  const gates = [projectedGate('sf', 'startFinish'), projectedGate('entry', 'pitEntry')];

  it('one flagged fix on the line no longer deletes the lap', () => {
    const detector = new CrossingDetector(gates, projection);
    const events = run(detector, { count: 8, crossAt: 4, pit: (i) => i === 4 });
    expect(events.map((event) => event.gateId)).toContain('sf');
    expect(detector.pitSuppressionDiagnostics().suppressedCrossings).toBe(0);
  });

  it('two flagged fixes spanning 1 s still do not', () => {
    // 1 s of evidence is inside the correlation time of a multipath excursion.
    const detector = new CrossingDetector(gates, projection);
    const events = run(detector, { count: 8, crossAt: 4, pit: (i) => i === 3 || i === 4 });
    expect(events.map((event) => event.gateId)).toContain('sf');
  });

  it('a sustained transit does, and the suppression is recorded', () => {
    const detector = new CrossingDetector(gates, projection);
    const events = run(detector, { count: 12, crossAt: 8, pit: (i) => i >= 2 });
    expect(events.map((event) => event.gateId)).not.toContain('sf');
    const diagnostics = detector.pitSuppressionDiagnostics();
    expect(diagnostics.suppressedCrossings).toBe(1);
    expect(diagnostics.lastSuppressedGateId).toBe('sf');
    // The line lies between the eighth and ninth fix; the crossing is
    // recorded against the fix that closed the step.
    expect(diagnostics.lastSuppressedTMono).toBe(9_000);
    expect(diagnostics.engaged).toBe(true);
  });

  it('an occupancy that never passed a pit entry gate still releases on one clear fix', () => {
    const detector = new CrossingDetector(gates, projection);
    // Flagged for the first six fixes, clear from the seventh; the line is
    // crossed on the eighth. No forward `pitEntry` crossing precedes the
    // evidence here, so the occupancy never LATCHES (P9-FIX1) and release is
    // immediate, exactly as P9 shipped.
    const events = run(detector, { count: 12, crossAt: 8, pit: (i) => i < 6 });
    expect(events.map((event) => event.gateId)).toContain('sf');
  });

  it('reset() clears the latch and the record', () => {
    const detector = new CrossingDetector(gates, projection);
    run(detector, { count: 12, crossAt: 8, pit: () => true });
    expect(detector.pitSuppressionDiagnostics().suppressedCrossings).toBe(1);
    detector.reset();
    expect(detector.pitSuppressionDiagnostics()).toEqual({
      suppressedCrossings: 0,
      lastSuppressedGateId: null,
      lastSuppressedTMono: null,
      // Ticket P9-FIX2: the ambiguity record resets with the rest of it.
      ambiguousCrossings: 0,
      lastAmbiguousGateId: null,
      lastAmbiguousTMono: null,
      engaged: false,
      established: false,
      ambiguous: false,
      occupancy: 'none',
    });
  });

  it('pit entry and exit gates are never suppressed, however long the evidence', () => {
    const detector = new CrossingDetector([projectedGate('entry', 'pitEntry')], projection);
    const events = run(detector, { count: 12, crossAt: 8, pit: () => true });
    expect(events.map((event) => event.gateId)).toEqual(['entry']);
  });

  it('the legacy single-sample rule is still reachable by configuration', () => {
    const detector = new CrossingDetector(gates, projection, {
      pitSuppressionHoldMs: 0,
      pitSuppressionMinSamples: 1,
      pitLimiterSpeedMps: 0,
    });
    const events = run(detector, { count: 8, crossAt: 4, pit: (i) => i === 4 });
    expect(events.map((event) => event.gateId)).not.toContain('sf');
  });
});

describe('P9 speed shortcut', () => {
  const gates = [projectedGate('sf', 'startFinish')];

  /**
   * Ticket P9-FIX2 CONTRACT CHANGE, recorded rather than quietly relaxed.
   *
   * Through P9-FIX1 one slow flagged fix DELETED the crossing outright, and
   * `gates` here contains no pit entry gate, so nothing had ever confirmed
   * the car went into a pit lane. That is a single-sample deletion -- the
   * exact failure P9 was written to end -- kept alive for slow fixes, and it
   * is reachable on track: the slowest corners at both circuits are taken
   * under the 20 m/s the shortcut reads as pit-lane speed, and the pit
   * polyline runs a few metres from the centerline.
   *
   * So the shortcut still engages the latch at once, and the latch now MARKS
   * instead of deleting until a forward `pitEntry` crossing confirms it. The
   * crossing survives, and it says it is unsure -- which is the whole of
   * P9-FIX2. The next test is the same run WITH the entry gate, where the
   * suppression that matters is intact.
   */
  it('a flagged fix under the pit limiter engages at once, and marks rather than deletes', () => {
    const detector = new CrossingDetector(gates, projection);
    const events = run(detector, { count: 8, crossAt: 4, pit: (i) => i === 4, speedMps: 12 });
    const sf = events.find((event) => event.gateId === 'sf');
    expect(sf, 'the lap boundary must still exist').toBeDefined();
    expect(sf?.pitAmbiguous).toBe(true);
    const diagnostics = detector.pitSuppressionDiagnostics();
    expect(diagnostics.suppressedCrossings).toBe(0);
    expect(diagnostics.ambiguousCrossings).toBe(1);
  });

  it('...and with the pit entry gate behind it, the shortcut still suppresses', () => {
    const detector = new CrossingDetector(
      [projectedGate('entry', 'pitEntry'), projectedGate('sf', 'startFinish')],
      projection,
    );
    const events = run(detector, { count: 8, crossAt: 4, pit: (i) => i >= 4, speedMps: 12 });
    expect(events.map((event) => event.gateId)).not.toContain('sf');
    expect(detector.pitSuppressionDiagnostics().suppressedCrossings).toBe(1);
  });

  it('a flagged fix at racing speed does not', () => {
    const detector = new CrossingDetector(gates, projection);
    const events = run(detector, { count: 8, crossAt: 4, pit: (i) => i === 4, speedMps: 45 });
    expect(events.map((event) => event.gateId)).toContain('sf');
  });

  it("iOS's -1 for 'no speed solution' is not read as a slow car", () => {
    const detector = new CrossingDetector(gates, projection);
    const events = run(detector, { count: 8, crossAt: 4, pit: (i) => i === 4, speedMps: -1 });
    expect(events.map((event) => event.gateId)).toContain('sf');
  });

  it('a missing speed channel leaves the hold in charge, both ways', () => {
    // A single unexplained flagged fix is still nothing: no latch, no mark.
    const blip = new CrossingDetector(gates, projection);
    const blipEvents = run(blip, { count: 8, crossAt: 4, pit: (i) => i === 4 });
    expect(blipEvents.map((event) => event.gateId)).toContain('sf');
    expect(blipEvents.find((event) => event.gateId === 'sf')?.pitAmbiguous).toBeUndefined();
    // Sustained evidence still engages the latch. Ticket P9-FIX2: with no pit
    // entry gate in `gates` the latch may mark but not delete -- see the
    // limiter test above for why -- and the run that follows is the same
    // evidence WITH the entry gate, which still suppresses.
    const sustained = new CrossingDetector(gates, projection);
    const sustainedEvents = run(sustained, { count: 12, crossAt: 8, pit: (i) => i >= 2 });
    expect(sustainedEvents.find((event) => event.gateId === 'sf')?.pitAmbiguous).toBe(true);
    const confirmed = new CrossingDetector(
      [projectedGate('entry', 'pitEntry'), projectedGate('sf', 'startFinish')],
      projection,
    );
    expect(
      run(confirmed, { count: 12, crossAt: 8, pit: (i) => i >= 2 }).map((event) => event.gateId),
    ).not.toContain('sf');
  });
});

describe('P9 matcher margin', () => {
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

// -------------------------------------------- P9-FIX1: release needs evidence

/**
 * Ticket P9-FIX1. A run with gates at DIFFERENT places along the straight, so
 * a pit entry, a timing gate and a pit exit can be crossed at different fixes
 * and the order between them matters -- which the single-position `run()`
 * above cannot express.
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

describe('P9-FIX1 an established pit occupancy survives ambiguous fixes', () => {
  // Pit entry crossed on the step into fix 1; the timing gate on the step into
  // fix 12; the pit exit on the step into fix 20.
  const gates = [
    gateAt('entry', 'pitEntry', 0),
    gateAt('sf', 'startFinish', 120),
    gateAt('exit', 'pitExit', 200),
  ];
  /** Flagged from the entry on, EXCEPT three ambiguous fixes over the line. */
  const noisyTransit = (index: number): boolean =>
    index >= 1 && !(index === 10 || index === 11 || index === 12);

  it('three clear fixes in the middle of a transit do not hand back the pit crossing', () => {
    const detector = new CrossingDetector(gates, projection);
    const events = drive(detector, { count: 24, pit: noisyTransit });
    expect(events.map((event) => event.gateId)).not.toContain('sf');
    const diagnostics = detector.pitSuppressionDiagnostics();
    expect(diagnostics.suppressedCrossings).toBe(1);
    expect(diagnostics.lastSuppressedGateId).toBe('sf');
  });

  it('and P9 as it shipped hands it back -- this is the A/B of the fix', () => {
    const shipped = new CrossingDetector(gates, projection, P9_AS_SHIPPED.crossings);
    const events = drive(shipped, { count: 24, pit: noisyTransit });
    expect(events.map((e) => e.gateId)).toContain('sf');
    // ...and hands it back UNMARKED, which is what made it a silent
    // fabrication rather than a disclosure.
    expect(events.find((e) => e.gateId === 'sf')?.pitAmbiguous).toBeUndefined();
  });

  it('occupancy is reported as established while the ambiguous fixes run', () => {
    const detector = new CrossingDetector(gates, projection);
    drive(detector, { count: 12, pit: noisyTransit });
    const diagnostics = detector.pitSuppressionDiagnostics();
    // Ticket P9-FIX2: the latch is still standing -- that is the point, it
    // does not time out -- but the current fix is unflagged, so it does not
    // corroborate it and nothing is being SUPPRESSED at this instant.
    expect(diagnostics.established).toBe(true);
    expect(diagnostics.occupancy).toBe('confirmed');
    expect(diagnostics.ambiguous).toBe(true);
    expect(diagnostics.engaged).toBe(false);
  });

  /**
   * Ticket P9-FIX2 CONTRACT CHANGE. This test used to assert that the gate at
   * fix 12 was SUPPRESSED, because it fell inside the 6 s release hold. Codex
   * then showed that exact behaviour deleting a real lap: a MotorPark two-lap
   * run whose fixes 185-195 are biased 8 m toward the pit polyline, with the
   * car never leaving the centerline, loses its 101.453 s boundary and
   * reports one 202.907 s lap. The replay is at the bottom of this file.
   *
   * A hold that suppresses cannot tell that case from a genuine transit, so
   * it no longer suppresses. Both gates fire; the one inside the unresolved
   * occupancy says so, the one after it has resolved does not.
   */
  it('the flag staying down does not delete a crossing -- it marks it, then resolves', () => {
    const detector = new CrossingDetector(
      [gateAt('entry', 'pitEntry', 0), gateAt('sf', 'startFinish', 120), gateAt('late', 'sector', 1_000)],
      projection,
    );
    const events = drive(detector, { count: 140, pit: (index) => index >= 1 && index <= 9 });
    const sf = events.find((event) => event.gateId === 'sf');
    const late = events.find((event) => event.gateId === 'late');
    expect(sf?.pitAmbiguous).toBe(true);
    // 800 m of progress past the last flagged fix (at 90 m) resolves this
    // CONFIRMED occupancy, so the gate at 1000 m is an ordinary crossing
    // again -- the marking is bounded and nothing latches forever.
    expect(late).toBeDefined();
    expect(late?.pitAmbiguous).toBeUndefined();
    expect(detector.pitSuppressionDiagnostics().engaged).toBe(false);
    expect(detector.pitSuppressionDiagnostics().occupancy).toBe('none');
  });

  it('a forward pit exit crossing releases it at once, without waiting out the hold', () => {
    // The exit gate is crossed on the step into fix 12 and the timing gate on
    // the step into fix 14, two seconds later -- far inside the 6 s hold. The
    // car has demonstrably rejoined the track, so the timing gate must fire.
    const detector = new CrossingDetector(
      [gateAt('entry', 'pitEntry', 0), gateAt('exit', 'pitExit', 120), gateAt('sf', 'startFinish', 140)],
      projection,
    );
    const events = drive(detector, { count: 24, pit: (index) => index >= 1 && index <= 12 });
    const ids = events.map((event) => event.gateId);
    expect(ids).toContain('exit');
    expect(ids).toContain('sf');
  });

  it('the step that carries the pit exit is itself still suppressed', () => {
    // Releasing on the exit must not un-suppress the very step the car left
    // on; the pre-P9 rule suppressed that step and so does this.
    const detector = new CrossingDetector(
      [gateAt('entry', 'pitEntry', 0), gateAt('exit', 'pitExit', 120), gateAt('sf', 'startFinish', 122)],
      projection,
    );
    const events = drive(detector, { count: 24, pit: (index) => index >= 1 && index <= 12 });
    const ids = events.map((event) => event.gateId);
    expect(ids).toContain('exit');
    expect(ids).not.toContain('sf');
  });

  it('a pit entry that 200 m of progress never confirms cannot authorise a latch', () => {
    // The pipeline drops a pending pit entry after 200 m; so does this. The
    // car crosses the entry gate, carries on down the track for 250 m, and a
    // later burst of flagged fixes may then suppress but may not latch.
    const detector = new CrossingDetector(
      [gateAt('entry', 'pitEntry', 0), gateAt('sf', 'startFinish', 400)],
      projection,
    );
    const events = drive(detector, {
      count: 60,
      // Clear until well past the 200 m expiry, then a sustained burst that
      // stops three fixes before the line.
      pit: (index) => index >= 30 && index <= 36,
    });
    expect(events.map((event) => event.gateId)).toContain('sf');
    expect(detector.pitSuppressionDiagnostics().established).toBe(false);
  });

  it('one slow flagged fix never deletes a later crossing', () => {
    // One slow flagged fix beside the line is exactly the evidence P9 exists
    // to distrust. Ticket P9-FIX2: it engages the latch (a pit entry gate WAS
    // crossed at fix 1 here, so the latch is even confirmed) but the line at
    // fix 12 is unflagged, so the crossing is emitted and marked -- never
    // dropped.
    const detector = new CrossingDetector(
      [gateAt('entry', 'pitEntry', 0), gateAt('sf', 'startFinish', 120)],
      projection,
    );
    const events = drive(detector, { count: 24, pit: (index) => index === 5, speedMps: 12 });
    const sf = events.find((event) => event.gateId === 'sf');
    expect(sf).toBeDefined();
    expect(sf?.pitAmbiguous).toBe(true);
    expect(detector.pitSuppressionDiagnostics().suppressedCrossings).toBe(0);
  });

  it('reset() clears the release window and the pending pit entry too', () => {
    const detector = new CrossingDetector(gates, projection);
    drive(detector, { count: 12, pit: noisyTransit });
    expect(detector.pitSuppressionDiagnostics().established).toBe(true);
    detector.reset();
    expect(detector.pitSuppressionDiagnostics()).toEqual({
      suppressedCrossings: 0,
      lastSuppressedGateId: null,
      lastSuppressedTMono: null,
      // Ticket P9-FIX2: the ambiguity record resets with the rest of it.
      ambiguousCrossings: 0,
      lastAmbiguousGateId: null,
      lastAmbiguousTMono: null,
      engaged: false,
      established: false,
      ambiguous: false,
      occupancy: 'none',
    });
    // ...and a reused detector then behaves exactly like a fresh one, which is
    // what proves the release window and the pending entry went with it.
    const reused = drive(detector, { count: 24, pit: noisyTransit });
    const fresh = drive(new CrossingDetector(gates, projection), { count: 24, pit: noisyTransit });
    expect(reused.map(identity)).toEqual(fresh.map(identity));
    expect(detector.pitSuppressionDiagnostics().suppressedCrossings).toBe(1);
  });
});

// ------------------------------------------- P9-FIX1: the invented-lap replay

/**
 * Ticket P9-FIX1. Codex's reproduction, replayed exactly as it was reported:
 * `motorparkPitLaneTransitLap` with the speed channel omitted and fixes
 * 156-158 moved 5 m toward the centerline, which unflags them. Before the fix
 * the three ambiguous fixes released a suppression that 16.5 s of evidence had
 * earned, the start/finish line inside the pit lane fired, and one lap became
 * two. PIT_TRANSIT marks do not undo an invented lap boundary, and on a first
 * track day with no reference times a fabricated 118 s lap is
 * indistinguishable from a real one.
 */
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

describe('P9-FIX1 the noisy pit transit does not invent a lap', () => {
  const NOISY_FIXES = [156, 157, 158];

  const clean = (): LocationSample[] => withoutSpeed(motorparkPitLaneTransitLap(motorpark.profile));
  const noisy = (): LocationSample[] =>
    nudgeTowardCenterline(motorpark.runtime, clean(), NOISY_FIXES, 5);

  it('the perturbation really does unflag exactly those fixes', () => {
    // If the matcher ever stops flagging them for some other reason this test
    // would pass vacuously, so the premise is asserted rather than assumed.
    const flagged = (samples: readonly LocationSample[]): boolean[] => {
      const matcher = new TrackMatcher(motorpark.runtime, {
        corridorWidthM: motorpark.profile.corridorWidthM,
      });
      return samples.map((s) => matcher.match(s)?.onPitLane === true);
    };
    const before = flagged(clean());
    const after = flagged(noisy());
    for (const index of NOISY_FIXES) {
      expect(before[index], `fix ${index} was not a pit fix to begin with`).toBe(true);
      expect(after[index], `fix ${index} is still flagged, so nothing is being tested`).toBe(false);
    }
  });

  it('P9 as it shipped invents two laps out of one', () => {
    const shipped = runSessionPipeline(motorpark.runtime, noisy(), P9_AS_SHIPPED);
    expect(shipped.laps.map((lap) => Number((lap.durationMs / 1_000).toFixed(3)))).toEqual([
      118.067, 115.71,
    ]);
  });

  it('and P9-FIX1 gives back the single real lap, unchanged by the noise', () => {
    const fixed = runSessionPipeline(motorpark.runtime, noisy());
    expect(fixed.laps.map((lap) => Number((lap.durationMs / 1_000).toFixed(3)))).toEqual([233.777]);
    // The same sequence of crossings as the unperturbed transit: the noise
    // moved the instants by millimetres and the STRUCTURE not at all, which is
    // the property the ticket actually wanted. (Only the two start/finish
    // crossings outside the pit lane survive; the one inside it stays
    // suppressed, as it did before the perturbation.)
    const unperturbed = runSessionPipeline(motorpark.runtime, clean());
    const shape = (event: CrossingEvent): string => `${event.kind}|${event.direction}`;
    expect(fixed.crossings.map(shape)).toEqual(unperturbed.crossings.map(shape));
    expect(fixed.crossings.filter((event) => event.kind === 'startFinish')).toHaveLength(2);
  });
});

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

/**
 * Ticket P9-FIX2. Codex's second round, both findings, replayed exactly as
 * reported. They are a matched pair and that is the point: the SAME release
 * rule that let finding 1 invent laps also made finding 2 delete a real one,
 * so no threshold placed between them can be right. What these tests assert
 * is the property that replaces the threshold --
 *
 *   no input makes a lap boundary silently disappear, and no input makes a
 *   fabricated lap boundary appear unmarked.
 */
describe('P9-FIX2 neither failure can be silent', () => {
  const clean = (): LocationSample[] => withoutSpeed(motorparkPitLaneTransitLap(motorpark.profile));

  describe('Codex finding 1: the perturbation extended to 6000 ms', () => {
    // The original three fixes were 1500 ms. Nine are 6000 ms, which is what
    // defeated P9-FIX1's timed release exactly.
    const SIX_SECOND_FIXES = [150, 151, 152, 153, 154, 155, 156, 157, 158];
    const noisy = (): LocationSample[] =>
      nudgeTowardCenterline(motorpark.runtime, clean(), SIX_SECOND_FIXES, 5);

    it('the perturbation really does unflag all nine fixes, spanning 6000 ms', () => {
      const matcher = new TrackMatcher(motorpark.runtime, {
        corridorWidthM: motorpark.profile.corridorWidthM,
      });
      const after = noisy().map((s) => matcher.match(s)?.onPitLane === true);
      for (const index of SIX_SECOND_FIXES) {
        expect(after[index], `fix ${index} is still flagged, so nothing is tested`).toBe(false);
      }
      const base = clean();
      expect(
        (base[158]?.tMono ?? 0) - (base[150]?.tMono ?? 0),
        'the perturbation must span the 6 s that defeated the timed release',
      ).toBe(6_000);
    });

    it('P9-FIX1 invented two laps out of one at this length', () => {
      // P9-FIX1 exactly: the timed release, and the 6 s of clear fixes that
      // walked straight past it.
      const held = runSessionPipeline(motorpark.runtime, noisy(), P9_FIX1_RELEASE_HOLD);
      expect(seconds(held.laps)).toEqual([118.066981, 115.709573]);
    });

    it('and P9-FIX2 keeps the single real lap, because there is no timeout to outlast', () => {
      const fixed = runSessionPipeline(motorpark.runtime, noisy());
      expect(seconds(fixed.laps)).toEqual([233.776554]);
      // The structure is the unperturbed transit's, not a near miss of it.
      const shape = (event: CrossingEvent): string => `${event.kind}|${event.direction}`;
      expect(fixed.crossings.map(shape)).toEqual(
        runSessionPipeline(motorpark.runtime, clean()).crossings.map(shape),
      );
    });

    it('the length of the perturbation stops mattering', () => {
      // The reviewer's objection was that extending the timeout only moves
      // the boundary. There is no timeout left to move: the latch is held by
      // the flag coming back UP, not by a clock, so every one of these gives
      // back the single real lap where P9-FIX1 gave two invented ones past
      // 6 s.
      for (const span of [3, 6, 9, 15, 20]) {
        const indices = Array.from({ length: span }, (_, offset) => 159 - span + offset);
        const perturbed = nudgeTowardCenterline(motorpark.runtime, clean(), indices, 5);
        expect(
          seconds(runSessionPipeline(motorpark.runtime, perturbed).laps),
          `a ${span}-fix perturbation changed the answer`,
        ).toEqual([233.776554]);
      }
    });

    /**
     * Ticket P9-FIX2, THE DISCLOSED LIMIT. Widen the perturbation until it
     * reaches back past the pit entry itself -- 25 fixes, starting at 135,
     * where the flag first comes up at 133 -- and the detector is left with
     * two flagged fixes over 750 ms before the line. That is below the
     * sustained hold, so no occupancy ever forms and the start/finish
     * crossing inside the pit lane is emitted with nothing to mark it.
     *
     * No rule this detector can hold gets that case right: every fix it is
     * given says the car is on the centerline, and the `pitEntry` crossing
     * behind them has run past the 200 m the pipeline lets a pending entry
     * stand for. What is asserted instead is the thing that still has to
     * hold -- the lap does not come out VALID. The pipeline's own pit
     * evidence marks it `PIT_TRANSIT`, so the invented boundary is still
     * never presented as a lap that was driven.
     */
    it('a perturbation that erases the evidence entirely still cannot produce a VALID lap', () => {
      const indices = Array.from({ length: 25 }, (_, offset) => 135 + offset);
      const perturbed = nudgeTowardCenterline(motorpark.runtime, clean(), indices, 5);
      const result = runSessionPipeline(motorpark.runtime, perturbed);
      expect(seconds(result.laps)).toEqual([118.066981, 115.709573]);
      for (const lap of result.laps) {
        expect(lap.valid, 'an invented lap was presented as a real one').toBe(false);
        expect(lap.invalidReasons.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Codex finding 2: a real on-track lap the hold was deleting', () => {
    const BIASED_FIXES = Array.from({ length: 11 }, (_, offset) => 185 + offset);
    const twoCleanLaps = (): LocationSample[] =>
      driveLap(motorpark.profile, {
        speedMps: 40,
        noiseSigmaM: 0,
        sampleRateHz: 2,
        lapCount: 2,
      });
    const biased = (): LocationSample[] =>
      nudgeTowardPitLane(motorpark.runtime, twoCleanLaps(), BIASED_FIXES, 8);

    it('the bias really does flag fixes of a car that never leaves the centerline', () => {
      const matcher = new TrackMatcher(motorpark.runtime, {
        corridorWidthM: motorpark.profile.corridorWidthM,
      });
      const flagged = biased()
        .map((s, index) => (matcher.match(s)?.onPitLane === true ? index : -1))
        .filter((index) => index >= 0);
      expect(flagged.length).toBeGreaterThan(2);
      expect(flagged.every((index) => BIASED_FIXES.includes(index))).toBe(true);
    });

    it('P9-FIX1 collapsed two real laps into one', () => {
      const held = runSessionPipeline(motorpark.runtime, biased(), P9_FIX1_RELEASE_HOLD);
      expect(seconds(held.laps)).toEqual([202.906737]);
    });

    it('and P9-FIX2 keeps both boundaries, marked rather than deleted', () => {
      const fixed = runSessionPipeline(motorpark.runtime, biased());
      expect(seconds(fixed.laps)).toEqual([101.45327, 101.453467]);
      // Present AND disclosed: the boundary between them is one the detector
      // could not place, so both laps say so and neither can set a PB.
      for (const lap of fixed.laps) {
        expect(lap.valid).toBe(false);
        expect(lap.invalidReasons).toContain('PIT_AMBIGUOUS');
      }
      const boundary = fixed.crossings.find(
        (event) => event.kind === 'startFinish' && Math.abs(event.tCross - 101_953) < 2_000,
      );
      expect(boundary?.pitAmbiguous).toBe(true);
    });

    it('the unbiased run of the same two laps is untouched and fully valid', () => {
      const cleanRun = runSessionPipeline(motorpark.runtime, twoCleanLaps());
      expect(seconds(cleanRun.laps)).toEqual([101.453369, 101.453369]);
      expect(cleanRun.laps.every((lap) => lap.invalidReasons.length === 0)).toBe(true);
    });
  });

  describe('the disclosed missed-entry variant', () => {
    /**
     * The pit entry gate crossing is destroyed by removing the fixes that
     * bracket it, and then the original 156-158 perturbation is applied to
     * the same three fixes of the shortened run. Through P9-FIX1 this was the
     * worst case in the whole ticket: the pipeline never entered `inPit`, so
     * the two invented laps came out `valid: true` with NO invalid reasons at
     * all -- a fabricated 118 s lap presented as an ordinary one.
     */
    const shortened = (): LocationSample[] =>
      clean().filter((_, index) => index < 133 || index > 141);
    const noisy = (): LocationSample[] =>
      // 156-158 of the original run, minus the nine removed fixes.
      nudgeTowardCenterline(motorpark.runtime, shortened(), [147, 148, 149], 5);

    it('removing those fixes really does destroy the pit entry crossing', () => {
      const withEntry = runSessionPipeline(motorpark.runtime, clean());
      const without = runSessionPipeline(motorpark.runtime, shortened());
      expect(withEntry.crossings.filter((event) => event.kind === 'pitEntry')).toHaveLength(2);
      expect(without.crossings.filter((event) => event.kind === 'pitEntry')).toHaveLength(1);
    });

    it('P9-FIX1 invented two laps and marked NEITHER of them', () => {
      // With no pit entry crossing the occupancy was only provisional, and
      // P9-FIX1 released a provisional one on the first clear fix -- which
      // for this input is P9 as it shipped, bit for bit.
      const held = runSessionPipeline(motorpark.runtime, noisy(), P9_AS_SHIPPED);
      expect(seconds(held.laps)).toEqual([118.066981, 115.709573]);
      expect(held.laps.map((lap) => lap.invalidReasons)).toEqual([[], []]);
      expect(held.laps.every((lap) => lap.valid)).toBe(true);
    });

    it('P9-FIX2 still cannot tell, and says so instead of guessing', () => {
      const fixed = runSessionPipeline(motorpark.runtime, noisy());
      // The boundaries are still there -- with no confirmed pit entry the
      // detector has no right to delete them -- but every one of them is
      // marked, so nothing here can be mistaken for a lap that was driven.
      expect(seconds(fixed.laps)).toEqual([118.066981, 115.709573]);
      for (const lap of fixed.laps) {
        expect(lap.valid).toBe(false);
        expect(lap.invalidReasons).toContain('PIT_AMBIGUOUS');
      }
    });
  });

  describe('the invariant, over a sweep of perturbations on both circuits', () => {
    /**
     * The two findings are two points; this is the property they are points
     * of. Over a sweep of perturbation positions and widths on both circuits:
     * every lap the unperturbed run produced still has a boundary within a
     * second of where it was (nothing silently disappears), and every lap the
     * perturbation ADDED carries `PIT_AMBIGUOUS` (nothing is silently
     * fabricated).
     */
    const CASES = [
      {
        name: 'MotorPark pit transit, nudged toward the centerline',
        circuit: motorpark,
        build: (): LocationSample[] => withoutSpeed(motorparkPitLaneTransitLap(motorpark.profile)),
        metres: 5,
        nudge: nudgeTowardCenterline,
      },
      {
        name: 'MotorPark two clean laps, biased toward the pit lane',
        circuit: motorpark,
        build: (): LocationSample[] =>
          driveLap(motorpark.profile, {
            speedMps: 40,
            noiseSigmaM: 0,
            sampleRateHz: 2,
            lapCount: 2,
          }),
        metres: 8,
        nudge: nudgeTowardPitLane,
      },
      {
        name: 'TMR pit transit, nudged toward the centerline',
        circuit: tmr,
        build: (): LocationSample[] => withoutSpeed(pitLaneTransitLap(tmr.profile)),
        metres: 5,
        nudge: nudgeTowardCenterline,
      },
      {
        name: 'TMR two clean laps, biased toward the pit lane',
        circuit: tmr,
        build: (): LocationSample[] => multiLapSession(tmr.profile, 2),
        metres: 8,
        nudge: nudgeTowardPitLane,
      },
    ] as const;

    it.each(CASES.map((c) => [c.name, c] as const))('%s', (name, testCase) => {
      const base = testCase.build();
      const reference = runSessionPipeline(testCase.circuit.runtime, base);
      const referenceEnds = reference.laps.map((lap) => lap.tEnd);
      let perturbations = 0;
      for (let start = 20; start + 25 < base.length; start += 17) {
        for (const width of [1, 3, 9, 25]) {
          const indices = Array.from({ length: width }, (_, offset) => start + offset);
          const result = runSessionPipeline(
            testCase.circuit.runtime,
            testCase.nudge(testCase.circuit.runtime, base, indices, testCase.metres),
          );
          perturbations += 1;
          const ends = result.laps.map((lap) => lap.tEnd);
          const window = `fixes ${start}..${start + width - 1}`;
          for (const expected of referenceEnds) {
            expect(
              ends.some((tEnd) => Math.abs(tEnd - expected) < 1_000),
              `${name}: ${window} deleted the lap boundary at ${expected}`,
            ).toBe(true);
          }
          for (const lap of result.laps) {
            if (referenceEnds.some((tEnd) => Math.abs(tEnd - lap.tEnd) < 1_000)) continue;
            // An added boundary may be marked by the detector
            // (`PIT_AMBIGUOUS`) or by the pipeline's own pit state
            // (`PIT_TRANSIT`); what it may never be is VALID.
            expect(
              lap.valid,
              `${name}: ${window} invented an UNMARKED lap ending at ${lap.tEnd}`,
            ).toBe(false);
            expect(lap.invalidReasons.length).toBeGreaterThan(0);
          }
        }
      }
      expect(perturbations).toBeGreaterThan(10);
    });
  });
});
