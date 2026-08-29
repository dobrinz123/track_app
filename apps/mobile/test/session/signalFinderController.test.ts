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

/**
 * A driver who obeys the metronome: the fake ECU's pedal follows the PROMPT
 * currently on screen, not a wall clock.
 *
 * P4m-FIX1 X1 is why this is no longer clock-based: a find now runs a ~2 s
 * PROBE before the script, so the transport's own "ms since my first request"
 * origin is no longer the script's origin. Following the prompt is both
 * closer to the real thing and immune to whatever happens before the script.
 */
interface PedalDouble {
  pressed: boolean;
}

function followMetronome(harness: Harness, pedal: PedalDouble, lagMs = TEST_SCRIPT.settleMs): void {
  let last: string | null = null;
  harness.controller.subscribe((snapshot) => {
    const kind = snapshot.step?.kind ?? null;
    if (kind === last) return;
    last = kind;
    const pressed = kind === 'press' || kind === 'hold';
    // A human reacts LATE -- by exactly the settle the metronome's evidence
    // windows are shifted by (`metronome.ts`). A fake driver who reacted
    // instantly would move the pedal inside the PREVIOUS window's evidence.
    setTimeout(() => {
      pedal.pressed = pressed;
    }, lagMs);
  });
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
    const pedal: PedalDouble = { pressed: false };
    const harness = makeController((ecu, did) => {
      if (ecu === 0x29 && did === 0x500c) return bytes(pedal.pressed ? '05' : '04');
      if (ecu === 0x12 && did === 0x58b7) return bytes('00');
      return 'nrc';
    });
    followMetronome(harness, pedal);
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
    const pedal: PedalDouble = { pressed: false };
    const harness = makeController((ecu, did) => {
      if (ecu === 0x29 && did === 0x500c) return bytes(pedal.pressed ? '05' : '04');
      return 'nrc';
    });
    followMetronome(harness, pedal);
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

/**
 * Ticket P4m-FIX1 (Codex P4m-REV1 findings 1, 2, 3, 5, 10):
 *  X1 measure the rate before the script instead of assuming 15.8 req/s;
 *  X2 a silent ECU is dropped, never allowed to eat the live ECU's samples;
 *  X3 only ATTEMPTED (ecu,did) keys count as read;
 *  X5 cached/changed pools belong to the TARGET's ECUs;
 *  X9 a find with nothing to read is refused with a reason, not "run" with
 *     zero scripts.
 */
describe('createSignalFinderController -- P4m-FIX1 honesty (X1, X2, X3, X5, X9)', () => {
  it('X1: probes first and reports a MEASURED request rate', async () => {
    const harness = makeController(() => bytes('00'));
    await runFind(harness);
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.rateSource).toBe('measured');
    expect(snapshot.measuredReqPerSec).toBeGreaterThan(0);
  });

  it('X1: when nothing answers the probe, the rate is reported as ASSUMED, never as measured', async () => {
    const harness = makeController(() => null);
    await runFind(harness);
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.rateSource).toBe('assumed');
    expect(snapshot.silentEcus).toEqual([0x12, 0x29]);
    // Every planned DID sits on a silent ECU, so no script was performed at all.
    expect(snapshot.round).toBe(0);
    expect(snapshot.readDids).toEqual([]);
  });

  it('X2: a SILENT ECU is named and dropped; the answering ECU keeps >= 3 samples in every window', async () => {
    const sweepStore = createInMemoryDidSweepStore();
    await seedRun(sweepStore, 'run-12', 0x12);
    await sweepStore.upsertResponders(
      'run-12',
      Array.from({ length: 4 }, (_v, i) => ({ did: 0x4100 + i, raw: bytes('00'), rttMs: 10 })),
      '2026-08-29T17:33:00.000Z',
    );
    const pedal: PedalDouble = { pressed: false };
    const harness = makeController(
      (ecu, did) => {
        if (ecu === 0x29) return null; // the whole ECU is silent -- every request times out.
        if (did === 0x58b7) return bytes(pedal.pressed ? '05' : '04');
        return bytes('00');
      },
      { sweepStore, measuredReqPerSec: 15 },
    );
    followMetronome(harness, pedal);
    await runFind(harness);
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.silentEcus).toEqual([0x29]);
    expect(snapshot.silentDids).toContainEqual({ ecu: 0x29, did: 0x500c });
    // A silent DID is NOT "no response" and NOT "not read (Next round)" -- it
    // has its own stated reason.
    expect(snapshot.noResponseDids).not.toContainEqual({ ecu: 0x29, did: 0x500c });
    expect(snapshot.notReadDids).not.toContainEqual({ ecu: 0x29, did: 0x500c });
    // The live ECU was sampled properly all the way through the script.
    const samples = harness.controller.getSamples().filter((s) => s.ecu === 0x12 && s.did === 0x58b7);
    const perWindow = TIMELINE.steps.map(
      (step) => samples.filter((s) => s.tMs >= step.evidenceFromMs && s.tMs < step.evidenceToMs).length,
    );
    expect(Math.min(...perWindow)).toBeGreaterThanOrEqual(3);
  });

  it('X3: a stop mid-script leaves the DIDs it never asked for in notRead -- never in noResponse', async () => {
    const sweepStore = createInMemoryDidSweepStore();
    await seedRun(sweepStore, 'run-12', 0x12);
    await sweepStore.upsertResponders(
      'run-12',
      Array.from({ length: 20 }, (_v, i) => ({ did: 0x4100 + i, raw: bytes('00'), rttMs: 10 })),
      '2026-08-29T17:33:00.000Z',
    );
    let controllerRef: ReturnType<typeof createSignalFinderController> | null = null;
    let requests = 0;
    const harness = makeController(
      () => {
        requests += 1;
        // The probe polls each planned DID once; stop a few requests into the
        // SCRIPT that follows it.
        if (requests === 15) void controllerRef?.stop();
        return bytes('00');
      },
      { sweepStore, measuredReqPerSec: 15 },
    );
    controllerRef = harness.controller;
    await runFind(harness);
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.readDids.length).toBeGreaterThan(0);
    expect(snapshot.readDids.length).toBeLessThan(snapshot.budget);
    for (const entry of snapshot.notReadDids) {
      expect(snapshot.readDids).not.toContainEqual(entry);
      expect(snapshot.noResponseDids).not.toContainEqual(entry);
    }
    // Nothing vanished: read + not read + silent still covers every eligible DID.
    const total = snapshot.readDids.length + snapshot.notReadDids.length + snapshot.silentDids.length;
    expect(total).toBe(22); // 2 hypotheses + 20 cached responders
  });

  it('X5: cached responders of an ECU the target has nothing to do with are never planned', async () => {
    const sweepStore = createInMemoryDidSweepStore();
    await seedRun(sweepStore, 'run-30', 0x30);
    await sweepStore.upsertResponders(
      'run-30',
      Array.from({ length: 6 }, (_v, i) => ({ did: 0x4000 + i, raw: bytes('00'), rttMs: 10 })),
      '2026-08-29T17:33:00.000Z',
    );
    const harness = makeController(() => bytes('00'), { sweepStore, measuredReqPerSec: 15 });
    await runFind(harness); // brakeSwitch: hypothesis ECUs 0x12/0x29, discovery ECU 0x29 -- 0x30 is none of them.
    const snapshot = harness.controller.getSnapshot();
    for (const entry of [...snapshot.readDids, ...snapshot.notReadDids]) expect(entry.ecu).not.toBe(0x30);

    // The steering target's own discovery range IS on 0x30, so the same cache
    // is eligible there.
    const steering = makeController(() => bytes('00'), { sweepStore, measuredReqPerSec: 15 });
    await runFind(steering, 'steeringAngle');
    expect(steering.controller.getSnapshot().readDids.some((entry) => entry.ecu === 0x30)).toBe(true);
  });

  it('X9: a target with nothing to read reports zero eligible DIDs, and Find performs no script', async () => {
    const harness = makeController(() => bytes('00'));
    expect(await harness.controller.eligibleDidCount('steeringAngle')).toBe(0);
    expect(await harness.controller.eligibleDidCount('brakeSwitch')).toBe(2);
    await runFind(harness, 'steeringAngle');
    expect(harness.transports).toHaveLength(0);
    expect(harness.controller.getSnapshot().round).toBe(0);
  });
});

describe('confirmBinding', () => {
  it('writes the winning DID into the vehicle profile with its evidence', async () => {
    const bindingStore = createInMemoryVehicleProfileBindingStore();
    const pedal: PedalDouble = { pressed: false };
    const harness = makeController((ecu, did) => {
      if (ecu === 0x29 && did === 0x500c) return bytes(pedal.pressed ? '05' : '04');
      return 'nrc';
    }, { bindingStore, profileId: 'test-profile' });
    followMetronome(harness, pedal);
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
