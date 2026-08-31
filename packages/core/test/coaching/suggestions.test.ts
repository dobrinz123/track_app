import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_BRAKE_LATER_M,
  MAX_MIN_SPEED_GAIN_KPH,
  MIN_CLEAN_LAPS_FOR_SUGGESTIONS,
  buildDemonstratedEnvelope,
  computeSuggestions,
  cueUpdateLine,
  pitSuggestionLine,
  type ActiveCue,
  type CleanLapMetrics,
  type CornerMetrics,
  type DemonstratedEnvelope,
} from '../../src/coaching';
import { CORNER_ANALYSIS_VERSION } from '../../src/contracts';

/**
 * Ticket P5c-B D1/D5 — the suggestion engine's SAFETY invariants, not its
 * prose. Everything here is written against contracts.md R2-3 and the Phase 5
 * safety contract's own constants: a cue may only ever move to a value a clean
 * lap of the SAME outing already demonstrated, by at most
 * `MAX_BRAKE_LATER_M` / `MAX_MIN_SPEED_GAIN_KPH`, once per corner per stint,
 * and only when `suggestionsEnabled` is on and the outing has enough clean
 * evidence.
 */

function metric(overrides: Partial<CornerMetrics> & { cornerId: number }): CornerMetrics {
  return {
    analysisVersion: CORNER_ANALYSIS_VERSION,
    liftPointM: 260,
    liftSource: 'decelOnset',
    brakeStartM: 200,
    brakeSource: 'gpsSpeed',
    brakeOnsetUncertaintyM: null,
    peakDecelG: 0.9,
    minSpeedKph: 70,
    minSpeedPositionM: 640,
    entrySpeedKph: 120,
    exitSpeedKph: 90,
    maxLatG: 1.1,
    maxLatGSource: 'imu',
    sectorMs: 3_000,
    sampleCount: 30,
    quality: { ok: true, flags: [], worstAccuracyM: 4, maxSampleGapMs: 250 },
    minSpeedVsApexM: 5,
    throttleOnM: 12,
    throttleOnSource: 'accelPedalPct',
    fullThrottleFraction: 0.4,
    frictionCircleMaxG: 1.2,
    turnInM: 20,
    turnInSource: null,
    steeringSmoothness: null,
    steeringCorrections: null,
    ...overrides,
  };
}

function lap(lapNumber: number, corners: CornerMetrics[]): CleanLapMetrics {
  return { lapNumber, corners };
}

/** Three clean laps of one corner: latest brake 170 m, earliest lift 280 m, best v_min 76. */
const CLEAN_LAPS: CleanLapMetrics[] = [
  lap(1, [metric({ cornerId: 1, brakeStartM: 200, liftPointM: 280, minSpeedKph: 70 })]),
  lap(2, [metric({ cornerId: 1, brakeStartM: 170, liftPointM: 250, minSpeedKph: 76 })]),
  lap(3, [metric({ cornerId: 1, brakeStartM: 185, liftPointM: 265, minSpeedKph: 73 })]),
];

const ENVELOPE: DemonstratedEnvelope = buildDemonstratedEnvelope(CLEAN_LAPS);

function cue(brakeStartM: number | null, liftPointM: number | null = null): ActiveCue[] {
  return [{ cornerId: 1, brakeStartM, liftPointM }];
}

