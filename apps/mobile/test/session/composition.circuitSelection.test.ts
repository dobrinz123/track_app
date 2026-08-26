import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SqlSessionRepository,
  cleanRecognitionLap,
  motorparkCleanRecognitionLap,
  multiLapSession,
  type LapRecord,
  type LocationSample,
  type SessionMachineSnapshot,
  type SqlDatabase,
} from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';

/**
 * ticket CN-W3 -- composition-level tests for contracts.md's Multi-circuit
 * selection addendum: preflight-gate rebuild-on-circuit-change (idle only,
 * never mid-session), delete-all spanning every bundled circuit, and
 * recovery's circuit resolution via `listSessions`. Follows
 * `composition.lifecycle.test.ts`'s established mocking pattern (own
 * `vi.mock`s for `expo-constants`/`../platform`/`expoSqlDatabase`, a fresh
 * module instance per test via `vi.resetModules()`, a feed-capable stub
 * GNSS provider) so fixtures run through the REAL production pipeline.
 */

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
}));

const tracked = vi.hoisted(() => ({
  gnssProviders: [] as StubLocationProviderInstance[],
}));

interface StubLocationProviderInstance {
  startCount: number;
  stopCount: number;
  push(sample: LocationSample): void;
}

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'circuit-selection-test' } },
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

import { TMR_CIRCUIT_PROFILE } from '../../src/session/tmrProfile';
import { MOTORPARK_CIRCUIT_PROFILE } from '../../src/session/circuitCatalog';

const ACTIVE_SESSION_KEY = 'activeSessionId';

function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function feed(provider: StubLocationProviderInstance, samples: readonly LocationSample[]): void {
  for (const sample of samples) provider.push(sample);
}

