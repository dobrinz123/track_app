import type { Corner, LocationSample } from '../contracts';
import { projectOntoPolyline } from '../geometry';
import type { RuntimeProfile } from '../profile';

export interface ValidationTrace {
  driverId: string;
  cleanLapCount: number;
  samples: readonly LocationSample[];
}

export interface GeometryValidationConfig {
  onTrackLateralM: number;
  excludeBeyondM: number;
  maxAccuracyM: number;
  minDrivers: number;
  minCleanLaps: number;
  minSamplesPerCorner: number;
  maxOutsideFraction: number;
  maxCornerOutsideFraction: number;
}

export const DEFAULT_GEOMETRY_VALIDATION_CONFIG = Object.freeze({
  maxAccuracyM: 10,
  minDrivers: 3,
  minCleanLaps: 20,
  minSamplesPerCorner: 10,
  maxOutsideFraction: 0.05,
  maxCornerOutsideFraction: 0.1,
});

export interface DeviationStats {
  sampleCount: number;
  medianSignedLateralM: number;
  medianAbsLateralM: number;
  p95AbsLateralM: number;
  outsideFraction: number;
}

export interface CornerDeviation extends DeviationStats {
  cornerId: number;
  driverCount: number;
}

export type GeometryValidationVerdict =
  'community-verified-candidate' | 'insufficient-evidence' | 'geometry-mismatch';

export interface GeometryValidationReport {
  verdict: GeometryValidationVerdict;
  reasons: string[];
  driverCount: number;
  cleanLapCount: number;
  usedSampleCount: number;
  rejectedForAccuracy: number;
  rejectedBeyondCorridor: number;
  overall: DeviationStats;
  corners: CornerDeviation[];
}

interface ProjectedSample {
  driverId: string;
  distanceM: number;
  lateralM: number;
}

type ConfigInput = Pick<GeometryValidationConfig, 'onTrackLateralM'> &
  Partial<Omit<GeometryValidationConfig, 'onTrackLateralM'>>;

function resolveConfig(input: ConfigInput): GeometryValidationConfig {
  const config: GeometryValidationConfig = {
    ...DEFAULT_GEOMETRY_VALIDATION_CONFIG,
    excludeBeyondM: input.onTrackLateralM * 3,
    ...input,
  };
  const positive: Array<keyof GeometryValidationConfig> = [
    'onTrackLateralM',
    'excludeBeyondM',
    'maxAccuracyM',
  ];
  for (const key of positive) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) {
      throw new RangeError(`${key} must be a positive finite number`);
    }
  }
  if (config.excludeBeyondM < config.onTrackLateralM) {
    throw new RangeError('excludeBeyondM must be at least onTrackLateralM');
  }
  const counts: Array<keyof GeometryValidationConfig> = [
    'minDrivers',
    'minCleanLaps',
    'minSamplesPerCorner',
  ];
  for (const key of counts) {
    if (!Number.isInteger(config[key]) || config[key] < 1) {
      throw new RangeError(`${key} must be a positive integer`);
    }
  }
  const fractions: Array<keyof GeometryValidationConfig> = [
    'maxOutsideFraction',
    'maxCornerOutsideFraction',
  ];
  for (const key of fractions) {
    if (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > 1) {
      throw new RangeError(`${key} must be between 0 and 1`);
    }
  }
  return config;
}

function validateTraces(traces: readonly ValidationTrace[]): void {
  traces.forEach((trace, index) => {
    if (typeof trace.driverId !== 'string' || trace.driverId.trim() === '') {
      throw new RangeError(`traces[${index}].driverId must be a non-empty string`);
    }
    if (!Number.isInteger(trace.cleanLapCount) || trace.cleanLapCount < 0) {
      throw new RangeError(`traces[${index}].cleanLapCount must be a nonnegative integer`);
    }
  });
}

