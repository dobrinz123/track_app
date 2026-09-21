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
  }

  /** Ticket P7M M4: how many steps were discarded as implausible, and the widest of them (metres). */
  stepDiagnostics(): { skippedSteps: number; widestSkippedStepM: number } {
    return { skippedSteps: this.skippedSteps, widestSkippedStepM: this.widestSkippedStepM };
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
  }

  update(
    prev: TrackMatch | null,
    curr: TrackMatch,
    prevSample: LocationSample | null,
    currSample: LocationSample,
  ): CrossingEvent[] {
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
        tCross: interpolateCrossingTime(prevSample.tMono, currSample.tMono, intersection.t),
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
