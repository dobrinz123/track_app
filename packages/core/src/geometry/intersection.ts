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

/**
 * iOS reports `CLLocation.speed` as -1 when it has no valid Doppler solution,
 * and the provider copies that value through verbatim
 * (`apps/mobile/src/platform/gnssLocationProvider.ts`), so NEGATIVE and ZERO
 * speeds reach this module. A stationary car cannot produce a crossing either,
 * so anything that is not finite and strictly positive counts as ABSENT.
 */
function usableSpeed(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Ticket P8.1. Converts a DISTANCE fraction along the path between two fixes
 * into the TIME fraction at which the car reached it, under a
 * constant-acceleration model built from the Doppler speed at each fix.
 * Returns `distanceFraction` UNCHANGED whenever the model cannot be applied,
 * so the caller's fallback is exactly today's linear interpolation.
 *
 * ## Derivation
 *
 * Let `dt = tCurr - tPrev`, and let the along-path speed be linear in time
 * (constant acceleration `a`) across the interval:
 *
 *     v(tau) = v0 + a*tau           with a = (v1 - v0) / dt
 *     d(tau) = v0*tau + a*tau^2/2   (distance travelled by time tau)
 *     D      = d(dt) = (v0 + v1)/2 * dt      (whole interval)
 *
 * `t` is the fraction of the PATH between the two fixes at which the gate
 * sits, so the crossing is the instant `tau` where `d(tau) = t*D`. Rather than
 * solve that quadratic directly, use the energy form `v^2 = v0^2 + 2*a*d`,
 * which is exact for constant acceleration and makes the distance condition
 * linear in `v^2`:
 *
 *     vt^2 = v0^2 + 2*a*(t*D)
 *          = v0^2 + 2*((v1 - v0)/dt)*t*((v0 + v1)/2)*dt
 *          = v0^2 + t*(v1^2 - v0^2)
 *     vt   = sqrt((1 - t)*v0^2 + t*v1^2)                       (non-negative)
 *
 * Speed is linear in time, so the time fraction follows straight from `vt`:
 *
 *     tau/dt = (vt - v0) / (v1 - v0)
 *
 * That form cancels catastrophically as `v1 -> v0`. Multiplying above and
 * below by `(vt + v0)` removes the cancellation entirely:
 *
 *     tau/dt = (vt^2 - v0^2) / ((v1 - v0)*(vt + v0))
 *            = t*(v1^2 - v0^2) / ((v1 - v0)*(vt + v0))
 *            = t*(v0 + v1) / (v0 + vt)
 *
 * which is well conditioned for every `v0, v1 > 0` and evaluates to exactly
 * `t` when `v0 === v1` (handled by an explicit early return so no rounding can
 * perturb the constant-speed case).
 *
 * ## Sign check (done from the formula, not from the name)
 *
 * Braking: v0 = 50, v1 = 30, t = 0.5 -> vt = sqrt(1700) = 41.23,
 * tau/dt = 0.5*80/91.23 = 0.438 < 0.5. Correct: a braking car covers the first
 * half of the distance in LESS than half the time, so the crossing happened
 * EARLIER than linear interpolation says. Accelerating (v1 > v0) gives the
 * mirror image, tau/dt > t. At 1 Hz, 1 g and 42 m/s the correction is ~27 ms,
 * the error the ticket quotes for linear interpolation.
 *
 * ## Modelling caveat
 *
 * `distanceFraction` from `segmentIntersection` is a fraction of the straight
 * CHORD between two fixes, while `D` above is arc length along the driven
 * path. The two agree to second order in the path curvature over one fix
 * interval and the difference is far below the effects being corrected here.
 */
export function kinematicCrossingFraction(
  distanceFraction: number,
  entrySpeedMps: number | undefined,
  exitSpeedMps: number | undefined,
): number {
  const t = distanceFraction;
  // Endpoints, out-of-range and non-finite inputs are the caller's contract to
  // police; hand them back untouched so behaviour is exactly today's.
  if (!Number.isFinite(t) || t <= 0 || t >= 1) return t;

  const v0 = usableSpeed(entrySpeedMps);
  const v1 = usableSpeed(exitSpeedMps);
  if (v0 === null || v1 === null) return t;
  if (v0 === v1) return t;

  const vt = Math.sqrt((1 - t) * v0 * v0 + t * v1 * v1);
  if (!Number.isFinite(vt) || vt <= 0) return t;

  const fraction = (t * (v0 + v1)) / (v0 + vt);
  // A degenerate model must never move the crossing onto or past an endpoint.
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) return t;
  return fraction;
}
