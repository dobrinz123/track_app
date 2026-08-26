import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, cleanRecognitionLap, driveLap, multiLapSession, type LocationSample } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * `bootFresh()`/inline `vi.resetModules()` + `import('../../src/session/composition')`
 * give composition.ts a FRESH `@circuit/core` module instance each time
 * (resetModules() clears the WHOLE registry, not just composition.ts) --
 * distinct from any `@circuit/core` binding statically imported at this
 * file's own top level (resolved once, before any test ever runs). Spying on
 * `SessionController.prototype` only observes calls made through the SAME
 * module instance the spy was installed on, so tests that need to observe
 * calls composition.ts's OWN `SessionController` instances make (F2/F4
 * fixes below) must re-import `@circuit/core` AFTER the composition module
 * they're testing, so both resolve to the same cached instance.
 */
async function freshSessionControllerClass(): Promise<typeof import('@circuit/core').SessionController> {
  const core = await import('@circuit/core');
  return core.SessionController;
}

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

/** Drives calibrate -> accept -> arm -> end for one full session through the given GNSS stub, leaving the production controller terminal (`sessionComplete`) -- the precondition for the preflight gate's dispose+install path to actually run. */
async function driveOneFullSession(
  composition: Awaited<ReturnType<typeof bootFresh>>,
  gnss: StubLocationProviderInstance,
  seedBase: number,
): Promise<void> {
  composition.facade.startPreflight();
  await flushBootstrap();
  composition.facade.beginCalibration();
  await flushBootstrap();
  feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, seedBase + 1));
  await flushBootstrap();
  composition.facade.acceptCalibration();
  await flushBootstrap();
  composition.facade.arm();
  feed(gnss, multiLapSession(TMR_CIRCUIT_PROFILE, 1, seedBase + 2));
  await flushBootstrap();
  composition.facade.endSession();
  await flushBootstrap();
}

describe('composition.ts SwappableFacade preflight gate (F2 fix)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('concurrent startPreflight() calls while the gate is in flight share a SINGLE dispose+install replacement, not one per call', async () => {
    const composition = await bootFresh();
    const gnss = tracked.gnssProviders[0]!;
    await driveOneFullSession(composition, gnss, 400_000);

    const SessionController = await freshSessionControllerClass();
    const disposeSpy = vi.spyOn(SessionController.prototype, 'dispose');
    disposeSpy.mockClear();

    // Two concurrent calls, neither awaited in between -- the gate must
    // dedupe these into ONE dispose-then-install cycle (a revert to
    // `void gate().then(...)` per call would run it twice, racing two
    // replacements against each other).
    composition.facade.startPreflight();
    composition.facade.startPreflight();
    await flushBootstrap();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    disposeSpy.mockRestore();

    // The single replacement genuinely works: a second full session still
    // succeeds and lands in history.
    await driveOneFullSession(composition, gnss, 400_100);
    expect(composition.sessionHistoryStore.listSessions()).toHaveLength(2);
  });

  it('a rejecting preflight gate surfaces via FacadeState.lastError (no unhandled rejection) instead of forwarding startPreflight to the stale facade', async () => {
    const composition = await bootFresh();
    const gnss = tracked.gnssProviders[0]!;
    await driveOneFullSession(composition, gnss, 410_000);

    // Force the replacement's dispose() to reject -- this is exactly what
    // previously became an unhandled rejection under `void gate().then(...)`.
    const SessionController = await freshSessionControllerClass();
    const disposeSpy = vi
      .spyOn(SessionController.prototype, 'dispose')
      .mockRejectedValueOnce(new Error('dispose failed (test double)'));

    const events: Array<{ sessionState: string; lastError: string | null }> = [];
    composition.facade.subscribe((s) => events.push(s as { sessionState: string; lastError: string | null }));

    composition.facade.startPreflight();
    await flushBootstrap();

    expect(events.at(-1)!.lastError).not.toBeNull();
    expect(events.at(-1)!.lastError).toContain('startPreflight');
    // No swap happened: the facade still reflects the OLD (terminal) session,
    // not a fresh controller's 'idle' -- the stale facade never received the
    // forwarded startPreflight() call.
    expect(events.at(-1)!.sessionState).toBe('sessionComplete');

    disposeSpy.mockRestore();
  });
});

