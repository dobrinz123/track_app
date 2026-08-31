import type { Corner, CornerSeverity, LocationSample } from '../contracts';
import {
  DEFAULT_CORNER_LAT_G_BUCKETS,
  DEFAULT_CORNER_SEVERITY_BANDS,
  analyzeCorners,
  type CornerLatGBucket,
  type CornerSeverityBand,
} from '../corners';
import { GRAVITY_MPS2 } from '../coaching/types';
import { curvatureProfile, polylineLength, projectOntoPolyline } from '../geometry';
import type { RuntimeProfile } from '../profile';

import { resolveTestLoopConfig, type TestLoopConfigOverrides } from './config';

/**
 * Ticket P5d T1(c) -- synthetic corners for a learned loop.
 *
 * Two independent witnesses, merged:
 *  1. GEOMETRY: `analyzeCorners` (the same deterministic curvature pass every
 *     bundled circuit's corner set comes from) run over the learned centreline.
 *  2. THE DRIVER: the speed the car actually carried through lap 1, reduced to
 *     "speed-drop windows" -- the same idea `cornerMetrics` uses to size a
 *     corner's approach and exit from its speed drop, applied here to FIND the
 *     corners rather than to measure them.
 *
 * Why both: on a 30 km/h street loop a junction can be tighter than any
 * curvature threshold tuned for a circuit will admit once a phone's fixes have
 * been smoothed, and a long constant-radius sweeper can carry no speed drop at
 * all. A corner that only one witness saw is still a corner; a corner both saw
 * gets the driver's own minimum speed as its advisory number, never a model
 * number above what the car was seen doing.
 */

const RAD_TO_DEG = 180 / Math.PI;
const MIN_RADIUS_M = 8;
const MAX_RADIUS_M = 2_000;
/** How far outside a corner's own span a speed minimum may sit and still be ITS minimum, metres. */
const SPEED_MATCH_SLACK_M = 25;
/** Minima closer together than this are one slow-down, metres. */
const MINIMUM_MERGE_M = 30;
/** How far back/forward a slow-down is traced for the speed it came from and returned to, metres. */
const DROP_SEARCH_M = 250;

export interface SpeedDropWindow {
  /** Where the car came off the pace, metres from S/F. */
  startM: number;
  /** Where it was slowest, metres from S/F. */
  minimumM: number;
  /** Where it was back on the pace, metres from S/F. */
  endM: number;
  approachSpeedKph: number;
  minimumSpeedKph: number;
}

