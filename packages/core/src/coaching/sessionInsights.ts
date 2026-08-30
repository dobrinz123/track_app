import { CORNER_ANALYSIS_VERSION, type Corner } from '../contracts';

import { classifyLap, type ClassifyLapOptions } from './cleanLap';
import {
  channelAvailability,
  computeCornerMetrics,
  cornerWindows,
  type CornerMetricsOptions,
} from './cornerMetrics';
import {
  assertPositiveLength,
  deltaCurveMs,
  deltaOverSegmentMs,
  resampleLapToDistanceGrid,
  type DistanceGrid,
} from './distanceDomain';
import { buildDemonstratedEnvelope, type CornerEnvelope, type DemonstratedEnvelope } from './envelope';
import type {
  ChannelAvailability,
  ClassifiableLap,
  CoachingChannelId,
  CornerLapSample,
  CornerMetrics,
  LapAnomalyReason,
  LapCheckId,
  LapLabel,
  LapStatus,
} from './types';

/**
 * Session-level insights -- `docs/architecture/analysis-engine.md` §5, in the
 * user's priority order: (1) where time is lost per corner and sector versus
 * their own best clean lap, (2) consistency, (3) brake/lift points per corner
 * per lap, (4) minimum and exit speed.
 *
 * V1 is OBSERVATIONS ONLY (Phase 5 REVISION): nothing here suggests a change of
 * driving. Honesty gates are explicit -- fewer than two clean laps, missing
 * channels, poor GNSS or unvalidated circuit geometry each add an entry to
 * `limitations`, and comparisons that need a reference are suppressed rather
 * than computed on thin evidence.
 */

// --- consistency scoring constants (documented, not tuned per circuit) -------
/** Brake-point spread (P90-P10) that scores 0 for consistency, metres. */
export const CONSISTENCY_BRAKE_SPREAD_M = 40;
/** Minimum-speed spread that scores 0, km/h. */
export const CONSISTENCY_MIN_SPEED_SPREAD_KPH = 12;
/** Corner-time spread that scores 0, milliseconds. */
export const CONSISTENCY_SECTOR_SPREAD_MS = 1_200;
/** Lap-time spread that scores 0, milliseconds. */
export const CONSISTENCY_LAP_SPREAD_MS = 4_000;
/** Minimum clean laps before any lap-to-lap comparison is reported. */
export const MIN_CLEAN_LAPS_FOR_COMPARISON = 2;

/** Difference in a brake/lift/throttle point that is worth naming, metres. */
const CAUSE_DISTANCE_M = 5;
/** Difference in a corner speed that is worth naming, km/h. */
const CAUSE_SPEED_KPH = 1;

export interface SessionLapInput {
  /** The timing engine's lap record (a `LapRecord` satisfies `ClassifiableLap`). */
  lap: ClassifiableLap;
  /** Projected, time-ordered samples of that lap. */
  samples: readonly CornerLapSample[];
  /** Optional sector times from the timing engine. */
  sectorTimes?: readonly { sectorIndex: number; durationMs: number }[];
}

export interface SessionAnalysisContext {
  totalLengthM: number;
  circuitId: string;
  circuitName?: string;
  layoutId?: string;
  /** Channels this vehicle/session does not provide; never read. */
  unsupportedChannels?: readonly CoachingChannelId[];
  /**
   * False when the circuit geometry has not been validated in the field
   * (MotorPark today) -- corner positions are then approximate and the report
   * says so.
   */
  geometryValidated?: boolean;
  cornerMetrics?: Omit<Partial<CornerMetricsOptions>, 'totalLengthM' | 'unsupportedChannels'>;
  cleanLap?: Omit<Partial<ClassifyLapOptions>, 'totalLengthM'>;
  /** Distance-grid step for the delta curve, metres. Default 1. */
  gridStepM?: number;
}

