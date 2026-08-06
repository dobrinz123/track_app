import type {
  LocalPoint,
  LocationSample,
  QualityAssessment,
  TrackMatch,
  TrackMatcher as TrackMatcherContract,
} from '../contracts';
import { polylineLength, projectOntoPolyline, unwrapProgress } from '../geometry';
import type { PolylineProjection } from '../geometry';
import type { RuntimeProfile } from '../profile';

import { TelemetryQualityEvaluator, type TelemetryQualityConfig } from './quality-evaluator';

export interface TrackMatcherConfig {
  corridorWidthM: number;
  pitCorridorWidthM: number;
  windowM: number;
  confidenceThreshold: number;
  offCorridorLimit: number;
  confidenceEmaAlpha: number;
  progressRegressionM: number;
  reverseEvidenceM: number;
  auditIntervalSamples?: number;
  quality: Partial<TelemetryQualityConfig>;
}

const DEFAULT_CONFIG: Readonly<TrackMatcherConfig> = {
  corridorWidthM: 20,
  pitCorridorWidthM: 20,
  windowM: 150,
  confidenceThreshold: 0.45,
  offCorridorLimit: 5,
  confidenceEmaAlpha: 0.25,
  progressRegressionM: 30,
  reverseEvidenceM: 3,
  auditIntervalSamples: 25,
  quality: {},
};

interface ValidatedSegment {
  a: LocalPoint;
  vx: number;
  vy: number;
  lengthSquared: number;
  length: number;
  startM: number;
  endM: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function circularDistance(a: number, b: number, total: number): number {
  const direct = Math.abs(a - b);
  return Math.min(direct, total - direct);
}

function segmentIsInHintWindow(
  startM: number,
  endM: number,
  hintDistanceM: number,
  windowM: number,
  totalM: number,
): boolean {
  const tolerance = Number.EPSILON * 64 * Math.max(1, totalM);
  if (windowM * 2 >= totalM) return true;

  const normalizedHint = modulo(hintDistanceM, totalM);
  if (normalizedHint + tolerance >= startM && normalizedHint - tolerance <= endM) return true;
  const normalizedEnd = endM === totalM ? 0 : endM;
  return (
    circularDistance(normalizedHint, startM, totalM) <= windowM + tolerance ||
    circularDistance(normalizedHint, normalizedEnd, totalM) <= windowM + tolerance
  );
}

function hintedSegmentIndices(
  cumulative: number[],
  totalM: number,
  hintDistanceM: number,
  windowM: number,
): number[] {
  const segmentCount = cumulative.length;
  if (windowM * 2 >= totalM) {
    return Array.from({ length: segmentCount }, (_, index) => index);
  }

  const hint = modulo(hintDistanceM, totalM);
  let low = 0;
  let high = segmentCount;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((cumulative[middle] ?? 0) <= hint) low = middle + 1;
    else high = middle;
  }
  const containingIndex = Math.max(0, low - 1);
  let firstIndex = containingIndex;
  let lastIndex = containingIndex;
  const tolerance = Number.EPSILON * 64 * Math.max(1, totalM);

  for (
    let index = (containingIndex + 1) % segmentCount;
    index !== containingIndex;
    index = (index + 1) % segmentCount
  ) {
    const forwardDistanceM = modulo((cumulative[index] ?? 0) - hint, totalM);
    if (forwardDistanceM > windowM + tolerance) break;
    lastIndex = index;
  }
  for (
    let index = modulo(containingIndex - 1, segmentCount);
    index !== containingIndex;
    index = modulo(index - 1, segmentCount)
  ) {
    const rawEndM = index === segmentCount - 1 ? totalM : (cumulative[index + 1] ?? totalM);
    const endM = rawEndM === totalM ? 0 : rawEndM;
    const backwardDistanceM = modulo(hint - endM, totalM);
    if (backwardDistanceM > windowM + tolerance) break;
    firstIndex = index;
  }

  const indices: number[] = [];
  if (firstIndex <= lastIndex) {
    for (let index = firstIndex; index <= lastIndex; index += 1) indices.push(index);
  } else {
    for (let index = 0; index <= lastIndex; index += 1) indices.push(index);
    for (let index = firstIndex; index < segmentCount; index += 1) indices.push(index);
  }
  return indices;
}

function validatedSegments(
  line: LocalPoint[],
  cumulative: number[],
): Array<ValidatedSegment | undefined> {
  return line.map((a, index) => {
    const b = line[(index + 1) % line.length];
    if (b === undefined) throw new RangeError('line must not be sparse');
    const vx = b.e - a.e;
    const vy = b.n - a.n;
    const lengthSquared = vx * vx + vy * vy;
    if (!Number.isFinite(lengthSquared)) throw new RangeError('segment length must be finite');
    if (lengthSquared === 0) return undefined;
    const length = Math.sqrt(lengthSquared);
    const startM = cumulative[index] ?? 0;
    return { a, vx, vy, lengthSquared, length, startM, endM: startM + length };
  });
}

