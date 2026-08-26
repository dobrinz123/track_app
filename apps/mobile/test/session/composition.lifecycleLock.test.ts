import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SqlSessionRepository,
  cleanRecognitionLap,
  type LapRecord,
  type LocationSample,
  type SqlDatabase,
} from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { createSqlWriteGate, gateSqlTransactions } from '../../src/persistence/sqlWriteGate';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';

/**
 * ticket CN-FIX3 (N7) -- the concurrency scenarios Codex CN-REV3 reported as
 * still open (N1..N5), each written to FAIL against HEAD (`5d7bcb2`) and pass
 * only once contracts.md's "lifecycle lock amendment" (ONE ordering boundary:
 * `lifecycleLock`) is actually in place.
 *
 * Follows `composition.circuitSelection.test.ts`'s established mocking
 * pattern, with two deliberate additions (N7's own "the database mock omits
 * the real write gate" finding): `openAppDatabase` here returns the REAL
 * `createSqlWriteGate()`/`gateSqlTransactions()` pair production uses, so the
 * active-session transaction and the delete-all telemetry step are exercised
 * through the genuine gate rather than a passthrough.
 */

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  gatedDb: undefined as unknown,
  writeGate: undefined as unknown,
  repository: undefined as unknown,
}));

const tracked = vi.hoisted(() => ({
  gnssProviders: [] as StubLocationProviderInstance[],
  /** One `PerformanceNowClock` is constructed per production-controller BUILD (`createProductionController()`), plus exactly one at module load for the telemetry clock -- so this count is a precise "how many times was the controller (re)built?" instrument. */
  clocks: [] as unknown[],
}));

interface StubLocationProviderInstance {
  startCount: number;
  stopCount: number;
  push(sample: LocationSample): void;
}

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'lifecycle-lock-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubGnssLocationProvider {
    listeners = new Set<(s: LocationSample) => void>();
    startCount = 0;
    stopCount = 0;
    constructor() {
      tracked.gnssProviders.push(this);
    }
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
  class StubClock {
    constructor() {
      tracked.clocks.push(this);
    }
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

/** Builds a fresh sql.js database + repository behind the REAL write gate, and points the mocked `openAppDatabase` at it. Returns the RAW db (for direct seeding/assertions) alongside the repository. */
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
  tracked.clocks.length = 0;
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
  lapNumber: number;
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

async function readSetting(db: SqlDatabase, key: string): Promise<string | null> {
  const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return rows[0]?.value ?? null;
}

describe('TMR default path (ticket CN-FIX3 CONSTRAINTS): bootstrap ordering is unchanged for a user who never selects', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a persisted non-default coachingEnabled is hydrated BEFORE the controller is built -- exactly ONE production controller is built at bootstrap, and the first startPreflight() forwards without rebuilding', async () => {
    const { db } = await seedDatabase();
    // Persisted settings that DIFFER from the in-memory defaults
    // (coachingEnabled defaults to true): if hydration ever ran after the
    // controller build, the settings subscriber would observe the change with
    // a controller already in place and queue an extra rebuild.
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ coachingEnabled: false }),
    ]);

    const composition = await importFreshComposition();
    await tick(0);

    expect(composition.settingsStore.getSettings().coachingEnabled).toBe(false);
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(TMR_CIRCUIT_PROFILE.circuitId);
    expect(composition.getProductionCircuitId()).toBe(TMR_CIRCUIT_PROFILE.circuitId);
    expect(tracked.gnssProviders.length).toBe(1);
    // One module-load telemetry clock + ONE production-controller build.
    expect(tracked.clocks.length).toBe(2);

    composition.facade.startPreflight();
    await tick(0);
    // The gate found a controller that is already idle and already on the
    // resolved selection: nothing to rebuild, command forwarded.
    expect(tracked.clocks.length).toBe(2);

    composition.facade.beginCalibration();
    await tick(0);
    const gnss = tracked.gnssProviders[0]!;
    for (const sample of cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 700_401)) gnss.push(sample);
    await tick(0);
    const state = latestFacadeState(composition);
    expect(state.sessionState).toBe('calibrationReview');
    expect(state.calibrationResult?.accepted).toBe(true);
  });
});

