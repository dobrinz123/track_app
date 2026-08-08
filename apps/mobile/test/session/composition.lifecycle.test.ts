import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, cleanRecognitionLap, multiLapSession, type LocationSample } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * Composition-level lifecycle fixes: C1 (one-shot controller), C2 (bootstrap
 * gate), and C6 (DevReplay swap leak + restore path). Follows
 * `composition.recovery.test.ts`'s established pattern -- mock
 * `expo-constants`/`../../src/platform`/`../../src/persistence/expoSqlDatabase`
 * minimally, drive the module's real bootstrap IIFE against a real
 * `SqlSessionRepository` over the sql.js adapter, import fresh per test via
 * `vi.resetModules()`.
 *
 * Unlike the recovery test's inert platform stubs, the GNSS/replay provider
 * stubs here are feed-capable (`push()`) and tracked in a shared `vi.hoisted`
 * registry, so tests can drive REAL samples (`@circuit/core`'s bundled
 * fixtures, against the SAME bundled TMR profile `composition.ts` itself
 * uses) through the actual production pipeline end-to-end.
 */

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
  /** When set, `openAppDatabase()` awaits this instead of resolving immediately -- lets the bootstrap-gate (C2) test keep bootstrap 'pending' on demand. */
  openGate: null as Promise<void> | null,
  /** When true, `openAppDatabase()` rejects instead of resolving -- the bootstrap-failure (C2) test. */
  openShouldReject: false,
}));

const tracked = vi.hoisted(() => ({
  gnssProviders: [] as StubLocationProviderInstance[],
  replayProviders: [] as StubLocationProviderInstance[],
}));

interface StubLocationProviderInstance {
  startCount: number;
  stopCount: number;
  push(sample: LocationSample): void;
}

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'lifecycle-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubLocationProviderBase {
    listeners = new Set<(s: LocationSample) => void>();
    startCount = 0;
    stopCount = 0;
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
  class StubGnssLocationProvider extends StubLocationProviderBase {
    constructor() {
      super();
      tracked.gnssProviders.push(this);
    }
  }
  class StubReplayLocationProvider extends StubLocationProviderBase {
    constructor(_samples: unknown, _options: unknown) {
      super();
      tracked.replayProviders.push(this);
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
    ReplayLocationProvider: StubReplayLocationProvider,
    startLifecycleListener: () => {},
  };
});

vi.mock('../../src/persistence/expoSqlDatabase', () => ({
  openAppDatabase: async () => {
    if (seeded.openGate !== null) await seeded.openGate;
    if (seeded.openShouldReject) throw new Error('disk full (test double)');
    return { db: seeded.db, repository: seeded.repository };
  },
}));

// Real bundled TMR profile -- the SAME one `composition.ts` itself loads
// (`../../src/session/tmrProfile`), unmocked, so fixtures built against it
// exercise the real pipeline exactly as production would.
import { TMR_CIRCUIT_PROFILE } from '../../src/session/tmrProfile';

/** Flushes the purely-microtask-based bootstrap IIFE / command chains to completion (mirrors `composition.recovery.test.ts`'s own helper). */
function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function feed(provider: StubLocationProviderInstance, samples: readonly LocationSample[]): void {
  for (const sample of samples) provider.push(sample);
}

/** Boots a FRESH composition module instance against a fresh, empty sql.js-backed repository. */
async function bootFresh(): Promise<typeof import('../../src/session/composition')> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  seeded.db = db;
  seeded.repository = repository;
  seeded.openGate = null;
  seeded.openShouldReject = false;
  tracked.gnssProviders.length = 0;
  tracked.replayProviders.length = 0;

  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

function latestFacadeState(composition: Awaited<ReturnType<typeof bootFresh>>): unknown {
  let latest: unknown;
  const unsubscribe = composition.facade.subscribe((s) => {
    latest = s;
  });
  unsubscribe();
  return latest;
}

