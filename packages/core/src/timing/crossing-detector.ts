import type {
  CrossingDetector as CrossingDetectorContract,
  CrossingEvent,
  Gate,
  GeoProjection,
  LocalPoint,
  LocationSample,
  TrackMatch,
} from '../contracts';
import { crossingDirection, interpolateCrossingTime, segmentIntersection } from '../geometry';
import { kinematicCrossingFraction } from '../geometry/intersection';
import {
  AlongTrackFilter,
  type AlongTrackEstimate,
  type AlongTrackFilterConfig,
} from '../matching/along-track-filter';

/**
 * Ticket P11C. What the pit evidence says about ONE timing-gate crossing.
 *
 * There is no third value, and that is the whole of this ticket: a timing
 * gate crossing is always emitted, so the only question left is whether it
 * is emitted marked (`'ambiguous'`) or plain (`'clear'`). Nothing this type
 * can hold suppresses anything.
 */
export type PitAssessment = 'clear' | 'ambiguous';

export interface ProjectedGate {
  gate: Gate;
  aLocal: LocalPoint;
  bLocal: LocalPoint;
}

export interface CrossingDetectorConfig {
  minRearmDistanceM?: number;
  maxStepM?: number;
  /** See {@link DEFAULT_MAX_STEP_SPEED_MPS}. */
  maxStepSpeedMps?: number;
  /** See {@link DEFAULT_MAX_STEP_CEILING_M}. */
  maxStepCeilingM?: number;
  /**
   * Ticket P8.1. Compute `tCross` from a constant-acceleration model built on
   * the Doppler speed at each bracketing fix instead of assuming constant
   * speed. Default true. Affects the crossing INSTANT only; setting it false
   * restores linear interpolation exactly.
   */
  dopplerCrossingTime?: boolean;
  /**
   * Ticket P8.2. Take the two bracketing along-track distances from the 1-D
   * along-track filter rather than from the raw projection. Default true.
   * Affects the crossing INSTANT only. Requires `dopplerCrossingTime`'s inputs
   * to be present in practice, but the two switches are independent so the
   * measurement harness can isolate each stage.
   */
  alongTrackFusion?: boolean;
  /** Tuning for the P8.2 filter; see {@link AlongTrackFilterConfig}. */
  alongTrackFilter?: AlongTrackFilterConfig;
  /**
   * Hard bound on how far P8.2 may move the crossing point along the track,
   * metres. See {@link DEFAULT_MAX_ALONG_TRACK_CORRECTION_M}.
   */
  maxAlongTrackCorrectionM?: number;
  /**
   * Ticket P11C. How long the `onPitLane` flag must stay continuously UP
   * before the mark it produces OUTLIVES the fixes that produced it,
   * milliseconds. See {@link DEFAULT_PIT_EVIDENCE_HOLD_MS}. It never decides
   * whether a flagged fix marks its OWN step -- one always does.
   */
  pitEvidenceHoldMs?: number;
  /**
   * Ticket P11C. How many consecutive flagged fixes that hold must contain.
   * See {@link DEFAULT_PIT_EVIDENCE_MIN_SAMPLES}.
   */
  pitEvidenceMinSamples?: number;
  /**
   * Ticket P11C. How long the `onPitLane` flag must stay continuously DOWN
   * before standing pit evidence is resolved and crossings stop being MARKED,
   * milliseconds. See {@link DEFAULT_PIT_RELEASE_HOLD_MS}.
   *
   * Every one of the three numbers below only ever decides how long a mark
   * persists. None of them can remove a crossing, because nothing in this
   * file removes a crossing any more, so no value of them -- and no input
   * that walks past one of them -- can delete a lap boundary.
   */
  pitReleaseHoldMs?: number;
  /**
   * Ticket P11C. How many consecutive UNflagged fixes the release hold above
   * must contain. See {@link DEFAULT_PIT_RELEASE_MIN_SAMPLES}.
   */
  pitReleaseMinSamples?: number;
  /**
   * Ticket P11C. How much along-track progress the car must make with the
   * flag continuously DOWN before standing pit evidence is resolved, metres.
   * See {@link DEFAULT_PIT_AMBIGUITY_CLEAR_RANGE_M}.
   */
  pitAmbiguityClearRangeM?: number;
  /**
   * Ticket P11C. The same, while a forward `pitEntry` crossing stands behind
   * the evidence with no `pitExit` after it, metres. See
   * {@link DEFAULT_PIT_CONFIRMED_CLEAR_RANGE_M} for why it is far longer.
   */
  pitConfirmedClearRangeM?: number;
}

const DEFAULT_MIN_REARM_DISTANCE_M = 50;
/**
 * The step bound for a NOMINAL fix interval, metres. Unchanged at 120 m: at
 * the 1 Hz worst case of the supported fix rates this is ~432 km/h, so no car
 * reaches it and a genuine GPS teleport does.
 */
const DEFAULT_MAX_STEP_M = 120;
/**
 * Ticket P7M M4. The flat 120 m bound above is a DISTANCE with no notion of
 * how long the gap it spans lasted, and that is the bug: at 150 km/h
 * (41.7 m/s) a three-second dropout -- one lost fix at 1 Hz, or a short
 * tunnel/pit-building shadow at 10 Hz -- is ~126 m, so the step was discarded,
 * the segment that contained the start/finish line was never tested, and the
 * lap was silently lost. Widening the flat constant instead would weaken the
 * check for EVERY step, including the 0.1 s ones where 120 m really is
 * impossible.
 *
 * So the bound is scaled by the elapsed time at a speed no car on a circuit
 * this app targets can sustain, 90 m/s = 324 km/h. What the check still
 * protects against -- a position that jumped without the car moving -- is
 * exactly what this keeps rejecting: a teleport is defined by covering
 * ground faster than a car can, not by covering a lot of it.
 */
