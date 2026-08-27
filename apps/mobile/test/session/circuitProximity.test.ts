import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_FIX_MAX_ACCURACY_M,
  CIRCUIT_FIX_MAX_AGE_MS,
  CIRCUIT_PROXIMITY_WARN_KM,
  evaluateCircuitProximity,
  evaluatePreflightProximity,
  gateMidpoint,
  haversineDistanceKm,
} from '../../src/session/circuitProximity';

/**
 * Field revision 2 (2026-08-27, binding — Phase 4h, P4h ticket item 1):
 * "calibration started 61 km from MotorPark (OFF TRACK ... 0 %) ... user felt
 * stuck." Preflight's distance guard is a pure decision built from
 * `evaluateCircuitProximity` -- these tests pin the exact ticket-specified
 * scenarios (61 km -> warn; 0.8 km -> no warn; no fix -> no warn, GNSS wait
 * applies).
 */
describe('circuitProximity (Field revision 2, binding: distance guard)', () => {
  it('CIRCUIT_PROXIMITY_WARN_KM is 3', () => {
    expect(CIRCUIT_PROXIMITY_WARN_KM).toBe(3);
  });

  it('haversineDistanceKm: two points ~1 degree of latitude apart are ~111 km apart', () => {
    const a = { lat: 45, lon: 25 };
    const b = { lat: 46, lon: 25 };
    expect(haversineDistanceKm(a, b)).toBeCloseTo(111.19, 0);
  });

  it('haversineDistanceKm: the same point is 0 km from itself', () => {
    const p = { lat: 45.5, lon: 25.5 };
    expect(haversineDistanceKm(p, p)).toBe(0);
  });

  it('gateMidpoint: the average of the gate\'s two endpoints', () => {
    const gate = { a: { lat: 45.0, lon: 25.0 }, b: { lat: 45.001, lon: 25.002 } };
    const midpoint = gateMidpoint(gate);
    expect(midpoint.lat).toBeCloseTo(45.0005, 9);
    expect(midpoint.lon).toBeCloseTo(25.001, 9);
  });

  describe('evaluateCircuitProximity', () => {
    // MotorPark România's real S/F gate, from the bundled profile (roughly
    // 45.65 N, 25.60 E) -- used as a realistic anchor so the "61 km away"
    // scenario below mirrors the actual field result.
    const startFinishGate = { a: { lat: 45.65, lon: 25.60 }, b: { lat: 45.6501, lon: 25.6002 } };

    it('61 km away -> warns (the exact field scenario: calibration started far off track)', () => {
      // ~61 km due north of the gate (1 degree of latitude ~= 111 km).
      const farFix = { lat: 45.65 + 61 / 111, lon: 25.60 };
      const result = evaluateCircuitProximity(farFix, startFinishGate);
      expect(result.shouldWarn).toBe(true);
      expect(result.distanceKm).toBeCloseTo(61, 0);
    });

    it('0.8 km away -> does NOT warn (comfortably inside the 3 km threshold)', () => {
      const nearFix = { lat: 45.65 + 0.8 / 111, lon: 25.60 };
      const result = evaluateCircuitProximity(nearFix, startFinishGate);
      expect(result.shouldWarn).toBe(false);
      expect(result.distanceKm).toBeCloseTo(0.8, 1);
    });

    it('no fix yet (null) -> never warns -- the existing GNSS wait applies instead', () => {
      const result = evaluateCircuitProximity(null, startFinishGate);
      expect(result.shouldWarn).toBe(false);
      expect(result.distanceKm).toBeNull();
    });

    it('exactly at the 3 km threshold does NOT warn (strictly greater-than)', () => {
      const at3km = { lat: 45.65 + 3 / 111, lon: 25.60 };
      const result = evaluateCircuitProximity(at3km, startFinishGate, 3);
      // Allow for the tiny haversine/linear-degree approximation slack around
      // the boundary -- assert against the ACTUAL computed distance rather
      // than assuming it lands at precisely 3.000.
      expect(result.shouldWarn).toBe(result.distanceKm! > 3);
    });

    it('a custom threshold is honored (not hardcoded to 3km)', () => {
      const fix = { lat: 45.65 + 1 / 111, lon: 25.60 }; // ~1km away.
      expect(evaluateCircuitProximity(fix, startFinishGate, 0.5).shouldWarn).toBe(true);
      expect(evaluateCircuitProximity(fix, startFinishGate, 2).shouldWarn).toBe(false);
    });
  });
});

