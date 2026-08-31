import { describe, expect, it } from 'vitest';

import {
  analyzeSession,
  blockedCornersFromInsights,
  computeSuggestions,
  cueEvidenceFromInsights,
  sealCueEvidence,
  suggestionsFromInsights,
  verifyCueEvidence,
  type ActiveCue,
  type SessionInsights,
} from '../../src/coaching';

import { driveCircuitSession, motorpark, transilvania, type TestCircuit } from './circuits';

/**
 * Ticket P5c-FIX1 E4 + E12 (Codex P5c-REV1 findings 4 and 12) — the honesty
 * gates the safety contract's rule 5 already states, now actually consumed by
 * the suggestion engine instead of being computed and discarded.
 *
 *   "Missing channels, poor GNSS, < 2 clean laps, or an unvalidated circuit
 *    geometry (MotorPark today) -> the analysis states the limitation and
 *    degrades (observations without suggestions)."
 *
 * MotorPark is the live case: its geometry is community-derived (OpenStreetMap),
 * so a corner "entry" there is an estimate. Nothing may be suggested on top of
 * an estimate — not a pit suggestion, not a cue move — and this file pins that
 * on the REAL catalog asset, not on a synthetic flag.
 */

function analyse(circuit: TestCircuit, laps = 4): SessionInsights {
  const session = driveCircuitSession(circuit, {
    laps,
    cornerSpeedScales: [0.95, 1, 0.97, 0.93],
    brakeDecelMps2: [3.6, 4.2, 3.9, 3.4],
  });
  return analyzeSession(session, circuit.corners, {
    totalLengthM: circuit.totalLengthM,
    circuitId: circuit.profile.circuitId,
    circuitName: circuit.profile.displayName,
    layoutId: circuit.profile.layoutId,
    geometryValidated: circuit.geometryValidated,
  });
}

/** A deliberately EARLY cue everywhere, so any demonstrated point is later. */
function earlyCues(insights: SessionInsights): ActiveCue[] {
  return insights.corners.map((corner) => ({
    cornerId: corner.cornerId,
    brakeStartM: 400,
    liftPointM: null,
  }));
}

