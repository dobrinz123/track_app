import type { LatLon } from '@circuit/core';

/**
 * Field revision 2 (2026-08-27, binding — Phase 4h, after driveway test 2):
 * "calibration started 61 km from MotorPark (OFF TRACK ... 0 %) ... user felt
 * stuck" — Preflight now warns BEFORE calibration when the driver's current
 * GNSS fix is more than this far from the selected circuit's start/finish
 * gate. Pure, no I/O — see {@link evaluateCircuitProximity}.
 */
export const CIRCUIT_PROXIMITY_WARN_KM = 3;

const EARTH_RADIUS_KM = 6_371.0088;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Great-circle (haversine) distance between two lat/lon points, in
 * kilometers. Pure function — no I/O — mirrors the same formula used
 * elsewhere in this codebase for short-range geo distance (e.g.
 * `packages/core/src/matching/quality-evaluator.ts`'s own `distanceM`, not
 * exported there, so re-derived here rather than reaching into a private
 * module internal).
 */
export function haversineDistanceKm(a: LatLon, b: LatLon): number {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const deltaLat = (b.lat - a.lat) * DEG_TO_RAD;
  const deltaLon = (b.lon - a.lon) * DEG_TO_RAD;
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Midpoint of a gate's directed segment (`a` -> `b`) — a simple lat/lon
 * average is adequate here: a start/finish gate segment spans, at most, the
 * width of a track (tens of meters), several orders of magnitude below the
 * `CIRCUIT_PROXIMITY_WARN_KM` threshold this feeds, so the (tiny) difference
 * from a true geodesic midpoint is immaterial to the warn/no-warn decision.
 */
export function gateMidpoint(gate: { a: LatLon; b: LatLon }): LatLon {
  return { lat: (gate.a.lat + gate.b.lat) / 2, lon: (gate.a.lon + gate.b.lon) / 2 };
}

export interface CircuitProximityResult {
  /** `null` when no GNSS fix is available yet — the existing GNSS-wait UI applies, and this never warns in that case (per contracts.md's Field revision 2: "No fix yet -> the existing GNSS wait applies"). */
  distanceKm: number | null;
  shouldWarn: boolean;
}

/**
 * Pure decision function (no I/O, no React, no navigation) — given the
 * current GNSS fix (or `null` before one has arrived) and the selected
 * circuit's start/finish gate, decides whether Preflight should show the
 * "you are far from the circuit" warning card. `PreflightScreen.tsx` is the
 * only caller; kept separate so the distance math and the warn threshold are
 * directly unit-testable without mounting the screen.
 */
export function evaluateCircuitProximity(
  fix: LatLon | null,
  startFinishGate: { a: LatLon; b: LatLon },
  warnThresholdKm: number = CIRCUIT_PROXIMITY_WARN_KM,
): CircuitProximityResult {
  if (fix === null) return { distanceKm: null, shouldWarn: false };
  const distanceKm = haversineDistanceKm(fix, gateMidpoint(startFinishGate));
  return { distanceKm, shouldWarn: distanceKm > warnThresholdKm };
}
