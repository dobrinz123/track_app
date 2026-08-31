import { describe, expect, it } from 'vitest';

import { buildTestLoopCircuit, detectLoopClosure } from '../../src/testloop';

import { rectangleLoopSamples, roundedRectanglePath, sampleDensePath } from './traces';

const OPTIONS = {
  circuitId: 'learned-qualified',
  displayName: 'Test loop',
  createdAtUtc: '2026-08-31T10:00:00.000Z',
};

/**
 * Ticket P5d-FIX2 N7 and N1 (Codex P5d-REV2).
 *
 * N7: the fixes the closure REFUSED must not come back into the geometry --
 *     a rejected fix is rejected for the whole pipeline, not just for the
 *     distance total.
 * N1: a lap closes on the FIRST return through the start point, and a pass
 *     that has not covered a lap's worth of driving since leaving the start
 *     circle cannot close one.
 */
describe('learned geometry is built from QUALIFIED fixes only (P5d-FIX2 N7)', () => {
  /** Five wild, low-accuracy fixes spliced into an otherwise clean lap. */
  function withGarbage(samples = rectangleLoopSamples({ laps: 2 })) {
    return samples.map((sample, index) =>
      index % 17 === 3 && index < 45
        ? { ...sample, lat: sample.lat + 0.0006, lon: sample.lon - 0.0006, accuracyM: 200 }
        : sample,
    );
  }

  it('keeps the learned line tight when the trace carries rejected fixes', () => {
    const clean = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), OPTIONS);
    const dirty = buildTestLoopCircuit(withGarbage(), OPTIONS);

    expect(clean.ok).toBe(true);
    expect(dirty.ok).toBe(true);
    if (!clean.ok || !dirty.ok) return;

    // A 60 m spike and back, five times over, would add hundreds of metres and
    // a fistful of invented corners if the raw array were sliced.
    expect(dirty.profile.totalLengthM).toBeGreaterThan(clean.profile.totalLengthM - 60);
    expect(dirty.profile.totalLengthM).toBeLessThan(clean.profile.totalLengthM + 60);
    expect(dirty.corners.length).toBeLessThanOrEqual(clean.corners.length + 1);
  });

  it('reports the refused fixes rather than hiding them', () => {
    const result = detectLoopClosure(withGarbage());
    expect(result.closed).toBe(true);
    if (!result.closed) return;
    expect(result.rejectedSamples).toBeGreaterThan(0);
  });
});

describe('closure completes on the FIRST return (P5d-FIX2 N1)', () => {
  /** One lap, plus just enough driving to leave the closing radius again. */
  function oneLapPlusExit() {
    const path = roundedRectanglePath();
    const samples = sampleDensePath(path, { laps: 2 });
    // Two laps of fixes, truncated a short way into lap 2 -- exactly what a
    // driver produces by carrying on past the start point.
    const perLap = Math.round(samples.length / 2);
    return samples.slice(0, perLap + 4);
  }

  it('closes at the first pass through the start point, not the second', () => {
    const samples = oneLapPlusExit();
    const result = detectLoopClosure(samples);

    expect(result.closed).toBe(true);
    if (!result.closed) return;
    expect(result.closure.lapLengthM).toBeGreaterThan(620);
    expect(result.closure.lapLengthM).toBeLessThan(720);
    // ...and the closing fix is one of the last few, not a lap later.
    expect(result.closure.closeIndex).toBeGreaterThan(samples.length - 10);
  });

  it('a pass through the start circle without a lap of driving behind it cannot close', () => {
    // The same loop with the minimum lap raised above its length: the car
    // passes the start point, but has not driven a lap since it left it.
    const result = detectLoopClosure(oneLapPlusExit(), { minLapLengthM: 900 });

    expect(result.closed).toBe(false);
    if (result.closed) return;
    expect(result.reason).toBe('too-short');
  });
});
