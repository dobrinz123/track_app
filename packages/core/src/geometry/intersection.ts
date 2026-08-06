import type { LocalPoint } from '../contracts';
import { assertFiniteNumber, assertLocalPoint } from './validation';

export interface SegmentIntersection {
  t: number;
  u: number;
  point: LocalPoint;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  const result = ax * by - ay * bx;
  assertFiniteNumber(result, 'cross product');
  return result;
}

function crossTolerance(ax: number, ay: number, bx: number, by: number): number {
  return Number.EPSILON * 16 * (Math.abs(ax * by) + Math.abs(ay * bx));
}

/**
 * Inclusive segment intersection using orientation determinants. Parallel,
 * collinear, and zero-length segments have no unique crossing and return null.
 */
export function segmentIntersection(
  p1: LocalPoint,
  p2: LocalPoint,
  q1: LocalPoint,
  q2: LocalPoint,
): SegmentIntersection | null {
  assertLocalPoint(p1, 'p1');
  assertLocalPoint(p2, 'p2');
  assertLocalPoint(q1, 'q1');
  assertLocalPoint(q2, 'q2');

  const rx = p2.e - p1.e;
  const ry = p2.n - p1.n;
  const sx = q2.e - q1.e;
  const sy = q2.n - q1.n;
  assertFiniteNumber(rx, 'p segment east component');
  assertFiniteNumber(ry, 'p segment north component');
  assertFiniteNumber(sx, 'q segment east component');
  assertFiniteNumber(sy, 'q segment north component');
  if ((rx === 0 && ry === 0) || (sx === 0 && sy === 0)) return null;

  const denominator = cross(rx, ry, sx, sy);
  if (Math.abs(denominator) <= crossTolerance(rx, ry, sx, sy)) return null;

  const qpx = q1.e - p1.e;
  const qpy = q1.n - p1.n;
  assertFiniteNumber(qpx, 'segment displacement east component');
  assertFiniteNumber(qpy, 'segment displacement north component');
  const t = cross(qpx, qpy, sx, sy) / denominator;
  const u = cross(qpx, qpy, rx, ry) / denominator;
  assertFiniteNumber(t, 'intersection t');
  assertFiniteNumber(u, 'intersection u');

  const parameterTolerance = Number.EPSILON * 32;
  if (t < -parameterTolerance || t > 1 + parameterTolerance) return null;
  if (u < -parameterTolerance || u > 1 + parameterTolerance) return null;

  const clampedT = Math.max(0, Math.min(1, t));
  const clampedU = Math.max(0, Math.min(1, u));
  const point = { e: p1.e + clampedT * rx, n: p1.n + clampedT * ry };
  assertLocalPoint(point, 'intersection point');
  return { t: clampedT, u: clampedU, point };
}

/**
 * A directed gate A->B has left where cross(B-A, X-A) is positive.
 * Forward is motion from the gate's right half-plane to its left, hence a
 * positive cross(gate vector, motion vector); reverse is negative.
 */
export function crossingDirection(
  gateA: LocalPoint,
  gateB: LocalPoint,
  motionFrom: LocalPoint,
  motionTo: LocalPoint,
): 'forward' | 'reverse' {
  assertLocalPoint(gateA, 'gateA');
  assertLocalPoint(gateB, 'gateB');
  assertLocalPoint(motionFrom, 'motionFrom');
  assertLocalPoint(motionTo, 'motionTo');

  const gateE = gateB.e - gateA.e;
  const gateN = gateB.n - gateA.n;
  const motionE = motionTo.e - motionFrom.e;
  const motionN = motionTo.n - motionFrom.n;
  if (gateE === 0 && gateN === 0) throw new RangeError('gate must have non-zero length');
  if (motionE === 0 && motionN === 0) throw new RangeError('motion must have non-zero length');

  const directionCross = cross(gateE, gateN, motionE, motionN);
  if (Math.abs(directionCross) <= crossTolerance(gateE, gateN, motionE, motionN)) {
    throw new RangeError('motion must cross the gate transversely');
  }
  return directionCross > 0 ? 'forward' : 'reverse';
}

function adjacentFloat(value: number, upward: boolean): number {
  if (value === (upward ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY)) return value;
  if (value === 0) return upward ? Number.MIN_VALUE : -Number.MIN_VALUE;

  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  let bits = view.getBigUint64(0);
  bits += (value > 0) === upward ? 1n : -1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

/** Interpolate a monotonic crossing timestamp using a segment parameter. */
export function interpolateCrossingTime(tPrev: number, tCurr: number, t: number): number {
  assertFiniteNumber(tPrev, 'tPrev');
  assertFiniteNumber(tCurr, 'tCurr');
  assertFiniteNumber(t, 't');
  if (tCurr < tPrev) throw new RangeError('tCurr must not precede tPrev');
  if (t < 0 || t > 1) throw new RangeError('t must be between zero and one');

  let result = (1 - t) * tPrev + t * tCurr;
  assertFiniteNumber(result, 'interpolated crossing time');

  // IEEE-754 rounding can collapse a mathematically interior result onto an
  // endpoint. Preserve the strict interior contract whenever the interval has
  // an interior representable number.
  if (t > 0 && t < 1 && tCurr > tPrev) {
    if (result <= tPrev) result = adjacentFloat(tPrev, true);
    if (result >= tCurr) result = adjacentFloat(tCurr, false);
    if (!(result > tPrev && result < tCurr)) {
      throw new RangeError('timestamp interval has no representable interior value');
    }
  }
  return result;
}
