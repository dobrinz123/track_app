import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMetronomeTimeline, type SignalActionScript, type SignalTargetCatalog } from '@circuit/core';
import { createEnetAdapterReservation as createReservation } from '../../src/session/enetAdapterReservation';
import { createSignalFinderController, type SignalFinderControllerDeps } from '../../src/session/signalFinderController';
import { createInMemoryDidSweepStore, createInMemoryVehicleProfileBindingStore } from '../../src/persistence/didSweepStore';
import { MultiEcuFakeTransport, TESTER_ADDRESS, bytes, flush, type DidAnswer } from '../support/signalFinderHarness';

/**
 * Ticket P4l S2 / contracts.md "Signal Finder (Phase 4l)" item 2 (binding):
 * "the finder iterates target addresses itself (0x12, 0x29, ...) using the
 * existing ENET transport/reservation; it polls at most 16 DIDs per ECU per
 * pass (rate-derived, like the batched flow) and ALSO includes cached
 * responders of that ECU from previous sweep runs stored in SQLite
 * (`did_sweep_responders`), filtered by the target's expected shape".
 */

/** A deliberately short script so a whole metronome run fits in a few fake-timer seconds. */
const TEST_SCRIPT: SignalActionScript = {
  repetitions: 2,
  baselineMs: 1_000,
  pressMs: 1_000,
  holdMs: 0,
  releaseMs: 1_000,
  settleMs: 200,
};

const TIMELINE = buildMetronomeTimeline(TEST_SCRIPT);

/** A two-ECU catalog with one brake target -- the finder must never know it is a Supra. */
const TEST_CATALOG: SignalTargetCatalog = {
  profileId: 'test-profile',
  label: 'Test vehicle',
  targets: [
    {
      id: 'brakeSwitch',
      label: 'Brake switch',
      engineRequirement: 'off-ok',
      expectedShape: 'boolean-edge',
      actionScript: TEST_SCRIPT,
      verbs: { baseline: 'Hold still', press: 'PRESS the brake', hold: 'HOLD', release: 'RELEASE the brake' },
      hypotheses: [
        { ecu: 0x29, did: 0x500c, length: 1, decode: 'bit0', status: 'field-observed', provenance: 'test fixture from field test 4' },
        { ecu: 0x12, did: 0x58b7, length: 1, decode: 'u8', status: 'hypothesis', provenance: 'test fixture' },
      ],
      discoveryRanges: [{ ecu: 0x29, fromDid: 0x58f3, toDid: 0x6fff, note: 'unswept remainder' }],
    },
    {
      id: 'steeringAngle',
      label: 'Steering angle',
      engineRequirement: 'off-ok',
      expectedShape: 'analog-bipolar',
      actionScript: TEST_SCRIPT,
      verbs: { baseline: 'Hold still', press: 'TURN', hold: 'HOLD', release: 'CENTRE' },
      hypotheses: [],
      discoveryRanges: [{ ecu: 0x30, fromDid: 0x4000, toDid: 0x4fff, note: 'EPS candidate' }],
    },
  ],
};

/** True while `tMs` falls inside a press evidence window of the metronome. */
function pressedAt(tMs: number): boolean {
  return TIMELINE.steps.some((s) => s.kind === 'press' && tMs >= s.evidenceFromMs && tMs < s.evidenceToMs);
}

interface Harness {
  controller: ReturnType<typeof createSignalFinderController>;
  transports: MultiEcuFakeTransport[];
  reservation: ReturnType<typeof createReservation>;
}

function makeController(
  answer: (ecu: number, did: number, tMs: number) => DidAnswer,
  overrides: Partial<SignalFinderControllerDeps> = {},
): Harness {
  const transports: MultiEcuFakeTransport[] = [];
  const reservation = overrides.reservation ?? createReservation();
  const controller = createSignalFinderController({
    transportFactory: () => {
      const transport = new MultiEcuFakeTransport({ answer });
      transports.push(transport);
      return transport;
    },
    testerAddress: TESTER_ADDRESS,
    clock: { now: () => Date.now() },
    nowUtc: () => new Date(Date.now()).toISOString(),
    catalog: TEST_CATALOG,
    reservation,
    ...overrides,
  });
  return { controller, transports, reservation: reservation as ReturnType<typeof createReservation> };
}