async function bootFresh(): Promise<typeof import('../../src/session/composition')> {
  const db = await createSqlJsDatabase();
  await migrateTelemetrySchema(db);
  const repository = await SqlSessionRepository.create(db);
  seeded.db = db;
  seeded.repository = repository;
  tracked.gnssProviders.length = 0;

  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
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

function latestFacadeState(composition: Awaited<ReturnType<typeof bootFresh>>): unknown {
  let latest: unknown;
  const unsubscribe = composition.facade.subscribe((s) => {
    latest = s;
  });
  unsubscribe();
  return latest;
}

describe('composition.ts preflight-gate circuit-change rebuild (ticket CN-W3)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('selecting a different circuit while idle rebuilds the production controller before the next startPreflight() -- calibration then succeeds against the NEW circuit\'s geometry', async () => {
    const composition = await bootFresh();
    // Default selection is TMR (idle) -- switch to MotorPark before anything starts.
    await composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    const gnss = tracked.gnssProviders.at(-1)!;
    feed(gnss, motorparkCleanRecognitionLap(MOTORPARK_CIRCUIT_PROFILE));
    await flushBootstrap();

    // Only reachable if the controller was actually rebuilt for MotorPark's
    // OWN centerline -- MotorPark's lat/lon samples matched against a
    // still-TMR-configured controller (a totally different, ~300km-away
    // circuit) would never accumulate meaningful on-track coverage.
    const state = latestFacadeState(composition) as {
      sessionState: string;
      calibrationResult: { accepted: boolean } | null;
    };
    expect(state.sessionState).toBe('calibrationReview');
    expect(state.calibrationResult?.accepted).toBe(true);
  });

  it('H2 fix (ticket CN-FIX2): a circuit switch mid-session is REFUSED -- {ok:false, reason:SESSION_ACTIVE}, settings/history untouched -- and the LIVE controller keeps driving TMR to completion', async () => {
    const composition = await bootFresh();
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
    await flushBootstrap();
    // Drive the session into an unambiguous mid-session state (outLap/timing)
    // -- immediately after arm() the state can still just be 'armed' (not
    // yet refused by H2's design, which lists only outLap/timing/inPit/paused),
    // so feed real samples first rather than relying on 'armed' alone.
    feed(gnss, multiLapSession(TMR_CIRCUIT_PROFILE, 1, 700_002));
    await flushBootstrap();

    const midState = latestFacadeState(composition) as { sessionState: string };
    expect(['outLap', 'timing', 'inPit', 'paused']).toContain(midState.sessionState);

    const sessionsBefore = composition.sessionHistoryStore.listSessions();
    const result = await composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);

    // H2 fix: refused -- settings AND history left completely untouched.
    expect(result).toEqual({ ok: false, reason: 'SESSION_ACTIVE' });
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(TMR_CIRCUIT_PROFILE.circuitId);
    expect(composition.sessionHistoryStore.listSessions()).toEqual(sessionsBefore);

    composition.facade.endSession();
    await flushBootstrap();

    const finalState = latestFacadeState(composition) as { sessionState: string; laps: unknown[] };
    expect(finalState.sessionState).toBe('sessionComplete');
    expect(finalState.laps.length).toBeGreaterThan(0);
  });

  it('H1 fix (ticket CN-FIX2): a selection made DURING bootstrap is not lost -- settings, history, and (once startPreflight runs) the controller all end up on the selected circuit', async () => {
    const db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
    const repository = await SqlSessionRepository.create(db);
    seeded.db = db;
    seeded.repository = repository;
    tracked.gnssProviders.length = 0;

    vi.resetModules();
    const composition = await import('../../src/session/composition');
    // Call selectCircuit() IMMEDIATELY -- before bootstrap's own async
    // openAppDatabase()/SqlSettingsStore.create() microtasks have had any
    // chance to settle (this is the exact race H1 fixes: a tap during
    // cold-launch bootstrap previously updated only the temporary in-memory
    // settings store, silently overwritten once the real store came online).
    const selectPromise = composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    await flushBootstrap();
    const result = await selectPromise;
    expect(result).toEqual({ ok: true });

    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);

    // The next startPreflight() rebuilds the production controller for the
    // now-selected circuit (the pre-existing idle-circuit-change gate, L1
    // fixed) -- only reachable if MotorPark samples produce a valid,
    // accepted calibration against a controller actually built for
    // MotorPark's own centerline.
    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    const gnss = tracked.gnssProviders.at(-1)!;
    feed(gnss, motorparkCleanRecognitionLap(MOTORPARK_CIRCUIT_PROFILE));
    await flushBootstrap();

    const state = latestFacadeState(composition) as {
      sessionState: string;
      calibrationResult: { accepted: boolean } | null;
    };
    expect(state.sessionState).toBe('calibrationReview');
    expect(state.calibrationResult?.accepted).toBe(true);
  });

  it("M1 fix (ticket CN-FIX2): two rapid selectCircuit calls apply IN ORDER -- the LAST call wins for both settings and the history store, even when the FIRST call's history refresh resolves slower", async () => {
    const composition = await bootFresh();
    const repo = seeded.repository as SqlSessionRepository;
    await repo.saveSession({
      sessionId: 'driver-1--m1-tmr',
      circuitId: TMR_CIRCUIT_PROFILE.circuitId,
      layoutId: TMR_CIRCUIT_PROFILE.layoutId,
      layoutVersion: TMR_CIRCUIT_PROFILE.layoutVersion,
      startedAtUtc: new Date().toISOString(),
      laps: [lap(1, 90_000)],
      userId: 'local-driver',
    });
    await repo.saveSession({
      sessionId: 'driver-1--m1-mp',
      circuitId: MOTORPARK_CIRCUIT_PROFILE.circuitId,
      layoutId: MOTORPARK_CIRCUIT_PROFILE.layoutId,
      layoutVersion: MOTORPARK_CIRCUIT_PROFILE.layoutVersion,
      startedAtUtc: new Date().toISOString(),
      laps: [lap(1, 90_000)],
      userId: 'local-driver',
    });

    const originalListSessions = repo.listSessions.bind(repo);
    let slowedOnce = false;
    repo.listSessions = async (userId: string, circuitId: string) => {
      if (!slowedOnce && circuitId === MOTORPARK_CIRCUIT_PROFILE.circuitId) {
        slowedOnce = true;
        // Simulate the FIRST call's (MotorPark) history refresh being slow.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return originalListSessions(userId, circuitId);
    };

    const first = composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    const second = composition.selectCircuit(TMR_CIRCUIT_PROFILE.circuitId);
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });

    // Without M1's serialization, the second (fast, TMR) call's history-store
    // swap would land BEFORE the first (slow, MotorPark) call's -- the
    // MotorPark store finishing last and clobbering the settings/history
    // agreement. With it, the LAST call (TMR) wins for both.
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(TMR_CIRCUIT_PROFILE.circuitId);
    const sessions = composition.sessionHistoryStore.listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['driver-1--m1-tmr']);
  });

  it('L1 fix (ticket CN-FIX2): an unknown persisted selectedCircuitId does not trigger a rebuild on every idle preflight -- the gate compares against the RESOLVED circuit, not the raw setting', async () => {
    const composition = await bootFresh();
    expect(tracked.gnssProviders.length).toBe(1);

    // Bypasses selectCircuit()'s own catalog validation -- simulates a
    // stale/corrupt persisted value from an older catalog build.
    composition.settingsStore.update({ selectedCircuitId: 'unknown-circuit-xyz' });

    composition.facade.startPreflight();
    await flushBootstrap();

    // Without the L1 fix, 'unknown-circuit-xyz' (raw) never equals
    // `productionControllerCircuitId` (TMR) -- the gate would rebuild (a
    // fresh GnssLocationProvider) on this call even though the controller
    // was ALREADY built for the resolved default.
    expect(tracked.gnssProviders.length).toBe(1);
  });
});