const DEFAULT_MAX_STEP_SPEED_MPS = 90;
/**
 * Absolute ceiling on the time-scaled bound, metres. Past roughly ten seconds
 * of dropout the straight line between two fixes stops being an approximation
 * of a driven path at all -- it can chord across a chicane or an infield and
 * intersect a gate the car never went near -- so beyond this the step is
 * refused however plausible its implied speed is.
 */
const DEFAULT_MAX_STEP_CEILING_M = 500;
const UNRELIABLE_CONFIDENCE_CAP = 0.3;
/**
 * Ticket P8.2. The filtered along-track distances may move the crossing point
 * by at most this much relative to the raw chord answer, metres. The raw
 * answer carries about 3 m of along-track noise and the filtered one about
 * 1.3 m, so a legitimate disagreement has a ~3.3 m sigma -- 9 m is roughly
 * 3 sigma. A disagreement wider than that is not the filter being smarter, it
 * is the filter having drifted, so the crossing falls back to raw geometry.
 */
const DEFAULT_MAX_ALONG_TRACK_CORRECTION_M = 9;
/**
 * Ticket P11C. THE RULE, AND WHY THERE IS NO LONGER A DECISION TO GET WRONG.
 *
 * Three attempts tried to decide whether the car was in the pit lane and to
 * SUPPRESS the timing-gate crossing when it believed it was:
 *
 *  - P9 suppressed on one flagged fix. It deleted real laps -- MotorPark lost
 *    one in six -- silently, with nothing stored and nothing shown.
 *  - P9-FIX1 asked for sustained evidence and released on a timeout. It broke
 *    in BOTH directions: a 6000 ms perturbation walked past the timeout and
 *    invented two laps out of one genuine 233.777 s pit transit, and the same
 *    timeout deleted a real 101.453 s boundary from two ordinary laps whose
 *    fixes were biased 8 m toward the pit polyline.
 *  - P9-FIX2 replaced the timeout with an occupancy latch confirmed by a
 *    forward `pitEntry` crossing. The reviewer defeated it with a wider
 *    perturbation in each direction: missing occupancy read as affirmative
 *    clearance (27 invented, unmarked laps), and a 10 m bias over 30 fixes
 *    satisfying the entry confirmation and deleting a real boundary (34
 *    deletions).
 *
 * Each round the reviewer found a wider or combined perturbation that beat
 * whatever threshold was current, and each round its suggested fix was the
 * same one: never delete a disputed boundary -- retain it and mark it. The pit
 * lane runs 12.4 m from the start/finish gate INSIDE the track's own 16 m
 * corridor at MotorPark and the two OSM ways share their junction nodes, so
 * the question is not hard, it is undecidable from the fixes, and every
 * threshold placed inside it trades one silent failure for the other.
 *
 * So the detector stops answering it. A start/finish or sector crossing is
 * ALWAYS emitted. Where any pit evidence bears on it the crossing is marked
 * {@link CrossingEvent.pitAmbiguous} and `LapTimingEngine` turns that into a
 * `PIT_AMBIGUOUS` invalid reason on BOTH adjacent laps; where there is none,
 * behaviour is exactly what it was.
 *
 * What that buys is not a better threshold but the removal of a whole failure
 * class: "a real boundary can never be deleted" is trivially true, because
 * nothing is deleted. No bias, no window width, no missing entry gate and no
 * value of any constant in this file can remove a crossing, because there is
 * no code path left that removes one. Only "is it marked" remains, and that is
 * a local decision on evidence the step already carries.
 *
 * ANY pit evidence marks, explicitly including the weak cases the previous
 * rules discarded:
 *  - the raw `onPitLane` flag up at EITHER bracketing fix (P9-FIX2 read a
 *    flagged fix with no latch behind it as affirmative clearance; that was
 *    the reviewer's first HIGH);
 *  - standing evidence from an earlier flagged fix that nothing has resolved
 *    yet, confirmed by a `pitEntry` crossing or not;
 *  - a forward `pitEntry` crossing with no `pitExit` after it, including one
 *    crossed earlier in this same step.
 *
 * The three constants below therefore only ever decide how long a MARK
 * persists after the flag goes down. They are bounded by measurement below,
 * but nothing depends on getting them right in the way the deleted thresholds
 * did: too short over-marks nothing and under-marks a lap the pipeline's own
 * `PIT_TRANSIT` evidence usually catches anyway; too long marks laps after the
 * car has plainly rejoined. Neither outcome can lose a lap.
 *
 * Standing evidence ends on exactly two things, both of them evidence:
 *  - a forward `pitExit` crossing -- the geometric definition of rejoining the
 *    track, and the same event `SessionPipelineCore` dispatches `PIT_EXITED`
 *    on;
 *  - the car covering {@link DEFAULT_PIT_AMBIGUITY_CLEAR_RANGE_M} of
 *    along-track progress with the flag continuously down (and at least
 *    {@link DEFAULT_PIT_RELEASE_MIN_SAMPLES} fixes over
 *    {@link DEFAULT_PIT_RELEASE_HOLD_MS}).
 */
