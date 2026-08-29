import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMetronomeTimeline, type SignalActionScript, type SignalTargetCatalog } from '@circuit/core';
import { createEnetAdapterReservation as createReservation } from '../../src/session/enetAdapterReservation';
import { createSignalFinderController, type SignalFinderControllerDeps } from '../../src/session/signalFinderController';
import { createInMemoryDidSweepStore, createInMemoryVehicleProfileBindingStore } from '../../src/persistence/didSweepStore';
import { MultiEcuFakeTransport, TESTER_ADDRESS, bytes, flush, type DidAnswer } from '../support/signalFinderHarness';

/**
 * Ticket P4m M2 / contracts.md "Signal Finder REVISION (2026-08-29, after
 * field test 5)" items 9–12 (binding):
 *
 *   "One metronome per FIND ... Budget, not passes ... All ECUs are polled in
 *    the SAME session (per-entry target address). Whatever does not fit is
 *    listed as 'not read (N) — Next round' with the button; each round is one
 *    more full script ... DIDs never polled are 'not read', never 'no
 *    response'."
 *
 * What build 5 did instead (field test 5): 91 passes, ONE FULL 24 s METRONOME
 * EACH, hypotheses queued last, 1372 never-read DIDs reported as "No response".
 * The user did the press script ~40 times and the DIDs that actually carried
 * the brake were never reached.
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
      verbs: {
        en: { baseline: 'Hold still', press: 'PRESS the brake', hold: 'HOLD', release: 'RELEASE the brake' },
        ro: { baseline: 'Stai liniștit', press: 'APASĂ frâna', hold: 'ȚINE', release: 'ELIBEREAZĂ frâna' },
      },
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
      verbs: {
        en: { baseline: 'Hold still', press: 'TURN', hold: 'HOLD', release: 'CENTRE' },
        ro: { baseline: 'Stai liniștit', press: 'ROTEȘTE', hold: 'ȚINE', release: 'CENTRU' },
      },
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

/** Drives fake timers until the controller settles. */
async function drive(harness: Harness, run: Promise<void>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await vi.advanceTimersByTimeAsync(100);
    const phase = harness.controller.getSnapshot().phase;
    if (phase === 'result' || phase === 'error' || phase === 'idle') break;
  }
  await run;
  await flush();
}

async function runFind(harness: Harness, targetId: 'brakeSwitch' | 'steeringAngle' = 'brakeSwitch'): Promise<void> {
  await drive(harness, harness.controller.find(targetId));
}

