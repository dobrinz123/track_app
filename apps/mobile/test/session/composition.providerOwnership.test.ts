import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, cleanRecognitionLap, type LocationSample, type SqlDatabase } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { createSqlWriteGate, gateSqlTransactions } from '../../src/persistence/sqlWriteGate';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';

/**
 * ticket CN-FIX6 -- contracts.md's "Multi-circuit selection — provider
 * ownership amendment" (binding, user finding): the composition layer OWNS
 * the GNSS provider singleton, so after ANY production rebuild inside
 * `lifecycleLock` the provider is stopped. A session-less GPS watcher is
 * user-visible (the OS location indicator stays lit, and it keeps draining
 * battery), which is why "no controller is subscribed to it" is not good
 * enough on its own.
 *
 * `SessionController.dispose()` only stops a provider IT knows it started
 * (`providerRunning`), and `start()` aborted by disposal deliberately never
 * stops a possibly-shared provider (CN-FIX5 item 2, closing amendment) --
 * both correct in core, and both leave the app-level guarantee to the owner.
 * That guarantee is what these tests pin.
 */

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  gatedDb: undefined as unknown,
  writeGate: undefined as unknown,
  repository: undefined as unknown,
  openShouldReject: false,
}));

const tracked = vi.hoisted(() => ({
  gnssProviders: [] as StubLocationProviderInstance[],
}));

interface StubLocationProviderInstance {
  startCount: number;
  stopCount: number;
  running: boolean;
  startDelayMs: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  push(sample: LocationSample): void;
}

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'provider-ownership-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubGnssLocationProvider {
    listeners = new Set<(s: LocationSample) => void>();
    startCount = 0;
    stopCount = 0;
    /** Mirrors the real provider's own watcher state -- what the OS location indicator reflects. */
    running = false;
    startDelayMs = 0;
    constructor() {
      tracked.gnssProviders.push(this);
    }
    async start(): Promise<void> {
      this.startCount += 1;
      if (this.startDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));
      this.running = true;
    }
    async stop(): Promise<void> {
      this.stopCount += 1;
      this.running = false;
    }
    subscribe(cb: (s: LocationSample) => void): () => void {
      this.listeners.add(cb);
      return () => {
        this.listeners.delete(cb);
      };
    }
    push(sample: LocationSample): void {
      for (const listener of [...this.listeners]) listener(sample);
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
  class StubReplayLocationProvider {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    subscribe(): () => void {
      return () => {};
    }
  }
  return {
    GnssLocationProvider: StubGnssLocationProvider,
    PerformanceNowClock: StubClock,
    ReplayLocationProvider: StubReplayLocationProvider,
    startLifecycleListener: () => {},
  };
});

vi.mock('../../src/persistence/expoSqlDatabase', () => ({
  openAppDatabase: async () => {
    if (seeded.openShouldReject) throw new Error('database open failed (test double)');
    return { db: seeded.gatedDb, repository: seeded.repository, writeGate: seeded.writeGate };
  },
}));

import { TMR_CIRCUIT_PROFILE } from '../../src/session/tmrProfile';
import { MOTORPARK_CIRCUIT_PROFILE } from '../../src/session/circuitCatalog';

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedDatabase(): Promise<{ db: SqlDatabase; repository: SqlSessionRepository }> {
  const db = await createSqlJsDatabase();
  await migrateTelemetrySchema(db);
  const writeGate = createSqlWriteGate();
  const gatedDb = gateSqlTransactions(db, writeGate);
  const repository = await SqlSessionRepository.create(gatedDb);
  seeded.db = db;
  seeded.gatedDb = gatedDb;
  seeded.writeGate = writeGate;
  seeded.repository = repository;
  seeded.openShouldReject = false;
  tracked.gnssProviders.length = 0;
  return { db, repository };
}

async function importFreshComposition(): Promise<typeof import('../../src/session/composition')> {
  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await tick();
  return composition;
}

function latestFacadeState(composition: typeof import('../../src/session/composition')): {
  sessionState: string;
  calibrationResult: { accepted: boolean } | null;
} {
  let latest: unknown;
  const unsubscribe = composition.facade.subscribe((s) => {
    latest = s;
  });
  unsubscribe();
  return latest as ReturnType<typeof latestFacadeState>;
}

