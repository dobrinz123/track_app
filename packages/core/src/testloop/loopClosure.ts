import type { LocalPoint, LocationSample } from '../contracts';
import { createProjection } from '../geometry';

import { resolveTestLoopConfig, type TestLoopConfigOverrides } from './config';

/**
 * Ticket P5d T1(a) -- "lap 1 defines the track" needs exactly one decision:
 * has the driver come back to where they started, going the way they left?
 *
 * Three independent conditions, all of which must hold, so that the honest
 * failure is always nameable:
 *   1. within `closeRadiusM` of the start point,
 *   2. travelling within `headingToleranceDeg` of the start heading,
 *   3. after at least `minLapLengthM` of driving (this is what rejects a
 *      U-turn -- it satisfies 1 and sometimes even 2, but never 3).
 *
 * Heading is measured from the TRACK, over a `courseBaselineM` baseline, not
 * from a single fix's `headingDeg`: a parked-then-rolling phone reports
 * garbage course, and 5 m of noise on two adjacent 1 Hz fixes is a 30 degree
 * error. A reported `headingDeg` is used only when the track cannot supply a
 * baseline (too few samples at the very start).
 */

export interface LoopClosure {
  /** Index of the sample the loop is anchored at (the start point). */
  startIndex: number;
  /** Index of the sample that closed the loop -- lap 1 is `[startIndex, closeIndex]`. */
  closeIndex: number;
  /** Distance driven from `startIndex` to `closeIndex`, metres. */
  lapLengthM: number;
  /** How near the start point the closing sample passed, metres. */
  closureDistanceM: number;
  /** How far the closing travel direction was from the start heading, degrees. */
  headingErrorDeg: number;
  /** The start heading itself, degrees (0 = north). */
  startHeadingDeg: number;
}

export type LoopClosureFailureReason =
  | 'insufficient-samples'
  | 'not-returned'
  | 'too-short'
  | 'heading-mismatch';

export type LoopClosureResult =
  | { closed: true; closure: LoopClosure }
  | {
      closed: false;
      reason: LoopClosureFailureReason;
      /** How far the driver actually drove, metres -- what the honest message quotes. */
      travelledM: number;
      /** Nearest the driver came to the start point after leaving it, metres. */
      closestApproachM: number;
    };

const RAD_TO_DEG = 180 / Math.PI;

function distance(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(b.e - a.e, b.n - a.n);
}

/** Bearing of `b` seen from `a`, degrees clockwise from north. */
function bearingDeg(a: LocalPoint, b: LocalPoint): number {
  return (Math.atan2(b.e - a.e, b.n - a.n) * RAD_TO_DEG + 360) % 360;
}

/** Smallest absolute angle between two bearings, degrees (0..180). */
export function headingDifferenceDeg(a: number, b: number): number {
  const raw = Math.abs(((a - b) % 360) + 360) % 360;
  return raw > 180 ? 360 - raw : raw;
}

/** Projects a sample trace into a metre frame anchored at its first sample. */
export function toLocalTrack(samples: readonly LocationSample[]): {
  points: LocalPoint[];
  cumulativeM: number[];
} {
  const first = samples[0];
  if (first === undefined) return { points: [], cumulativeM: [] };
  const projection = createProjection({ lat: first.lat, lon: first.lon });
  const points = samples.map((sample) => projection.toLocal({ lat: sample.lat, lon: sample.lon }));
  const cumulativeM: number[] = new Array<number>(points.length);
  cumulativeM[0] = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) break;
    cumulativeM[index] = (cumulativeM[index - 1] ?? 0) + distance(previous, current);
  }
  return { points, cumulativeM };
}

/**
 * Travel direction at `index`, measured over a `baselineM` window of TRACK
 * either side of it (clipped at the ends of the trace). `null` when the trace
 * carries no usable baseline at all and no fix reported a heading.
 */