describe('computeSuggestions — the gate (D5)', () => {
  it('produces NOTHING at all when suggestions are disabled (default OFF)', () => {
    const result = computeSuggestions({ enabled: false, envelope: ENVELOPE, cues: cue(220) });
    expect(result.gate).toBe('disabled');
    expect(result.cueUpdates).toEqual([]);
    expect(result.pitSuggestions).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('produces NOTHING with fewer than two clean laps in the outing', () => {
    const thin = buildDemonstratedEnvelope([CLEAN_LAPS[0] as CleanLapMetrics]);
    expect(thin.cleanLapCount).toBeLessThan(MIN_CLEAN_LAPS_FOR_SUGGESTIONS);
    const result = computeSuggestions({ enabled: true, envelope: thin, cues: cue(220) });
    expect(result.gate).toBe('insufficient-clean-laps');
    expect(result.cueUpdates).toEqual([]);
    expect(result.pitSuggestions).toEqual([]);
  });

  it('produces nothing for a corner with no demonstrated evidence at all', () => {
    const blind = buildDemonstratedEnvelope([
      lap(1, [metric({ cornerId: 1, brakeStartM: null, liftPointM: null, minSpeedKph: null })]),
      lap(2, [metric({ cornerId: 1, brakeStartM: null, liftPointM: null, minSpeedKph: null })]),
    ]);
    const result = computeSuggestions({ enabled: true, envelope: blind, cues: cue(220) });
    expect(result.gate).toBe('open');
    expect(result.cueUpdates).toEqual([]);
    expect(result.pitSuggestions).toEqual([]);
    expect(result.skipped.map((entry) => entry.reason)).toContain('insufficient-data');
  });
});

describe('computeSuggestions — cue updates (D1a)', () => {
  it('moves the brake cue later, but never past what a clean lap demonstrated', () => {
    const result = computeSuggestions({ enabled: true, envelope: ENVELOPE, cues: cue(175) });
    const update = result.cueUpdates[0];
    expect(update?.point).toBe('brake');
    expect(update?.fromM).toBe(175);
    expect(update?.toM).toBe(170);
    expect(update?.demonstratedM).toBe(170);
    expect(update?.evidenceLapNumber).toBe(2);
    expect(update?.movedLaterM).toBe(5);
  });

  it('clamps a bigger gap to MAX_BRAKE_LATER_M and stops short of the demonstrated value', () => {
    const result = computeSuggestions({ enabled: true, envelope: ENVELOPE, cues: cue(260) });
    const update = result.cueUpdates[0];
    expect(update?.toM).toBe(250);
    expect(update?.movedLaterM).toBe(MAX_BRAKE_LATER_M);
    expect(update?.toM).toBeGreaterThan(ENVELOPE.corners[0]?.latestBrakeStartM ?? 0);
  });

  it('never moves a cue the driver has not out-braked (demonstrated is not later)', () => {
    const result = computeSuggestions({ enabled: true, envelope: ENVELOPE, cues: cue(160) });
    expect(result.cueUpdates).toEqual([]);
    expect(result.skipped.map((entry) => entry.reason)).toContain('nothing-demonstrated-later');
  });

  it('makes at most ONE change per corner per stint — a corner already moved is skipped', () => {
    const result = computeSuggestions({
      enabled: true,
      envelope: ENVELOPE,
      cues: cue(260, 320),
      updatedCornerIds: [1],
    });
    expect(result.cueUpdates).toEqual([]);
    expect(result.skipped.map((entry) => entry.reason)).toContain('already-updated-this-stint');
  });

  it('emits ONE update for a corner whose brake AND lift cue could both move', () => {
    const result = computeSuggestions({ enabled: true, envelope: ENVELOPE, cues: cue(260, 320) });
    expect(result.cueUpdates).toHaveLength(1);
    expect(result.cueUpdates[0]?.point).toBe('brake');
  });

  it('moves the lift cue when there is no brake cue to move', () => {
    const result = computeSuggestions({ enabled: true, envelope: ENVELOPE, cues: cue(null, 320) });
    const update = result.cueUpdates[0];
    expect(update?.point).toBe('lift');
    expect(update?.demonstratedM).toBe(250);
    expect(update?.toM).toBe(310);
  });

  it('is deterministic: shuffled cue input produces byte-identical output', () => {
    const many = buildDemonstratedEnvelope([
      lap(1, [
        metric({ cornerId: 3, brakeStartM: 200 }),
        metric({ cornerId: 1, brakeStartM: 210 }),
        metric({ cornerId: 2, brakeStartM: 190 }),
      ]),
      lap(2, [
        metric({ cornerId: 2, brakeStartM: 170 }),
        metric({ cornerId: 3, brakeStartM: 180 }),
        metric({ cornerId: 1, brakeStartM: 195 }),
      ]),
    ]);
    const cues: ActiveCue[] = [
      { cornerId: 2, brakeStartM: 240, liftPointM: null },
      { cornerId: 3, brakeStartM: 240, liftPointM: null },
      { cornerId: 1, brakeStartM: 240, liftPointM: null },
    ];
    const forward = computeSuggestions({ enabled: true, envelope: many, cues });
    const reversed = computeSuggestions({ enabled: true, envelope: many, cues: [...cues].reverse() });
    expect(reversed).toEqual(forward);
    expect(forward.cueUpdates.map((entry) => entry.cornerId)).toEqual([1, 2, 3]);
  });
});

describe('computeSuggestions — pit suggestions (D1b)', () => {
  it('caps a braking suggestion at the demonstrated latest brake point', () => {
    const result = computeSuggestions({ enabled: true, envelope: ENVELOPE, cues: [] });
    const brake = result.pitSuggestions.find((entry) => entry.kind === 'brakeLater');
    expect(brake?.typicalValue).toBe(185);
    expect(brake?.demonstratedValue).toBe(170);
    expect(brake?.targetValue).toBe(175);
    expect(brake?.evidenceLapNumber).toBe(2);
  });

  it('caps a minimum-speed suggestion at MAX_MIN_SPEED_GAIN_KPH and at the demonstrated best', () => {
    const result = computeSuggestions({ enabled: true, envelope: ENVELOPE, cues: [] });
    const speed = result.pitSuggestions.find((entry) => entry.kind === 'carryMoreMinSpeed');
    expect(speed?.typicalValue).toBe(73);
    expect(speed?.demonstratedValue).toBe(76);
    expect(speed?.deltaValue).toBeLessThanOrEqual(MAX_MIN_SPEED_GAIN_KPH);
    expect(speed?.targetValue).toBe(76);
  });

  it('carries the time lost in that corner when the caller supplies it (ranking only)', () => {
    const result = computeSuggestions({
      enabled: true,
      envelope: ENVELOPE,
      cues: [],
      timeLossMsByCorner: { 1: 420 },
    });
    expect(result.pitSuggestions.every((entry) => entry.timeLossMs === 420)).toBe(true);
  });

  it('generates nothing beyond the demonstrated envelope', () => {
    const result = computeSuggestions({ enabled: true, envelope: ENVELOPE, cues: [] });
    for (const suggestion of result.pitSuggestions) {
      if (suggestion.unit === 'm') {
        expect(suggestion.targetValue).toBeGreaterThanOrEqual(suggestion.demonstratedValue);
      } else {
        expect(suggestion.targetValue).toBeLessThanOrEqual(suggestion.demonstratedValue);
      }
    }
  });
});

describe('suggestion text (D1b, RO/EN)', () => {
  it('renders a pit suggestion with its numbers and the lap that proves it', () => {
    const result = computeSuggestions({ enabled: true, envelope: ENVELOPE, cues: [] });
    const brake = result.pitSuggestions.find((entry) => entry.kind === 'brakeLater');
    if (brake === undefined) throw new Error('expected a braking suggestion');
    const en = pitSuggestionLine(brake, 'en');
    const ro = pitSuggestionLine(brake, 'ro');
    expect(en).toContain('lap 2');
    expect(en).toContain('175 m');
    expect(ro).toContain('turul 2');
    expect(ro).toContain('175 m');
    for (const line of [en, ro]) {
      expect(line).not.toContain('undefined');
      expect(line).not.toContain('NaN');
    }
  });

  it('renders an applied cue update with before, after and the demonstrating lap', () => {
    const result = computeSuggestions({ enabled: true, envelope: ENVELOPE, cues: cue(260) });
    const update = result.cueUpdates[0];
    if (update === undefined) throw new Error('expected a cue update');
    const en = cueUpdateLine(update, 'en');
    const ro = cueUpdateLine(update, 'ro');
    expect(en).toContain('260 m');
    expect(en).toContain('250 m');
    expect(en).toContain('lap 2');
    expect(ro).toContain('turul 2');
    for (const line of [en, ro]) {
      expect(line).not.toContain('undefined');
      expect(line).not.toContain('NaN');
    }
  });
});

// ---------------------------------------------------------------------------
// Property tests (mandatory): the safety invariants over arbitrary outings.
// ---------------------------------------------------------------------------

const brakePoints = fc.array(fc.integer({ min: 40, max: 400 }), { minLength: 1, maxLength: 8 });

function envelopeFrom(points: readonly number[], speeds: readonly number[]): DemonstratedEnvelope {
  return buildDemonstratedEnvelope(
    points.map((brakeStartM, index) =>
      lap(index + 1, [
        metric({
          cornerId: 1,
          brakeStartM,
          liftPointM: brakeStartM + 60,
          minSpeedKph: speeds[index] ?? 60,
        }),
      ]),
    ),
  );
}

describe('computeSuggestions — properties', () => {
  it('never moves a cue beyond the demonstrated envelope, and never by more than the bound', () => {
    fc.assert(
      fc.property(brakePoints, fc.integer({ min: 20, max: 500 }), (points, cueM) => {
        const envelope = envelopeFrom(points, points.map(() => 60));
        const result = computeSuggestions({
          enabled: true,
          envelope,
          cues: [{ cornerId: 1, brakeStartM: cueM, liftPointM: null }],
        });
        for (const update of result.cueUpdates) {
          expect(update.toM).toBeGreaterThanOrEqual(update.demonstratedM);
          expect(update.toM).toBeLessThan(update.fromM);
          expect(update.movedLaterM).toBeLessThanOrEqual(MAX_BRAKE_LATER_M);
          expect(update.movedLaterM).toBeGreaterThan(0);
          expect(envelope.cleanLapIds).toContain(update.evidenceLapNumber);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('never emits more than one cue update per corner', () => {
    fc.assert(
      fc.property(
        brakePoints,
        fc.integer({ min: 20, max: 500 }),
        fc.integer({ min: 20, max: 500 }),
        (points, brakeM, liftM) => {
          const envelope = envelopeFrom(points, points.map(() => 60));
          const result = computeSuggestions({
            enabled: true,
            envelope,
            cues: [{ cornerId: 1, brakeStartM: brakeM, liftPointM: liftM }],
          });
          const perCorner = new Map<number, number>();
          for (const update of result.cueUpdates) {
            perCorner.set(update.cornerId, (perCorner.get(update.cornerId) ?? 0) + 1);
          }
          for (const count of perCorner.values()) expect(count).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('keeps every pit suggestion inside the demonstrated envelope and its step bound', () => {
    fc.assert(
      fc.property(
        brakePoints,
        fc.array(fc.integer({ min: 30, max: 200 }), { minLength: 1, maxLength: 8 }),
        (points, speeds) => {
          const envelope = envelopeFrom(points, speeds);
          const result = computeSuggestions({ enabled: true, envelope, cues: [] });
          for (const suggestion of result.pitSuggestions) {
            expect(suggestion.deltaValue).toBeGreaterThan(0);
            if (suggestion.unit === 'm') {
              expect(suggestion.targetValue).toBeGreaterThanOrEqual(suggestion.demonstratedValue);
              expect(suggestion.targetValue).toBeLessThan(suggestion.typicalValue);
              expect(suggestion.deltaValue).toBeLessThanOrEqual(MAX_BRAKE_LATER_M);
            } else {
              expect(suggestion.targetValue).toBeLessThanOrEqual(suggestion.demonstratedValue);
              expect(suggestion.targetValue).toBeGreaterThan(suggestion.typicalValue);
              expect(suggestion.deltaValue).toBeLessThanOrEqual(MAX_MIN_SPEED_GAIN_KPH);
            }
            expect(envelope.cleanLapIds).toContain(suggestion.evidenceLapNumber);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('disabled is always the empty result, whatever the outing looked like', () => {
    fc.assert(
      fc.property(brakePoints, fc.integer({ min: 20, max: 500 }), (points, cueM) => {
        const result = computeSuggestions({
          enabled: false,
          envelope: envelopeFrom(points, points.map(() => 60)),
          cues: [{ cornerId: 1, brakeStartM: cueM, liftPointM: cueM + 50 }],
        });
        expect(result.cueUpdates).toEqual([]);
        expect(result.pitSuggestions).toEqual([]);
        expect(result.skipped).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('insufficient clean evidence always yields nothing', () => {
    fc.assert(
      fc.property(fc.integer({ min: 40, max: 400 }), fc.integer({ min: 20, max: 500 }), (point, cueM) => {
        const result = computeSuggestions({
          enabled: true,
          envelope: envelopeFrom([point], [60]),
          cues: [{ cornerId: 1, brakeStartM: cueM, liftPointM: cueM + 50 }],
        });
        expect(result.gate).toBe('insufficient-clean-laps');
        expect(result.cueUpdates).toEqual([]);
        expect(result.pitSuggestions).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});
