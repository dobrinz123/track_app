import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SqlSessionRepository,
  cleanRecognitionLap,
  multiLapSession,
  type LapRecord,
  type LocationSample,
  type SqlDatabase,
} from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { createSqlWriteGate, gateSqlTransactions } from '../../src/persistence/sqlWriteGate';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';

/**
 * ticket CN-FIX4 (Codex CN-REV4) -- contracts.md's "Multi-circuit selection —
 * facade boundary amendment" (binding). Every scenario here FAILS against
 * `fd9a5c6`: the lifecycle lock existed, but the asynchronous facade commands
 * (`beginCalibration`, `endSession`) ran outside it, so a controller could be
 * `idle` on paper while genuinely starting, delete-all could outrun an
 * in-flight session end, a terminal controller could re-persist a checkpoint
 * from the background hook, and a cancelled DevReplay run still moved the
 * selection.
 */

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  gatedDb: undefined as unknown,
  writeGate: undefined as unknown,
  repository: undefined as unknown,
}));

const tracked = vi.hoisted(() => ({
  gnssProviders: [] as StubLocationProviderInstance[],
  /** Captured `startLifecycleListener({ onBackground })` registrations -- lets a test fire a real OS-background transition. */
  lifecycleHooks: [] as Array<{ onBackground: () => void }>,
}));

interface StubLocationProviderInstance {
  startCount: number;
  stopCount: number;
  startDelayMs: number;
  stopDelayMs: number;
  stopShouldReject: boolean;
  push(sample: LocationSample): void;
}

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'facade-boundary-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubGnssLocationProvider {
    listeners = new Set<(s: LocationSample) => void>();
    startCount = 0;
    stopCount = 0;
    /** Test-controlled latency for the exact awaits the amendment is about. */
    startDelayMs = 0;
    stopDelayMs = 0;
    /** Drives the "controller end FAILS" path: `SessionController.endSession()` awaits provider stop first, so a rejection there means its success-only `onSessionEnded` callback never runs. */
    stopShouldReject = false;
    constructor() {
      tracked.gnssProviders.push(this);
    }
    async start(): Promise<void> {
      this.startCount += 1;
      if (this.startDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));
    }
    async stop(): Promise<void> {
      this.stopCount += 1;
      if (this.stopDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.stopDelayMs));
      if (this.stopShouldReject) throw new Error('provider stop failed (test double)');
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
    startLifecycleListener: (hooks: { onBackground: () => void }) => {
      tracked.lifecycleHooks.push(hooks);
    },
  };
});

vi.mock('../../src/persistence/expoSqlDatabase', () => ({
  openAppDatabase: async () => ({
    db: seeded.gatedDb,
    repository: seeded.repository,
    writeGate: seeded.writeGate,
  }),
}));

import { TMR_CIRCUIT_PROFILE } from '../../src/session/tmrProfile';
import { MOTORPARK_CIRCUIT_PROFILE } from '../../src/session/circuitCatalog';
import { DEV_REPLAY_SCENARIOS } from '../../src/session/devReplayScenarios';

const ACTIVE_SESSION_KEY = 'activeSessionId';
const ACTIVE_SESSION_CIRCUIT_KEY = 'activeSessionCircuitId';

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  tracked.gnssProviders.length = 0;
  tracked.lifecycleHooks.length = 0;
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
  laps: unknown[];
  calibrationResult: { accepted: boolean } | null;
} {
  let latest: unknown;
  const unsubscribe = composition.facade.subscribe((s) => {
    latest = s;
  });
  unsubscribe();
  return latest as ReturnType<typeof latestFacadeState>;
}

async function countRows(db: SqlDatabase, table: string): Promise<number> {
  const rows = await db.getAllAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return rows[0]?.count ?? 0;
}

/** Drives a real session from idle to mid-session (timing/outLap) with one completed lap. */
async function driveToMidSession(
  composition: typeof import('../../src/session/composition'),
  gnss: StubLocationProviderInstance,
): Promise<void> {
  composition.facade.startPreflight();
  await tick(0);
  composition.facade.beginCalibration();
  await tick(0);
  for (const sample of cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 900_001)) gnss.push(sample);
  await tick(0);
  composition.facade.acceptCalibration();
  await tick(0);
  composition.facade.arm();
  await tick(0);
  for (const sample of multiLapSession(TMR_CIRCUIT_PROFILE, 1, 900_002)) gnss.push(sample);
  await tick(0);
}

