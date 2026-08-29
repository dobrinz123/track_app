import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DidObservationPhaseId, ObdTransport } from '@circuit/core';
import { createDidSweepController, parseFocusedDidList } from '../../src/session/didSweepController';
import { createEnetAdapterReservation } from '../../src/session/enetAdapterReservation';
import { createInMemoryDidSweepStore } from '../../src/persistence/didSweepStore';
import {
  FakeSweepTransport,
  TARGET_ADDRESS,
  TESTER_ADDRESS,
  flush,
  monotonicCounter,
  negativePdu,
  positivePdu,
  type ScriptEntry,
} from '../support/didSweepHarness';

/**
 * Ticket P4j-FIX1 (binding, after Codex P4j-REV1) + the coordinator's binding
 * pre-pass/shortlist addendum. Every test here FAILED against HEAD 6c38985:
 *  - H1: the "5 samples per DID per phase" guarantee was duration math only.
 *  - H2/M3: length-inconsistent DIDs were split into two apparent candidates.
 *  - H3: batched samples/summaries were memory-only.
 *  - M1: batchSize / focused-shortlist / minSamplesPerPhase were uncapped.
 *  - M2: pause() was a no-op during observation; stop() could resolve before
 *        the socket closed and the reservation was released.
 *  - M5: the legacy flows had been widened to the 1-32-byte pool.
 *  - addendum: the two-sample pre-pass EXCLUDED DIDs from the guided phases.
 */

const SWEEP_FROM = 0x0001;
const SWEEP_TO = 0x0004;

/** Answers forever with a value that alternates -- a live, always-responding DID. */
function livePositive(did: number, values: readonly number[][]): ScriptEntry {
  return { responses: values.map((v) => positivePdu(did, v)), mode: 'oneFramePerSend', delayMs: 5 };
}

interface Built {
  controller: ReturnType<typeof createDidSweepController>;
  transports: FakeSweepTransport[];
}

function build(script: Map<number, ScriptEntry>, extra: Partial<Parameters<typeof createDidSweepController>[0]> = {}): Built {
  const transports: FakeSweepTransport[] = [];
  const controller = createDidSweepController({
    transportFactory: (): ObdTransport => {
      const transport = new FakeSweepTransport(script);
      transports.push(transport);
      return transport;
    },
    testerAddress: TESTER_ADDRESS,
    targetAddress: TARGET_ADDRESS,
    clock: monotonicCounter(),
    ...extra,
  });
  return { controller, transports };
}

async function runSweep(controller: ReturnType<typeof createDidSweepController>): Promise<void> {
  controller.start({ from: SWEEP_FROM, to: SWEEP_TO });
  await vi.runAllTimersAsync();
  await flush();
}

async function drainObservation(controller: ReturnType<typeof createDidSweepController>, maxSteps = 400): Promise<void> {
  for (let i = 0; i < maxSteps && controller.getSnapshot().phase === 'observing'; i += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
  }
}

function samplesPerPhase(
  samples: readonly { did: number; phase: DidObservationPhaseId }[],
  did: number,
  phase: DidObservationPhaseId,
): number {
  return samples.filter((s) => s.did === did && s.phase === phase).length;
}

