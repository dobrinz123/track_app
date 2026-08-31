import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignalTargetCatalog } from '@circuit/core';

/**
 * Ticket P4q (binding): VIN-based vehicle auto-detection. Mirrors the other
 * `composition.*.test.ts` files' minimal module-load mocks (`composition.ts`
 * kicks off `runBootstrap()` at import time) -- `openAppDatabase` rejects
 * since none of these tests exercise real bootstrap/SQLite.
 *
 * `../../src/session/enetTcpTransport` and `../../src/session/didSweepController`
 * are replaced with fully test-controlled doubles: the one-shot VIN read's
 * own wire framing is already covered by `@circuit/core`'s
 * `vinRead.test.ts` (a fake `SweepTransport` answering 0xF190) -- these tests
 * are about the ORCHESTRATION composition.ts owns: ENET-only gating, never
 * blocking/stealing a busy reservation, one-shot-per-app-run caching,
 * persistence, and auto-select precedence.
 */

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'vin-detection-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubGnssLocationProvider {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    subscribe(): () => void {
      return () => undefined;
    }
    getDiagnostics(): unknown {
      return {
        samplesEmitted: 0,
        samplesRejectedMocked: 0,
        sampleIntervalHistogramMs: [],
        accuracyDistributionM: { sampleCount: 0, minM: null, p50M: null, p95M: null },
        reducedAccuracy: false,
      };
    }
  }
  class StubClock {
    now(): number {
      return Date.now();
    }
  }
  return {
    GnssLocationProvider: StubGnssLocationProvider,
    PerformanceNowClock: StubClock,
    ReplayLocationProvider: class {},
    startLifecycleListener: () => {},
  };
});

vi.mock('../../src/persistence/expoSqlDatabase', () => ({
  openAppDatabase: async () => {
    throw new Error('vinDetection tests never need a real on-device database');
  },
}));

/** A one-shot channel double: answers `nextResponse` with whatever `queuedResponse` currently holds. */
const channelDouble = vi.hoisted(() => ({
  queuedResponse: 'timeout' as Uint8Array | 'timeout',
  sendCalls: 0,
  createCalls: [] as Array<{ testerAddress: number; targetAddress: number }>,
}));

vi.mock('../../src/session/didSweepController', () => ({
  createRawUdsChannel: (_transport: unknown, testerAddress: number, targetAddress: number) => {
    channelDouble.createCalls.push({ testerAddress, targetAddress });
    return {
      async send(): Promise<void> {
        channelDouble.sendCalls += 1;
      },
      async nextResponse(): Promise<Uint8Array | 'timeout'> {
        return channelDouble.queuedResponse;
      },
      async keepAlive(): Promise<void> {},
    };
  },
}));

const transportDouble = vi.hoisted(() => ({
  connectCalls: 0,
  closeCalls: 0,
  constructedWith: [] as Array<{ host: string; port: number }>,
}));

vi.mock('../../src/session/enetTcpTransport', () => ({
  EnetTcpTransport: class {
    constructor(config: { host: string; port: number }) {
      transportDouble.constructedWith.push(config);
    }
    async connect(): Promise<void> {
      transportDouble.connectCalls += 1;
    }
    onData(): () => void {
      return () => undefined;
    }
    onClose(): () => void {
      return () => undefined;
    }
    send(): void {}
    async close(): Promise<void> {
      transportDouble.closeCalls += 1;
    }
  },
}));

