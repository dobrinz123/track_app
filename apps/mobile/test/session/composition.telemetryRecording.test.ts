import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SqlSessionRepository,
  cleanRecognitionLap,
  multiLapSession,
  type LocationSample,
  type SqlDatabase,
  type TelemetrySample,
} from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';

/**
 * WPT3 fixes that need PRECISE, deterministic control over exactly which
 * telemetry samples land and when (F4's lap-0/NULL tagging boundary; F7's
 * delete-all row survival) -- `../../src/session/telemetryProvider` is
 * mocked entirely with a fully test-controlled double (start/stop/onSample/
 * onStateChange/getDiagnostics) so sample delivery is driven by explicit
 * `feedTelemetry()` calls instead of the real `SimulatedElm327Transport`'s
 * own wall-clock timing (used by `composition.telemetry.test.ts`'s broader
 * session-integration tests, which don't need this level of control).
 * Otherwise follows `composition.telemetry.test.ts`'s established
 * `bootFresh()` pattern (mock `expo-constants`/`../../src/platform`/
 * `../../src/persistence/expoSqlDatabase`, drive the module's real bootstrap
 * against a real `SqlSessionRepository` over the sql.js adapter, fresh
 * module instance per test via `vi.resetModules()`).
 */

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
}));

const tracked = vi.hoisted(() => ({
  gnssProviders: [] as StubLocationProviderInstance[],
}));

interface StubLocationProviderInstance {
  push(sample: LocationSample): void;
}

const telemetryDouble = vi.hoisted(() => ({
  sampleListeners: new Set<(s: unknown) => void>(),
  stateListeners: new Set<(s: string, d?: string) => void>(),
  startCalls: 0,
  stopCalls: 0,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'telemetry-recording-test' } },
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

/** Passive `GForceProvider` double -- exists ONLY so composition.ts's unconditional `createGForceProvider(...)` import/construction never reaches the real, lazy `import('expo-sensors')` inside `gforceProvider.ts` (vitest must never load it); this file's own tests don't need G samples, so start()/stop() are no-ops. */
vi.mock('../../src/session/gforceProvider', () => ({
  createGForceProvider: () => ({
    start: () => {},
    stop: async () => {},
    onSample: () => () => undefined,
  }),
}));

/** Fully test-controlled `TelemetryProvider` double -- `feedTelemetry()` below drives its `onSample` listeners directly, decoupled from any real adapter timing. */
vi.mock('../../src/session/telemetryProvider', () => ({
  createTelemetryProvider: () => ({
    start: () => {
      telemetryDouble.startCalls += 1;
    },
    stop: async () => {
      telemetryDouble.stopCalls += 1;
    },
    onSample: (cb: (s: unknown) => void) => {
      telemetryDouble.sampleListeners.add(cb);
      return () => telemetryDouble.sampleListeners.delete(cb);
    },
    onStateChange: (cb: (s: string, d?: string) => void) => {
      telemetryDouble.stateListeners.add(cb);
      cb('idle');
      return () => telemetryDouble.stateListeners.delete(cb);
    },
    getDiagnostics: () => ({ state: 'idle', observedHzByChannel: {}, errorCount: 0, retriesUsed: 0 }),
  }),
}));

import { TMR_CIRCUIT_PROFILE } from '../../src/session/tmrProfile';

function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function feed(provider: StubLocationProviderInstance, samples: readonly LocationSample[]): void {
  for (const sample of samples) provider.push(sample);
}

function feedTelemetry(sample: TelemetrySample): void {
  for (const cb of [...telemetryDouble.sampleListeners]) cb(sample);
}

async function bootFresh(): Promise<typeof import('../../src/session/composition')> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  await migrateTelemetrySchema(db);
  seeded.db = db;
  seeded.repository = repository;
  tracked.gnssProviders.length = 0;
  telemetryDouble.sampleListeners.clear();
  telemetryDouble.stateListeners.clear();
  telemetryDouble.startCalls = 0;
  telemetryDouble.stopCalls = 0;

  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

interface TelemetryRow {
  lap_number: number | null;
  channel: string;
  value: number;
}

async function allRows(): Promise<TelemetryRow[]> {
  const db = seeded.db as SqlDatabase;
  return db.getAllAsync<TelemetryRow>('SELECT lap_number, channel, value FROM telemetry_samples ORDER BY t_mono_ms');
}

describe('composition.ts telemetry recording (WPT3)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('F4 fix: a sample recorded before the first lap starts is tagged NULL, not lap 0; a sample recorded after a lap crossing is tagged with the real (non-zero) lap number', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ telemetryEnabled: true });

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration(); // sessionId now known -- startTelemetryRecording() has run.
    await flushBootstrap();

    // Pre-lap: calibration is in progress, `facade`'s lapNumber is still 0.
    feedTelemetry({ channel: 'rpm', value: 900, tMonoMs: 1 });

    feed(tracked.gnssProviders[0]!, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 740_001));
    await flushBootstrap();
    composition.facade.acceptCalibration();
    await flushBootstrap();
    composition.facade.arm();
    feed(tracked.gnssProviders[0]!, multiLapSession(TMR_CIRCUIT_PROFILE, 1, 740_002));
    await flushBootstrap();

    // Lap 1 has now completed (the driver is on the NEXT lap, out on track
    // again, per `SessionController`'s own binding semantics -- a session
    // doesn't end until `endSession()`) -- a sample recorded here must be
    // tagged with a real, non-zero lap number, not 0/NULL.
    feedTelemetry({ channel: 'rpm', value: 950, tMonoMs: 2 });

    composition.facade.endSession();
    await flushBootstrap();
    await flushBootstrap();

    const rows = await allRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.lap_number).toBeNull(); // pre-lap sample -- 0 mapped to NULL (F4 fix).
    expect(rows[1]!.lap_number).toBeGreaterThan(0); // post-crossing sample -- real, non-zero lap number.
  });

  it('F7 fix: "delete all my data" also deletes telemetry_samples, and the result reports failure if any survive', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ telemetryEnabled: true });

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    feedTelemetry({ channel: 'rpm', value: 900, tMonoMs: 1 });
    feed(tracked.gnssProviders[0]!, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 750_001));
    await flushBootstrap();
    composition.facade.acceptCalibration();
    await flushBootstrap();
    composition.facade.arm();
    feed(tracked.gnssProviders[0]!, multiLapSession(TMR_CIRCUIT_PROFILE, 1, 750_002));
    await flushBootstrap();
    feedTelemetry({ channel: 'rpm', value: 950, tMonoMs: 2 });
    composition.facade.endSession();
    await flushBootstrap();
    await flushBootstrap();

    expect((await allRows()).length).toBeGreaterThan(0); // sanity: rows genuinely exist before deletion.

    const result = await composition.deleteAllStoredUserData();

    expect(result.ok).toBe(true);
    expect((await allRows()).length).toBe(0);
  });
});
