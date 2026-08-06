import type {
  CalibrationDiagnostics,
  CalibrationEngine as CalibrationEngineContract,
  CalibrationResult,
  LocalPoint,
  LocationSample,
} from '../contracts';
import { polylineLength, projectOntoPolyline } from '../geometry';
import type { RuntimeProfile } from '../profile';
import {
  TelemetryQualityEvaluator,
  TrackMatcher,
  type TelemetryQualityConfig,
  type TrackMatcherConfig,
} from '../matching';

export interface CalibrationConfig {
  coverageBinM: number;
  corridorWidthM: number;
  direction?: 'clockwise' | 'counterclockwise';
  quality: Partial<TelemetryQualityConfig>;
  matcher: Partial<TrackMatcherConfig>;
}

interface AcceptedPoint {
  point: LocalPoint;
  lateralM: number;
  segmentIndex: number;
}

const DEFAULT_CONFIG: Omit<CalibrationConfig, 'direction'> = {
  coverageBinM: 25,
  corridorWidthM: 20,
  quality: {},
  matcher: {},
};

/** Hard ceiling on `acceptedPoints` (~2.7 h at 1 Hz) -- L1 fix. Calibration is expected to finish within one short Learn lap; a session left calibrating far past that is force-failed rather than growing this array forever. */
const MAX_ACCEPTED_POINTS = 10_000;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function inferredDirection(profile: RuntimeProfile): 'clockwise' | 'counterclockwise' {
  let twiceArea = 0;
  for (let index = 0; index < profile.centerline.length; index += 1) {
    const current = profile.centerline[index];
    const next = profile.centerline[(index + 1) % profile.centerline.length];
    if (current !== undefined && next !== undefined) {
      twiceArea += current.e * next.n - next.e * current.n;
    }
  }
  return twiceArea < 0 ? 'clockwise' : 'counterclockwise';
}

export class CalibrationEngine implements CalibrationEngineContract {
  private readonly config: CalibrationConfig;
  private readonly totalLengthM: number;
  private readonly expectedDirection: 'clockwise' | 'counterclockwise';
  private readonly centerlineDirection: 'clockwise' | 'counterclockwise';
  private evaluator: TelemetryQualityEvaluator;
  private matcher: TrackMatcher;
  private coverage: boolean[];
  private previousQualitySample: LocationSample | undefined;
  private previousAcceptedProgressM: number | undefined;
  private acceptedPoints: AcceptedPoint[] = [];
  private samplesAccepted = 0;
  private samplesRejected = 0;
  private rejectionReasons: Record<string, number> = {};
  private positiveDirectionM = 0;
  private negativeDirectionM = 0;
  private firstTimestamp: number | undefined;
  private lastTimestamp: number | undefined;
  private timestampCount = 0;
  private lastOnTrack = false;
  private lastQualityOk = false;
  /** Set once `acceptedPoints` hits `MAX_ACCEPTED_POINTS` -- L1 fix. Sticky for the life of this engine instance (cleared only by `reset()`), so `finish()` always force-fails with `CALIBRATION_OVERRUN` after an overrun, however long calibration continues to run past it. */
  private calibrationOverrun = false;

