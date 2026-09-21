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

/** Ticket P9-FIX2. See {@link CrossingDetector.pitOccupancy}. */
export type PitOccupancy = 'none' | 'unconfirmed' | 'confirmed';
/** Ticket P9-FIX2. How confidently one fix places the car in the pit lane. */
export type PitAssessment = 'clear' | 'ambiguous' | 'pit';

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
   * Ticket P9. How long the `onPitLane` flag must stay continuously up before
   * timing gates are suppressed, milliseconds. See
   * {@link DEFAULT_PIT_SUPPRESSION_HOLD_MS}. Zero, with
   * `pitSuppressionMinSamples` 1, restores the pre-P9 single-sample rule.
   */
  pitSuppressionHoldMs?: number;
  /**
   * Ticket P9. How many consecutive flagged fixes the hold above must contain.
   * See {@link DEFAULT_PIT_SUPPRESSION_MIN_SAMPLES}.
   */
  pitSuppressionMinSamples?: number;
  /**
   * Ticket P9. At or below this Doppler ground speed a flagged fix suppresses
   * timing gates immediately, without waiting out the hold. See
   * {@link DEFAULT_PIT_LIMITER_SPEED_MPS}. Zero disables the shortcut; the
   * hold then decides on its own, which is what happens whenever the speed
   * channel is absent or invalid.
   */
  pitLimiterSpeedMps?: number;
  /**
   * Ticket P9-FIX2. How long the `onPitLane` flag must stay continuously DOWN
   * before an unresolved pit occupancy is resolved as "back on track",
   * milliseconds. See {@link DEFAULT_PIT_RELEASE_HOLD_MS}. This window no
   * longer SUPPRESSES anything -- it is the window inside which a timing
   * crossing is emitted and marked {@link CrossingEvent.pitAmbiguous} -- so
   * lengthening it can only add disclosure, never delete a lap. Zero, with
   * `pitAmbiguityClearRangeM` zero, makes an unflagged fix resolve at once.
   */
  pitReleaseHoldMs?: number;
  /**
   * Ticket P9-FIX1. How many consecutive UNflagged fixes the release hold above
   * must contain. See {@link DEFAULT_PIT_RELEASE_MIN_SAMPLES}.
   */
  pitReleaseMinSamples?: number;
  /**
   * Ticket P9-FIX2. How much along-track progress the car must make with the
   * flag continuously DOWN before an unresolved occupancy is resolved as
   * "back on track", metres. See {@link DEFAULT_PIT_AMBIGUITY_CLEAR_RANGE_M}.
   */
  pitAmbiguityClearRangeM?: number;
  /**
   * Ticket P9-FIX2. Whether SUPPRESSING a timing gate requires a forward
   * `pitEntry` crossing behind the occupancy -- the same precondition
   * `SessionPipelineCore` puts on dispatching `PIT_ENTERED`. Default true.
   * Without it an occupancy can still be held and still MARK crossings, it
   * just may not delete one.
   *
   * Set false only to restore the pre-P9 and as-shipped-P9 rules for
   * measurement; production must never turn it off, because it is the only
   * thing standing between a burst of mis-flagged fixes on a slow corner and
   * a lap that silently never appears.
   */
  pitEntryGateRequired?: boolean;
  /**
   * Ticket P9-FIX2. The same, for an occupancy a forward `pitEntry` crossing
   * CONFIRMED, metres. See {@link DEFAULT_PIT_CONFIRMED_CLEAR_RANGE_M} for
   * why it is far longer than the unconfirmed one.
   */
  pitConfirmedClearRangeM?: number;
  /**
   * Ticket P9-FIX2, MEASUREMENT ONLY -- never set this in production.
   *
   * Restores P9-FIX1's release hold: while an occupancy stands, an UNflagged
   * fix goes on suppressing timing gates instead of marking them. That is the
   * rule Codex showed deleting a real on-track lap, and it is kept reachable
   * only so the regression tests can state the before number as well as the
   * after one.
   */
  pitUnflaggedFixSuppresses?: boolean;
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
 * Ticket P9. A single fix flagged `onPitLane` used to suppress EVERY timing
 * gate for that step, so one noisy fix beside the start/finish line deleted
 * the whole lap -- silently, with nothing shown to the driver and nothing
 * stored. The P8 measurement harness put that at 2-6 % of simulated laps.
 *
 * The fix is to ask for evidence that lasts, because a pit lane and a noise
 * spike differ in exactly that:
 *  - a pit lane is entered under a limiter (60 km/h at both circuits this app
 *    ships) and is 638 m (MotorPark) / 720 m (TMR) long, so it is OCCUPIED for
 *    tens of seconds. Measured on `motorparkPitLaneTransitLap`, the only
 *    fixture on either circuit whose pit transit crosses a timing gate at all,
 *    the flag has been continuously up for 16.5 s / 23 fixes by the time the
 *    car reaches the start/finish line;
 *  - GNSS multipath and racing-line excursions are correlated over about a
 *    second and are gone by the next fix or two.
 *
 * 2000 ms sits between those by an order of magnitude on each side: it is
 * longer than any single-fix or two-fix excursion at the 1 Hz worst case, and
 * it is 8x shorter than the 16.5 s of headroom the real pit transit leaves.
 * It is a DURATION and not a fix count because the noise it rejects is
 * correlated in time, and because the app runs anywhere from 1 to 10 Hz; the
 * separate minimum-sample floor below is what makes it rate-independent at the
 * slow end.
 */
