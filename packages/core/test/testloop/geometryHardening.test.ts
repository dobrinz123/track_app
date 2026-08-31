import { describe, expect, it } from 'vitest';

import {
  MAX_TEST_LOOP_CORNERS,
  buildTestLoopCircuit,
  decodeLearnedCircuit,
  encodeLearnedCircuit,
  overlapFractionOf,
} from '../../src/testloop';

import { rectangleLoopSamples, sampleDensePath, smallLoopPath, wigglyLoopPath } from './traces';

const OPTIONS = {
  circuitId: 'learned-hardening',
  displayName: 'Test loop',
  createdAtUtc: '2026-08-31T10:00:00.000Z',
};

/** Ticket P5d-FIX1 items 6, 7, 8 and H2 (Codex P5d-REV1). */
describe('buildTestLoopCircuit -- degenerate traces (P5d-FIX1 item 6)', () => {
  it('refuses a sub-300 m loop driven round and round to make up the distance', () => {
    // Three laps of an ~230 m loop. Since P5d-FIX2 N1 each pass is judged on
    // the distance driven SINCE the car last left the start circle, so this is
    // refused as what it is -- a loop that is too short -- rather than being
    // stacked into a two-copy circuit.
    const result = buildTestLoopCircuit(sampleDensePath(smallLoopPath(), { laps: 3 }), OPTIONS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-short');
  });

  it('measures self-overlap directly: a doubled ring is not a circuit', () => {
    const oneLap = Array.from({ length: 120 }, (_, index) => {
      const angle = (2 * Math.PI * index) / 120;
      return { e: 100 * Math.cos(angle), n: 100 * Math.sin(angle) };
    });
    const doubled = [...oneLap, ...oneLap.map((point) => ({ e: point.e + 1, n: point.n + 1 }))];

    expect(overlapFractionOf(oneLap, 12, 60)).toBeLessThan(0.15);
    expect(overlapFractionOf(doubled, 12, 60)).toBeGreaterThan(0.5);
  });

  it('accepts an ordinary single-traversal loop', () => {
    const result = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), OPTIONS);
    expect(result.ok).toBe(true);
  });
});

describe('buildTestLoopCircuit -- corner explosion (P5d-FIX1 item 7)', () => {
  it('caps and prunes the corner set on a wiggly trace, and it survives storage', () => {
    const result = buildTestLoopCircuit(sampleDensePath(wigglyLoopPath(), { laps: 2 }), OPTIONS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.corners.length).toBeGreaterThan(0);
    expect(result.corners.length).toBeLessThanOrEqual(MAX_TEST_LOOP_CORNERS);
    // Every surviving corner is a real corner, not a wiggle.
    for (const corner of result.corners) {
      expect(corner.totalAngleDeg).toBeGreaterThanOrEqual(10);
      expect(corner.lengthM).toBeGreaterThan(0);
    }
    // Ids stay 1..n in travel order after pruning.
    expect(result.corners.map((corner) => corner.id)).toEqual(
      result.corners.map((_, index) => index + 1),
    );

    const decoded = decodeLearnedCircuit(encodeLearnedCircuit(result.profile, result.corners));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.corners).toEqual(result.corners);
    expect(decoded.cornersRecovered).toBe(false);
  });
});

describe('buildTestLoopCircuit -- corridor and gate (P5d-FIX1 item 8)', () => {
  it('derives the corridor from lap 1 accuracy and dispersion, within bounds', () => {
    const tight = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), OPTIONS);
    const loose = buildTestLoopCircuit(
      rectangleLoopSamples({ laps: 2 }).map((sample) => ({ ...sample, accuracyM: 22 })),
      OPTIONS,
    );

    expect(tight.ok).toBe(true);
    expect(loose.ok).toBe(true);
    if (!tight.ok || !loose.ok) return;
    expect(tight.profile.corridorWidthM).toBeGreaterThanOrEqual(8);
    expect(tight.profile.corridorWidthM).toBeLessThanOrEqual(25);
    expect(loose.profile.corridorWidthM).toBeGreaterThan(tight.profile.corridorWidthM);
    expect(loose.profile.corridorWidthM).toBeLessThanOrEqual(25);
  });

  it('sizes the start/finish gate independently of the corridor', () => {
    const result = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const gate = result.runtime.startFinishGate;
    const widthM = Math.hypot(gate.b.e - gate.a.e, gate.b.n - gate.a.n);
    expect(widthM).toBeGreaterThan(result.profile.corridorWidthM);
    expect(widthM).toBeLessThan(100);
  });
});

describe('learned profiles are frozen (P5d-FIX1 H2)', () => {
  it('a built learned profile cannot have its geometryStatus rewritten', () => {
    const result = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.isFrozen(result.profile)).toBe(true);
    expect(() => {
      (result.profile as { geometryStatus: string }).geometryStatus = 'official';
    }).toThrow(TypeError);
    expect(result.profile.geometryStatus).toBe('ad-hoc');
  });

  it('a profile decoded from storage is frozen too', () => {
    const result = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = decodeLearnedCircuit(encodeLearnedCircuit(result.profile, result.corners));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(Object.isFrozen(decoded.profile)).toBe(true);
    expect(() => {
      (decoded.profile as { geometryStatus: string }).geometryStatus = 'official';
    }).toThrow(TypeError);
  });
});
