import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, type LocationSample, type TelemetrySample } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { migrateDidSweepSchema } from '../../src/persistence/didSweepSchema';
import type { VehicleProfileBinding } from '../../src/persistence/didSweepStore';

/**
 * Ticket P4l-FIX3 J5 (binding, the P4l worker's own concern 1 -- Codex
 * P4l-REV1 finding 3/HIGH: "Confirmed bindings never reach live ENET
 * telemetry" -- `composition.ts` built `telemetryProvider` WITHOUT ever
 * passing `readVehicleProfileBindings`, so a channel the Signal Finder wrote
 * to `vehicle_profile_bindings` could never become a poll entry no matter
 * how the app was used).
 *
 * `telemetryProvider.ts`'s OWN correctness once handed a binding (decoding,
 * poll-plan inclusion, sample emission) is already covered end-to-end by
 * `telemetryProviderBrakeChannel.test.ts`. This suite's job is narrower and
 * sits squarely in `composition.ts`: prove the EXPORTED singleton actually
 * reads a REAL, PERSISTED binding (through the SAME `getTelemetryReadDb()` /
 * `createVehicleProfileBindingStore()` the Signal Finder screen writes
 * through) rather than the empty stub it shipped with.
 *
 * Follows `composition.telemetry.test.ts`'s own `bootFresh()` pattern
 * (mock `expo-constants`/`../../src/platform`/`../../src/persistence/expoSqlDatabase`/
 * `../../src/session/gforceProvider`, drive the module's real bootstrap
 * against a real sql.js-backed repository, fresh module instance per test),
 * additionally mocking `../../src/session/enetTcpTransport` with the Signal
 * Finder suite's own multi-ECU HSFZ double (`telemetryProviderBrakeChannel.test.ts`'s
 * exact pattern) so the ENET path is deterministic without a real adapter.
 */

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
}));

const tracked = vi.hoisted(() => ({
  gnssProviders: [] as StubLocationProviderInstance[],
}));

interface StubLocationProviderInstance {
  startCount: number;
  stopCount: number;
}