const DEFAULT_PIT_SUPPRESSION_HOLD_MS = 2_000;
/**
 * Ticket P9. ...and no number of milliseconds may be satisfied by ONE fix. Two
 * is the floor: below 1 Hz a single fix can span the hold on its own, and a
 * single fix is precisely the evidence this ticket exists to stop trusting.
 */
const DEFAULT_PIT_SUPPRESSION_MIN_SAMPLES = 2;
/**
 * Ticket P9. A car crossing the start/finish line at racing speed is not in a
 * pit lane: both circuits limit the pit lane to 60 km/h (16.7 m/s). 20 m/s
 * (72 km/h) leaves headroom for Doppler error and for the moment before the
 * limiter engages, and is far below the 80-200 km/h the timing gates are
 * actually crossed at.
 *
 * Speed is used ONLY to make suppression FASTER -- a flagged fix that is also
 * slow suppresses at once, exactly as the pre-P9 code did. Correctness never
 * depends on it: a missing `speedMps`, or iOS's -1 for "no valid speed
 * solution", simply means the hold decides. It can therefore never cause a
 * genuine pit lane to go unsuppressed, only to be suppressed sooner.
 */
const DEFAULT_PIT_LIMITER_SPEED_MPS = 20;
/**
 * Ticket P9-FIX1 / P9-FIX2. THE DECISION THIS DETECTOR REFUSES TO GUESS.
 *
 * P9 asked for sustained evidence to ENGAGE suppression and left RELEASE
 * immediate. Codex broke that: three ambiguous fixes in the middle of a
 * genuine 16.5 s MotorPark pit transit released a suppression 16.5 s of
 * evidence had earned, and one 233.777 s lap became two invented ones of
 * 118.067 s and 115.710 s. P9-FIX1 answered with a timed release hold, and
 * Codex broke THAT in both directions at once:
 *
 *  - extend the same perturbation to 6000 ms and the invented laps come back;
 *  - and the hold itself DELETES a real on-track lap -- a MotorPark two-lap
 *    run whose fixes 185-195 are biased 8 m toward the pit polyline while the
 *    car stays on the centerline loses its 101.453 s boundary and reports one
 *    202.907 s lap.
 *
 * Its conclusion, which this ticket accepts: "simply extending the timeout
 * moves this failure boundary". Every threshold trades one silent failure for
 * the other, because the two polylines are 12.4 m apart inside a 16 m
 * corridor beside the start/finish line and the question is genuinely
 * undecidable from one burst of fixes.
 *
 * So the detector stops answering a binary. Occupancy is a LATCH that ends
 * only on evidence, and each fix is graded against it:
 *
 *  - `'pit'`   -- an occupancy CONFIRMED by the pipeline's own precondition (a
 *                 forward `pitEntry` crossing) and the flag up at this fix.
 *                 Timing gates are suppressed, exactly as P9 shipped.
 *  - `'clear'` -- no occupancy stands. Timing gates fire untouched.
 *  - `'ambiguous'` -- an occupancy stands but this fix does not corroborate
 *                 it: the flag is down inside an unresolved occupancy, or the
 *                 occupancy was never confirmed by a `pitEntry` crossing.
 *                 The crossing is EMITTED and marked
 *                 {@link CrossingEvent.pitAmbiguous}, because a lap that is
 *                 present and flagged can be reconciled afterwards and a lap
 *                 that was never emitted is gone.
 *
 * What makes this different from another threshold: the flag going down no
 * longer ENDS the occupancy, it only fails to corroborate it. So the 1500 ms
 * and the 6000 ms perturbations behave the SAME -- when the flag comes back
 * up the fix is `'pit'` again and the pit crossing is still suppressed, at
 * any perturbation length. There is no timeout left to push past.
 *
 * Occupancy ends on exactly two things, both of them evidence:
 *  - a forward `pitExit` crossing -- the geometric definition of rejoining
 *    the track, and the same event `SessionPipelineCore` dispatches
 *    `PIT_EXITED` on;
 *  - the car covering {@link DEFAULT_PIT_AMBIGUITY_CLEAR_RANGE_M} of
 *    along-track progress with the flag continuously down (and at least
 *    {@link DEFAULT_PIT_RELEASE_MIN_SAMPLES} fixes over
 *    {@link DEFAULT_PIT_RELEASE_HOLD_MS}). That is not a suppression timeout
 *    -- nothing is suppressed during it -- it is the point past which
 *    continuing to MARK laps would be noise.
 */
