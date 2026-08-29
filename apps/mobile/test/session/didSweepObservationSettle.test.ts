import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DidObservationPhaseId, ObdTransport } from '@circuit/core';
import { SETTLE_MS } from '@circuit/core';
import { createDidSweepController } from '../../src/session/didSweepController';
import { FakeSweepTransport, TARGET_ADDRESS, TESTER_ADDRESS, flush, monotonicCounter, positivePdu, type ScriptEntry } from '../support/didSweepHarness';

/**
 * Ticket P4k (binding). Field evidence (test 4,
 * `data/field/sweeps/2026-08-29-test4-ecu29-0x5000-0x58F2.json`, DID 0x500C):
 * the FIRST sample of the STEERING phase (tMs 312) still read the BRAKE
 * value -- the driver's foot was still on the pedal when the phase prompt
 * switched. `computeDidCandidateSummaries` now excludes any such sample from
 * a phase's own change evidence (see `didObservationPhases.test.ts`), but the
 * mobile controller's own count guarantee (>= `minSamplesPerPhase` POSITIVE
 * samples per DID per phase, ticket P4j-FIX1 H1) must ALSO count only
 * non-settling samples -- otherwise a phase could satisfy its guarantee
 * entirely from settling samples and never actually observe the driver's
 * input for the required count.
 */

const SWEEP_FROM = 0x0001;
const SWEEP_TO = 0x0001;

/** Answers every send, forever, with the same 1-byte value -- a fast, always-responding DID (the settle-window arithmetic is what this test exercises, not the change-detection rule). */
function alwaysPositive(did: number): ScriptEntry {
  return { responses: [positivePdu(did, [0x10])], mode: 'oneFramePerSend', delayMs: 5 };
}

interface Built {
  controller: ReturnType<typeof createDidSweepController>;
}

function build(script: Map<number, ScriptEntry>): Built {
  const controller = createDidSweepController({
    transportFactory: (): ObdTransport => new FakeSweepTransport(script),
    testerAddress: TESTER_ADDRESS,
    targetAddress: TARGET_ADDRESS,
    clock: monotonicCounter(),
  });
  return { controller };
}

async function runSweep(controller: ReturnType<typeof createDidSweepController>): Promise<void> {
  controller.start({ from: SWEEP_FROM, to: SWEEP_TO });
  await vi.runAllTimersAsync();
  await flush();
}

async function drainObservation(controller: ReturnType<typeof createDidSweepController>, maxSteps = 600): Promise<void> {
  for (let i = 0; i < maxSteps && controller.getSnapshot().phase === 'observing'; i += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
  }
}

function samplesFor(
  samples: readonly { did: number; phase: DidObservationPhaseId; tMs: number }[],
  did: number,
  phase: DidObservationPhaseId,
): readonly { tMs: number }[] {
  return samples.filter((s) => s.did === did && s.phase === phase);
}

describe('P4k -- the batched count guarantee counts only non-settling samples (binding)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('every active phase (brake/steering/throttle) keeps sampling past the settle window until 5 NON-settling samples exist -- baseline needs no settle', async () => {
    const did1 = 0x0001;
    const script = new Map<number, ScriptEntry>([[did1, alwaysPositive(did1)]]);
    const { controller } = build(script);
    await runSweep(controller);
    expect(controller.getSnapshot().responders).toHaveLength(1);

    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 5 });
    await drainObservation(controller);
    expect(controller.getSnapshot().phase).toBe('observationComplete');

    const samples = controller.getGuidedSamples();
    for (const phase of ['brake', 'steering', 'throttle'] as const) {
      const forPhase = samplesFor(samples, did1, phase);
      const nonSettling = forPhase.filter((s) => s.tMs >= SETTLE_MS);
      const settling = forPhase.filter((s) => s.tMs < SETTLE_MS);
      // The guarantee (5) is met by NON-settling samples alone.
      expect(nonSettling.length).toBeGreaterThanOrEqual(5);
      // Settling samples were genuinely recorded (never dropped from the
      // log), which is only observable because the fast responder produced
      // some inside the first SETTLE_MS of this phase.
      expect(settling.length).toBeGreaterThan(0);
    }
    // Baseline needs no settle window -- its own 5-sample guarantee is met
    // by samples regardless of their tMs.
    const baselineSamples = samplesFor(samples, did1, 'baseline');
    expect(baselineSamples.length).toBeGreaterThanOrEqual(5);
  }, 60_000);
});