function asciiBytes(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

function vinPdu(vin: string): Uint8Array {
  return Uint8Array.from([0x62, 0xf1, 0x90, ...asciiBytes(vin)]);
}

async function bootFresh(): Promise<typeof import('../../src/session/composition')> {
  channelDouble.queuedResponse = 'timeout';
  channelDouble.sendCalls = 0;
  channelDouble.createCalls = [];
  transportDouble.connectCalls = 0;
  transportDouble.closeCalls = 0;
  transportDouble.constructedWith = [];
  vi.resetModules();
  return import('../../src/session/composition');
}

describe('composition.ts VIN one-shot read (ticket P4q Q1)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is a no-op on the ELM327 path (no mode-09 support) -- never opens a transport', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ adapterType: 'elm327' });
    const vin = await composition.maybeDetectVehicleFromVin();
    expect(vin).toBeNull();
    expect(transportDouble.constructedWith).toHaveLength(0);
  });

  it('is a no-op when no ENET host is configured', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ adapterType: 'enet', enetHost: '' });
    const vin = await composition.maybeDetectVehicleFromVin();
    expect(vin).toBeNull();
    expect(transportDouble.constructedWith).toHaveLength(0);
  });

  it('reads, decodes and caches the VIN over ENET, addressed to ECU 0x12', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ adapterType: 'enet', enetHost: '192.168.4.20', enetPort: 6801, enetTesterAddress: 0xf1 });
    channelDouble.queuedResponse = vinPdu('WBA12345678901234');

    const vin = await composition.maybeDetectVehicleFromVin();

    expect(vin).toBe('WBA12345678901234');
    expect(transportDouble.constructedWith).toEqual([{ host: '192.168.4.20', port: 6801 }]);
    expect(transportDouble.connectCalls).toBe(1);
    expect(transportDouble.closeCalls).toBe(1);
    expect(channelDouble.createCalls).toEqual([{ testerAddress: 0xf1, targetAddress: 0x12 }]);
  });

  it('persists the read VIN into settings.lastSeenVin', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ adapterType: 'enet', enetHost: '192.168.4.20' });
    channelDouble.queuedResponse = vinPdu('JTH00000000000001');

    await composition.maybeDetectVehicleFromVin();

    expect(composition.settingsStore.getSettings().lastSeenVin).toBe('JTH00000000000001');
  });

  it('never fabricates a VIN on a timeout/NRC -- resolves null and does not touch lastSeenVin', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ adapterType: 'enet', enetHost: '192.168.4.20' });
    channelDouble.queuedResponse = 'timeout';

    const vin = await composition.maybeDetectVehicleFromVin();

    expect(vin).toBeNull();
    expect(composition.settingsStore.getSettings().lastSeenVin).toBeNull();
  });

  it('is one-shot per app run: a second call returns the cached result without reopening the transport', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ adapterType: 'enet', enetHost: '192.168.4.20' });
    channelDouble.queuedResponse = vinPdu('WBA12345678901234');

    const first = await composition.maybeDetectVehicleFromVin();
    const second = await composition.maybeDetectVehicleFromVin();

    expect(first).toBe('WBA12345678901234');
    expect(second).toBe('WBA12345678901234');
    expect(transportDouble.connectCalls).toBe(1); // only the FIRST call actually opened anything.
  });

  it('never blocks or steals: skips (resolves null) when the shared reservation is already held, and does not mark detection done', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ adapterType: 'enet', enetHost: '192.168.4.20' });
    const { enetAdapterReservation } = await import('../../src/session/enetAdapterReservation');
    const token = enetAdapterReservation.tryAcquire('provider');
    expect(token).not.toBeNull();

    const whileBusy = await composition.maybeDetectVehicleFromVin();
    expect(whileBusy).toBeNull();
    expect(transportDouble.constructedWith).toHaveLength(0); // never opened anything while busy.

    // Freed afterward -- the NEXT trigger gets its own chance (not marked "done" by the busy skip).
    enetAdapterReservation.release(token!);
    channelDouble.queuedResponse = vinPdu('WBA00000000000009');
    const afterFree = await composition.maybeDetectVehicleFromVin();
    expect(afterFree).toBe('WBA00000000000009');
  });

  it('releases its own reservation token after the read completes, freeing the adapter', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ adapterType: 'enet', enetHost: '192.168.4.20' });
    channelDouble.queuedResponse = vinPdu('WBA12345678901234');

    await composition.maybeDetectVehicleFromVin();

    const { enetAdapterReservation } = await import('../../src/session/enetAdapterReservation');
    expect(enetAdapterReservation.holder()).toBeNull();
  });
});

