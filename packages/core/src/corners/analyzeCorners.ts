import type { Corner, CornerSeverity } from '../contracts';
import { curvatureProfile, polylineLength } from '../geometry';
import type { RuntimeProfile } from '../profile';

const RAD_TO_DEG = 180 / Math.PI;
const GRAVITY_MPS2 = 9.81;
const MIN_RADIUS_M = 8;
const MAX_RADIUS_M = 2_000;

export interface CornerSeverityBand {
  minimumRadiusM: number;
  severity: CornerSeverity;
}

export interface CornerLatGBucket {
  minimumAngleDeg: number;
  latG: number;
}

export interface ObservedCornerSpeed {
  cornerId: number;
  apexSpeedKph: number;
  source: string;
}

export interface CornerAnalysisConfig {
  cornerThreshold?: number;
  curvatureWindowM?: number;
  gapToleranceM?: number;
  mergeDistanceM?: number;
  severityBands?: readonly CornerSeverityBand[];
  latGBuckets?: readonly CornerLatGBucket[];
}

export const DEFAULT_CORNER_SEVERITY_BANDS: readonly CornerSeverityBand[] = Object.freeze([
  { minimumRadiusM: 300, severity: 1 },
  { minimumRadiusM: 180, severity: 2 },
  { minimumRadiusM: 110, severity: 3 },
  { minimumRadiusM: 60, severity: 4 },
  { minimumRadiusM: 30, severity: 5 },
  { minimumRadiusM: 0, severity: 6 },
]);

/**
 * Racing-line straightening grows as corner angle shrinks, so shallow corners can
 * sustain more effective lateral acceleration. These buckets are anchored to the
 * user-supplied TMR M2 Competition onboard apex-speed observations.
 */
export const DEFAULT_CORNER_LAT_G_BUCKETS: readonly CornerLatGBucket[] = Object.freeze([
  { minimumAngleDeg: 100, latG: 1.05 },
  { minimumAngleDeg: 45, latG: 1.65 },
  { minimumAngleDeg: 0, latG: 2.0 },
]);

export const DEFAULT_CORNER_ANALYSIS_CONFIG = Object.freeze({
  cornerThreshold: 0.008,
  curvatureWindowM: 40,
  gapToleranceM: 25,
  mergeDistanceM: 30,
  severityBands: DEFAULT_CORNER_SEVERITY_BANDS,
  latGBuckets: DEFAULT_CORNER_LAT_G_BUCKETS,
});

interface CurvatureSample {
  curvatureRadPerM: number;
  distanceM: number;
}

type Run = number[];

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function forwardDistance(fromM: number, toM: number, totalLengthM: number): number {
  return modulo(toM - fromM, totalLengthM);
}

function collectRuns(active: boolean[]): Run[] {
  if (!active.some(Boolean)) return [];
  if (active.every(Boolean)) return [active.map((_, index) => index)];

  const runs: Run[] = [];
  for (let index = 0; index < active.length; index += 1) {
    const previousIndex = modulo(index - 1, active.length);
    if (active[index] !== true || active[previousIndex] === true) continue;

    const run: Run = [];
    let cursor = index;
    while (active[cursor] === true) {
      run.push(cursor);
      cursor = (cursor + 1) % active.length;
    }
    runs.push(run);
  }
  return runs;
}

function apexIndex(run: Run, samples: CurvatureSample[]): number {
  const firstIndex = run[0];
  if (firstIndex === undefined) throw new RangeError('Corner run must not be empty');
  let bestIndex = firstIndex;
  let bestMagnitude = Math.abs(samples[firstIndex]?.curvatureRadPerM ?? 0);
  for (let offset = 1; offset < run.length; offset += 1) {
    const index = run[offset];
    if (index === undefined) throw new RangeError('Corner run is sparse');
    const magnitude = Math.abs(samples[index]?.curvatureRadPerM ?? 0);
    if (magnitude > bestMagnitude) {
      bestIndex = index;
      bestMagnitude = magnitude;
    }
  }
  return bestIndex;
}

function runDirection(run: Run, samples: CurvatureSample[]): -1 | 1 {
  const curvature = samples[apexIndex(run, samples)]?.curvatureRadPerM;
  if (curvature === undefined || curvature === 0) {
    throw new RangeError('Corner apex must have non-zero curvature');
  }
  return curvature > 0 ? 1 : -1;
}