describe('A/N3 (ticket CN-FIX4): an asynchronous session start is inside the lock', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('beginCalibration() with a slow provider start: a selection issued during the start is REFUSED, and the running session\'s circuit is the persisted selection', async () => {
    await seedDatabase();
    const composition = await importFreshComposition();
    const gnss = tracked.gnssProviders[0]!;

    composition.facade.startPreflight();
    await tick(0);
    // The exact window CN-REV4 found: `SessionController.start()` has taken a
    // session id but still reports `idle` while awaiting provider startup.
    gnss.startDelayMs = 30;
    composition.facade.beginCalibration();
    await tick(0);

    const selection = await composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    await tick(40);

    // HEAD: the controller reads `idle` mid-start, so the selection is
    // admitted, MotorPark is persisted, and the TMR controller is disposed
    // and replaced -- while its start resumes and runs a TMR session anyway.
    expect(selection).toEqual({ ok: false, reason: 'SESSION_ACTIVE' });
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(TMR_CIRCUIT_PROFILE.circuitId);
    expect(composition.getProductionCircuitId()).toBe(TMR_CIRCUIT_PROFILE.circuitId);

    // The session that started is live and drives the exposed facade.
    gnss.startDelayMs = 0;
    for (const sample of cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 900_101)) gnss.push(sample);
    await tick(0);
    const state = latestFacadeState(composition);
    expect(state.sessionState).toBe('calibrationReview');
    expect(state.calibrationResult?.accepted).toBe(true);
  });
});

describe('1 (ticket CN-FIX5): a QUEUED endSession() still shuts telemetry down', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('telemetry started by the lock holder after the fire-early stop is stopped inside the queued section -- even when the controller end itself fails', async () => {
    await seedDatabase();
    const composition = await importFreshComposition();
    const gnss = tracked.gnssProviders[0]!;
    composition.settingsStore.update({ telemetryEnabled: true });

    // Mirrors the provider's real running/stopped lifecycle: `startTelemetryRecording()`
    // starts it, `stopTelemetryRecording()` stops it.
    let telemetryRunning = false;
    const provider = composition.telemetryProvider as unknown as {
      start: () => void;
      stop: () => Promise<void>;
    };
    const originalStart = provider.start.bind(provider);
    const originalStop = provider.stop.bind(provider);
    provider.start = () => {
      telemetryRunning = true;
      originalStart();
    };
    provider.stop = async () => {
      telemetryRunning = false;
      await originalStop();
    };

    composition.facade.startPreflight();
    await tick(0);

    // The lock holder: a slow beginCalibration whose onSessionStarted will
    // START telemetry when it finally completes.
    gnss.startDelayMs = 30;
    composition.facade.beginCalibration();
    // Queued behind it. Its fire-early telemetry stop runs NOW -- while
    // nothing is recording yet, so it stops nothing.
    composition.facade.endSession();
    expect(telemetryRunning).toBe(false);
    // ...and the queued controller end then FAILS, so the success-only
    // `onSessionEnded` telemetry stop never runs either.
    gnss.stopShouldReject = true;

    await tick(90);

    // HEAD (`a2681e3`): telemetry started by the lock holder outlives the
    // session end entirely -- the F2 "shutdown even when the controller end
    // rejects" guarantee did not survive the command queueing.
    expect(telemetryRunning).toBe(false);
  });
});