vi.mock('../../src/session/gforceProvider', () => ({
  createGForceProvider: () => ({
    start: () => undefined,
    stop: async () => undefined,
    onSample: () => () => undefined,
  }),
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'vehicle-profile-binding-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubLocationProviderBase {
    listeners = new Set<(s: LocationSample) => void>();
    startCount = 0;
    stopCount = 0;
    async start(): Promise<void> {
      this.startCount += 1;
    }
    async stop(): Promise<void> {
      this.stopCount += 1;
    }
    subscribe(cb: (s: LocationSample) => void): () => void {
      this.listeners.add(cb);
      return () => {
        this.listeners.delete(cb);
      };
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
  class StubGnssLocationProvider extends StubLocationProviderBase {
    constructor() {
      super();
      tracked.gnssProviders.push(this);
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
    ReplayLocationProvider: class extends StubLocationProviderBase {},
    startLifecycleListener: () => {},
  };
});

vi.mock('../../src/persistence/expoSqlDatabase', () => ({
  openAppDatabase: async () => {
    return { db: seeded.db, repository: seeded.repository };
  },
}));

/** The Signal Finder suite's own multi-ECU HSFZ double (`signalFinderHarness.ts`) -- answers as WHICHEVER ECU the request targets, exactly like a real UDS bus. Standing in for `EnetTcpTransport` so the ENET path never touches a real adapter. */
const brakeState = vi.hoisted(() => ({ byte: 0x04 }));
vi.mock('../../src/session/enetTcpTransport', async () => {
  const { MultiEcuFakeTransport: Transport } = await import('../support/signalFinderHarness');
  return {
    EnetTcpTransport: class extends Transport {
      constructor() {
        super({
          answer: (ecu: number, did: number) => {
            if (ecu === 0x29 && did === 0x500c) return Uint8Array.from([brakeState.byte]);
            return 'nrc';
          },
        });
      }
    },
  };
});

function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function bootFresh(): Promise<typeof import('../../src/session/composition')> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  await migrateTelemetrySchema(db);
  await migrateDidSweepSchema(db);
  seeded.db = db;
  seeded.repository = repository;
  tracked.gnssProviders.length = 0;
  brakeState.byte = 0x04;

  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

async function waitFor(predicate: () => boolean, budgetMs = 4_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the expected condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function brakeBinding(overrides: Partial<VehicleProfileBinding> = {}): VehicleProfileBinding {
  return {
    profileId: 'generic',
    channel: 'brakeSwitch',
    ecu: 0x29,
    did: 0x500c,
    length: 1,
    decode: 'bit0 (0x04 released -> 0x05 pressed)',
    status: 'field-confirmed',
    evidenceJson: JSON.stringify({ restValueHex: '04', min: 4, max: 5, byteOffset: null }),
    updatedAtUtc: '2026-08-29T18:12:00.000Z',
    ...overrides,
  };
}

describe('composition.ts vehicle profile binding wiring (P4l-FIX3 J5)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a binding confirmed by the Signal Finder (persisted via createVehicleProfileBindingStore) reaches the exported telemetryProvider once refreshed, and emits brakeSwitch samples', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({
      telemetryEnabled: true,
      telemetrySimulate: false,
      adapterType: 'enet',
      enetHost: '192.168.4.1',
      enetAutoDiscover: false,
      enetChannelSpecsJson: '[]',
    });

    // Before any confirm/refresh: the cache is empty and the brake channel
    // has never been part of any config this composition built.
    expect(composition.getVehicleProfileBindingsCache()).toEqual([]);

    // The exact write path `SignalFinderController.confirmBinding()` uses --
    // same store factory, same db accessor.
    const { createVehicleProfileBindingStore } = await import('../../src/persistence/didSweepStore');
    const store = createVehicleProfileBindingStore(composition.getTelemetryReadDb());
    await store.upsertBinding(brakeBinding());

    // The composition-level refresh J5 adds -- what `SignalFinderScreen.tsx`'s
    // `handleConfirm` now calls after a successful confirm.
    await composition.refreshVehicleProfileBindingsCache();
    expect(composition.getVehicleProfileBindingsCache()).toHaveLength(1);
    expect(composition.getVehicleProfileBindingsCache()[0]).toMatchObject({ channel: 'brakeSwitch', ecu: 0x29, did: 0x500c });

    const samples: TelemetrySample[] = [];
    composition.telemetryProvider.onSample((sample) => samples.push(sample));
    composition.telemetryProvider.start();

    await waitFor(() => samples.some((sample) => sample.channel === 'brakeSwitch'));
    expect(samples.find((sample) => sample.channel === 'brakeSwitch')?.value).toBe(0);

    brakeState.byte = 0x05;
    await waitFor(() => samples.some((sample) => sample.channel === 'brakeSwitch' && sample.value === 100));

    // The provider's ENET config really does carry the brake DID entry --
    // reported as a live ENET channel, exactly like any built-in one.
    expect(composition.telemetryProvider.getDiagnostics().supportedChannels).toContain('brakeSwitch');

    await composition.telemetryProvider.stop();
  }, 15_000);

  it('without ever confirming/refreshing a binding, the brake channel never appears at all (the pre-fix behaviour this ticket closes)', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({
      telemetryEnabled: true,
      telemetrySimulate: false,
      adapterType: 'enet',
      enetHost: '192.168.4.1',
      enetAutoDiscover: false,
      enetChannelSpecsJson: '[]',
    });

    const samples: TelemetrySample[] = [];
    composition.telemetryProvider.onSample((sample) => samples.push(sample));
    composition.telemetryProvider.start();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(samples).toEqual([]);
    const diag = composition.telemetryProvider.getDiagnostics();
    expect(diag.supportedChannels ?? []).not.toContain('brakeSwitch');
    expect(diag.unsupportedChannels ?? []).not.toContain('brakeSwitch');

    await composition.telemetryProvider.stop();
  }, 15_000);

  it('bootstrap itself primes the cache once db is available -- a binding confirmed in an EARLIER app run is live on this run s very first start(), no confirm/refresh needed in-process', async () => {
    // Seed the underlying sql.js db with a binding BEFORE the module (and
    // its bootstrap) is even imported -- simulating "confirmed last time the
    // app ran".
    const db = await createSqlJsDatabase();
    const repository = await SqlSessionRepository.create(db);
    await migrateTelemetrySchema(db);
    await migrateDidSweepSchema(db);
    const { createVehicleProfileBindingStore } = await import('../../src/persistence/didSweepStore');
    await createVehicleProfileBindingStore(db).upsertBinding(brakeBinding());
    seeded.db = db;
    seeded.repository = repository;
    tracked.gnssProviders.length = 0;
    brakeState.byte = 0x04;

    vi.resetModules();
    const composition = await import('../../src/session/composition');
    await flushBootstrap();
    // Bootstrap's own priming call is fire-and-forget -- give its microtasks
    // a moment to settle before asserting on the cache.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(composition.getVehicleProfileBindingsCache()).toHaveLength(1);

    composition.settingsStore.update({
      telemetryEnabled: true,
      telemetrySimulate: false,
      adapterType: 'enet',
      enetHost: '192.168.4.1',
      enetAutoDiscover: false,
      enetChannelSpecsJson: '[]',
    });
    const samples: TelemetrySample[] = [];
    composition.telemetryProvider.onSample((sample) => samples.push(sample));
    composition.telemetryProvider.start();
    await waitFor(() => samples.some((sample) => sample.channel === 'brakeSwitch'));
    await composition.telemetryProvider.stop();
  }, 15_000);
});
