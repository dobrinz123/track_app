import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionController,
  SqlSessionRepository,
  cleanRecognitionLap,
  multiLapSession,
  type LocationSample,
  type SqlDatabase,
} from '@circuit/core';

import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { bundled, TMR_CIRCUIT_ID } from '../support/analysisHarness';
import { FakeClock, FakeLocationProvider, feedSamples } from '../support/coreTestDoubles';

/**
 * Ticket D1 / D2 (flow review F1, F2, F3) -- the two journeys that ended with
 * the app unusable or the driver's laps gone, driven end to end through the
 * REAL composition layer.
 *
 * D1: start a session, cancel the Learn lap, back out of the calibration
 *     flow, tap a circuit. Before the fix the controller sat in
 *     `awaitingCalibration` forever, `selectCircuit()` refused, and the
 *     screen logged the refusal and showed nothing -- every row on the app's
 *     initial route inert, with Detail/Preflight/History/Settings all behind
 *     it. Force-quit was the only exit.
 *
 * D2: force-quit mid-session, relaunch, tap Discard on the recovery banner
 *     that has just told you it recovered N laps. Before the fix the laps
 *     lived only in the checkpoint Discard overwrites, so History afterwards
 *     said "0 laps" for a drive that had four, with no warning.
 */

const ACTIVE_SESSION_KEY = 'activeSessionId';
const ACTIVE_SESSION_CIRCUIT_KEY = 'activeSessionCircuitId';

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

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'stranded-journeys-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubGnssLocationProvider {
    listeners = new Set<(s: LocationSample) => void>();
    constructor() {
      tracked.gnssProviders.push(this);
    }
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
      return { sampleIntervalHistogramMs: [] };
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
    ReplayLocationProvider: class {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      subscribe(): () => void {
        return () => {};
      }
    },
    startLifecycleListener: () => {},
  };
});

vi.mock('../../src/persistence/expoSqlDatabase', () => ({
  openAppDatabase: async () => ({ db: seeded.db, repository: seeded.repository }),
}));

import { TMR_CIRCUIT_PROFILE } from '../../src/session/tmrProfile';
import { MOTORPARK_CIRCUIT_PROFILE } from '../../src/session/circuitCatalog';