describe('C (ticket CN-FIX4): delete-all is durable against controller persistence', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('an in-flight endSession() (slow provider stop) followed by delete-all: nothing is re-persisted behind the wipe', async () => {
    const { db } = await seedDatabase();
    const composition = await importFreshComposition();
    const gnss = tracked.gnssProviders[0]!;

    await driveToMidSession(composition, gnss);
    expect(['outLap', 'timing', 'inPit']).toContain(latestFacadeState(composition).sessionState);

    // `SessionController.endSession()` awaits provider stop BEFORE it saves
    // the session summary and its terminal checkpoint.
    gnss.stopDelayMs = 30;
    composition.facade.endSession();

    const result = await composition.deleteAllStoredUserData();
    await tick(60);

    expect(result.ok).toBe(true);
    // HEAD: `endSession()` is fire-and-forget outside the lock, so the
    // session row and checkpoint land AFTER delete-all verified empty.
    expect(await countRows(db, 'sessions')).toBe(0);
    expect(await countRows(db, 'checkpoints')).toBe(0);
    expect(await countRows(db, 'laps')).toBe(0);
  });

  it('after a completed session, delete-all leaves nothing that a later app-background checkpoint can recreate', async () => {
    const { db } = await seedDatabase();
    const composition = await importFreshComposition();
    const gnss = tracked.gnssProviders[0]!;

    await driveToMidSession(composition, gnss);
    composition.facade.endSession();
    await tick(10);
    expect(latestFacadeState(composition).sessionState).toBe('sessionComplete');

    const result = await composition.deleteAllStoredUserData();
    expect(result.ok).toBe(true);
    expect(await countRows(db, 'checkpoints')).toBe(0);

    // A real OS background transition after the wipe.
    expect(tracked.lifecycleHooks.length).toBeGreaterThan(0);
    for (const hook of tracked.lifecycleHooks) hook.onBackground();
    await tick(10);

    // HEAD: `checkpointNow()` fires on the retained terminal controller
    // (its `sessionId` is still set) and re-creates the deleted checkpoint.
    expect(await countRows(db, 'checkpoints')).toBe(0);
    expect(await countRows(db, 'sessions')).toBe(0);
  });

  it('delete-all is REFUSED while a session is genuinely mid-session -- stored data is left untouched', async () => {
    const { db } = await seedDatabase();
    const composition = await importFreshComposition();
    const gnss = tracked.gnssProviders[0]!;

    await driveToMidSession(composition, gnss);
    const midState = latestFacadeState(composition).sessionState;
    expect(['outLap', 'timing', 'inPit', 'paused']).toContain(midState);
    // Seed a stored session so "untouched" is observable.
    const repo = seeded.repository as SqlSessionRepository;
    await repo.saveSession({
      sessionId: 'driver-1--keep-me',
      circuitId: TMR_CIRCUIT_PROFILE.circuitId,
      layoutId: TMR_CIRCUIT_PROFILE.layoutId,
      layoutVersion: TMR_CIRCUIT_PROFILE.layoutVersion,
      startedAtUtc: new Date().toISOString(),
      laps: [lap(1, 90_000)],
      userId: 'local-driver',
    });

    const result = await composition.deleteAllStoredUserData();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('SESSION_ACTIVE');
    expect(await countRows(db, 'sessions')).toBe(1);
    // The live session is untouched by the refusal.
    expect(latestFacadeState(composition).sessionState).toBe(midState);
  });
});

describe('3 (ticket CN-FIX5): delete-all is refused while a DevReplay controller is installed', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a live replay controller means DEV_REPLAY_ACTIVE -- nothing is read, deleted or verified', async () => {
    const { db, repository } = await seedDatabase();
    const composition = await importFreshComposition();
    await repository.saveSession({
      sessionId: 'driver-1--survives-dev-replay',
      circuitId: TMR_CIRCUIT_PROFILE.circuitId,
      layoutId: TMR_CIRCUIT_PROFILE.layoutId,
      layoutVersion: TMR_CIRCUIT_PROFILE.layoutVersion,
      startedAtUtc: new Date().toISOString(),
      laps: [lap(1, 90_000)],
      userId: 'local-driver',
    });

    const scenario = DEV_REPLAY_SCENARIOS.find((s) => s.circuitId === TMR_CIRCUIT_PROFILE.circuitId)!;
    const run = await composition.runDevReplayScenario(scenario);
    expect(run).toEqual({ ok: true });
    // The replay controller -- not the production one -- is driving `facade`.
    expect(composition.getLiveDiagnostics()!.gnss).toBeNull();

    const result = await composition.deleteAllStoredUserData();

    // HEAD (`a2681e3`): the replay's states are not in `MID_SESSION_STATES`,
    // so the wipe was admitted while `unlockedRebuildProductionController()`
    // silently no-opped (a replay controller is active) -- leaving a live
    // controller with a session id that can persist right back over the wipe.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('DEV_REPLAY_ACTIVE');
    expect(result.errorText as string).toContain('replay');
    expect(await countRows(db, 'sessions')).toBe(1);
  });
});