/** Runs the whole find, driving fake timers until it settles. */
async function runFind(harness: Harness, targetId: 'brakeSwitch' | 'steeringAngle' = 'brakeSwitch'): Promise<void> {
  const done = harness.controller.find(targetId);
  for (let i = 0; i < 200; i += 1) {
    await vi.advanceTimersByTimeAsync(200);
    if (harness.controller.getSnapshot().phase === 'result' || harness.controller.getSnapshot().phase === 'error') break;
  }
  await done;
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-29T18:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSignalFinderController -- one session across ECUs', () => {
  it('iterates the target s ECUs in ascending order, one fresh transport per pass, and finds the brake', async () => {
    const harness = makeController((ecu, did, tMs) => {
      if (ecu === 0x29 && did === 0x500c) return bytes(pressedAt(tMs) ? '05' : '04');
      if (ecu === 0x12 && did === 0x58b7) return bytes('00');
      return 'nrc';
    });
    await runFind(harness);

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.phase).toBe('result');
    expect(snapshot.passes.map((p) => p.ecu)).toEqual([0x12, 0x29]);
    // H1/H2 discipline (didSweepController): a FRESH transport per pass, each
    // one closed.
    expect(harness.transports).toHaveLength(2);
    for (const transport of harness.transports) {
      expect(transport.connectCalls).toBe(1);
      expect(transport.closeCalls).toBe(1);
    }

    const found = snapshot.scores.filter((s) => s.verdict === 'found');
    expect(found.map((s) => [s.ecu, s.did])).toEqual([[0x29, 0x500c]]);
    expect(found[0]).toMatchObject({ matchedEdges: TIMELINE.expectedEdges, baselineChanges: 0 });
    // The static DME DID answered every read and simply never moved.
    expect(snapshot.scores.find((s) => s.did === 0x58b7)?.verdict).toBe('unrelated');
    expect(snapshot.error).toBeNull();
  });

  it('adds cached responders of that ECU from previous sweep runs, filtered by the target s shape', async () => {
    const sweepStore = createInMemoryDidSweepStore();
    await sweepStore.createRun({
      runId: 'run-29',
      adapterType: 'enet',
      targetAddress: 0x29,
      rangeFrom: 0x5000,
      rangeTo: 0x58f2,
      lastDid: 0x58f2,
      startedAtUtc: '2026-08-29T17:32:56.879Z',
      updatedAtUtc: '2026-08-29T17:35:38.263Z',
      status: 'stopped',
      visitedCount: 2_291,
      timeoutCount: 0,
      unmatchedCount: 0,
      errorCount: 0,
      nrcCounts: {},
    });
    await sweepStore.upsertResponders(
      'run-29',
      [
        { did: 0x500b, raw: bytes('0002'), rttMs: 12 }, // 2 bytes -- a plausible switch/analog.
        { did: 0x5003, raw: bytes('07'), rttMs: 12 },
        // A 21-byte block joins the pool (scored per byte offset); the ASCII
        // identification string never does.
        { did: 0x5002, raw: bytes('0000019A840101010058070500001B1A480A28FFFF'), rttMs: 12 },
        { did: 0x5056, raw: bytes('3252424652303230300000'), rttMs: 12 },
      ],
      '2026-08-29T17:33:00.000Z',
    );

    const harness = makeController((_ecu, _did, tMs) => bytes(pressedAt(tMs) ? '05' : '04'), { sweepStore });
    await runFind(harness);

    const pass29 = harness.controller.getSnapshot().passes.find((p) => p.ecu === 0x29);
    expect(pass29).toBeDefined();
    // Hypotheses first, then the cached responders that survived the filter.
    expect(pass29!.dids).toEqual([0x500c, 0x5003, 0x500b, 0x5002]);
    expect(pass29!.hypothesisDids).toEqual([0x500c]);
    expect(pass29!.cachedDids).toEqual([0x5003, 0x500b, 0x5002]);
    expect(pass29!.dids).not.toContain(0x5056);
  });

  it('never polls more than the per-pass cap (16 DIDs)', async () => {
    const sweepStore = createInMemoryDidSweepStore();
    await sweepStore.createRun({
      runId: 'run-29',
      adapterType: 'enet',
      targetAddress: 0x29,
      rangeFrom: 0x5000,
      rangeTo: 0x5fff,
      lastDid: 0x5fff,
      startedAtUtc: '2026-08-29T17:32:56.879Z',
      updatedAtUtc: '2026-08-29T17:35:38.263Z',
      status: 'complete',
      visitedCount: 4_096,
      timeoutCount: 0,
      unmatchedCount: 0,
      errorCount: 0,
      nrcCounts: {},
    });
    await sweepStore.upsertResponders(
      'run-29',
      Array.from({ length: 40 }, (_v, i) => ({ did: 0x5100 + i, raw: bytes('00'), rttMs: 10 })),
      '2026-08-29T17:33:00.000Z',
    );

    const harness = makeController(() => bytes('00'), { sweepStore });
    await runFind(harness);
    const pass29 = harness.controller.getSnapshot().passes.find((p) => p.ecu === 0x29);
    expect(pass29!.dids).toHaveLength(16);
    expect(pass29!.dids[0]).toBe(0x500c); // the hypothesis is never squeezed out by cached responders.
  });

  it('tolerates NRC -- the DID is reported as "no response", the run still completes', async () => {
    const harness = makeController((ecu, did, tMs) => {
      if (ecu === 0x29 && did === 0x500c) return bytes(pressedAt(tMs) ? '05' : '04');
      return 'nrc';
    });
    await runFind(harness);
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.phase).toBe('result');
    expect(snapshot.noResponseDids).toEqual([{ ecu: 0x12, did: 0x58b7 }]);
    expect(snapshot.scores.some((s) => s.did === 0x58b7)).toBe(false);
  });
});

