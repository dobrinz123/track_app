import type { LatLon, LocalPoint } from '../contracts';

export function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
}

export function assertLatLon(point: LatLon, name: string): void {
  assertFiniteNumber(point.lat, `${name}.lat`);
  assertFiniteNumber(point.lon, `${name}.lon`);

  if (point.lat < -90 || point.lat > 90) {
    throw new RangeError(`${name}.lat must be between -90 and 90 degrees`);
  }
  if (point.lon < -180 || point.lon > 180) {
    throw new RangeError(`${name}.lon must be between -180 and 180 degrees`);
  }
}

export function assertLocalPoint(point: LocalPoint, name: string): void {
  assertFiniteNumber(point.e, `${name}.e`);
  assertFiniteNumber(point.n, `${name}.n`);
}

export function checkedHypot(x: number, y: number, name: string): number {
  const result = Math.hypot(x, y);
  assertFiniteNumber(result, name);
  return result;
}