export interface LapInsight {
  lapNumber: number;
  durationMs: number;
  valid: boolean;
  /** `clean` / `unverified` / `anomalous` -- see `LapStatus`. */
  status: LapStatus;
  /** True only for `status === 'clean'`. */
  clean: boolean;
  reason: LapAnomalyReason | null;
  reasons: LapAnomalyReason[];
  detail: string;
  /** Safety checks this lap's samples could not support. */
  unavailableChecks: LapCheckId[];
  /** Fraction of the lap distance each safety check had evidence over, 0..1. */
  checkCoverage: Record<LapCheckId, number>;
  coverageFraction: number;
  corners: CornerMetrics[];
  /** Informative labels this lap carries (R2-1) -- never used to exclude it. */
  labels: LapLabel[];
  /** Peak |longitudinal g| observed, magnitude. Feeds HEAVY_BRAKING's sentence. */
  peakDecelG: number | null;
  /** Worst yaw-rate excess over the implied yaw, deg/s. Feeds SLIDE_ROTATION's sentence. */
  yawExcessDps: number | null;
  /** True when an ABS-like brake-release-reapply oscillation was detected. */
  absOscillationDetected: boolean;
}

export interface CornerLapRow {
  lapNumber: number;
  clean: boolean;
  brakeStartM: number | null;
  brakeSource: CornerMetrics['brakeSource'];
  /** P4l-FIX4 N3: the sampling-interval width of `brakeStartM`, metres; non-null only for a held (state) brake channel. */
  brakeOnsetUncertaintyM: number | null;
  liftPointM: number | null;
  liftSource: CornerMetrics['liftSource'];
  peakDecelG: number | null;
  minSpeedKph: number | null;
  exitSpeedKph: number | null;
  sectorMs: number | null;
  throttleOnM: number | null;
  maxLatG: number | null;
  frictionCircleMaxG: number | null;
  /** Time lost (+) or gained (-) against the reference lap over this corner, ms. */
  deltaMs: number | null;
  qualityOk: boolean;
}

export type TimeLossCause =
  | 'EARLIER_BRAKE'
  | 'EARLIER_LIFT'
  | 'LOWER_MIN_SPEED'
  | 'LOWER_EXIT_SPEED'
  | 'LATER_THROTTLE';

export interface TimeLossFinding {
  cornerId: number;
  /** The reference (best clean) lap this corner is measured against. */
  referenceLapNumber: number;
  /**
   * The REPRESENTATIVE clean lap whose loss against the reference is ranked:
   * the median clean lap from three laps up, and the other clean lap when the
   * session has exactly the two the honesty gate requires.
   */
  comparisonLapNumber: number;
  /** Δt contribution of the comparison lap over the corner window, ms (+ = lost). */
  deltaMs: number | null;
  /** Corner time of the comparison lap minus the best corner time, ms. */
  sectorLossMs: number | null;
  bestSectorMs: number | null;
  bestSectorLapNumber: number | null;
  comparisonSectorMs: number | null;
  causes: TimeLossCause[];
}

/** Which measurements a consistency score was actually built from. */
export type ConsistencyComponent = 'brake' | 'minSpeed' | 'sector';

export interface ConsistencyFinding {
  cornerId: number;
  lapCount: number;
  /** P90-P10 spread across clean laps. */
  brakeSpreadM: number | null;
  minSpeedSpreadKph: number | null;
  sectorSpreadMs: number | null;
  /** 0-100, 100 = tight. `null` when there is not enough clean evidence. */
  score: number | null;
  /**
   * The components the score averaged, in a fixed order. A score built from
   * corner time alone is NOT the same measurement as one built from brake
   * point, minimum speed and corner time.
   */
  basis: ConsistencyComponent[];
  /**
   * True when this corner's basis matches the basis the ranking uses. Only
   * corners that share a basis are ranked against each other.
   */
  comparable: boolean;
}

export interface SectorLossFinding {
  sectorIndex: number;
  referenceLapNumber: number;
  referenceMs: number;
  /** The same representative lap the corner ranking compares (see `TimeLossFinding`). */
  comparisonLapNumber: number;
  comparisonMs: number;
  /** `comparisonMs - referenceMs`: positive = lost, negative = gained. */
  lostMs: number;
}

export interface CornerInsight {
  cornerId: number;
  entryDistanceM: number;
  apexDistanceM: number;
  exitDistanceM: number;
  direction: Corner['direction'];
  severity: Corner['severity'];
  advisorySpeedKph: number;
  /** Rows for every lap, clean or not, ordered by lap number. */
  perLap: CornerLapRow[];
  cleanLapCount: number;
  bestSectorMs: number | null;
  bestSectorLapNumber: number | null;
  medianSectorMs: number | null;
  worstSectorMs: number | null;
  worstSectorLapNumber: number | null;
  envelope: CornerEnvelope | null;
  consistency: ConsistencyFinding | null;
  timeLoss: TimeLossFinding | null;
}

