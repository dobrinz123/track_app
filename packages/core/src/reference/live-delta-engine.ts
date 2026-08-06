import type {
  DeltaUpdate,
  LiveDeltaEngine as LiveDeltaEngineContract,
  ReferenceLap,
  TrackMatch,
} from '../contracts';

export interface LiveDeltaEngineConfig {
  alpha?: number;
  smoothingAlpha?: number;
  confidenceThreshold?: number;
  deadbandMs?: number;
  sparseGapMs?: number;
  staleGapMs?: number;
  regressionConfidenceFactor?: number;
}

const DEFAULT_ALPHA = 0.3;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.4;
const DEFAULT_DEADBAND_MS = 50;
const DEFAULT_SPARSE_GAP_MS = 3_000;
const DEFAULT_STALE_GAP_MS = 5_000;
const DEFAULT_REGRESSION_CONFIDENCE_FACTOR = 0.5;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function bounded(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
  return resolved;
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return resolved;
}

function cloneReference(reference: ReferenceLap): ReferenceLap {
  return {
    ...reference,
    sectorTimes: reference.sectorTimes.map((sector) => ({ ...sector })),
    distanceGridM: [...reference.distanceGridM],
    elapsedMsAtGrid: [...reference.elapsedMsAtGrid],
    gnssQualitySummary: {
      ...reference.gnssQualitySummary,
      reasons: [...reference.gnssQualitySummary.reasons],
    },
  };
}

export function referenceCompleteness(reference: ReferenceLap): number {
  const { distanceGridM, elapsedMsAtGrid } = reference;
  if (
    distanceGridM.length < 2 ||
    distanceGridM.length !== elapsedMsAtGrid.length ||
    !Number.isFinite(reference.durationMs) ||
    reference.durationMs <= 0
  ) {
    return 0;
  }
  for (let index = 0; index < distanceGridM.length; index += 1) {
    const distanceM = distanceGridM[index];
    const elapsedMs = elapsedMsAtGrid[index];
    if (
      distanceM === undefined ||
      elapsedMs === undefined ||
      !Number.isFinite(distanceM) ||
      !Number.isFinite(elapsedMs)
    ) {
      return 0;
    }
    if (index > 0) {
      const previousDistanceM = distanceGridM[index - 1];
      const previousElapsedMs = elapsedMsAtGrid[index - 1];
      if (
        previousDistanceM === undefined ||
        previousElapsedMs === undefined ||
        distanceM <= previousDistanceM ||
        elapsedMs < previousElapsedMs
      ) {
        return 0;
      }
    }
  }
  const firstDistanceM = distanceGridM[0] ?? 0;
  const totalLengthM = distanceGridM[distanceGridM.length - 1] ?? 0;
  const firstElapsedMs = elapsedMsAtGrid[0] ?? 0;
  const lastElapsedMs = elapsedMsAtGrid[elapsedMsAtGrid.length - 1] ?? 0;
  if (totalLengthM <= 0) return 0;
  const spatialCoverage = clamp01((totalLengthM - Math.max(0, firstDistanceM)) / totalLengthM);
  const temporalCoverage = clamp01((lastElapsedMs - Math.max(0, firstElapsedMs)) / reference.durationMs);
  return Math.min(spatialCoverage, temporalCoverage);
}

export function referenceElapsedAt(reference: ReferenceLap, distanceM: number): number {
  const grid = reference.distanceGridM;
  const elapsed = reference.elapsedMsAtGrid;
  const totalLengthM = grid[grid.length - 1] ?? 0;
  if (referenceCompleteness(reference) === 0 || totalLengthM <= 0) return 0;

  const endpointTolerance = Math.max(1, totalLengthM) * Number.EPSILON * 8;
  let normalizedDistanceM: number;
  if (distanceM > 0 && Math.abs(distanceM - totalLengthM) <= endpointTolerance) {
    normalizedDistanceM = totalLengthM;
  } else {
    normalizedDistanceM = ((distanceM % totalLengthM) + totalLengthM) % totalLengthM;
  }

  let low = 0;
  let high = grid.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const gridDistanceM = grid[middle];
    if (gridDistanceM === undefined) break;
    if (gridDistanceM < normalizedDistanceM) low = middle + 1;
    else if (gridDistanceM > normalizedDistanceM) high = middle - 1;
    else return elapsed[middle] ?? 0;
  }
  const beforeIndex = Math.max(0, high);
  const afterIndex = Math.min(grid.length - 1, low);
  const beforeDistanceM = grid[beforeIndex] ?? 0;
  const afterDistanceM = grid[afterIndex] ?? beforeDistanceM;
  const beforeElapsedMs = elapsed[beforeIndex] ?? 0;
  const afterElapsedMs = elapsed[afterIndex] ?? beforeElapsedMs;
  if (afterDistanceM === beforeDistanceM) return beforeElapsedMs;
  const fraction = (normalizedDistanceM - beforeDistanceM) / (afterDistanceM - beforeDistanceM);
  return beforeElapsedMs + fraction * (afterElapsedMs - beforeElapsedMs);
}