function percentileOfSorted(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const position = (sortedAsc.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sortedAsc[lower] ?? 0;
  const upperValue = sortedAsc[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function statsOf(samples: readonly ProjectedSample[], onTrackLateralM: number): DeviationStats {
  const signed = samples.map((sample) => sample.lateralM).sort((a, b) => a - b);
  const absolute = samples.map((sample) => Math.abs(sample.lateralM)).sort((a, b) => a - b);
  const outside = absolute.filter((value) => value > onTrackLateralM).length;
  return {
    sampleCount: samples.length,
    medianSignedLateralM: percentileOfSorted(signed, 0.5),
    medianAbsLateralM: percentileOfSorted(absolute, 0.5),
    p95AbsLateralM: percentileOfSorted(absolute, 0.95),
    outsideFraction: samples.length === 0 ? 0 : outside / samples.length,
  };
}

function isInsideCorner(distanceM: number, corner: Corner): boolean {
  if (corner.entryDistanceM <= corner.exitDistanceM) {
    return distanceM >= corner.entryDistanceM && distanceM <= corner.exitDistanceM;
  }
  return distanceM >= corner.entryDistanceM || distanceM <= corner.exitDistanceM;
}

function projectTraces(
  runtime: RuntimeProfile,
  traces: readonly ValidationTrace[],
  config: GeometryValidationConfig,
): { used: ProjectedSample[]; rejectedForAccuracy: number; rejectedBeyondCorridor: number } {
  const used: ProjectedSample[] = [];
  let rejectedForAccuracy = 0;
  let rejectedBeyondCorridor = 0;
  for (const trace of traces) {
    for (const sample of trace.samples) {
      if (sample.accuracyM === undefined || sample.accuracyM > config.maxAccuracyM) {
        rejectedForAccuracy += 1;
        continue;
      }
      const projected = projectOntoPolyline(
        runtime.projection.toLocal(sample),
        runtime.centerline,
        runtime.cumulativeDistancesM,
        true,
      );
      if (Math.abs(projected.lateralM) > config.excludeBeyondM) {
        rejectedBeyondCorridor += 1;
        continue;
      }
      used.push({
        driverId: trace.driverId,
        distanceM: projected.distanceM,
        lateralM: projected.lateralM,
      });
    }
  }
  return { used, rejectedForAccuracy, rejectedBeyondCorridor };
}

function cornerDeviations(
  corners: readonly Corner[],
  used: readonly ProjectedSample[],
  onTrackLateralM: number,
): CornerDeviation[] {
  return corners.map((corner) => {
    const inside = used.filter((sample) => isInsideCorner(sample.distanceM, corner));
    return {
      cornerId: corner.id,
      driverCount: new Set(inside.map((sample) => sample.driverId)).size,
      ...statsOf(inside, onTrackLateralM),
    };
  });
}

function evidenceReasons(
  driverCount: number,
  cleanLapCount: number,
  usedSampleCount: number,
  corners: readonly CornerDeviation[],
  config: GeometryValidationConfig,
): string[] {
  const reasons: string[] = [];
  if (usedSampleCount === 0) reasons.push('NO_USABLE_SAMPLES');
  if (driverCount < config.minDrivers) reasons.push('DRIVERS_BELOW_MIN');
  if (cleanLapCount < config.minCleanLaps) reasons.push('CLEAN_LAPS_BELOW_MIN');
  for (const corner of corners) {
    if (corner.sampleCount < config.minSamplesPerCorner) {
      reasons.push(`CORNER_${corner.cornerId}_SAMPLES_BELOW_MIN`);
    }
  }
  return reasons;
}

function mismatchReasons(
  overall: DeviationStats,
  corners: readonly CornerDeviation[],
  config: GeometryValidationConfig,
): string[] {
  const reasons: string[] = [];
  if (overall.sampleCount > 0 && overall.outsideFraction > config.maxOutsideFraction) {
    reasons.push('OVERALL_OUTSIDE_FRACTION_ABOVE_MAX');
  }
  for (const corner of corners) {
    if (
      corner.sampleCount >= config.minSamplesPerCorner &&
      corner.outsideFraction > config.maxCornerOutsideFraction
    ) {
      reasons.push(`CORNER_${corner.cornerId}_OUTSIDE_FRACTION_ABOVE_MAX`);
    }
  }
  return reasons;
}

export function assessGeometryDeviation(
  runtime: RuntimeProfile,
  corners: readonly Corner[],
  traces: readonly ValidationTrace[],
  configInput: ConfigInput,
): GeometryValidationReport {
  const config = resolveConfig(configInput);
  validateTraces(traces);

  const { used, rejectedForAccuracy, rejectedBeyondCorridor } = projectTraces(
    runtime,
    traces,
    config,
  );
  const overall = statsOf(used, config.onTrackLateralM);
  const perCorner = cornerDeviations(corners, used, config.onTrackLateralM);
  const driverCount = new Set(used.map((sample) => sample.driverId)).size;
  const cleanLapCount = traces.reduce((total, trace) => total + trace.cleanLapCount, 0);

  const mismatch = mismatchReasons(overall, perCorner, config);
  const evidence = evidenceReasons(driverCount, cleanLapCount, used.length, perCorner, config);
  const verdict: GeometryValidationVerdict =
    mismatch.length > 0
      ? 'geometry-mismatch'
      : evidence.length > 0
        ? 'insufficient-evidence'
        : 'community-verified-candidate';

  return {
    verdict,
    reasons: [...mismatch, ...evidence],
    driverCount,
    cleanLapCount,
    usedSampleCount: used.length,
    rejectedForAccuracy,
    rejectedBeyondCorridor,
    overall,
    corners: perCorner,
  };
}
