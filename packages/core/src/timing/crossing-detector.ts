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
    this.alongTrack = new AlongTrackFilter(config.alongTrackFilter);
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

    const events: CrossingEvent[] = [];
    for (const projected of this.projectedGates) {
      if ((prev.onPitLane || curr.onPitLane) && isTimingGate(projected.gate)) continue;

      const intersection = segmentIntersection(from, to, projected.aLocal, projected.bLocal);
      if (intersection === null) continue;

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
    return events;
  }
}
