import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, type LocationSample, type SqlDatabase } from '@circuit/core';

import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { rectangleLoopSamples, uTurnSamples } from '../support/testLoopTraces';

/**
 * Ticket P5d T2/T4/T6 -- Test Loop mode end to end through the REAL
 * composition layer: learn a track from lap 1, keep it, save it as a named
 * circuit, and find it still there after a restart.
 *
 * Follows `composition.circuitSelection.test.ts`'s established mocking
 * pattern: stub `expo-constants`/`../platform`/`expoSqlDatabase`, a fresh
 * module instance per test via `vi.resetModules()`, and a feed-capable stub
 * GNSS provider so the learn phase is driven by real `LocationSample`s.
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
  default: { expoConfig: { version: 'test-loop-test' } },
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

function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function boot(db: SqlDatabase): Promise<typeof import('../../src/session/composition')> {
  seeded.db = db;
  seeded.repository = await SqlSessionRepository.create(db);
  tracked.gnssProviders.length = 0;
  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

function provider(): StubLocationProviderInstance {
  const instance = tracked.gnssProviders[tracked.gnssProviders.length - 1];
  if (instance === undefined) throw new Error('no stub GNSS provider was constructed');
  return instance;
}

async function learnALoop(
  composition: typeof import('../../src/session/composition'),
  samples: readonly LocationSample[] = rectangleLoopSamples({ laps: 2 }),
): Promise<string> {
  const started = await composition.startTestLoop();
  expect(started.ok).toBe(true);
  const gnss = provider();
  for (const sample of samples) {
    gnss.push(sample);
    // P5d-FIX1 H1/H3: the handover is asynchronous and AWAITED -- let it
    // settle between fixes exactly as it would between two real ones.
    await flushBootstrap();
  }
  await flushBootstrap();
  const snapshot = composition.testLoopSnapshot();
  expect(snapshot.phase).toBe('learned');
  return snapshot.learned!.circuitId;
}

describe('composition -- Test Loop mode (P5d T2, T4, T6)', () => {
  let db: SqlDatabase;

  beforeEach(async () => {
    db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
  });

  it('learns a track from lap 1, persists it, and selects it for the session that follows', async () => {
    const composition = await boot(db);
    const circuitId = await learnALoop(composition);

    const snapshot = composition.testLoopSnapshot();
    expect(snapshot.learned!.cornerCount).toBe(4);
    expect(snapshot.learned!.lengthM).toBeGreaterThan(600);

    // The learned circuit is resolvable BY THE ORDINARY CATALOG, which is what
    // makes the session controller, history and analysis work unchanged.
    const { circuitCatalog } = await import('../../src/session/circuitCatalog');
    const entry = circuitCatalog.get(circuitId);
    expect(entry).not.toBeNull();
    expect(entry!.profile.geometryStatus).toBe('ad-hoc');
    expect(entry!.corners).toHaveLength(4);
    expect(composition.listLearnedCircuits().map((record) => record.circuitId)).toEqual([circuitId]);
    expect(composition.settingsStore.getSettings().selectedCircuitId).toBe(circuitId);

    // ...and the selection RESOLVES to the learned geometry, so the session
    // controller and history store that follow are built for it -- not
    // silently for the default circuit.
    const { resolveSelectedCircuit } = await import('../../src/session/circuitCatalog');
    const resolved = resolveSelectedCircuit({ selectedCircuitId: circuitId });
    expect(resolved.profile.circuitId).toBe(circuitId);
    expect(resolved.profile.geometryStatus).toBe('ad-hoc');
  });

  it('keeps an unsaved test loop out of the circuit list, but alive across a restart', async () => {
    const first = await boot(db);
    const circuitId = await learnALoop(first);
    expect(first.listLearnedCircuits()[0]!.saved).toBe(false);

    const restarted = await boot(db);
    const records = restarted.listLearnedCircuits();
    expect(records.map((record) => record.circuitId)).toEqual([circuitId]);
    expect(records[0]!.saved).toBe(false);
  });

  it('saves a learned loop as a named circuit that appears in the selection list and survives a restart', async () => {
    const first = await boot(db);
    const circuitId = await learnALoop(first);

    const saved = await first.saveLearnedCircuit(circuitId, 'Cartierul meu');
    expect(saved).toEqual({ ok: true });

    const restarted = await boot(db);
    expect(restarted.listLearnedCircuits().map((record) => record.saved)).toEqual([true]);
    const { circuitCatalog } = await import('../../src/session/circuitCatalog');
    const listed = circuitCatalog.list();
    const learnedRow = listed.find((circuit) => circuit.circuitId === circuitId);
    expect(learnedRow).toBeDefined();
    expect(learnedRow!.displayName).toBe('Cartierul meu');
    expect(learnedRow!.origin).toBe('learned');
    expect(learnedRow!.geometryStatus).toBe('ad-hoc');

    // The bundled circuits are untouched by any of this.
    expect(listed.filter((circuit) => circuit.origin === 'bundled').map((c) => c.circuitId)).toEqual(
      [TMR_CIRCUIT_PROFILE.circuitId, MOTORPARK_CIRCUIT_PROFILE.circuitId],
    );
  });

  it('refuses to delete a learned circuit that is in use, and deletes one that is not', async () => {
    const composition = await boot(db);
    const circuitId = await learnALoop(composition);
    await composition.saveLearnedCircuit(circuitId, 'De șters');

    // P5d-FIX1 item 9: the session that grew out of the learn phase is STILL
    // being driven on this geometry -- deleting it would pull the track out
    // from under a live session.
    const refusedLive = await composition.deleteLearnedCircuit(circuitId);
    expect(refusedLive).toEqual({ ok: false, reason: 'active-session' });

    composition.facade.endSession();
    await composition.facade.whenCommandsSettled?.();
    await flushBootstrap();
    await flushBootstrap();

    await db.runAsync(
      'INSERT OR REPLACE INTO sessions (sessionId, userId, circuitId, layoutId, layoutVersion, startedAtUtc) VALUES (?, ?, ?, ?, ?, ?)',
      ['s1', 'local', circuitId, 'learned', 1, '2026-08-31T10:00:00.000Z'],
    );
    const refused = await composition.deleteLearnedCircuit(circuitId);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe('has-sessions');
    expect(composition.listLearnedCircuits()).toHaveLength(1);

    await db.runAsync('DELETE FROM sessions WHERE circuitId = ?', [circuitId]);
    const removed = await composition.deleteLearnedCircuit(circuitId);
    expect(removed).toEqual({ ok: true });
    expect(composition.listLearnedCircuits()).toHaveLength(0);
    const { circuitCatalog } = await import('../../src/session/circuitCatalog');
    expect(circuitCatalog.list().some((circuit) => circuit.circuitId === circuitId)).toBe(false);
  });

  it('ends a loop that never closed with an honest failure, and learns nothing (T5)', async () => {
    const composition = await boot(db);
    const started = await composition.startTestLoop();
    expect(started.ok).toBe(true);
    for (const sample of uTurnSamples()) provider().push(sample);

    const stopped = await composition.stopTestLoop();
    expect(stopped.phase).toBe('failed');
    expect(stopped.failure!.reason).toBe('too-short');
    expect(composition.listLearnedCircuits()).toHaveLength(0);
    // The provider the learn phase started is stopped again -- no session-less
    // GPS watcher is left running (the provider-ownership rule).
    expect(provider().stopCount).toBeGreaterThan(0);
  });
});