const DEFAULT_PIT_RELEASE_HOLD_MS = 6_000;
/**
 * Ticket P9-FIX1. ...and, as with engagement, no number of milliseconds may be
 * satisfied by one fix. Three, so that at the 1 Hz floor the resolution rests
 * on three independent observations rather than on one long gap between two.
 */
const DEFAULT_PIT_RELEASE_MIN_SAMPLES = 3;
/**
 * Ticket P9-FIX2. How far the car must travel along the track, flag
 * continuously down, before an unresolved occupancy is resolved as "back on
 * track" and laps stop being marked, metres.
 *
 * DISTANCE and not time, because "the car is somewhere else now" is a
 * statement about geography: 6 s means nothing at pit-lane speed and a great
 * deal at 45 m/s. 200 m is the pipeline's own pending-pit-entry range
 * ({@link PIT_ENTRY_PENDING_RANGE_M}), reused so the two modules expire the
 * same kind of evidence over the same span.
 *
 * It is bounded on both sides by measurement rather than taste:
 *  - too short would let a genuine pit transit go unmarked. The flag would
 *    have to stay wrongly down for 200 m of a 638 m (MotorPark) / 720 m (TMR)
 *    pit lane; GNSS multipath is correlated over about a second.
 *  - too long would mark laps after the car has plainly rejoined. From the
 *    pit exit to the next timing gate is 881.5 m at TMR and 1209.2 m at
 *    MotorPark, so even when the `pitExit` crossing is missed entirely the
 *    occupancy resolves 680 m before the next gate and nothing is marked.
 */