function fillGap(active: boolean[], run: Run, nextRun: Run): void {
  const endIndex = run[run.length - 1];
  const nextStartIndex = nextRun[0];
  if (endIndex === undefined || nextStartIndex === undefined) {
    throw new RangeError('Corner run must not be empty');
  }
  let cursor = (endIndex + 1) % active.length;
  while (cursor !== nextStartIndex) {
    active[cursor] = true;
    cursor = (cursor + 1) % active.length;
  }
}

function fillEligibleGaps(
  active: boolean[],
  samples: CurvatureSample[],
  totalLengthM: number,
  maximumGapM: number,
  requireSameDirection: boolean,
): void {
  if (!(maximumGapM > 0)) return;

  while (true) {
    const runs = collectRuns(active);
    if (runs.length === 0 || active.every(Boolean)) return;

    let filled = false;
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];
      const nextRun = runs[(index + 1) % runs.length];
      if (run === undefined || nextRun === undefined) throw new RangeError('Corner runs are sparse');
      const endIndex = run[run.length - 1];
      const nextStartIndex = nextRun[0];
      if (endIndex === undefined || nextStartIndex === undefined) {
        throw new RangeError('Corner run must not be empty');
      }
      const endDistanceM = samples[endIndex]?.distanceM;
      const nextStartDistanceM = samples[nextStartIndex]?.distanceM;
      if (endDistanceM === undefined || nextStartDistanceM === undefined) {
        throw new RangeError('Curvature samples are sparse');
      }
      const gapM = forwardDistance(endDistanceM, nextStartDistanceM, totalLengthM);
      if (gapM >= maximumGapM) continue;
      if (
        requireSameDirection &&
        runDirection(run, samples) !== runDirection(nextRun, samples)
      ) {
        continue;
      }
      fillGap(active, run, nextRun);
      filled = true;
      break;
    }
    if (!filled) return;
  }
}

function severityForRadius(
  radiusM: number,
  severityBands: readonly CornerSeverityBand[],
): CornerSeverity {
  for (const band of severityBands) {
    if (radiusM >= band.minimumRadiusM) return band.severity;
  }
  throw new RangeError('severityBands must cover the clamped radius range');
}

function effectiveLatG(
  totalAngleDeg: number,
  latGBuckets: readonly CornerLatGBucket[],
): number {
  for (const bucket of latGBuckets) {
    if (totalAngleDeg >= bucket.minimumAngleDeg) return bucket.latG;
  }
  throw new RangeError('latGBuckets must cover nonnegative corner angles');
}

function validateConfig(config: Required<CornerAnalysisConfig>): void {
  const positiveValues = [
    config.cornerThreshold,
    config.curvatureWindowM,
  ];
  if (positiveValues.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError('cornerThreshold and curvatureWindowM must be positive and finite');
  }
  if (
    !Number.isFinite(config.gapToleranceM) ||
    config.gapToleranceM < 0 ||
    !Number.isFinite(config.mergeDistanceM) ||
    config.mergeDistanceM < 0
  ) {
    throw new RangeError('gapToleranceM and mergeDistanceM must be nonnegative and finite');
  }
  if (config.severityBands.length === 0) throw new RangeError('severityBands must not be empty');
  let previousMinimum = Number.POSITIVE_INFINITY;
  for (const band of config.severityBands) {
    if (
      !Number.isFinite(band.minimumRadiusM) ||
      band.minimumRadiusM < 0 ||
      band.minimumRadiusM > previousMinimum ||
      !Number.isInteger(band.severity) ||
      band.severity < 1 ||
      band.severity > 6
    ) {
      throw new RangeError('severityBands must be finite and ordered by descending minimumRadiusM');
    }
    previousMinimum = band.minimumRadiusM;
  }
  severityForRadius(MIN_RADIUS_M, config.severityBands);

  if (config.latGBuckets.length === 0) throw new RangeError('latGBuckets must not be empty');
  let previousAngle = Number.POSITIVE_INFINITY;
  for (const bucket of config.latGBuckets) {
    if (
      !Number.isFinite(bucket.minimumAngleDeg) ||
      bucket.minimumAngleDeg < 0 ||
      bucket.minimumAngleDeg > previousAngle ||
      !Number.isFinite(bucket.latG) ||
      bucket.latG <= 0
    ) {
      throw new RangeError(
        'latGBuckets must have positive finite latG values and descending nonnegative angles',
      );
    }
    previousAngle = bucket.minimumAngleDeg;
  }
  effectiveLatG(0, config.latGBuckets);
}

