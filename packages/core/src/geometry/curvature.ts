import type { LocalPoint } from '../contracts';

function distance(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(b.e - a.e, b.n - a.n);
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function validateInputs(
  centerlineLocal: LocalPoint[],
  cumulative: number[],
  closed: boolean,
  windowM: number,
): number {
  if (centerlineLocal.length !== cumulative.length) {
    throw new RangeError('cumulative must have one entry per centerline vertex');
  }
  if (centerlineLocal.length < 3) {
    throw new RangeError('centerlineLocal must contain at least three vertices');
  }
  if (cumulative[0] !== 0) throw new RangeError('cumulative must begin at zero');
  if (!Number.isFinite(windowM) || windowM <= 0) {
    throw new RangeError('windowM must be a positive finite number');
  }

  for (let index = 0; index < centerlineLocal.length; index += 1) {
    const point = centerlineLocal[index];
    const distanceM = cumulative[index];
    if (
      point === undefined ||
      distanceM === undefined ||
      !Number.isFinite(point.e) ||
      !Number.isFinite(point.n) ||
      !Number.isFinite(distanceM)
    ) {
      throw new RangeError(`centerlineLocal/cumulative is invalid at index ${index}`);
    }
    if (index > 0) {
      const previousPoint = centerlineLocal[index - 1];
      const previousDistanceM = cumulative[index - 1];
      if (previousPoint === undefined || previousDistanceM === undefined) {
        throw new RangeError(`centerlineLocal/cumulative is sparse at index ${index}`);
      }
      const segmentLengthM = distance(previousPoint, point);
      if (!(segmentLengthM > 0)) {
        throw new RangeError('centerlineLocal must not contain zero-length segments');
      }
      const expectedDistanceM = previousDistanceM + segmentLengthM;
      const toleranceM = Number.EPSILON * 64 * Math.max(1, expectedDistanceM);
      if (Math.abs(distanceM - expectedDistanceM) > toleranceM) {
        throw new RangeError('cumulative distances do not match centerlineLocal');
      }
    }
  }

  const first = centerlineLocal[0];
  const last = centerlineLocal[centerlineLocal.length - 1];
  const openLengthM = cumulative[cumulative.length - 1];
  if (first === undefined || last === undefined || openLengthM === undefined) {
    throw new RangeError('centerlineLocal must not be sparse');
  }
  const closingLengthM = closed ? distance(last, first) : 0;
  if (closed && !(closingLengthM > 0)) {
    throw new RangeError('closed centerlineLocal must have a non-zero closing segment');
  }
  const totalLengthM = openLengthM + closingLengthM;
  if (!(totalLengthM > 0) || !Number.isFinite(totalLengthM)) {
    throw new RangeError('centerlineLocal must have a positive finite length');
  }
  if (closed && windowM * 2 >= totalLengthM) {
    throw new RangeError('windowM must be shorter than half the closed centerline');
  }
  return totalLengthM;
}

function segmentBearing(centerlineLocal: LocalPoint[], segmentIndex: number): number {
  const a = centerlineLocal[segmentIndex];
  const b = centerlineLocal[segmentIndex + 1];
  if (a === undefined || b === undefined) throw new RangeError('centerlineLocal is sparse');
  return Math.atan2(b.n - a.n, b.e - a.e);
}

function closingSegmentBearing(centerlineLocal: LocalPoint[]): number {
  const first = centerlineLocal[0];
  const last = centerlineLocal[centerlineLocal.length - 1];
  if (first === undefined || last === undefined) throw new RangeError('centerlineLocal is sparse');
  return Math.atan2(first.n - last.n, first.e - last.e);
}

function signedTurn(fromBearing: number, toBearing: number): number {
  const difference = toBearing - fromBearing;
  return Math.atan2(Math.sin(difference), Math.cos(difference));
}

function vertexTurn(centerlineLocal: LocalPoint[], index: number, closed: boolean): number | null {
  const lastIndex = centerlineLocal.length - 1;
  if (!closed && (index === 0 || index === lastIndex)) return null;

  const incomingBearing =
    index === 0 ? closingSegmentBearing(centerlineLocal) : segmentBearing(centerlineLocal, index - 1);
  const outgoingBearing =
    index === lastIndex ? closingSegmentBearing(centerlineLocal) : segmentBearing(centerlineLocal, index);
  return signedTurn(incomingBearing, outgoingBearing);
}

/**
 * Signed turning-angle density at an arbitrary along-line distance. Magnitude
 * is the sum of absolute vertex turns inside the +/- window, matching the TMR
 * generator's established straightness metric; sign is the net turn (+ left).
 */
export function curvatureAtDistance(
  centerlineLocal: LocalPoint[],
  cumulative: number[],
  closed: boolean,
  distanceM: number,
  windowM: number,
): number {
  const totalLengthM = validateInputs(centerlineLocal, cumulative, closed, windowM);
  if (!Number.isFinite(distanceM)) throw new RangeError('distanceM must be finite');

  const targetDistanceM = closed ? modulo(distanceM, totalLengthM) : distanceM;
  if (!closed && (targetDistanceM < 0 || targetDistanceM > totalLengthM)) {
    throw new RangeError('distanceM must lie on the open centerline');
  }
  const windowStartM = closed ? modulo(targetDistanceM - windowM, totalLengthM) : Math.max(0, targetDistanceM - windowM);
  const windowEndM = closed ? windowStartM + windowM * 2 : Math.min(totalLengthM, targetDistanceM + windowM);
  const denominatorM = windowEndM - windowStartM;
  let absoluteTurningAngle = 0;
  let signedTurningAngle = 0;

  for (let index = 0; index < centerlineLocal.length; index += 1) {
    const vertexDistanceM = cumulative[index];
    if (vertexDistanceM === undefined) throw new RangeError('cumulative is sparse');
    const distanceFromWindowStartM = closed
      ? modulo(vertexDistanceM - windowStartM, totalLengthM)
      : vertexDistanceM - windowStartM;
    if (distanceFromWindowStartM <= 0 || distanceFromWindowStartM >= denominatorM) continue;

    const turn = vertexTurn(centerlineLocal, index, closed);
    if (turn === null) continue;
    absoluteTurningAngle += Math.abs(turn);
    signedTurningAngle += turn;
  }

  return Math.sign(signedTurningAngle) * (absoluteTurningAngle / denominatorM);
}

/** Per-vertex signed curvature in radians per metre (+ left, - right). */
export function curvatureProfile(
  centerlineLocal: LocalPoint[],
  cumulative: number[],
  closed: boolean,
  windowM: number,
): number[] {
  validateInputs(centerlineLocal, cumulative, closed, windowM);
  return cumulative.map((distanceM) =>
    curvatureAtDistance(centerlineLocal, cumulative, closed, distanceM, windowM),
  );
}
