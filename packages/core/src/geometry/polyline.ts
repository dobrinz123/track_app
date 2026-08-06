import type { LocalPoint } from '../contracts';
import { assertFiniteNumber, assertLocalPoint, checkedHypot } from './validation';

export interface PolylineProjection {
  distanceM: number;
  lateralM: number;
  segmentIndex: number;
  point: LocalPoint;
}

export interface ProjectionHint {
  distanceM: number;
  windowM: number;
}

function segmentLength(a: LocalPoint, b: LocalPoint): number {
  return checkedHypot(b.e - a.e, b.n - a.n, 'segment length');
}

function validatePoints(points: LocalPoint[], name: string): void {
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) {
      throw new RangeError(`${name} is sparse at index ${index}`);
    }
    assertLocalPoint(point, `${name}[${index}]`);
  }
}

/** Distances at each vertex; the implicit closing segment is not a vertex. */
export function polylineCumulative(points: LocalPoint[]): number[] {
  validatePoints(points, 'points');
  if (points.length === 0) return [];

  const cumulative = new Array<number>(points.length);
  cumulative[0] = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) {
      throw new RangeError(`points is sparse at index ${index}`);
    }
    const distance = (cumulative[index - 1] ?? 0) + segmentLength(previous, current);
    assertFiniteNumber(distance, `cumulative distance at index ${index}`);
    cumulative[index] = distance;
  }
  return cumulative;
}

/** Total length of an implicitly closed loop, including last-to-first wrap. */
export function polylineLength(closedLoop: LocalPoint[]): number {
  const cumulative = polylineCumulative(closedLoop);
  if (closedLoop.length < 2) return 0;

  const first = closedLoop[0];
  const last = closedLoop[closedLoop.length - 1];
  if (first === undefined || last === undefined) return 0;
  const total = (cumulative[cumulative.length - 1] ?? 0) + segmentLength(last, first);
  assertFiniteNumber(total, 'polyline length');
  return total;
}

