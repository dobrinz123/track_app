import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMetronomeTimeline, type SignalActionScript, type SignalTargetCatalog } from '@circuit/core';
import { createEnetAdapterReservation as createReservation } from '../../src/session/enetAdapterReservation';
import {
  FINDER_ENGINE_RPM_MIN,
  createSignalFinderController,
  finderEngineWarning,
  type SignalFinderControllerDeps,
} from '../../src/session/signalFinderController';
import { MultiEcuFakeTransport, TESTER_ADDRESS, bytes, flush, type DidAnswer } from '../support/signalFinderHarness';

/**
 * Ticket P4p G2 (binding, field test 9 BUG-B): "engine not detected running"
 * could NEVER clear inside the Signal Finder. The warning waited for a fresh
 * telemetry rpm sample, and telemetry is stopped for the whole time the finder
 * holds the single adapter reservation (user, binding: "telemetry and the
 * Signal Finder NEVER run simultaneously"). So the check has to be
 * self-sufficient: the finder's own probe reads rpm itself, over the channel
 * it already has open, with ONE standard mode-01 0x0C request.
 */

const TEST_SCRIPT: SignalActionScript = {
  repetitions: 2,
  baselineMs: 1_000,
  pressMs: 1_000,
  holdMs: 0,
  releaseMs: 1_000,
  settleMs: 200,
};

buildMetronomeTimeline(TEST_SCRIPT);

/** One target that PHYSICALLY needs the engine running (the Supra's steering: the EPS is unpowered with the engine off). */
const TEST_CATALOG: SignalTargetCatalog = {
  profileId: 'test-profile',
  label: 'Test vehicle',
  targets: [
    {
      id: 'steeringAngle',
      label: 'Steering angle',
      engineRequirement: 'running',
      expectedShape: 'analog-bipolar',
      actionScript: TEST_SCRIPT,
      verbs: {
        en: { baseline: 'Hold still', press: 'TURN', hold: 'HOLD', release: 'CENTRE' },
        ro: { baseline: 'Stai', press: 'ROTEȘTE', hold: 'ȚINE', release: 'CENTRU' },
      },
      hypotheses: [
        { ecu: 0x29, did: 0x500b, length: 2, decode: 'word', status: 'hypothesis', provenance: 'test fixture' },
      ],
      discoveryRanges: [{ ecu: 0x29, fromDid: 0x58f3, toDid: 0x6fff, note: 'unswept remainder' }],
    },
  ],
};

interface Harness {
  controller: ReturnType<typeof createSignalFinderController>;
  transports: MultiEcuFakeTransport[];
}

function makeController(
  answer: (ecu: number, did: number, tMs: number) => DidAnswer,
  answerObd: ((ecu: number, pid: number, tMs: number) => DidAnswer) | undefined,
  overrides: Partial<SignalFinderControllerDeps> = {},
): Harness {
  const transports: MultiEcuFakeTransport[] = [];
  const controller = createSignalFinderController({
    transportFactory: () => {
      const transport = new MultiEcuFakeTransport({ answer, answerObd });
      transports.push(transport);
      return transport;
    },
    testerAddress: TESTER_ADDRESS,
    clock: { now: () => Date.now() },
    nowUtc: () => new Date(Date.now()).toISOString(),
    catalog: TEST_CATALOG,
    reservation: createReservation(),
    ...overrides,
  });
  return { controller, transports };
}

async function runFind(harness: Harness): Promise<void> {
  const run = harness.controller.find('steeringAngle');
  for (let i = 0; i < 200; i += 1) {
    await vi.advanceTimersByTimeAsync(100);
    const phase = harness.controller.getSnapshot().phase;
    if (phase === 'result' || phase === 'error' || phase === 'idle') break;
  }
  await run;
  await flush();
}

