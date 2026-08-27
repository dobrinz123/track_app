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
  clean: boolean;
  reason: LapAnomalyReason | null;
  reasons: LapAnomalyReason[];
  detail: string;
  coverageFraction: number;
  corners: CornerMetrics[];
}

export interface CornerLapRow {
  lapNumber: number;
  clean: boolean;
  brakeStartM: number | null;
  brakeSource: CornerMetrics['brakeSource'];
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
  /** The median clean lap, whose loss against the reference is ranked. */
  medianLapNumber: number;
  /** Δt contribution of the median lap over the corner window, ms (+ = lost). */
  deltaMs: number | null;
  /** Corner time of the median lap minus the best corner time, ms. */
  sectorLossMs: number | null;
  bestSectorMs: number | null;
  bestSectorLapNumber: number | null;
  medianSectorMs: number | null;
  causes: TimeLossCause[];
}

export interface ConsistencyFinding {
  cornerId: number;
  lapCount: number;
  /** P90-P10 spread across clean laps. */
  brakeSpreadM: number | null;
  minSpeedSpreadKph: number | null;
  sectorSpreadMs: number | null;
  /** 0-100, 100 = tight. `null` when there is not enough clean evidence. */
  score: number | null;
}

export interface SectorLossFinding {
  sectorIndex: number;
  referenceLapNumber: number;
  referenceMs: number;
  bestMs: number;
  bestLapNumber: number;
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
  | 'UNSUPPORTED_CHANNELS'
  | 'MISSING_CHANNELS'
  | 'GNSS_QUALITY'
  | 'GEOMETRY_UNVALIDATED'
  | 'CORNER_COVERAGE';

export interface Limitation {
  code: LimitationCode;
  /** Counts referenced by the rendered sentence (laps, corners, ...). */
  count?: number;
  channels?: CoachingChannelId[];
  lapNumbers?: number[];
  cornerIds?: number[];
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
  corners: CornerInsight[];
  /** Corners ranked by time lost on the median clean lap, worst first. */
  timeLossRanking: TimeLossFinding[];
  /** Corners ranked by consistency score, least consistent first. */
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
      clean: classification.clean,
      reason: classification.reason,
      reasons: classification.reasons,
      detail: classification.detail,
      coverageFraction: classification.coverageFraction,
      corners: computeCornerMetrics(entry.samples, orderedCorners, metricsOptions),
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
          const parts = [
            subScore(brakeSpread, CONSISTENCY_BRAKE_SPREAD_M),
            subScore(minSpeedSpread, CONSISTENCY_MIN_SPEED_SPREAD_KPH),
            subScore(sectorSpread, CONSISTENCY_SECTOR_SPREAD_MS),
          ].filter((part): part is number => part !== null);
          return {
            cornerId: corner.id,
            lapCount: cleanRows.length,
            brakeSpreadM: brakeSpread,
            minSpeedSpreadKph: minSpeedSpread,
            sectorSpreadMs: sectorSpread,
            score:
              parts.length === 0
                ? null
                : Math.round(parts.reduce((sum, part) => sum + part, 0) / parts.length),
          };
        })()
      : null;

    const timeLoss: TimeLossFinding | null =
      comparable && reference !== null && medianLap !== null && medianLap.lapNumber !== reference.lapNumber
        ? (() => {
            const medianRow = perLap.find((row) => row.lapNumber === medianLap.lapNumber);
            const referenceMetrics = metricsOf(reference, corner.id);
            const medianMetrics = metricsOf(medianLap, corner.id);
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
              medianLapNumber: medianLap.lapNumber,
              deltaMs: medianRow?.deltaMs ?? null,
              sectorLossMs:
                medianSectorMs !== null && bestSector !== null
                  ? medianSectorMs - bestSector.value
                  : null,
              bestSectorMs: bestSector?.value ?? null,
              bestSectorLapNumber: bestSector?.lapNumber ?? null,
              medianSectorMs,
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

  const consistencyRanking = cornerInsights
    .map((corner) => corner.consistency)
    .filter((finding): finding is ConsistencyFinding => finding !== null && finding.score !== null)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0) || a.cornerId - b.cornerId);

  // --- track sectors ----------------------------------------------------------
  const sectorTimeLoss: SectorLossFinding[] = [];
  if (comparable && reference !== null) {
    const referenceEntry = orderedLaps.find((entry) => entry.lap.lapNumber === reference.lapNumber);
    const sectorIndices = [
      ...new Set(
        orderedLaps.flatMap((entry) => (entry.sectorTimes ?? []).map((sector) => sector.sectorIndex)),
      ),
    ].sort((a, b) => a - b);
    for (const sectorIndex of sectorIndices) {
      const referenceMs = referenceEntry?.sectorTimes?.find(
        (sector) => sector.sectorIndex === sectorIndex,
      )?.durationMs;
      if (referenceMs === undefined || !Number.isFinite(referenceMs)) continue;
      let best: { lapNumber: number; value: number } | null = null;
      for (const entry of orderedLaps) {
        const insight = lapInsights.find((lap) => lap.lapNumber === entry.lap.lapNumber);
        if (insight === undefined || !insight.clean) continue;
        const value = entry.sectorTimes?.find(
          (sector) => sector.sectorIndex === sectorIndex,
        )?.durationMs;
        if (value === undefined || !Number.isFinite(value)) continue;
        if (best === null || value < best.value) best = { lapNumber: entry.lap.lapNumber, value };
      }
      if (best === null) continue;
      sectorTimeLoss.push({
        sectorIndex,
        referenceLapNumber: reference.lapNumber,
        referenceMs,
        bestMs: best.value,
        bestLapNumber: best.lapNumber,
        lostMs: referenceMs - best.value,
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
