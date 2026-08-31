import { describe, expect, it } from 'vitest';
import type { TestLoopCircuit } from '@circuit/core';

import { TestLoopController } from '../../src/session/testLoopController';
import { rectangleLoopSamples, uTurnSamples } from '../support/testLoopTraces';

/**
 * Ticket P5d T2/T5, hardened by P5d-FIX1 H3 -- the learn phase as the screen
 * sees it: feed fixes, watch a track appear, and get an HONEST end when one
 * never does.
 *
 * Since P5d-FIX1 H3 the handover is AWAITED: `adopting` while the learned
 * circuit is being persisted, registered and selected, `learned` only once
 * that succeeded, `error` (with a retry) when it did not.
 */

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeController(
  onLearned: (circuit: TestLoopCircuit) => void | Promise<void> = () => undefined,
) {
  let counter = 0;
  return new TestLoopController({
    nowUtc: () => '2026-08-31T09:00:00.000Z',
    makeCircuitId: () => `learned-${(counter += 1)}`,
    makeDisplayName: () => 'Test loop',
    onLearned,
  });
}

/** Two laps: the first teaches the track, the second proves the car drove through the start. */
const TWO_LAPS = rectangleLoopSamples({ laps: 2 });
/** One lap plus the few fixes it takes to drive back out of the closing radius. */
const ONE_LAP_PLUS_EXIT = TWO_LAPS.slice(0, Math.round(TWO_LAPS.length / 2) + 5);

describe('TestLoopController (P5d T2, T5, P5d-FIX1 H3)', () => {
  it('starts idle and reports progress while learning', () => {
    const controller = makeController();
    expect(controller.snapshot().phase).toBe('idle');

    controller.start();
    expect(controller.snapshot().phase).toBe('learning');

    controller.feed(TWO_LAPS[0]!);
    controller.feed(TWO_LAPS[1]!);
    const snapshot = controller.snapshot();
    expect(snapshot.phase).toBe('learning');
    expect(snapshot.sampleCount).toBe(2);
    expect(snapshot.travelledM).toBeGreaterThan(10);
    expect(snapshot.learned).toBeNull();
  });

  it('learns the track when lap 1 closes, and hands the circuit over exactly once', async () => {
    const learned: TestLoopCircuit[] = [];
    const controller = makeController((circuit) => {
      learned.push(circuit);
    });
    controller.start();
    for (const sample of TWO_LAPS) controller.feed(sample);
    await settle();

    const snapshot = controller.snapshot();
    expect(snapshot.phase).toBe('learned');
    expect(learned).toHaveLength(1);
    expect(snapshot.learned).not.toBeNull();
    expect(snapshot.learned!.circuitId).toBe('learned-1');
    expect(snapshot.learned!.cornerCount).toBe(4);
    expect(snapshot.learned!.lengthM).toBeGreaterThan(600);
    expect(snapshot.learned!.lengthM).toBeLessThan(750);
    expect(learned[0]!.profile.geometryStatus).toBe('ad-hoc');
  });

  it('goes through an ADOPTING phase before it claims a track was learned (H3)', async () => {
    const phases: string[] = [];
    let release: null | (() => void) = null;
    const controller = makeController(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    controller.subscribe((snapshot) => phases.push(snapshot.phase));
    controller.start();
    for (const sample of TWO_LAPS) controller.feed(sample);
    await settle();

    // Still handing over: nothing has told the driver a track exists yet.
    expect(controller.snapshot().phase).toBe('adopting');
    expect(controller.snapshot().learned).toBeNull();
    (release as (() => void) | null)?.();
    await settle();

    expect(controller.snapshot().phase).toBe('learned');
    expect(phases).toContain('learning');
    expect(phases).toContain('adopting');
    expect(phases[phases.length - 1]).toBe('learned');
  });

  it('reports an ERROR (never a learned track) when the handover fails, and retries it (H3)', async () => {
    let attempts = 0;
    const controller = makeController(() => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error('database is gone'));
      return Promise.resolve();
    });
    controller.start();
    for (const sample of TWO_LAPS) controller.feed(sample);
    await settle();

    expect(controller.snapshot().phase).toBe('error');
    expect(controller.snapshot().learned).toBeNull();
    expect(controller.snapshot().adoptError).toBe('database is gone');

    controller.retryAdopt();
    await settle();

    expect(attempts).toBe(2);
    expect(controller.snapshot().phase).toBe('learned');
    expect(controller.snapshot().adoptError).toBeNull();
    expect(controller.snapshot().learned).not.toBeNull();
  });

  it('closes on the FIRST return, as soon as the car drives back out of the radius (P5d-FIX2 N1)', async () => {
    const controller = makeController();
    controller.start();
    for (const sample of ONE_LAP_PLUS_EXIT) controller.feed(sample);
    await settle();

    const snapshot = controller.snapshot();
    expect(snapshot.phase).toBe('learned');
    expect(snapshot.learned!.lengthM).toBeGreaterThan(600);
    expect(snapshot.learned!.lengthM).toBeLessThan(750);
    // The learning lap is ONE lap of fixes, not two.
    expect(controller.learnedLapSamples().length).toBeLessThanOrEqual(
      Math.round(TWO_LAPS.length / 2) + 1,
    );
  });

  it('ends a never-closed loop gracefully, naming what was missing (T5)', () => {
    const controller = makeController();
    controller.start();
    for (const sample of uTurnSamples()) controller.feed(sample);

    const stopped = controller.stop();
    expect(stopped.phase).toBe('failed');
    expect(stopped.failure).not.toBeNull();
    expect(stopped.failure!.reason).toBe('too-short');
    expect(stopped.failure!.travelledM).toBeGreaterThan(100);
    expect(stopped.learned).toBeNull();
  });

  it('stopping after the track was learned keeps the learned track', async () => {
    const controller = makeController();
    controller.start();
    for (const sample of TWO_LAPS) controller.feed(sample);
    await settle();
    const stopped = controller.stop();

    expect(stopped.phase).toBe('learned');
    expect(stopped.learned).not.toBeNull();
  });

  it('ignores fixes before start and after the track is learned', async () => {
    const learned: TestLoopCircuit[] = [];
    const controller = makeController((circuit) => {
      learned.push(circuit);
    });
    const samples = rectangleLoopSamples({ laps: 3 });
    controller.feed(samples[0]!);
    expect(controller.snapshot().sampleCount).toBe(0);

    controller.start();
    for (const sample of samples) controller.feed(sample);
    await settle();
    const countAtLearned = controller.snapshot().sampleCount;
    for (const sample of samples) controller.feed(sample);
    await settle();

    expect(controller.snapshot().sampleCount).toBe(countAtLearned);
    expect(learned).toHaveLength(1);
  });

  it('gives up at the sample cap, says how many fixes it refused, and frees the buffer (N6)', () => {
    const controller = new TestLoopController({
      nowUtc: () => '2026-08-31T09:00:00.000Z',
      makeCircuitId: () => 'learned-x',
      makeDisplayName: () => 'Test loop',
      onLearned: () => undefined,
      maxSamples: 10,
    });
    controller.start();
    for (const sample of TWO_LAPS) controller.feed(sample);

    const snapshot = controller.snapshot();
    expect(snapshot.phase).toBe('failed');
    expect(snapshot.failure!.reason).toBe('not-returned');
    expect(snapshot.failure!.sampleCap).toBe(10);
    // The trace is released: a learn phase that gave up holds no memory.
    expect(snapshot.sampleCount).toBe(0);
    expect(controller.learnedLapSamples()).toEqual([]);
  });
});