describe('D/N5 (ticket CN-FIX4 + CN-FIX5 item 4): DevReplay cancellation is honored before the selection write', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('an already-stale generation leaves the selection, the history store and the production controller untouched', async () => {
    const { repository } = await seedDatabase();
    const composition = await importFreshComposition();

    // A stored TMR session makes the history store's identity observable.
    await repository.saveSession({
      sessionId: 'driver-1--tmr-history',
      circuitId: TMR_CIRCUIT_PROFILE.circuitId,
      layoutId: TMR_CIRCUIT_PROFILE.layoutId,
      layoutVersion: TMR_CIRCUIT_PROFILE.layoutVersion,
      startedAtUtc: new Date().toISOString(),
      laps: [lap(1, 90_000)],
      userId: 'local-driver',
    });
    await composition.selectCircuit(TMR_CIRCUIT_PROFILE.circuitId);
    const historyBefore = composition.sessionHistoryStore.listSessions().map((s) => s.sessionId);
    expect(historyBefore).toContain('driver-1--tmr-history');

    const scenario = DEV_REPLAY_SCENARIOS.find((s) => s.circuitId === MOTORPARK_CIRCUIT_PROFILE.circuitId)!;
    const result = await composition.runDevReplayScenario(scenario, () => true);

    expect(result).toEqual({ ok: false, reason: 'CANCELLED' });
    // HEAD: restore + the selection write + the controller rebuild all ran
    // before the first cancellation check, so MotorPark was left selected.
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(TMR_CIRCUIT_PROFILE.circuitId);
    expect(composition.getProductionCircuitId()).toBe(TMR_CIRCUIT_PROFILE.circuitId);
    expect(composition.sessionHistoryStore.listSessions().map((s) => s.sessionId)).toEqual(historyBefore);
    expect(composition.getLiveDiagnostics()!.gnss).not.toBeNull();
  });

  /**
   * ticket CN-FIX5 item 4 (contracts.md's closing amendment, binding): once
   * the selection write has BEGUN, cancellation no longer aborts it -- there
   * is no rollback. The run finishes the selection so settings, the history
   * store and the production controller all agree, then skips the install and
   * the navigation and reports `CANCELLED`. This pins that contract (a
   * half-applied selection would be far worse than a consistent one the user
   * did not ask for).
   */
  it('cancellation that flips DURING the selection write completes the selection consistently and installs nothing', async () => {
    const { repository } = await seedDatabase();
    const composition = await importFreshComposition();
    await repository.saveSession({
      sessionId: 'driver-1--mp-history',
      circuitId: MOTORPARK_CIRCUIT_PROFILE.circuitId,
      layoutId: MOTORPARK_CIRCUIT_PROFILE.layoutId,
      layoutVersion: MOTORPARK_CIRCUIT_PROFILE.layoutVersion,
      startedAtUtc: new Date().toISOString(),
      laps: [lap(1, 95_000)],
      userId: 'local-driver',
    });

    let cancelled = false;
    const originalListSessions = repository.listSessions.bind(repository);
    repository.listSessions = async (userId: string, circuitId: string) => {
      if (circuitId === MOTORPARK_CIRCUIT_PROFILE.circuitId) {
        // The scenario's own selection write is in flight at exactly this
        // moment (settings already applied, history refresh pending).
        cancelled = true;
        await tick(5);
      }
      return originalListSessions(userId, circuitId);
    };

    const scenario = DEV_REPLAY_SCENARIOS.find((s) => s.circuitId === MOTORPARK_CIRCUIT_PROFILE.circuitId)!;
    const result = await composition.runDevReplayScenario(scenario, () => cancelled);

    expect(result).toEqual({ ok: false, reason: 'CANCELLED' });
    // Consistency, not rollback: all three agree on MotorPark.
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(composition.getProductionCircuitId()).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(composition.sessionHistoryStore.listSessions().map((s) => s.sessionId)).toContain('driver-1--mp-history');
    // Nothing was installed: production still drives `facade`.
    expect(composition.getLiveDiagnostics()!.gnss).not.toBeNull();
    expect(latestFacadeState(composition).sessionState).toBe('idle');
  });
});

