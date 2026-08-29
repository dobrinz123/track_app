import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Ticket P4k-FIX1 K1 (binding, after Codex P4k-REV1 MEDIUM #1): the
// 3x-hard-cap check in `runCountGuaranteedPhase` runs only BEFORE a slice
// starts -- so the final slice, sized from the CANDIDATE-COUNT/rate formula,
// can itself run well past the cap with no clamp. This mock overrides ONLY
// the per-slice sizing call (`computeGuidedPhaseDurationMs(pending.length,
// PHASE_SLICE_BASE_MS /* 1000 */, ..., 1)`, identified by its distinctive
// `baseDurationMs === 1_000` -- no other call site in the controller passes
// that value) to a FIXED size that does not evenly divide the hard cap, so
// the overrun is deterministic instead of depending on measured response
// rates. Every OTHER caller of `computeGuidedPhaseDurationMs` (the batch's
// own nominal-duration calc inside `planObservationBatches`, and the
// changing-value pre-pass) is untouched -- both call through the ORIGINAL
// function reference, either internally (pre-pass, same module) or via the
// spread-forwarded `actual` implementation.
const HARD_CAP_TEST_SLICE_MS = 10_000;
vi.mock('@circuit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@circuit/core')>();
  return {
    ...actual,
    computeGuidedPhaseDurationMs: vi.fn(
      (candidateCount: number, baseDurationMs: number, assumedReqPerSec?: number, minSamplesPerCandidate?: number) =>
        baseDurationMs === 1_000
          ? HARD_CAP_TEST_SLICE_MS
          : actual.computeGuidedPhaseDurationMs(candidateCount, baseDurationMs, assumedReqPerSec, minSamplesPerCandidate),
    ),
  };
});
import type { DidObservationPhaseId, ObdTransport } from '@circuit/core';
import { createDidSweepController } from '../../src/session/didSweepController';
import { FakeSweepTransport, TARGET_ADDRESS, TESTER_ADDRESS, flush, monotonicCounter, positivePdu, type ScriptEntry } from '../support/didSweepHarness';

/**
 * Ticket P4k-FIX1 K1 (binding): "the 3x hard cap is checked only before
 * launching a full slice -> the final slice can overrun the cap." Every
 * phase's nominal duration here floors to `DID_OBSERVATION_PHASES`' own 6s
 * (the DID's discovery-sweep response is fast, so the rate-derived duration
 * is far below the floor) -- so the hard cap is exactly 3 x 6000 = 18000ms,
 * a fact this test relies on for its exact-timing assertions.
 */
const NOMINAL_PHASE_MS = 6_000;
const HARD_CAP_MS = NOMINAL_PHASE_MS * 3; // PHASE_HARD_CAP_MULTIPLIER (not exported) -- 18_000.
/**
 * `runDidObservation` (core) cannot preempt a request already in flight when
 * its own window expires -- the round already under way (bounded by its
 * `targetHz: 1` round budget, default 1000ms) is allowed to finish before the
 * NEXT `shouldContinue()` check ends the call. That is expected, orthogonal
 * behaviour this ticket does not touch; the assertions below allow for ONE
 * such round on top of the hard cap, while still catching K1's actual defect
 * (an UNCLAMPED final slice, which overran by ~2000ms+ pre-fix -- see the red
 * run this ticket's report cites).
 */
const ONE_ROUND_BUDGET_MS = 1_000;

const SWEEP_FROM = 0x0001;
const SWEEP_TO = 0x0001;

/** Responds ONCE, during the discovery sweep (so the DID is a responder at all), then goes silent for the whole observation -- the DID never earns a single sample in ANY phase, so it stays `stillShort` (and its miss counter never gets a chance to hit the 3-consecutive-miss budget, since a slice with no response at all still only counts as ONE miss) all the way to the hard cap. */
function quietAfterSweep(did: number): ScriptEntry {
  return { responses: [positivePdu(did, [0x10])], mode: 'oneFramePerSend', delayMs: 5, stopAfterList: true };
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

async function drainObservation(controller: ReturnType<typeof createDidSweepController>, maxSteps = 200): Promise<void> {
  for (let i = 0; i < maxSteps && controller.getSnapshot().phase === 'observing'; i += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
  }
}

describe('P4k-FIX1 K1 -- runCountGuaranteedPhase never overruns the 3x hard cap (binding)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a DID that never earns a single sample keeps each phase within the hard cap, and ends `insufficient`', async () => {
    const did1 = 0x0001;
    const script = new Map<number, ScriptEntry>([[did1, quietAfterSweep(did1)]]);
    const { controller } = build(script);
    await runSweep(controller);
    expect(controller.getSnapshot().responders).toHaveLength(1);

    const transitions: { phase: DidObservationPhaseId | 'prePass' | null; atMs: number }[] = [];
    let lastPhase: DidObservationPhaseId | 'prePass' | null | undefined;
    const unsubscribe = controller.subscribe((s) => {
      if (s.guidedPhase !== lastPhase) {
        lastPhase = s.guidedPhase;
        transitions.push({ phase: s.guidedPhase, atMs: Date.now() });
      }
    });

    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 5 });
    await drainObservation(controller);
    unsubscribe();

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(controller.getSnapshot().observationInsufficientDids).toContain(did1);

    for (const phase of ['baseline', 'brake', 'steering', 'throttle'] as const) {
      const startIdx = transitions.findIndex((t) => t.phase === phase);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      const nextEntry = transitions[startIdx + 1];
      expect(nextEntry).toBeDefined();
      const elapsedMs = nextEntry!.atMs - transitions[startIdx]!.atMs;
      // Pre-fix, the last slice (sized 10_000ms, which does not divide 18_000
      // evenly) runs to completion regardless of how much cap budget is left
      // -- 10_000 + 10_000 = 20_000ms, ~2_000ms past the 18_000ms cap (see
      // this ticket's red-run evidence: 20_085ms). Post-fix it is clamped to
      // the remaining budget (measured: 18_075ms) -- comfortably inside the
      // one-round tolerance below, where the pre-fix overrun is not.
      expect(elapsedMs).toBeLessThanOrEqual(HARD_CAP_MS + ONE_ROUND_BUDGET_MS);
    }
  }, 40_000);
});