describe('provider ownership (ticket CN-FIX6): a rebuild always leaves the GNSS provider stopped', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a circuit-change rebuild stops the provider -- and the next beginCalibration restarts it and samples still flow', async () => {
    await seedDatabase();
    const composition = await importFreshComposition();
    const gnss = tracked.gnssProviders[0]!;
    const stopsBefore = gnss.stopCount;

    // A circuit change while idle rebuilds the production controller inside
    // the lock (`unlockedApplySelection`).
    const selection = await composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(selection).toEqual({ ok: true });
    expect(composition.getProductionCircuitId()).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);

    // HEAD (`b2df284`): the rebuild never touches the provider -- core's
    // `dispose()` stops only a provider the disposed controller itself had
    // running, so nothing guarantees the watcher is off after a rebuild.
    expect(gnss.stopCount).toBe(stopsBefore + 1);
    expect(gnss.running).toBe(false);

    // The stop must not break the next session: a locked `beginCalibration`
    // queues behind the rebuild and restarts the provider through
    // `ensureProviderRunning()`.
    composition.facade.startPreflight();
    await tick(0);
    composition.facade.beginCalibration();
    await tick(0);
    expect(gnss.running).toBe(true);

    const live = tracked.gnssProviders.at(-1)!;
    for (const sample of cleanRecognitionLap(MOTORPARK_CIRCUIT_PROFILE, 950_001)) live.push(sample);
    await tick(0);
    // Samples reach the freshly built controller: the calibration completes.
    expect(latestFacadeState(composition).sessionState).toBe('calibrationReview');
  });

  it('a start that was in flight when its controller was disposed leaves NO orphaned watcher -- the rebuild stops it', async () => {
    await seedDatabase();
    const composition = await importFreshComposition();
    const gnss = tracked.gnssProviders[0]!;

    // The window CN-FIX5 item 2 deliberately leaves open in core: a start
    // whose provider came up AFTER its controller was disposed never
    // subscribes and never stops the (possibly shared) provider. Reproduced
    // here at the seam by starting the provider directly, exactly as an
    // aborted `SessionController.start()` would have left it -- running,
    // with no controller subscribed.
    await gnss.start();
    expect(gnss.running).toBe(true);
    const stopsBefore = gnss.stopCount;

    // Any rebuild inside the lock is now responsible for it.
    await composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);

    expect(gnss.stopCount).toBe(stopsBefore + 1);
    expect(gnss.running).toBe(false);
  });

  it("a terminal-state rebuild through the preflight gate stops the provider again, idempotently, after a completed session", async () => {
    await seedDatabase();
    const composition = await importFreshComposition();
    const gnss = tracked.gnssProviders[0]!;

    composition.facade.startPreflight();
    await tick(0);
    composition.facade.beginCalibration();
    await tick(0);
    expect(gnss.running).toBe(true);
    for (const sample of cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 950_101)) gnss.push(sample);
    await tick(0);
    composition.facade.endSession();
    await tick(10);
    expect(latestFacadeState(composition).sessionState).toBe('sessionComplete');
    // `SessionController.endSession()` already stopped it once.
    expect(gnss.running).toBe(false);
    const stopsBefore = gnss.stopCount;

    // The next preflight rebuilds the terminal controller (C1 fix) -- the
    // rebuild stops the provider AGAIN, which is a harmless no-op on an
    // already-stopped provider and must not throw.
    composition.facade.startPreflight();
    await tick(10);

    expect(gnss.stopCount).toBe(stopsBefore + 1);
    expect(gnss.running).toBe(false);
    // The gate's rebuild really did happen and the facade is still usable.
    expect(latestFacadeState(composition).sessionState).toBe('idle');
  });

  it('a provider whose stop() REJECTS is logged, never thrown -- the rebuild (and the selection driving it) still succeeds', async () => {
    await seedDatabase();
    const composition = await importFreshComposition();
    const gnss = tracked.gnssProviders[0]!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    gnss.stop = async () => {
      throw new Error('location services unavailable (test double)');
    };

    const selection = await composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);

    expect(selection).toEqual({ ok: true });
    expect(composition.getProductionCircuitId()).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('no GNSS provider yet (bootstrap failed before one was built): a rebuild-driving operation fails on bootstrap, never on a null provider', async () => {
    await seedDatabase();
    seeded.openShouldReject = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.resetModules();
    const composition = await import('../../src/session/composition');
    await tick();

    let bootstrapState: string | null = null;
    composition.subscribeBootstrapState((s) => {
      bootstrapState = s;
    });
    expect(bootstrapState).toBe('failed');

    // `deleteAllStoredUserData()` is a locked section that rebuilds the
    // production controller. With no provider (and no controller) it must
    // fail on the bootstrap error, NOT on a null-provider TypeError.
    await expect(composition.deleteAllStoredUserData()).rejects.toThrow(/database open failed/);
    error.mockRestore();
    seeded.openShouldReject = false;
  });
});
