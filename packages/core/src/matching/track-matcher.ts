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

import {
  TelemetryQualityEvaluator,
  type TelemetryQualityConfig,
} from './quality-evaluator';

export interface TrackMatcherConfig {
  corridorWidthM: number;
  pitCorridorWidthM: number;
  windowM: number;
  confidenceThreshold: number;
  offCorridorLimit: number;
  confidenceEmaAlpha: number;
  progressRegressionM: number;
  reverseEvidenceM: number;
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
  quality: {},
};

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

export class TrackMatcher implements TrackMatcherContract {
  private readonly totalLengthM: number;
  private readonly startOffsetM: number;
  private readonly config: TrackMatcherConfig;
  private readonly evaluator: TelemetryQualityEvaluator;
  private previousSample: LocationSample | undefined;
  private previousPoint: LocalPoint | undefined;
  private lastMatch: TrackMatch | undefined;
  private lost = false;
  private offCorridorCount = 0;

  constructor(
    private readonly profile: RuntimeProfile,
    config: Partial<TrackMatcherConfig> = {},
  ) {
    this.totalLengthM = polylineLength(profile.centerline);
    this.startOffsetM = profile.startFinishGate.distanceM;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      quality: { ...DEFAULT_CONFIG.quality, ...config.quality },
    };
    this.evaluator = new TelemetryQualityEvaluator(this.config.quality);
  }

  reset(): void {
    this.previousSample = undefined;
    this.previousPoint = undefined;
    this.lastMatch = undefined;
    this.lost = false;
    this.offCorridorCount = 0;
  }

  match(sample: LocationSample): TrackMatch | null {
    const quality = this.evaluator.assess(sample, this.previousSample);
    if (quality.level === 'invalid') return null;

    const point = this.profile.projection.toLocal({ lat: sample.lat, lon: sample.lon });
    const shouldHint =
      !this.lost &&
      this.lastMatch !== undefined &&
      this.lastMatch.confidence > this.config.confidenceThreshold;
    const full = projectOntoPolyline(
      point,
      this.profile.centerline,
      this.profile.cumulativeDistancesM,
      true,
    );
    let projection = full;
    let hintDisagreementM = 0;

    if (shouldHint && this.lastMatch !== undefined) {
      const rawHintDistance = modulo(this.lastMatch.distanceM + this.startOffsetM, this.totalLengthM);
      projection = projectOntoPolyline(
        point,
        this.profile.centerline,
        this.profile.cumulativeDistancesM,
        true,
        { distanceM: rawHintDistance, windowM: this.config.windowM },
      );
      hintDisagreementM = circularDistance(
        projection.distanceM,
        full.distanceM,
        this.totalLengthM,
      );
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
    const disagreementScore = clamp01(1 - hintDisagreementM / Math.max(1, this.config.windowM));
    const qualityScore = quality.level === 'unreliable' ? 0.45 : quality.level === 'degraded' ? 0.75 : 1;
    const targetConfidence =
      lateralScore * accuracyScore * Math.max(0.15, disagreementScore) * qualityScore * regressionPenalty;
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
    const b = this.profile.centerline[(projection.segmentIndex + 1) % this.profile.centerline.length];
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
    const pitDistanceM = Math.hypot(point.e - pitProjection.point.e, point.n - pitProjection.point.n);
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