describe('the geometry gate (E4) — an unvalidated circuit suggests NOTHING', () => {
  it('MotorPark: zero suggestions and zero cue updates, on real catalog geometry', () => {
    const circuit = motorpark();
    expect(circuit.profile.geometryStatus).not.toBe('official');
    const insights = analyse(circuit);
    // The analysis itself still runs and still measures the outing...
    expect(insights.cleanLapCount).toBeGreaterThanOrEqual(2);
    expect(insights.limitations.map((entry) => entry.code)).toContain('GEOMETRY_UNVALIDATED');

    const result = suggestionsFromInsights(insights, earlyCues(insights), { enabled: true });
    // ...and says nothing at all about what to do next.
    expect(result.gate).toBe('geometry-unvalidated');
    expect(result.cueUpdates).toEqual([]);
    expect(result.pitSuggestions).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('MotorPark: the sealed evidence is empty too, so no cue can be moved on it', () => {
    const insights = analyse(motorpark());
    const evidence = cueEvidenceFromInsights(insights, {
      sessionId: 'motorpark-outing',
      generation: 1,
      stintIndex: 0,
    });
    expect(verifyCueEvidence(evidence)).toBe(true);
    // Nothing is sealed as demonstrated, so the cue source has no bound to
    // accept -- a caller that skipped the engine entirely still moves nothing.
    expect(evidence.entries).toEqual([]);
  });

  it('Transilvania Motor Ring: the same session, the same engine, suggestions ARE produced', () => {
    const circuit = transilvania();
    expect(circuit.geometryValidated).toBe(true);
    const insights = analyse(circuit);
    const result = suggestionsFromInsights(insights, earlyCues(insights), { enabled: true });
    expect(result.gate).toBe('open');
    expect(result.pitSuggestions.length).toBeGreaterThan(0);
  });

  it('corner ids line up with the catalog on BOTH circuits (E12)', () => {
    for (const circuit of [transilvania(), motorpark()]) {
      const insights = analyse(circuit);
      const catalogIds = [...circuit.corners].map((corner) => corner.id).sort((a, b) => a - b);
      expect(insights.corners.map((corner) => corner.cornerId)).toEqual(catalogIds);
      expect(insights.envelope.corners.map((corner) => corner.cornerId)).toEqual(catalogIds);
    }
  });
});

describe('the per-corner honesty gates (E4)', () => {
  it('blocks a corner whose evidence rests on a lap the engine could not verify', () => {
    const insights = analyse(transilvania());
    const corner = insights.envelope.corners.find((entry) => entry.evidenceLapIds.length > 0);
    if (corner === undefined) throw new Error('expected a corner with evidence');
    const tainted: SessionInsights = {
      ...insights,
      limitations: [
        ...insights.limitations,
        {
          code: 'UNVERIFIED_LAPS',
          count: corner.evidenceLapIds.length,
          lapNumbers: [...corner.evidenceLapIds],
        },
      ],
    };
    expect(blockedCornersFromInsights(tainted)).toContain(corner.cornerId);

    const result = suggestionsFromInsights(tainted, earlyCues(insights), { enabled: true });
    expect(result.pitSuggestions.some((s) => s.cornerId === corner.cornerId)).toBe(false);
    expect(result.cueUpdates.some((u) => u.cornerId === corner.cornerId)).toBe(false);
    expect(
      result.skipped.some(
        (skip) => skip.cornerId === corner.cornerId && skip.reason === 'honesty-gate',
      ),
    ).toBe(true);
  });

  it('blocks a corner no lap covered (CORNER_COVERAGE)', () => {
    const insights = analyse(transilvania());
    const cornerId = insights.corners[0]!.cornerId;
    const gated: SessionInsights = {
      ...insights,
      limitations: [...insights.limitations, { code: 'CORNER_COVERAGE', cornerIds: [cornerId], count: 1 }],
    };
    const result = suggestionsFromInsights(gated, earlyCues(insights), { enabled: true });
    expect(result.pitSuggestions.some((s) => s.cornerId === cornerId)).toBe(false);
    expect(result.cueUpdates.some((u) => u.cornerId === cornerId)).toBe(false);
  });

  it('a corner that passed every gate is still suggested on', () => {
    const insights = analyse(transilvania());
    const cornerId = insights.corners[0]!.cornerId;
    const gated: SessionInsights = {
      ...insights,
      limitations: [...insights.limitations, { code: 'CORNER_COVERAGE', cornerIds: [cornerId], count: 1 }],
    };
    const result = suggestionsFromInsights(gated, earlyCues(insights), { enabled: true });
    expect(result.pitSuggestions.length).toBeGreaterThan(0);
    expect(result.pitSuggestions.every((s) => s.cornerId !== cornerId)).toBe(true);
  });

  it('geometryValidated defaults to true for a caller passing a synthetic envelope', () => {
    const insights = analyse(transilvania());
    const withoutFlag = computeSuggestions({
      enabled: true,
      envelope: insights.envelope,
      cues: earlyCues(insights),
    });
    expect(withoutFlag.gate).toBe('open');
  });
});

describe('sealed cue evidence (E2)', () => {
  it('seals, verifies, and detects any mutation of the entries', () => {
    const insights = analyse(transilvania());
    const evidence = cueEvidenceFromInsights(insights, {
      sessionId: 'outing-1',
      generation: 3,
      stintIndex: 2,
    });
    expect(evidence.entries.length).toBeGreaterThan(0);
    expect(verifyCueEvidence(evidence)).toBe(true);

    const first = evidence.entries[0]!;
    expect(
      verifyCueEvidence({
        ...evidence,
        entries: [{ ...first, demonstratedM: first.demonstratedM - 25 }, ...evidence.entries.slice(1)],
      }),
    ).toBe(false);
    expect(verifyCueEvidence({ ...evidence, sessionId: 'outing-2' })).toBe(false);
    expect(verifyCueEvidence({ ...evidence, generation: 4 })).toBe(false);
    expect(verifyCueEvidence({ ...evidence, stintIndex: 3 })).toBe(false);
    // Dropping an entry is a mutation too.
    expect(verifyCueEvidence({ ...evidence, entries: evidence.entries.slice(1) })).toBe(false);
  });

  it('is order-independent and deterministic', () => {
    const entries = [
      { cornerId: 2, point: 'brake' as const, demonstratedM: 120, evidenceLapNumber: 3, cleanLapCount: 4 },
      { cornerId: 1, point: 'lift' as const, demonstratedM: 200, evidenceLapNumber: 2, cleanLapCount: 4 },
    ];
    const context = { sessionId: 'o', generation: 1, stintIndex: 0 };
    const forward = sealCueEvidence({ ...context, entries });
    const reversed = sealCueEvidence({ ...context, entries: [...entries].reverse() });
    expect(forward.checksum).toBe(reversed.checksum);
    expect(forward.checksum).toMatch(/^[0-9a-f]{8}$/);
  });

  it('carries BOTH the brake and the lift bound for every corner with evidence (E3)', () => {
    const insights = analyse(transilvania());
    const evidence = cueEvidenceFromInsights(insights, {
      sessionId: 'outing-1',
      generation: 1,
      stintIndex: 0,
    });
    const points = new Set(evidence.entries.map((entry) => entry.point));
    expect(points.has('brake')).toBe(true);
    expect(points.has('lift')).toBe(true);
    for (const entry of evidence.entries) {
      expect(Number.isFinite(entry.demonstratedM)).toBe(true);
      expect(Number.isFinite(entry.evidenceLapNumber)).toBe(true);
    }
  });
});
