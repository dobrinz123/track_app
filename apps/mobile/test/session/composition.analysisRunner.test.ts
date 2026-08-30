import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, type LocationSample } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';

/**
 * Ticket P5b-FIX1 C6 (Codex P5b-REV1 finding 6): the analysis runner and its
 * cache are composition singletons, not per-screen-instance objects -- leaving
 * the Analysis screen mid-run and coming back joins the SAME run instead of
 * starting a second one next to the abandoned first.
 *
 * Mocking follows `composition.circuitSelection.test.ts`'s established pattern.
 */

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'analysis-runner-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubGnssLocationProvider {
    listeners = new Set<(s: LocationSample) => void>();
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    subscribe(cb: (s: LocationSample) => void): () => void {
      this.listeners.add(cb);
      return () => {
        this.listeners.delete(cb);
      };
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

function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function bootFresh(): Promise<typeof import('../../src/session/composition')> {
  const db = await createSqlJsDatabase();
  await migrateTelemetrySchema(db);
  const repository = await SqlSessionRepository.create(db);
  seeded.db = db;
  seeded.repository = repository;

  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

describe('composition.ts owns ONE analysis runner (P5b-FIX1 C6)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('hands every caller the same runner and the same cache', async () => {
    const composition = await bootFresh();
    const first = composition.getAnalysisRunner();
    const second = composition.getAnalysisRunner();
    expect(second).toBe(first);
    expect(first.peek('no-such-session')).toBeNull();
  });

  it('reports an unknown session honestly through the shared runner', async () => {
    const composition = await bootFresh();
    const result = await composition.getAnalysisRunner().run('no-such-session');
    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' && result.reason).toBe('session-not-found');
  });
});