const DEFAULT_PIT_AMBIGUITY_CLEAR_RANGE_M = 200;
/**
 * Ticket P9-FIX2. The same, once a forward `pitEntry` crossing has CONFIRMED
 * the occupancy, metres. Much longer, and the two bounds that set it do not
 * leave much room to choose:
 *
 *  - it must exceed the longest pit lane on either circuit -- 720 m at TMR,
 *    638 m at MotorPark -- or a long enough stretch of wrongly-unflagged
 *    fixes resolves the occupancy WHILE THE CAR IS STILL IN THE PIT LANE, and
 *    the start/finish line inside the pit lane then fires as an ordinary lap.
 *    The first draft of this ticket used 200 m here and a 25-fix perturbation
 *    walked straight through it, which is the same class of defect as the
 *    timeout this ticket removed;
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
  private readonly pitSuppressionHoldMs: number;
  private readonly pitSuppressionMinSamples: number;
  private readonly pitLimiterSpeedMps: number;
  private readonly pitReleaseHoldMs: number;
  private readonly pitReleaseMinSamples: number;
  private readonly pitAmbiguityClearRangeM: number;
  private readonly pitConfirmedClearRangeM: number;
  /**
   * Ticket P9 / P9-FIX1 / P9-FIX2. The pit-occupancy LATCH, folded once per
   * fix. See {@link DEFAULT_PIT_RELEASE_HOLD_MS} for why it is a latch and
   * not a per-fix answer.
   *
   *  - `'none'`        -- nothing stands.
   *  - `'unconfirmed'` -- sustained flag (or the low-speed shortcut) with no
   *                       forward `pitEntry` crossing behind it. This is the
   *                       pipeline's own precondition for believing it is in
   *                       the pits, so without it the detector will not
   *                       suppress -- it marks instead.
   *  - `'confirmed'`   -- the same, WITH a forward `pitEntry` crossing behind
   *                       it. Only this may suppress a timing gate.
   */
  private pitOccupancy: PitOccupancy = 'none';
  /** The latch, and the raw flag, as they stood at the PREVIOUS fix. */
  private pitOccupancyBefore: PitOccupancy = 'none';
  private pitFlagUp = false;
  private pitFlagUpBefore = false;
  private readonly pitEntryGateRequired: boolean;
  private readonly pitUnflaggedFixSuppresses: boolean;
  private pitEvidenceStartTMono: number | null = null;
  private pitEvidenceSamples = 0;
  /** Ticket P9-FIX1/FIX2. The run of consecutive UNflagged fixes, if any. */
  private pitClearStartTMono: number | null = null;
  private pitClearStartProgressM: number | null = null;
  private pitClearSamples = 0;
  /**
   * Ticket P9-FIX1. Along-track progress at the last forward `pitEntry`
   * crossing, or null when none is pending. This is the pipeline's own
   * precondition for believing it is in the pits -- `SessionPipelineCore` will
   * not dispatch `PIT_ENTERED` without a forward `pitEntry` crossing first,
   * and drops the pending entry once progress runs 200 m past it unconfirmed
   * (`pipelineCore.ts`). The detector requires the same thing before an
   * occupancy may suppress, so the two agree on what "the car went into the
   * pits" means instead of each deciding privately.
   */
  private pitEntryPendingProgressM: number | null = null;
  /**
   * Ticket P9. Timing-gate crossings this detector suppressed because the car
   * was held to be in the pit lane. Silence is what made the original defect
   * so expensive to find: a lap simply never appeared, with nothing anywhere
   * saying why. This is the record that it was a decision rather than a loss.
   * `SessionPipelineCore` owns the detector privately and is outside this
   * ticket's write set, so nothing surfaces it to the driver yet.
   */
  private pitSuppressedCrossings = 0;
  private lastPitSuppressedGateId: string | null = null;
  private lastPitSuppressedTMono: number | null = null;
  /**
   * Ticket P9-FIX2. Timing-gate crossings emitted with the pit question left
   * open. These are the ones neither of the two silent failures can reach:
   * the lap exists, and it says so.
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
    this.pitSuppressionHoldMs = nonNegativeFinite(
      config.pitSuppressionHoldMs ?? DEFAULT_PIT_SUPPRESSION_HOLD_MS,
      'pitSuppressionHoldMs',
    );
    this.pitSuppressionMinSamples = Math.max(
      1,
      Math.floor(
        nonNegativeFinite(
          config.pitSuppressionMinSamples ?? DEFAULT_PIT_SUPPRESSION_MIN_SAMPLES,
          'pitSuppressionMinSamples',
        ),
      ),
    );
    this.pitLimiterSpeedMps = nonNegativeFinite(
      config.pitLimiterSpeedMps ?? DEFAULT_PIT_LIMITER_SPEED_MPS,
      'pitLimiterSpeedMps',
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
    this.pitEntryGateRequired = config.pitEntryGateRequired ?? true;
    this.pitUnflaggedFixSuppresses = config.pitUnflaggedFixSuppresses ?? false;
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
   * Ticket P9: how many timing-gate crossings were suppressed as pit-lane
   * transits, and the last one of them. A suppressed crossing is a lap that
   * will not appear; this is the only place that currently says so.
   */
  pitSuppressionDiagnostics(): {
    suppressedCrossings: number;
    lastSuppressedGateId: string | null;
    lastSuppressedTMono: number | null;
    /** Ticket P9-FIX2: crossings emitted with the pit question left open. */
    ambiguousCrossings: number;
    lastAmbiguousGateId: string | null;
    lastAmbiguousTMono: number | null;
    /** Timing gates are being suppressed right now. */
    engaged: boolean;
    /** Ticket P9-FIX1: an occupancy a forward `pitEntry` crossing confirmed. */
    established: boolean;
    /** Ticket P9-FIX2: an occupancy stands but this fix does not corroborate it. */
    ambiguous: boolean;
    occupancy: PitOccupancy;
  } {
    return {
      suppressedCrossings: this.pitSuppressedCrossings,
      lastSuppressedGateId: this.lastPitSuppressedGateId,
      lastSuppressedTMono: this.lastPitSuppressedTMono,
      ambiguousCrossings: this.pitAmbiguousCrossings,
      lastAmbiguousGateId: this.lastPitAmbiguousGateId,
      lastAmbiguousTMono: this.lastPitAmbiguousTMono,
      engaged: this.gradeFix(this.pitOccupancy, this.pitFlagUp) === 'pit',
      established: this.pitOccupancy === 'confirmed',
      ambiguous: this.gradeFix(this.pitOccupancy, this.pitFlagUp) === 'ambiguous',
      occupancy: this.pitOccupancy,
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
    this.pitOccupancy = 'none';
    this.pitOccupancyBefore = 'none';
    this.pitFlagUp = false;
    this.pitFlagUpBefore = false;
    this.pitEvidenceStartTMono = null;
    this.pitEvidenceSamples = 0;
    this.pitClearStartTMono = null;
    this.pitClearStartProgressM = null;
    this.pitClearSamples = 0;
    this.pitEntryPendingProgressM = null;
    this.pitSuppressedCrossings = 0;
    this.lastPitSuppressedGateId = null;
    this.lastPitSuppressedTMono = null;
    this.pitAmbiguousCrossings = 0;
    this.lastPitAmbiguousGateId = null;
    this.lastPitAmbiguousTMono = null;
  }

  /**
   * Ticket P9-FIX1 / P9-FIX2. Ends the occupancy. Both evidence windows go
   * with it, so re-engaging has to earn the sustained hold again from
   * scratch -- a car that has just rejoined the track is not half in the
   * pits. Called on a forward `pitExit` crossing (the occupancy is resolved
   * as a real pit visit that has now finished) and when the car has covered
   * {@link DEFAULT_PIT_AMBIGUITY_CLEAR_RANGE_M} with the flag down (resolved
   * as never having been one).
   */
  private resolvePitOccupancy(): void {
    this.pitOccupancy = 'none';
    this.pitEvidenceStartTMono = null;
    this.pitEvidenceSamples = 0;
    this.pitClearStartTMono = null;
    this.pitClearStartProgressM = null;
    this.pitClearSamples = 0;
    this.pitEntryPendingProgressM = null;
  }

  /**
   * Ticket P9-FIX2. How confidently one fix places the car in the pit lane,
   * given the latch that stood at it and its own `onPitLane` flag. Pure, so
   * a `pitEntry` crossed part-way through a step can be applied by grading
   * the step again with the occupancy upgraded.
   *
   *   latch / flag     up            down
   *   none             clear         clear
   *   unconfirmed      ambiguous     ambiguous
   *   confirmed        PIT           ambiguous
   *
   * The whole design is the two `ambiguous` cells in the `confirmed`/
   * `unconfirmed` rows: the flag going down does not END an occupancy (that
   * is the timeout that was pushed past twice) and an occupancy the pipeline
   * would not call a pit entry does not get to delete a lap.
   */
  private gradeFix(occupancy: PitOccupancy, flagUp: boolean): PitAssessment {
    if (occupancy === 'none') return 'clear';
    const confirmed = occupancy === 'confirmed' || !this.pitEntryGateRequired;
    if (!flagUp) return confirmed && this.pitUnflaggedFixSuppresses ? 'pit' : 'ambiguous';
    return confirmed ? 'pit' : 'ambiguous';
  }

  /**
   * Ticket P9 / P9-FIX1 / P9-FIX2. Folds one fix into the pit-lane occupancy
   * latch and grades it. Called at the top of `update()`, before any guard
   * can return, so the evidence is continuous over exactly the fixes the
   * detector sees.
   */
  private observePitLane(curr: TrackMatch, currSample: LocationSample): void {
    this.pitOccupancyBefore = this.pitOccupancy;
    this.pitFlagUpBefore = this.pitFlagUp;
    this.pitFlagUp = curr.onPitLane === true;
    const tMono = currSample.tMono;
    const progressM = Number.isFinite(curr.unwrappedProgressM) ? curr.unwrappedProgressM : null;

    // The pipeline's own expiry, mirrored: a pit entry that 200 m of progress
    // has not confirmed was not a pit entry, so it may no longer confirm an
    // occupancy. Once an occupancy IS confirmed the pending entry has done
    // its job and the expiry no longer applies -- a pit lane is longer than
    // 200 m at both circuits.
    if (
      this.pitEntryPendingProgressM !== null &&
      this.pitOccupancy !== 'confirmed' &&
      progressM !== null &&
      progressM - this.pitEntryPendingProgressM > PIT_ENTRY_PENDING_RANGE_M
    ) {
      this.pitEntryPendingProgressM = null;
    }

    if (curr.onPitLane) {
      this.pitClearStartTMono = null;
      this.pitClearStartProgressM = null;
      this.pitClearSamples = 0;
      if (this.pitEvidenceStartTMono === null || !Number.isFinite(tMono)) {
        this.pitEvidenceStartTMono = Number.isFinite(tMono) ? tMono : null;
        this.pitEvidenceSamples = 1;
      } else {
        this.pitEvidenceSamples += 1;
      }

      // Speed is a shortcut, never a requirement: iOS reports -1 when it has
      // no valid speed solution, and Android may omit the channel entirely.
      // It can only make the latch engage SOONER, and since P9-FIX2 it can
      // never suppress on its own -- an occupancy the speed shortcut engaged
      // is `'unconfirmed'` until a forward `pitEntry` crossing confirms it,
      // and an unconfirmed occupancy marks rather than deletes. That matters
      // because the slowest corners at both circuits are driven under the
      // 20 m/s the shortcut treats as pit-lane speed.
      const speedMps = currSample.speedMps;
      const speedIsValid =
        typeof speedMps === 'number' && Number.isFinite(speedMps) && speedMps >= 0;
      const underLimiter =
        this.pitLimiterSpeedMps > 0 && speedIsValid && speedMps <= this.pitLimiterSpeedMps;

      const start = this.pitEvidenceStartTMono;
      const elapsedMs = start === null ? 0 : tMono - start;
      const sustained =
        this.pitEvidenceSamples >= this.pitSuppressionMinSamples &&
        Number.isFinite(elapsedMs) &&
        elapsedMs >= this.pitSuppressionHoldMs;

      if (this.pitOccupancy === 'none' && (sustained || underLimiter)) {
        this.pitOccupancy = 'unconfirmed';
      }
      if (this.pitOccupancy === 'unconfirmed' && this.pitEntryPendingProgressM !== null) {
        this.pitOccupancy = 'confirmed';
      }
      return;
    }

    this.pitEvidenceStartTMono = null;
    this.pitEvidenceSamples = 0;
    if (this.pitOccupancy === 'none') {
      this.pitClearStartTMono = null;
      this.pitClearStartProgressM = null;
      this.pitClearSamples = 0;
      return;
    }

    // An occupancy stands and this fix does not corroborate it. It is NOT
    // released -- that is the timeout Codex pushed past twice -- it is
    // simply not confirmed at this fix, so crossings here are emitted and
    // marked instead of either suppressed or reported as ordinary laps.
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
    // A CONFIRMED occupancy takes far more contrary evidence to resolve than
    // an unconfirmed one: the first is a pit visit the pipeline agrees
    // happened, and resolving it early while the car is still in the pit lane
    // hands back the start/finish crossing inside it.
    const clearRangeRequiredM =
      this.pitOccupancy === 'confirmed'
        ? this.pitConfirmedClearRangeM
        : this.pitAmbiguityClearRangeM;
    if (
      this.pitClearSamples >= this.pitReleaseMinSamples &&
      clearMs >= this.pitReleaseHoldMs &&
      clearRangeM >= clearRangeRequiredM
    ) {
      this.resolvePitOccupancy();
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
     * Ticket P9-FIX2. A forward `pitEntry` crossed EARLIER IN THIS STEP can
     * confirm an occupancy that is otherwise only sustained -- the pit gate
     * and the timing gate can sit on the same step, and the entry is then
     * evidence the timing gate is entitled to. Found in a pre-pass so the
     * emission order of the gate loop below is untouched; applied only to
     * gates the car reached AFTER the entry (`intersection.t`), with an
     * exact tie resolved in favour of the entry, which is the suppressing
     * and therefore conservative direction.
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
     * Ticket P9 / P9-FIX2. How this step is graded against the pit-occupancy
     * latch. `'pit'` at either endpoint suppresses timing gates, exactly as
     * P9 shipped. `'ambiguous'` at either endpoint, with neither confirming,
     * emits them MARKED -- the case this ticket exists for, where suppressing
     * would delete a real lap and emitting silently would fabricate one.
     */
    const stepAssessment = (atGateT: number): PitAssessment => {
      const confirmedHere =
        earliestForwardPitEntryT !== null && atGateT >= earliestForwardPitEntryT;
      const upgrade = (occupancy: PitOccupancy): PitOccupancy =>
        confirmedHere && occupancy === 'unconfirmed' ? 'confirmed' : occupancy;
      const before = this.gradeFix(upgrade(this.pitOccupancyBefore), this.pitFlagUpBefore);
      const here = this.gradeFix(upgrade(this.pitOccupancy), this.pitFlagUp);
      if (before === 'pit' || here === 'pit') return 'pit';
      if (before === 'ambiguous' || here === 'ambiguous') return 'ambiguous';
      return 'clear';
    };

    const events: CrossingEvent[] = [];
    /**
     * Ticket P9-FIX1. A forward `pitExit` crossing is the authoritative end of
     * a pit transit -- it is the same event `SessionPipelineCore` dispatches
     * `PIT_EXITED` on, so the detector's occupancy and the pipeline's `inPit`
     * state end on one signal rather than on two unrelated rules. It is acted
     * on AFTER the loop, so the step that carries the exit is still suppressed
     * (exactly as the pre-P9 rule suppressed it) and only later steps are free.
     */
    let pitExitCrossed = false;
    for (const projected of this.projectedGates) {
      const intersection = segmentIntersection(from, to, projected.aLocal, projected.bLocal);
      if (intersection === null) continue;

      const assessment = isTimingGate(projected.gate)
        ? stepAssessment(intersection.t)
        : 'clear';
      if (assessment === 'pit') {
        // Recorded rather than silently dropped: this is a lap that will not
        // appear, and the driver's first circuit day is not the moment to
        // discover that no trace of the decision was kept.
        this.pitSuppressedCrossings += 1;
        this.lastPitSuppressedGateId = projected.gate.id;
        this.lastPitSuppressedTMono = currSample.tMono;
        continue;
      }

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
        // Ticket P9-FIX2. The confirmation the pre-pass above applied to this
        // step is made durable, so the next fix inherits a confirmed
        // occupancy rather than re-deriving it.
        if (this.pitOccupancy === 'unconfirmed') this.pitOccupancy = 'confirmed';
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
        // Ticket P9-FIX2. Only ever added, never set to false: absent keeps
        // its pre-FIX2 meaning for every consumer that does not read it.
        ...(assessment === 'ambiguous' ? { pitAmbiguous: true } : {}),
      });
    }
    if (pitExitCrossed) this.resolvePitOccupancy();
    return events;
  }
}