describe('P4j-FIX1 H1 — the sample guarantee is by COUNT, not duration (binding)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('every DID reaches minSamplesPerPhase POSITIVE samples in EVERY phase (the default 5, not a duration guess)', async () => {
    const did1 = 0x0001;
    const did2 = 0x0002;
    const script = new Map<number, ScriptEntry>([
      [did1, livePositive(did1, [[0x10], [0x11]])],
      [did2, livePositive(did2, [[0x20], [0x21]])],
    ]);
    const { controller } = build(script);
    await runSweep(controller);
    expect(controller.getSnapshot().responders).toHaveLength(2);

    // 10 samples/DID/phase over 2 DIDs at ~1 round/s needs ~10s per phase --
    // far longer than the 6s nominal window the pre-fix duration math sized
    // (which delivered only ~6 samples and called the guarantee met).
    controller.startBatchedObservation({ batchSize: 2, minSamplesPerPhase: 10 });
    await drainObservation(controller, 600);

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    const samples = controller.getGuidedSamples();
    for (const did of [did1, did2]) {
      for (const phase of ['baseline', 'brake', 'steering', 'throttle'] as const) {
        expect(samplesPerPhase(samples, did, phase)).toBeGreaterThanOrEqual(10);
      }
    }
  }, 90_000);

  it('a DID that goes quiet (timeouts) is marked `insufficient` after the bounded failure budget instead of blocking the phase forever', async () => {
    const live = 0x0001;
    const quiet = 0x0002;
    const script = new Map<number, ScriptEntry>([
      [live, livePositive(live, [[0x10], [0x11]])],
      // Answers the sweep once, then never again -- exactly the field case
      // (an NRC/timeout tail DID) the pre-fix duration math left at 0 samples.
      [quiet, { responses: [positivePdu(quiet, [0x20])], mode: 'oneFramePerSend', delayMs: 5, stopAfterList: true }],
    ]);
    const { controller } = build(script);
    await runSweep(controller);

    controller.startBatchedObservation({ batchSize: 2, minSamplesPerPhase: 5 });
    await drainObservation(controller);

    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('observationComplete');
    expect(snapshot.observationInsufficientDids).toContain(quiet);
    // The live DID still got its full budget -- the quiet one never stalled it.
    for (const phase of ['baseline', 'brake', 'steering', 'throttle'] as const) {
      expect(samplesPerPhase(controller.getGuidedSamples(), live, phase)).toBeGreaterThanOrEqual(5);
    }
    // Excluded from ranking: never reported as a brake/steering/throttle candidate.
    const quietSummary = snapshot.candidateSummaries.find((c) => c.did === quiet);
    expect(quietSummary === undefined || quietSummary.rank === 'static').toBe(true);
  }, 40_000);

  it('a DID answering only NRC in every phase is reported as no-response, and the run still completes', async () => {
    const live = 0x0001;
    const nrcOnly = 0x0002;
    const script = new Map<number, ScriptEntry>([
      [live, livePositive(live, [[0x10], [0x11]])],
      [nrcOnly, { responses: [positivePdu(nrcOnly, [0x20]), negativePdu(0x31)], mode: 'oneFramePerSend', delayMs: 5 }],
    ]);
    const { controller } = build(script);
    await runSweep(controller);

    controller.startBatchedObservation({ batchSize: 2, minSamplesPerPhase: 5 });
    await drainObservation(controller);

    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('observationComplete');
    expect(snapshot.observationInsufficientDids).toContain(nrcOnly);
  }, 40_000);

  it('the countdown shows the NOMINAL duration and flags "extending" once the phase runs past it', async () => {
    const did1 = 0x0001;
    const script = new Map<number, ScriptEntry>([[did1, livePositive(did1, [[0x10], [0x11]])]]);
    const { controller } = build(script);
    await runSweep(controller);

    const nominalDurations = new Set<number>();
    let sawExtending = false;
    let elapsedEverExceededNominal = false;
    controller.subscribe((s) => {
      if (s.guidedPhase !== null && s.guidedPhaseDurationMs > 0) nominalDurations.add(s.guidedPhaseDurationMs);
      if (s.guidedPhaseExtending) sawExtending = true;
      if (s.guidedPhaseDurationMs > 0 && s.guidedPhaseElapsedMs > s.guidedPhaseDurationMs) elapsedEverExceededNominal = true;
    });

    // 10 samples/phase at ~1 round/s needs ~10s -- longer than the 6s nominal
    // phase window, so the phase must EXTEND rather than cut the guarantee.
    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 10 });
    await drainObservation(controller, 600);

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(sawExtending).toBe(true);
    // The advertised countdown stayed the ONE nominal window (never silently
    // grew to swallow the extension, and never ran past its own total).
    expect(nominalDurations.size).toBe(1);
    expect(elapsedEverExceededNominal).toBe(false);
    expect(controller.getSnapshot().guidedPhaseExtending).toBe(false);
    for (const phase of ['baseline', 'brake', 'steering', 'throttle'] as const) {
      expect(samplesPerPhase(controller.getGuidedSamples(), did1, phase)).toBeGreaterThanOrEqual(10);
    }
  }, 90_000);
});

