import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, type LapRecord, type SessionMachineSnapshot } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * Ticket P5c-FIX1 E7 (Codex P5c-REV1 finding 7): a RECOVERED outing is a real
 * outing. `resumeRecovery()` drives the controller directly and never goes
 * through `RealSessionFacadeCallbacks.onSessionStarted`, so nothing used to
 * initialise the trackday stage for it: `mostRecentSessionId` stayed null, the
 * pit view had no session to open, and no cue could ever be computed for the
 * laps the driver had already driven.
 *
 * Same harness as `composition.recovery.test.ts` (its own doc comment explains
 * why composition has to be booted rather than unit-tested): expo/RN modules
 * mocked minimally, a real `SqlSessionRepository` over sql.js underneath.
 */
const ACTIVE_SESSION_KEY = 'activeSessionId';
const ACTIVE_SESSION_STARTED_KEY = 'activeSessionStartedAtUtc';

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

function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function bootWithCheckpoint(
  sessionId: string,
  snapshot: SessionMachineSnapshot,
  laps: LapRecord[],
  startedAtUtc?: string,
): Promise<typeof import('../../src/session/composition')> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
    ACTIVE_SESSION_KEY,
    sessionId,
  ]);
  if (startedAtUtc !== undefined) {
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      ACTIVE_SESSION_STARTED_KEY,
      startedAtUtc,
    ]);
  }
  await repository.saveCheckpoint(sessionId, snapshot, laps);
  seeded.db = db;
  seeded.repository = repository;

  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

describe('composition — a recovered outing can use the trackday stage (E7)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('has NO stint context before the recovery is resumed', async () => {
    const composition = await bootWithCheckpoint(
      'driver-1--stint-rec',
      { state: 'timing', lapNumber: 3, context: {} },
      [lap(1, 90_000), lap(2, 88_000)],
    );
    expect(composition.getActiveStintContext()).toBeNull();
  });

  it('initialises the stint stage on resume, with the recovered session id', async () => {
    const composition = await bootWithCheckpoint(
      'driver-1--stint-rec',
      { state: 'timing', lapNumber: 3, context: {} },
      [lap(1, 90_000), lap(2, 88_000)],
      '2026-08-31T07:30:00.000Z',
    );

    expect(await composition.resumeRecovery()).toBe(true);

    const context = composition.getActiveStintContext();
    expect(context).not.toBeNull();
    expect(context?.sessionId).toBe('driver-1--stint-rec');
    // The restored laps are what the pit view would analyse: the two
    // completed ones plus the interrupted in-flight lap, which
    // `restoreFromCheckpoint` records as a RECOVERY lap.
    expect(context?.completedLapCount).toBe(3);
    // And the journal is addressable for that session, empty, never another
    // outing's.
    expect(composition.getTrackdayRecord('driver-1--stint-rec')).toEqual({
      cueUpdates: [],
      shownPitSuggestions: [],
    });
  });

  it('resumes with an outing that has no stored start instant too (legacy pointer)', async () => {
    const composition = await bootWithCheckpoint(
      'driver-1--stint-legacy',
      { state: 'timing', lapNumber: 2, context: {} },
      [lap(1, 91_000)],
    );
    expect(await composition.resumeRecovery()).toBe(true);
    expect(composition.getActiveStintContext()?.sessionId).toBe('driver-1--stint-legacy');
  });
});