describe('N1 (ticket CN-FIX3): the RECOVERY circuit wins over a selection made before Resume', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('crash on MotorPark, then select TMR before tapping Resume -> resumeRecovery() resumes on MOTORPARK and reasserts BOTH keys with MotorPark', async () => {
    const { db, repository } = await seedDatabase();
    const sessionId = 'driver-1--n1-crash-motorpark';
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [ACTIVE_SESSION_KEY, sessionId]);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      ACTIVE_SESSION_CIRCUIT_KEY,
      MOTORPARK_CIRCUIT_PROFILE.circuitId,
    ]);
    await repository.saveCheckpoint(sessionId, { state: 'armed', lapNumber: 0, context: {} }, [lap(1, 90_000)]);

    const composition = await importFreshComposition();

    // Bootstrap resolved the crashed session's circuit correctly.
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    let recovery: { sessionId: string; lapCount: number; circuitId: string } | null = null;
    composition.subscribeRecovery((r) => {
      if (r !== null) recovery = r;
    });
    expect(recovery).not.toBeNull();
    // The banner carries the circuit identity from bootstrap on (N1's
    // `PendingRecovery.circuitId`) -- and can therefore name it.
    expect(recovery!.circuitId).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);

    // The user goes back to circuit selection and picks TMR BEFORE tapping
    // Resume. The controller is idle, so this is permitted.
    const switched = await composition.selectCircuit(TMR_CIRCUIT_PROFILE.circuitId);
    expect(switched).toEqual({ ok: true });
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(TMR_CIRCUIT_PROFILE.circuitId);

    const resumed = await composition.resumeRecovery();
    expect(resumed).toBe(true);

    // HEAD (`5d7bcb2`) rebuilds for the CURRENT selection (TMR), restores the
    // MotorPark checkpoint into it, and overwrites the correct persisted
    // circuit with TMR -- the exact "switch after crash, before resume" hole.
    expect(await readSetting(db, ACTIVE_SESSION_CIRCUIT_KEY)).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(await readSetting(db, ACTIVE_SESSION_KEY)).toBe(sessionId);
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(composition.getProductionCircuitId()).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);
  });
});

describe('N2 (ticket CN-FIX3): a coaching rebuild started mid-recovery cannot leave resume driving a DISPOSED controller', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('delayed loadCheckpoint + a coachingEnabled toggle mid-recovery -> the resumed session is the LIVE production facade, not a disposed controller', async () => {
    const { db, repository } = await seedDatabase();
    const sessionId = 'driver-1--n2-coaching-race';
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [ACTIVE_SESSION_KEY, sessionId]);
    await repository.saveCheckpoint(sessionId, { state: 'armed', lapNumber: 0, context: {} }, [lap(1, 90_000)]);

    const composition = await importFreshComposition();
    expect(composition.settingsStore.getSettings().coachingEnabled).toBe(true);

    const originalLoadCheckpoint = repository.loadCheckpoint.bind(repository);
    repository.loadCheckpoint = async (id: string) => {
      await tick(20);
      return originalLoadCheckpoint(id);
    };

    const resumePromise = composition.resumeRecovery();
    // Let resume get past its rebuild wait and INTO the (now slow) checkpoint
    // read before the coaching toggle fires its own rebuild.
    await tick(0);
    composition.settingsStore.update({ coachingEnabled: false });

    const resumed = await resumePromise;
    expect(resumed).toBe(true);
    await tick(0);

    // On HEAD the settings subscriber's rebuild disposes the controller
    // `resumeRecovery()` captured, so the restore/start lands on a disposed
    // instance whose facade listeners were cleared -- the exposed production
    // facade stays 'idle' with no restored laps.
    const state = latestFacadeState(composition);
    expect(state.sessionState).not.toBe('idle');
    expect(state.laps.length).toBe(1);
    expect(await readSetting(db, ACTIVE_SESSION_KEY)).toBe(sessionId);
  });
});