export interface TestLoopCornerDerivation {
  corners: Corner[];
  speedDropWindows: SpeedDropWindow[];
  /** How many corners the curvature pass alone proposed. */
  curvatureCandidates: number;
  /** ...how many of those the driver's speed trace agreed with. */
  confirmedBySpeedDrop: number;
  /** ...and how many corners exist ONLY because the driver braked for them. */
  addedFromSpeedDrop: number;
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function forwardDistance(fromM: number, toM: number, totalLengthM: number): number {
  return modulo(toM - fromM, totalLengthM);
}

/** True when `pointM` lies on the forward arc from `startM` to `endM`. */
function withinArc(pointM: number, startM: number, endM: number, totalLengthM: number): boolean {
  const span = forwardDistance(startM, endM, totalLengthM);
  return forwardDistance(startM, pointM, totalLengthM) <= span;
}

function severityForRadius(
  radiusM: number,
  bands: readonly CornerSeverityBand[] = DEFAULT_CORNER_SEVERITY_BANDS,
): CornerSeverity {
  for (const band of bands) {
    if (radiusM >= band.minimumRadiusM) return band.severity;
  }
  return 6;
}

function effectiveLatG(
  totalAngleDeg: number,
  buckets: readonly CornerLatGBucket[] = DEFAULT_CORNER_LAT_G_BUCKETS,
): number {
  for (const bucket of buckets) {
    if (totalAngleDeg >= bucket.minimumAngleDeg) return bucket.latG;
  }
  return 1;
}

/** A corner minus its id -- ids are assigned once, at the end, in travel order. */
function withoutId(corner: Corner): Omit<Corner, 'id'> {
  const copy: Partial<Corner> = { ...corner };
  delete copy.id;
  return copy as Omit<Corner, 'id'>;
}

/** Advisory speeds are quoted in 5 km/h steps -- DOWN, so an advisory is never a number the car has not done. */
function quantizeDownKph(speedKph: number): number {
  return Math.max(5, Math.floor(speedKph / 5) * 5);
}

interface CurvatureGrid {
  /** Signed curvature (rad/m, + = left) sampled every `stepM` from S/F. */
  values: number[];
  stepM: number;
  totalLengthM: number;
}

/** Signed curvature of the learned centreline, rebased to S/F and put on an even grid. */
function buildCurvatureGrid(
  runtime: RuntimeProfile,
  totalLengthM: number,
  curvatureWindowM: number,
  stepM: number,
): CurvatureGrid {
  const raw = curvatureProfile(
    runtime.centerline,
    runtime.cumulativeDistancesM,
    true,
    curvatureWindowM,
  );
  const startFinishM = modulo(runtime.startFinishGate.distanceM, totalLengthM);
  const rebased = runtime.cumulativeDistancesM
    .map((sourceM, index) => ({
      distanceM: modulo(sourceM - startFinishM, totalLengthM),
      curvature: raw[index] ?? 0,
    }))
    .sort((a, b) => a.distanceM - b.distanceM);

  const count = Math.max(8, Math.round(totalLengthM / stepM));
  const values = new Array<number>(count).fill(0);
  for (let index = 0; index < count; index += 1) {
    const target = (index * totalLengthM) / count;
    let best = rebased[0];
    let bestGap = Number.POSITIVE_INFINITY;
    for (const entry of rebased) {
      const gap = Math.min(
        Math.abs(entry.distanceM - target),
        totalLengthM - Math.abs(entry.distanceM - target),
      );
      if (gap < bestGap) {
        bestGap = gap;
        best = entry;
      }
    }
    values[index] = best?.curvature ?? 0;
  }
  return { values, stepM: totalLengthM / count, totalLengthM };
}

interface SpeedObservation {
  distanceM: number;
  speedMps: number;
}

interface SpeedSeries {
  /** Smoothed speed on the even grid, m/s -- what the drop detector reads. */
  grid: number[];
  /** The RAW fixes behind it -- what an advisory number is allowed to quote. */
  observations: SpeedObservation[];
}

/** The car's speed along the loop, on the same even grid, in m/s. */
function buildSpeedGrid(
  runtime: RuntimeProfile,
  samples: readonly LocationSample[],
  totalLengthM: number,
  stepM: number,
): SpeedSeries | null {
  const startFinishM = modulo(runtime.startFinishGate.distanceM, totalLengthM);
  const observations: SpeedObservation[] = [];
  for (const sample of samples) {
    const speedMps = sample.speedMps;
    if (speedMps === undefined || !Number.isFinite(speedMps)) continue;
    const local = runtime.projection.toLocal({ lat: sample.lat, lon: sample.lon });
    const projected = projectOntoPolyline(
      local,
      runtime.centerline,
      runtime.cumulativeDistancesM,
      true,
    );
    observations.push({
      distanceM: modulo(projected.distanceM - startFinishM, totalLengthM),
      speedMps,
    });
  }
  if (observations.length < 8) return null;
  observations.sort((a, b) => a.distanceM - b.distanceM);

  const count = Math.max(8, Math.round(totalLengthM / stepM));
  const grid = new Array<number>(count).fill(0);
  for (let index = 0; index < count; index += 1) {
    const target = (index * totalLengthM) / count;
    // Nearest observation either side, circularly -- linear in between.
    let before = observations[observations.length - 1];
    let after = observations[0];
    for (const observation of observations) {
      if (observation.distanceM <= target) before = observation;
    }
    for (let cursor = observations.length - 1; cursor >= 0; cursor -= 1) {
      const observation = observations[cursor];
      if (observation !== undefined && observation.distanceM >= target) after = observation;
    }
    if (before === undefined || after === undefined) continue;
    const span = forwardDistance(before.distanceM, after.distanceM, totalLengthM);
    const offset = forwardDistance(before.distanceM, target, totalLengthM);
    const fraction = span <= 0 ? 0 : Math.min(1, offset / span);
    grid[index] = before.speedMps + (after.speedMps - before.speedMps) * fraction;
  }
  return {
    grid: smoothCircular(grid, Math.max(1, Math.round(15 / (totalLengthM / count)))),
    observations,
  };
}

/**
 * The slowest RAW fix inside a window. Smoothing is what makes the drop
 * detectable; it must never be what an advisory speed is quoted from, or the
 * app would advise a speed the car was never seen doing.
 */
function rawMinimumKph(
  window: SpeedDropWindow,
  observations: readonly SpeedObservation[],
  totalLengthM: number,
): number | null {
  let slowest: number | null = null;
  for (const observation of observations) {
    if (!withinArc(observation.distanceM, window.startM, window.endM, totalLengthM)) continue;
    const speedKph = observation.speedMps * 3.6;
    if (slowest === null || speedKph < slowest) slowest = speedKph;
  }
  return slowest;
}

/** Circular moving average with a half-width of `half` cells. */
function smoothCircular(values: readonly number[], half: number): number[] {
  const count = values.length;
  if (count === 0 || half <= 0) return [...values];
  return values.map((_, index) => {
    let total = 0;
    let used = 0;
    for (let offset = -half; offset <= half; offset += 1) {
      const value = values[modulo(index + offset, count)];
      if (value === undefined) continue;
      total += value;
      used += 1;
    }
    return used === 0 ? 0 : total / used;
  });
}

/** Every slow-down the driver made that is big enough to mean something. */
export function findSpeedDropWindows(
  speedGrid: readonly number[],
  totalLengthM: number,
  minimumDropKph: number,
  minimumDropFraction: number,
): SpeedDropWindow[] {
  const count = speedGrid.length;
  if (count < 8) return [];
  const cellM = totalLengthM / count;
  const toM = (index: number): number => modulo(index, count) * cellM;

  const minima: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const previous = speedGrid[modulo(index - 1, count)] ?? 0;
    const current = speedGrid[index] ?? 0;
    const next = speedGrid[modulo(index + 1, count)] ?? 0;
    if (current <= previous && current < next) minima.push(index);
  }
  // Collapse minima that belong to the same slow-down.
  const merged: number[] = [];
  for (const index of minima) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      forwardDistance(toM(last), toM(index), totalLengthM) < MINIMUM_MERGE_M
    ) {
      if ((speedGrid[index] ?? 0) < (speedGrid[last] ?? 0)) merged[merged.length - 1] = index;
      continue;
    }
    merged.push(index);
  }

  const searchCells = Math.max(2, Math.round(DROP_SEARCH_M / cellM));
  const windows: SpeedDropWindow[] = [];
  for (const minimumIndex of merged) {
    const minimumSpeed = speedGrid[minimumIndex] ?? 0;
    let approachIndex = minimumIndex;
    let approachSpeed = minimumSpeed;
    for (let step = 1; step <= searchCells; step += 1) {
      const index = modulo(minimumIndex - step, count);
      const value = speedGrid[index] ?? 0;
      if (value < approachSpeed) break;
      approachSpeed = value;
      approachIndex = index;
    }
    let recoveryIndex = minimumIndex;
    let recoverySpeed = minimumSpeed;
    for (let step = 1; step <= searchCells; step += 1) {
      const index = modulo(minimumIndex + step, count);
      const value = speedGrid[index] ?? 0;
      if (value < recoverySpeed) break;
      recoverySpeed = value;
      recoveryIndex = index;
    }

    const dropMps = approachSpeed - minimumSpeed;
    if (dropMps * 3.6 < minimumDropKph) continue;
    if (approachSpeed <= 0 || dropMps / approachSpeed < minimumDropFraction) continue;

    // Narrow the window to where the car was actually OFF the pace.
    let startIndex = approachIndex;
    for (let step = 0; step <= searchCells; step += 1) {
      const index = modulo(approachIndex + step, count);
      if ((speedGrid[index] ?? 0) <= approachSpeed - dropMps * 0.25) {
        startIndex = index;
        break;
      }
    }
    let endIndex = recoveryIndex;
    for (let step = 0; step <= searchCells; step += 1) {
      const index = modulo(minimumIndex + step, count);
      if ((speedGrid[index] ?? 0) >= minimumSpeed + (recoverySpeed - minimumSpeed) * 0.5) {
        endIndex = index;
        break;
      }
    }

    windows.push({
      startM: toM(startIndex),
      minimumM: toM(minimumIndex),
      endM: toM(endIndex),
      approachSpeedKph: approachSpeed * 3.6,
      minimumSpeedKph: minimumSpeed * 3.6,
    });
  }
  return windows.sort((a, b) => a.minimumM - b.minimumM);
}