describe('composition.ts one-shot-controller fix (C1)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a full session followed by a SECOND full session through the SAME app composition (no relaunch) records laps for both and leaves 2 sessions in history', async () => {
    const composition = await bootFresh();
    const gnss = tracked.gnssProviders[0]!;

    // ---- Session 1: calibrate -> lap -> end ----
    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 100_001));
    await flushBootstrap();
    composition.facade.acceptCalibration();
    await flushBootstrap();
    composition.facade.arm();
    feed(gnss, multiLapSession(TMR_CIRCUIT_PROFILE, 1, 100_002));
    await flushBootstrap();
    composition.facade.endSession();
    await flushBootstrap();

    const afterSession1 = latestFacadeState(composition) as {
      sessionState: string;
      laps: unknown[];
    };
    expect(afterSession1.sessionState).toBe('sessionComplete');
    expect(afterSession1.laps.length).toBeGreaterThan(0);
    expect(composition.sessionHistoryStore.listSessions()).toHaveLength(1);

    // ---- Session 2: SAME composition, no relaunch, no manual controller
    //      recreation -- startPreflight() must dispose the terminal
    //      controller and swap a fresh one before the command reaches it.
    //      Before the C1 fix, `sessionComplete` ignores START_PREFLIGHT and
    //      every calibration transition, so this second session would never
    //      progress and history would stay stuck at 1.
    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 100_003));
    await flushBootstrap();
    composition.facade.acceptCalibration();
    await flushBootstrap();
    composition.facade.arm();
    feed(gnss, multiLapSession(TMR_CIRCUIT_PROFILE, 1, 100_004));
    await flushBootstrap();
    composition.facade.endSession();
    await flushBootstrap();

    const afterSession2 = latestFacadeState(composition) as {
      sessionState: string;
      laps: unknown[];
    };
    expect(afterSession2.sessionState).toBe('sessionComplete');
    expect(afterSession2.laps.length).toBeGreaterThan(0);
    expect(composition.sessionHistoryStore.listSessions()).toHaveLength(2);
  });
});

describe('composition.ts bootstrap gate (C2)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('commands invoked while bootstrap is still pending are safe no-ops (no throw, no state corruption); the SAME facade binding works once bootstrap resolves', async () => {
    // A deferred `openGate` this ONE test controls, so bootstrap stays
    // 'pending' until the test explicitly resolves it.
    let resolveOpen: (() => void) | undefined;
    const db = await createSqlJsDatabase();
    const repository = await SqlSessionRepository.create(db);
    seeded.db = db;
    seeded.repository = repository;
    seeded.openShouldReject = false;
    seeded.openGate = new Promise((resolve) => {
      resolveOpen = resolve;
    });
    tracked.gnssProviders.length = 0;
    tracked.replayProviders.length = 0;

    vi.resetModules();
    const composition = await import('../../src/session/composition');
    await flushBootstrap();

    expect(composition.subscribeBootstrapState).toBeDefined();
    let bootstrapState: string = 'unset';
    composition.subscribeBootstrapState((s) => {
      bootstrapState = s;
    });
    expect(bootstrapState).toBe('pending');

    // Commands invoked while pending: no throw, and no fabricated session
    // state (unlike the old live-MockSessionFacade-as-placeholder behavior).
    expect(() => {
      composition.facade.startPreflight();
      composition.facade.beginCalibration();
      composition.facade.acceptCalibration();
      composition.facade.arm();
      composition.facade.pause();
      composition.facade.resume();
      composition.facade.endSession();
    }).not.toThrow();
    await flushBootstrap();

    const whilePending = latestFacadeState(composition) as { sessionState: string; laps: unknown[] };
    expect(whilePending.sessionState).toBe('idle');
    expect(whilePending.laps).toHaveLength(0);

    // Now let bootstrap resolve.
    resolveOpen?.();
    await flushBootstrap();
    await flushBootstrap();

    expect(bootstrapState).toBe('ready');

    // The SAME `facade` binding now drives the real production pipeline.
    const gnss = tracked.gnssProviders[0]!;
    composition.facade.beginCalibration();
    await flushBootstrap();
    feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 200_001));
    const afterReady = latestFacadeState(composition) as { sessionState: string };
    expect(afterReady.sessionState).toBe('calibrationReview');
  });

  it('bootstrap failure flips bootstrapState to \'failed\' (not an uncaught rejection) and keeps every command a safe no-op', async () => {
    seeded.openGate = null;
    seeded.openShouldReject = true;
    tracked.gnssProviders.length = 0;
    tracked.replayProviders.length = 0;

    vi.resetModules();
    const composition = await import('../../src/session/composition');
    await flushBootstrap();

    let bootstrapState: string = 'unset';
    composition.subscribeBootstrapState((s) => {
      bootstrapState = s;
    });
    expect(bootstrapState).toBe('failed');

    expect(() => {
      composition.facade.beginCalibration();
      composition.facade.endSession();
    }).not.toThrow();
    await flushBootstrap();

    const state = latestFacadeState(composition) as { sessionState: string; laps: unknown[] };
    expect(state.sessionState).toBe('idle');
    expect(state.laps).toHaveLength(0);
  });
});

