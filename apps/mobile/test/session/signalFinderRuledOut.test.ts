import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignalActionScript, SignalTargetCatalog } from '@circuit/core';
import { createEnetAdapterReservation as createReservation } from '../../src/session/enetAdapterReservation';
import { createSignalFinderController, type SignalFinderControllerDeps } from '../../src/session/signalFinderController';
import { createInMemorySignalFinderRuledOutStore } from '../../src/persistence/didSweepStore';
import { MultiEcuFakeTransport, TESTER_ADDRESS, bytes, flush, type DidAnswer } from '../support/signalFinderHarness';
import { SIGNAL_FINDER_SCREEN_STRINGS } from '../../src/ui/screens/signalFinderStrings';

/**
 * Ticket P4p G5 (binding, user request after field test 9): "the steering
 * finds re-tested the same known DIDs and found nothing -- I never want them
 * offered again". A DID a COMPLETED find scored `unrelated` for a target is
 * remembered as ruled out FOR THAT TARGET and excluded from every later plan,
 * until the user taps "Re-test all".
 *
 * Honesty bounds (the same ones item 12 imposes on "not read"): only a DID
 * this run actually SAMPLED and SCORED as unrelated is ruled out --
 * `insufficient`, silent, and never-read DIDs are evidence of nothing and are
 * kept in the pool.
 */

const TEST_SCRIPT: SignalActionScript = {
  repetitions: 2,
  baselineMs: 1_000,
  pressMs: 1_000,
  holdMs: 0,
  releaseMs: 1_000,
  settleMs: 200,
};

const TEST_CATALOG: SignalTargetCatalog = {
  profileId: 'test-profile',
  label: 'Test vehicle',
  targets: [
    {
      id: 'steeringAngle',
      label: 'Steering angle',
      engineRequirement: 'off-ok',
      expectedShape: 'analog-bipolar',
      actionScript: TEST_SCRIPT,
      verbs: {
        en: { baseline: 'Hold still', press: 'TURN', hold: 'HOLD', release: 'CENTRE' },
        ro: { baseline: 'Stai', press: 'ROTEȘTE', hold: 'ȚINE', release: 'CENTRU' },
      },
      hypotheses: [
        { ecu: 0x12, did: 0x5422, length: 1, decode: 'u8', status: 'hypothesis', provenance: 'field test 9 fixture' },
        { ecu: 0x12, did: 0x5468, length: 2, decode: 'u16', status: 'hypothesis', provenance: 'field test 9 fixture' },
      ],
      discoveryRanges: [{ ecu: 0x29, fromDid: 0x58f3, toDid: 0x6fff, note: 'unswept remainder' }],
    },
    {
      id: 'brakePressure',
      label: 'Brake pressure',
      engineRequirement: 'off-ok',
      expectedShape: 'analog-monotone',
      actionScript: TEST_SCRIPT,
      verbs: {
        en: { baseline: 'Hold still', press: 'PRESS', hold: 'HOLD', release: 'RELEASE' },
        ro: { baseline: 'Stai', press: 'APASĂ', hold: 'ȚINE', release: 'ELIBEREAZĂ' },
      },
      hypotheses: [
        { ecu: 0x12, did: 0x5422, length: 1, decode: 'u8', status: 'hypothesis', provenance: 'field test 9 fixture' },
      ],
      discoveryRanges: [],
    },
  ],
};

interface Harness {
  controller: ReturnType<typeof createSignalFinderController>;
  transports: MultiEcuFakeTransport[];
  ruledOutStore: ReturnType<typeof createInMemorySignalFinderRuledOutStore>;
}

function makeController(
  answer: (ecu: number, did: number, tMs: number) => DidAnswer,
  overrides: Partial<SignalFinderControllerDeps> = {},
): Harness {
  const transports: MultiEcuFakeTransport[] = [];
  const ruledOutStore = (overrides.ruledOutStore ?? createInMemorySignalFinderRuledOutStore()) as ReturnType<
    typeof createInMemorySignalFinderRuledOutStore
  >;
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
    profileId: 'test-profile',
    reservation: createReservation(),
    ...overrides,
    ruledOutStore,
  });
  return { controller, transports, ruledOutStore };
}

async function drive(harness: Harness, run: Promise<void>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await vi.advanceTimersByTimeAsync(100);
    const phase = harness.controller.getSnapshot().phase;
    if (phase === 'result' || phase === 'error' || phase === 'idle') break;
  }
  await run;
  await flush();
}

async function runFind(harness: Harness, targetId: 'steeringAngle' | 'brakePressure' = 'steeringAngle'): Promise<void> {
  await drive(harness, harness.controller.find(targetId));
}

/**
 * The field-test-9 shape: 0x5422 answers a flat 0x00 through the whole script
 * (34 samples, no movement -> `unrelated`), while 0x5468 answers NRC and is
 * therefore never SCORED at all -- so it is the control case for "only what
 * was actually judged is ruled out".
 */