describe('P4j-FIX1 M3 — group and validate per DID BEFORE numeric/block routing (binding)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a DID alternating between 8 and 9 bytes is marked INCONSISTENT, never split into two apparently consistent candidates', async () => {
    const wobbly = 0x0001;
    const eight = [1, 2, 3, 4, 5, 6, 7, 8];
    const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const script = new Map<number, ScriptEntry>([
      [wobbly, { responses: [positivePdu(wobbly, eight), positivePdu(wobbly, nine)], mode: 'oneFramePerSend', delayMs: 5 }],
    ]);
    const { controller } = build(script);
    await runSweep(controller);

    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 5 });
    await drainObservation(controller);

    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('observationComplete');
    expect(snapshot.inconsistentCandidateDids).toContain(wobbly);
    expect(snapshot.candidateSummaries.some((c) => c.did === wobbly)).toBe(false);
    expect(snapshot.blockCandidateSummaries.some((b) => b.did === wobbly)).toBe(false);
  }, 40_000);

  it('a DID alternating between 32 and 33 bytes is inconsistent too (the 33-byte samples are never silently dropped)', async () => {
    const wobbly = 0x0001;
    const thirtyTwo = new Array<number>(32).fill(0x11);
    const thirtyThree = new Array<number>(33).fill(0x11);
    const script = new Map<number, ScriptEntry>([
      [wobbly, { responses: [positivePdu(wobbly, thirtyTwo), positivePdu(wobbly, thirtyThree)], mode: 'oneFramePerSend', delayMs: 5 }],
    ]);
    const { controller } = build(script);
    await runSweep(controller);

    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 5 });
    await drainObservation(controller);

    const snapshot = controller.getSnapshot();
    expect(snapshot.inconsistentCandidateDids).toContain(wobbly);
    expect(snapshot.blockCandidateSummaries.some((b) => b.did === wobbly)).toBe(false);
  }, 40_000);
});

describe('P4j-FIX1 M1 — hard bounds (binding)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refuses a focused shortlist longer than 16 DIDs with a visible error (never silently runs it)', async () => {
    const did1 = 0x0001;
    const script = new Map<number, ScriptEntry>([[did1, livePositive(did1, [[0x10], [0x11]])]]);
    const { controller } = build(script);
    await runSweep(controller);

    controller.startFocusedObservation(Array.from({ length: 17 }, (_, i) => 0x5000 + i));
    expect(controller.getSnapshot().phase).not.toBe('observing');
    expect(controller.getSnapshot().error).toMatch(/16/);
  }, 20_000);

  it('parseFocusedDidList reports invalid hex tokens as an error instead of silently dropping them', () => {
    expect(parseFocusedDidList('1234,ZZZZ,5678')).toEqual({ dids: [], error: expect.stringContaining('ZZZZ') });
    expect(parseFocusedDidList('1234, 5678')).toEqual({ dids: [0x1234, 0x5678], error: null });
    expect(parseFocusedDidList('0x4A1D 4811')).toEqual({ dids: [0x4a1d, 0x4811], error: null });
    expect(parseFocusedDidList('')).toEqual({ dids: [], error: null });
    expect(parseFocusedDidList(Array.from({ length: 17 }, (_, i) => (0x5000 + i).toString(16)).join(',')).error).toMatch(/16/);
  });
});

