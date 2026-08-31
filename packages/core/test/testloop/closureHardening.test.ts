import { describe, expect, it } from 'vitest';

import { DEFAULT_TEST_LOOP_CONFIG, detectLoopClosure } from '../../src/testloop';

import {
  parkedDriftSamples,
  rectangleLoopSamples,
  roundedRectanglePath,
  sampleDensePath,
  smallLoopPath,
  withJump,
} from './traces';

/**
 * Ticket P5d-FIX1 items 4 and 5 (Codex P5d-REV1 MEDIUM 4/5).
 *
 * 4: distance, departure and closure may only be built from fixes that are
 *    actually usable -- accurate enough, moving, and not a teleport. Parked
 *    drift and an urban-canyon reflection are the two ways a stationary or
 *    mis-fixed phone would otherwise manufacture a lap.
 * 5: a closure is a RUN of fixes inside the radius, finalized at its nearest
 *    fix, and only once the car has left the radius again -- never the first
 *    sample that happens to qualify (which can be 25 m off-centre).
 */
describe('detectLoopClosure -- quality gate (P5d-FIX1 item 4)', () => {
  it('never closes a loop on a parked car drifting around one point', () => {
    const result = detectLoopClosure(parkedDriftSamples());

    expect(result.closed).toBe(false);
    if (result.closed) return;
    expect(result.travelledM).toBeLessThan(DEFAULT_TEST_LOOP_CONFIG.minLapLengthM);
    expect(result.rejectedSamples).toBeGreaterThan(0);
  });

  it('does not count a teleport towards the lap distance', () => {
    // Half a rectangle (~340 m of real driving), plus one 5 km jump.
    const path = roundedRectanglePath();
    const half = {
      points: path.points.slice(0, Math.floor(path.points.length / 2)),
      speedMps: path.speedMps.slice(0, Math.floor(path.points.length / 2)),
    };
    const clean = sampleDensePath(half);
    const jumped = withJump(clean, Math.floor(clean.length / 2), 5_000, 5_000);

    const cleanResult = detectLoopClosure(clean);
    const jumpedResult = detectLoopClosure(jumped);
    expect(cleanResult.closed).toBe(false);
    expect(jumpedResult.closed).toBe(false);
    if (cleanResult.closed || jumpedResult.closed) return;
    // The jump adds ~14 km of raw displacement; the gate must swallow it.
    expect(jumpedResult.travelledM).toBeLessThan(cleanResult.travelledM + 100);
    expect(jumpedResult.rejectedSamples).toBeGreaterThan(0);
  });

  it('ignores fixes whose reported accuracy is worse than the gate allows', () => {
    const samples = rectangleLoopSamples({ laps: 2 }).map((sample) => ({
      ...sample,
      accuracyM: 120,
    }));
    const result = detectLoopClosure(samples);

    expect(result.closed).toBe(false);
    if (result.closed) return;
    expect(result.reason).toBe('insufficient-samples');
  });

  it('still closes a clean lap: the gate rejects nothing it should not', () => {
    const result = detectLoopClosure(rectangleLoopSamples({ laps: 2 }));

    expect(result.closed).toBe(true);
    if (!result.closed) return;
    expect(result.closure.lapLengthM).toBeGreaterThan(620);
    expect(result.closure.lapLengthM).toBeLessThan(720);
  });
});

describe('detectLoopClosure -- stateful run (P5d-FIX1 item 5)', () => {
  it('does not close while the car is still inside the closing radius', () => {
    // The trace STOPS at the first return -- the run has not ended yet.
    const samples = rectangleLoopSamples();
    const result = detectLoopClosure(samples);

    expect(result.closed).toBe(false);
    if (result.closed) return;
    expect(result.reason).toBe('closure-unconfirmed');
  });

  it('closes at the NEAREST fix of the run once the car has left the radius again', () => {
    const twoLaps = rectangleLoopSamples({ laps: 2 });
    const result = detectLoopClosure(twoLaps);

    expect(result.closed).toBe(true);
    if (!result.closed) return;
    // The nearest fix of the run, not the first one to fall inside 25 m.
    expect(result.closure.closureDistanceM).toBeLessThan(10);
    const chosen = twoLaps[result.closure.closeIndex];
    expect(chosen).toBeDefined();
  });

  it('a mid-route pass that never leaves the radius cannot close the lap', () => {
    // A sub-300 m loop driven once: it comes back inside the radius but the
    // lap is too short, and the trace ends there.
    const result = detectLoopClosure(sampleDensePath(smallLoopPath()));

    expect(result.closed).toBe(false);
  });
});
