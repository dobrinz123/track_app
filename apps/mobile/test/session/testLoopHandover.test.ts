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
    const rows = await db.getAllAsync<{ lapNumber: number }>(
      'SELECT lapNumber FROM telemetry ORDER BY lapNumber',
    );
    expect(rows.map((row) => row.lapNumber)).toContain(0);
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