/** rpm is encoded (256A+B)/4 -- the standard mode-01 0x0C formula `pidCodec.ts` already owns. */
function rpmBytes(rpm: number): Uint8Array {
  const raw = Math.round(rpm * 4);
  return Uint8Array.from([(raw >> 8) & 0xff, raw & 0xff]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('P4p G2 -- the finder probe reads rpm itself', () => {
  it('sends exactly ONE mode-01 0x0C request, to the DME, and reports the engine as RUNNING', async () => {
    const harness = makeController(
      () => bytes('0000'),
      (ecu, pid) => (ecu === 0x12 && pid === 0x0c ? rpmBytes(850) : 'nrc'),
    );
    await runFind(harness);

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.engineRpm).toBeCloseTo(850, 0);
    expect(snapshot.engineRunning).toBe(true);

    const obdRequests = harness.transports[0]!.obdRequests;
    expect(obdRequests).toEqual([{ ecu: 0x12, pid: 0x0c }]);
  }, 20_000);

  it('rpm 0 with the engine off reports NOT running (the warning stays, honestly)', async () => {
    const harness = makeController(
      () => bytes('0000'),
      () => rpmBytes(0),
    );
    await runFind(harness);
    expect(harness.controller.getSnapshot().engineRpm).toBe(0);
    expect(harness.controller.getSnapshot().engineRunning).toBe(false);
  }, 20_000);

  it('an ECU that will not answer 0x0C leaves the reading UNKNOWN -- never a fabricated "running"', async () => {
    const harness = makeController(
      () => bytes('0000'),
      () => 'nrc',
    );
    await runFind(harness);
    expect(harness.controller.getSnapshot().engineRpm).toBeNull();
    expect(harness.controller.getSnapshot().engineRunning).toBeNull();
  }, 20_000);

  it('silence on 0x0C is UNKNOWN too, and never blocks the find', async () => {
    const harness = makeController(
      () => bytes('0000'),
      () => null,
    );
    await runFind(harness);
    expect(harness.controller.getSnapshot().engineRunning).toBeNull();
    expect(harness.controller.getSnapshot().phase).toBe('result');
  }, 20_000);

  it('a fresh find() clears the previous reading before it probes again', async () => {
    const rpm = { value: 900 };
    const harness = makeController(
      () => bytes('0000'),
      () => rpmBytes(rpm.value),
    );
    await runFind(harness);
    expect(harness.controller.getSnapshot().engineRunning).toBe(true);

    const seen: Array<boolean | null> = [];
    harness.controller.subscribe((snapshot) => seen.push(snapshot.engineRunning));
    rpm.value = 0;
    await runFind(harness);
    expect(seen).toContain(null);
    expect(harness.controller.getSnapshot().engineRunning).toBe(false);
  }, 20_000);
});

describe('P4p G2 -- the warning predicate the screen renders', () => {
  const fresh = { rpm: 0, tMonoMs: 1_000 };

  it('an off-ok target is never warned about, whatever the readings say', () => {
    expect(
      finderEngineWarning({ engineRequirement: 'off-ok', engineRunning: false, recentSample: null, nowMs: 1_000 }),
    ).toBe(false);
  });

  it('the finder s OWN reading clears the warning with no telemetry sample at all (the field-test-9 dead end)', () => {
    expect(
      finderEngineWarning({ engineRequirement: 'running', engineRunning: true, recentSample: null, nowMs: 1_000 }),
    ).toBe(false);
  });

  it('the finder s OWN reading raises the warning when the engine really is off', () => {
    expect(
      finderEngineWarning({ engineRequirement: 'running', engineRunning: false, recentSample: null, nowMs: 1_000 }),
    ).toBe(true);
  });

  it('with no reading of its own, it falls back to a FRESH telemetry sample, exactly as before', () => {
    expect(
      finderEngineWarning({ engineRequirement: 'running', engineRunning: null, recentSample: fresh, nowMs: 1_500 }),
    ).toBe(true);
    expect(
      finderEngineWarning({
        engineRequirement: 'running',
        engineRunning: null,
        recentSample: { rpm: 900, tMonoMs: 1_000 },
        nowMs: 1_500,
      }),
    ).toBe(false);
    // Stale telemetry is no evidence at all.
    expect(
      finderEngineWarning({
        engineRequirement: 'running',
        engineRunning: null,
        recentSample: { rpm: 900, tMonoMs: 1_000 },
        nowMs: 100_000,
      }),
    ).toBe(true);
  });

  it('the running threshold is a real idle, not "any non-zero"', () => {
    expect(FINDER_ENGINE_RPM_MIN).toBe(400);
  });
});