/**
 * Ticket P11C. HOW LONG A MARK OUTLIVES THE FIXES THAT EARNED IT -- and the
 * one place where the amount of evidence still matters at all.
 *
 * A flagged fix ALWAYS marks a timing gate crossed on its own step; that is
 * not negotiable and needs no hold, because reading "one flagged fix, no latch
 * behind it" as affirmative clearance is precisely the reviewer's first HIGH.
 *
 * What this decides is different: whether the mark goes on standing over LATER
 * fixes that are not flagged. It has to, for a genuine pit transit whose flag
 * flickers -- that is the case three rounds of review kept breaking -- but if
 * ONE stray fix could do it, every lap at both circuits would be marked. The
 * pit lane and the centerline are OSM ways that share their junction nodes, so
 * a fix or two beside the pit entry and pit exit joins is flagged on an
 * ordinary lap, and the marking range is 200 m of progress.
 *
 * So standing evidence asks for what P9 asked for -- 2000 ms across at least
 * two fixes -- and for the same measured reason: a real pit lane is occupied
 * for tens of seconds (16.5 s at MotorPark by the time the line is reached)
 * while multipath and racing-line excursions are correlated over about a
 * second. The difference from P9 is what the answer is FOR: P9 used it to
 * decide whether to delete a lap, and this decides only how long to keep
 * saying "unsure". Failing the hold can no longer lose anything -- the
 * crossing is emitted either way, and the flagged step is marked either way.
 */
const DEFAULT_PIT_EVIDENCE_HOLD_MS = 2_000;
/**
 * Ticket P11C. ...and no number of milliseconds may be satisfied by ONE fix:
 * below 1 Hz a single fix can span the hold on its own.
 */
const DEFAULT_PIT_EVIDENCE_MIN_SAMPLES = 2;
const DEFAULT_PIT_RELEASE_HOLD_MS = 6_000;
/**
 * Ticket P11C. ...and no number of milliseconds may be satisfied by one fix.
 * Three, so that at the 1 Hz floor the resolution rests on three independent
 * observations rather than on one long gap between two.
 */
const DEFAULT_PIT_RELEASE_MIN_SAMPLES = 3;
/**
 * Ticket P11C. How far the car must travel along the track, flag continuously
 * down, before standing pit evidence is resolved and crossings stop being
 * marked, metres.
 *
 * DISTANCE and not time, because "the car is somewhere else now" is a
 * statement about geography: 6 s means nothing at pit-lane speed and a great
 * deal at 45 m/s. 200 m is the pipeline's own pending-pit-entry range, reused
 * so the two modules expire the same kind of evidence over the same span.
 *
 * It is bounded on both sides by measurement rather than taste:
 *  - too short would let a genuine pit transit go unmarked. The flag would
 *    have to stay wrongly down for 200 m of a 638 m (MotorPark) / 720 m (TMR)
 *    pit lane; GNSS multipath is correlated over about a second.
 *  - too long would mark laps after the car has plainly rejoined. From the
 *    pit exit to the next timing gate is 881.5 m at TMR and 1209.2 m at
 *    MotorPark, so even when the `pitExit` crossing is missed entirely the
 *    evidence resolves 680 m before the next gate and nothing is marked.
 */
const DEFAULT_PIT_AMBIGUITY_CLEAR_RANGE_M = 200;
/**
 * Ticket P11C. The same, while a forward `pitEntry` crossing stands behind the
 * evidence, metres. Much longer, and the two bounds that set it do not leave
 * much room to choose:
 *
 *  - it must exceed the longest pit lane on either circuit -- 720 m at TMR,
 *    638 m at MotorPark -- or a long enough stretch of wrongly-unflagged
 *    fixes resolves the evidence WHILE THE CAR IS STILL IN THE PIT LANE, and
 *    the start/finish line inside the pit lane then fires as an ordinary,
 *    unmarked lap. P9-FIX2 used 200 m here and a 25-fix perturbation walked
 *    straight through it;
 *  - it must stay under the distance from the pit EXIT to the next timing
 *    gate -- 881.5 m at TMR (exit 358.8 m, sector 1 at 1240.3 m), 1209.2 m at
 *    MotorPark (exit 177.1 m, sector 1 at 1386.3 m) -- so that a `pitExit`
 *    crossing the detector misses entirely costs no marked laps at all,
 *    rather than marking the rest of the session.
 *
 * 800 m is between 720 and 881.5. The window is 161 m wide and both edges are
 * measured from the shipped assets, so this is not a tuning parameter with a
 * comfortable value picked out of it -- it is the only range that satisfies
 * both circuits at once.
 */
const DEFAULT_PIT_CONFIRMED_CLEAR_RANGE_M = 800;
/**
 * Ticket P11C. How far a forward `pitEntry` crossing goes on being evidence on
 * its own, metres. See the comment in `observePitLane`: this one is bounded
 * from ABOVE by the circuits, not from below.
 */
const PIT_ENTRY_PENDING_RANGE_M = 200;
/**
 * Ticket P9-FIX1 (Codex MEDIUM). A Doppler speed the device actually solved
 * for: finite and non-negative. iOS reports -1 when it has no solution and
 * Android may omit the channel; both mean "no Doppler", and both must take
 * the crossing instant back to plain linear interpolation.
 */