export class LiveDeltaEngine implements LiveDeltaEngineContract {
  private readonly alpha: number;
  private readonly confidenceThreshold: number;
  private readonly deadbandMs: number;
  private readonly sparseGapMs: number;
  private readonly staleGapMs: number;
  private readonly regressionConfidenceFactor: number;
  private reference: ReferenceLap | null = null;
  private completeness = 0;
  private displayedDeltaMs: number | undefined;
  private rawDeltaMs: number | undefined;
  private lastTMono: number | undefined;
  private lastUnwrappedProgressM: number | undefined;

  constructor(config: LiveDeltaEngineConfig = {}) {
    this.alpha = bounded(config.alpha ?? config.smoothingAlpha, DEFAULT_ALPHA, 'alpha');
    this.confidenceThreshold = bounded(
      config.confidenceThreshold,
      DEFAULT_CONFIDENCE_THRESHOLD,
      'confidenceThreshold',
    );
    this.deadbandMs = nonNegative(config.deadbandMs, DEFAULT_DEADBAND_MS, 'deadbandMs');
    this.sparseGapMs = nonNegative(config.sparseGapMs, DEFAULT_SPARSE_GAP_MS, 'sparseGapMs');
    this.staleGapMs = nonNegative(config.staleGapMs, DEFAULT_STALE_GAP_MS, 'staleGapMs');
    this.regressionConfidenceFactor = bounded(
      config.regressionConfidenceFactor,
      DEFAULT_REGRESSION_CONFIDENCE_FACTOR,
      'regressionConfidenceFactor',
    );
    if (this.staleGapMs < this.sparseGapMs) {
      throw new RangeError('staleGapMs must be greater than or equal to sparseGapMs');
    }
  }

  setReference(reference: ReferenceLap | null): void {
    const completeness = reference === null ? 0 : referenceCompleteness(reference);
    this.reference = reference === null || completeness === 0 ? null : cloneReference(reference);
    this.completeness = this.reference === null ? 0 : completeness;
    this.clearLiveState();
  }

  reset(): void {
    this.clearLiveState();
  }

  onMatch(match: TrackMatch, lapElapsedMs: number): DeltaUpdate {
    if (this.reference === null) return { deltaMs: 0, confidence: 0, display: 'neutral' };

    const gapMs =
      this.lastTMono === undefined ? 0 : Math.max(0, match.tMono - this.lastTMono);
    const regressed =
      this.lastUnwrappedProgressM !== undefined &&
      match.unwrappedProgressM < this.lastUnwrappedProgressM;
    let confidence = Math.min(clamp01(match.confidence), this.completeness);

    if (gapMs > this.sparseGapMs) {
      const decayRangeMs = Math.max(1, this.staleGapMs - this.sparseGapMs);
      confidence *= clamp01(1 - (gapMs - this.sparseGapMs) / decayRangeMs);
    }
    if (regressed) confidence *= this.regressionConfidenceFactor;

    if (!regressed) {
      const rawDeltaMs =
        Math.max(0, lapElapsedMs) - referenceElapsedAt(this.reference, match.distanceM);
      this.rawDeltaMs = rawDeltaMs;
      this.displayedDeltaMs =
        this.displayedDeltaMs === undefined
          ? rawDeltaMs
          : this.displayedDeltaMs + this.alpha * (rawDeltaMs - this.displayedDeltaMs);
      this.lastUnwrappedProgressM = match.unwrappedProgressM;
    }
    this.lastTMono = match.tMono;

    const deltaMs = this.displayedDeltaMs ?? 0;
    const stale = gapMs > this.staleGapMs;
    const qualityOk = match.quality.level === 'good' || match.quality.level === 'degraded';
    const display =
      stale || confidence < this.confidenceThreshold || !qualityOk
        ? 'neutral'
        : deltaMs < -this.deadbandMs
          ? 'faster'
          : deltaMs > this.deadbandMs
            ? 'slower'
            : 'neutral';
    const rawDeltaMs = this.rawDeltaMs;
    return {
      deltaMs,
      confidence,
      display,
      ...(confidence >= 0.6 && rawDeltaMs !== undefined
        ? { estimatedLapMs: this.reference.durationMs + rawDeltaMs }
        : {}),
    };
  }

  private clearLiveState(): void {
    this.displayedDeltaMs = undefined;
    this.rawDeltaMs = undefined;
    this.lastTMono = undefined;
    this.lastUnwrappedProgressM = undefined;
  }
}