describe('decideVinAutoSelect (ticket P4q Q3, pure precedence rule)', () => {
  it('auto-selects on exactly one match', async () => {
    const { decideVinAutoSelect } = await bootFresh();
    expect(decideVinAutoSelect(['toyota-supra-b58'], false)).toBe('toyota-supra-b58');
  });

  it('does nothing on zero matches', async () => {
    const { decideVinAutoSelect } = await bootFresh();
    expect(decideVinAutoSelect([], false)).toBeNull();
  });

  it('does nothing on multiple matches (never guesses)', async () => {
    const { decideVinAutoSelect } = await bootFresh();
    expect(decideVinAutoSelect(['profile-a', 'profile-b'], false)).toBeNull();
  });

  it('NEVER overrides an explicit choice made this app run, even with exactly one match', async () => {
    const { decideVinAutoSelect } = await bootFresh();
    expect(decideVinAutoSelect(['toyota-supra-b58'], true)).toBeNull();
  });
});

describe('applyVinAutoSelect (ticket P4q Q2/Q3, integration over a fake catalog registry)', () => {
  const fakeMatch: SignalTargetCatalog = {
    profileId: 'fake-matched-car',
    label: 'Fake Matched Car',
    targets: [],
    vinPatterns: ['WBA'],
  };
  const fakeOther: SignalTargetCatalog = {
    profileId: 'fake-other-car',
    label: 'Fake Other Car',
    targets: [],
    vinPatterns: ['JTH'],
  };

  beforeEach(() => {
    vi.resetModules();
  });

  it('activates the matched profile and raises the dismissible notice on exactly one match', async () => {
    const composition = await bootFresh();
    const seen: Array<unknown> = [];
    composition.subscribeVinAutoDetectNotice((n) => seen.push(n));

    composition.applyVinAutoSelect('WBA00000000000001', [fakeMatch, fakeOther]);

    expect(composition.settingsStore.getSettings().activeVehicleProfileId).toBe('fake-matched-car');
    expect(seen.at(-1)).toEqual({ vin: 'WBA00000000000001', profileId: 'fake-matched-car' });
  });

  it('changes nothing on zero matches', async () => {
    const composition = await bootFresh();
    const before = composition.settingsStore.getSettings().activeVehicleProfileId;

    composition.applyVinAutoSelect('ZZZ00000000000001', [fakeMatch, fakeOther]);

    expect(composition.settingsStore.getSettings().activeVehicleProfileId).toBe(before);
  });

  it('changes nothing on multiple matches', async () => {
    const composition = await bootFresh();
    const overlapping: SignalTargetCatalog = { ...fakeMatch, profileId: 'fake-overlap' };
    const before = composition.settingsStore.getSettings().activeVehicleProfileId;

    composition.applyVinAutoSelect('WBA00000000000001', [fakeMatch, overlapping]);

    expect(composition.settingsStore.getSettings().activeVehicleProfileId).toBe(before);
  });

  it('never overrides a profile the user explicitly chose this app run (the chip)', async () => {
    const composition = await bootFresh();
    composition.setActiveVehicleProfileIdExplicit('generic');
    expect(composition.hasUserExplicitlyChosenVehicleProfileThisRun()).toBe(true);

    composition.applyVinAutoSelect('WBA00000000000001', [fakeMatch]);

    expect(composition.settingsStore.getSettings().activeVehicleProfileId).toBe('generic');
  });

  it('dismissVinAutoDetectNotice clears the banner without touching the selected profile', async () => {
    const composition = await bootFresh();
    composition.applyVinAutoSelect('WBA00000000000001', [fakeMatch]);
    expect(composition.settingsStore.getSettings().activeVehicleProfileId).toBe('fake-matched-car');

    composition.dismissVinAutoDetectNotice();

    const seen: Array<unknown> = [];
    composition.subscribeVinAutoDetectNotice((n) => seen.push(n));
    expect(seen).toEqual([null]);
    expect(composition.settingsStore.getSettings().activeVehicleProfileId).toBe('fake-matched-car');
  });
});