async function runNextRound(harness: Harness): Promise<void> {
  await drive(harness, harness.controller.nextRound());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-29T18:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSignalFinderController -- ONE metronome, ONE session, every ECU (items 9-10)', () => {
  it('runs exactly ONE script on ONE transport and polls both ECUs inside it', async () => {
    const harness = makeController((ecu, did, tMs) => {
      if (ecu === 0x29 && did === 0x500c) return bytes(pressedAt(tMs) ? '05' : '04');
      if (ecu === 0x12 && did === 0x58b7) return bytes('00');
      return 'nrc';
    });
    await runFind(harness);

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.phase).toBe('result');
    expect(snapshot.round).toBe(1);
    // ONE transport, opened once and closed once -- not one per ECU.
    expect(harness.transports).toHaveLength(1);
    expect(harness.transports[0]!.connectCalls).toBe(1);
    expect(harness.transports[0]!.closeCalls).toBe(1);
    // Both ECUs were addressed inside that one session (per-entry target address).
    const addressed = new Set(harness.transports[0]!.requests.map((r) => r.ecu));
    expect([...addressed].sort((a, b) => a - b)).toEqual([0x12, 0x29]);

    const found = snapshot.scores.filter((s) => s.verdict === 'found');
    expect(found.map((s) => [s.ecu, s.did])).toEqual([[0x29, 0x500c]]);
    expect(snapshot.error).toBeNull();
  });

  it('paces the driver through the script exactly ONCE -- the build 5 defect was one full metronome per pass', async () => {
    const taps: string[] = [];
    const harness = makeController(() => bytes('00'), { haptics: { step: (kind) => taps.push(kind) } });
    const kinds: string[] = [];
    harness.controller.subscribe((s) => {
      const kind = s.step?.kind;
      if (kind !== undefined && kinds[kinds.length - 1] !== kind) kinds.push(kind);
    });
    await runFind(harness);
    expect(kinds).toEqual(['baseline', 'press', 'release', 'press', 'release']);
    expect(taps).toHaveLength(5);
  });

  it('reads the hypotheses of EVERY ECU first, within the rate-derived budget', async () => {
    const sweepStore = createInMemoryDidSweepStore();
    await seedRun(sweepStore, 'run-29', 0x29);
    await sweepStore.upsertResponders(
      'run-29',
      Array.from({ length: 30 }, (_v, i) => ({ did: 0x5100 + i, raw: bytes('00'), rttMs: 10 })),
      '2026-08-29T17:33:00.000Z',
    );
    const harness = makeController(() => bytes('00'), { sweepStore, measuredReqPerSec: 15 });
    await runFind(harness);
    const snapshot = harness.controller.getSnapshot();

    expect(snapshot.budget).toBe(12);
    expect(snapshot.readDids).toHaveLength(12);
    // Both hypotheses lead, whatever ECU they are on.
    expect(snapshot.readDids.slice(0, 2)).toEqual([
      { ecu: 0x12, did: 0x58b7 },
      { ecu: 0x29, did: 0x500c },
    ]);
    // Item 12 (honesty): the rest is NOT READ, and is never reported as "no response".
    expect(snapshot.notReadCount).toBe(20);
    expect(snapshot.notReadDids).toHaveLength(20);
    for (const entry of snapshot.notReadDids) {
      expect(snapshot.noResponseDids).not.toContainEqual(entry);
    }
  });

  it('nextRound() reads the NEXT slice -- only on an explicit call, one more script, nothing re-read', async () => {
    const sweepStore = createInMemoryDidSweepStore();
    await seedRun(sweepStore, 'run-29', 0x29);
    await sweepStore.upsertResponders(
      'run-29',
      Array.from({ length: 30 }, (_v, i) => ({ did: 0x5100 + i, raw: bytes('00'), rttMs: 10 })),
      '2026-08-29T17:33:00.000Z',
    );
    const harness = makeController(() => bytes('00'), { sweepStore, measuredReqPerSec: 15 });
    await runFind(harness);
    const first = harness.controller.getSnapshot();
    expect(first.round).toBe(1);
    expect(harness.transports).toHaveLength(1);

    await runNextRound(harness);
    const second = harness.controller.getSnapshot();
    expect(second.round).toBe(2);
    expect(harness.transports).toHaveLength(2); // one fresh session per round.
    expect(second.readDids).toHaveLength(24);
    expect(second.notReadCount).toBe(8);
    // No DID was read twice.
    const keys = second.readDids.map((entry) => `${entry.ecu}:${entry.did}`);
    expect(new Set(keys).size).toBe(keys.length);
    // The result now says "24 DIDs across 2 ECUs in 2 rounds".
    expect(second.passes.map((p) => p.ecu).sort((a, b) => a - b)).toEqual([0x12, 0x29]);
    expect(second.passes.reduce((total, pass) => total + pass.dids.length, 0)).toBe(24);
  });

  it('prioritises cached DIDs that CHANGED in an earlier observation over plain responders', async () => {
    const sweepStore = createInMemoryDidSweepStore();
    await seedRun(sweepStore, 'run-29', 0x29);
    await sweepStore.upsertResponders(
      'run-29',
      [
        { did: 0x5001, raw: bytes('00'), rttMs: 10 },
        { did: 0x5002, raw: bytes('00'), rttMs: 10 },
        { did: 0x5003, raw: bytes('00'), rttMs: 10 },
        { did: 0x5004, raw: bytes('00'), rttMs: 10 },
      ],
      '2026-08-29T17:33:00.000Z',
    );
    await sweepStore.saveObservationSummary(
      'run-29',
      'obs-1',
      JSON.stringify({
        candidates: [
          { did: 0x5004, rank: 'brakeCandidate' },
          { did: 0x5002, rank: 'static' },
          { did: 0x5001, rank: 'insufficient' },
          { did: 0x5003, rank: 'changedInSeveral' },
        ],
        blockCandidates: [],
      }),
      '2026-08-29T17:34:00.000Z',
    );

    const harness = makeController(() => bytes('00'), { sweepStore, measuredReqPerSec: 15, maxDidsPerRound: 4 });
    await runFind(harness);
    const read = harness.controller.getSnapshot().readDids;
    // Hypotheses (both ECUs) first, then the two DIDs with prior CHANGE
    // evidence, in the order the summary ranked them.
    expect(read).toEqual([
      { ecu: 0x12, did: 0x58b7 },
      { ecu: 0x29, did: 0x500c },
      { ecu: 0x29, did: 0x5004 },
      { ecu: 0x29, did: 0x5003 },
    ]);
  });

  it('tolerates NRC -- that DID is "no response", and never appears as "not read"', async () => {
    const harness = makeController((ecu, did, tMs) => {
      if (ecu === 0x29 && did === 0x500c) return bytes(pressedAt(tMs) ? '05' : '04');
      return 'nrc';
    });
    await runFind(harness);
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.noResponseDids).toEqual([{ ecu: 0x12, did: 0x58b7 }]);
    expect(snapshot.notReadDids).toEqual([]);
    expect(snapshot.scores.some((s) => s.did === 0x58b7)).toBe(false);
  });

  it('renders the metronome prompts in the app s language (M4)', async () => {
    const prompts: string[] = [];
    const harness = makeController(() => bytes('00'), { getLanguage: () => 'ro' });
    harness.controller.subscribe((s) => {
      const prompt = s.step?.prompt;
      if (prompt !== undefined && prompts[prompts.length - 1] !== prompt) prompts.push(prompt);
    });
    await runFind(harness);
    expect(prompts).toContain('APASĂ frâna');
    expect(prompts).not.toContain('PRESS the brake');
  });
});

