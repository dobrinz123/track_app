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

// ---------------------------------------------------------------------------
// P4h-FIX1 H2+H3 (after Codex P4h-REV1 HIGH, `PreflightScreen.tsx:75-78,
// 99-117,137-138,245-255`): "the distance guard can silently bypass itself
// ... `currentFix` remains `null`, `evaluateCircuitProximity(null, ...)`
// returns no warning, and the ordinary Continue button is shown."
//
// The guard now has THREE outcomes, not two, and "no usable fix" is one of
// them: the screen says so and keeps Continue disabled (binding ticket rule:
// "Never silently pass ... Continue stays disabled until a fix arrives
// (Continue-anyway remains available). Keep accuracy/age of the fix (stale
// > 30 s or accuracy > 200 m -> unknown)"). Pure -- the screen owns only the
// watcher lifetime and the rendering.
// ---------------------------------------------------------------------------

/** A fix is only usable while it is this fresh (wall-clock ms since it arrived). */
export const CIRCUIT_FIX_MAX_AGE_MS = 30_000;
/** ...and only this imprecise. A 200 m 1-sigma fix is still two orders of magnitude below the 3 km gate, so anything worse cannot answer "am I at the circuit?" either way. */
export const CIRCUIT_FIX_MAX_ACCURACY_M = 200;

/** One GNSS fix as the preflight watcher records it: position plus the quality/age metadata the guard needs. `tMs` is wall-clock (`Date.now()`), the same clock `nowMs` is read from. */
export interface PreflightFix {
  lat: number;
  lon: number;
  accuracyM?: number | null;
  tMs: number;
}

export type CircuitProximityStatus = 'unknown' | 'near' | 'far';

export interface PreflightProximityDecision {
  status: CircuitProximityStatus;
  /** `null` unless `status` is 'near'/'far' (i.e. a usable fix produced it). */
  distanceKm: number | null;
  /** "Distance to circuit unknown" card. */
  showUnknownCard: boolean;
  /** "You are X km from <circuit>" card. */
  showFarWarning: boolean;
  /** The plain Continue button is enabled ONLY for a usable fix at the circuit. */
  continueEnabled: boolean;
  /** The deliberate testing override stays available whenever the guard is not satisfied. */
  continueAnywayAvailable: boolean;
}

export function evaluatePreflightProximity(
  fix: PreflightFix | null,
  startFinishGate: { a: LatLon; b: LatLon },
  options: {
    nowMs: number;
    /** The rest of preflight passed. While false the existing failure/GNSS-wait UI owns the screen and this guard shows nothing at all. */
    preflightPassed: boolean;
    warnThresholdKm?: number;
    maxFixAgeMs?: number;
    maxAccuracyM?: number;
  },
): PreflightProximityDecision {
  const {
    nowMs,
    preflightPassed,
    warnThresholdKm = CIRCUIT_PROXIMITY_WARN_KM,
    maxFixAgeMs = CIRCUIT_FIX_MAX_AGE_MS,
    maxAccuracyM = CIRCUIT_FIX_MAX_ACCURACY_M,
  } = options;

  if (!preflightPassed) {
    return {
      status: 'unknown',
      distanceKm: null,
      showUnknownCard: false,
      showFarWarning: false,
      continueEnabled: false,
      continueAnywayAvailable: false,
    };
  }

  if (!isUsableFix(fix, nowMs, maxFixAgeMs, maxAccuracyM)) {
    return {
      status: 'unknown',
      distanceKm: null,
      showUnknownCard: true,
      showFarWarning: false,
      continueEnabled: false,
      continueAnywayAvailable: true,
    };
  }

  const { distanceKm, shouldWarn } = evaluateCircuitProximity(fix, startFinishGate, warnThresholdKm);
  return {
    status: shouldWarn ? 'far' : 'near',
    distanceKm,
    showUnknownCard: false,
    showFarWarning: shouldWarn,
    continueEnabled: !shouldWarn,
    continueAnywayAvailable: shouldWarn,
  };
}

function isUsableFix(
  fix: PreflightFix | null,
  nowMs: number,
  maxFixAgeMs: number,
  maxAccuracyM: number,
): fix is PreflightFix {
  if (fix === null) return false;
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return false;
  if (!Number.isFinite(fix.tMs) || nowMs - fix.tMs > maxFixAgeMs) return false;
  // An unreported accuracy is treated as unusable rather than assumed good --
  // "never silently pass" applies to missing metadata too.
  if (fix.accuracyM === undefined || fix.accuracyM === null) return false;
  if (!Number.isFinite(fix.accuracyM) || fix.accuracyM > maxAccuracyM) return false;
  return true;
}