function courseAtDeg(
  points: readonly LocalPoint[],
  cumulativeM: readonly number[],
  samples: readonly LocationSample[],
  index: number,
  baselineM: number,
): number | null {
  const here = points[index];
  const hereM = cumulativeM[index];
  if (here === undefined || hereM === undefined) return null;

  let backIndex = index;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    backIndex = cursor;
    if (hereM - (cumulativeM[cursor] ?? hereM) >= baselineM) break;
  }
  let forwardIndex = index;
  for (let cursor = index + 1; cursor < points.length; cursor += 1) {
    forwardIndex = cursor;
    if ((cumulativeM[cursor] ?? hereM) - hereM >= baselineM) break;
  }

  const from = points[backIndex];
  const to = points[forwardIndex];
  if (from !== undefined && to !== undefined && distance(from, to) >= 1) {
    return bearingDeg(from, to);
  }
  const reported = samples[index]?.headingDeg;
  return reported !== undefined && Number.isFinite(reported) ? ((reported % 360) + 360) % 360 : null;
}

/**
 * Finds the first honest closure of lap 1. Never throws: a trace that does not
 * close is a NAMED outcome, because the driver has to be told which of the
 * three conditions was the one that did not hold.
 */
export function detectLoopClosure(
  samples: readonly LocationSample[],
  overrides: TestLoopConfigOverrides = {},
): LoopClosureResult {
  const config = resolveTestLoopConfig(overrides);
  if (samples.length < 4) {
    return { closed: false, reason: 'insufficient-samples', travelledM: 0, closestApproachM: 0 };
  }

  const { points, cumulativeM } = toLocalTrack(samples);
  const start = points[0];
  if (start === undefined) {
    return { closed: false, reason: 'insufficient-samples', travelledM: 0, closestApproachM: 0 };
  }
  const travelledM = cumulativeM[cumulativeM.length - 1] ?? 0;
  const startHeadingDeg = courseAtDeg(points, cumulativeM, samples, 0, config.courseBaselineM);
  if (startHeadingDeg === null) {
    return { closed: false, reason: 'insufficient-samples', travelledM, closestApproachM: 0 };
  }

  let closestApproachM = Number.POSITIVE_INFINITY;
  let sawReturn = false;
  let sawLongEnoughReturn = false;
  let departed = false;

  // One pass; a "return" is a RUN of consecutive samples inside the closing
  // radius, and the candidate within it is the closest approach -- the first
  // sample to enter a 25 m circle at 60 km/h can easily be 24 m off-centre
  // while the next one is 3 m off.
  let runBestIndex: number | null = null;
  let runBestDistanceM = Number.POSITIVE_INFINITY;

  const evaluateRun = (): LoopClosure | null => {
    if (runBestIndex === null) return null;
    const index = runBestIndex;
    const lapLengthM = cumulativeM[index] ?? 0;
    runBestIndex = null;
    runBestDistanceM = Number.POSITIVE_INFINITY;
    sawReturn = true;
    if (lapLengthM < config.minLapLengthM) return null;
    sawLongEnoughReturn = true;
    const course = courseAtDeg(points, cumulativeM, samples, index, config.courseBaselineM);
    if (course === null) return null;
    const headingErrorDeg = headingDifferenceDeg(course, startHeadingDeg);
    if (headingErrorDeg > config.headingToleranceDeg) return null;
    return {
      startIndex: 0,
      closeIndex: index,
      lapLengthM,
      closureDistanceM: distance(start, points[index] ?? start),
      headingErrorDeg,
      startHeadingDeg,
    };
  };

  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    const toStartM = distance(start, point);
    if (!departed) {
      // The trace must LEAVE the closing circle before returning to it can
      // mean anything -- otherwise a car creeping away from the kerb closes
      // a zero-length loop on its second fix.
      if (toStartM > config.closeRadiusM) departed = true;
      continue;
    }
    if (toStartM <= config.closeRadiusM) {
      closestApproachM = Math.min(closestApproachM, toStartM);
      if (toStartM < runBestDistanceM) {
        runBestDistanceM = toStartM;
        runBestIndex = index;
      }
      continue;
    }
    const closure = evaluateRun();
    if (closure !== null) return { closed: true, closure };
  }
  const closure = evaluateRun();
  if (closure !== null) return { closed: true, closure };

  const reason: LoopClosureFailureReason = !sawReturn
    ? 'not-returned'
    : sawLongEnoughReturn
      ? 'heading-mismatch'
      : 'too-short';
  return {
    closed: false,
    reason,
    travelledM,
    closestApproachM: Number.isFinite(closestApproachM) ? closestApproachM : travelledM,
  };
}