function rebaseSamples(runtime: RuntimeProfile, curvatures: number[], totalLengthM: number): CurvatureSample[] {
  const startFinishM = modulo(runtime.startFinishGate.distanceM, totalLengthM);
  const toleranceM = Number.EPSILON * 128 * Math.max(1, totalLengthM);
  return runtime.cumulativeDistancesM
    .map((sourceDistanceM, index) => {
      let distanceM = modulo(sourceDistanceM - startFinishM, totalLengthM);
      if (distanceM < toleranceM || totalLengthM - distanceM < toleranceM) distanceM = 0;
      const curvatureRadPerM = curvatures[index];
      if (curvatureRadPerM === undefined) throw new RangeError('Curvature profile is sparse');
      return { curvatureRadPerM, distanceM };
    })
    .sort((a, b) => a.distanceM - b.distanceM);
}

/** Analyze a validated runtime profile into deterministic, S/F-relative corners. */
export function analyzeCorners(runtime: RuntimeProfile, config: CornerAnalysisConfig = {}): Corner[] {
  const resolved: Required<CornerAnalysisConfig> = {
    ...DEFAULT_CORNER_ANALYSIS_CONFIG,
    ...config,
    severityBands: config.severityBands ?? DEFAULT_CORNER_SEVERITY_BANDS,
    latGBuckets: config.latGBuckets ?? DEFAULT_CORNER_LAT_G_BUCKETS,
  };
  validateConfig(resolved);

  const totalLengthM = polylineLength(runtime.centerline);
  if (!(totalLengthM > 0)) throw new RangeError('Runtime profile centerline must have positive length');
  const curvatures = curvatureProfile(
    runtime.centerline,
    runtime.cumulativeDistancesM,
    true,
    resolved.curvatureWindowM,
  );
  const samples = rebaseSamples(runtime, curvatures, totalLengthM);
  const active = samples.map(
    (sample) => Math.abs(sample.curvatureRadPerM) >= resolved.cornerThreshold,
  );

  fillEligibleGaps(active, samples, totalLengthM, resolved.gapToleranceM, false);
  fillEligibleGaps(active, samples, totalLengthM, resolved.mergeDistanceM, true);

  return collectRuns(active).map((run, index): Corner => {
    const entryIndex = run[0];
    const exitIndex = run[run.length - 1];
    const apexSampleIndex = apexIndex(run, samples);
    if (entryIndex === undefined || exitIndex === undefined) throw new RangeError('Corner run is empty');
    const entry = samples[entryIndex];
    const exit = samples[exitIndex];
    const apex = samples[apexSampleIndex];
    if (entry === undefined || exit === undefined || apex === undefined) {
      throw new RangeError('Curvature samples are sparse');
    }

    let totalAngleRad = 0;
    for (let sampleIndex = 1; sampleIndex < run.length; sampleIndex += 1) {
      const previous = samples[run[sampleIndex - 1] ?? -1];
      const current = samples[run[sampleIndex] ?? -1];
      if (previous === undefined || current === undefined) throw new RangeError('Corner run is sparse');
      const segmentLengthM = forwardDistance(previous.distanceM, current.distanceM, totalLengthM);
      totalAngleRad +=
        ((Math.abs(previous.curvatureRadPerM) + Math.abs(current.curvatureRadPerM)) / 2) *
        segmentLengthM;
    }

    const maximumCurvature = Math.abs(apex.curvatureRadPerM);
    const minRadiusM = Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, 1 / maximumCurvature));
    const totalAngleDeg = totalAngleRad * RAD_TO_DEG;
    const advisoryMps = Math.sqrt(
      effectiveLatG(totalAngleDeg, resolved.latGBuckets) * GRAVITY_MPS2 * minRadiusM,
    );
    return {
      id: index + 1,
      entryDistanceM: entry.distanceM,
      apexDistanceM: apex.distanceM,
      exitDistanceM: exit.distanceM,
      lengthM: forwardDistance(entry.distanceM, exit.distanceM, totalLengthM),
      minRadiusM,
      totalAngleDeg,
      direction: apex.curvatureRadPerM > 0 ? 'left' : 'right',
      severity: severityForRadius(minRadiusM, resolved.severityBands),
      advisorySpeedKph: Math.round((advisoryMps * 3.6) / 5) * 5,
      speedSource: 'model',
    };
  });
}