describe('composition.ts deleteAllStoredUserData spans every bundled circuit (ticket CN-W3)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('verifies EVERY bundled circuit is empty -- both circuitIds are queried, not just the selected one', async () => {
    const composition = await bootFresh();
    const repo = seeded.repository as SqlSessionRepository;
    const queriedCircuitIds: string[] = [];
    const originalListSessions = repo.listSessions.bind(repo);
    repo.listSessions = (userId: string, circuitId: string) => {
      queriedCircuitIds.push(circuitId);
      return originalListSessions(userId, circuitId);
    };

    const result = await composition.deleteAllStoredUserData();

    expect(result.ok).toBe(true);
    expect(queriedCircuitIds).toEqual(
      expect.arrayContaining([TMR_CIRCUIT_PROFILE.circuitId, MOTORPARK_CIRCUIT_PROFILE.circuitId]),
    );
  });

  it('fails aggregate ok when ANY single bundled circuit fails its verify-empty check', async () => {
    const composition = await bootFresh();
    const repo = seeded.repository as SqlSessionRepository;
    const originalListSessions = repo.listSessions.bind(repo);
    // Simulate MotorPark alone failing to come back empty (e.g. a straggler
    // row) -- TMR still verifies clean.
    repo.listSessions = async (userId: string, circuitId: string) => {
      if (circuitId === MOTORPARK_CIRCUIT_PROFILE.circuitId) {
        return [
          {
            sessionId: 'driver-1--straggler',
            circuitId,
            layoutId: MOTORPARK_CIRCUIT_PROFILE.layoutId,
            layoutVersion: MOTORPARK_CIRCUIT_PROFILE.layoutVersion,
            startedAtUtc: new Date().toISOString(),
            laps: [],
            userId,
          },
        ];
      }
      return originalListSessions(userId, circuitId);
    };

    const result = await composition.deleteAllStoredUserData();
    expect(result.ok).toBe(false);
  });

  it('M3 fix (ticket CN-FIX2): a REJECTED per-circuit delete does not abort the loop -- the remaining circuit is still attempted, aggregate ok:false, failed id named in errorText', async () => {
    const composition = await bootFresh();
    const repo = seeded.repository as SqlSessionRepository;
    const originalDeleteUserData = repo.deleteUserData.bind(repo);
    let callCount = 0;
    repo.deleteUserData = async (userId: string) => {
      callCount += 1;
      // First circuit in catalog order (TMR) rejects -- MotorPark must still
      // be attempted afterward.
      if (callCount === 1) throw new Error('simulated rejection');
      return originalDeleteUserData(userId);
    };

    const result = await composition.deleteAllStoredUserData();

    expect(callCount).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.failedCircuitIds).toEqual([TMR_CIRCUIT_PROFILE.circuitId]);
    expect(result.errorText).not.toBeNull();
    expect(result.errorText as string).toContain(TMR_CIRCUIT_PROFILE.circuitId);
  });

  it('M4 fix (ticket CN-FIX2): deleteAllStoredUserData clears a leftover active-session pointer (BOTH keys) too', async () => {
    const composition = await bootFresh();
    const db = seeded.db as SqlDatabase;
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'activeSessionId',
      'driver-1--leftover',
    ]);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'activeSessionCircuitId',
      TMR_CIRCUIT_PROFILE.circuitId,
    ]);

    const result = await composition.deleteAllStoredUserData();
    expect(result.ok).toBe(true);

    const idRows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      'activeSessionId',
    ]);
    const circuitRows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      'activeSessionCircuitId',
    ]);
    expect(idRows.length).toBe(0);
    expect(circuitRows.length).toBe(0);
  });
});

