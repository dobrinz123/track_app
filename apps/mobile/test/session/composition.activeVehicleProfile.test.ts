import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, type LocationSample } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { migrateDidSweepSchema } from '../../src/persistence/didSweepSchema';
import type { VehicleProfileBinding } from '../../src/persistence/didSweepStore';

/**
 * Ticket P4p G1 (binding, field test 9 BUG-A). The field exports of
 * 2026-08-31 prove both stores exist side by side:
 *
 *   `2026-08-31-steeringAngle-1.json` (profileId `generic`)
 *       brakePressure = 0x12 / 0x4002  (the DME two-level flag)
 *   `2026-08-31-steeringAngle-2.json` (profileId `toyota-supra-b58`)
 *       brakePressure = 0x12 / 0x58B7  (what the user confirmed, engine running)
 *
 * `composition.ts` read a HARD-CODED `'generic'`, so the monitor polled
 * 0x4002 and showed raw 131/155 = 0/100 %. This suite proves the cache the
 * provider reads now follows the app-level `activeVehicleProfileId`, and that
 * the one-time migration heuristic picks the supra profile for exactly this
 * data.
 *
 * Boot pattern (mocks, sql.js db, fresh module per test) copied from
 * `composition.vehicleProfileBinding.test.ts`.
 */

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
}));

vi.mock('../../src/session/gforceProvider', () => ({
  createGForceProvider: () => ({
    start: () => undefined,
    stop: async () => undefined,
    onSample: () => () => undefined,
  }),
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'active-vehicle-profile-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubLocationProviderBase {
    listeners = new Set<(s: LocationSample) => void>();
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
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
  class StubClock {
    now(): number {
      return Date.now();
    }
  }
  return {
    GnssLocationProvider: class extends StubLocationProviderBase {},
    PerformanceNowClock: StubClock,
    ReplayLocationProvider: class extends StubLocationProviderBase {},
    startLifecycleListener: () => {},
  };
});

vi.mock('../../src/persistence/expoSqlDatabase', () => ({
  openAppDatabase: async () => ({ db: seeded.db, repository: seeded.repository }),
}));

vi.mock('../../src/session/enetTcpTransport', async () => {
  const { MultiEcuFakeTransport } = await import('../support/signalFinderHarness');
  return {
    EnetTcpTransport: class extends MultiEcuFakeTransport {
      constructor() {
        super({ answer: () => 'nrc' });
      }
    },
  };
});

function pressureBinding(profileId: string, did: number, max: number): VehicleProfileBinding {
  return {
    profileId,
    channel: 'brakePressure',
    ecu: 0x12,
    did,
    length: 1,
    decode: 'u8',
    status: 'field-confirmed',
    evidenceJson: JSON.stringify({ restValueHex: '00', min: 0, max, byteOffset: null }),
    updatedAtUtc: '2026-08-31T11:39:06.993Z',
  };
}

async function seedDb(bindings: readonly VehicleProfileBinding[], settingsRow?: unknown): Promise<void> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  await migrateTelemetrySchema(db);
  await migrateDidSweepSchema(db);
  const { createVehicleProfileBindingStore } = await import('../../src/persistence/didSweepStore');
  const store = createVehicleProfileBindingStore(db);
  for (const binding of bindings) await store.upsertBinding(binding);
  if (settingsRow !== undefined) {
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify(settingsRow),
    ]);
  }
  seeded.db = db;
  seeded.repository = repository;
}

async function boot(): Promise<typeof import('../../src/session/composition')> {
  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 80));
  return composition;
}

describe('composition.ts -- the binding cache follows the ACTIVE vehicle profile (P4p G1)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('with both profiles confirmed and no stored choice, the one-time heuristic activates the supra profile and the cache carries 0x58B7 -- never the generic 0x4002', async () => {
    await seedDb([
      pressureBinding('generic', 0x4002, 155),
      pressureBinding('toyota-supra-b58', 0x58b7, 64),
    ]);
    const composition = await boot();

    expect(composition.settingsStore.getSettings().activeVehicleProfileId).toBe('toyota-supra-b58');
    expect(composition.getActiveVehicleProfileId()).toBe('toyota-supra-b58');
    const cache = composition.getVehicleProfileBindingsCache();
    expect(cache).toHaveLength(1);
    expect(cache[0]).toMatchObject({ channel: 'brakePressure', ecu: 0x12, did: 0x58b7 });
  }, 15_000);

  it('a profile the user has already chosen is never overridden by the heuristic', async () => {
    await seedDb(
      [pressureBinding('generic', 0x4002, 155), pressureBinding('toyota-supra-b58', 0x58b7, 64)],
      { activeVehicleProfileId: 'generic' },
    );
    const composition = await boot();

    expect(composition.settingsStore.getSettings().activeVehicleProfileId).toBe('generic');
    expect(composition.getVehicleProfileBindingsCache()[0]).toMatchObject({ did: 0x4002 });
  }, 15_000);

  it('switching the active profile re-reads the cache for THAT profile only', async () => {
    await seedDb(
      [pressureBinding('generic', 0x4002, 155), pressureBinding('toyota-supra-b58', 0x58b7, 64)],
      { activeVehicleProfileId: 'generic' },
    );
    const composition = await boot();
    expect(composition.getVehicleProfileBindingsCache()[0]).toMatchObject({ did: 0x4002 });

    composition.settingsStore.update({ activeVehicleProfileId: 'toyota-supra-b58' });
    await composition.refreshVehicleProfileBindingsCache();

    const cache = composition.getVehicleProfileBindingsCache();
    expect(cache).toHaveLength(1);
    expect(cache[0]).toMatchObject({ did: 0x58b7 });
    // The generic profile's stale binding is still PERSISTED (nothing is ever
    // deleted) -- it is simply not what the provider reads any more.
    const { createVehicleProfileBindingStore } = await import('../../src/persistence/didSweepStore');
    const store = createVehicleProfileBindingStore(composition.getTelemetryReadDb());
    expect(await store.listBindings('generic')).toHaveLength(1);
  }, 15_000);

  it('nothing to migrate: with only generic bindings the active profile stays generic', async () => {
    await seedDb([pressureBinding('generic', 0x4002, 155)]);
    const composition = await boot();
    expect(composition.settingsStore.getSettings().activeVehicleProfileId).toBe('generic');
    expect(composition.getVehicleProfileBindingsCache()[0]).toMatchObject({ did: 0x4002 });
  }, 15_000);
});
