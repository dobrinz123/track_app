import { describe, expect, it } from 'vitest';
import type { TestLoopCircuit } from '@circuit/core';

import { TestLoopController } from '../../src/session/testLoopController';
import { rectangleLoopSamples, uTurnSamples } from '../support/testLoopTraces';

/**
 * Ticket P5d T2/T5 -- the learn phase as the screen sees it: feed fixes, watch
 * a track appear, and get an HONEST end when one never does.
 */

function makeController(onLearned: (circuit: TestLoopCircuit) => void = () => undefined) {
  let counter = 0;
  return new TestLoopController({
    nowUtc: () => '2026-08-31T09:00:00.000Z',
    makeCircuitId: () => `learned-${(counter += 1)}`,
    makeDisplayName: () => 'Test loop',
    onLearned,
  });
}

describe('TestLoopController (P5d T2, T5)', () => {
  it('starts idle and reports progress while learning', () => {
    const controller = makeController();
    expect(controller.snapshot().phase).toBe('idle');

    controller.start();
    expect(controller.snapshot().phase).toBe('learning');

    const samples = rectangleLoopSamples();
    controller.feed(samples[0]!);
    controller.feed(samples[1]!);
    const snapshot = controller.snapshot();
    expect(snapshot.phase).toBe('learning');
    expect(snapshot.sampleCount).toBe(2);
    expect(snapshot.travelledM).toBeGreaterThan(10);
    expect(snapshot.learned).toBeNull();
  });

  it('learns the track when lap 1 closes, and hands the circuit over exactly once', () => {
    const learned: TestLoopCircuit[] = [];
    const controller = makeController((circuit) => learned.push(circuit));
    controller.start();
    for (const sample of rectangleLoopSamples({ laps: 2 })) controller.feed(sample);

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

  it('notifies subscribers on every phase change', () => {
    const phases: string[] = [];
    const controller = makeController();
    controller.subscribe((snapshot) => phases.push(snapshot.phase));
    controller.start();
    for (const sample of rectangleLoopSamples()) controller.feed(sample);

    expect(phases[0]).toBe('idle');
    expect(phases).toContain('learning');
    expect(phases[phases.length - 1]).toBe('learned');
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

  it('stopping after the track was learned keeps the learned track', () => {
    const controller = makeController();
    controller.start();
    for (const sample of rectangleLoopSamples()) controller.feed(sample);
    const stopped = controller.stop();

    expect(stopped.phase).toBe('learned');
    expect(stopped.learned).not.toBeNull();
  });

  it('ignores fixes before start and after the track is learned', () => {
    const learned: TestLoopCircuit[] = [];
    const controller = makeController((circuit) => learned.push(circuit));
    const samples = rectangleLoopSamples({ laps: 3 });
    controller.feed(samples[0]!);
    expect(controller.snapshot().sampleCount).toBe(0);

    controller.start();
    for (const sample of samples) controller.feed(sample);
    const countAtLearned = controller.snapshot().sampleCount;
    for (const sample of samples) controller.feed(sample);

    expect(controller.snapshot().sampleCount).toBe(countAtLearned);
    expect(learned).toHaveLength(1);
  });

  it('gives up honestly once the trace is longer than the mode is for', () => {
    const controller = new TestLoopController({
      nowUtc: () => '2026-08-31T09:00:00.000Z',
      makeCircuitId: () => 'learned-x',
      makeDisplayName: () => 'Test loop',
      onLearned: () => undefined,
      maxSamples: 10,
    });
    controller.start();
    for (const sample of rectangleLoopSamples()) controller.feed(sample);

    const snapshot = controller.snapshot();
    expect(snapshot.phase).toBe('failed');
    expect(snapshot.failure!.reason).toBe('not-returned');
  });
});
