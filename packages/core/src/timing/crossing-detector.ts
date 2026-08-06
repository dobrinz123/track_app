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
}

const DEFAULT_MIN_REARM_DISTANCE_M = 50;
const DEFAULT_MAX_STEP_M = 120;
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
  private readonly lastForwardProgressByGate = new Map<string, number>();

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
  }

  reset(): void {
    this.lastForwardProgressByGate.clear();
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
    if (Math.hypot(to.e - from.e, to.n - from.n) > this.maxStepM) return [];

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