describe('composition.ts DevReplay swap leak + restore (C6)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('starting a SECOND replay disposes the first (stops its provider); restoreProductionFacade() disposes the active replay and hands commands back to production', async () => {
    const composition = await bootFresh();

    // ---- First replay ----
    await composition.startDevReplaySession(cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 300_001));
    composition.facade.beginCalibration();
    await flushBootstrap();
    const replay1 = tracked.replayProviders[0]!;
    expect(replay1.startCount).toBe(1);
    expect(replay1.stopCount).toBe(0);
    const midReplay1 = latestFacadeState(composition) as { sessionState: string };
    expect(midReplay1.sessionState).toBe('calibrating');

    // ---- Second replay, started without an explicit restore first (C6:
    //      startDevReplaySession() must dispose any previous replay
    //      controller itself, defense in depth) ----
    await composition.startDevReplaySession(cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 300_002));
    expect(replay1.stopCount).toBe(1); // the first replay's controller was disposed -- its provider was stopped.
    composition.facade.beginCalibration();
    await flushBootstrap();
    const replay2 = tracked.replayProviders[1]!;
    expect(replay2.startCount).toBe(1);
    expect(replay2.stopCount).toBe(0);

    // Pushing more samples into the FIRST (disposed) replay's provider must
    // not be observable through `facade` at all -- it is driving the SECOND
    // replay controller now.
    const beforeStaleFeed = latestFacadeState(composition);
    feed(replay1, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 300_003));
    await flushBootstrap();
    expect(latestFacadeState(composition)).toEqual(beforeStaleFeed);

    // ---- Restore production ----
    await composition.restoreProductionFacade();
    expect(replay2.stopCount).toBe(1); // the still-active second replay's controller was disposed too.

    const afterRestore = latestFacadeState(composition) as { sessionState: string };
    // Production's own controller was never driven -- its fresh, untouched
    // 'idle' state proves `facade` really points at production now, not a
    // frozen snapshot of wherever the replay last left off.
    expect(afterRestore.sessionState).toBe('idle');

    // Commands now reach the PRODUCTION controller/provider.
    const gnss = tracked.gnssProviders[0]!;
    composition.facade.beginCalibration();
    await flushBootstrap();
    expect(gnss.startCount).toBeGreaterThan(0);
    feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 300_004));
    const drivingProduction = latestFacadeState(composition) as { sessionState: string };
    expect(drivingProduction.sessionState).toBe('calibrationReview');

    // And the disposed replay controllers are still silent.
    feed(replay2, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 300_005));
    await flushBootstrap();
    const afterStaleReplay2Feed = latestFacadeState(composition);
    expect(afterStaleReplay2Feed).toEqual(drivingProduction);
  });
});