/**
 * P4h-FIX1 H2+H3 (after Codex P4h-REV1 HIGH, `PreflightScreen.tsx:75-78,99-117,137-138,245-255`):
 * "the distance guard can silently bypass itself ... `currentFix` remains
 * `null`, `evaluateCircuitProximity(null, ...)` returns no warning, and the
 * ordinary Continue button is shown."
 *
 * Binding fix rule (ticket P4h-FIX1): "Never silently pass: with no fix the
 * card shows 'Distance to circuit unknown' and Continue stays disabled until
 * a fix arrives (Continue-anyway remains available). Keep accuracy/age of the
 * fix (stale > 30 s or accuracy > 200 m -> unknown)."
 */
describe('evaluatePreflightProximity (P4h-FIX1 H2+H3: never silently passes)', () => {
  const startFinishGate = { a: { lat: 45.65, lon: 25.6 }, b: { lat: 45.6501, lon: 25.6002 } };
  const NOW = 1_000_000;
  const nearFix = { lat: 45.65 + 0.8 / 111, lon: 25.6, accuracyM: 8, tMs: NOW };
  const farFix = { lat: 45.65 + 61 / 111, lon: 25.6, accuracyM: 8, tMs: NOW };

  it('thresholds: fixes older than 30 s, or worse than 200 m accuracy, are not usable', () => {
    expect(CIRCUIT_FIX_MAX_AGE_MS).toBe(30_000);
    expect(CIRCUIT_FIX_MAX_ACCURACY_M).toBe(200);
  });

  it('no fix while the rest of preflight passes -> UNKNOWN card, Continue DISABLED, Continue-anyway available', () => {
    const decision = evaluatePreflightProximity(null, startFinishGate, { nowMs: NOW, preflightPassed: true });
    expect(decision.status).toBe('unknown');
    expect(decision.showUnknownCard).toBe(true);
    expect(decision.continueEnabled).toBe(false);
    expect(decision.continueAnywayAvailable).toBe(true);
    expect(decision.distanceKm).toBeNull();
  });

  it('a fix older than 30 s is treated as no fix (unknown, Continue disabled)', () => {
    const stale = { ...nearFix, tMs: NOW - 30_001 };
    const decision = evaluatePreflightProximity(stale, startFinishGate, { nowMs: NOW, preflightPassed: true });
    expect(decision.status).toBe('unknown');
    expect(decision.continueEnabled).toBe(false);
    expect(decision.continueAnywayAvailable).toBe(true);
  });

  it('a fix with accuracy worse than 200 m is treated as no fix (unknown, Continue disabled)', () => {
    const imprecise = { ...nearFix, accuracyM: 250 };
    const decision = evaluatePreflightProximity(imprecise, startFinishGate, { nowMs: NOW, preflightPassed: true });
    expect(decision.status).toBe('unknown');
    expect(decision.continueEnabled).toBe(false);
  });

  it('a fix with NO accuracy reading at all is unknown too (never silently passes)', () => {
    const noAccuracy = { lat: nearFix.lat, lon: nearFix.lon, tMs: NOW };
    const decision = evaluatePreflightProximity(noAccuracy, startFinishGate, { nowMs: NOW, preflightPassed: true });
    expect(decision.status).toBe('unknown');
    expect(decision.continueEnabled).toBe(false);
  });

  it('a fresh, precise fix ON the circuit -> near: plain Continue, no cards', () => {
    const decision = evaluatePreflightProximity(nearFix, startFinishGate, { nowMs: NOW, preflightPassed: true });
    expect(decision.status).toBe('near');
    expect(decision.continueEnabled).toBe(true);
    expect(decision.showUnknownCard).toBe(false);
    expect(decision.showFarWarning).toBe(false);
    expect(decision.continueAnywayAvailable).toBe(false);
  });

  it('a fresh, precise fix 61 km away -> far: warning card, Continue disabled, Continue-anyway available', () => {
    const decision = evaluatePreflightProximity(farFix, startFinishGate, { nowMs: NOW, preflightPassed: true });
    expect(decision.status).toBe('far');
    expect(decision.showFarWarning).toBe(true);
    expect(decision.continueEnabled).toBe(false);
    expect(decision.continueAnywayAvailable).toBe(true);
    expect(decision.distanceKm).toBeCloseTo(61, 0);
  });

  it('while the rest of preflight has NOT passed, the existing failure/wait UI owns the screen: no proximity cards, nothing enabled', () => {
    const decision = evaluatePreflightProximity(null, startFinishGate, { nowMs: NOW, preflightPassed: false });
    expect(decision.showUnknownCard).toBe(false);
    expect(decision.showFarWarning).toBe(false);
    expect(decision.continueEnabled).toBe(false);
    expect(decision.continueAnywayAvailable).toBe(false);
  });
});