describe('composition.ts bootstrap facade activation timing (F3 fix)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('commands stay no-ops through the WHOLE bootstrap sequence, including after the production controller has already been built internally but before history/settings/recovery finish', async () => {
    const db = await createSqlJsDatabase();
    const repository = await SqlSessionRepository.create(db);
    let releaseHistoryGate: (() => void) | undefined;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistoryGate = resolve;
    });
    const originalListSessions = repository.listSessions.bind(repository);
    repository.listSessions = (userId: string, circuitId: string) => historyGate.then(() => originalListSessions(userId, circuitId));

    seeded.db = db;
    seeded.repository = repository;
    seeded.openGate = null;
    seeded.openShouldReject = false;
    tracked.gnssProviders.length = 0;
    tracked.replayProviders.length = 0;

    vi.resetModules();
    const composition = await import('../../src/session/composition');
    await flushBootstrap();

    let bootstrapState: string = 'unset';
    composition.subscribeBootstrapState((s) => {
      bootstrapState = s;
    });
    // Still pending -- blocked on history.refresh()'s listSessions() call.
    expect(bootstrapState).toBe('pending');
    // But the production controller/GnssLocationProvider have ALREADY been
    // constructed internally by this point (F3 fix's `buildProductionController()`
    // runs before the history step) -- the pre-fix code activated the real
    // facade right there, which is exactly the residue window this proves closed.
    expect(tracked.gnssProviders).toHaveLength(1);

    composition.facade.beginCalibration();
    await flushBootstrap();
    const whilePending = latestFacadeState(composition) as { sessionState: string };
    // Still idle: the command reached the inert PendingFacade, not the
    // already-built (but not yet activated) production controller.
    expect(whilePending.sessionState).toBe('idle');
    expect(tracked.gnssProviders[0]!.startCount).toBe(0);

    releaseHistoryGate?.();
    await flushBootstrap();
    await flushBootstrap();
    expect(bootstrapState).toBe('ready');

    // The SAME facade binding now drives the real production pipeline.
    const gnss = tracked.gnssProviders[0]!;
    composition.facade.beginCalibration();
    await flushBootstrap();
    feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 500_001));
    const afterReady = latestFacadeState(composition) as { sessionState: string };
    expect(afterReady.sessionState).toBe('calibrationReview');
  });

  it('a failed bootstrap can be retried via retryBootstrap() and succeeds once the underlying DB works, without a full app restart', async () => {
    const db = await createSqlJsDatabase();
    const repository = await SqlSessionRepository.create(db);
    seeded.db = db;
    seeded.repository = repository;
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
    expect(() => composition.facade.beginCalibration()).not.toThrow();

    // The underlying DB now works.
    seeded.openShouldReject = false;

    await composition.retryBootstrap();
    await flushBootstrap();
    expect(bootstrapState).toBe('ready');

    const gnss = tracked.gnssProviders[0]!;
    composition.facade.beginCalibration();
    await flushBootstrap();
    feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 510_001));
    const afterRetry = latestFacadeState(composition) as { sessionState: string };
    expect(afterRetry.sessionState).toBe('calibrationReview');
  });

  it('concurrent retryBootstrap() calls share a single in-flight attempt', async () => {
    const db = await createSqlJsDatabase();
    const repository = await SqlSessionRepository.create(db);
    seeded.db = db;
    seeded.repository = repository;
    seeded.openGate = null;
    seeded.openShouldReject = true;
    tracked.gnssProviders.length = 0;
    tracked.replayProviders.length = 0;

    vi.resetModules();
    const composition = await import('../../src/session/composition');
    await flushBootstrap();

    let openCalls = 0;
    seeded.openShouldReject = false;
    const originalListSessions = repository.listSessions.bind(repository);
    repository.listSessions = (userId: string, circuitId: string) => {
      openCalls += 1;
      return originalListSessions(userId, circuitId);
    };

    await Promise.all([composition.retryBootstrap(), composition.retryBootstrap()]);
    // A revert to no guard would run `runBootstrap()` (and so `listSessions()`)
    // twice -- each `retryBootstrap()` independently kicking off its own attempt.
    expect(openCalls).toBe(1);
  });
});

