import type {
  CircuitProfile,
  LapRecord,
  QualityAssessment,
  QualityLevel,
  ReferenceLap,
} from '../contracts';

export type ReferenceTelemetrySample = {
  tMono: number;
  quality: QualityAssessment | QualityLevel;
} & (
  | { unwrappedProgressM: number; distanceM?: number }
  | { distanceM: number; unwrappedProgressM?: number }
);

export interface ReferenceLapProvenance {
  userId: string;
  recordedAtUtc: string;
  sessionId: string;
  appVersion: string;
  algorithmVersion: number;
  device?: string;
}

interface BuildReferenceLapBase extends ReferenceLapProvenance {
  lap: LapRecord;
  profile: Pick<
    CircuitProfile,
    'circuitId' | 'layoutId' | 'layoutVersion' | 'schemaVersion' | 'totalLengthM'
  >;
  gridStepM?: number;
}

export type BuildReferenceLapInput = BuildReferenceLapBase &
  (
    | { telemetry: readonly ReferenceTelemetrySample[]; matches?: never; matchedTelemetry?: never }
    | { matches: readonly ReferenceTelemetrySample[]; telemetry?: never; matchedTelemetry?: never }
    | { matchedTelemetry: readonly ReferenceTelemetrySample[]; telemetry?: never; matches?: never }
  );

export type ReferenceLapBuildError =
  | 'INVALID_SOURCE_LAP'
  | 'INVALID_TOTAL_LENGTH'
  | 'INVALID_GRID_STEP'
  | 'INVALID_PROVENANCE'
  | 'INSUFFICIENT_TELEMETRY'
  | 'INSUFFICIENT_COVERAGE';

export type BuildReferenceLapResult =
  | { ok: true; reference: ReferenceLap; value: ReferenceLap }
  | { ok: false; error: ReferenceLapBuildError; errors: ReferenceLapBuildError[] };

interface ProgressPoint {
  distanceM: number;
  elapsedMs: number;
}

const QUALITY_RANK: Record<QualityLevel, number> = {
  good: 0,
  degraded: 1,
  unreliable: 2,
  invalid: 3,
};

function failure(error: ReferenceLapBuildError): BuildReferenceLapResult {
  return { ok: false, error, errors: [error] };
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function qualityAssessment(quality: QualityAssessment | QualityLevel): QualityAssessment {
  return typeof quality === 'string' ? { level: quality, reasons: [] } : quality;
}

function telemetryOf(input: BuildReferenceLapInput): readonly ReferenceTelemetrySample[] {
  if (input.telemetry !== undefined) return input.telemetry;
  if (input.matches !== undefined) return input.matches;
  return input.matchedTelemetry;
}

function gridFor(totalLengthM: number, stepM: number): number[] {
  const grid: number[] = [];
  for (let distanceM = 0; distanceM < totalLengthM; distanceM += stepM) {
    grid.push(distanceM);
  }
  grid.push(totalLengthM);
  return grid;
}

function interpolationPoints(
  samples: readonly ReferenceTelemetrySample[],
  lap: LapRecord,
  totalLengthM: number,
): ProgressPoint[] {
  const ordered = samples
    .filter(
      (sample) =>
        Number.isFinite(sample.tMono) &&
        sample.tMono >= lap.tStart &&
        sample.tMono <= lap.tEnd,
    )
    .sort((a, b) => a.tMono - b.tMono);

  const firstUnwrapped = ordered.find((sample) => sample.unwrappedProgressM !== undefined)
    ?.unwrappedProgressM;
  const unwrappedLapBase =
    firstUnwrapped === undefined
      ? 0
      : Math.floor(firstUnwrapped / totalLengthM + 1e-9) * totalLengthM;

  const points: ProgressPoint[] = [];
  let monotoneDistanceM = 0;
  for (const sample of ordered) {
    const rawDistanceM =
      sample.distanceM !== undefined
        ? sample.distanceM
        : (sample.unwrappedProgressM as number) - unwrappedLapBase;
    if (!Number.isFinite(rawDistanceM)) continue;

    const endpointToleranceM = Math.max(1e-6, totalLengthM * 1e-9);
    const boundedDistanceM =
      Math.abs(rawDistanceM - totalLengthM) <= endpointToleranceM
        ? totalLengthM
        : Math.abs(rawDistanceM) <= endpointToleranceM
          ? 0
          : Math.max(0, Math.min(totalLengthM, rawDistanceM));
    monotoneDistanceM = Math.max(monotoneDistanceM, boundedDistanceM);
    const elapsedMs = Math.max(0, Math.min(lap.durationMs, sample.tMono - lap.tStart));
    const previous = points[points.length - 1];
    if (previous !== undefined && monotoneDistanceM === previous.distanceM) {
      previous.elapsedMs = Math.max(previous.elapsedMs, elapsedMs);
    } else {
      points.push({ distanceM: monotoneDistanceM, elapsedMs });
    }
  }
  return points;
}

function interpolate(points: readonly ProgressPoint[], distanceM: number): number {
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const point = points[middle];
    if (point === undefined) break;
    if (point.distanceM < distanceM) low = middle + 1;
    else if (point.distanceM > distanceM) high = middle - 1;
    else return point.elapsedMs;
  }

  const before = points[Math.max(0, high)];
  const after = points[Math.min(points.length - 1, low)];
  if (before === undefined || after === undefined) return 0;
  if (before.distanceM === after.distanceM) return Math.max(before.elapsedMs, after.elapsedMs);
  const fraction = (distanceM - before.distanceM) / (after.distanceM - before.distanceM);
  return before.elapsedMs + fraction * (after.elapsedMs - before.elapsedMs);
}