describe('P4j-FIX1 M2 — pause/resume during a batched observation, and a stop() that means it (binding)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pause() during a batched run pauses at the next BATCH boundary; resume() continues with the remaining batches', async () => {
    const did1 = 0x0001;
    const did2 = 0x0002;
    const script = new Map<number, ScriptEntry>([
      [did1, livePositive(did1, [[0x10], [0x11]])],
      [did2, livePositive(did2, [[0x20], [0x21]])],
    ]);
    const { controller } = build(script);
    await runSweep(controller);

    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 5 });
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(controller.getSnapshot().phase).toBe('observing');

    void controller.pause().catch(() => undefined);
    for (let i = 0; i < 200 && controller.getSnapshot().phase !== 'paused'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(controller.getSnapshot().phase).toBe('paused');
    // Batch 0's samples survive the pause (state persisted, nothing reset).
    const pausedSamples = [...controller.getGuidedSamples()];
    const pausedCount = pausedSamples.length;
    expect(pausedCount).toBeGreaterThan(0);
    expect(pausedSamples.every((s) => s.did === did1)).toBe(true);

    controller.resume();
    expect(controller.getSnapshot().phase).toBe('observing');
    await drainObservation(controller);

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    const finalSamples = controller.getGuidedSamples();
    expect(finalSamples.some((s) => s.did === did2)).toBe(true);
    expect(finalSamples.length).toBeGreaterThan(pausedCount);
  }, 90_000);

  it('stop() resolves only AFTER the transport is closed and the reservation released', async () => {
    const did1 = 0x0001;
    const script = new Map<number, ScriptEntry>([[did1, livePositive(did1, [[0x10], [0x11]])]]);
    const reservation = createEnetAdapterReservation();
    const { controller, transports } = build(script, { reservation });

    controller.start({ from: SWEEP_FROM, to: SWEEP_TO });
    await vi.advanceTimersByTimeAsync(50);
    await flush();
    expect(transports).toHaveLength(1);
    expect(reservation.tryAcquire('provider')).toBeNull(); // sweep holds it.

    // The assertion is made INSIDE stop()'s own continuation: at the instant
    // it resolves, the socket must already be closed and the claim released
    // (the pre-fix stop() returned only its persistence flush, leaving
    // teardown/release in a detached task -- "adapter in use" on an immediate
    // navigation to telemetry).
    let closedAtResolve = false;
    let releasedAtResolve = false;
    const stopped = controller.stop().then(() => {
      closedAtResolve = transports[0]?.closed === true;
      const token = reservation.tryAcquire('provider');
      releasedAtResolve = token !== null;
      if (token !== null) reservation.release(token);
    });
    await vi.runAllTimersAsync();
    await stopped;

    expect(closedAtResolve).toBe(true);
    expect(releasedAtResolve).toBe(true);
  }, 20_000);
});

describe('P4j-FIX1 M5 — the legacy flows stay on the binding 1-8-byte filter (binding)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('startGuidedObservation() never polls a 24-byte block responder (that is the BATCHED flow\'s widened pool only)', async () => {
    const small = 0x0001;
    const wide = 0x0002;
    const script = new Map<number, ScriptEntry>([
      [small, livePositive(small, [[0x10], [0x11]])],
      [wide, livePositive(wide, [new Array<number>(24).fill(0x33), new Array<number>(24).fill(0x44)])],
    ]);
    const { controller, transports } = build(script);
    await runSweep(controller);
    expect(controller.getSnapshot().responders).toHaveLength(2);

    controller.startGuidedObservation();
    await drainObservation(controller, 200);

    const observationTransport = transports[transports.length - 1];
    expect(observationTransport?.sendCallCountByDid.get(small) ?? 0).toBeGreaterThan(0);
    expect(observationTransport?.sendCallCountByDid.get(wide) ?? 0).toBe(0);
  }, 60_000);

  it('startObservation() (single-window heuristics) never polls a 24-byte block responder either', async () => {
    const small = 0x0001;
    const wide = 0x0002;
    const script = new Map<number, ScriptEntry>([
      [small, livePositive(small, [[0x10], [0x11]])],
      [wide, livePositive(wide, [new Array<number>(24).fill(0x33), new Array<number>(24).fill(0x44)])],
    ]);
    const { controller, transports } = build(script);
    await runSweep(controller);

    controller.startObservation(3_000);
    await drainObservation(controller, 60);

    const observationTransport = transports[transports.length - 1];
    expect(observationTransport?.sendCallCountByDid.get(small) ?? 0).toBeGreaterThan(0);
    expect(observationTransport?.sendCallCountByDid.get(wide) ?? 0).toBe(0);
  }, 60_000);
});