describe('createSignalFinderController -- metronome, haptics and lifecycle', () => {
  it('walks the driver through baseline -> press -> release with a countdown, and taps once per step', async () => {
    const taps: string[] = [];
    const harness = makeController(() => bytes('00'), {
      haptics: { step: (kind) => taps.push(kind) },
    });
    const kinds: string[] = [];
    harness.controller.subscribe((s) => {
      const kind = s.step?.kind;
      if (kind !== undefined && kinds[kinds.length - 1] !== kind) kinds.push(kind);
    });

    const done = harness.controller.find('brakeSwitch');
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.controller.getSnapshot().phase).toBe('reading');
    expect(harness.controller.getSnapshot().step?.kind).toBe('baseline');
    expect(harness.controller.getSnapshot().step?.prompt).toBe('Hold still');
    const countdownAtStart = harness.controller.getSnapshot().step!.countdownMs;
    await vi.advanceTimersByTimeAsync(400);
    expect(harness.controller.getSnapshot().step!.countdownMs).toBeLessThan(countdownAtStart);

    for (let i = 0; i < 200; i += 1) {
      await vi.advanceTimersByTimeAsync(200);
      if (harness.controller.getSnapshot().phase === 'result') break;
    }
    await done;

    // Each ECU pass runs the WHOLE metronome (the driver presses again for
    // the next ECU) -- 2 passes x baseline/press/release/press/release.
    expect(kinds).toEqual([
      'baseline', 'press', 'release', 'press', 'release',
      'baseline', 'press', 'release', 'press', 'release',
    ]);
    // One haptic per step, per ECU pass (2 passes x 5 steps).
    expect(taps).toHaveLength(10);
  });

  it('holds the adapter reservation for the whole session and releases it afterwards', async () => {
    const reservation = createReservation();
    const harness = makeController(() => bytes('00'), { reservation });
    const holders: (string | null)[] = [];
    reservation.subscribe((holder) => holders.push(holder));
    await runFind(harness);
    expect(holders).toContain('signalFinder');
    expect(reservation.holder()).toBeNull();
  });

  it('reports a refused reservation as an error -- never throws, never opens a transport', async () => {
    const reservation = createReservation();
    reservation.tryAcquire('provider');
    const harness = makeController(() => bytes('00'), { reservation });
    await harness.controller.find('brakeSwitch');
    await flush();
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.phase).toBe('error');
    expect(snapshot.error).toMatch(/adapter is in use/i);
    expect(harness.transports).toHaveLength(0);
  });

  it('a connect failure closes down cleanly, releases the reservation and reports the error', async () => {
    const reservation = createReservation();
    const controller = createSignalFinderController({
      transportFactory: () => new MultiEcuFakeTransport({ answer: () => 'nrc' }, { refuseConnect: true }),
      testerAddress: TESTER_ADDRESS,
      clock: { now: () => Date.now() },
      catalog: TEST_CATALOG,
      reservation,
    });
    await controller.find('brakeSwitch');
    await flush();
    expect(controller.getSnapshot().phase).toBe('error');
    expect(controller.getSnapshot().error).toMatch(/refused/i);
    expect(reservation.holder()).toBeNull();
  });

  it('stop() ends the run early, closes the transport and releases the reservation', async () => {
    const reservation = createReservation();
    const harness = makeController(() => bytes('00'), { reservation });
    const done = harness.controller.find('brakeSwitch');
    await vi.advanceTimersByTimeAsync(300);
    expect(reservation.holder()).toBe('signalFinder');
    const stopped = harness.controller.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopped;
    await done;
    expect(reservation.holder()).toBeNull();
    expect(harness.transports[0]!.closeCalls).toBe(1);
    expect(harness.controller.getSnapshot().phase).not.toBe('reading');
  });

  it('a target with no hypotheses reads nothing and names the next concrete step instead', async () => {
    const harness = makeController(() => bytes('00'));
    await runFind(harness, 'steeringAngle');
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.passes).toEqual([]);
    expect(harness.transports).toHaveLength(0);
    expect(snapshot.phase).toBe('result');
    expect(snapshot.nextStep).toMatchObject({ ecu: 0x30, fromDid: 0x4000, toDid: 0x4fff });
    expect(snapshot.nextStep!.estimatedMinutes).toBeGreaterThan(0);
  });

  it('offers the next concrete step whenever nothing was found (item 4, honesty)', async () => {
    const harness = makeController(() => bytes('00'));
    await runFind(harness);
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.scores.every((s) => s.verdict !== 'found')).toBe(true);
    expect(snapshot.nextStep).toMatchObject({ ecu: 0x29, fromDid: 0x58f3, toDid: 0x6fff });
  });
});