describe('composition.ts DevReplay transition lock (F4 fix)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a rapid start/restore/start storm settles deterministically: exactly one live controller ends up active, and the disposed replay never emits again', async () => {
    const composition = await bootFresh();

    // Three transitions fired back-to-back, none awaited in between -- if
    // they ran unserialized, whichever finished last (a race) would decide
    // the outcome. They instead execute strictly in CALL order under the one
    // `lifecycleLock` (ticket CN-FIX3): `startDevReplaySession()` acquires the
    // lock FIRST and awaits `ready()` inside it, so the old caveat -- that
    // its pre-lock `ready()` await could let `restoreProductionFacade()`
    // overtake it, making the enforced order differ from the raw call order
    // -- no longer applies. The last call issued is the one that wins.
    const p1 = composition.startDevReplaySession(cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 600_001));
    const p2 = composition.restoreProductionFacade();
    const p3 = composition.startDevReplaySession(cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 600_002));
    await Promise.all([p1, p2, p3]);
    await flushBootstrap();

    const replay1 = tracked.replayProviders[0]!;
    const replay2 = tracked.replayProviders[1]!;

    // Exactly one live controller: drive a command and observe which
    // replay's samples actually move `facade`'s state.
    composition.facade.beginCalibration();
    await flushBootstrap();
    const midState = latestFacadeState(composition) as { sessionState: string };
    expect(midState.sessionState).toBe('calibrating');

    // The FIRST replay is stale/disposed -- its samples never reach `facade`,
    // no matter how the storm interleaved internally.
    feed(replay1, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 600_003));
    await flushBootstrap();
    expect(latestFacadeState(composition)).toEqual(midState);

    // The SECOND (later-installed) replay is the one actually live.
    feed(replay2, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 600_004));
    await flushBootstrap();
    const afterReplay2Feed = latestFacadeState(composition) as { sessionState: string };
    expect(afterReplay2Feed.sessionState).toBe('calibrationReview');
  });

  it("restoreProductionFacade() awaits the active replay controller's flush() to settle BEFORE calling dispose() on it", async () => {
    const composition = await bootFresh();
    await composition.startDevReplaySession(cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 610_001));
    composition.facade.beginCalibration();
    await flushBootstrap();

    // Spy on the SAME `SessionController` class composition.ts's own replay
    // controller is an instance of (see `freshSessionControllerClass()`'s
    // doc comment) so `flush()`'s completion-ordering relative to
    // `dispose()` is observed directly, rather than trying to organically
    // complete a real timed lap through DevReplay's real (non-mocked)
    // `ReplayTimestampedLocationProvider` wall-clock re-stamping -- which
    // this test file's synchronous, zero-real-time `feed()` helper cannot
    // reliably drive to a valid crossing.
    const SessionController = await freshSessionControllerClass();
    const callOrder: string[] = [];
    let releaseFlushGate: () => void = () => undefined;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlushGate = resolve;
    });
    const flushSpy = vi.spyOn(SessionController.prototype, 'flush').mockImplementation(async () => {
      callOrder.push('flush-start');
      await flushGate;
      callOrder.push('flush-end');
    });
    const disposeSpy = vi.spyOn(SessionController.prototype, 'dispose').mockImplementation(async () => {
      callOrder.push('dispose');
    });

    let restored = false;
    const restorePromise = composition.restoreProductionFacade().then(() => {
      restored = true;
    });

    // Progress pending microtasks up to the flush gate without releasing
    // it -- `dispose()` must not have run yet, and `restoreProductionFacade()`
    // must not have resolved yet.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(callOrder).toEqual(['flush-start']);
    expect(restored).toBe(false);

    releaseFlushGate();
    await restorePromise;

    // flush() genuinely completed BEFORE dispose() ran -- not merely
    // "flush() was called at some point".
    expect(callOrder).toEqual(['flush-start', 'flush-end', 'dispose']);
    expect(restored).toBe(true);

    flushSpy.mockRestore();
    disposeSpy.mockRestore();
  });
});

