import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionController, SqlSessionRepository, type SqlDatabase } from '@circuit/core';

import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { bundled, TMR_CIRCUIT_ID } from '../support/analysisHarness';
import { FakeClock, FakeLocationProvider, feedSamples } from '../support/coreTestDoubles';

/**
 * Ticket P10A H2 (binding) -- END TO END, THROUGH THE REAL BOOTSTRAP.
 *
 * The P9 reviewer's finding was not that the trace was missing. It was that
 * the trace was on disk and UNREACHABLE: a session that never completed a
 * lap had no session row and no checkpoint, so on the next launch bootstrap
 * found an active-session pointer it could not resolve, cleared it, and the
 * drive disappeared from recovery, from history and from the raw export at
 * once. That is the Monday scenario -- a first visit to a circuit whose gate
 * geometry has never been validated, where no crossing is ever detected.
 *
 * So this test crashes a real `SessionController` mid-calibration over a
 * real SQLite (sql.js) database, then boots the real `composition.ts`
 * against that same database and asks the three questions the owner would
 * ask: is it offered back to me, is it in my history, and can I get it off
 * the phone.
 */

const ACTIVE_SESSION_KEY = 'activeSessionId';
const ACTIVE_SESSION_CIRCUIT_KEY = 'activeSessionCircuitId';

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

function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Drives a real controller through calibration and then simply STOPS --
 * `endSession()` is never called, exactly as a foreground process death
 * leaves things. The active-session pointer is written the way
 * `composition.ts`'s own `onSessionStarted` writes it.
 */
async function crashDuringCalibration(
  fixCount: number,
  options: { escapeCalibration?: boolean } = {},
): Promise<{ db: SqlDatabase; repository: SqlSessionRepository; sessionId: string; fedTMono: number[] }> {
  const circuit = bundled(TMR_CIRCUIT_ID);
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);

  const clock = new FakeClock(1_000_000);
  const provider = new FakeLocationProvider();
  const controller = new SessionController({
    runtimeProfile: circuit.runtime,
    circuitProfile: circuit.profile,
    locationProvider: provider,
    clock,
    repository,
    userId: 'local-driver',
    appVersion: 'p10a-crash-test',
    algorithmVersion: 1,
    restartProvider: () => undefined,
  });

  await controller.start('calibration');
  const sessionId = controller.diagnostics().sessionId!;
  await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
    ACTIVE_SESSION_KEY,
    sessionId,
  ]);
  await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
    ACTIVE_SESSION_CIRCUIT_KEY,
    circuit.profile.circuitId,
  ]);

  const point = circuit.profile.centerline[0]!;
  const samples = Array.from({ length: fixCount }, (_, index) => ({
    lat: point.lat,
    lon: point.lon,
    tMono: index * 1_000,
    accuracyM: 3,
    source: 'replay' as const,
  }));
  feedSamples(clock, provider, samples);
  if (options.escapeCalibration === true) {
    expect(controller.proceedWithoutValidatedCalibration()).toBe('armed-unvalidated');
  }
  await controller.flush();
  // ... and the process dies here. No endSession(), no final checkpoint.

  return { db, repository, sessionId, fedTMono: samples.map((s) => s.tMono) };
}