describe('P4j-FIX1 coordinator addendum — the pre-pass is ADVISORY, and a typed shortlist DID is always read (binding)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a DID that was STATIC during the two-sample pre-pass is STILL observed in the guided phases (field: 0x4A1D / 0x4811 / 0x4812)', async () => {
    const moving = 0x0001;
    // A perfectly static, implausible-decode value: the pre-fix
    // `selectChangingCandidates` filter dropped exactly this shape, which is
    // how the brake-booster/accel DIDs never reached the phases at all.
    const staticDid = 0x0002;
    const script = new Map<number, ScriptEntry>([
      [moving, livePositive(moving, [[0x10], [0x11]])],
      [staticDid, livePositive(staticDid, [[0xff, 0xff]])],
    ]);
    const { controller, transports } = build(script);
    await runSweep(controller);
    expect(controller.getSnapshot().responders).toHaveLength(2);

    controller.startGuidedObservation();
    await drainObservation(controller, 200);

    const observationTransport = transports[transports.length - 1];
    expect(observationTransport?.sendCallCountByDid.get(staticDid) ?? 0).toBeGreaterThan(0);
    expect(controller.getGuidedSamples().some((s) => s.did === staticDid)).toBe(true);
  }, 60_000);

  it('the BATCHED flow observes every candidate in the pool -- nothing is pre-filtered away', async () => {
    const moving = 0x0001;
    const staticDid = 0x0002;
    const script = new Map<number, ScriptEntry>([
      [moving, livePositive(moving, [[0x10], [0x11]])],
      [staticDid, livePositive(staticDid, [[0xff, 0xff]])],
    ]);
    const { controller } = build(script);
    await runSweep(controller);

    controller.startBatchedObservation({ batchSize: 2, minSamplesPerPhase: 5 });
    await drainObservation(controller);

    const observed = new Set(controller.getGuidedSamples().map((s) => s.did));
    expect(observed).toContain(moving);
    expect(observed).toContain(staticDid);
  }, 40_000);

  it('a focused shortlist DID the sweep never saw is still read directly, and an NRC-only DID is reported as no-response', async () => {
    const responder = 0x0001;
    const neverSwept = 0x7abc; // outside the swept range entirely.
    const script = new Map<number, ScriptEntry>([
      [responder, livePositive(responder, [[0x10], [0x11]])],
      [neverSwept, { responses: [negativePdu(0x31)], mode: 'oneFramePerSend', delayMs: 5 }],
    ]);
    const { controller, transports } = build(script);
    await runSweep(controller);
    expect(controller.getSnapshot().responders.map((r) => r.did)).not.toContain(neverSwept);

    controller.startFocusedObservation([responder, neverSwept], { minSamplesPerPhase: 3 });
    await drainObservation(controller, 200);

    const observationTransport = transports[transports.length - 1];
    expect(observationTransport?.sendCallCountByDid.get(neverSwept) ?? 0).toBeGreaterThan(0);
    expect(controller.getSnapshot().observationNoResponseDids).toContain(neverSwept);
  }, 60_000);
});

