import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, type LocationSample, type SqlDatabase } from '@circuit/core';

import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { rectangleLoopSamples } from '../support/testLoopTraces';

/**
 * Ticket P5d-FIX1 H1/H3 (Codex P5d-REV1 HIGH 1 and 3) -- the learn phase IS a
 * session.
 *
 * H1: the recording pipeline runs from the moment learning starts, and the
 *     instant lap 1 closes the session rolls into timing WITHOUT stopping a
 *     single provider: the learning lap is recorded, and the driving that
 *     continues is timed against the track it just defined.
 * H3: nothing tells the driver a track was learned until it has actually been
 *     persisted, registered AND selected -- a failure is an error with a
 *     retry, never a session quietly running on the previously selected
 *     circuit.
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
  running: boolean;
  push(sample: LocationSample): void;
}

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'test-loop-handover-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubGnssLocationProvider {
    listeners = new Set<(s: LocationSample) => void>();
    startCount = 0;
    stopCount = 0;
    running = false;
    constructor() {
      tracked.gnssProviders.push(this);
    }
    async start(): Promise<void> {
      this.startCount += 1;
      this.running = true;
    }
    async stop(): Promise<void> {
      this.stopCount += 1;
      this.running = false;
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

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function boot(db: SqlDatabase): Promise<typeof import('../../src/session/composition')> {
  seeded.db = db;
  seeded.repository = await SqlSessionRepository.create(db);
  tracked.gnssProviders.length = 0;
  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await settle();
  return composition;
}

function provider(): StubLocationProviderInstance {
  const instance = tracked.gnssProviders[tracked.gnssProviders.length - 1];
  if (instance === undefined) throw new Error('no stub GNSS provider was constructed');
  return instance;
}

/** Three laps of the loop: lap 1 teaches the track, the rest is driving. */
const THREE_LAPS = rectangleLoopSamples({ laps: 3 });
/** Where lap 1 ends: the closure fires a few fixes past the start point. */
const LAP_SAMPLES = Math.round(THREE_LAPS.length / 3);