export type LimitationCode =
  | 'NO_CLEAN_LAPS'
  | 'FEW_CLEAN_LAPS'
  | 'UNVERIFIED_LAPS'
  | 'UNSUPPORTED_CHANNELS'
  | 'MISSING_CHANNELS'
  | 'GNSS_QUALITY'
  | 'GEOMETRY_UNVALIDATED'
  | 'CORNER_COVERAGE'
  | 'TIME_INTEGRATION_DRIFT';

export interface Limitation {
  code: LimitationCode;
  /** Counts referenced by the rendered sentence (laps, corners, ...). */
  count?: number;
  channels?: CoachingChannelId[];
  lapNumbers?: number[];
  cornerIds?: number[];
  /** Safety checks that could not run (`UNVERIFIED_LAPS`). */
  checks?: LapCheckId[];
  /**
   * Percentage of the lap distance the WEAKEST unavailable check had evidence
   * over (`UNVERIFIED_LAPS`): "no data" and "data for 11 % of the lap" are two
   * different statements and the report has to make the right one.
   */
  coveragePercent?: number;
  /**
   * Largest disagreement between the integrated `t(s)` and the recorded clock
   * on any lap, milliseconds (`TIME_INTEGRATION_DRIFT`).
   */
  driftMs?: number;
}

export interface LapTimeConsistency {
  lapCount: number;
  bestMs: number;
  bestLapNumber: number;
  medianMs: number;
  worstMs: number;
  worstLapNumber: number;
  spreadMs: number;
  score: number;
}

export interface SessionInsights {
  analysisVersion: number;
  circuitId: string;
  circuitName: string | null;
  layoutId: string | null;
  totalLengthM: number;
  geometryValidated: boolean;
  /** V1 states observations only -- no suggestions are produced. */
  observationsOnly: true;
  lapCount: number;
  cleanLapCount: number;
  laps: LapInsight[];
  referenceLapNumber: number | null;
  referenceDurationMs: number | null;
  medianCleanLapNumber: number | null;
  /** The representative clean lap every comparison in this report uses. */
  comparisonLapNumber: number | null;
  corners: CornerInsight[];
  /** Corners ranked by time lost on the representative clean lap, worst first. */
  timeLossRanking: TimeLossFinding[];
  /** Corners ranked by consistency score, least consistent first (same basis only). */
  consistencyRanking: ConsistencyFinding[];
  sectorTimeLoss: SectorLossFinding[];
  lapTimeConsistency: LapTimeConsistency | null;
  envelope: DemonstratedEnvelope;
  availability: ChannelAvailability;
  limitations: Limitation[];
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower];
  const high = sorted[upper];
  if (low === undefined || high === undefined) return null;
  return low + (high - low) * (position - lower);
}

function spread(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const high = percentile(values, 0.9);
  const low = percentile(values, 0.1);
  if (high === null || low === null) return null;
  return high - low;
}

function subScore(value: number | null, zeroAt: number): number | null {
  if (value === null) return null;
  return Math.max(0, Math.min(100, 100 * (1 - value / zeroAt)));
}

function lowerMedianOf<T>(entries: readonly T[], value: (entry: T) => number): T | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => value(a) - value(b));
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function definedNumbers(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null && Number.isFinite(value));
}

function metricsOf(lap: LapInsight, cornerId: number): CornerMetrics | undefined {
  return lap.corners.find((entry) => entry.cornerId === cornerId);
}

/**
 * Runs the whole deterministic analysis for one session: classification,
 * per-corner metrics, the demonstrated envelope, the distance-domain delta
 * curves and the ranked findings the report renders.
 */
