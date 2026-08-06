import type { GeoProjection, LatLon, LocalPoint } from '../contracts';
import { assertFiniteNumber, assertLatLon, assertLocalPoint } from './validation';

// IUGG mean Earth radius. The projection is deliberately spherical and local:
// circuits are small enough that ellipsoidal geodesics add cost without useful
// lap-timing accuracy.
const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MIN_LONGITUDE_SCALE = 1e-12;

function normalizeLongitude(lon: number): number {
  const normalized = ((lon + 180) % 360 + 360) % 360 - 180;
  // Preserve +180 when it was the caller's canonical representation.
  return normalized === -180 && lon > 0 ? 180 : normalized;
}

function shortestLongitudeDelta(lon: number, originLon: number): number {
  const delta = ((lon - originLon + 180) % 360 + 360) % 360 - 180;
  return delta === -180 && lon - originLon > 0 ? 180 : delta;
}

/** Create a fast local east/north projection centered on `origin`. */
export function createProjection(origin: LatLon): GeoProjection {
  assertLatLon(origin, 'origin');

  const longitudeScale = Math.cos(origin.lat * DEG_TO_RAD);
  if (Math.abs(longitudeScale) < MIN_LONGITUDE_SCALE) {
    throw new RangeError('origin is too close to a pole for an equirectangular projection');
  }

  const stableOrigin = { ...origin };

  return {
    origin: stableOrigin,

    toLocal(point: LatLon): LocalPoint {
      assertLatLon(point, 'point');
      const result = {
        e:
          EARTH_RADIUS_M *
          shortestLongitudeDelta(point.lon, stableOrigin.lon) *
          DEG_TO_RAD *
          longitudeScale,
        n: EARTH_RADIUS_M * (point.lat - stableOrigin.lat) * DEG_TO_RAD,
      };
      assertLocalPoint(result, 'projected point');
      return result;
    },

    toLatLon(point: LocalPoint): LatLon {
      assertLocalPoint(point, 'point');
      const result = {
        lat: stableOrigin.lat + (point.n / EARTH_RADIUS_M) * RAD_TO_DEG,
        lon: normalizeLongitude(
          stableOrigin.lon + (point.e / (EARTH_RADIUS_M * longitudeScale)) * RAD_TO_DEG,
        ),
      };
      assertFiniteNumber(result.lat, 'unprojected point.lat');
      assertFiniteNumber(result.lon, 'unprojected point.lon');
      if (result.lat < -90 || result.lat > 90) {
        throw new RangeError('local point projects outside the valid latitude range');
      }
      return result;
    },
  };
}