/**
 * RuntimeProfile geometry has already passed the profile validator, so the
 * matcher can apply the same hinted projection math without revalidating and
 * rescanning the complete profile on every valid local update.
 */
function projectOntoValidatedHintWindow(
  point: LocalPoint,
  line: LocalPoint[],
  cumulative: number[],
  segments: Array<ValidatedSegment | undefined>,
  totalLengthM: number,
  hintDistanceM: number,
  windowM: number,
): PolylineProjection {
  if (!Number.isFinite(hintDistanceM) || !Number.isFinite(windowM) || windowM < 0) {
    return projectOntoPolyline(point, line, cumulative, true, {
      distanceM: hintDistanceM,
      windowM,
    });
  }

  let best: PolylineProjection | undefined;
  let bestSquaredDistance = Number.POSITIVE_INFINITY;
  const candidateIndices = hintedSegmentIndices(cumulative, totalLengthM, hintDistanceM, windowM);
  for (const index of candidateIndices) {
    const segment = segments[index];
    if (segment === undefined) continue;
    const { a, vx, vy, lengthSquared, length, startM, endM } = segment;
    if (!segmentIsInHintWindow(startM, endM, hintDistanceM, windowM, totalLengthM)) {
      continue;
    }

    const unclampedT = ((point.e - a.e) * vx + (point.n - a.n) * vy) / lengthSquared;
    const t = Math.max(0, Math.min(1, unclampedT));
    const projected = { e: a.e + t * vx, n: a.n + t * vy };
    const deltaE = point.e - projected.e;
    const deltaN = point.n - projected.n;
    const squaredDistance = deltaE * deltaE + deltaN * deltaN;
    if (!Number.isFinite(squaredDistance))
      throw new RangeError('projection distance must be finite');

    if (squaredDistance < bestSquaredDistance) {
      const cross = vx * (point.n - a.n) - vy * (point.e - a.e);
      const lateralM = cross / length;
      const rawDistanceM = startM + t * length;
      bestSquaredDistance = squaredDistance;
      best = {
        distanceM: rawDistanceM >= totalLengthM ? 0 : rawDistanceM,
        lateralM,
        segmentIndex: index,
        point: projected,
      };
    }
  }

  if (best === undefined) throw new RangeError('hint window contains no non-zero-length segment');
  return best;
}

export class TrackMatcher implements TrackMatcherContract {
  private readonly totalLengthM: number;
  private readonly startOffsetM: number;
  private readonly centerlineSegments: Array<ValidatedSegment | undefined>;
  private readonly auditIntervalSamples: number;
  private readonly config: TrackMatcherConfig;
  private readonly evaluator: TelemetryQualityEvaluator;
  private previousSample: LocationSample | undefined;
  private previousPoint: LocalPoint | undefined;
  private lastMatch: TrackMatch | undefined;
  private lost = false;
  private offCorridorCount = 0;
  private samplesSinceAudit = 0;
  private hintDisagreementM = 0;