describe("composition.ts recovery's circuit resolution via listSessions (ticket CN-W3)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a recovered checkpoint whose session already has a COMPLETED row under a DIFFERENT circuit switches the selection to it before recovery is offered', async () => {
    const db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
    const repository = await SqlSessionRepository.create(db);
    const sessionId = 'driver-1--cross-circuit';

    // A completed MotorPark session under this sessionId already exists in
    // history (e.g. from bootstrap's history-store rebuild -- see
    // `resolveRecoveryCircuitId`'s doc comment for exactly which real
    // scenario this represents: a lingering active-session pointer whose
    // session actually finished under a DIFFERENT circuit than whatever is
    // currently selected).
    await repository.saveSession({
      sessionId,
      circuitId: MOTORPARK_CIRCUIT_PROFILE.circuitId,
      layoutId: MOTORPARK_CIRCUIT_PROFILE.layoutId,
      layoutVersion: MOTORPARK_CIRCUIT_PROFILE.layoutVersion,
      startedAtUtc: new Date().toISOString(),
      laps: [lap(1, 90_000)],
      userId: 'local-driver',
    });
    // But its checkpoint is still non-terminal (recoverable) and the
    // active-session pointer still points at it.
    const nonTerminalSnapshot: SessionMachineSnapshot = { state: 'armed', lapNumber: 0, context: {} };
    await repository.saveCheckpoint(sessionId, nonTerminalSnapshot, [lap(1, 90_000)]);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [ACTIVE_SESSION_KEY, sessionId]);

    seeded.db = db;
    seeded.repository = repository;
    tracked.gnssProviders.length = 0;

    vi.resetModules();
    const composition = await import('../../src/session/composition');
    await flushBootstrap();

    // Default selection is TMR -- the resolver must have switched it to
    // MotorPark BEFORE offering recovery.
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);

    let recovery: unknown = 'unset';
    composition.subscribeRecovery((r) => {
      recovery = r;
    });
    expect(recovery).toEqual({ sessionId, lapCount: 1, circuitId: MOTORPARK_CIRCUIT_PROFILE.circuitId });

    // History/PB now reflect MotorPark too (selectCircuit's own history rebuild).
    expect(composition.sessionHistoryStore.listSessions().some((s) => s.sessionId === sessionId)).toBe(true);
  });

  it('a checkpoint with NO corresponding sessions-table row (the ordinary in-progress/first-crash case) keeps the CURRENTLY SELECTED circuit and recovery is still offered -- see resolveRecoveryCircuitId\'s doc comment for why this is NOT treated as "discard"', async () => {
    // This is deliberately the SAME setup composition.recovery.test.ts's own
    // scenarios use (checkpoint only, no saveSession row) -- proving the
    // pre-existing TMR recovery behavior is unchanged by this ticket.
    const db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
    const repository = await SqlSessionRepository.create(db);
    const sessionId = 'driver-1--in-progress-no-row';
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [ACTIVE_SESSION_KEY, sessionId]);
    await repository.saveCheckpoint(sessionId, { state: 'timing', lapNumber: 2, context: {} }, [lap(1, 90_000)]);

    seeded.db = db;
    seeded.repository = repository;
    tracked.gnssProviders.length = 0;

    vi.resetModules();
    const composition = await import('../../src/session/composition');
    await flushBootstrap();

    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(TMR_CIRCUIT_PROFILE.circuitId);
    let recovery: unknown = 'unset';
    composition.subscribeRecovery((r) => {
      recovery = r;
    });
    expect(recovery).toEqual({ sessionId, lapCount: 2, circuitId: TMR_CIRCUIT_PROFILE.circuitId });
  });
});

const ACTIVE_SESSION_CIRCUIT_KEY = 'activeSessionCircuitId';