describe('E (ticket CN-FIX4): a recovery whose circuit is no longer bundled is DISCARDED, never resumed on other geometry', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('resumeRecovery() clears both keys and the banner, starts no session, and warns', async () => {
    const { db, repository } = await seedDatabase();
    const sessionId = 'driver-1--unbundled-recovery';
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [ACTIVE_SESSION_KEY, sessionId]);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      ACTIVE_SESSION_CIRCUIT_KEY,
      MOTORPARK_CIRCUIT_PROFILE.circuitId,
    ]);
    await repository.saveCheckpoint(sessionId, { state: 'armed', lapNumber: 0, context: {} }, [lap(1, 90_000)]);

    const composition = await importFreshComposition();
    let recovery: unknown = 'unset';
    composition.subscribeRecovery((r) => {
      recovery = r;
    });
    expect(recovery).not.toBeNull();

    // The catalog loses that circuit between bootstrap and the Resume tap
    // (a catalog build that dropped it) -- the defensive path the amendment
    // says must DISCARD rather than fall back to the current selection.
    // Resolved through a dynamic import so this is the SAME module instance
    // the freshly-reset `composition` is holding (`vi.resetModules()` gives
    // the static import at the top of this file an older instance).
    const { circuitCatalog } = await import('../../src/session/circuitCatalog');
    const originalGet = circuitCatalog.get.bind(circuitCatalog);
    circuitCatalog.get = (circuitId: string) =>
      circuitId === MOTORPARK_CIRCUIT_PROFILE.circuitId ? null : originalGet(circuitId);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const resumed = await composition.resumeRecovery();

      // HEAD: warns and resumes on the CURRENT selection's geometry.
      expect(resumed).toBe(false);
      expect(warn).toHaveBeenCalled();
      expect(latestFacadeState(composition).sessionState).toBe('idle');
      let after: unknown = 'unset';
      composition.subscribeRecovery((r) => {
        after = r;
      });
      expect(after).toBeNull();
      const idRows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
        ACTIVE_SESSION_KEY,
      ]);
      const circuitRows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
        ACTIVE_SESSION_CIRCUIT_KEY,
      ]);
      expect(idRows.length).toBe(0);
      expect(circuitRows.length).toBe(0);
    } finally {
      circuitCatalog.get = originalGet;
      warn.mockRestore();
    }
  });
});

/**
 * P4h-FIX2 F3 (after Codex P4h-REV2 MEDIUM, `composition.ts:323,342`;
 * `CalibrationInstructionsScreen.tsx:48`): "calibration cancellation covers
 * only a start already executing inside the lifecycle lock. If
 * `beginCalibration()` is QUEUED behind another lock holder, navigation still
 * immediately pushes ActiveCalibration; Cancel calls the unlocked
 * `rejectCalibration()` before `SessionController.start()` sets
 * `calibrationStartInFlight`, so it is a no-op. The queued command later
 * starts an invisible calibration after the user has left."
 *
 * Binding fix (ticket P4h-FIX2): `beginCalibration()` carries a
 * composition-level cancel token; when the lock is finally acquired and the
 * token is cancelled, the command returns without starting anything.
 */
describe('F3 (ticket P4h-FIX2): Cancel cancels a calibration start that is still QUEUED behind the lock', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a beginCalibration() queued behind a slow selection is cancelled by rejectCalibration(): no calibration ever starts', async () => {
    await seedDatabase();
    const composition = await importFreshComposition();
    const gnss = tracked.gnssProviders[0]!;

    // The lock holder: a circuit change whose controller rebuild awaits the
    // (deliberately slow) GNSS provider stop -- contracts.md's provider
    // ownership amendment -- so it holds `lifecycleLock` for ~30 ms.
    gnss.stopDelayMs = 30;
    const selection = composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);

    // The user taps "Start calibration": the command QUEUES behind the
    // selection, and the screen navigates to ActiveCalibration immediately.
    composition.facade.beginCalibration();
    // ...and immediately taps Cancel there, while the start is still queued
    // (the controller is `idle`, `calibrationStartInFlight` is still false).
    composition.facade.rejectCalibration();

    expect(await selection).toEqual({ ok: true });
    gnss.stopDelayMs = 0;
    await tick(60);

    // HEAD (74a21e9): the queued command runs after the user has left and
    // starts an INVISIBLE calibration (watchdog running, session id minted).
    expect(latestFacadeState(composition).sessionState).toBe('idle');
    expect(composition.getProductionCircuitId()).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);
  });

  it('the cancel applies to THAT queued start only -- a later beginCalibration() still works', async () => {
    await seedDatabase();
    const composition = await importFreshComposition();
    const gnss = tracked.gnssProviders[0]!;

    gnss.stopDelayMs = 30;
    const selection = composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    composition.facade.beginCalibration();
    composition.facade.rejectCalibration();
    expect(await selection).toEqual({ ok: true });
    gnss.stopDelayMs = 0;
    await tick(60);
    expect(latestFacadeState(composition).sessionState).toBe('idle');

    composition.facade.beginCalibration();
    await tick(20);
    expect(latestFacadeState(composition).sessionState).toBe('calibrating');
  });
});
