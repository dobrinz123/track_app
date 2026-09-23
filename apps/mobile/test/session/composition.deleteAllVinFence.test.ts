import { describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, type LocationSample, type SqlDatabase } from '@circuit/core';

import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { migrateDidSweepSchema } from '../../src/persistence/didSweepSchema';

/**
 * Codex P18-REV2 H1: a VIN read that STARTS while delete-all is running must
 * not put the VIN back once delete-all has reported success. The ENET
 * transport and the VIN read itself are stubbed so the read completes
 * instantly with a real-looking VIN; everything else is the production
 * composition. Mock pattern follows `composition.circuitSelection.test.ts`.
 */

const VIN = 'WZ1DB0C04LW000001';

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
  vinReads: 0,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'delete-all-vin-fence-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubGnssLocationProvider {
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
    GnssLocationProvider: StubGnssLocationProvider,
    PerformanceNowClock: StubClock,
    ReplayLocationProvider: class {},
    startLifecycleListener: () => {},
  };
});

vi.mock('../../src/persistence/expoSqlDatabase', () => ({
  openAppDatabase: async () => ({ db: seeded.db, repository: seeded.repository }),
}));

vi.mock('../../src/session/enetTcpTransport', () => ({
  EnetTcpTransport: class {
    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    onData(): () => void {
      return () => {};
    }
    onClose(): () => void {
      return () => {};
    }
    async send(): Promise<void> {}
  },
}));

vi.mock('@circuit/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@circuit/core')>()),
  readVinFromChannel: async () => {
    seeded.vinReads += 1;
    return 'WZ1DB0C04LW000001';
  },
}));

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function storedVin(db: SqlDatabase): Promise<unknown> {
  const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['app-settings']);
  return (JSON.parse(rows[0]?.value ?? '{}') as { lastSeenVin?: unknown }).lastSeenVin;
}

describe('composition.ts delete-all -- VIN detection fence (Codex P18-REV2 H1)', () => {
  it('a VIN read triggered at any point during delete-all does not restore the VIN after it reports success', async () => {
    const db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
    await migrateDidSweepSchema(db);
    seeded.db = db;
    seeded.repository = await SqlSessionRepository.create(db);
    seeded.vinReads = 0;
    vi.resetModules();
    const composition = await import('../../src/session/composition');
    await flush();

    composition.settingsStore.update({ adapterType: 'enet', enetHost: '192.168.16.254' });
    expect(await composition.maybeDetectVehicleFromVin()).toBe(VIN);
    await flush();
    expect(await storedVin(db)).toBe(VIN);

    // Every settings change delete-all makes is a moment another trigger
    // (a telemetry connect, the Signal Finder opening) could start a read.
    let deleting = true;
    const unsubscribe = composition.settingsStore.subscribe(() => {
      if (deleting) void composition.maybeDetectVehicleFromVin();
    });
    const readsBefore = seeded.vinReads;
    const result = await composition.deleteAllStoredUserData();
    deleting = false;
    unsubscribe();
    for (let i = 0; i < 5; i += 1) await flush();

    expect(result.ok).toBe(true);
    expect(seeded.vinReads).toBe(readsBefore);
    expect(composition.settingsStore.getSettings().lastSeenVin).toBeNull();
    expect(await storedVin(db)).toBeNull();

    // And detection is re-armed: the next connection after delete-all reads again.
    expect(await composition.maybeDetectVehicleFromVin()).toBe(VIN);
  });
});