describe('composition.ts M4 fix (ticket CN-FIX2) -- activeSessionCircuitId recovery (contracts.md recovery amendment)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a first-crash checkpoint (NO sessions-table row) resolves its circuit from the persisted activeSessionCircuitId -- even while a DIFFERENT circuit is currently selected -- and resumeRecovery() reasserts BOTH keys', async () => {
    const db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
    const repository = await SqlSessionRepository.create(db);
    const sessionId = 'driver-1--crash-motorpark';

    // Selection currently reads the default (TMR) -- unrelated to the
    // crashed session; no `sessions` row exists yet (a genuine first crash,
    // by construction -- see `resolveRecoveryCircuitId`'s own doc comment
    // for why the OLD listSessions-scan mechanism alone could never resolve
    // this case).
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [ACTIVE_SESSION_KEY, sessionId]);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      ACTIVE_SESSION_CIRCUIT_KEY,
      MOTORPARK_CIRCUIT_PROFILE.circuitId,
    ]);
    await repository.saveCheckpoint(sessionId, { state: 'armed', lapNumber: 0, context: {} }, [lap(1, 90_000)]);

    seeded.db = db;
    seeded.repository = repository;
    tracked.gnssProviders.length = 0;

    vi.resetModules();
    const composition = await import('../../src/session/composition');
    await flushBootstrap();

    // Selection switched to MotorPark BEFORE recovery was offered -- resolved
    // from the persisted activeSessionCircuitId, not the (necessarily empty,
    // for a first crash) listSessions scan.
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);

    let recovery: unknown = 'unset';
    composition.subscribeRecovery((r) => {
      recovery = r;
    });
    expect(recovery).toEqual({ sessionId, lapCount: 1, circuitId: MOTORPARK_CIRCUIT_PROFILE.circuitId });

    const resumed = await composition.resumeRecovery();
    expect(resumed).toBe(true);

    // Both keys reasserted after resume -- read them back directly.
    const idRows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      ACTIVE_SESSION_KEY,
    ]);
    const circuitRows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      ACTIVE_SESSION_CIRCUIT_KEY,
    ]);
    expect(idRows[0]?.value).toBe(sessionId);
    expect(circuitRows[0]?.value).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);
  });

  it('a persisted activeSessionCircuitId naming a circuit OUTSIDE the bundled catalog discards the checkpoint (with a warning) instead of offering an unresolvable recovery', async () => {
    const db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
    const repository = await SqlSessionRepository.create(db);
    const sessionId = 'driver-1--crash-unbundled';
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [ACTIVE_SESSION_KEY, sessionId]);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      ACTIVE_SESSION_CIRCUIT_KEY,
      'not-a-real-circuit',
    ]);
    await repository.saveCheckpoint(sessionId, { state: 'armed', lapNumber: 0, context: {} }, [lap(1, 90_000)]);

    seeded.db = db;
    seeded.repository = repository;
    tracked.gnssProviders.length = 0;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const composition = await import('../../src/session/composition');
    await flushBootstrap();

    let recovery: unknown = 'unset';
    composition.subscribeRecovery((r) => {
      recovery = r;
    });
    expect(recovery).toBeNull();
    expect(warn).toHaveBeenCalled();

    const idRows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      ACTIVE_SESSION_KEY,
    ]);
    const circuitRows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      ACTIVE_SESSION_CIRCUIT_KEY,
    ]);
    expect(idRows.length).toBe(0);
    expect(circuitRows.length).toBe(0);
    warn.mockRestore();
  });

  it('discardRecovery() clears BOTH keys together', async () => {
    const db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
    const repository = await SqlSessionRepository.create(db);
    const sessionId = 'driver-1--discard-both';
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [ACTIVE_SESSION_KEY, sessionId]);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      ACTIVE_SESSION_CIRCUIT_KEY,
      TMR_CIRCUIT_PROFILE.circuitId,
    ]);
    await repository.saveCheckpoint(sessionId, { state: 'armed', lapNumber: 0, context: {} }, []);

    seeded.db = db;
    seeded.repository = repository;
    tracked.gnssProviders.length = 0;

    vi.resetModules();
    const composition = await import('../../src/session/composition');
    await flushBootstrap();

    await composition.discardRecovery();

    const idRows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      ACTIVE_SESSION_KEY,
    ]);
    const circuitRows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      ACTIVE_SESSION_CIRCUIT_KEY,
    ]);
    expect(idRows.length).toBe(0);
    expect(circuitRows.length).toBe(0);
  });

  it('a normal session start persists BOTH keys transactionally, matching the circuit it actually started on -- cleared together on session end', async () => {
    const composition = await bootFresh();
    const db = seeded.db as SqlDatabase;
    const gnss = tracked.gnssProviders[0]!;

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 700_101));
    await flushBootstrap();
    composition.facade.acceptCalibration();
    await flushBootstrap();
    composition.facade.arm();
    await flushBootstrap();
    feed(gnss, multiLapSession(TMR_CIRCUIT_PROFILE, 1, 700_102));
    await flushBootstrap();

    const idDuring = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      ACTIVE_SESSION_KEY,
    ]);
    const circuitDuring = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      ACTIVE_SESSION_CIRCUIT_KEY,
    ]);
    expect(idDuring.length).toBe(1);
    expect(circuitDuring[0]?.value).toBe(TMR_CIRCUIT_PROFILE.circuitId);

    composition.facade.endSession();
    await flushBootstrap();

    const idAfter = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      ACTIVE_SESSION_KEY,
    ]);
    const circuitAfter = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      ACTIVE_SESSION_CIRCUIT_KEY,
    ]);
    expect(idAfter.length).toBe(0);
    expect(circuitAfter.length).toBe(0);
  });
});