describe('P4j-FIX1 H3 — observation samples and summaries survive a kill/reopen (binding)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('persists the batched series (with batchIndex) and the summary; a RECREATED controller reads them back from the store', async () => {
    const did1 = 0x0001;
    const did2 = 0x0002;
    const script = new Map<number, ScriptEntry>([
      [did1, livePositive(did1, [[0x10], [0x11]])],
      [did2, livePositive(did2, [[0x20], [0x21]])],
    ]);
    const store = createInMemoryDidSweepStore();
    const { controller } = build(script, { store });
    await runSweep(controller);
    const runId = controller.getCurrentRunId();
    expect(runId).not.toBeNull();

    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 5 });
    await drainObservation(controller);
    expect(controller.getSnapshot().phase).toBe('observationComplete');

    const persisted = await store.getObservationSamples(runId as string);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.filter((s) => s.did === did1).every((s) => s.batchIndex === 0)).toBe(true);
    expect(persisted.filter((s) => s.did === did2).every((s) => s.batchIndex === 1)).toBe(true);

    const summaries = await store.getObservationSummaries(runId as string);
    expect(summaries).toHaveLength(1);
    const parsed = JSON.parse(summaries[0]?.summaryJson ?? '{}') as { candidates?: unknown[] };
    expect(Array.isArray(parsed.candidates)).toBe(true);
  }, 40_000);

  it('a LATER observation on the same run APPENDS a new observationId instead of destroying the earlier series', async () => {
    const did1 = 0x0001;
    const script = new Map<number, ScriptEntry>([[did1, livePositive(did1, [[0x10], [0x11]])]]);
    const store = createInMemoryDidSweepStore();
    const { controller } = build(script, { store });
    await runSweep(controller);
    const runId = controller.getCurrentRunId() as string;

    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 5 });
    await drainObservation(controller);
    const afterFirst = await store.getObservationSamples(runId);
    expect(afterFirst.length).toBeGreaterThan(0);

    controller.startFocusedObservation([did1], { minSamplesPerPhase: 3 });
    await drainObservation(controller, 200);

    const afterSecond = await store.getObservationSamples(runId);
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
    expect(new Set(afterSecond.map((s) => s.observationId)).size).toBe(2);
    expect(await store.getObservationSummaries(runId)).toHaveLength(2);
  }, 90_000);
});

describe('P4j-FIX1 — keep-alive and an all-NRC batch (binding: whitelist + "never > 2 s between keep-alives")', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the TesterPresent gap stays within 2 s across every phase, SLICE and batch boundary of a count-guaranteed run', async () => {
    const did1 = 0x0001;
    const did2 = 0x0002;
    const script = new Map<number, ScriptEntry>([
      [did1, livePositive(did1, [[0x10], [0x11]])],
      [did2, livePositive(did2, [[0x20], [0x21]])],
    ]);
    const { controller, transports } = build(script);
    await runSweep(controller);

    // batchSize 1 -> two batches, each phase now several slices: the maximum
    // number of call boundaries the controller-owned ticker has to span.
    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 5 });
    await drainObservation(controller);
    expect(controller.getSnapshot().phase).toBe('observationComplete');

    const observationTransport = transports[transports.length - 1];
    const stamps = observationTransport?.keepAliveAtMs ?? [];
    expect(stamps.length).toBeGreaterThan(1);
    let maxGap = 0;
    for (let i = 1; i < stamps.length; i += 1) maxGap = Math.max(maxGap, stamps[i]! - stamps[i - 1]!);
    expect(maxGap).toBeLessThanOrEqual(2_000);
  }, 60_000);

  it('a batch in which EVERY DID answers only NRC still terminates, ranks nothing, and reports both DIDs', async () => {
    const a = 0x0001;
    const b = 0x0002;
    const script = new Map<number, ScriptEntry>([
      [a, { responses: [positivePdu(a, [0x10]), negativePdu(0x31)], mode: 'oneFramePerSend', delayMs: 5 }],
      [b, { responses: [positivePdu(b, [0x20]), negativePdu(0x31)], mode: 'oneFramePerSend', delayMs: 5 }],
    ]);
    const { controller } = build(script);
    await runSweep(controller);
    expect(controller.getSnapshot().responders).toHaveLength(2);

    controller.startBatchedObservation({ batchSize: 2, minSamplesPerPhase: 5 });
    await drainObservation(controller);

    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('observationComplete');
    expect(snapshot.observationInsufficientDids).toEqual([a, b]);
    expect(snapshot.candidateSummaries.every((c) => c.rank === 'static')).toBe(true);
  }, 60_000);
});
