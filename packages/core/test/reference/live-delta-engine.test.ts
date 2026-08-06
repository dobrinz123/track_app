import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ReferenceLap, TrackMatch } from '../../src/contracts';
import {
  LiveDeltaEngine,
  referenceCompleteness,
  referenceElapsedAt,
} from '../../src/reference';

function reference(overrides: Partial<ReferenceLap> = {}): ReferenceLap {
  return {
    circuitId: 'circuit-1',
    layoutId: 'layout-1',
    layoutVersion: 1,
    userId: 'driver-1',
    durationMs: 100_000,
    sectorTimes: [{ sectorIndex: 0, durationMs: 100_000, quality: 'good' }],
    recordedAtUtc: '2026-08-01T12:00:00.000Z',
    sessionId: 'session-1',
    lapNumber: 1,
    distanceGridM: Array.from({ length: 11 }, (_, index) => index * 100),
    elapsedMsAtGrid: Array.from({ length: 11 }, (_, index) => index * 10_000),
    gnssQualitySummary: { level: 'good', reasons: [] },
    appVersion: '1.2.3',
    algorithmVersion: 2,
    profileSchemaVersion: 1,
    ...overrides,
  };
}

function match(
  tMono: number,
  distanceM: number,
  overrides: Partial<TrackMatch> = {},
): TrackMatch {
  return {
    tMono,
    distanceM,
    progress: distanceM / 1_000,
    unwrappedProgressM: distanceM,
    lateralM: 0,
    confidence: 1,
    sectorIndex: 0,
    quality: { level: 'good', reasons: [] },
    onPitLane: false,
    ...overrides,
  };
}

describe('reference interpolation', () => {
  it('is exact at every grid point', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 }), (index) => {
        expect(referenceElapsedAt(reference(), index * 100)).toBe(index * 10_000);
      }),
      { numRuns: 100 },
    );
  });

  it('linearly interpolates between points and reports endpoint completeness', () => {
    expect(referenceElapsedAt(reference(), 255)).toBe(25_500);
    expect(referenceCompleteness(reference())).toBe(1);
    expect(referenceCompleteness(reference({ elapsedMsAtGrid: [0, 10_000] }))).toBe(0);
  });
});

