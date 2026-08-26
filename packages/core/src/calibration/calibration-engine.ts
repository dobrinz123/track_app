import type {
  CalibrationDiagnostics,
  CalibrationEngine as CalibrationEngineContract,
  CalibrationResult,
  LocalPoint,
  LocationSample,
  TrackMatch,
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

/**
 * A quality-ok, matched sample retained purely because it fell within the wide Learn
 * corridor (D1 field-calibration fix) -- independent of tight-corridor acceptance.
 * `distanceM`/`lateralM`/`unwrappedProgressM` are the matcher's own values (same ones
 * that gate tight on-track acceptance); `localPoint` is kept so `finish()` can subtract
 * an estimated bias and re-project onto the centerline from scratch.
 */
interface WideSample {
  distanceM: number;
  lateralM: number;
  unwrappedProgressM: number;
  localPoint: LocalPoint;
}

const DEFAULT_CONFIG: Omit<CalibrationConfig, 'direction'> = {
  coverageBinM: 25,
  corridorWidthM: 20,
  quality: {},
  matcher: {},
};

/** Hard ceiling on `acceptedPoints` (~2.7 h at 1 Hz) -- L1 fix. Calibration is expected to finish within one short Learn lap; a session left calibrating far past that is force-failed rather than growing this array forever. */
const MAX_ACCEPTED_POINTS = 10_000;

/**
 * D1 field-calibration fix: an unvalidated OSM centerline can be laterally offset from
 * the real racing line by more than `corridorWidthM` for a contiguous stretch, which
 * makes strict on-track coverage impossible to reach even when the driver never left
 * the circuit (root cause of the 81-90%-coverage field failure). Every quality-ok,
 * matched sample within this wider corridor is retained in `wideSamples` so `finish()`
 * can estimate a systematic bias and recover coverage against the bias-corrected
 * positions. Tight-corridor semantics (`corridorWidthM`) are unchanged everywhere else.
 */
const LEARN_WIDE_CORRIDOR_M = 40;

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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
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
  private wideSamples: WideSample[] = [];
  private samplesAccepted = 0;
  private samplesRejected = 0;
  private rejectionReasons: Record<string, number> = {};
  private positiveDirectionM = 0;
  private negativeDirectionM = 0;
  private firstTimestamp: number | undefined;
  private lastTimestamp: number | undefined;
  private timestampCount = 0;
  /**
   * V6 live-indicator fix: whether the LAST fed sample is within the wide Learn
   * corridor (`LEARN_WIDE_CORRIDOR_M`), used only for the live on-track indicator
   * surfaced by `progress()`. A driver within 40 m of an unvalidated centerline reads
   * as on-track on screen during calibration even though that sample may still miss
   * tight-corridor acceptance (`acceptedPoints`, lateral stats, `finish()`) below.
   */
  private lastLiveOnTrack = false;
  private lastQualityOk = false;
  /** Set once `acceptedPoints` hits `MAX_ACCEPTED_POINTS` -- L1 fix. Sticky for the life of this engine instance (cleared only by `reset()`), so `finish()` always force-fails with `CALIBRATION_OVERRUN` after an overrun, however long calibration continues to run past it. */
  private calibrationOverrun = false;
  /**
   * V2 track-map plumbing: the LAST fed sample's raw (unmatched) local-frame position
   * and its matched (projected-onto-centerline) local-frame position, plus that match's
   * own `lateralM`/`distanceM` -- exposed additively through `progress()` for the live
   * track-map view. Sticky: only updated when `match !== null` (an invalid-quality
   * sample leaves the last known position in place rather than going blank). `undefined`
   * until the first sample with a valid match has been fed.
   */
  private lastRawLocalPoint: LocalPoint | undefined;
  private lastMatchedLocalPoint: LocalPoint | undefined;
  private lastMatchLateralM: number | undefined;
  private lastMatchDistanceM: number | undefined;

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
    this.wideSamples = [];
    this.samplesAccepted = 0;
    this.samplesRejected = 0;
    this.rejectionReasons = {};
    this.positiveDirectionM = 0;
    this.negativeDirectionM = 0;
    this.firstTimestamp = undefined;
    this.lastTimestamp = undefined;
    this.timestampCount = 0;
    this.lastLiveOnTrack = false;
    this.lastQualityOk = false;
    this.calibrationOverrun = false;
    this.lastRawLocalPoint = undefined;
    this.lastMatchedLocalPoint = undefined;
    this.lastMatchLateralM = undefined;
    this.lastMatchDistanceM = undefined;
  }

  feed(sample: LocationSample): void {
    this.observeTimestamp(sample.tMono);
    const assessment = this.evaluator.assess(sample, this.previousQualitySample);
    const match = this.matcher.match(sample);
    const qualityOk = assessment.level === 'good' || assessment.level === 'degraded';
    const onTrack = match !== null && Math.abs(match.lateralM) <= this.config.corridorWidthM;
    // V6 live-indicator fix: the live on-track indicator uses the WIDE Learn corridor,
    // not the tight one -- a driver within LEARN_WIDE_CORRIDOR_M of an unvalidated
    // centerline must not be told "off track" while actually on the circuit. Tight
    // `onTrack` above is unchanged and still gates acceptance/coverage/bias below.
    const liveOnTrack = match !== null && Math.abs(match.lateralM) <= LEARN_WIDE_CORRIDOR_M;
    this.lastQualityOk = qualityOk;
    this.lastLiveOnTrack = liveOnTrack;

    // V2 track-map plumbing: record this sample's raw + matched local-frame positions
    // regardless of tight on-track acceptance below -- the live map shows the raw GPS
    // dot and the matched dot (red/green by `liveOnTrack`) for every fed sample that
    // produced a match, on-track or not.
    if (match !== null) {
      this.lastRawLocalPoint = this.profile.projection.toLocal({ lat: sample.lat, lon: sample.lon });
      // `match.distanceM` is distance-from-start/finish (`TrackMatcher` subtracts its
      // own `startOffsetM`); `cumulativeDistancesM`/`pointAtDistanceM` are indexed from
      // centerline vertex 0 -- add `startFinishGate.distanceM` back to convert, same
      // relationship `sampleAtLapDistance` (fixtures/drive-lap.ts) uses in reverse.
      this.lastMatchedLocalPoint = this.pointAtDistanceM(match.distanceM + this.profile.startFinishGate.distanceM);
      this.lastMatchLateralM = match.lateralM;
      this.lastMatchDistanceM = match.distanceM;
    }

    // D1 field-calibration fix: retain every quality-ok, matched sample within the wide
    // Learn corridor regardless of tight on-track acceptance below -- see `WideSample`.
    if (qualityOk && match !== null && Math.abs(match.lateralM) <= LEARN_WIDE_CORRIDOR_M) {
      this.recordWideSample(match, sample);
    }

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
    this.markCoverage(this.coverage, match.distanceM);
    if (this.previousAcceptedProgressM !== undefined) {
      const deltaM = match.unwrappedProgressM - this.previousAcceptedProgressM;
      if (Math.abs(deltaM) <= this.totalLengthM / 2) {
        if (deltaM > 0.5) this.positiveDirectionM += deltaM;
        if (deltaM < -0.5) this.negativeDirectionM += -deltaM;
        this.markCoverageBetween(this.coverage, this.previousAcceptedProgressM, match.unwrappedProgressM);
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

  /** Live progress during the Learn lap. `coverageFraction` deliberately still reports
   * TIGHT-corridor coverage (unchanged by the D1 field-calibration fix): `finish()`'s
   * bias-corrected acceptance coverage can end up higher than what was ever shown live
   * here, once a systematic offset is estimated and corrected for. `onTrack` (V6 live-
   * indicator fix) reports the WIDE Learn-corridor result instead -- see
   * `lastLiveOnTrack` -- so the live display doesn't say "off track" for a driver who is
   * on the circuit but outside the still-unvalidated tight corridor. See
   * `CalibrationConfig`. Additive V2 track-map fields (`rawLocalX`/`Y`, `matchedLocalX`/
   * `Y`, `lateralM`, `distanceM`) report the LAST fed sample's projection -- see
   * `lastRawLocalPoint` -- and are omitted until the first sample with a valid match has
   * been fed. */
  progress(): {
    coverageFraction: number;
    onTrack: boolean;
    qualityOk: boolean;
    rawLocalX?: number;
    rawLocalY?: number;
    matchedLocalX?: number;
    matchedLocalY?: number;
    lateralM?: number;
    distanceM?: number;
  } {
    const lastProjection =
      this.lastRawLocalPoint !== undefined &&
      this.lastMatchedLocalPoint !== undefined &&
      this.lastMatchLateralM !== undefined &&
      this.lastMatchDistanceM !== undefined
        ? {
            rawLocalX: this.lastRawLocalPoint.e,
            rawLocalY: this.lastRawLocalPoint.n,
            matchedLocalX: this.lastMatchedLocalPoint.e,
            matchedLocalY: this.lastMatchedLocalPoint.n,
            lateralM: this.lastMatchLateralM,
            distanceM: this.lastMatchDistanceM,
          }
        : {};
    return {
      coverageFraction: this.coverageFraction(this.coverage),
      onTrack: this.lastLiveOnTrack,
      qualityOk: this.lastQualityOk,
      ...lastProjection,
    };
  }

  /** Interpolated local-frame point at `distanceM` along the closed-loop centerline --
   * V2 track-map plumbing's cheap way to get the MATCHED (on-centerline) position for
   * the live map from a `TrackMatch`'s own `distanceM`, without re-running the O(n)
   * nearest-point search `projectOntoPolyline` does (that work already happened inside
   * `this.matcher.match()` to produce `distanceM` in the first place). */
  private pointAtDistanceM(distanceM: number): LocalPoint {
    const centerline = this.profile.centerline;
    const cumulative = this.profile.cumulativeDistancesM;
    const normalized = ((distanceM % this.totalLengthM) + this.totalLengthM) % this.totalLengthM;
    for (let index = 0; index < centerline.length; index += 1) {
      const current = centerline[index];
      const next = centerline[(index + 1) % centerline.length];
      if (current === undefined || next === undefined) continue;
      const startM = cumulative[index] ?? 0;
      const segmentLength = Math.hypot(next.e - current.e, next.n - current.n);
      const endM = index === centerline.length - 1 ? this.totalLengthM : startM + segmentLength;
      if (normalized <= endM || index === centerline.length - 1) {
        const span = endM - startM;
        const t = span === 0 ? 0 : Math.max(0, Math.min(1, (normalized - startM) / span));
        return { e: current.e + (next.e - current.e) * t, n: current.n + (next.n - current.n) * t };
      }
    }
    return centerline[0] as LocalPoint;
  }

  finish(): CalibrationResult {
    const totalSamples = this.samplesAccepted + this.samplesRejected;
    const observedRateHz = this.observedRateHz();
    const directionDetected = this.directionDetected();

    // D1 field-calibration fix: bias is estimated from the tight-corridor accepted
    // points as before; a systematic offset larger than corridorWidthM can leave that
    // set too small to trust for a whole lap, so fall back to a median-anchored
    // estimate from the wide Learn corridor instead.
    const bias =
      this.acceptedPoints.length < 50 ? this.estimateBiasFromWide() : this.estimateBias();

    // Re-project every wide-corridor sample with the bias applied and recompute
    // coverage + lateral stats from whichever of them now land inside the tight
    // corridor -- this is what recovers coverage on a track whose unvalidated OSM
    // centerline is laterally offset from the real racing line for a stretch.
    const correctedProjections = this.wideSamples.map(({ localPoint }) =>
      projectOntoPolyline(
        { e: localPoint.e - bias.e, n: localPoint.n - bias.n },
        this.profile.centerline,
        this.profile.cumulativeDistancesM,
        true,
      ),
    );
    const correctedInCorridor = correctedProjections.filter(
      (projection) => Math.abs(projection.lateralM) <= this.config.corridorWidthM,
    );

    const coverage = this.emptyCoverage();
    let previousDistanceM: number | undefined;
    for (const projection of correctedInCorridor) {
      if (previousDistanceM !== undefined) {
        this.markCoverageBetween(coverage, previousDistanceM, projection.distanceM);
      }
      this.markCoverage(coverage, projection.distanceM);
      previousDistanceM = projection.distanceM;
    }
    const coverageFraction = this.coverageFraction(coverage);
    const gap = this.longestUncoveredRun(coverage);

    const lateralValues = correctedInCorridor.map((projection) => Math.abs(projection.lateralM));
    const meanLateralM = mean(lateralValues);
    const p95LateralM = percentile95(lateralValues);

    // D2 acceptance relax: POOR_GNSS is judged against the WIDE-corridor accept set
    // (`wideSamples`), not the tight one -- so a tight corridor being too narrow for an
    // unvalidated centerline can never masquerade as bad GNSS.
    const wideRejectedFraction =
      totalSamples === 0 ? 1 : (totalSamples - this.wideSamples.length) / totalSamples;

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
      uncoveredGapStartM: gap.startM,
      uncoveredGapEndM: gap.endM,
    };

    const failureReasons: string[] = [];
    if (coverageFraction < 0.85) failureReasons.push('INSUFFICIENT_COVERAGE');
    if (directionDetected !== this.expectedDirection) failureReasons.push('WRONG_DIRECTION');
    if (wideRejectedFraction > 0.5) failureReasons.push('POOR_GNSS');
    if (observedRateHz < 0.5) failureReasons.push('RATE_TOO_LOW');
    if (gap.lengthM > 250) failureReasons.push('COVERAGE_GAP');
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

  /** `coverage` is an explicit param (not always `this.coverage`) so `finish()` can
   * recompute a separate, bias-corrected coverage bitmap without touching the live one
   * `progress()` reports mid-lap. */
  private markCoverage(coverage: boolean[], distanceM: number): void {
    const normalized = ((distanceM % this.totalLengthM) + this.totalLengthM) % this.totalLengthM;
    const bin = Math.min(coverage.length - 1, Math.floor(normalized / this.config.coverageBinM));
    coverage[bin] = true;
  }

  private markCoverageBetween(coverage: boolean[], fromM: number, toM: number): void {
    const deltaM = toM - fromM;
    const maximumContinuousStepM = Math.max(100, this.config.coverageBinM * 4);
    if (Math.abs(deltaM) > maximumContinuousStepM) return;
    const steps = Math.max(1, Math.ceil(Math.abs(deltaM) / (this.config.coverageBinM / 2)));
    for (let step = 0; step <= steps; step += 1) {
      this.markCoverage(coverage, fromM + (deltaM * step) / steps);
    }
  }

  private coverageFraction(coverage: boolean[]): number {
    const covered = coverage.reduce((sum, value) => sum + (value ? 1 : 0), 0);
    return covered / coverage.length;
  }

  /** Longest uncovered run in a coverage bitmap, plus its start/end distance-along-
   * centerline (D3 driver diagnostics). A run that wraps past the start/finish line is
   * reported as ending at `totalLengthM` rather than wrapping past it. */
  private longestUncoveredRun(coverage: boolean[]): { lengthM: number; startM: number; endM: number } {
    if (coverage.every(Boolean)) return { lengthM: 0, startM: 0, endM: 0 };
    if (coverage.every((value) => !value)) {
      return { lengthM: this.totalLengthM, startM: 0, endM: this.totalLengthM };
    }
    const binCount = coverage.length;
    const doubled = [...coverage, ...coverage];
    let longestLen = 0;
    let longestStartBin = 0;
    let currentLen = 0;
    let currentStartBin = 0;
    for (let index = 0; index < doubled.length; index += 1) {
      if (doubled[index]) {
        currentLen = 0;
        continue;
      }
      if (currentLen === 0) currentStartBin = index;
      currentLen += 1;
      const cappedLen = Math.min(currentLen, binCount);
      if (cappedLen > longestLen) {
        longestLen = cappedLen;
        longestStartBin = currentStartBin;
      }
    }
    const lengthM = Math.min(this.totalLengthM, longestLen * this.config.coverageBinM);
    const startM = (longestStartBin % binCount) * this.config.coverageBinM;
    const endM = Math.min(this.totalLengthM, startM + lengthM);
    return { lengthM, startM, endM };
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

  /** D1 fallback bias estimate used when `acceptedPoints` (tight-corridor) is too small
   * to trust (< 50 points) -- reprojects every `wideSamples` point fresh against the
   * centerline (its own `lateralM` came from the matcher's possibly hinted projection;
   * this recomputes the same full, unhinted projection `acceptedPoints` use) and solves
   * the same least-squares bias, but anchored on a median-trimmed observation set so a
   * systematic offset dominates over any noisier subset. */
  private estimateBiasFromWide(): LocalPoint {
    const observations = this.wideObservations();
    if (observations.length < 10) return { e: 0, n: 0 };

    const medianLateralM = median(observations.map((observation) => observation.lateralM));
    const madM = median(
      observations.map((observation) => Math.abs(observation.lateralM - medianLateralM)),
    );
    const toleranceM = Math.max(3, madM * 3);
    const trimmed = observations.filter(
      (observation) => Math.abs(observation.lateralM - medianLateralM) <= toleranceM,
    );
    const candidate = this.solveBias(trimmed.length >= 10 ? trimmed : observations);
    const magnitude = Math.hypot(candidate.e, candidate.n);
    if (magnitude < 1.5 || magnitude > LEARN_WIDE_CORRIDOR_M) return { e: 0, n: 0 };

    const before = percentile95(observations.map((observation) => Math.abs(observation.lateralM)));
    const after = percentile95(
      observations.map((observation) =>
        Math.abs(
          observation.lateralM - observation.normalE * candidate.e - observation.normalN * candidate.n,
        ),
      ),
    );
    return before > 0 && after <= before * 0.8 ? candidate : { e: 0, n: 0 };
  }

  private wideObservations(): Array<{ normalE: number; normalN: number; lateralM: number }> {
    const observations: Array<{ normalE: number; normalN: number; lateralM: number }> = [];
    for (const sample of this.wideSamples) {
      const projection = projectOntoPolyline(
        sample.localPoint,
        this.profile.centerline,
        this.profile.cumulativeDistancesM,
        true,
      );
      const a = this.profile.centerline[projection.segmentIndex];
      const b = this.profile.centerline[(projection.segmentIndex + 1) % this.profile.centerline.length];
      if (a === undefined || b === undefined) continue;
      const length = Math.hypot(b.e - a.e, b.n - a.n);
      if (length === 0) continue;
      observations.push({
        normalE: -(b.n - a.n) / length,
        normalN: (b.e - a.e) / length,
        lateralM: projection.lateralM,
      });
    }
    return observations;
  }

  private recordWideSample(match: TrackMatch, sample: LocationSample): void {
    if (this.wideSamples.length >= MAX_ACCEPTED_POINTS) {
      this.calibrationOverrun = true;
      return;
    }
    const localPoint = this.profile.projection.toLocal({ lat: sample.lat, lon: sample.lon });
    this.wideSamples.push({
      distanceM: match.distanceM,
      lateralM: match.lateralM,
      unwrappedProgressM: match.unwrappedProgressM,
      localPoint,
    });
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