function flatAnswer(): (ecu: number, did: number) => DidAnswer {
  return (ecu, did) => (ecu === 0x12 && did === 0x5422 ? bytes('00') : 'nrc');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('P4p G5 -- a DID scored `unrelated` by a completed find is never offered again for that target', () => {
  it('persists the unrelated DID and leaves it out of the NEXT find s plan', async () => {
    const harness = makeController(flatAnswer());
    await runFind(harness);

    const scores = harness.controller.getSnapshot().scores;
    expect(scores.find((score) => score.did === 0x5422)?.verdict).toBe('unrelated');

    const ruled = await harness.ruledOutStore.listRuledOut('test-profile', 'steeringAngle');
    expect(ruled.map((row) => [row.ecu, row.did])).toEqual([[0x12, 0x5422]]);
    expect(ruled[0]).toMatchObject({ verdict: 'unrelated' });
    expect(ruled[0]!.sessionId).toBe(harness.controller.getSnapshot().sessionId);

    // A second find, same controller state, must not ask for it again.
    const second = makeController(flatAnswer(), { ruledOutStore: harness.ruledOutStore });
    await runFind(second);
    const asked = second.transports.flatMap((transport) => transport.requests);
    expect(asked.some((request) => request.did === 0x5422)).toBe(false);
    expect(asked.some((request) => request.did === 0x5468)).toBe(true);
    expect(second.controller.getSnapshot().ruledOutCount).toBe(1);
  }, 20_000);

  it('a DID that merely could not be judged (insufficient / never answered) is NOT ruled out', async () => {
    const harness = makeController((ecu, did) => (ecu === 0x12 && did === 0x5468 ? bytes('3F93') : null));
    await runFind(harness);
    const ruled = await harness.ruledOutStore.listRuledOut('test-profile', 'steeringAngle');
    expect(ruled.some((row) => row.did === 0x5422)).toBe(false);
  }, 20_000);

  it('is PER TARGET: a DID ruled out for steering is still polled for the brake', async () => {
    const harness = makeController(flatAnswer());
    await runFind(harness, 'steeringAngle');
    expect((await harness.ruledOutStore.listRuledOut('test-profile', 'steeringAngle')).length).toBe(1);

    const brake = makeController(() => bytes('00'), { ruledOutStore: harness.ruledOutStore });
    await runFind(brake, 'brakePressure');
    expect(brake.transports.flatMap((t) => t.requests).some((request) => request.did === 0x5422)).toBe(true);
  }, 20_000);

  it('"Re-test all" clears the exclusions for that target and the DID is planned again', async () => {
    const harness = makeController(flatAnswer());
    await runFind(harness);
    expect(await harness.controller.ruledOutDidCount('steeringAngle')).toBe(1);

    await harness.controller.clearRuledOut('steeringAngle');
    expect(await harness.controller.ruledOutDidCount('steeringAngle')).toBe(0);
    expect(harness.controller.getSnapshot().ruledOutCount).toBe(0);

    const again = makeController(flatAnswer(), { ruledOutStore: harness.ruledOutStore });
    await runFind(again);
    expect(again.transports.flatMap((t) => t.requests).some((request) => request.did === 0x5422)).toBe(true);
  }, 20_000);

  it('an eligible-DID count excludes what has been ruled out (so the row can offer the discovery scan instead)', async () => {
    const harness = makeController(flatAnswer());
    const before = await harness.controller.eligibleDidCount('steeringAngle');
    await runFind(harness);
    const after = await harness.controller.eligibleDidCount('steeringAngle');
    expect(after).toBe(before - 1);
  }, 20_000);
});

/**
 * The field fixture the user asked for: `2026-08-31-steeringAngle-1.json`
 * (generic profile, engine running, 34 samples of 0x12/0x5422, all but a
 * couple of them 0x00) was scored `unrelated` in the field. Replaying that
 * exact answer stream through the controller must rule it out.
 */
describe('P4p G5 -- field fixture 2026-08-31-steeringAngle-1.json', () => {
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../data/field/signal-finder/2026-08-31-steeringAngle-1.json'), 'utf8'),
  ) as {
    candidates: Array<{ ecuHex: string; didHex: string; verdict: string; sampleCount: number }>;
    samples: Array<{ ecuHex: string; didHex: string; rawHex: string }>;
  };

  it('the export itself records 0x12/0x5422 as unrelated over 34 samples (the fact this ticket acts on)', () => {
    const candidate = fixture.candidates.find((entry) => entry.ecuHex === '0x12' && entry.didHex === '0x5422');
    expect(candidate).toBeDefined();
    expect(candidate!.verdict).toBe('unrelated');
    expect(candidate!.sampleCount).toBe(34);
  });

  it('replaying that DID s own answers rules it out for steeringAngle', async () => {
    const raws = fixture.samples
      .filter((sample) => sample.ecuHex === '0x12' && sample.didHex === '0x5422')
      .map((sample) => sample.rawHex);
    expect(raws.length).toBeGreaterThan(10);
    let index = 0;
    const harness = makeController((ecu, did) => {
      if (ecu === 0x12 && did === 0x5422) {
        const raw = raws[index % raws.length] ?? '00';
        index += 1;
        return bytes(raw);
      }
      return 'nrc';
    });
    await runFind(harness);

    const ruled = await harness.ruledOutStore.listRuledOut('test-profile', 'steeringAngle');
    expect(ruled.map((row) => [row.ecu, row.did])).toContainEqual([0x12, 0x5422]);
  }, 20_000);
});

describe('P4p G5 -- the count line and its reset control, in both languages', () => {
  it('says how many DIDs earlier finds ruled out', () => {
    expect(SIGNAL_FINDER_SCREEN_STRINGS.en.ruledOut(3)).toBe('3 ruled out from earlier finds');
    expect(SIGNAL_FINDER_SCREEN_STRINGS.ro.ruledOut(3)).toBe('3 excluse din căutările anterioare');
  });

  it('offers the reset in both languages', () => {
    expect(SIGNAL_FINDER_SCREEN_STRINGS.en.retestAll).toBe('Re-test all');
    expect(SIGNAL_FINDER_SCREEN_STRINGS.ro.retestAll).not.toBe(SIGNAL_FINDER_SCREEN_STRINGS.en.retestAll);
  });
});
