import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, type LapRecord, type SessionMachineSnapshot } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * composition.ts's recovery decision logic (MUST DO #7): `midSessionState()`
 * and the `recoveryLapCount = checkpoint.laps.length + (midSessionState ? 1 : 0)`
 * math it feeds are private, unexported implementation details of
 * `apps/mobile/src/session/composition.ts` -- and this ticket's write set
 * does not include apps/mobile/src/**, so they cannot be exported for direct
 * unit testing. They ARE observable indirectly, through composition.ts's own
 * exported `subscribeRecovery()`, once the module's bootstrap IIFE runs
 * against a seeded checkpoint -- which is what this file does.
 *
 * composition.ts also imports `expo-constants` and (via its `../platform`
 * barrel) `expo-location`/`expo-sensors`/react-native's `AppState`, none of
 * which run under plain Node/vitest -- CONSTRAINTS requires mocking these
 * minimally rather than pulling in expo/RN runtime. `../persistence/expoSqlDatabase`
 * (the expo-sqlite binding) is likewise mocked, per CONSTRAINTS' explicit
 * instruction not to test that file's expo binding itself -- it is replaced
 * here with a real `SqlSessionRepository` over the sql.js adapter instead,
 * pre-seeded with the checkpoint each test exercises.
 *
 * `ACTIVE_SESSION_KEY` below duplicates composition.ts's own private
 * `ACTIVE_SESSION_SETTINGS_KEY` constant ('activeSessionId') -- there is no
 * exported binding for it (same write-set constraint).
 */
const ACTIVE_SESSION_KEY = 'activeSessionId';

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'composition-test' } },
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

/** Flushes the purely-microtask-based (no real timers) bootstrap IIFE to completion. A macrotask boundary only runs after the ENTIRE pending microtask queue (including chained `await`s) has drained. */
function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Seeds a fresh sql.js-backed repository with an (optional) checkpoint under `sessionId`, points the mocked `openAppDatabase` at it, then imports a fresh `composition` module against that state. */
async function bootWithCheckpoint(
  sessionId: string | null,
  snapshot?: SessionMachineSnapshot,
  laps: LapRecord[] = [],
): Promise<typeof import('../../src/session/composition')> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  if (sessionId !== null) {
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [ACTIVE_SESSION_KEY, sessionId]);
    if (snapshot !== undefined) {
      await repository.saveCheckpoint(sessionId, snapshot, laps);
    }
  }
  seeded.db = db;
  seeded.repository = repository;

  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

describe('composition.ts recovery decision logic (MUST DO #7)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('mid-session state (timing) with 2 recorded laps recovers as lapCount = 3 (laps + the in-flight one)', async () => {
    const composition = await bootWithCheckpoint(
      'driver-1--rec-timing',
      { state: 'timing', lapNumber: 3, context: {} },
      [lap(1, 90_000), lap(2, 88_000)],
    );
    let recovery: unknown = 'unset';
    composition.subscribeRecovery((r) => {
      recovery = r;
    });
    expect(recovery).toEqual({ sessionId: 'driver-1--rec-timing', lapCount: 3 });
  });

  it('"paused" with a mid-session priorState (outLap) still counts the in-flight lap', async () => {
    const composition = await bootWithCheckpoint(
      'driver-1--rec-paused',
      { state: 'paused', lapNumber: 1, context: { priorState: 'outLap' } },
      [],
    );
    let recovery: unknown = 'unset';
    composition.subscribeRecovery((r) => {
      recovery = r;
    });
    expect(recovery).toEqual({ sessionId: 'driver-1--rec-paused', lapCount: 1 });
  });

  it('"paused" with a non-mid-session priorState (armed) does NOT add an in-flight lap', async () => {
    const composition = await bootWithCheckpoint(
      'driver-1--rec-paused-armed',
      { state: 'paused', lapNumber: 0, context: { priorState: 'armed' } },
      [lap(1, 90_000)],
    );
    let recovery: unknown = 'unset';
    composition.subscribeRecovery((r) => {
      recovery = r;
    });
    expect(recovery).toEqual({ sessionId: 'driver-1--rec-paused-armed', lapCount: 1 });
  });

  it('a non-mid-session state (armed) recovers as lapCount = laps.length exactly', async () => {
    const composition = await bootWithCheckpoint(
      'driver-1--rec-armed',
      { state: 'armed', lapNumber: 0, context: {} },
      [lap(1, 90_000)],
    );
    let recovery: unknown = 'unset';
    composition.subscribeRecovery((r) => {
      recovery = r;
    });
    expect(recovery).toEqual({ sessionId: 'driver-1--rec-armed', lapCount: 1 });
  });

  it('a checkpoint already in "sessionComplete" is never offered as a recovery', async () => {
    const composition = await bootWithCheckpoint(
      'driver-1--rec-complete',
      { state: 'sessionComplete', lapNumber: 3, context: {} },
      [lap(1, 90_000)],
    );
    let recovery: unknown = 'unset';
    composition.subscribeRecovery((r) => {
      recovery = r;
    });
    expect(recovery).toBeNull();
  });

  it('no active-session pointer at all -> no recovery offered', async () => {
    const composition = await bootWithCheckpoint(null);
    let recovery: unknown = 'unset';
    composition.subscribeRecovery((r) => {
      recovery = r;
    });
    expect(recovery).toBeNull();
  });
});