describe('Test Loop handover (P5d-FIX1 H1, H3)', () => {
  let db: SqlDatabase;

  beforeEach(async () => {
    db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
  });

  it('rolls straight into a timed session at closure, without stopping the provider', async () => {
    const composition = await boot(db);
    const started = await composition.startTestLoop();
    expect(started.ok).toBe(true);
    const gnss = provider();
    const stopsBefore = gnss.stopCount;

    for (const sample of THREE_LAPS) {
      gnss.push(sample);
      // The handover happens inside a sample callback; let its awaits settle
      // exactly as they would between two real fixes.
      await settle();
    }
    await settle();

    const snapshot = composition.testLoopSnapshot();
    expect(snapshot.phase).toBe('learned');
    expect(snapshot.learned).not.toBeNull();

    // H1: no provider was stopped anywhere in the handover, and the watcher is
    // still running -- the driver never lost a fix.
    expect(gnss.stopCount).toBe(stopsBefore);
    expect(gnss.running).toBe(true);

    // ...and the session is live, driving against the track it just learned.
    let sessionState = 'idle';
    composition.facade.subscribe((state) => {
      sessionState = state.sessionState;
    })();
    expect(['outLap', 'timing']).toContain(sessionState);
  });

  it('records the learning lap and times the laps that follow', async () => {
    const composition = await boot(db);
    await composition.startTestLoop();
    const gnss = provider();

    for (const sample of THREE_LAPS) {
      gnss.push(sample);
      await settle();
    }
    await settle();

    let sessionState = 'idle';
    let lapCount = 0;
    const unsubscribe = composition.facade.subscribe((state) => {
      sessionState = state.sessionState;
      lapCount = state.laps.length;
    });
    unsubscribe();

    // The session is driving (out-lap or timing), not idle and not complete.
    expect(['outLap', 'timing']).toContain(sessionState);
    // Two more laps of driving after the learning lap produce a timed lap.
    expect(lapCount).toBeGreaterThanOrEqual(1);

    // The learning lap itself is STORED: lap 0 is its trace.
    const rows = await db.getAllAsync<{ lapNumber: number; payload: string }>(
      'SELECT lapNumber, payload FROM telemetry ORDER BY lapNumber',
    );
    expect(rows.map((row) => row.lapNumber)).toContain(0);

    // P5d-FIX2 N1: lap 0 holds ONE learning lap, not the lap and a half the
    // old late-closure behaviour swallowed into it.
    const outLap = rows.find((row) => row.lapNumber === 0);
    const storedSamples = JSON.parse(outLap!.payload) as unknown[];
    expect(storedSamples.length).toBeLessThanOrEqual(LAP_SAMPLES + 4);
    // ...and a TIMED lap exists beside it.
    expect(rows.some((row) => row.lapNumber >= 1)).toBe(true);
  });

  it('hands the GNSS watcher back after the handover, so later rebuilds clean up normally (N5)', async () => {
    const composition = await boot(db);
    await composition.startTestLoop();
    const gnss = provider();
    for (const sample of THREE_LAPS) {
      gnss.push(sample);
      await settle();
    }
    await settle();

    expect(composition.testLoopSnapshot().phase).toBe('learned');
    expect(composition.testLoopDiagnostics().providerAttached).toBe(false);
    expect(composition.testLoopDiagnostics().handoverActive).toBe(false);
  });

  it('tears the providers down when a learn phase ends without a track (N5, N6)', async () => {
    const composition = await boot(db);
    await composition.startTestLoop();
    const gnss = provider();
    for (const sample of THREE_LAPS.slice(0, 12)) gnss.push(sample);

    const stopped = await composition.stopTestLoop();
    await settle();
    expect(stopped.phase).toBe('failed');
    expect(composition.testLoopDiagnostics().providerAttached).toBe(false);
    expect(gnss.running).toBe(false);
    // P5d-FIX3 F11: `stopTestLoop()` and the auto-teardown that the same
    // failure triggers are ONE serialized teardown -- the global provider is
    // shut down exactly once, never twice from two racing paths.
    expect(gnss.stopCount).toBe(1);
  });

  it('serializes concurrent teardowns: the provider is stopped exactly once (P5d-FIX3 F11)', async () => {
    const composition = await boot(db);
    await composition.startTestLoop();
    const gnss = provider();
    for (const sample of THREE_LAPS.slice(0, 12)) gnss.push(sample);

    // Both paths at once: two stop requests, plus the auto-teardown that the
    // resulting failed phase fires on its own.
    const [first, second] = await Promise.all([
      composition.stopTestLoop(),
      composition.stopTestLoop(),
    ]);
    await settle();
    await settle();

    expect(first.phase).toBe('failed');
    expect(second.phase).toBe('failed');
    expect(gnss.stopCount).toBe(1);
    expect(composition.testLoopDiagnostics().providerAttached).toBe(false);
  });

  it('resumes a half-finished handover on retry instead of repeating it (N2)', async () => {
    const composition = await boot(db);
    await composition.startTestLoop();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Break the LAST step (storing the out-lap trace) so the handover fails
    // after the circuit was stored, selected and the session started.
    await db.execAsync('DROP TABLE telemetry');
    const gnss = provider();
    for (const sample of THREE_LAPS) {
      gnss.push(sample);
      await settle();
    }
    await settle();

    expect(composition.testLoopSnapshot().phase).toBe('error');
    const circuitsAfterFailure = composition.listLearnedCircuits().length;
    expect(circuitsAfterFailure).toBe(1);
    const sessionsAfterFailure = await db.getAllAsync<{ sessionId: string }>(
      'SELECT sessionId FROM sessions',
    );

    // Repair the database and retry: the steps that already succeeded must not
    // run again -- no second circuit, no second session.
    await db.execAsync(
      'CREATE TABLE IF NOT EXISTS telemetry (sessionId TEXT NOT NULL, lapNumber INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (sessionId, lapNumber))',
    );
    composition.retryTestLoopAdoption();
    await settle();
    await settle();

    expect(composition.testLoopSnapshot().phase).toBe('learned');
    expect(composition.listLearnedCircuits()).toHaveLength(circuitsAfterFailure);
    const sessionsAfterRetry = await db.getAllAsync<{ sessionId: string }>(
      'SELECT sessionId FROM sessions',
    );
    expect(sessionsAfterRetry.length).toBe(sessionsAfterFailure.length);
    const outLap = await db.getAllAsync<{ lapNumber: number }>(
      'SELECT lapNumber FROM telemetry WHERE lapNumber = 0',
    );
    expect(outLap).toHaveLength(1);
    warn.mockRestore();
  });

  it('reports an error (not a learned track) when the learned circuit cannot be kept', async () => {
    const composition = await boot(db);
    await composition.startTestLoop();
    // Break the store underneath the adoption: persistence must fail loudly.
    await db.execAsync('DROP TABLE learned_circuits');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gnss = provider();

    for (const sample of THREE_LAPS) {
      gnss.push(sample);
      await settle();
    }
    await settle();

    const snapshot = composition.testLoopSnapshot();
    expect(snapshot.phase).toBe('error');
    expect(snapshot.learned).toBeNull();
    expect(snapshot.adoptError).not.toBeNull();
    // H3: the selection was NOT changed to something that does not exist.
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(
      'transilvania-motor-ring',
    );
    warn.mockRestore();
  });
});

