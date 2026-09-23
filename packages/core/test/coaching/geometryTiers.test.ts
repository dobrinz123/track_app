import { describe, expect, it } from 'vitest';

import {
  analyzeSession,
  computeSuggestions,
  geometryProvenanceOf,
  normalizeDistance,
  pitSuggestionLine,
  renderReport,
  resolveGeometryProvenance,
  suggestionsFromInsights,
  type ActiveCue,
  type CornerLapSample,
  type SessionInsights,
  type SessionLapInput,
} from '../../src/coaching';
import { analyzeCorners } from '../../src/corners';
import type { Corner } from '../../src/contracts';
import { polylineLength } from '../../src/geometry';
import { buildTestLoopCircuit } from '../../src/testloop';

import { driveCircuitSession, motorpark, transilvania, type TestCircuit } from './circuits';
import { sampleDensePath, wigglyLoopPath } from '../testloop/traces';

/**
 * Ticket P17 — the graduated geometry gate, and the claim it rests on.
 *
 * The old gate was binary: `geometryStatus === 'official'` or no advice at all.
 * Nothing in the pipeline can produce `'official'` without somebody surveying a
 * track, so the deterministic coaching engine shipped switched off for every
 * user on every circuit.
 *
 * The claim that changes the problem is that the engine's advice is
 * SELF-REFERENTIAL: every number the driver is shown compares their own laps
 * with each other through the same distance windows. §1 below proves that
 * structurally rather than asserting it — the whole analysis is run twice, once
 * on a centreline whose distance origin has been displaced by 137 m, and every
 * self-referential number comes back the same to within floating-point noise
 * (see {@link INVARIANCE_TOLERANCE}; the rendered SENTENCES are byte-identical)
 * while the absolute ones move by exactly the displacement.
 *
 * §2 is the product half: the three tiers, as text a driver reads.
 */

const DISPLACEMENT_M = 137;

/** The same corner list with every distance moved along the lap by `deltaM`. */
function displaceCorners(corners: readonly Corner[], totalLengthM: number, deltaM: number): Corner[] {
  return corners.map((corner) => ({
    ...corner,
    entryDistanceM: normalizeDistance(corner.entryDistanceM + deltaM, totalLengthM),
    apexDistanceM: normalizeDistance(corner.apexDistanceM + deltaM, totalLengthM),
    exitDistanceM: normalizeDistance(corner.exitDistanceM + deltaM, totalLengthM),
  }));
}

/** The same drive, projected onto that displaced line. */
function displaceSession(
  session: readonly SessionLapInput[],
  totalLengthM: number,
  deltaM: number,
): SessionLapInput[] {
  const move = (sample: CornerLapSample): CornerLapSample => ({
    ...sample,
    distanceM: normalizeDistance(sample.distanceM + deltaM, totalLengthM),
  });
  return session.map((lap) => ({ ...lap, samples: lap.samples.map(move) }));
}

/**
 * The invariance is EXACT in the mathematics and float-exact in the code to
 * about twelve significant figures: displacing the origin re-orders a handful
 * of `+`/`-` on wrapped distances, so the last bits of a double differ. This
 * tolerance is far below anything a report prints (metres to 0 dp, km/h and g
 * to 1-2 dp, seconds to 2 dp), so a difference this size can never reach a
 * driver -- but it is asserted as a number rather than waved away, because a
 * REAL dependence on absolute position would blow straight through it.
 */
const INVARIANCE_TOLERANCE = 1e-6;

function expectSameNumbers(
  actual: readonly (number | null)[],
  expected: readonly (number | null)[],
): void {
  expect(actual.length).toBe(expected.length);
  for (const [index, value] of expected.entries()) {
    const other = actual[index];
    if (value === null || other === null || other === undefined) {
      expect(other ?? null).toBe(value);
      continue;
    }
    expect(Math.abs(other - value)).toBeLessThan(INVARIANCE_TOLERANCE);
  }
}

function analyse(
  circuit: TestCircuit,
  overrides: Partial<Parameters<typeof analyzeSession>[2]> = {},
  laps = 4,
): SessionInsights {
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
    ...overrides,
  });
}

function earlyCues(insights: SessionInsights): ActiveCue[] {
  return insights.corners.map((corner) => ({
    cornerId: corner.cornerId,
    brakeStartM: 400,
    liftPointM: null,
  }));
}

// ---------------------------------------------------------------------------
// §1 The invariance the gate rests on
// ---------------------------------------------------------------------------

