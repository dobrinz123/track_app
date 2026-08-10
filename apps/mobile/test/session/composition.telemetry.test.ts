import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, cleanRecognitionLap, multiLapSession, type LocationSample } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';

/**
 * Telemetry addendum session-integration tests (MUST DO (g)): the provider
 * starts/stops with the session lifecycle, and -- the binding requirement --
 * a dead/absent adapter must leave sessions 100% functional. Follows
 * `composition.lifecycle.test.ts`'s established `bootFresh()` pattern
 * (mock `expo-constants`/`../../src/platform`/`../../src/persistence/expoSqlDatabase`,
 * drive the module's real bootstrap against a real `SqlSessionRepository`
 * over the sql.js adapter, fresh module instance per test via
 * `vi.resetModules()`), additionally mocking `../../src/session/tcpObdTransport`
 * so the "dead adapter" scenario is deterministic and never touches the real
 * native module.
 */

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
}));

const tracked = vi.hoisted(() => ({
  gnssProviders: [] as StubLocationProviderInstance[],
  tcpConnectCalls: 0,
}));

interface StubLocationProviderInstance {
  startCount: number;
  stopCount: number;
  push(sample: LocationSample): void;
}

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'telemetry-test' } },
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

/** Forces the real-adapter transport to fail `connect()` immediately, deterministically, without ever loading `react-native-tcp-socket` -- mirrors `telemetryProvider.test.ts`'s mock. */
vi.mock('../../src/session/tcpObdTransport', () => ({
  TcpObdTransport: class {
    async connect(): Promise<void> {
      tracked.tcpConnectCalls += 1;
      throw new Error('adapter unreachable (test double)');
    }
    send(): void {}
    onData(): () => void {
      return () => undefined;
    }
    onClose(): () => void {
      return () => undefined;
    }
    async close(): Promise<void> {}
  },
}));

import { TMR_CIRCUIT_PROFILE } from '../../src/session/tmrProfile';

function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function feed(provider: StubLocationProviderInstance, samples: readonly LocationSample[]): void {
  for (const sample of samples) provider.push(sample);
}

/** Boots a FRESH composition module instance against a fresh, empty, telemetry-migrated sql.js-backed repository. */
async function bootFresh(): Promise<typeof import('../../src/session/composition')> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  await migrateTelemetrySchema(db); // real openAppDatabase() does this too -- see expoSqlDatabase.ts.
  seeded.db = db;
  seeded.repository = repository;
  tracked.gnssProviders.length = 0;
  tracked.tcpConnectCalls = 0;

  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

function latestFacadeState(composition: Awaited<ReturnType<typeof bootFresh>>): { sessionState: string; laps: unknown[] } {
  let latest: { sessionState: string; laps: unknown[] } | undefined;
  const unsubscribe = composition.facade.subscribe((s) => {
    latest = s as { sessionState: string; laps: unknown[] };
  });
  unsubscribe();
  return latest as { sessionState: string; laps: unknown[] };
}

describe('composition.ts telemetry session integration (Telemetry addendum, MUST DO (g))', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a dead/absent adapter (telemetryEnabled on, real-adapter path failing) leaves a full session 100% functional -- the lap completes normally', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ telemetryEnabled: true, telemetrySimulate: false });
    const gnss = tracked.gnssProviders[0]!;

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 700_001));
    await flushBootstrap();
    composition.facade.acceptCalibration();
    await flushBootstrap();
    composition.facade.arm();
    feed(gnss, multiLapSession(TMR_CIRCUIT_PROFILE, 1, 700_002));
    await flushBootstrap();

    // The dead adapter really was attempted (proves this isn't just
    // "telemetry never started") -- and never blocked anything above.
    expect(tracked.tcpConnectCalls).toBeGreaterThan(0);
    expect(composition.telemetryProvider.getDiagnostics().state).toBe('failed');

    composition.facade.endSession();
    await flushBootstrap();

    const after = latestFacadeState(composition);
    expect(after.sessionState).toBe('sessionComplete');
    expect(after.laps.length).toBeGreaterThan(0);
    expect(composition.sessionHistoryStore.listSessions()).toHaveLength(1);
  });

  it('telemetry stays off (provider never starts) when telemetryEnabled is false -- the default', async () => {
    const composition = await bootFresh();
    const gnss = tracked.gnssProviders[0]!;

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 710_001));
    await flushBootstrap();
    composition.facade.acceptCalibration();
    await flushBootstrap();
    composition.facade.arm();
    feed(gnss, multiLapSession(TMR_CIRCUIT_PROFILE, 1, 710_002));
    await flushBootstrap();

    expect(tracked.tcpConnectCalls).toBe(0);
    expect(composition.telemetryProvider.getDiagnostics().state).toBe('idle');

    composition.facade.endSession();
    await flushBootstrap();
    expect(latestFacadeState(composition).sessionState).toBe('sessionComplete');
  });

  it('the provider stops (state leaves the running set) once endSession() completes', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ telemetryEnabled: true, telemetrySimulate: true });
    const gnss = tracked.gnssProviders[0]!;

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 720_001));
    await flushBootstrap();
    composition.facade.acceptCalibration();
    await flushBootstrap();
    composition.facade.arm();
    feed(gnss, multiLapSession(TMR_CIRCUIT_PROFILE, 1, 720_002));
    await flushBootstrap();

    const runningStates = new Set(['connecting', 'initializing', 'polling']);
    expect(runningStates.has(composition.telemetryProvider.getDiagnostics().state)).toBe(true);

    composition.facade.endSession();
    await flushBootstrap();
    await flushBootstrap();

    expect(runningStates.has(composition.telemetryProvider.getDiagnostics().state)).toBe(false);
  });
});