describe('LiveDeltaEngine', () => {
  it('returns a neutral zero update without a reference', () => {
    expect(new LiveDeltaEngine().onMatch(match(0, 500), 49_000)).toEqual({
      deltaMs: 0,
      confidence: 0,
      display: 'neutral',
    });
  });

  it('uses the negative-is-faster sign convention', () => {
    const engine = new LiveDeltaEngine();
    engine.setReference(reference());
    expect(engine.onMatch(match(0, 500), 49_000)).toMatchObject({
      deltaMs: -1_000,
      display: 'faster',
      estimatedLapMs: 99_000,
    });
  });

  it('smooths only the displayed delta while estimating from the retained raw delta', () => {
    const engine = new LiveDeltaEngine({ alpha: 0.5 });
    engine.setReference(reference());
    expect(engine.onMatch(match(0, 500), 51_000).deltaMs).toBe(1_000);
    const update = engine.onMatch(match(1_000, 600), 59_000);
    expect(update.deltaMs).toBe(0);
    expect(update.estimatedLapMs).toBe(99_000);
  });

  it('takes the minimum match/reference confidence and gates estimates at 0.6', () => {
    const incomplete = reference({
      elapsedMsAtGrid: Array.from({ length: 11 }, (_, index) => index * 5_000),
    });
    const engine = new LiveDeltaEngine();
    engine.setReference(incomplete);
    const update = engine.onMatch(match(0, 500, { confidence: 0.8 }), 25_000);
    expect(update.confidence).toBe(0.5);
    expect(update.estimatedLapMs).toBeUndefined();
  });

  it.each([
    ['unreliable', 1],
    ['invalid', 1],
    ['good', 0.39],
  ] as const)('stays neutral for %s quality at confidence %s', (level, confidence) => {
    const engine = new LiveDeltaEngine();
    engine.setReference(reference());
    expect(
      engine.onMatch(match(0, 500, { confidence, quality: { level, reasons: [] } }), 51_000)
        .display,
    ).toBe('neutral');
  });

  it('uses a strict +/- 50 ms deadband', () => {
    const outputs = [49, 50, 51, -49, -50, -51].map((deltaMs) => {
      const engine = new LiveDeltaEngine({ alpha: 1 });
      engine.setReference(reference());
      return engine.onMatch(match(0, 500), 50_000 + deltaMs).display;
    });
    expect(outputs).toEqual(['neutral', 'neutral', 'slower', 'neutral', 'neutral', 'faster']);
  });

  it('holds the last delta and decays confidence on progress regression', () => {
    const engine = new LiveDeltaEngine({ alpha: 1 });
    engine.setReference(reference());
    expect(engine.onMatch(match(0, 500), 51_000).deltaMs).toBe(1_000);
    const regressed = engine.onMatch(
      match(1_000, 490, { unwrappedProgressM: 490 }),
      48_000,
    );
    expect(regressed.deltaMs).toBe(1_000);
    expect(regressed.confidence).toBe(0.5);
  });

  it('decays confidence for gaps over 3 seconds and goes neutral when stale over 5 seconds', () => {
    const engine = new LiveDeltaEngine({ alpha: 1 });
    engine.setReference(reference());
    engine.onMatch(match(0, 100), 11_000);
    const sparse = engine.onMatch(match(4_000, 200, { unwrappedProgressM: 200 }), 21_000);
    expect(sparse.confidence).toBe(0.5);
    const stale = engine.onMatch(match(10_000, 300, { unwrappedProgressM: 300 }), 31_000);
    expect(stale.confidence).toBe(0);
    expect(stale.display).toBe('neutral');
  });

  it('is wrap-safe immediately before and after start/finish', () => {
    const engine = new LiveDeltaEngine({ alpha: 1 });
    engine.setReference(reference());
    expect(engine.onMatch(match(0, 999.9), 99_990).deltaMs).toBeCloseTo(0, 8);
    expect(
      engine.onMatch(match(1_000, 0, { unwrappedProgressM: 1_000 }), 0).deltaMs,
    ).toBeCloseTo(0, 8);
  });

  it('handles reference invalidation mid-lap and reset without discarding the reference', () => {
    const engine = new LiveDeltaEngine();
    engine.setReference(reference());
    engine.onMatch(match(0, 500), 51_000);
    engine.setReference(null);
    expect(engine.onMatch(match(1_000, 600), 61_000)).toEqual({
      deltaMs: 0,
      confidence: 0,
      display: 'neutral',
    });

    engine.setReference(reference());
    engine.onMatch(match(2_000, 500), 51_000);
    engine.reset();
    expect(engine.onMatch(match(3_000, 500), 50_000).deltaMs).toBe(0);
  });

  it('keeps displayed deltas continuous for smooth 1 Hz synthetic laps', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: Math.PI * 2, noNaN: true, noDefaultInfinity: true }),
        (amplitudeMps, phase) => {
          const engine = new LiveDeltaEngine();
          engine.setReference(reference());
          let distanceM = 0;
          let previousDeltaMs: number | undefined;
          for (let second = 0; second <= 80; second += 1) {
            if (second > 0) distanceM += 10 + amplitudeMps * Math.sin(second / 12 + phase);
            const update = engine.onMatch(
              match(second * 1_000, distanceM, { unwrappedProgressM: distanceM }),
              second * 1_000,
            );
            if (previousDeltaMs !== undefined) {
              expect(Math.abs(update.deltaMs - previousDeltaMs)).toBeLessThan(500);
            }
            previousDeltaMs = update.deltaMs;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