describe('P17 §1 — a consistent geometric offset changes nothing the driver is told', () => {
  const circuit = motorpark();
  const session = driveCircuitSession(circuit, {
    laps: 4,
    cornerSpeedScales: [0.95, 1, 0.97, 0.93],
    brakeDecelMps2: [3.6, 4.2, 3.9, 3.4],
  });
  const context = {
    totalLengthM: circuit.totalLengthM,
    circuitId: circuit.profile.circuitId,
    geometryValidated: false,
    geometryProvenance: 'mapped' as const,
  };
  const straight = analyzeSession(session, circuit.corners, context);
  const displaced = analyzeSession(
    displaceSession(session, circuit.totalLengthM, DISPLACEMENT_M),
    displaceCorners(circuit.corners, circuit.totalLengthM, DISPLACEMENT_M),
    context,
  );

  it('produces the same per-corner measurements from the same windows', () => {
    expect(displaced.corners.length).toBe(straight.corners.length);
    for (const [index, corner] of straight.corners.entries()) {
      const other = displaced.corners[index]!;
      expect(other.cornerId).toBe(corner.cornerId);
      // Speeds and g are measurements of the CAR, taken over a window that
      // moved with the line: identical.
      expectSameNumbers(
        other.perLap.map((row) => row.minSpeedKph),
        corner.perLap.map((row) => row.minSpeedKph),
      );
      expectSameNumbers(
        other.perLap.map((row) => row.exitSpeedKph),
        corner.perLap.map((row) => row.exitSpeedKph),
      );
      expectSameNumbers(
        other.perLap.map((row) => row.peakDecelG),
        corner.perLap.map((row) => row.peakDecelG),
      );
      // A braking point is metres BEFORE the entry, so it is a difference of
      // two displaced distances and the displacement cancels.
      expectSameNumbers(
        other.perLap.map((row) => row.brakeStartM),
        corner.perLap.map((row) => row.brakeStartM),
      );
      // The time comparisons, which are what the driver is actually told.
      expectSameNumbers(
        other.perLap.map((row) => row.sectorMs),
        corner.perLap.map((row) => row.sectorMs),
      );
      expectSameNumbers(
        [
          other.timeLoss?.deltaMs ?? null,
          other.envelope?.latestBrakeStartM ?? null,
          other.envelope?.highestMinSpeedKph ?? null,
        ],
        [
          corner.timeLoss?.deltaMs ?? null,
          corner.envelope?.latestBrakeStartM ?? null,
          corner.envelope?.highestMinSpeedKph ?? null,
        ],
      );
      // The consistency SCORE is an integer 0-100: exactly equal, no tolerance.
      expect(other.consistency?.score ?? null).toEqual(corner.consistency?.score ?? null);
    }
  });

  it('produces the same rankings, the same clean laps and the same suggestions', () => {
    expect(displaced.cleanLapCount).toBe(straight.cleanLapCount);
    expect(displaced.referenceLapNumber).toBe(straight.referenceLapNumber);
    // The ORDER of the ranking -- which corner the driver is sent to first --
    // is identical, exactly.
    expect(displaced.timeLossRanking.map((entry) => entry.cornerId)).toEqual(
      straight.timeLossRanking.map((entry) => entry.cornerId),
    );
    expectSameNumbers(
      displaced.timeLossRanking.map((entry) => entry.deltaMs),
      straight.timeLossRanking.map((entry) => entry.deltaMs),
    );
    expect(displaced.consistencyRanking.map((entry) => [entry.cornerId, entry.score])).toEqual(
      straight.consistencyRanking.map((entry) => [entry.cornerId, entry.score]),
    );

    const a = suggestionsFromInsights(straight, earlyCues(straight), { enabled: true });
    const b = suggestionsFromInsights(displaced, earlyCues(displaced), { enabled: true });
    expect(a.pitSuggestions.length).toBeGreaterThan(0);
    expect(b.pitSuggestions.map((entry) => [entry.cornerId, entry.kind, entry.evidenceLapNumber])).toEqual(
      a.pitSuggestions.map((entry) => [entry.cornerId, entry.kind, entry.evidenceLapNumber]),
    );
    expectSameNumbers(
      b.pitSuggestions.map((entry) => entry.targetValue),
      a.pitSuggestions.map((entry) => entry.targetValue),
    );
    expectSameNumbers(
      b.pitSuggestions.map((entry) => entry.deltaValue),
      a.pitSuggestions.map((entry) => entry.deltaValue),
    );
    // And the SENTENCES, which is what the driver actually reads, are
    // byte-identical -- the rounding never survives formatting.
    expect(b.pitSuggestions.map((entry) => pitSuggestionLine(entry, 'en', 'mapped'))).toEqual(
      a.pitSuggestions.map((entry) => pitSuggestionLine(entry, 'en', 'mapped')),
    );
  });

  it('moves the ABSOLUTE claims — and only those — by exactly the displacement', () => {
    for (const [index, corner] of straight.corners.entries()) {
      const other = displaced.corners[index]!;
      expect(other.apexDistanceM).toBeCloseTo(
        normalizeDistance(corner.apexDistanceM + DISPLACEMENT_M, circuit.totalLengthM),
        6,
      );
    }
    // Which is the whole point: the one thing the offset breaks is the one
    // thing the graduated gate refuses to claim.
    const apexes = straight.corners.map((corner) => corner.apexDistanceM);
    const moved = displaced.corners.map((corner) => corner.apexDistanceM);
    expect(moved).not.toEqual(apexes);
  });
});

// ---------------------------------------------------------------------------
// §2 The three tiers, as the driver reads them
// ---------------------------------------------------------------------------