async function boot(
  db: SqlDatabase,
  repository: SqlSessionRepository,
): Promise<typeof import('../../src/session/composition')> {
  seeded.db = db;
  seeded.repository = repository;
  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

describe('P10A H2 -- a crashed zero-lap session survives the next launch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is offered back for recovery, listed in history, and exports its whole drive', async () => {
    const { db, repository, sessionId, fedTMono } = await crashDuringCalibration(10);

    // WAS (reviewer): checkpoint null, history 0 -- so bootstrap cleared the
    // pointer and the ten persisted fixes were unreachable.
    const composition = await boot(db, repository);

    let recovery: unknown = 'unset';
    composition.subscribeRecovery((r) => {
      recovery = r;
    });
    expect(recovery).toEqual({ sessionId, lapCount: 0, circuitId: TMR_CIRCUIT_ID });

    // The active-session pointer was NOT cleared.
    const pointer = await db.getAllAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      [ACTIVE_SESSION_KEY],
    );
    expect(pointer[0]?.value).toBe(sessionId);

    // It is in history, with no laps -- which is what makes the history
    // screen's export button reach it.
    const listed = composition.sessionHistoryStore.listSessions();
    expect(listed.map((s) => s.sessionId)).toContain(sessionId);
    expect(composition.sessionHistoryStore.getSession(sessionId)!.laps).toHaveLength(0);

    // And the raw export finds the drive.
    const doc = await composition.buildRawSessionExport(sessionId, '2026-09-21T10:00:00.000Z');
    expect(typeof doc).not.toBe('string');
    if (typeof doc === 'string') throw new Error(doc);
    expect(doc.session.sessionId).toBe(sessionId);
    expect(doc.gnss.totalSampleCount).toBe(10);
    expect(doc.gnss.unclaimed.map((s) => s.tMono)).toEqual(fedTMono);
    // Nothing concluded the calibration, so the export says UNKNOWN -- never
    // presents the session as calibrated.
    expect(doc.session.calibrationStatus).toBe('unknown');
    expect(doc.session.traceIncomplete).toBe(false);
  });

  it('a session driven past a REJECTED calibration still says so after the crash (H5/H6)', async () => {
    const { db, repository, sessionId } = await crashDuringCalibration(10, { escapeCalibration: true });
    const composition = await boot(db, repository);

    // Read back from the session's OWN durable record, not from the side log
    // -- nothing wrote the log in this simulated crash.
    expect(composition.resolveSessionCalibrationStatus(sessionId)).toBe('unvalidated');
    expect(composition.isSessionMatchingUnvalidated(sessionId)).toBe(true);

    const doc = await composition.buildRawSessionExport(sessionId, '2026-09-21T10:00:00.000Z');
    if (typeof doc === 'string') throw new Error(doc);
    expect(doc.session.calibrationStatus).toBe('unvalidated');
    expect(doc.session.matchingUnvalidated).toBe(true);

    // And resuming it does not launder the label (the reviewer's H5 chain,
    // through the real recovery path this time).
    expect(await composition.resumeRecovery()).toBe(true);
    let live: { matchingUnvalidated: boolean; calibrationStatus: string } | undefined;
    const unsubscribe = composition.facade.subscribe((s) => {
      live = s;
    });
    unsubscribe();
    expect(live?.matchingUnvalidated).toBe(true); // WAS: false
    expect(live?.calibrationStatus).toBe('unvalidated');
  });
});

describe('P10A H7 -- the Results screen precedence rule', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('`unvalidated` from either side wins, `validated` needs both, everything else is unknown', async () => {
    const { db, repository, sessionId } = await crashDuringCalibration(10, { escapeCalibration: true });
    const composition = await boot(db, repository);

    // The stored record says `unvalidated`. A controller that has since been
    // rebuilt (and so reports `unknown`) must NOT downgrade the warning.
    expect(composition.resolveResultsCalibrationStatus('unknown', sessionId)).toBe('unvalidated');
    expect(composition.resolveResultsCalibrationStatus('validated', sessionId)).toBe('unvalidated');
    // A live escape that has not reached disk yet is still shown.
    expect(composition.resolveResultsCalibrationStatus('unvalidated', null)).toBe('unvalidated');
    // No session at all: unknown, never validated.
    expect(composition.resolveResultsCalibrationStatus('validated', null)).toBe('unknown');
    expect(composition.resolveResultsCalibrationStatus('unknown', 'no-such-session')).toBe('unknown');
  });

  it('a genuinely validated session reads `validated` from both sides', async () => {
    const circuit = bundled(TMR_CIRCUIT_ID);
    const db = await createSqlJsDatabase();
    const repository = await SqlSessionRepository.create(db);
    await repository.saveSession({
      sessionId: 'local-driver--ok',
      circuitId: circuit.profile.circuitId,
      layoutId: circuit.profile.layoutId,
      layoutVersion: circuit.profile.layoutVersion,
      startedAtUtc: '2026-09-21T09:00:00.000Z',
      laps: [],
      userId: 'local-driver',
      calibrationStatus: 'validated',
    });
    const composition = await boot(db, repository);

    expect(composition.resolveSessionCalibrationStatus('local-driver--ok')).toBe('validated');
    expect(composition.resolveResultsCalibrationStatus('validated', 'local-driver--ok')).toBe(
      'validated',
    );
  });
});
