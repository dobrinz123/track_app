import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SqlSessionRepository,
  cleanRecognitionLap,
  motorparkCleanRecognitionLap,
  multiLapSession,
  type LapRecord,
  type LocationSample,
  type SessionMachineSnapshot,
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

  it('a circuit switch mid-session does NOT rebuild until the session ends (never during outLap/timing/inPit/paused)', async () => {
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

    const stateBeforeSwitch = latestFacadeState(composition) as { sessionState: string };
    expect(['outLap', 'timing', 'armed']).toContain(stateBeforeSwitch.sessionState);

    // Selection change mid-session: must not tear down the LIVE TMR controller.
    await composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    await flushBootstrap();

    // The SAME (still TMR-configured) controller keeps driving this session
    // to completion -- if a rebuild had happened here, these TMR samples fed
    // into a fresh, freshly-idle MotorPark controller would never produce a
    // completed, valid lap.
    feed(gnss, multiLapSession(TMR_CIRCUIT_PROFILE, 1, 700_002));
    await flushBootstrap();
    composition.facade.endSession();
    await flushBootstrap();

    const finalState = latestFacadeState(composition) as { sessionState: string; laps: unknown[] };
    expect(finalState.sessionState).toBe('sessionComplete');
    expect(finalState.laps.length).toBeGreaterThan(0);
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
    expect(recovery).toEqual({ sessionId, lapCount: 1 });

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
    expect(recovery).toEqual({ sessionId, lapCount: 2 });
  });
});