describe('createSignalFinderController -- lifecycle (unchanged discipline)', () => {
  it('holds the adapter reservation for the whole round and releases it afterwards', async () => {
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

  it('a target with no hypotheses and no cache reads nothing and names the next concrete step instead', async () => {
    const harness = makeController(() => bytes('00'));
    await runFind(harness, 'steeringAngle');
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.readDids).toEqual([]);
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

  it('nextRound() is a no-op when nothing is left unread', async () => {
    const harness = makeController(() => bytes('00'));
    await runFind(harness);
    expect(harness.controller.getSnapshot().notReadCount).toBe(0);
    await runNextRound(harness);
    expect(harness.controller.getSnapshot().round).toBe(1);
    expect(harness.transports).toHaveLength(1);
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
    expect(evidence).toMatchObject({ expectedEdges: TIMELINE.expectedEdges, baselineChanges: 0 });
    expect(harness.controller.getSnapshot().confirmedChannels).toContain('brakeSwitch');
  });

  it('is a no-op returning null when no binding store is wired (web preview)', async () => {
    const harness = makeController(() => bytes('00'));
    await runFind(harness);
    const any = harness.controller.getSnapshot().scores[0]!;
    expect(await harness.controller.confirmBinding('brakeSwitch', any)).toBeNull();
  });
});

async function seedRun(
  store: ReturnType<typeof createInMemoryDidSweepStore>,
  runId: string,
  targetAddress: number,
): Promise<void> {
  await store.createRun({
    runId,
    adapterType: 'enet',
    targetAddress,
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
}
