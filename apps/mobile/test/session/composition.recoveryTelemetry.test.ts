import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, type LapRecord, type SessionMachineSnapshot } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';

/**
 * F6 fix (WPT3): `resumeRecovery()` must start telemetry recording for the
 * recovered session id, the SAME way normal session start does through
 * `onSessionStarted`. Follows `composition.recovery.test.ts`'s established
 * `bootWithCheckpoint()` pattern, additionally mocking
 * `../../src/session/telemetryProvider` (a fully controlled double) so this
 * test can assert `start()` was actually called without touching the real
 * adapter/native module at all.
 */
const ACTIVE_SESSION_KEY = 'activeSessionId';

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
}));

const telemetryDouble = vi.hoisted(() => ({
  startCalls: 0,
  stopCalls: 0,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'recovery-telemetry-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubGnssLocationProvider {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    subscribe(): () => void {
      return () => {};
    }
    getDiagnostics(): unknown {
      return { sampleIntervalHistogramMs: [] };
    }
  }
  class StubClock {
    now(): number {
      return 0;
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
  openAppDatabase: async () => ({ db: seeded.db, repository: seeded.repository }),
}));

vi.mock('../../src/session/telemetryProvider', () => ({
  createTelemetryProvider: () => ({
    start: () => {
      telemetryDouble.startCalls += 1;
    },
    stop: async () => {
      telemetryDouble.stopCalls += 1;
    },
    onSample: () => () => undefined,
    onStateChange: (cb: (s: string) => void) => {
      cb('idle');
      return () => undefined;
    },
    getDiagnostics: () => ({ state: 'idle', observedHzByChannel: {}, errorCount: 0, retriesUsed: 0 }),
  }),
}));

/** Passive `GForceProvider` double -- exists ONLY so composition.ts's unconditional `createGForceProvider(...)` import/construction never reaches the real, lazy `import('expo-sensors')` inside `gforceProvider.ts` (vitest must never load it); this file's own tests don't need G samples. */
vi.mock('../../src/session/gforceProvider', () => ({
  createGForceProvider: () => ({
    start: () => {},
    stop: async () => {},
    onSample: () => () => undefined,
  }),
}));

function lap(lapNumber: number, durationMs: number): LapRecord {
  return {
    lapNumber,
    tStart: 0,
    tEnd: durationMs,
    durationMs,
    sectorTimes: [],
    valid: true,
    invalidReasons: [],
    quality: 'good',
  };
}

function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function bootWithCheckpoint(
  sessionId: string,
  snapshot: SessionMachineSnapshot,
  laps: LapRecord[] = [],
): Promise<typeof import('../../src/session/composition')> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  await migrateTelemetrySchema(db);
  await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [ACTIVE_SESSION_KEY, sessionId]);
  await repository.saveCheckpoint(sessionId, snapshot, laps);
  seeded.db = db;
  seeded.repository = repository;
  telemetryDouble.startCalls = 0;
  telemetryDouble.stopCalls = 0;

  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

describe('composition.ts resumeRecovery() starts telemetry recording (F6 fix, WPT3)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('telemetryEnabled: resuming a recovered session starts the telemetry provider for the recovered session id', async () => {
    const composition = await bootWithCheckpoint(
      'driver-1--rec-telemetry',
      { state: 'timing', lapNumber: 3, context: {} },
      [lap(1, 90_000), lap(2, 88_000)],
    );
    composition.settingsStore.update({ telemetryEnabled: true });

    expect(telemetryDouble.startCalls).toBe(0); // not started yet -- recovery hasn't resumed.

    const resumed = await composition.resumeRecovery();
    expect(resumed).toBe(true);

    // The SAME hook normal session start reaches through `onSessionStarted`
    // -- previously `resumeRecovery()` drove the controller directly and
    // never called it at all, so a recovered session recorded no OBD data.
    expect(telemetryDouble.startCalls).toBe(1);
  });

  it('telemetryEnabled false (default): resuming a recovered session does NOT start telemetry -- gating is unchanged', async () => {
    const composition = await bootWithCheckpoint(
      'driver-1--rec-telemetry-off',
      { state: 'armed', lapNumber: 0, context: {} },
      [lap(1, 90_000)],
    );

    const resumed = await composition.resumeRecovery();
    expect(resumed).toBe(true);
    expect(telemetryDouble.startCalls).toBe(0);
  });
});