function validateCumulative(line: LocalPoint[], cumulative: number[]): void {
  if (cumulative.length !== line.length) {
    throw new RangeError('cumulative must have one entry per line vertex');
  }
  if (cumulative[0] !== 0) {
    throw new RangeError('cumulative must begin at zero');
  }

  for (let index = 0; index < cumulative.length; index += 1) {
    const value = cumulative[index];
    if (value === undefined) throw new RangeError(`cumulative is sparse at index ${index}`);
    assertFiniteNumber(value, `cumulative[${index}]`);
    if (index > 0 && value < (cumulative[index - 1] ?? 0)) {
      throw new RangeError('cumulative must be nondecreasing');
    }
    if (index > 0) {
      const previousPoint = line[index - 1];
      const currentPoint = line[index];
      if (previousPoint === undefined || currentPoint === undefined) {
        throw new RangeError(`line is sparse at index ${index}`);
      }
      const expected = (cumulative[index - 1] ?? 0) + segmentLength(previousPoint, currentPoint);
      const tolerance = Number.EPSILON * 64 * Math.max(1, expected);
      if (Math.abs(value - expected) > tolerance) {
        throw new RangeError('cumulative distances do not match line geometry');
      }
    }
  }
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function circularDistance(a: number, b: number, total: number): number {
  const difference = Math.abs(a - b);
  return Math.min(difference, total - difference);
}

function segmentIsInHintWindow(
  startM: number,
  endM: number,
  hint: ProjectionHint,
  totalM: number,
  closed: boolean,
): boolean {
  const tolerance = Number.EPSILON * 64 * Math.max(1, totalM);
  if (!closed) {
    return (
      endM + tolerance >= hint.distanceM - hint.windowM &&
      startM - tolerance <= hint.distanceM + hint.windowM
    );
  }
  if (hint.windowM * 2 >= totalM) return true;

  const hintDistance = modulo(hint.distanceM, totalM);
  if (hintDistance + tolerance >= startM && hintDistance - tolerance <= endM) return true;
  const normalizedEnd = endM === totalM ? 0 : endM;
  return (
    circularDistance(hintDistance, startM, totalM) <= hint.windowM + tolerance ||
    circularDistance(hintDistance, normalizedEnd, totalM) <= hint.windowM + tolerance
  );
}

/**
 * Find the closest point on a polyline. Duplicate vertices are ignored. A hint
 * admits only segments whose along-line interval overlaps its distance window;
 * closed-loop windows wrap through distance zero.
 */
export function projectOntoPolyline(
  p: LocalPoint,
  line: LocalPoint[],
  cumulative: number[],
  closed: boolean,
  hint?: ProjectionHint,
): PolylineProjection {
  assertLocalPoint(p, 'p');
  validatePoints(line, 'line');
  if (line.length < 2) throw new RangeError('line must contain at least two vertices');
  validateCumulative(line, cumulative);

  if (hint !== undefined) {
    assertFiniteNumber(hint.distanceM, 'hint.distanceM');
    assertFiniteNumber(hint.windowM, 'hint.windowM');
    if (hint.windowM < 0) throw new RangeError('hint.windowM must be nonnegative');
  }

  const lastIndex = line.length - 1;
  const first = line[0];
  const last = line[lastIndex];
  if (first === undefined || last === undefined) throw new RangeError('line must not be sparse');
  const openLength = cumulative[lastIndex] ?? 0;
  const wrapLength = closed ? segmentLength(last, first) : 0;
  const totalLength = openLength + wrapLength;
  if (!(totalLength > 0) || !Number.isFinite(totalLength)) {
    throw new RangeError('line must contain at least one non-zero-length segment');
  }

  let best: PolylineProjection | undefined;
  let bestSquaredDistance = Number.POSITIVE_INFINITY;
  const segmentCount = closed ? line.length : line.length - 1;

  for (let index = 0; index < segmentCount; index += 1) {
    const a = line[index];
    const b = line[(index + 1) % line.length];
    if (a === undefined || b === undefined) throw new RangeError('line must not be sparse');

    const vx = b.e - a.e;
    const vy = b.n - a.n;
    const lengthSquared = vx * vx + vy * vy;
    if (!Number.isFinite(lengthSquared)) throw new RangeError('segment length must be finite');
    if (lengthSquared === 0) continue;

    const startM = cumulative[index] ?? 0;
    const length = Math.sqrt(lengthSquared);
    const endM = startM + length;
    if (
      hint !== undefined &&
      !segmentIsInHintWindow(startM, endM, hint, totalLength, closed)
    ) {
      continue;
    }

    const unclampedT = ((p.e - a.e) * vx + (p.n - a.n) * vy) / lengthSquared;
    const t = Math.max(0, Math.min(1, unclampedT));
    const projected = { e: a.e + t * vx, n: a.n + t * vy };
    const deltaE = p.e - projected.e;
    const deltaN = p.n - projected.n;
    const squaredDistance = deltaE * deltaE + deltaN * deltaN;
    if (!Number.isFinite(squaredDistance)) throw new RangeError('projection distance must be finite');

    if (squaredDistance < bestSquaredDistance) {
      const cross = vx * (p.n - a.n) - vy * (p.e - a.e);
      const lateral = cross / length;
      const rawDistance = startM + t * length;
      const distance = closed && rawDistance >= totalLength ? 0 : rawDistance;
      assertFiniteNumber(lateral, 'lateral distance');
      assertFiniteNumber(distance, 'along-line distance');
      assertLocalPoint(projected, 'projected point');
      bestSquaredDistance = squaredDistance;
      best = {
        distanceM: distance,
        lateralM: lateral,
        segmentIndex: index,
        point: projected,
      };
    }
  }

  if (best === undefined) {
    throw new RangeError('hint window contains no non-zero-length segment');
  }
  return best;
}

/** Lift wrapped progress to the nearest equivalent distance to the previous value. */
export function unwrapProgress(
  prevUnwrappedM: number,
  newDistanceM: number,
  totalLengthM: number,
): number {
  assertFiniteNumber(prevUnwrappedM, 'prevUnwrappedM');
  assertFiniteNumber(newDistanceM, 'newDistanceM');
  assertFiniteNumber(totalLengthM, 'totalLengthM');
  if (totalLengthM <= 0) throw new RangeError('totalLengthM must be positive');

  const wrappedDistance = modulo(newDistanceM, totalLengthM);
  const wrap = Math.round((prevUnwrappedM - wrappedDistance) / totalLengthM);
  const result = wrappedDistance + wrap * totalLengthM;
  assertFiniteNumber(result, 'unwrapped progress');
  return result;
}