  constructor(
    private readonly profile: RuntimeProfile,
    config: Partial<CalibrationConfig> = {},
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      quality: { ...DEFAULT_CONFIG.quality, ...config.quality },
      matcher: { ...DEFAULT_CONFIG.matcher, ...config.matcher },
    };
    this.totalLengthM = polylineLength(profile.centerline);
    this.centerlineDirection = inferredDirection(profile);
    this.expectedDirection = config.direction ?? this.centerlineDirection;
    this.evaluator = new TelemetryQualityEvaluator(this.config.quality);
    this.matcher = this.createMatcher();
    this.coverage = this.emptyCoverage();
  }

  reset(): void {
    this.evaluator = new TelemetryQualityEvaluator(this.config.quality);
    this.matcher = this.createMatcher();
    this.coverage = this.emptyCoverage();
    this.previousQualitySample = undefined;
    this.previousAcceptedProgressM = undefined;
    this.acceptedPoints = [];
    this.samplesAccepted = 0;
    this.samplesRejected = 0;
    this.rejectionReasons = {};
    this.positiveDirectionM = 0;
    this.negativeDirectionM = 0;
    this.firstTimestamp = undefined;
    this.lastTimestamp = undefined;
    this.timestampCount = 0;
    this.lastOnTrack = false;
    this.lastQualityOk = false;
    this.calibrationOverrun = false;
  }

  feed(sample: LocationSample): void {
    this.observeTimestamp(sample.tMono);
    const assessment = this.evaluator.assess(sample, this.previousQualitySample);
    const match = this.matcher.match(sample);
    const qualityOk = assessment.level === 'good' || assessment.level === 'degraded';
    const onTrack = match !== null && Math.abs(match.lateralM) <= this.config.corridorWidthM;
    this.lastQualityOk = qualityOk;
    this.lastOnTrack = onTrack;

    if (!qualityOk || !onTrack || match === null) {
      this.samplesRejected += 1;
      const reasons = [...assessment.reasons];
      if (!onTrack && match !== null) reasons.push('OFF_CORRIDOR');
      if (reasons.length === 0) reasons.push(match === null ? 'INVALID_SAMPLE' : 'LOW_QUALITY');
      for (const reason of new Set(reasons)) {
        this.rejectionReasons[reason] = (this.rejectionReasons[reason] ?? 0) + 1;
      }
      if (assessment.level !== 'invalid') this.previousQualitySample = sample;
      return;
    }

    this.samplesAccepted += 1;
    this.markCoverage(match.distanceM);
    if (this.previousAcceptedProgressM !== undefined) {
      const deltaM = match.unwrappedProgressM - this.previousAcceptedProgressM;
      if (Math.abs(deltaM) <= this.totalLengthM / 2) {
        if (deltaM > 0.5) this.positiveDirectionM += deltaM;
        if (deltaM < -0.5) this.negativeDirectionM += -deltaM;
        this.markCoverageBetween(this.previousAcceptedProgressM, match.unwrappedProgressM);
      }
    }
    this.previousAcceptedProgressM = match.unwrappedProgressM;

    if (this.acceptedPoints.length < MAX_ACCEPTED_POINTS) {
      const point = this.profile.projection.toLocal({ lat: sample.lat, lon: sample.lon });
      const projected = projectOntoPolyline(
        point,
        this.profile.centerline,
        this.profile.cumulativeDistancesM,
        true,
      );
      this.acceptedPoints.push({
        point,
        lateralM: projected.lateralM,
        segmentIndex: projected.segmentIndex,
      });
    } else {
      this.calibrationOverrun = true;
    }
    this.previousQualitySample = sample;
  }

  progress(): { coverageFraction: number; onTrack: boolean; qualityOk: boolean } {
    return {
      coverageFraction: this.coverageFraction(),
      onTrack: this.lastOnTrack,
      qualityOk: this.lastQualityOk,
    };
  }

  finish(): CalibrationResult {
    const coverageFraction = this.coverageFraction();
    const totalSamples = this.samplesAccepted + this.samplesRejected;
    const rejectedFraction = totalSamples === 0 ? 1 : this.samplesRejected / totalSamples;
    const observedRateHz = this.observedRateHz();
    const directionDetected = this.directionDetected();
    const bias = this.estimateBias();
    const lateralValues = this.lateralValuesAfterBias(bias);
    const meanLateralM = mean(lateralValues);
    const p95LateralM = percentile95(lateralValues);
    const diagnostics: CalibrationDiagnostics = {
      coverageFraction,
      samplesAccepted: this.samplesAccepted,
      samplesRejected: this.samplesRejected,
      rejectionReasons: { ...this.rejectionReasons },
      meanLateralM,
      p95LateralM,
      estimatedBias: { ...bias },
      directionDetected,
      observedRateHz,
    };

    const failureReasons: string[] = [];
    if (coverageFraction < 0.95) failureReasons.push('INSUFFICIENT_COVERAGE');
    if (directionDetected !== this.expectedDirection) failureReasons.push('WRONG_DIRECTION');
    if (rejectedFraction > 0.3) failureReasons.push('POOR_GNSS');
    if (observedRateHz < 0.5) failureReasons.push('RATE_TOO_LOW');
    if (this.longestUncoveredRunM() > 100) failureReasons.push('COVERAGE_GAP');
    if (this.calibrationOverrun) failureReasons.push('CALIBRATION_OVERRUN');

    const qualityRatio = totalSamples === 0 ? 0 : this.samplesAccepted / totalSamples;
    const lateralTightness = clamp01(1 - p95LateralM / this.config.corridorWidthM);
    const confidence = clamp01(
      coverageFraction * 0.45 + qualityRatio * 0.3 + lateralTightness * 0.25,
    );
    return {
      accepted: failureReasons.length === 0,
      confidence,
      failureReasons,
      appliedBias: { ...bias },
      diagnostics,
    };
  }

  private createMatcher(): TrackMatcher {
    return new TrackMatcher(this.profile, {
      ...this.config.matcher,
      corridorWidthM: this.config.corridorWidthM,
      quality: this.config.quality,
    });
  }

  private emptyCoverage(): boolean[] {
    return new Array<boolean>(Math.max(1, Math.ceil(this.totalLengthM / this.config.coverageBinM))).fill(
      false,
    );
  }

  private markCoverage(distanceM: number): void {
    const normalized = ((distanceM % this.totalLengthM) + this.totalLengthM) % this.totalLengthM;
    const bin = Math.min(this.coverage.length - 1, Math.floor(normalized / this.config.coverageBinM));
    this.coverage[bin] = true;
  }

  private markCoverageBetween(fromM: number, toM: number): void {
    const deltaM = toM - fromM;
    const maximumContinuousStepM = Math.max(100, this.config.coverageBinM * 4);
    if (Math.abs(deltaM) > maximumContinuousStepM) return;
    const steps = Math.max(1, Math.ceil(Math.abs(deltaM) / (this.config.coverageBinM / 2)));
    for (let step = 0; step <= steps; step += 1) {
      this.markCoverage(fromM + (deltaM * step) / steps);
    }
  }

  private coverageFraction(): number {
    const covered = this.coverage.reduce((sum, value) => sum + (value ? 1 : 0), 0);
    return covered / this.coverage.length;
  }

  private longestUncoveredRunM(): number {
    if (this.coverage.every(Boolean)) return 0;
    if (this.coverage.every((value) => !value)) return this.totalLengthM;
    const doubled = [...this.coverage, ...this.coverage];
    let longest = 0;
    let current = 0;
    for (const covered of doubled) {
      current = covered ? 0 : current + 1;
      longest = Math.max(longest, Math.min(current, this.coverage.length));
    }
    return Math.min(this.totalLengthM, longest * this.config.coverageBinM);
  }

  private directionDetected(): 'clockwise' | 'counterclockwise' | 'unknown' {
    const totalVotesM = this.positiveDirectionM + this.negativeDirectionM;
    if (totalVotesM < this.config.coverageBinM) return 'unknown';
    if (this.positiveDirectionM / totalVotesM >= 0.6) return this.centerlineDirection;
    if (this.negativeDirectionM / totalVotesM >= 0.6) {
      return this.centerlineDirection === 'clockwise' ? 'counterclockwise' : 'clockwise';
    }
    return 'unknown';
  }

  private observeTimestamp(tMono: number): void {
    if (!Number.isFinite(tMono)) return;
    if (this.firstTimestamp === undefined) this.firstTimestamp = tMono;
    this.lastTimestamp = tMono;
    this.timestampCount += 1;
  }

  private observedRateHz(): number {
    if (
      this.timestampCount < 2 ||
      this.firstTimestamp === undefined ||
      this.lastTimestamp === undefined ||
      this.lastTimestamp <= this.firstTimestamp
    ) {
      return 0;
    }
    return (this.timestampCount - 1) / ((this.lastTimestamp - this.firstTimestamp) / 1_000);
  }

  private estimateBias(): LocalPoint {
    if (this.acceptedPoints.length < 10) return { e: 0, n: 0 };
    const observations: Array<{ normalE: number; normalN: number; lateralM: number }> = [];
    for (const accepted of this.acceptedPoints) {
      const a = this.profile.centerline[accepted.segmentIndex];
      const b = this.profile.centerline[(accepted.segmentIndex + 1) % this.profile.centerline.length];
      if (a === undefined || b === undefined) continue;
      const length = Math.hypot(b.e - a.e, b.n - a.n);
      if (length === 0) continue;
      observations.push({
        normalE: -(b.n - a.n) / length,
        normalN: (b.e - a.e) / length,
        lateralM: accepted.lateralM,
      });
    }
    const initial = this.solveBias(observations);
    const ordered = [...observations].sort((a, b) => {
      const residualA = a.lateralM - a.normalE * initial.e - a.normalN * initial.n;
      const residualB = b.lateralM - b.normalE * initial.e - b.normalN * initial.n;
      return residualA - residualB;
    });
    const trimEachSide = Math.floor(ordered.length * 0.1);
    const candidate = this.solveBias(ordered.slice(trimEachSide, ordered.length - trimEachSide));
    const magnitude = Math.hypot(candidate.e, candidate.n);
    if (magnitude < 1.5 || magnitude > 8) return { e: 0, n: 0 };

    const before = percentile95(this.acceptedPoints.map((point) => Math.abs(point.lateralM)));
    const after = percentile95(this.lateralValuesAfterBias(candidate));
    return before > 0 && after <= before * 0.8 ? candidate : { e: 0, n: 0 };
  }

  private solveBias(
    observations: Array<{ normalE: number; normalN: number; lateralM: number }>,
  ): LocalPoint {
    let a00 = 0;
    let a01 = 0;
    let a11 = 0;
    let y0 = 0;
    let y1 = 0;
    for (const observation of observations) {
      a00 += observation.normalE * observation.normalE;
      a01 += observation.normalE * observation.normalN;
      a11 += observation.normalN * observation.normalN;
      y0 += observation.normalE * observation.lateralM;
      y1 += observation.normalN * observation.lateralM;
    }
    const determinant = a00 * a11 - a01 * a01;
    if (Math.abs(determinant) < 1e-9) return { e: 0, n: 0 };
    return {
      e: (y0 * a11 - y1 * a01) / determinant,
      n: (a00 * y1 - a01 * y0) / determinant,
    };
  }

  private lateralValuesAfterBias(bias: LocalPoint): number[] {
    return this.acceptedPoints.map(({ point }) => {
      const corrected = { e: point.e - bias.e, n: point.n - bias.n };
      return Math.abs(
        projectOntoPolyline(
          corrected,
          this.profile.centerline,
          this.profile.cumulativeDistancesM,
          true,
        ).lateralM,
      );
    });
  }
}