export function analyzeSession(
  laps: readonly SessionLapInput[],
  corners: readonly Corner[],
  context: SessionAnalysisContext,
): SessionInsights {
  assertPositiveLength(context.totalLengthM);
  const totalLengthM = context.totalLengthM;
  const unsupportedChannels = context.unsupportedChannels ?? [];
  const metricsOptions: CornerMetricsOptions = {
    ...(context.cornerMetrics ?? {}),
    totalLengthM,
    unsupportedChannels,
  };
  const orderedCorners = [...corners].sort((a, b) => a.id - b.id);
  const orderedLaps = [...laps].sort((a, b) => a.lap.lapNumber - b.lap.lapNumber);
  // Lap numbers key every comparison, the envelope and the report sentences: a
  // duplicate would silently make one lap stand for two different drives.
  const seenLapNumbers = new Set<number>();
  for (const entry of orderedLaps) {
    if (seenLapNumbers.has(entry.lap.lapNumber)) {
      throw new RangeError(`duplicate lap number ${entry.lap.lapNumber} in the session`);
    }
    seenLapNumbers.add(entry.lap.lapNumber);
  }

  // --- per lap ---------------------------------------------------------------
  const lapInsights: LapInsight[] = orderedLaps.map((entry) => {
    const classification = classifyLap(entry.lap, entry.samples, {
      ...(context.cleanLap ?? {}),
      totalLengthM,
    });
    return {
      lapNumber: entry.lap.lapNumber,
      durationMs: entry.lap.durationMs,
      valid: entry.lap.valid,
      status: classification.status,
      clean: classification.clean,
      reason: classification.reason,
      reasons: classification.reasons,
      detail: classification.detail,
      unavailableChecks: classification.unavailableChecks,
      checkCoverage: classification.checkCoverage,
      coverageFraction: classification.coverageFraction,
      corners: computeCornerMetrics(entry.samples, orderedCorners, metricsOptions),
      labels: classification.labels,
      peakDecelG: classification.peakDecelG,
      yawExcessDps: classification.yawExcessDps,
      absOscillationDetected: classification.absOscillationDetected,
    };
  });

  const cleanLaps = lapInsights.filter((lap) => lap.clean);
  const envelope = buildDemonstratedEnvelope(
    cleanLaps.map((lap) => ({ lapNumber: lap.lapNumber, corners: lap.corners })),
  );

  const availability = channelAvailability(
    orderedLaps.flatMap((entry) => [...entry.samples]),
    unsupportedChannels,
  );

  // --- reference and median clean laps ---------------------------------------
  const comparable = cleanLaps.length >= MIN_CLEAN_LAPS_FOR_COMPARISON;
  const reference =
    cleanLaps.length === 0
      ? null
      : cleanLaps.reduce((best, lap) =>
          lap.durationMs < best.durationMs ||
          (lap.durationMs === best.durationMs && lap.lapNumber < best.lapNumber)
            ? lap
            : best,
        );
  const medianLap = comparable ? lowerMedianOf(cleanLaps, (lap) => lap.durationMs) : null;
  // The lap the report compares against the reference. With three or more clean
  // laps that is the median; with exactly the two the honesty gate requires,
  // the median IS the reference, so the other clean lap is the representative
  // one -- otherwise the minimum session that passes the gate would produce an
  // empty priority-1 report.
  const comparisonLap: LapInsight | null =
    !comparable || reference === null
      ? null
      : (() => {
          if (medianLap !== null && medianLap.lapNumber !== reference.lapNumber) return medianLap;
          const rest = [...cleanLaps]
            .filter((lap) => lap.lapNumber !== reference.lapNumber)
            .sort((a, b) => a.durationMs - b.durationMs || a.lapNumber - b.lapNumber);
          return rest[Math.floor((rest.length - 1) / 2)] ?? null;
        })();

  // --- distance-domain delta curves -----------------------------------------
  const gridStepM = context.gridStepM ?? 1;
  const grids = new Map<number, DistanceGrid>();
  if (reference !== null) {
    for (const entry of orderedLaps) {
      grids.set(
        entry.lap.lapNumber,
        resampleLapToDistanceGrid(entry.samples, { totalLengthM, stepM: gridStepM }),
      );
    }
  }
  const referenceGrid = reference === null ? undefined : grids.get(reference.lapNumber);
  const deltaCurves = new Map<number, (number | null)[]>();
  if (referenceGrid !== undefined) {
    for (const [lapNumber, grid] of grids) {
      if (lapNumber === reference?.lapNumber) continue;
      deltaCurves.set(lapNumber, deltaCurveMs(grid, referenceGrid));
    }
  }

  // --- per corner ------------------------------------------------------------
  const cornerInsights: CornerInsight[] = orderedCorners.map((corner) => {
    const windows = cornerWindows(corner, orderedCorners, metricsOptions);
    const perLap: CornerLapRow[] = lapInsights.map((lap) => {
      const metrics = metricsOf(lap, corner.id);
      const delta = deltaCurves.get(lap.lapNumber);
      const deltaMs =
        delta === undefined || referenceGrid === undefined
          ? null
          : deltaOverSegmentMs(delta, windows.approachStartM, windows.exitM, {
              stepM: gridStepM,
              totalLengthM,
            });
      return {
        lapNumber: lap.lapNumber,
        clean: lap.clean,
        brakeStartM: metrics?.brakeStartM ?? null,
        brakeSource: metrics?.brakeSource ?? null,
        brakeOnsetUncertaintyM: metrics?.brakeOnsetUncertaintyM ?? null,
        liftPointM: metrics?.liftPointM ?? null,
        liftSource: metrics?.liftSource ?? null,
        peakDecelG: metrics?.peakDecelG ?? null,
        minSpeedKph: metrics?.minSpeedKph ?? null,
        exitSpeedKph: metrics?.exitSpeedKph ?? null,
        sectorMs: metrics?.sectorMs ?? null,
        throttleOnM: metrics?.throttleOnM ?? null,
        maxLatG: metrics?.maxLatG ?? null,
        frictionCircleMaxG: metrics?.frictionCircleMaxG ?? null,
        deltaMs: lap.lapNumber === reference?.lapNumber ? 0 : deltaMs,
        qualityOk: metrics?.quality.ok ?? false,
      };
    });

    const cleanRows = perLap.filter((row) => row.clean && row.qualityOk);
    const sectorValues = cleanRows
      .map((row) => ({ lapNumber: row.lapNumber, value: row.sectorMs }))
      .filter((entry): entry is { lapNumber: number; value: number } => entry.value !== null);
    const bestSector = sectorValues.reduce<{ lapNumber: number; value: number } | null>(
      (best, entry) => (best === null || entry.value < best.value ? entry : best),
      null,
    );
    const worstSector = sectorValues.reduce<{ lapNumber: number; value: number } | null>(
      (worst, entry) => (worst === null || entry.value > worst.value ? entry : worst),
      null,
    );
    const medianSector = lowerMedianOf(sectorValues, (entry) => entry.value);

    const consistency: ConsistencyFinding | null = comparable
      ? (() => {
          const brakeSpread = spread(definedNumbers(cleanRows.map((row) => row.brakeStartM)));
          const minSpeedSpread = spread(definedNumbers(cleanRows.map((row) => row.minSpeedKph)));
          const sectorSpread = spread(sectorValues.map((entry) => entry.value));
          const components: { id: ConsistencyComponent; score: number | null }[] = [
            { id: 'brake', score: subScore(brakeSpread, CONSISTENCY_BRAKE_SPREAD_M) },
            { id: 'minSpeed', score: subScore(minSpeedSpread, CONSISTENCY_MIN_SPEED_SPREAD_KPH) },
            { id: 'sector', score: subScore(sectorSpread, CONSISTENCY_SECTOR_SPREAD_MS) },
          ];
          const used = components.filter(
            (component): component is { id: ConsistencyComponent; score: number } =>
              component.score !== null,
          );
          return {
            cornerId: corner.id,
            lapCount: cleanRows.length,
            brakeSpreadM: brakeSpread,
            minSpeedSpreadKph: minSpeedSpread,
            sectorSpreadMs: sectorSpread,
            score:
              used.length === 0
                ? null
                : Math.round(
                    used.reduce((sum, component) => sum + component.score, 0) / used.length,
                  ),
            basis: used.map((component) => component.id),
            // Filled in below, once every corner's basis is known.
            comparable: false,
          };
        })()
      : null;

    const timeLoss: TimeLossFinding | null =
      comparable && reference !== null && comparisonLap !== null
        ? (() => {
            const medianRow = perLap.find((row) => row.lapNumber === comparisonLap.lapNumber);
            const referenceMetrics = metricsOf(reference, corner.id);
            const medianMetrics = metricsOf(comparisonLap, corner.id);
            const causes: TimeLossCause[] = [];
            if (referenceMetrics !== undefined && medianMetrics !== undefined) {
              const later = (a: number | null, b: number | null, margin: number): boolean =>
                a !== null && b !== null && a > b + margin;
              const lower = (a: number | null, b: number | null, margin: number): boolean =>
                a !== null && b !== null && a < b - margin;
              if (later(medianMetrics.brakeStartM, referenceMetrics.brakeStartM, CAUSE_DISTANCE_M)) {
                causes.push('EARLIER_BRAKE');
              }
              // With no pedal channel the lift IS the braking onset; naming both
              // would report one measurement as two independent causes.
              const liftIsBrakeOnset =
                medianMetrics.liftSource === 'decelOnset' &&
                medianMetrics.liftPointM === medianMetrics.brakeStartM;
              if (
                !liftIsBrakeOnset &&
                later(medianMetrics.liftPointM, referenceMetrics.liftPointM, CAUSE_DISTANCE_M)
              ) {
                causes.push('EARLIER_LIFT');
              }
              if (lower(medianMetrics.minSpeedKph, referenceMetrics.minSpeedKph, CAUSE_SPEED_KPH)) {
                causes.push('LOWER_MIN_SPEED');
              }
              if (lower(medianMetrics.exitSpeedKph, referenceMetrics.exitSpeedKph, CAUSE_SPEED_KPH)) {
                causes.push('LOWER_EXIT_SPEED');
              }
              if (later(medianMetrics.throttleOnM, referenceMetrics.throttleOnM, CAUSE_DISTANCE_M)) {
                causes.push('LATER_THROTTLE');
              }
            }
            // Only a cleanly measured corner time may be compared with the
            // best one -- otherwise a flagged window could "beat" the record.
            const medianSectorMs =
              medianRow !== undefined && medianRow.qualityOk ? medianRow.sectorMs : null;
            return {
              cornerId: corner.id,
              referenceLapNumber: reference.lapNumber,
              comparisonLapNumber: comparisonLap.lapNumber,
              deltaMs: medianRow?.deltaMs ?? null,
              sectorLossMs:
                medianSectorMs !== null && bestSector !== null
                  ? medianSectorMs - bestSector.value
                  : null,
              bestSectorMs: bestSector?.value ?? null,
              bestSectorLapNumber: bestSector?.lapNumber ?? null,
              comparisonSectorMs: medianSectorMs,
              causes,
            };
          })()
        : null;

    return {
      cornerId: corner.id,
      entryDistanceM: corner.entryDistanceM,
      apexDistanceM: corner.apexDistanceM,
      exitDistanceM: corner.exitDistanceM,
      direction: corner.direction,
      severity: corner.severity,
      advisorySpeedKph: corner.advisorySpeedKph,
      perLap,
      cleanLapCount: cleanRows.length,
      bestSectorMs: bestSector?.value ?? null,
      bestSectorLapNumber: bestSector?.lapNumber ?? null,
      medianSectorMs: medianSector?.value ?? null,
      worstSectorMs: worstSector?.value ?? null,
      worstSectorLapNumber: worstSector?.lapNumber ?? null,
      envelope: envelope.corners.find((entry) => entry.cornerId === corner.id) ?? null,
      consistency,
      timeLoss,
    };
  });

  // --- rankings ---------------------------------------------------------------
  const timeLossRanking = cornerInsights
    .map((corner) => corner.timeLoss)
    .filter((finding): finding is TimeLossFinding => finding !== null)
    .sort((a, b) => {
      const left = a.deltaMs ?? a.sectorLossMs ?? Number.NEGATIVE_INFINITY;
      const right = b.deltaMs ?? b.sectorLossMs ?? Number.NEGATIVE_INFINITY;
      return right - left || a.cornerId - b.cornerId;
    });

  // A consistency score built from corner time alone and one built from brake
  // point + minimum speed + corner time are not the same measurement, so only
  // corners that share an evidence basis are ranked against each other. The
  // ranked basis is the most common one; ties go to the richer basis, then to
  // the lexicographically smaller key, so the choice is deterministic.
  const scored = cornerInsights
    .map((corner) => corner.consistency)
    .filter((finding): finding is ConsistencyFinding => finding !== null && finding.score !== null);
  const basisKey = (finding: ConsistencyFinding): string => finding.basis.join('+');
  const counts = new Map<string, { count: number; size: number }>();
  for (const finding of scored) {
    const key = basisKey(finding);
    const seen = counts.get(key);
    counts.set(key, { count: (seen?.count ?? 0) + 1, size: finding.basis.length });
  }
  let rankedBasis: string | null = null;
  for (const [key, value] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const incumbent = rankedBasis === null ? null : counts.get(rankedBasis);
    if (
      incumbent === undefined ||
      incumbent === null ||
      value.count > incumbent.count ||
      (value.count === incumbent.count && value.size > incumbent.size)
    ) {
      rankedBasis = key;
    }
  }
  for (const corner of cornerInsights) {
    if (corner.consistency === null) continue;
    corner.consistency.comparable =
      corner.consistency.score !== null && basisKey(corner.consistency) === rankedBasis;
  }
  const consistencyRanking = scored
    .filter((finding) => finding.comparable)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0) || a.cornerId - b.cornerId);

  // --- track sectors ----------------------------------------------------------
  // The SAME comparison the corner ranking uses: the representative clean lap
  // against the best-clean reference. Comparing the reference against the best
  // sector on any lap would report the driver's own personal best as a loss.
  const sectorTimeLoss: SectorLossFinding[] = [];
  if (comparable && reference !== null && comparisonLap !== null) {
    const referenceEntry = orderedLaps.find((entry) => entry.lap.lapNumber === reference.lapNumber);
    const comparisonEntry = orderedLaps.find(
      (entry) => entry.lap.lapNumber === comparisonLap.lapNumber,
    );
    const sectorIndices = [
      ...new Set(
        orderedLaps.flatMap((entry) => (entry.sectorTimes ?? []).map((sector) => sector.sectorIndex)),
      ),
    ].sort((a, b) => a - b);
    for (const sectorIndex of sectorIndices) {
      const referenceMs = referenceEntry?.sectorTimes?.find(
        (sector) => sector.sectorIndex === sectorIndex,
      )?.durationMs;
      const comparisonMs = comparisonEntry?.sectorTimes?.find(
        (sector) => sector.sectorIndex === sectorIndex,
      )?.durationMs;
      if (referenceMs === undefined || !Number.isFinite(referenceMs)) continue;
      if (comparisonMs === undefined || !Number.isFinite(comparisonMs)) continue;
      sectorTimeLoss.push({
        sectorIndex,
        referenceLapNumber: reference.lapNumber,
        referenceMs,
        comparisonLapNumber: comparisonLap.lapNumber,
        comparisonMs,
        lostMs: comparisonMs - referenceMs,
      });
    }
    sectorTimeLoss.sort((a, b) => b.lostMs - a.lostMs || a.sectorIndex - b.sectorIndex);
  }

  // --- lap-time consistency ----------------------------------------------------
  let lapTimeConsistency: LapTimeConsistency | null = null;
  if (comparable) {
    const durations = cleanLaps.map((lap) => lap.durationMs);
    const spreadMs = spread(durations);
    const best = cleanLaps.reduce((accumulator, lap) =>
      lap.durationMs < accumulator.durationMs ? lap : accumulator,
    );
    const worst = cleanLaps.reduce((accumulator, lap) =>
      lap.durationMs > accumulator.durationMs ? lap : accumulator,
    );
    const median = lowerMedianOf(cleanLaps, (lap) => lap.durationMs);
    if (spreadMs !== null && median !== null) {
      lapTimeConsistency = {
        lapCount: cleanLaps.length,
        bestMs: best.durationMs,
        bestLapNumber: best.lapNumber,
        medianMs: median.durationMs,
        worstMs: worst.durationMs,
        worstLapNumber: worst.lapNumber,
        spreadMs,
        score: Math.round(subScore(spreadMs, CONSISTENCY_LAP_SPREAD_MS) ?? 0),
      };
    }
  }

  // --- honesty gates ------------------------------------------------------------
  const limitations: Limitation[] = [];
  if (cleanLaps.length === 0) {
    limitations.push({ code: 'NO_CLEAN_LAPS', count: 0 });
  } else if (!comparable) {
    limitations.push({ code: 'FEW_CLEAN_LAPS', count: cleanLaps.length });
  }
  // A lap whose safety checks could not run is neither clean nor anomalous, and
  // the report has to say which evidence was missing rather than stay silent.
  const unverifiedLaps = lapInsights.filter((lap) => lap.status === 'unverified');
  if (unverifiedLaps.length > 0) {
    const checkOrder: readonly LapCheckId[] = [
      'offTrack',
      'yawSpike',
      'decelSpike',
      'gnssPoor',
      'coverage',
    ];
    const seen = new Set(unverifiedLaps.flatMap((lap) => lap.unavailableChecks));
    const coverages = unverifiedLaps.flatMap((lap) =>
      lap.unavailableChecks.map((check) => lap.checkCoverage[check] ?? 0),
    );
    limitations.push({
      code: 'UNVERIFIED_LAPS',
      count: unverifiedLaps.length,
      lapNumbers: unverifiedLaps.map((lap) => lap.lapNumber),
      checks: checkOrder.filter((check) => seen.has(check)),
      coveragePercent: Math.round(Math.min(...coverages, 1) * 100),
    });
  }
  // `t(s)` is the integral of ds/v; when a lap's own timestamps disagree with
  // that integral by more than the tolerance, the delta curve built from it is
  // only as good as the speed channel, and the report has to say so.
  const driftingLaps = orderedLaps
    .map((entry) => ({ lapNumber: entry.lap.lapNumber, grid: grids.get(entry.lap.lapNumber) }))
    .filter((entry) => entry.grid?.timeIntegrationDriftExceeded === true);
  if (driftingLaps.length > 0) {
    const worst = driftingLaps.reduce(
      (best, entry) => Math.max(best, Math.abs(entry.grid?.timeIntegrationDriftMs ?? 0)),
      0,
    );
    limitations.push({
      code: 'TIME_INTEGRATION_DRIFT',
      count: driftingLaps.length,
      lapNumbers: driftingLaps.map((entry) => entry.lapNumber),
      driftMs: Math.round(worst),
    });
  }
  if (availability.unsupported.length > 0) {
    limitations.push({ code: 'UNSUPPORTED_CHANNELS', channels: availability.unsupported });
  }
  if (availability.missing.length > 0) {
    limitations.push({ code: 'MISSING_CHANNELS', channels: availability.missing });
  }
  const poorGnssLaps = lapInsights
    .filter((lap) => lap.reasons.includes('gnssPoor'))
    .map((lap) => lap.lapNumber);
  if (poorGnssLaps.length > 0) {
    limitations.push({ code: 'GNSS_QUALITY', lapNumbers: poorGnssLaps, count: poorGnssLaps.length });
  }
  if (context.geometryValidated === false) {
    limitations.push({ code: 'GEOMETRY_UNVALIDATED' });
  }
  const uncovered = cornerInsights
    .filter((corner) => corner.perLap.every((row) => !row.qualityOk))
    .map((corner) => corner.cornerId);
  if (uncovered.length > 0) {
    limitations.push({ code: 'CORNER_COVERAGE', cornerIds: uncovered, count: uncovered.length });
  }

  return {
    analysisVersion: CORNER_ANALYSIS_VERSION,
    circuitId: context.circuitId,
    circuitName: context.circuitName ?? null,
    layoutId: context.layoutId ?? null,
    totalLengthM,
    geometryValidated: context.geometryValidated ?? true,
    observationsOnly: true,
    lapCount: lapInsights.length,
    cleanLapCount: cleanLaps.length,
    laps: lapInsights,
    referenceLapNumber: reference?.lapNumber ?? null,
    referenceDurationMs: reference?.durationMs ?? null,
    medianCleanLapNumber: medianLap?.lapNumber ?? null,
    comparisonLapNumber: comparisonLap?.lapNumber ?? null,
    corners: cornerInsights,
    timeLossRanking,
    consistencyRanking,
    sectorTimeLoss,
    lapTimeConsistency,
    envelope,
    availability,
    limitations,
  };
}
