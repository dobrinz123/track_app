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
   * Ticket P9-FIX1. How long the `onPitLane` flag must stay continuously DOWN
   * before an ESTABLISHED pit occupancy is released, milliseconds. See
   * {@link DEFAULT_PIT_RELEASE_HOLD_MS}. Zero restores the pre-FIX1 immediate
   * release. Ignored while occupancy is only provisional (see
   * {@link CrossingDetectorConfig.pitLimiterSpeedMps}), and short-circuited
   * entirely by a forward `pitExit` crossing.
   */
  pitReleaseHoldMs?: number;
  /**
   * Ticket P9-FIX1. How many consecutive UNflagged fixes the release hold above
   * must contain. See {@link DEFAULT_PIT_RELEASE_MIN_SAMPLES}.
   */
  pitReleaseMinSamples?: number;
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
 * Ticket P9-FIX1. P9 asked for sustained evidence to ENGAGE suppression and
 * left RELEASE immediate, and argued from that that the newly suppressed set
 * is a subset of the old one. The subset is real and the argument is wrong:
 * a subset property covers engagement and says nothing about release. Codex
 * reproduced the hole on `motorparkPitLaneTransitLap` -- omit the speed
 * channel, move three fixes of a genuine pit transit 5 m toward the
 * centerline, and those three ambiguous fixes released a suppression that
 * 16.5 s of evidence had earned. The pit crossing then fired and one 233.777 s
 * lap became two invented ones of 118.067 s and 115.710 s. Marking them
 * PIT_TRANSIT does not undo the fabricated lap boundary, and on a first track
 * day with no reference times a fabricated 118 s lap is indistinguishable
 * from a real one.
 *
 * So release now needs evidence too, and the two authorities it uses are the
 * SAME two the pipeline's own `inPit` state machine uses, rather than a third
 * private notion of being in the pits:
 *
 *  - the authoritative one is a forward `pitExit` crossing. That is the
 *    geometric definition of rejoining the track, it is what
 *    `SessionPipelineCore` dispatches `PIT_EXITED` on, and this detector
 *    already computes it. It releases immediately and no amount of noise can
 *    fake it, because it is a gate crossing and not a corridor test;
 *  - the backstop, for when that gate is never crossed, is the flag being
 *    continuously DOWN for this long. 6000 ms is 3x the engagement hold and
 *    ~6x the ~1 s correlation time of a multipath excursion, so no plausible
 *    burst of ambiguous fixes spans it (Codex's three spanned 1500 ms).
 *
 * The cost of holding too long is bounded and was measured, not guessed: from
 * the pit exit gate to the next timing gate is 881.5 m at TMR (exit 358.8 m,
 * sector 1 at 1240.3 m) and 1209.2 m at MotorPark (exit 177.1 m, sector 1 at
 * 1386.3 m). Even at an implausible 45 m/s merge that is 19.6 s at the tighter
 * of the two, so a 6 s backstop cannot cost a timing gate even if the
 * `pitExit` crossing is missed entirely.
 *
 * The hysteresis applies ONLY to an ESTABLISHED occupancy -- one that earned
 * the full sustained hold. An occupancy engaged by the low-speed shortcut
 * alone is provisional and still releases on the first clear fix, exactly as
 * P9 shipped, so a single slow flagged fix beside the line can never latch.
 */
const DEFAULT_PIT_RELEASE_HOLD_MS = 6_000;
/**
 * Ticket P9-FIX1. ...and, as with engagement, no number of milliseconds may be
 * satisfied by one fix. Three, so that at the 1 Hz floor the release rests on
 * three independent observations rather than on one long gap between two.
 */
const DEFAULT_PIT_RELEASE_MIN_SAMPLES = 3;
/**
 * Ticket P9-FIX1. How far along-track a forward `pitEntry` crossing may keep
 * authorising a latch before it is treated as unconfirmed, metres. Not a new
 * number: it is `SessionPipelineCore`'s own pending-pit-entry range, copied so
 * the detector and the pipeline expire the same evidence at the same point.
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
  private readonly pitSuppressionHoldMs: number;
  private readonly pitSuppressionMinSamples: number;
  private readonly pitLimiterSpeedMps: number;
  private readonly pitReleaseHoldMs: number;
  private readonly pitReleaseMinSamples: number;
  /**
   * Ticket P9 / P9-FIX1. The pit-occupancy state, folded once per fix.
   * `engaged` is the suppression latch AFTER the current fix, `engagedBefore`
   * the same thing after the previous one; a step is suppressed when either
   * endpoint was engaged.
   *
   * There are two grades of occupancy, and they release differently:
   *
   *  - PROVISIONAL: engaged by the low-speed shortcut alone, on as little as
   *    one flagged fix. It releases on the first unflagged fix, exactly as P9
   *    shipped, so a single slow noisy fix beside the line can never latch;
   *  - ESTABLISHED: the flag stayed up for the full sustained hold. Codex
   *    showed that releasing THIS on the first ambiguous fix invents laps --
   *    three noisy fixes in the middle of a 16.5 s pit transit released it and
   *    a 233.777 s lap became two of 118.067 s and 115.710 s. So an
   *    established occupancy survives brief ambiguity: it ends on a forward
   *    `pitExit` crossing (the same event the pipeline dispatches `PIT_EXITED`
   *    on) or on the flag staying down for {@link DEFAULT_PIT_RELEASE_HOLD_MS}.
   *
   * Engagement is UNCHANGED from P9 and still requires the flag itself, so
   * `engaged` at a fix still implies `onPitLane` at that fix or at a fix
   * within the release window behind it. What P9's subset argument covered --
   * that no noise spike can newly engage suppression -- therefore still holds
   * exactly; what it did not cover, release, is what this state adds.
   */
  private pitEngaged = false;
  private pitEngagedBefore = false;
  private pitEstablished = false;
  private pitEvidenceStartTMono: number | null = null;
  private pitEvidenceSamples = 0;
  /** Ticket P9-FIX1. Consecutive UNflagged fixes, and when that run started. */
  private pitClearStartTMono: number | null = null;
  private pitClearSamples = 0;
  /**
   * Ticket P9-FIX1. Along-track progress at the last forward `pitEntry`
   * crossing, or null when none is pending. This is the pipeline's own
   * precondition for believing it is in the pits -- `SessionPipelineCore` will
   * not dispatch `PIT_ENTERED` without a forward `pitEntry` crossing first,
   * and drops the pending entry once progress runs 200 m past it unconfirmed
   * (`pipelineCore.ts`). The detector now requires the same thing before an
   * occupancy may LATCH, so the two agree on what "the car went into the pits"
   * means instead of each deciding privately.
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
    engaged: boolean;
    /** Ticket P9-FIX1: occupancy that earned the full hold, and so releases slowly. */
    established: boolean;
  } {
    return {
      suppressedCrossings: this.pitSuppressedCrossings,
      lastSuppressedGateId: this.lastPitSuppressedGateId,
      lastSuppressedTMono: this.lastPitSuppressedTMono,
      engaged: this.pitEngaged,
      established: this.pitEstablished,
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
    this.pitEngaged = false;
    this.pitEngagedBefore = false;
    this.pitEstablished = false;
    this.pitEvidenceStartTMono = null;
    this.pitEvidenceSamples = 0;
    this.pitClearStartTMono = null;
    this.pitClearSamples = 0;
    this.pitEntryPendingProgressM = null;
    this.pitSuppressedCrossings = 0;
    this.lastPitSuppressedGateId = null;
    this.lastPitSuppressedTMono = null;
  }

  /**
   * Ticket P9-FIX1. Drops pit occupancy entirely. Both the latch and both
   * evidence windows go, so re-engaging has to earn the hold again from
   * scratch -- a car that has just rejoined the track is not half-in the pits.
   */
  private releasePitOccupancy(): void {
    this.pitEngaged = false;
    this.pitEstablished = false;
    this.pitEvidenceStartTMono = null;
    this.pitEvidenceSamples = 0;
    this.pitClearStartTMono = null;
    this.pitClearSamples = 0;
    this.pitEntryPendingProgressM = null;
  }

  /**
   * Ticket P9 / P9-FIX1. Folds one fix into the pit-lane occupancy state.
   * Called at the top of `update()`, before any guard can return, so the
   * evidence is continuous over exactly the fixes the detector sees.
   */
  private observePitLane(curr: TrackMatch, currSample: LocationSample): void {
    this.pitEngagedBefore = this.pitEngaged;
    const tMono = currSample.tMono;

    // The pipeline's own expiry, mirrored: a pit entry that 200 m of progress
    // has not confirmed was not a pit entry, so it may no longer authorise a
    // latch. Once occupancy is established the pending entry has done its job.
    if (
      this.pitEntryPendingProgressM !== null &&
      !this.pitEstablished &&
      Number.isFinite(curr.unwrappedProgressM) &&
      curr.unwrappedProgressM - this.pitEntryPendingProgressM > PIT_ENTRY_PENDING_RANGE_M
    ) {
      this.pitEntryPendingProgressM = null;
    }

    if (!curr.onPitLane) {
      this.pitEvidenceStartTMono = null;
      this.pitEvidenceSamples = 0;
      if (!this.pitEngaged) {
        this.pitClearStartTMono = null;
        this.pitClearSamples = 0;
        return;
      }
      // Provisional occupancy, or the hysteresis configured off: release on
      // the first clear fix, bit-for-bit the pre-FIX1 behaviour.
      if (!this.pitEstablished || this.pitReleaseHoldMs <= 0) {
        this.releasePitOccupancy();
        return;
      }
      // Established occupancy: a handful of ambiguous fixes is not evidence
      // that the car rejoined the track, so make the absence last too.
      if (this.pitClearStartTMono === null || !Number.isFinite(tMono)) {
        this.pitClearStartTMono = Number.isFinite(tMono) ? tMono : null;
        this.pitClearSamples = 1;
      } else {
        this.pitClearSamples += 1;
      }
      const clearStart = this.pitClearStartTMono;
      // Out-of-order fixes clamp to zero rather than counting backwards: the
      // conservative direction here is staying suppressed.
      const clearMs = clearStart === null ? 0 : Math.max(0, tMono - clearStart);
      if (
        this.pitClearSamples >= this.pitReleaseMinSamples &&
        Number.isFinite(clearMs) &&
        clearMs >= this.pitReleaseHoldMs
      ) {
        this.releasePitOccupancy();
      }
      return;
    }

    this.pitClearStartTMono = null;
    this.pitClearSamples = 0;
    if (this.pitEvidenceStartTMono === null || !Number.isFinite(tMono)) {
      this.pitEvidenceStartTMono = Number.isFinite(tMono) ? tMono : null;
      this.pitEvidenceSamples = 1;
    } else {
      this.pitEvidenceSamples += 1;
    }

    // Speed is a shortcut, never a requirement: iOS reports -1 when it has no
    // valid speed solution, and Android may omit the channel entirely. It can
    // only ENGAGE, and only provisionally -- it never establishes occupancy
    // and never releases it, so correctness still never depends on it.
    const speedMps = currSample.speedMps;
    const speedIsValid = typeof speedMps === 'number' && Number.isFinite(speedMps) && speedMps >= 0;
    if (this.pitLimiterSpeedMps > 0 && speedIsValid && speedMps <= this.pitLimiterSpeedMps) {
      this.pitEngaged = true;
    }

    const start = this.pitEvidenceStartTMono;
    const elapsedMs = start === null ? 0 : tMono - start;
    if (
      this.pitSuppressionHoldMs > 0 &&
      this.pitEntryPendingProgressM !== null &&
      this.pitEvidenceSamples >= this.pitSuppressionMinSamples &&
      Number.isFinite(elapsedMs) &&
      elapsedMs >= this.pitSuppressionHoldMs
    ) {
      this.pitEngaged = true;
      this.pitEstablished = true;
    } else if (
      this.pitEvidenceSamples >= this.pitSuppressionMinSamples &&
      Number.isFinite(elapsedMs) &&
      elapsedMs >= this.pitSuppressionHoldMs
    ) {
      // Sustained, but not authorised to LATCH: either no forward `pitEntry`
      // crossing stands behind it, or the hold is configured to zero (the
      // pre-P9 single-sample rule restored). Suppression for this step is
      // exactly what P9 did; only release stays immediate.
      this.pitEngaged = true;
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
     * Ticket P9. Either endpoint of the step being inside a SUSTAINED pit-lane
     * transit suppresses timing gates. `pitEngaged`/`pitEngagedBefore` both
     * imply `onPitLane` at their own fix, so this condition is strictly
     * narrower than the `prev.onPitLane || curr.onPitLane` it replaces.
     */
    const pitSuppressed = this.pitEngagedBefore || this.pitEngaged;

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

      if (pitSuppressed && isTimingGate(projected.gate)) {
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
      });
    }
    if (pitExitCrossed) this.releasePitOccupancy();
    return events;
  }
}