/** A coaching-cue-dense driving fixture (same shape `sessionController.test.ts`'s own coaching tests use, proven to produce cues on the real TMR geometry). */
function coachingDenseLap(seed: number) {
  return driveLap(TMR_CIRCUIT_PROFILE, {
    seed,
    lapCount: 1,
    sampleRateHz: 2,
    noiseSigmaM: 0,
    accuracyM: 3,
    speedMps: ({ progress }: { progress: number }) => 32 + 10 * Math.sin(progress * Math.PI * 2) ** 2,
  });
}

/** Drives one full session (calibrate -> arm -> lap -> end) and collects every observed `coachCue`. */
async function driveOneCoachingSession(
  composition: Awaited<ReturnType<typeof bootFresh>>,
  gnss: StubLocationProviderInstance,
  seed: number,
): Promise<unknown[]> {
  const coachCues: unknown[] = [];
  const unsubscribe = composition.facade.subscribe((s: { coachCue: unknown }) => {
    coachCues.push(s.coachCue);
  });

  composition.facade.startPreflight();
  await flushBootstrap();
  composition.facade.beginCalibration();
  await flushBootstrap();
  feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, seed));
  await flushBootstrap();
  composition.facade.acceptCalibration();
  await flushBootstrap();
  composition.facade.arm();
  feed(gnss, coachingDenseLap(seed + 1));
  await flushBootstrap();
  composition.facade.endSession();
  await flushBootstrap();

  unsubscribe();
  return coachCues;
}

describe('composition.ts coaching-settings rebuild (F3 fix)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('toggling coachingEnabled off while idle rebuilds the production controller -- the NEXT session emits zero coaching cues', async () => {
    const composition = await bootFresh();
    const gnss = tracked.gnssProviders[0]!;

    expect(composition.settingsStore.getSettings().coachingEnabled).toBe(true);
    const state = latestFacadeState(composition) as { sessionState: string };
    expect(state.sessionState).toBe('idle');

    composition.settingsStore.update({ coachingEnabled: false });
    await flushBootstrap();

    const coachCues = await driveOneCoachingSession(composition, gnss, 900_001);

    expect(coachCues.every((cue) => cue === null)).toBe(true);
  });

  it('control: the SAME driving fixture produces at least one coaching cue when coachingEnabled stays on (proves the toggle test above is not merely "the fixture never fires")', async () => {
    const composition = await bootFresh();
    const gnss = tracked.gnssProviders[0]!;

    const coachCues = await driveOneCoachingSession(composition, gnss, 900_101);

    expect(coachCues.some((cue) => cue !== null)).toBe(true);
  });

  it('toggling coachingEnabled off mid-session does NOT rebuild until the session ends -- SettingsScreen note territory, not a mid-lap teardown', async () => {
    const composition = await bootFresh();
    const gnss = tracked.gnssProviders[0]!;

    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 900_201));
    await flushBootstrap();
    composition.facade.acceptCalibration();
    await flushBootstrap();
    composition.facade.arm();
    await flushBootstrap();

    const stateBeforeToggle = latestFacadeState(composition) as { sessionState: string };
    expect(['outLap', 'timing', 'armed']).toContain(stateBeforeToggle.sessionState);

    // Toggling mid-session must not tear down the live controller (a
    // rebuild here would destroy in-flight timing/GNSS state).
    composition.settingsStore.update({ coachingEnabled: false });
    await flushBootstrap();
    feed(gnss, coachingDenseLap(900_202));
    await flushBootstrap();

    // The session still completes normally through the SAME controller --
    // proves nothing was torn down underneath it.
    composition.facade.endSession();
    await flushBootstrap();
    const finalState = latestFacadeState(composition) as { sessionState: string; laps: unknown[] };
    expect(finalState.sessionState).toBe('sessionComplete');
    expect(finalState.laps.length).toBeGreaterThan(0);
  });
});