describe('confirmBinding', () => {
  it('writes the winning DID into the vehicle profile with its evidence', async () => {
    const bindingStore = createInMemoryVehicleProfileBindingStore();
    const harness = makeController((ecu, did, tMs) => {
      if (ecu === 0x29 && did === 0x500c) return bytes(pressedAt(tMs) ? '05' : '04');
      return 'nrc';
    }, { bindingStore, profileId: 'test-profile' });
    await runFind(harness);

    const winner = harness.controller.getSnapshot().scores.find((s) => s.verdict === 'found')!;
    const written = await harness.controller.confirmBinding('brakeSwitch', winner);
    expect(written).toMatchObject({
      profileId: 'test-profile',
      channel: 'brakeSwitch',
      ecu: 0x29,
      did: 0x500c,
      length: 1,
      status: 'field-confirmed',
    });
    const stored = await bindingStore.getBinding('test-profile', 'brakeSwitch');
    expect(stored).toMatchObject({ did: 0x500c, status: 'field-confirmed' });
    const evidence: unknown = JSON.parse(stored!.evidenceJson);
    expect(evidence).toMatchObject({ matchedEdges: TIMELINE.expectedEdges, expectedEdges: TIMELINE.expectedEdges, baselineChanges: 0 });
    expect(harness.controller.getSnapshot().confirmedChannels).toContain('brakeSwitch');
  });

  it('is a no-op returning null when no binding store is wired (web preview)', async () => {
    const harness = makeController(() => bytes('00'));
    await runFind(harness);
    const any = harness.controller.getSnapshot().scores[0]!;
    expect(await harness.controller.confirmBinding('brakeSwitch', any)).toBeNull();
  });
});