  constructor(
    private readonly profile: RuntimeProfile,
    config: Partial<TrackMatcherConfig> = {},
  ) {
    this.totalLengthM = polylineLength(profile.centerline);
    this.startOffsetM = profile.startFinishGate.distanceM;
    this.centerlineSegments = validatedSegments(profile.centerline, profile.cumulativeDistancesM);
    this.auditIntervalSamples = config.auditIntervalSamples ?? 25;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      auditIntervalSamples: this.auditIntervalSamples,
      quality: { ...DEFAULT_CONFIG.quality, ...config.quality },
    };
    if (!Number.isInteger(this.auditIntervalSamples) || this.auditIntervalSamples < 1) {
      throw new RangeError('auditIntervalSamples must be a positive integer');
    }
    this.evaluator = new TelemetryQualityEvaluator(this.config.quality);
  }

  reset(): void {
    this.previousSample = undefined;
    this.previousPoint = undefined;
    this.lastMatch = undefined;
    this.lost = false;
    this.offCorridorCount = 0;
    this.samplesSinceAudit = 0;
    this.hintDisagreementM = 0;
  }

  match(sample: LocationSample): TrackMatch | null {
    const quality = this.evaluator.assess(sample, this.previousSample);
    if (quality.level === 'invalid') return null;

    const point = this.profile.projection.toLocal({ lat: sample.lat, lon: sample.lon });
    const shouldHint = !this.lost && this.lastMatch !== undefined;
    const shouldAudit = shouldHint && this.samplesSinceAudit + 1 >= this.auditIntervalSamples;
    let projection: PolylineProjection;

    if (shouldHint && this.lastMatch !== undefined) {
      const rawHintDistance = modulo(
        this.lastMatch.distanceM + this.startOffsetM,
        this.totalLengthM,
      );
      projection = projectOntoValidatedHintWindow(
        point,
        this.profile.centerline,
        this.profile.cumulativeDistancesM,
        this.centerlineSegments,
        this.totalLengthM,
        rawHintDistance,
        this.config.windowM,
      );
      if (shouldAudit) {
        const full = projectOntoPolyline(
          point,
          this.profile.centerline,
          this.profile.cumulativeDistancesM,
          true,
        );
        this.hintDisagreementM = circularDistance(
          projection.distanceM,
          full.distanceM,
          this.totalLengthM,
        );
        this.samplesSinceAudit = 0;
      } else {
        this.samplesSinceAudit += 1;
      }
    } else {
      projection = projectOntoPolyline(
        point,
        this.profile.centerline,
        this.profile.cumulativeDistancesM,
        true,
      );
      this.hintDisagreementM = 0;
      this.samplesSinceAudit = 0;
    }

    const distanceM = modulo(projection.distanceM - this.startOffsetM, this.totalLengthM);
    const previousUnwrapped = this.lastMatch?.unwrappedProgressM;
    const unwrappedProgressM =
      previousUnwrapped === undefined
        ? distanceM
        : unwrapProgress(previousUnwrapped, distanceM, this.totalLengthM);
    const offCorridor = Math.abs(projection.lateralM) > this.config.corridorWidthM;
    if (offCorridor) {
      this.offCorridorCount += 1;
      if (this.offCorridorCount >= this.config.offCorridorLimit) this.lost = true;
    } else {
      this.offCorridorCount = 0;
      this.lost = false;
    }

    const matchQuality: QualityAssessment = {
      level: quality.level,
      reasons: [...quality.reasons],
    };
    let regressionPenalty = 1;
    if (
      previousUnwrapped !== undefined &&
      previousUnwrapped - unwrappedProgressM > this.config.progressRegressionM &&
      !this.hasReverseEvidence(point, projection)
    ) {
      matchQuality.reasons.push('PROGRESS_REGRESSION');
      regressionPenalty = 0.4;
    }

    const lateralScore = clamp01(1 - Math.abs(projection.lateralM) / this.config.corridorWidthM);
    const accuracyScore =
      sample.accuracyM === undefined
        ? 1
        : clamp01(1 - sample.accuracyM / Math.max(1, this.config.corridorWidthM * 2.5));
    const disagreementScore = clamp01(
      1 - this.hintDisagreementM / Math.max(1, this.config.windowM),
    );
    const qualityScore =
      quality.level === 'unreliable' ? 0.45 : quality.level === 'degraded' ? 0.75 : 1;
    const targetConfidence =
      lateralScore *
      accuracyScore *
      Math.max(0.15, disagreementScore) *
      qualityScore *
      regressionPenalty;
    const confidence =
      this.lastMatch === undefined
        ? targetConfidence
        : clamp01(
            this.lastMatch.confidence +
              this.config.confidenceEmaAlpha * (targetConfidence - this.lastMatch.confidence),
          );

    const result: TrackMatch = {
      tMono: sample.tMono,
      distanceM,
      progress: distanceM / this.totalLengthM,
      unwrappedProgressM,
      lateralM: projection.lateralM,
      confidence: clamp01(confidence),
      sectorIndex: this.sectorIndex(distanceM),
      quality: matchQuality,
      onPitLane: this.isOnPitLane(point, Math.abs(projection.lateralM)),
    };

    this.previousSample = sample;
    this.previousPoint = point;
    this.lastMatch = result;
    return result;
  }

  private hasReverseEvidence(point: LocalPoint, projection: PolylineProjection): boolean {
    if (this.previousPoint === undefined) return false;
    const a = this.profile.centerline[projection.segmentIndex];
    const b =
      this.profile.centerline[(projection.segmentIndex + 1) % this.profile.centerline.length];
    if (a === undefined || b === undefined) return false;
    const tangentLength = Math.hypot(b.e - a.e, b.n - a.n);
    if (tangentLength === 0) return false;
    const displacementE = point.e - this.previousPoint.e;
    const displacementN = point.n - this.previousPoint.n;
    const forwardMovement =
      (displacementE * (b.e - a.e) + displacementN * (b.n - a.n)) / tangentLength;
    return forwardMovement < -this.config.reverseEvidenceM;
  }

  private isOnPitLane(point: LocalPoint, centerlineDistanceM: number): boolean {
    const pitLane = this.profile.pitLane;
    if (pitLane === undefined) return false;
    const pitProjection = projectOntoPolyline(
      point,
      pitLane.polyline,
      pitLane.cumulativeDistancesM,
      false,
    );
    const pitDistanceM = Math.hypot(
      point.e - pitProjection.point.e,
      point.n - pitProjection.point.n,
    );
    return pitDistanceM < centerlineDistanceM && pitDistanceM <= this.config.pitCorridorWidthM;
  }

  private sectorIndex(distanceM: number): number {
    let sectorIndex = 0;
    let latestBoundaryM = -1;
    for (const projectedGate of this.profile.sectorGates) {
      const boundaryM = modulo(projectedGate.distanceM - this.startOffsetM, this.totalLengthM);
      if (distanceM >= boundaryM && boundaryM > latestBoundaryM) {
        latestBoundaryM = boundaryM;
        sectorIndex = projectedGate.gate.sectorIndex ?? sectorIndex;
      }
    }
    return sectorIndex;
  }
}