function qualitySummary(
  lapQuality: QualityLevel,
  samples: readonly ReferenceTelemetrySample[],
): QualityAssessment {
  let level = lapQuality;
  const reasons = new Set<string>();
  for (const sample of samples) {
    const assessment = qualityAssessment(sample.quality);
    if (QUALITY_RANK[assessment.level] > QUALITY_RANK[level]) level = assessment.level;
    for (const reason of assessment.reasons) reasons.add(reason);
  }
  return { level, reasons: [...reasons] };
}

export function buildReferenceLap(input: BuildReferenceLapInput): BuildReferenceLapResult {
  const { lap, profile } = input;
  if (
    !lap.valid ||
    !Number.isFinite(lap.tStart) ||
    !Number.isFinite(lap.tEnd) ||
    !Number.isFinite(lap.durationMs) ||
    lap.durationMs <= 0 ||
    lap.tEnd <= lap.tStart
  ) {
    return failure('INVALID_SOURCE_LAP');
  }
  if (!Number.isFinite(profile.totalLengthM) || profile.totalLengthM <= 0) {
    return failure('INVALID_TOTAL_LENGTH');
  }

  const gridStepM = input.gridStepM ?? 10;
  if (!Number.isFinite(gridStepM) || gridStepM <= 0) return failure('INVALID_GRID_STEP');
  if (
    !isNonEmpty(profile.circuitId) ||
    !isNonEmpty(profile.layoutId) ||
    !isNonEmpty(input.userId) ||
    !isNonEmpty(input.recordedAtUtc) ||
    !isNonEmpty(input.sessionId) ||
    !isNonEmpty(input.appVersion) ||
    !Number.isFinite(input.algorithmVersion) ||
    input.algorithmVersion < 0 ||
    !Number.isFinite(profile.schemaVersion) ||
    profile.schemaVersion < 0
  ) {
    return failure('INVALID_PROVENANCE');
  }

  const telemetry = telemetryOf(input);
  const points = interpolationPoints(telemetry, lap, profile.totalLengthM);
  if (points.length < 2) return failure('INSUFFICIENT_TELEMETRY');

  const grid = gridFor(profile.totalLengthM, gridStepM);
  const firstDistanceM = points[0]?.distanceM ?? profile.totalLengthM;
  const lastDistanceM = points[points.length - 1]?.distanceM ?? 0;
  const coveredGridPoints = grid.filter(
    (distanceM) => distanceM >= firstDistanceM && distanceM <= lastDistanceM,
  ).length;
  if (coveredGridPoints / grid.length < 0.95) return failure('INSUFFICIENT_COVERAGE');

  const anchoredPoints: ProgressPoint[] = [...points];
  if ((anchoredPoints[0]?.distanceM ?? 0) > 0) {
    anchoredPoints.unshift({ distanceM: 0, elapsedMs: 0 });
  } else if (anchoredPoints[0] !== undefined) {
    anchoredPoints[0].elapsedMs = 0;
  }
  const lastPoint = anchoredPoints[anchoredPoints.length - 1];
  if (lastPoint !== undefined && lastPoint.distanceM < profile.totalLengthM) {
    anchoredPoints.push({ distanceM: profile.totalLengthM, elapsedMs: lap.durationMs });
  } else if (lastPoint !== undefined) {
    lastPoint.elapsedMs = lap.durationMs;
  }

  const elapsedMsAtGrid: number[] = [];
  let previousElapsedMs = 0;
  for (const distanceM of grid) {
    const elapsedMs = Math.max(previousElapsedMs, interpolate(anchoredPoints, distanceM));
    elapsedMsAtGrid.push(elapsedMs);
    previousElapsedMs = elapsedMs;
  }
  elapsedMsAtGrid[0] = 0;
  elapsedMsAtGrid[elapsedMsAtGrid.length - 1] = lap.durationMs;

  const reference: ReferenceLap = {
    circuitId: profile.circuitId,
    layoutId: profile.layoutId,
    layoutVersion: profile.layoutVersion,
    userId: input.userId,
    durationMs: lap.durationMs,
    sectorTimes: lap.sectorTimes.map((sector) => ({ ...sector })),
    recordedAtUtc: input.recordedAtUtc,
    sessionId: input.sessionId,
    lapNumber: lap.lapNumber,
    distanceGridM: grid,
    elapsedMsAtGrid,
    gnssQualitySummary: qualitySummary(lap.quality, telemetry),
    appVersion: input.appVersion,
    algorithmVersion: input.algorithmVersion,
    profileSchemaVersion: profile.schemaVersion,
    ...(input.device === undefined ? {} : { device: input.device }),
  };
  return { ok: true, reference, value: reference };
}
