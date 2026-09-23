import { describe, expect, it } from 'vitest';

import {
  BLOCKING_LIMITATION_CODES,
  analyzeSession,
  blockedCornersFromInsights,
  computeSuggestions,
  cueEvidenceFromInsights,
  sealCueEvidence,
  suggestionsFromInsights,
  verifyCueEvidence,
  type ActiveCue,
  type LimitationCode,
  type SessionAnalysisContext,
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

describe('the geometry gate (E4/P17) — an unsurveyed circuit moves NO CUE', () => {
  /**
   * P17 replaced "MotorPark suggests nothing" with a claim this test can
   * actually defend. The old one rested on "no corner reference point is
   * trustworthy", which is false for a self-comparison: every lap of the
   * outing is projected onto the same centreline and measured through the same
   * `cornerWindows`, so a displaced line moves every lap together and cancels.
   * What genuinely needs a survey is a claim the app ACTS on in the world —
   * a live cue fired at a point it believes it knows. So that is what this
   * test now pins, and it pins it harder: not "the gate was shut" (which any
   * unrelated failure would also satisfy) but "the engine ran, produced
   * evidence-carrying suggestions, and still moved nothing".
   */
  it('MotorPark: pit suggestions ARE produced, and not one cue moves', () => {
    const circuit = motorpark();
    expect(circuit.profile.geometryStatus).not.toBe('official');
    const insights = analyse(circuit);
    expect(insights.cleanLapCount).toBeGreaterThanOrEqual(2);
    expect(insights.limitations.map((entry) => entry.code)).toContain('GEOMETRY_UNVALIDATED');
    expect(insights.geometryProvenance).toBe('mapped');

    const result = suggestionsFromInsights(insights, earlyCues(insights), { enabled: true });
    expect(result.gate).toBe('open');
    expect(result.scope).toBe('self-referential');
    // The cue path: shut, and visibly so. Every corner that HAS a cue is
    // named as skipped with the reason, so silence is legible rather than
    // indistinguishable from "we found nothing".
    expect(result.cueUpdates).toEqual([]);
    expect(result.skipped.length).toBe(insights.corners.length);
    expect(new Set(result.skipped.map((entry) => entry.reason))).toEqual(
      new Set(['geometry-self-referential']),
    );
    // The pit path: open, and every suggestion is still bounded by a lap the
    // driver actually drove -- the invariant that was never about geometry.
    expect(result.pitSuggestions.length).toBeGreaterThan(0);
    for (const suggestion of result.pitSuggestions) {
      expect(suggestion.evidenceLapNumber).toBeGreaterThan(0);
      if (suggestion.unit === 'm') {
        expect(suggestion.targetValue).toBeGreaterThanOrEqual(suggestion.demonstratedValue);
      } else {
        expect(suggestion.targetValue).toBeLessThanOrEqual(suggestion.demonstratedValue);
      }
    }
  });

  /**
   * P17: the unlock needs an explicit statement about the circuit. A caller
   * that describes nothing still gets nothing — P16 C2's property, unchanged
   * and now load-bearing for a wider surface.
   */
  it('a caller that states no provenance at all still gets a closed gate', () => {
    const insights = analyse(motorpark());
    const result = computeSuggestions({
      enabled: true,
      envelope: insights.envelope,
      cues: earlyCues(insights),
    });
    expect(result.gate).toBe('geometry-unvalidated');
    expect(result.scope).toBe('closed');
    expect(result.pitSuggestions).toEqual([]);
    expect(result.cueUpdates).toEqual([]);
  });

  /** P17: a `'surveyed'` claim can never overrule an explicit `false`. */
  it('refuses to be talked into "surveyed" by a contradictory input', () => {
    const insights = analyse(motorpark());
    const result = computeSuggestions({
      enabled: true,
      envelope: insights.envelope,
      cues: earlyCues(insights),
      geometryValidated: false,
      geometry: 'surveyed',
    });
    expect(result.scope).toBe('self-referential');
    expect(result.cueUpdates).toEqual([]);
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

  /**
   * Ticket P16 C2 -- THE INVERSION OF THE TEST THAT USED TO STAND HERE.
   *
   * This case previously asserted `geometryValidated` DEFAULTS TO TRUE: omit
   * the flag and the gate opened. That pinned a safety gate that failed OPEN.
   * Both circuits that ship today are `community-derived`, so the default that
   * applied to every real track was the wrong one, and the caller most likely
   * to omit the flag is precisely the caller that does not know the circuit's
   * provenance.
   *
   * The gate now opens only on an explicit `true`. This is a TIGHTENING: no
   * input that produced silence before produces advice now, and one input that
   * produced advice before (an omitted flag) produces silence -- announced
   * through the same `'geometry-unvalidated'` gate value, so the caller can
   * see why rather than wondering where its suggestions went.
   */
  it('omitting geometryValidated is NOT consent: the gate stays shut', () => {
    const insights = analyse(transilvania());
    const withoutFlag = computeSuggestions({
      enabled: true,
      envelope: insights.envelope,
      cues: earlyCues(insights),
    });
    expect(withoutFlag.gate).toBe('geometry-unvalidated');
    expect(withoutFlag.cueUpdates).toEqual([]);
    expect(withoutFlag.pitSuggestions).toEqual([]);

    // The same call, with the fact stated, is the one that gets advice.
    const stated = computeSuggestions({
      enabled: true,
      envelope: insights.envelope,
      cues: earlyCues(insights),
      geometryValidated: true,
    });
    expect(stated.gate).toBe('open');
  });

  /**
   * Ticket P16 C2 -- and the same at the analysis layer, where the default
   * used to be applied as `context.geometryValidated ?? true`. It is now a
   * REQUIRED field of `SessionAnalysisContext`, so there is no default left to
   * inherit: the type below is the test. A caller cannot reach `analyzeSession`
   * without saying what it knows about the circuit's geometry.
   */
  it('SessionAnalysisContext requires the geometry fact rather than assuming it', () => {
    const withheld: Record<string, unknown> = {
      totalLengthM: 1_000,
      circuitId: 'c',
    };
    // @ts-expect-error -- geometryValidated is required; omitting it must not compile.
    const context: SessionAnalysisContext = withheld;
    expect(context).toBeDefined();

    // And what the caller states is what the insights carry, unmodified.
    expect(analyse(transilvania()).geometryValidated).toBe(true);
    const unvalidated = analyse(motorpark());
    expect(unvalidated.geometryValidated).toBe(false);
    expect(unvalidated.limitations.some((l) => l.code === 'GEOMETRY_UNVALIDATED')).toBe(true);
  });
});

describe('P4 (Codex P5c-REV1 finding 4) — every LimitationCode is an explicit, reviewed blocking decision', () => {
  it('the blocking set is typed against LimitationCode, not a string flag checked ad hoc', () => {
    // A `Record<LimitationCode, boolean>` literal forces every CURRENT member
    // of the type to appear here -- add a new code to `LimitationCode`
    // without a line in this table and TS refuses to compile this test file,
    // rather than the honesty gate silently deciding nothing for it at
    // runtime. `GEOMETRY_UNVALIDATED` blocks the WHOLE session through the
    // separate, session-wide `geometryValidated` gate (E4) -- never through
    // this per-corner set -- so it is deliberately `false` here.
    const expectedBlocking: Record<LimitationCode, boolean> = {
      NO_CLEAN_LAPS: false,
      FEW_CLEAN_LAPS: false,
      UNVERIFIED_LAPS: true,
      UNSUPPORTED_CHANNELS: false,
      MISSING_CHANNELS: false,
      GNSS_QUALITY: true,
      GEOMETRY_UNVALIDATED: false,
      CORNER_COVERAGE: true,
      TIME_INTEGRATION_DRIFT: false,
    };
    for (const code of Object.keys(expectedBlocking) as LimitationCode[]) {
      expect(BLOCKING_LIMITATION_CODES.has(code)).toBe(expectedBlocking[code]);
    }
    // And the set contains ONLY codes this table accounts for -- no member
    // sneaks in some other way.
    for (const code of BLOCKING_LIMITATION_CODES) {
      expect(expectedBlocking[code]).toBe(true);
    }
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