function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function boot(
  db: SqlDatabase,
  repository: SqlSessionRepository,
): Promise<typeof import('../../src/session/composition')> {
  seeded.db = db;
  seeded.repository = repository;
  tracked.gnssProviders.length = 0;
  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

async function bootFresh(): Promise<typeof import('../../src/session/composition')> {
  const db = await createSqlJsDatabase();
  await migrateTelemetrySchema(db);
  const repository = await SqlSessionRepository.create(db);
  return boot(db, repository);
}

function provider(): StubLocationProviderInstance {
  const instance = tracked.gnssProviders[tracked.gnssProviders.length - 1];
  if (instance === undefined) throw new Error('no stub GNSS provider was constructed');
  return instance;
}

function facadeState(
  composition: typeof import('../../src/session/composition'),
): { sessionState: string } {
  let latest: { sessionState: string } | undefined;
  const unsubscribe = composition.facade.subscribe((s) => {
    latest = s as unknown as { sessionState: string };
  });
  unsubscribe();
  return latest!;
}

// ---------------------------------------------------------------------------
// D1 -- the cancelled Learn lap
// ---------------------------------------------------------------------------

describe('D1 -- cancelling the Learn lap never strands the app (flow review F1)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('REPRODUCTION: a cancelled calibration leaves the controller in a state selectCircuit refuses', async () => {
    const composition = await bootFresh();

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    composition.facade.rejectCalibration();
    await flushBootstrap();

    // The state the reducer parks a rejected calibration in.
    expect(facadeState(composition).sessionState).toBe('awaitingCalibration');
    // ...and every circuit row on the app's initial route is inert because of
    // it. This is the bug, stated: the refusal is real and correct, and
    // before this ticket NOTHING could clear it.
    const refused = await composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(refused).toEqual({ ok: false, reason: 'SESSION_ACTIVE' });
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(
      TMR_CIRCUIT_PROFILE.circuitId,
    );

    // The refusal is now EXPLICABLE -- the screen can say which kind it is
    // and offer the matching way out, instead of console.warn-ing it.
    expect(composition.pendingSessionStage()).toBe('setup');
  });

  it('abandonPendingSession() ends the stranded setup session and leaves an IDLE controller that can select and start again', async () => {
    const composition = await bootFresh();

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    composition.facade.rejectCalibration();
    await flushBootstrap();

    const outcome = await composition.abandonPendingSession();
    await flushBootstrap();
    expect(outcome).toEqual({ ok: true, abandoned: true });

    // Rebuilt, not merely terminal: "Start Calibration" on a screen still in
    // the stack must work, and that never goes through the preflight gate.
    expect(facadeState(composition).sessionState).toBe('idle');
    expect(composition.pendingSessionStage()).toBe('none');

    // The journey that was impossible before: pick the other circuit.
    const selected = await composition.selectCircuit(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(selected).toEqual({ ok: true });
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(
      MOTORPARK_CIRCUIT_PROFILE.circuitId,
    );

    // And a second session really starts on it.
    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    expect(facadeState(composition).sessionState).toBe('calibrating');
  });

  it('leaves NO active-session pointer behind, so the next launch offers no phantom recovery', async () => {
    const db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
    const repository = await SqlSessionRepository.create(db);
    const composition = await boot(db, repository);

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    const pointerWhileCalibrating = await db.getAllAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      [ACTIVE_SESSION_KEY],
    );
    expect(pointerWhileCalibrating).toHaveLength(1);

    composition.facade.rejectCalibration();
    await flushBootstrap();
    await composition.abandonPendingSession();
    await flushBootstrap();

    const pointerAfter = await db.getAllAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      [ACTIVE_SESSION_KEY],
    );
    expect(pointerAfter).toHaveLength(0);

    // Relaunch: no recovery banner for a session that never drove a lap.
    const relaunched = await boot(db, repository);
    let offered: unknown = 'not-called';
    const unsubscribe = relaunched.subscribeRecovery((r) => {
      offered = r;
    });
    unsubscribe();
    expect(offered).toBeNull();
  });

  it('a Learn lap that is still RUNNING reports its own stage -- the calibration screen owns it, not this one', async () => {
    const composition = await bootFresh();

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();

    expect(facadeState(composition).sessionState).toBe('calibrating');
    expect(composition.pendingSessionStage()).toBe('calibrating');
    // Never torn down from here: Cancel and the escape hatch live on
    // `ActiveCalibrationScreen`, which is where the refusal sends the driver.
    expect(await composition.abandonPendingSession()).toEqual({ ok: false, reason: 'driving' });
    expect(facadeState(composition).sessionState).toBe('calibrating');
  });

  it('REFUSES to abandon a session that is genuinely being driven -- only the dashboard may end that', async () => {
    const composition = await bootFresh();

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    const gnss = provider();
    for (const sample of cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 500_001)) gnss.push(sample);
    await flushBootstrap();
    composition.facade.acceptCalibration();
    await flushBootstrap();
    composition.facade.arm();
    await flushBootstrap();
    for (const sample of multiLapSession(TMR_CIRCUIT_PROFILE, 1, 500_002)) gnss.push(sample);
    await flushBootstrap();

    expect(composition.pendingSessionStage()).toBe('driving');
    expect(await composition.abandonPendingSession()).toEqual({ ok: false, reason: 'driving' });
    expect(['outLap', 'timing', 'inPit', 'paused']).toContain(
      facadeState(composition).sessionState,
    );
    // Still driving -- nothing was torn down under the driver.
    expect(['outLap', 'timing', 'inPit', 'paused']).toContain(
      facadeState(composition).sessionState,
    );
  });
});

// ---------------------------------------------------------------------------
// D2 -- the crash-recovery banner
// ---------------------------------------------------------------------------

/**
 * Drives a real controller through calibration and `lapCount` laps and then
 * simply STOPS -- no `endSession()`, exactly as a force-quit leaves things.
 * The active-session keys are written the way `onSessionStarted` writes them.
 */