/**
 * Ticket P5d-FIX3 F10 (Codex P5d-REV3 HIGH): the adoption journal outlives the
 * process. A kill in the middle of keeping a learned track must leave a state
 * the next launch can either finish or undo -- never an orphan circuit, an
 * orphan session, or a silent nothing.
 */
describe('interrupted adoption is repaired at the next launch (P5d-FIX3 F10)', () => {
  let db: SqlDatabase;

  beforeEach(async () => {
    db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
  });

  async function journalRow(): Promise<string | null> {
    const rows = await db.getAllAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      ['testLoopAdoption'],
    );
    return rows[0]?.value ?? null;
  }

  it('writes a journal while adopting, and finishes the job on the next launch', async () => {
    const first = await boot(db);
    await first.startTestLoop();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Break the last adoption step so the process "dies" mid-adoption.
    await db.execAsync('DROP TABLE telemetry');
    const gnss = provider();
    for (const sample of THREE_LAPS) {
      gnss.push(sample);
      await settle();
    }
    await settle();

    expect(first.testLoopSnapshot().phase).toBe('error');
    const staged = await journalRow();
    expect(staged).not.toBeNull();
    const circuitId = first.listLearnedCircuits()[0]!.circuitId;

    // Next launch: the geometry survived, so the adoption is COMPLETED --
    // the circuit is kept and selected, and the journal is closed.
    await db.execAsync(
      'CREATE TABLE IF NOT EXISTS telemetry (sessionId TEXT NOT NULL, lapNumber INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (sessionId, lapNumber))',
    );
    const second = await boot(db);

    expect(await journalRow()).toBeNull();
    expect(second.listLearnedCircuits().map((record) => record.circuitId)).toEqual([circuitId]);
    expect(second.settingsStore.getSettings().selectedCircuitId).toBe(circuitId);
    let notice: string | null = null;
    second.subscribeRecoveryNotice((value) => {
      notice = value;
    })();
    expect(notice).not.toBeNull();
    warn.mockRestore();
  });

  it('rolls a half-adopted circuit back when its geometry never landed', async () => {
    const seed = await boot(db);
    expect(seed.listLearnedCircuits()).toHaveLength(0);
    // A journal from a process that died BEFORE the circuit was stored, with
    // the session it had already started.
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'testLoopAdoption',
      JSON.stringify({ circuitId: 'learned-ghost', stage: 'session-started', sessionId: 's-ghost' }),
    ]);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'activeSessionId',
      's-ghost',
    ]);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'activeSessionCircuitId',
      'learned-ghost',
    ]);

    const relaunched = await boot(db);

    expect(await journalRow()).toBeNull();
    expect(relaunched.listLearnedCircuits()).toHaveLength(0);
    const active = await db.getAllAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      ['activeSessionId'],
    );
    expect(active).toHaveLength(0);
    let notice: string | null = null;
    relaunched.subscribeRecoveryNotice((value) => {
      notice = value;
    })();
    expect(notice).not.toBeNull();
  });
});