/** Builds one `Corner` from the curvature carried inside a speed-drop window. */
function cornerFromWindow(
  window: SpeedDropWindow,
  grid: CurvatureGrid,
  minimumCurvature: number,
): Omit<Corner, 'id'> | null {
  const count = grid.values.length;
  const cellM = grid.totalLengthM / count;
  const spanM = forwardDistance(window.startM, window.endM, grid.totalLengthM);
  const cells = Math.max(1, Math.round(spanM / cellM));
  const startIndex = Math.round(window.startM / cellM);

  let peakIndex = startIndex;
  let peak = 0;
  for (let step = 0; step <= cells; step += 1) {
    const index = modulo(startIndex + step, count);
    const magnitude = Math.abs(grid.values[index] ?? 0);
    if (magnitude > peak) {
      peak = magnitude;
      peakIndex = index;
    }
  }
  if (peak < minimumCurvature) return null;

  // The corner is the stretch around the peak that still carries real curvature.
  const floor = Math.max(minimumCurvature, peak * 0.5);
  let entryIndex = peakIndex;
  for (let step = 1; step <= cells; step += 1) {
    const index = modulo(peakIndex - step, count);
    if (Math.abs(grid.values[index] ?? 0) < floor) break;
    entryIndex = index;
  }
  let exitIndex = peakIndex;
  for (let step = 1; step <= cells; step += 1) {
    const index = modulo(peakIndex + step, count);
    if (Math.abs(grid.values[index] ?? 0) < floor) break;
    exitIndex = index;
  }

  const entryM = entryIndex * cellM;
  const exitM = exitIndex * cellM;
  const lengthM = forwardDistance(entryM, exitM, grid.totalLengthM);
  let totalAngleRad = 0;
  const spanCells = Math.max(1, Math.round(lengthM / cellM));
  for (let step = 0; step <= spanCells; step += 1) {
    totalAngleRad += Math.abs(grid.values[modulo(entryIndex + step, count)] ?? 0) * cellM;
  }
  const minRadiusM = Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, 1 / peak));
  const totalAngleDeg = totalAngleRad * RAD_TO_DEG;
  const modelKph =
    Math.sqrt(effectiveLatG(totalAngleDeg) * GRAVITY_MPS2 * minRadiusM) * 3.6;

  return {
    entryDistanceM: entryM,
    apexDistanceM: peakIndex * cellM,
    exitDistanceM: exitM,
    lengthM,
    minRadiusM,
    totalAngleDeg,
    direction: (grid.values[peakIndex] ?? 0) > 0 ? 'left' : 'right',
    severity: severityForRadius(minRadiusM),
    advisorySpeedKph: quantizeDownKph(Math.min(modelKph, window.minimumSpeedKph)),
    speedSource: 'observed',
  };
}