/** A circuit learned the way the app learns one: from a single driven lap. */
function learnedCircuit(): TestCircuit {
  const built = buildTestLoopCircuit(sampleDensePath(wigglyLoopPath(), { laps: 2 }), {
    circuitId: 'learned-p17',
    displayName: 'Learned loop',
    createdAtUtc: '2026-09-23T09:00:00.000Z',
  });
  if (!built.ok) throw new Error(`could not learn a circuit: ${built.reason}`);
  return {
    profile: built.profile,
    runtime: built.runtime,
    corners: analyzeCorners(built.runtime),
    totalLengthM: polylineLength(built.runtime.centerline),
    geometryValidated: false,
  };
}

describe('P17 §2 — the three tiers say three different things', () => {
  it('maps every catalog geometryStatus onto exactly one tier', () => {
    expect(geometryProvenanceOf('official')).toBe('surveyed');
    expect(geometryProvenanceOf('community-derived')).toBe('mapped');
    expect(geometryProvenanceOf('dev-only')).toBe('mapped');
    expect(geometryProvenanceOf('ad-hoc')).toBe('learned');
    expect(learnedCircuit().profile.geometryStatus).toBe('ad-hoc');
  });

  it('never resolves to "surveyed" over an explicit geometryValidated: false', () => {
    expect(resolveGeometryProvenance(false, 'surveyed')).toBe('mapped');
    expect(resolveGeometryProvenance(false, undefined)).toBe('mapped');
    expect(resolveGeometryProvenance(false, 'learned')).toBe('learned');
    expect(resolveGeometryProvenance(true, undefined)).toBe('surveyed');
    // A narrower claim next to a `true` flag still wins: stating where the
    // line came from can only ever reduce what is said about it.
    expect(resolveGeometryProvenance(true, 'mapped')).toBe('mapped');
  });

  it('surveyed: the corner is the circuit\'s, and the report claims it plainly', () => {
    const insights = analyse(transilvania());
    expect(insights.geometryProvenance).toBe('surveyed');
    const en = renderReport(insights, 'en');
    expect(en).toMatch(/^Corner 1 \((left|right)\)$/m);
    expect(en).toContain('Position on the lap:');
    expect(en).not.toContain('our numbering');
    expect(en).not.toContain('Corner numbers and positions are ours');

    const suggestions = suggestionsFromInsights(insights, earlyCues(insights), { enabled: true });
    expect(suggestions.scope).toBe('surveyed');
    expect(suggestions.cueUpdates.length).toBeGreaterThan(0);
  });

  it('mapped: the same numbers, and every naming of a corner says whose it is', () => {
    const insights = analyse(motorpark());
    expect(insights.geometryProvenance).toBe('mapped');
    const en = renderReport(insights, 'en');
    const ro = renderReport(insights, 'ro');
    expect(en).toMatch(/^Corner 1 \((left|right), our numbering\)$/m);
    expect(en).toContain('Position on the line we traced');
    expect(en).toContain('is our reading of a map trace');
    expect(en).toContain('Comparisons between your own laps are unaffected');
    expect(ro).toMatch(/^Virajul 1 \((stânga|dreapta), numerotarea noastră\)$/m);
    expect(ro).toContain('Poziția pe linia trasată de noi');
    // Nothing in either language can render a placeholder.
    expect(`${en}\n${ro}`).not.toMatch(/undefined|NaN/);

    const suggestions = suggestionsFromInsights(insights, earlyCues(insights), { enabled: true });
    expect(suggestions.scope).toBe('self-referential');
    expect(suggestions.pitSuggestions.length).toBeGreaterThan(0);
    expect(suggestions.cueUpdates).toEqual([]);
    for (const suggestion of suggestions.pitSuggestions) {
      expect(pitSuggestionLine(suggestion, 'en', insights.geometryProvenance)).toContain(
        '(our numbering)',
      );
      expect(pitSuggestionLine(suggestion, 'ro', insights.geometryProvenance)).toContain(
        '(numerotarea noastră)',
      );
    }
  });

  it('learned: a real on-device loop is analysed, and named as the driver\'s own line', () => {
    const circuit = learnedCircuit();
    expect(circuit.corners.length).toBeGreaterThan(0);
    const insights = analyse(
      circuit,
      { geometryProvenance: geometryProvenanceOf(circuit.profile.geometryStatus) },
      3,
    );
    expect(insights.geometryProvenance).toBe('learned');
    const en = renderReport(insights, 'en');
    const ro = renderReport(insights, 'ro');
    expect(en).toContain('Position on the line learned from your own lap');
    expect(en).toContain('is our reading of the single lap you drove to learn this track');
    expect(en).toContain('This track was learned from one lap you drove, not surveyed.');
    expect(en).not.toContain('traced from a map');
    expect(ro).toContain('Poziția pe linia învățată din turul tău');
    expect(`${en}\n${ro}`).not.toMatch(/undefined|NaN/);

    const suggestions = computeSuggestions({
      enabled: true,
      envelope: insights.envelope,
      cues: earlyCues(insights),
      geometryValidated: false,
      geometry: 'learned',
    });
    expect(suggestions.scope).toBe('self-referential');
    expect(suggestions.cueUpdates).toEqual([]);
  });
});
