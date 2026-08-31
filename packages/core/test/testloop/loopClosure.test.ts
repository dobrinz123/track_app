import { describe, expect, it } from 'vitest';

import { DEFAULT_TEST_LOOP_CONFIG, detectLoopClosure } from '../../src/testloop';

import {
  figureEightPath,
  headingMismatchPath,
  rectangleLoopSamples,
  roundedRectanglePath,
  sampleDensePath,
  uTurnPath,
} from './traces';

/**
 * Ticket P5d T1(a): lap 1 defines the track, and the ONLY thing that says
 * "lap 1 is over" is the geometric closure test -- back within the closing
 * radius of the start point, travelling roughly the way we left it, after a
 * lap long enough to be a lap.
 */
describe('detectLoopClosure (P5d T1a)', () => {
  it('closes a clean rectangle loop at the return to the start point', () => {
    const samples = rectangleLoopSamples();
    const result = detectLoopClosure(samples);

    expect(result.closed).toBe(true);
    if (!result.closed) return;
    expect(result.closure.startIndex).toBe(0);
    expect(result.closure.closeIndex).toBeGreaterThan(10);
    expect(result.closure.closeIndex).toBeLessThan(samples.length);
    // The rounded rectangle is ~677 m round (2 x 170 + 2 x 90 + 2 pi x 25).
    expect(result.closure.lapLengthM).toBeGreaterThan(620);
    expect(result.closure.lapLengthM).toBeLessThan(720);
    expect(result.closure.closureDistanceM).toBeLessThanOrEqual(
      DEFAULT_TEST_LOOP_CONFIG.closeRadiusM,
    );
    expect(result.closure.headingErrorDeg).toBeLessThanOrEqual(
      DEFAULT_TEST_LOOP_CONFIG.headingToleranceDeg,
    );
  });

  it('rejects a U-turn: it comes back, but not far enough to be a lap', () => {
    const result = detectLoopClosure(sampleDensePath(uTurnPath()));

    expect(result.closed).toBe(false);
    if (result.closed) return;
    expect(result.reason).toBe('too-short');
    expect(result.travelledM).toBeLessThan(DEFAULT_TEST_LOOP_CONFIG.minLapLengthM);
  });

  it('does not close a loop that never returns to the start', () => {
    // Half a rectangle: driven away and stopped.
    const path = roundedRectanglePath();
    const half = {
      points: path.points.slice(0, Math.floor(path.points.length / 2)),
      speedMps: path.speedMps.slice(0, Math.floor(path.speedMps.length / 2)),
    };
    const result = detectLoopClosure(sampleDensePath(half));

    expect(result.closed).toBe(false);
    if (result.closed) return;
    expect(result.reason).toBe('not-returned');
    expect(result.travelledM).toBeGreaterThan(200);
  });

  it('rejects a pass through the start point with the wrong heading, and closes on the right one', () => {
    const samples = sampleDensePath(headingMismatchPath());
    const result = detectLoopClosure(samples);

    expect(result.closed).toBe(true);
    if (!result.closed) return;
    // The rejected pass happens at ~430 m; the real closure is at ~860 m.
    expect(result.closure.lapLengthM).toBeGreaterThan(700);
  });

  it('reports heading-mismatch when the only return was the wrong way round', () => {
    const path = headingMismatchPath();
    // Cut the trace right after the wrong-heading pass over the start point.
    const cut = 200 + 32 + 260;
    const truncated = {
      points: path.points.slice(0, cut),
      speedMps: path.speedMps.slice(0, cut),
    };
    const result = detectLoopClosure(sampleDensePath(truncated));

    expect(result.closed).toBe(false);
    if (result.closed) return;
    expect(result.reason).toBe('heading-mismatch');
  });

  it('handles a figure eight as ONE loop (it closes only at the full eight)', () => {
    const path = figureEightPath();
    const samples = sampleDensePath(path);
    const result = detectLoopClosure(samples);

    expect(result.closed).toBe(true);
    if (!result.closed) return;
    const fullLengthM = path.points.length; // ~1 m per point
    expect(result.closure.lapLengthM).toBeGreaterThan(fullLengthM * 0.85);
  });

  it('needs samples: an empty or one-sample trace is not a failed loop, it is no loop', () => {
    const empty = detectLoopClosure([]);
    expect(empty.closed).toBe(false);
    if (empty.closed) return;
    expect(empty.reason).toBe('insufficient-samples');
  });

  it('still closes when the fixes carry no headingDeg at all (heading read from the track)', () => {
    const samples = rectangleLoopSamples({ withHeading: false });
    const result = detectLoopClosure(samples);

    expect(result.closed).toBe(true);
  });

  it('closes on noisy fixes (5 m sigma), and does not close early inside the noise', () => {
    const samples = rectangleLoopSamples({ noiseSigmaM: 5, seed: 7 });
    const result = detectLoopClosure(samples);

    expect(result.closed).toBe(true);
    if (!result.closed) return;
    expect(result.closure.lapLengthM).toBeGreaterThan(500);
  });

  it('honours a caller-raised minimum lap length', () => {
    const samples = rectangleLoopSamples();
    const result = detectLoopClosure(samples, { minLapLengthM: 5_000 });

    expect(result.closed).toBe(false);
    if (result.closed) return;
    expect(result.reason).toBe('too-short');
  });
});