/**
 * Derives the learned loop's corner set: curvature candidates, merged with the
 * driver's own speed-drop windows. Pure; the same trace always derives the
 * same corners.
 */
export function deriveTestLoopCorners(
  runtime: RuntimeProfile,
  samples: readonly LocationSample[],
  overrides: TestLoopConfigOverrides = {},
): TestLoopCornerDerivation {
  const config = resolveTestLoopConfig(overrides);
  const totalLengthM = polylineLength(runtime.centerline);
  if (!(totalLengthM > 0)) {
    throw new RangeError('deriveTestLoopCorners: centreline must have positive length');
  }
  // `curvatureProfile` refuses a window wider than half the closed loop -- a
  // 300 m learned loop is a legal loop, so the window yields to it.
  const curvatureWindowM = Math.min(config.curvatureWindowM, totalLengthM / 4);

  const candidates = analyzeCorners(runtime, {
    cornerThreshold: config.cornerThreshold,
    curvatureWindowM,
  });
  const grid = buildCurvatureGrid(runtime, totalLengthM, curvatureWindowM, config.resampleStepM);
  const speedSeries = buildSpeedGrid(runtime, samples, totalLengthM, config.resampleStepM);
  const windows =
    speedSeries === null
      ? []
      : findSpeedDropWindows(
          speedSeries.grid,
          totalLengthM,
          config.speedDropKph,
          config.speedDropFraction,
        ).map((window) => {
          const rawKph = rawMinimumKph(window, speedSeries.observations, totalLengthM);
          return rawKph === null ? window : { ...window, minimumSpeedKph: rawKph };
        });

  const claimed = new Set<SpeedDropWindow>();
  let confirmedBySpeedDrop = 0;
  const merged: Array<Omit<Corner, 'id'>> = candidates.map((corner) => {
    const match = windows.find(
      (window) =>
        !claimed.has(window) &&
        withinArc(
          window.minimumM,
          modulo(corner.entryDistanceM - SPEED_MATCH_SLACK_M, totalLengthM),
          modulo(corner.exitDistanceM + SPEED_MATCH_SLACK_M, totalLengthM),
          totalLengthM,
        ),
    );
    if (match === undefined) return withoutId(corner);
    claimed.add(match);
    confirmedBySpeedDrop += 1;
    const apexInsideCorner = withinArc(
      match.minimumM,
      corner.entryDistanceM,
      corner.exitDistanceM,
      totalLengthM,
    );
    const rest = withoutId(corner);
    return {
      ...rest,
      apexDistanceM: apexInsideCorner ? match.minimumM : rest.apexDistanceM,
      advisorySpeedKph: quantizeDownKph(
        Math.min(rest.advisorySpeedKph, match.minimumSpeedKph),
      ),
      speedSource: 'observed' as const,
    };
  });

  let addedFromSpeedDrop = 0;
  for (const window of windows) {
    if (claimed.has(window)) continue;
    const corner = cornerFromWindow(window, grid, config.speedDropMinCurvature);
    if (corner === null) continue;
    // Never two corners over the same stretch of road.
    const overlaps = merged.some((existing) =>
      withinArc(corner.apexDistanceM, existing.entryDistanceM, existing.exitDistanceM, totalLengthM),
    );
    if (overlaps) continue;
    merged.push(corner);
    addedFromSpeedDrop += 1;
  }

  const corners: Corner[] = merged
    .sort((a, b) => a.entryDistanceM - b.entryDistanceM)
    .map((corner, index) => ({ ...corner, id: index + 1 }));

  return {
    corners,
    speedDropWindows: windows,
    curvatureCandidates: candidates.length,
    confirmedBySpeedDrop,
    addedFromSpeedDrop,
  };
}