function usableDopplerMps(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function interpolate(from: number, to: number, fraction: number): number {
  return from + (to - from) * fraction;
}

function isTimingGate(gate: Gate): boolean {
  return gate.kind === 'startFinish' || gate.kind === 'sector';
}

/**
 * Detects crossings against gates that have already been projected into the
 * same local ENU frame as `projection`.
 */
export class CrossingDetector implements CrossingDetectorContract {
  private readonly minRearmDistanceM: number;
  private readonly maxStepM: number;
  private readonly maxStepSpeedMps: number;
  private readonly maxStepCeilingM: number;
  private readonly lastForwardProgressByGate = new Map<string, number>();
  /**
   * Ticket P7M M4: steps this detector refused to test for crossings, and the
   * widest one it refused. A refusal can cost a whole lap, so it is no longer
   * discarded without trace -- `stepDiagnostics()` below is the record that a
   * fix gap big enough to have skipped the line actually happened. Nothing
   * consumes it yet (`SessionPipelineCore` owns the detector privately and is
   * outside this ticket's write set); it exists so the next investigation of a
   * missing lap can be answered instead of guessed at.
   */
  private skippedSteps = 0;
  private widestSkippedStepM = 0;
  /**
   * Ticket P8. The 1-D along-track estimator. It is owned privately here and
   * is fed the current fix at the TOP of `update()`, before any of the
   * detection guards can return -- so whether it runs is never coupled to
   * whether a crossing is reported, only the reverse. Everything that reads it
   * is inside `crossingTime()`, which is wrapped so that any failure degrades
   * to today's linear interpolation instead of losing the event.
   */
  private readonly alongTrack: AlongTrackFilter;
  private readonly dopplerCrossingTime: boolean;
  private readonly alongTrackFusion: boolean;
  private readonly maxAlongTrackCorrectionM: number;
  /** Posterior at the PREVIOUS fix (captured before this fix is folded in). */
  private previousEstimate: AlongTrackEstimate | null = null;
  /** Posterior at the CURRENT fix. */
  private currentEstimate: AlongTrackEstimate | null = null;
  /** Diagnostics: how many emitted crossings used each stage. */
  private kinematicCrossings = 0;
  private fusedCrossings = 0;
  private readonly pitEvidenceHoldMs: number;
  private readonly pitEvidenceMinSamples: number;
  private readonly pitReleaseHoldMs: number;
  private readonly pitReleaseMinSamples: number;
  private readonly pitAmbiguityClearRangeM: number;
  private readonly pitConfirmedClearRangeM: number;
  /**
   * Ticket P11C. Pit evidence that STANDS: the flag has been up for
   * {@link DEFAULT_PIT_EVIDENCE_HOLD_MS} across
   * {@link DEFAULT_PIT_EVIDENCE_MIN_SAMPLES} fixes and nothing has resolved it
   * yet. It ends only on the two pieces of evidence described at
   * {@link DEFAULT_PIT_RELEASE_HOLD_MS}.
   *
   * It exists so that a genuine pit transit whose flag flickers goes on being
   * marked across the gap. It is NOT what decides whether a flagged fix marks
   * its own step -- one always does, latch or no latch (see `stepAssessment`)
   * -- and it is not, and can no longer become, a licence to delete anything.
   */
  private pitEvidence = false;
  /** The latch, and the raw flag, as they stood at the PREVIOUS fix. */
  private pitEvidenceBefore = false;
  private pitFlagUp = false;
  private pitFlagUpBefore = false;
  /** Ticket P11C. The run of consecutive FLAGGED fixes, if any. */
  private pitFlaggedStartTMono: number | null = null;
  private pitFlaggedSamples = 0;
  /** Ticket P11C. The run of consecutive UNflagged fixes, if any. */
  private pitClearStartTMono: number | null = null;
  private pitClearStartProgressM: number | null = null;
  private pitClearSamples = 0;
  /**
   * Ticket P11C. Along-track progress at the last forward `pitEntry` crossing
   * with no `pitExit` after it, or null when none stands. `SessionPipelineCore`
   * will not dispatch `PIT_ENTERED` without a forward `pitEntry` crossing
   * first, and drops the pending entry once progress runs 200 m past it
   * uncorroborated (`pipelineCore.ts`); this mirrors that, so the two modules
   * expire the same kind of evidence over the same span.
   *
   * It is evidence in its own right -- an entry without a matching exit marks
   * -- and while it stands it also buys the longer clear range, because a pit
   * lane is longer than 200 m at both circuits.
   */
  private pitEntryPendingProgressM: number | null = null;
  /**
   * Ticket P11C. Timing-gate crossings emitted with the pit question left
   * open. There is deliberately no counterpart counter for suppressed
   * crossings: suppression is gone, so the number would be a constant zero
   * and a reader might take its existence for a path that can still fire.
   */
  private pitAmbiguousCrossings = 0;
  private lastPitAmbiguousGateId: string | null = null;
  private lastPitAmbiguousTMono: number | null = null;

  constructor(
    private readonly projectedGates: readonly ProjectedGate[],
    private readonly projection: Pick<GeoProjection, 'toLocal'>,
    config: CrossingDetectorConfig = {},
  ) {
    this.minRearmDistanceM = nonNegativeFinite(
      config.minRearmDistanceM ?? DEFAULT_MIN_REARM_DISTANCE_M,
      'minRearmDistanceM',
    );
    this.maxStepM = nonNegativeFinite(config.maxStepM ?? DEFAULT_MAX_STEP_M, 'maxStepM');
    this.maxStepSpeedMps = nonNegativeFinite(
      config.maxStepSpeedMps ?? DEFAULT_MAX_STEP_SPEED_MPS,
      'maxStepSpeedMps',
    );
    this.maxStepCeilingM = nonNegativeFinite(
      config.maxStepCeilingM ?? DEFAULT_MAX_STEP_CEILING_M,
      'maxStepCeilingM',
    );
    this.dopplerCrossingTime = config.dopplerCrossingTime ?? true;
    this.alongTrackFusion = config.alongTrackFusion ?? true;
    this.maxAlongTrackCorrectionM = nonNegativeFinite(
      config.maxAlongTrackCorrectionM ?? DEFAULT_MAX_ALONG_TRACK_CORRECTION_M,
      'maxAlongTrackCorrectionM',
    );
    this.pitEvidenceHoldMs = nonNegativeFinite(
      config.pitEvidenceHoldMs ?? DEFAULT_PIT_EVIDENCE_HOLD_MS,
      'pitEvidenceHoldMs',
    );
    this.pitEvidenceMinSamples = Math.max(
      1,
      Math.floor(
        nonNegativeFinite(
          config.pitEvidenceMinSamples ?? DEFAULT_PIT_EVIDENCE_MIN_SAMPLES,
          'pitEvidenceMinSamples',
        ),
      ),
    );
    this.pitReleaseHoldMs = nonNegativeFinite(
      config.pitReleaseHoldMs ?? DEFAULT_PIT_RELEASE_HOLD_MS,
      'pitReleaseHoldMs',
    );
    this.pitReleaseMinSamples = Math.max(
      1,
      Math.floor(
        nonNegativeFinite(
          config.pitReleaseMinSamples ?? DEFAULT_PIT_RELEASE_MIN_SAMPLES,
          'pitReleaseMinSamples',
        ),
      ),
    );
    this.pitConfirmedClearRangeM = nonNegativeFinite(
      config.pitConfirmedClearRangeM ?? DEFAULT_PIT_CONFIRMED_CLEAR_RANGE_M,
      'pitConfirmedClearRangeM',
    );
    this.pitAmbiguityClearRangeM = nonNegativeFinite(
      config.pitAmbiguityClearRangeM ?? DEFAULT_PIT_AMBIGUITY_CLEAR_RANGE_M,
      'pitAmbiguityClearRangeM',
    );
    this.alongTrack = new AlongTrackFilter(config.alongTrackFilter);
  }

  /**
   * Ticket P11C: how many timing-gate crossings were emitted with the pit
   * question left open, the last of them, and what evidence stands right now.
   *
   * There is no `suppressedCrossings`, because there is no suppression: the
   * P9/P9-FIX1/P9-FIX2 counter that recorded laps this detector had decided
   * not to report is gone along with the decision.
   */
  pitEvidenceDiagnostics(): {
    /** Crossings emitted carrying {@link CrossingEvent.pitAmbiguous}. */
    ambiguousCrossings: number;
    lastAmbiguousGateId: string | null;
    lastAmbiguousTMono: number | null;
    /** The `onPitLane` flag at the most recent fix. */
    flagUp: boolean;
    /** Unresolved evidence from an earlier flagged fix. */
    evidenceStanding: boolean;
    /** A forward `pitEntry` crossing with no `pitExit` after it. */
    pitEntryPending: boolean;
    /** What a timing gate crossed right now would be graded. */
    assessment: PitAssessment;
  } {
    return {
      ambiguousCrossings: this.pitAmbiguousCrossings,
      lastAmbiguousGateId: this.lastPitAmbiguousGateId,
      lastAmbiguousTMono: this.lastPitAmbiguousTMono,
      flagUp: this.pitFlagUp,
      evidenceStanding: this.pitEvidence,
      pitEntryPending: this.pitEntryPendingProgressM !== null,
      assessment:
        this.pitFlagUp || this.pitEvidence || this.pitEntryPendingProgressM !== null
          ? 'ambiguous'
          : 'clear',
    };
  }

  /** Ticket P7M M4: how many steps were discarded as implausible, and the widest of them (metres). */
  stepDiagnostics(): { skippedSteps: number; widestSkippedStepM: number } {
    return { skippedSteps: this.skippedSteps, widestSkippedStepM: this.widestSkippedStepM };
  }

  /**
   * Ticket P8: how the emitted crossings were timed. `linear` is today's
   * behaviour, `kinematic` used the Doppler constant-acceleration model, and
   * `fused` additionally took its endpoints from the along-track filter
   * (`fused` is a subset of `kinematic` whenever P8.1 is enabled).
   */
  timingDiagnostics(): {
    kinematicCrossings: number;
    fusedCrossings: number;
    alongTrackResets: number;
  } {
    return {
      kinematicCrossings: this.kinematicCrossings,
      fusedCrossings: this.fusedCrossings,
      alongTrackResets: this.alongTrack.resetCount,
    };
  }

  /**
   * The largest step, in metres, this detector will still test for crossings
   * given the elapsed time between the two fixes. Never below `maxStepM`, so
   * a nominal-interval step behaves exactly as it did before P7M M4.
   */
  private allowedStepM(prevSample: LocationSample, currSample: LocationSample): number {
    const elapsedMs = currSample.tMono - prevSample.tMono;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return this.maxStepM;
    const travelBound = this.maxStepSpeedMps * (elapsedMs / 1000);
    return Math.min(this.maxStepCeilingM, Math.max(this.maxStepM, travelBound));
  }

  reset(): void {
    this.lastForwardProgressByGate.clear();
    this.skippedSteps = 0;
    this.widestSkippedStepM = 0;
    this.alongTrack.reset();
    this.previousEstimate = null;
    this.currentEstimate = null;
    this.kinematicCrossings = 0;
    this.fusedCrossings = 0;
    this.pitEvidence = false;
    this.pitEvidenceBefore = false;
    this.pitFlagUp = false;
    this.pitFlagUpBefore = false;
    this.pitFlaggedStartTMono = null;
    this.pitFlaggedSamples = 0;
    this.pitClearStartTMono = null;
    this.pitClearStartProgressM = null;
    this.pitClearSamples = 0;
    this.pitEntryPendingProgressM = null;
    this.pitAmbiguousCrossings = 0;
    this.lastPitAmbiguousGateId = null;
    this.lastPitAmbiguousTMono = null;
  }

  /**
   * Ticket P11C. Ends the standing pit evidence. Both windows go with it, so
   * evidence has to be observed again from scratch -- a car that has just
   * rejoined the track is not half in the pits. Called on a forward `pitExit`
   * crossing (a real pit visit that has now finished) and when the car has
   * covered the clear range with the flag down (never having been one).
   *
   * Resolving it can only stop crossings being MARKED. It cannot make one
   * appear or disappear.
   */
  private resolvePitEvidence(): void {
    this.pitEvidence = false;
    this.pitFlaggedStartTMono = null;
    this.pitFlaggedSamples = 0;
    this.pitClearStartTMono = null;
    this.pitClearStartProgressM = null;
    this.pitClearSamples = 0;
    this.pitEntryPendingProgressM = null;
  }

  /**
   * Ticket P11C. Folds one fix into the standing pit evidence. Called at the
   * top of `update()`, before any guard can return, so the evidence is
   * continuous over exactly the fixes the detector sees.
   *
   * The flag going UP raises the evidence at once: P9's sustained hold existed
   * to keep one noisy fix from DELETING a lap, and with deletion gone the hold
   * only delayed a mark. Worse, the reviewer's first HIGH was exactly the hold
   * not having been met -- a flagged fix beside the line with no latch behind
   * it was read as affirmative clearance and the invented lap came out valid
   * and unmarked.
   */
  private observePitLane(curr: TrackMatch, currSample: LocationSample): void {
    this.pitEvidenceBefore = this.pitEvidence;
    this.pitFlagUpBefore = this.pitFlagUp;
    this.pitFlagUp = curr.onPitLane === true;
    const tMono = currSample.tMono;
    const progressM = Number.isFinite(curr.unwrappedProgressM) ? curr.unwrappedProgressM : null;

    /*
     * A pit entry stops being evidence once the car has covered
     * {@link PIT_ENTRY_PENDING_RANGE_M} of progress past it with nothing
     * corroborating it -- the same expiry `SessionPipelineCore` puts on its
     * own pending entry, so the two modules expire the same evidence over the
     * same span.
     *
     * The span cannot be widened, and that bound is measured rather than
     * chosen: at BOTH shipped circuits the racing line crosses the pitEntry
     * gate on every single lap, 382.2 m (TMR) and 477.0 m (MotorPark) before
     * the start/finish line. An entry that stayed evidence for longer than
     * that would mark every lap at both circuits, which is why "a pitEntry
     * crossing with no matching exit" is a WEAK signal here and is bounded
     * hard. See the disclosed residual in `p11c-pit-never-deletes.test.ts`.
     *
     * While flag evidence stands the expiry does not apply at all -- a pit
     * lane is longer than 200 m at both circuits -- and `resolvePitEvidence`
     * clears the pending entry along with everything else.
     */
    if (
      this.pitEntryPendingProgressM !== null &&
      !this.pitEvidence &&
      progressM !== null &&
      progressM - this.pitEntryPendingProgressM > PIT_ENTRY_PENDING_RANGE_M
    ) {
      this.pitEntryPendingProgressM = null;
    }

    if (curr.onPitLane) {
      this.pitClearStartTMono = null;
      this.pitClearStartProgressM = null;
      this.pitClearSamples = 0;
      if (this.pitFlaggedStartTMono === null || !Number.isFinite(tMono)) {
        this.pitFlaggedStartTMono = Number.isFinite(tMono) ? tMono : null;
        this.pitFlaggedSamples = 1;
      } else {
        this.pitFlaggedSamples += 1;
      }
      const start = this.pitFlaggedStartTMono;
      const elapsedMs = start === null ? 0 : tMono - start;
      // This fix marks its own step whatever this says (see `stepAssessment`).
      // The hold decides only whether the mark OUTLIVES it.
      if (
        this.pitFlaggedSamples >= this.pitEvidenceMinSamples &&
        Number.isFinite(elapsedMs) &&
        elapsedMs >= this.pitEvidenceHoldMs
      ) {
        this.pitEvidence = true;
      }
      return;
    }

    this.pitFlaggedStartTMono = null;
    this.pitFlaggedSamples = 0;
    if (!this.pitEvidence) {
      this.pitClearStartTMono = null;
      this.pitClearStartProgressM = null;
      this.pitClearSamples = 0;
      return;
    }

    // Evidence stands and this fix does not corroborate it. It is NOT
    // released on a clock -- that is the timeout that was pushed past twice
    // -- and releasing it would in any case only stop crossings here being
    // marked, never make one disappear.
    if (this.pitClearSamples === 0) {
      this.pitClearStartTMono = Number.isFinite(tMono) ? tMono : null;
      this.pitClearStartProgressM = progressM;
      this.pitClearSamples = 1;
    } else {
      this.pitClearSamples += 1;
    }
    const clearStart = this.pitClearStartTMono;
    // Out-of-order fixes clamp to zero rather than counting backwards.
    const clearMs =
      clearStart === null || !Number.isFinite(tMono) ? 0 : Math.max(0, tMono - clearStart);
    const clearStartProgressM = this.pitClearStartProgressM;
    const clearRangeM =
      clearStartProgressM === null || progressM === null
        ? 0
        : Math.max(0, progressM - clearStartProgressM);
    // Evidence a `pitEntry` crossing stands behind takes far more contrary
    // evidence to resolve: it is a pit visit the pipeline agrees happened, and
    // resolving it early while the car is still in the pit lane would stop
    // marking the start/finish crossing inside it.
    const clearRangeRequiredM =
      this.pitEntryPendingProgressM !== null
        ? this.pitConfirmedClearRangeM
        : this.pitAmbiguityClearRangeM;
    if (
      this.pitClearSamples >= this.pitReleaseMinSamples &&
      clearMs >= this.pitReleaseHoldMs &&
      clearRangeM >= clearRangeRequiredM
    ) {
      this.resolvePitEvidence();
    }
  }

  /**
   * Ticket P8.2. Folds one fix into the along-track filter. Called first thing
   * in `update()` so it runs on exactly the samples the detector sees, and
   * never gates a crossing. Any throw is swallowed and the filter dropped --
   * losing precision, never a lap.
   */
  private observeAlongTrack(curr: TrackMatch, currSample: LocationSample): void {
    this.previousEstimate = this.currentEstimate;
    try {
      this.currentEstimate = this.alongTrack.observe({
        tMono: currSample.tMono,
        measuredDistanceM: curr.unwrappedProgressM,
        speedMps: currSample.speedMps,
        accuracyM: currSample.accuracyM,
      });
    } catch {
      this.currentEstimate = null;
      this.alongTrack.reset();
    }
  }

  /**
   * Ticket P8. The crossing INSTANT, and nothing else. Two independent
   * refinements over `interpolateCrossingTime(tPrev, tCurr, chordT)`:
   *
   *  P8.2 replaces the chord DISTANCE fraction with one measured between the
   *    filter's two along-track estimates. The gate's own along-track
   *    coordinate is `gateProgressM`, which the caller already computes as
   *    `interpolate(prevProgress, currProgress, chordT)` -- and which is far
   *    less noisy than either endpoint, because the same raw endpoint errors
   *    that shift `chordT` shift the interpolation back: substituting
   *    `chordT = (s_gate - m0)/(m1 - m0)` into `m0 + chordT*(m1 - m0)` returns
   *    `s_gate` with both measurement errors cancelled. So the gate is the
   *    anchor and only the ENDPOINTS need denoising.
   *
   *  P8.1 turns that distance fraction into a time fraction under constant
   *    acceleration (see `kinematicCrossingFraction`).
   *
   * Every branch degrades to the previous one; the last line is exactly
   * today's call.
   */
  private crossingTime(
    prevSample: LocationSample,
    currSample: LocationSample,
    chordT: number,
    gateProgressM: number,
  ): number {
    /**
     * Ticket P9-FIX1 (Codex MEDIUM). The stated contract is that without
     * valid Doppler at BOTH bracketing fixes the instant is bit-identical to
     * the pre-P8 linear interpolation. It was not: the along-track filter is
     * position-only-capable, so at 10 Hz with no speed channel at all it still
     * converged and fed its own inferred velocities into the kinematic model
     * (linear 9938.461538461539 ms vs 9946.915566660227 ms, with both counters
     * incremented). Neither refinement may run on inferred speed, so the gate
     * is here, above both of them, and reads the RAW bracketing samples.
     */
    if (
      usableDopplerMps(prevSample.speedMps) === null ||
      usableDopplerMps(currSample.speedMps) === null
    ) {
      return interpolateCrossingTime(prevSample.tMono, currSample.tMono, chordT);
    }

    let fraction = chordT;
    let entrySpeedMps = prevSample.speedMps;
    let exitSpeedMps = currSample.speedMps;

    const before = this.previousEstimate;
    const after = this.currentEstimate;
    if (
      this.alongTrackFusion &&
      before !== null &&
      after !== null &&
      before.converged &&
      after.converged &&
      before.tMono === prevSample.tMono &&
      after.tMono === currSample.tMono
    ) {
      const spanM = after.distanceM - before.distanceM;
      if (Number.isFinite(spanM) && spanM > 0) {
        const fused = (gateProgressM - before.distanceM) / spanM;
        if (Number.isFinite(fused) && fused > 0 && fused < 1) {
          if (Math.abs(fused - chordT) * spanM <= this.maxAlongTrackCorrectionM) {
            fraction = fused;
            entrySpeedMps = before.speedMps;
            exitSpeedMps = after.speedMps;
            this.fusedCrossings += 1;
          }
        }
      }
    }

    if (this.dopplerCrossingTime) {
      const kinematic = kinematicCrossingFraction(fraction, entrySpeedMps, exitSpeedMps);
      if (kinematic !== fraction) this.kinematicCrossings += 1;
      fraction = kinematic;
    }
    return interpolateCrossingTime(prevSample.tMono, currSample.tMono, fraction);
  }

  /**
   * Ticket P8. The refinement above must never be able to suppress an event,
   * so a throw from any of it collapses to the pre-P8 call. The fallback is
   * bit-for-bit the line this detector shipped before P8.
   */
  private safeCrossingTime(
    prevSample: LocationSample,
    currSample: LocationSample,
    chordT: number,
    gateProgressM: number,
  ): number {
    try {
      return this.crossingTime(prevSample, currSample, chordT, gateProgressM);
    } catch {
      return interpolateCrossingTime(prevSample.tMono, currSample.tMono, chordT);
    }
  }

  update(
    prev: TrackMatch | null,
    curr: TrackMatch,
    prevSample: LocationSample | null,
    currSample: LocationSample,
  ): CrossingEvent[] {
    this.observeAlongTrack(curr, currSample);
    this.observePitLane(curr, currSample);
    if (prev === null || prevSample === null) return [];
    if (prev.quality.level === 'invalid' || curr.quality.level === 'invalid') return [];

    const from = this.projection.toLocal({ lat: prevSample.lat, lon: prevSample.lon });
    const to = this.projection.toLocal({ lat: currSample.lat, lon: currSample.lon });
    const stepM = Math.hypot(to.e - from.e, to.n - from.n);
    if (stepM > this.allowedStepM(prevSample, currSample)) {
      this.skippedSteps += 1;
      if (stepM > this.widestSkippedStepM) this.widestSkippedStepM = stepM;
      return [];
    }

    /**
     * Ticket P11C. A forward `pitEntry` crossed EARLIER IN THIS STEP is pit
     * evidence the timing gate after it is entitled to -- the pit gate and the
     * timing gate can sit on the same step. Found in a pre-pass so the
     * emission order of the gate loop below is untouched; applied only to
     * gates the car reached AFTER the entry (`intersection.t`), with an exact
     * tie resolved in favour of the entry, which is the marking and therefore
     * conservative direction.
     */
    let earliestForwardPitEntryT: number | null = null;
    for (const projected of this.projectedGates) {
      if (projected.gate.kind !== 'pitEntry') continue;
      const hit = segmentIntersection(from, to, projected.aLocal, projected.bLocal);
      if (hit === null) continue;
      if (crossingDirection(projected.aLocal, projected.bLocal, from, to) !== 'forward') continue;
      if (earliestForwardPitEntryT === null || hit.t < earliestForwardPitEntryT) {
        earliestForwardPitEntryT = hit.t;
      }
    }

    /**
     * Ticket P11C. ANY pit evidence bearing on a timing gate crossed on this
     * step, listed exhaustively -- every one of these marks, and there is no
     * combination of them that deletes:
     *
     *  - the raw `onPitLane` flag at either bracketing fix. A flagged fix with
     *    nothing standing behind it used to grade `'clear'`, which is the
     *    reviewer's first HIGH: absence of a latch is not clearance;
     *  - standing evidence from an earlier flagged fix that nothing has
     *    resolved, at either bracketing fix, corroborated by a `pitEntry`
     *    crossing or not;
     *  - a forward `pitEntry` crossing with no `pitExit` after it, whether it
     *    stands from an earlier step or was crossed earlier in this one.
     */
    const stepAssessment = (atGateT: number): PitAssessment => {
      const entryHere = earliestForwardPitEntryT !== null && atGateT >= earliestForwardPitEntryT;
      const evidence =
        this.pitFlagUpBefore ||
        this.pitFlagUp ||
        this.pitEvidenceBefore ||
        this.pitEvidence ||
        this.pitEntryPendingProgressM !== null ||
        entryHere;
      return evidence ? 'ambiguous' : 'clear';
    };

    const events: CrossingEvent[] = [];
    /**
     * Ticket P11C. A forward `pitExit` crossing is the authoritative end of a
     * pit transit -- it is the same event `SessionPipelineCore` dispatches
     * `PIT_EXITED` on, so the detector's evidence and the pipeline's `inPit`
     * state end on one signal rather than on two unrelated rules. It is acted
     * on AFTER the loop, so a timing gate on the very step the car left on is
     * still MARKED, which is the conservative direction and costs nothing.
     */
    let pitExitCrossed = false;
    for (const projected of this.projectedGates) {
      const intersection = segmentIntersection(from, to, projected.aLocal, projected.bLocal);
      if (intersection === null) continue;

      /**
       * Ticket P11C. THE LINE THAT USED TO DELETE LAPS. It read
       * `if (assessment === 'pit') continue;` and three rounds of review each
       * found a wider perturbation that reached it with a real boundary in
       * hand. There is no `continue` here any more and no other early exit
       * below that pit evidence can reach, so from here on every timing-gate
       * crossing this loop sees is emitted. The assessment decides only
       * whether it carries a mark.
       */
      const assessment = isTimingGate(projected.gate)
        ? stepAssessment(intersection.t)
        : 'clear';

      const direction = crossingDirection(projected.aLocal, projected.bLocal, from, to);
      const crossingProgressM = interpolate(
        prev.unwrappedProgressM,
        curr.unwrappedProgressM,
        intersection.t,
      );

      const lastForwardProgress = this.lastForwardProgressByGate.get(projected.gate.id);
      if (
        lastForwardProgress !== undefined &&
        crossingProgressM - lastForwardProgress < this.minRearmDistanceM
      ) {
        continue;
      }
      if (direction === 'forward') {
        this.lastForwardProgressByGate.set(projected.gate.id, crossingProgressM);
      }

      if (projected.gate.kind === 'pitExit' && direction === 'forward') pitExitCrossed = true;
      if (projected.gate.kind === 'pitEntry' && direction === 'forward') {
        this.pitEntryPendingProgressM = crossingProgressM;
      }

      if (assessment === 'ambiguous') {
        this.pitAmbiguousCrossings += 1;
        this.lastPitAmbiguousGateId = projected.gate.id;
        this.lastPitAmbiguousTMono = currSample.tMono;
      }

      const unreliable = prev.quality.level === 'unreliable' || curr.quality.level === 'unreliable';
      const matchConfidence = Math.min(prev.confidence, curr.confidence);
      events.push({
        gateId: projected.gate.id,
        kind: projected.gate.kind,
        tCross: this.safeCrossingTime(
          prevSample,
          currSample,
          intersection.t,
          crossingProgressM,
        ),
        direction,
        confidence: unreliable
          ? Math.min(matchConfidence, UNRELIABLE_CONFIDENCE_CAP)
          : matchConfidence,
        lapDistanceM: crossingProgressM,
        // Ticket P11C. Only ever added, never set to false: absent keeps its
        // original meaning for every consumer that does not read it.
        ...(assessment === 'ambiguous' ? { pitAmbiguous: true } : {}),
      });
    }
    if (pitExitCrossed) this.resolvePitEvidence();
    return events;
  }
}