async function crashAfterLaps(lapCount: number): Promise<{
  db: SqlDatabase;
  repository: SqlSessionRepository;
  sessionId: string;
}> {
  const circuit = bundled(TMR_CIRCUIT_ID);
  const db = await createSqlJsDatabase();
  await migrateTelemetrySchema(db);
  const repository = await SqlSessionRepository.create(db);

  const clock = new FakeClock(1_000_000);
  const locationProvider = new FakeLocationProvider();
  const controller = new SessionController({
    runtimeProfile: circuit.runtime,
    circuitProfile: circuit.profile,
    locationProvider,
    clock,
    repository,
    userId: 'local-driver',
    appVersion: 'd2-crash-test',
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

  feedSamples(clock, locationProvider, cleanRecognitionLap(circuit.profile, 600_001));
  controller.acceptCalibration();
  await controller.flush();
  controller.arm();
  feedSamples(clock, locationProvider, multiLapSession(circuit.profile, lapCount, 600_002));
  await controller.flush();
  // ... and the process dies here.

  return { db, repository, sessionId };
}

describe('D2 -- Discard no longer destroys the laps the banner counted (flow review F2/F3)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('the recovery banner counts N laps, and after Discard History still shows N laps', async () => {
    const { db, repository, sessionId } = await crashAfterLaps(3);
    const checkpointBefore = await repository.loadCheckpoint(sessionId);
    const lapsInCheckpoint = checkpointBefore!.laps.length;
    expect(lapsInCheckpoint).toBeGreaterThan(0);

    const composition = await boot(db, repository);
    let offered: { lapCount: number } | null = null;
    composition.subscribeRecovery((r) => {
      offered = r as { lapCount: number } | null;
    })();
    expect(offered).not.toBeNull();
    // The banner counts the interrupted lap too; what matters is that it
    // quantifies laps the driver is about to be offered a Discard for.
    expect(offered!.lapCount).toBeGreaterThanOrEqual(lapsInCheckpoint);

    await composition.discardRecovery();
    await flushBootstrap();

    // THE ASSERTION. Before the fix this was `0 laps · best —`.
    const stored = composition.sessionHistoryStore
      .listSessions()
      .find((s) => s.sessionId === sessionId);
    expect(stored).toBeDefined();
    expect(stored!.laps).toHaveLength(lapsInCheckpoint);

    // And it is never offered for recovery again.
    const relaunched = await boot(db, repository);
    let reoffered: unknown = 'not-called';
    relaunched.subscribeRecovery((r) => {
      reoffered = r;
    })();
    expect(reoffered).toBeNull();
  });

  it('starting a NEW session instead of resuming does not orphan the crashed one\'s laps either (F3)', async () => {
    const { db, repository, sessionId } = await crashAfterLaps(2);
    const lapsInCheckpoint = (await repository.loadCheckpoint(sessionId))!.laps.length;

    const composition = await boot(db, repository);
    // The driver never touches the banner -- they just start driving again.
    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    composition.facade.rejectCalibration();
    await flushBootstrap();
    await composition.abandonPendingSession();
    await flushBootstrap();

    const stored = composition.sessionHistoryStore
      .listSessions()
      .find((s) => s.sessionId === sessionId);
    expect(stored).toBeDefined();
    expect(stored!.laps).toHaveLength(lapsInCheckpoint);
  });

  it('a discarded checkpoint written by an OLDER build (row still at zero laps) has its laps copied onto the row', async () => {
    const { db, repository, sessionId } = await crashAfterLaps(2);
    const checkpoint = (await repository.loadCheckpoint(sessionId))!;
    expect(checkpoint.laps.length).toBeGreaterThan(0);

    // Re-create the pre-ticket state exactly: the row exists (recording start
    // wrote it) but carries no laps, because only the checkpoint ever did.
    const row = (await repository.listSessions('local-driver', TMR_CIRCUIT_PROFILE.circuitId)).find(
      (s) => s.sessionId === sessionId,
    )!;
    await repository.saveSession({ ...row, laps: [] });

    const composition = await boot(db, repository);
    await composition.discardRecovery();
    await flushBootstrap();

    const stored = composition.sessionHistoryStore
      .listSessions()
      .find((s) => s.sessionId === sessionId);
    expect(stored!.laps).toHaveLength(checkpoint.laps.length);
  });
});