describe('N3 (ticket CN-FIX3): selection and the preflight gate commit ONE final circuit', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('MotorPark then TMR selections with a delayed history refresh and a startPreflight() in between -> the controller the session actually starts on IS the persisted selection, and a selection issued once it has started is refused SESSION_ACTIVE', async () => {
    const { repository } = await seedDatabase();
    const composition = await importFreshComposition();

    const originalListSessions = repository.listSessions.bind(repository);
    let slowedOnce = false;
    repository.listSessions = async (userId: string, circuitId: string) => {
      if (!slowedOnce && circuitId === MOTORPARK_CIRCUIT_PROFILE.circuitId) {
        slowedOnce = true;
        await tick(30);
      }
      return originalListSessions(userId, circuitId);
    };

    const first = composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    // One macrotask: long enough for HEAD's selection to have written its
    // settings (it applies them BEFORE its slow history refresh), short
    // enough that the history refresh is still in flight.
    await tick(0);

    // On HEAD the gate now reads selection=MotorPark and rebuilds the
    // controller for MotorPark...
    composition.facade.startPreflight();
    // ...and this queued selection then commits TMR anyway, because
    // `RealSessionFacade.startPreflight()` is a controller-side no-op (the
    // state machine first moves at `beginCalibration()`), so the controller
    // still reads 'idle' and HEAD's deny-list lets the change through.
    const second = composition.selectCircuit(TMR_CIRCUIT_PROFILE.circuitId);

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });

    // THE invariant: an idle production controller is always built for the
    // resolved selection. HEAD leaves controller=MotorPark with
    // selection=TMR -- two different final circuits, exactly N3.
    expect(composition.getProductionCircuitId()).toBe(composition.settingsStore.getSettings().selectedCircuitId);
    expect(composition.getProductionCircuitId()).toBe(TMR_CIRCUIT_PROFILE.circuitId);

    // Proven behaviorally too: the session that now starts calibrates
    // against TMR's OWN centerline (MotorPark samples would never accumulate
    // meaningful coverage on it, and vice versa).
    await tick(0);
    composition.facade.beginCalibration();
    await tick(0);
    const gnss = tracked.gnssProviders.at(-1)!;
    for (const sample of cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 700_301)) gnss.push(sample);
    await tick(0);

    const state = latestFacadeState(composition);
    expect(state.sessionState).toBe('calibrationReview');
    expect(state.calibrationResult?.accepted).toBe(true);

    // And now that a session HAS started, a further selection is refused --
    // HEAD only refused outLap/timing/inPit/paused, so it would accept this
    // one mid-calibration.
    const during = await composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(during).toEqual({ ok: false, reason: 'SESSION_ACTIVE' });
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(TMR_CIRCUIT_PROFILE.circuitId);
  });
});

describe('N4 (ticket CN-FIX3): a circuit rejection never suppresses telemetry deletion', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a rejected per-circuit delete still deletes AND verifies telemetry_samples; aggregate ok is false and errorText names the circuit', async () => {
    const { db, repository } = await seedDatabase();
    const composition = await importFreshComposition();

    for (let i = 0; i < 3; i += 1) {
      await db.runAsync(
        'INSERT INTO telemetry_samples (session_id, lap_number, t_mono_ms, channel, value) VALUES (?, ?, ?, ?, ?)',
        ['driver-1--n4', 1, i * 100, 'rpm', 4000 + i],
      );
    }
    const before = await db.getAllAsync<{ count: number }>('SELECT COUNT(*) AS count FROM telemetry_samples');
    expect(before[0]?.count).toBe(3);

    const originalDeleteUserData = repository.deleteUserData.bind(repository);
    let calls = 0;
    repository.deleteUserData = async (userId: string) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated rejection');
      return originalDeleteUserData(userId);
    };

    const result = await composition.deleteAllStoredUserData();

    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.failedCircuitIds).toEqual([TMR_CIRCUIT_PROFILE.circuitId]);
    expect(result.errorText as string).toContain(TMR_CIRCUIT_PROFILE.circuitId);
    // HEAD gates the telemetry step on aggregate circuit success, so these
    // rows survive a rejection entirely.
    const after = await db.getAllAsync<{ count: number }>('SELECT COUNT(*) AS count FROM telemetry_samples');
    expect(after[0]?.count).toBe(0);
  });
});

describe('N5 (ticket CN-FIX3): a cancelled DevReplay scenario installs nothing', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a scenario cancelled while its selectCircuit() is still pending leaves production restored and installs NO replay controller', async () => {
    const { repository } = await seedDatabase();
    const composition = await importFreshComposition();

    const originalListSessions = repository.listSessions.bind(repository);
    repository.listSessions = async (userId: string, circuitId: string) => {
      if (circuitId === MOTORPARK_CIRCUIT_PROFILE.circuitId) await tick(20);
      return originalListSessions(userId, circuitId);
    };

    const scenario = DEV_REPLAY_SCENARIOS.find((s) => s.circuitId === MOTORPARK_CIRCUIT_PROFILE.circuitId)!;
    let cancelled = false;
    const run = composition.runDevReplayScenario(scenario, () => cancelled);
    // The screen unmounts (or another fixture is tapped) while the scenario's
    // own selectCircuit() history refresh is still pending.
    cancelled = true;

    const result = await run;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('CANCELLED');

    // Production is intact: `gnss` is non-null ONLY while the ACTIVE
    // controller is the production (GNSS-backed) one -- a replay install
    // would have made it null.
    const diagnostics = composition.getLiveDiagnostics();
    expect(diagnostics).not.toBeNull();
    expect(diagnostics!.gnss).not.toBeNull();
    expect(latestFacadeState(composition).sessionState).toBe('idle');
  });
});
