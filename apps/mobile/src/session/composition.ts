import Constants from 'expo-constants';
import type {
  LocationProvider,
  LocationSample,
  SessionControllerDiagnostics,
  SessionMachineSnapshot,
  SessionState,
  LocalSessionRepository,
  SqlDatabase,
} from '@circuit/core';
import {
  InMemorySessionRepository,
  SessionController,
  deleteAllUserData,
  type DeleteUserDataResult,
} from '@circuit/core';
// Web detection WITHOUT importing react-native: its Flow-typed source breaks
// vitest's parser, and `typeof document` distinguishes the three real runtime
// environments correctly (browser preview = web; Hermes on device and node
// test runs have no DOM).
const IS_WEB_RUNTIME = typeof document !== 'undefined';
import {
  GnssLocationProvider,
  PerformanceNowClock,
  ReplayLocationProvider,
  startLifecycleListener,
  type GnssDiagnostics,
} from '../platform';
import { openAppDatabase } from '../persistence/expoSqlDatabase';
import { SqlSettingsStore } from '../persistence/sqlSettingsStore';
import type { FacadeState, SessionFacade } from './facade';
import { MockSessionFacade } from './mockFacade';
import type { PersonalBestEntry, SessionHistoryStore, StoredSession } from './mockHistory';
import { MockSessionHistoryStore } from './mockHistory';
import { SqlSessionHistoryStore } from './sqlSessionHistoryStore';
import type { AppSettings, SettingsStore } from './settingsStore';
import { InMemorySettingsStore } from './settingsStore';
import { RealSessionFacade, type RealSessionFacadeCallbacks } from './realFacade';
import { ReplayTimeSource, ReplayTimestampedLocationProvider, ScaledReplayClock } from './liveTimestampedProvider';
import { TMR_CIRCUIT_PROFILE, TMR_RUNTIME_PROFILE } from './tmrProfile';

const DB_NAME = 'circuit-timer.db';
/** Single-user local app -- no auth/account system exists (MVP scope, ADR-0001/0004). Stable so `sessionId` (`${userId}--<random>`) and stored data survive across launches. */
const LOCAL_USER_ID = 'local-driver';
const ACTIVE_SESSION_SETTINGS_KEY = 'activeSessionId';
const ALGORITHM_VERSION = 1;

function appVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0';
}

// ---------------------------------------------------------------------------
// Swappable wrappers. `apps/mobile/src/ui/**` imports `facade` /
// `sessionHistoryStore` / `settingsStore` as stable bindings that never
// change identity; internally each delegates to a swappable inner
// implementation. This exists for two reasons:
//  1. Opening the on-device SQLite database is async, but React components
//     import these singletons synchronously at module-load time -- each
//     starts backed by an in-memory placeholder and is swapped to the real
//     SQL-backed implementation once `openAppDatabase` resolves.
//  2. DevReplayScreen (MUST DO #6) drives the SAME real screens (Calibration
//     Instructions -> Active Calibration -> Calibration Result -> Active
//     Dashboard) against a replay-backed `SessionController` instead of the
//     live GNSS one -- swapping `facade`'s inner implementation just before
//     navigating there is what makes that possible without those screens
//     knowing anything changed.
// ---------------------------------------------------------------------------

class SwappableFacade implements SessionFacade {
  private inner: SessionFacade;
  private innerUnsubscribe: () => void;
  private current!: FacadeState;
  private readonly listeners = new Set<(s: FacadeState) => void>();
  /**
   * One-shot-controller gate (C1 fix). When set, every `startPreflight()`
   * call runs this first and awaits it before forwarding the command to
   * `inner` -- composition.ts uses it to dispose and swap in a fresh
   * production controller/facade if the current one is terminal
   * (`sessionComplete`/`error`) before a new session can begin.
   */
  private preflightGate: (() => Promise<void>) | null = null;

  constructor(initial: SessionFacade) {
    this.inner = initial;
    this.innerUnsubscribe = initial.subscribe((s) => this.broadcast(s));
  }

  private broadcast(s: FacadeState): void {
    this.current = s;
    for (const listener of this.listeners) listener(s);
  }

  /** Swaps the active implementation. Existing subscribers keep working -- they're subscribed to this wrapper, not `inner`. */
  setInner(next: SessionFacade): void {
    this.innerUnsubscribe();
    this.inner = next;
    this.innerUnsubscribe = next.subscribe((s) => this.broadcast(s));
  }

  setPreflightGate(gate: (() => Promise<void>) | null): void {
    this.preflightGate = gate;
  }

  subscribe(cb: (s: FacadeState) => void): () => void {
    this.listeners.add(cb);
    cb(this.current);
    return () => {
      this.listeners.delete(cb);
    };
  }

  startPreflight(): void {
    const gate = this.preflightGate;
    if (gate === null) {
      this.inner.startPreflight();
      return;
    }
    void gate().then(() => this.inner.startPreflight());
  }
  beginCalibration(): void {
    this.inner.beginCalibration();
  }
  acceptCalibration(): void {
    this.inner.acceptCalibration();
  }
  rejectCalibration(): void {
    this.inner.rejectCalibration();
  }
  arm(): void {
    this.inner.arm();
  }
  endSession(): void {
    this.inner.endSession();
  }
  pause(): void {
    this.inner.pause();
  }
  resume(): void {
    this.inner.resume();
  }
}

class SwappableSessionHistoryStore implements SessionHistoryStore {
  constructor(private inner: SessionHistoryStore) {}
  setInner(next: SessionHistoryStore): void {
    this.inner = next;
  }
  listSessions(): StoredSession[] {
    return this.inner.listSessions();
  }
  getSession(sessionId: string): StoredSession | null {
    return this.inner.getSession(sessionId);
  }
  getPersonalBest(): PersonalBestEntry | null {
    return this.inner.getPersonalBest();
  }
}

class SwappableSettingsStore implements SettingsStore {
  private inner: SettingsStore;
  private innerUnsubscribe: () => void;
  private current!: AppSettings;
  private readonly listeners = new Set<(s: AppSettings) => void>();

  constructor(initial: SettingsStore) {
    this.inner = initial;
    this.innerUnsubscribe = initial.subscribe((s) => this.broadcast(s));
  }

  private broadcast(s: AppSettings): void {
    this.current = s;
    for (const listener of this.listeners) listener(s);
  }

  setInner(next: SettingsStore): void {
    this.innerUnsubscribe();
    this.inner = next;
    this.innerUnsubscribe = next.subscribe((s) => this.broadcast(s));
  }

  getSettings(): AppSettings {
    return this.inner.getSettings();
  }
  subscribe(cb: (s: AppSettings) => void): () => void {
    this.listeners.add(cb);
    cb(this.current);
    return () => {
      this.listeners.delete(cb);
    };
  }
  update(patch: Partial<AppSettings>): void {
    this.inner.update(patch);
  }
}

// ---------------------------------------------------------------------------
// PendingFacade (C2 fix). Installed as `facade`'s initial inner implementation
// -- replacing what used to be a live `MockSessionFacade` -- so nothing is
// clickable/functional until bootstrap actually finishes. Every command is a
// silent no-op and state never changes: unlike `MockSessionFacade` (which
// stays reserved for the __DEV__ DevReplay "scripted mock" toggle), this
// never fabricates laps, times, or any other session data. `CircuitDetailScreen`
// separately disables its "Start Session" button until `bootstrapState==='ready'`,
// so in normal use no command ever reaches this facade at all -- it exists as
// a safe placeholder for the brief window it takes React to import
// `composition.ts` and observe that state, and as a defensive fallback if a
// caller invokes `facade` before/without checking it.
// ---------------------------------------------------------------------------

const PENDING_FACADE_STATE: FacadeState = {
  sessionState: 'idle',
  lapNumber: 0,
  currentLapMs: 0,
  lastLapMs: null,
  pbMs: null,
  delta: null,
  sector: 0,
  gnssQuality: 'good',
  calibration: null,
  calibrationResult: null,
  laps: [],
  speedKph: null,
  lastError: null,
};

class PendingFacade implements SessionFacade {
  private readonly listeners = new Set<(s: FacadeState) => void>();
  subscribe(cb: (s: FacadeState) => void): () => void {
    this.listeners.add(cb);
    cb(PENDING_FACADE_STATE);
    return () => {
      this.listeners.delete(cb);
    };
  }
  startPreflight(): void {}
  beginCalibration(): void {}
  acceptCalibration(): void {}
  rejectCalibration(): void {}
  arm(): void {}
  endSession(): void {}
  pause(): void {}
  resume(): void {}
}

/**
 * Single composition root for session-layer singletons consumed by
 * `apps/mobile/src/ui/**`. Screens must always import `facade`,
 * `sessionHistoryStore`, and `settingsStore` from here — never `Mock*` or
 * `Sql*`/`Real*` implementations directly.
 */
const facadeWrapper = new SwappableFacade(new PendingFacade());
export const facade: SessionFacade = facadeWrapper;

const historyWrapper = new SwappableSessionHistoryStore(new MockSessionHistoryStore());
export const sessionHistoryStore: SessionHistoryStore = historyWrapper;

const settingsWrapper = new SwappableSettingsStore(new InMemorySettingsStore());
export const settingsStore: SettingsStore = settingsWrapper;

// ---------------------------------------------------------------------------
// Bootstrap readiness (C2 fix). `CircuitDetailScreen` subscribes via
// `subscribeBootstrapState` to disable "Start Session" (and show an inline
// note/error banner) until bootstrap has actually finished.
// ---------------------------------------------------------------------------

export type BootstrapState = 'pending' | 'ready' | 'failed';

let bootstrapState: BootstrapState = 'pending';
const bootstrapStateListeners = new Set<(s: BootstrapState) => void>();

function setBootstrapState(next: BootstrapState): void {
  bootstrapState = next;
  for (const listener of bootstrapStateListeners) listener(next);
}

export function subscribeBootstrapState(cb: (s: BootstrapState) => void): () => void {
  bootstrapStateListeners.add(cb);
  cb(bootstrapState);
  return () => {
    bootstrapStateListeners.delete(cb);
  };
}

// ---------------------------------------------------------------------------
// Recovery (ADR-0003 §3, MUST DO #3). CircuitDetailScreen subscribes to
// `subscribeRecovery` and shows an inline banner (not modal) when non-null.
// ---------------------------------------------------------------------------

export interface PendingRecovery {
  sessionId: string;
  lapCount: number;
}

let pendingRecovery: PendingRecovery | null = null;
const recoveryListeners = new Set<(r: PendingRecovery | null) => void>();

function setPendingRecovery(next: PendingRecovery | null): void {
  pendingRecovery = next;
  for (const listener of recoveryListeners) listener(next);
}

export function subscribeRecovery(cb: (r: PendingRecovery | null) => void): () => void {
  recoveryListeners.add(cb);
  cb(pendingRecovery);
  return () => {
    recoveryListeners.delete(cb);
  };
}

// ---------------------------------------------------------------------------
// Production bootstrap: opens the on-device SQLite database, builds the real
// `SessionController` + `GnssLocationProvider`, checks for a recoverable
// checkpoint, and swaps every wrapper above from its in-memory placeholder
// to the real implementation. Kicked off once, at module load.
// ---------------------------------------------------------------------------

let db: SqlDatabase | null = null;
let repository: LocalSessionRepository | null = null;
let controller: SessionController | null = null;
/** The `RealSessionFacade` currently wrapping the production `controller` -- kept alive (not recreated) across DevReplay swaps so `restoreProductionFacade()` (C6 fix) can just re-point `facadeWrapper` back to it instead of leaking a fresh subscription every time. Recreated together with `controller` by `installProductionController()` (C1 fix). */
let productionFacade: RealSessionFacade | null = null;
let gnssProvider: GnssLocationProvider | null = null;
let historyStore: SqlSessionHistoryStore | null = null;
/**
 * The `SessionController` currently backing `facade` -- the production one,
 * or (in `__DEV__`) `startDevReplaySession`'s replay controller. Tracked
 * separately from `controller` (which stays the production instance for its
 * whole lifetime) so both the background-checkpoint lifecycle hook (MUST DO
 * #4) and `getLiveDiagnostics` (MUST DO #3) always act on whichever session
 * is actually live, not a stale production reference during dev replay.
 */
let activeController: SessionController | null = null;
/** The current `__DEV__` DevReplay controller, if any (C6 fix) -- tracked so a new replay (or a return to production) can `dispose()` it first instead of leaking its provider/watchdog. */
let replayController: SessionController | null = null;

// ---------------------------------------------------------------------------
// App-lifecycle wiring (MUST DO #4). Registered once at module load --
// independent of `bootstrapPromise` below -- so a background transition
// during boot is a harmless no-op (`activeController` is still null) rather
// than a missed event. `checkpointNow()` is itself a no-op with no active
// session (`SessionController.checkpointNow`'s own doc comment), so this is
// always safe to fire unconditionally on every background transition; no
// separate "is a session active" check is needed here.
//
// Deliberately does NOT pause on background (keep-awake means backgrounding
// during an active session is a deliberate user action -- timing continues,
// the ADR-0003 §1 watchdog handles any resulting GNSS gap) and does nothing
// special on foreground return (the ADR-0003 §3 recovery flow already covers
// process death; a mere background/foreground cycle without process death
// needs no extra action beyond the checkpoint already taken going in).
//
// C8 fix: `.catch()` (not bare `void`) so a rejected checkpoint write is
// logged instead of becoming an unhandled promise rejection; `checkpointNow()`
// itself can never throw synchronously (it is an `async` method, so any
// internal synchronous throw is already converted to a rejection by
// language semantics) -- there was nothing further to change core-side.
// ---------------------------------------------------------------------------
startLifecycleListener({
  onBackground: () => {
    activeController?.checkpointNow().catch((error: unknown) => {
      console.warn('[composition] background checkpoint failed', error);
    });
  },
});

async function getActiveSessionId(database: SqlDatabase): Promise<string | null> {
  const rows = await database.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
    ACTIVE_SESSION_SETTINGS_KEY,
  ]);
  return rows[0]?.value ?? null;
}

async function setActiveSessionId(database: SqlDatabase, sessionId: string | null): Promise<void> {
  if (sessionId === null) {
    await database.runAsync('DELETE FROM settings WHERE key = ?', [ACTIVE_SESSION_SETTINGS_KEY]);
  } else {
    await database.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      ACTIVE_SESSION_SETTINGS_KEY,
      sessionId,
    ]);
  }
}

function midSessionState(snapshot: SessionMachineSnapshot): boolean {
  const midStates = new Set(['outLap', 'timing', 'inPit']);
  if (midStates.has(snapshot.state)) return true;
  const priorState = snapshot.context.priorState;
  return snapshot.state === 'paused' && typeof priorState === 'string' && midStates.has(priorState);
}

/** Reads a `SessionController`'s current `sessionState` -- `subscribe()` always calls back synchronously with the current state (see `SessionController.subscribe`'s own doc comment), so this never actually waits. */
function currentControllerState(ctrl: SessionController): SessionState {
  let state: SessionState = 'idle';
  const unsubscribe = ctrl.subscribe((s) => {
    state = s.sessionState;
  });
  unsubscribe();
  return state;
}

/**
 * Builds the production `SessionController` (C1 fix's `createProductionController()`
 * factory) -- the SAME deps `bootstrapPromise` used to construct it inline
 * with, extracted so the initial bootstrap build and every later
 * terminal-state rebuild (`installProductionController()` below) can never
 * drift apart. Reuses the single, already-started `gnssProvider`/`repository`
 * module singletons -- only `controller` itself (and its `clock`) are fresh.
 */
function createProductionController(): SessionController {
  if (repository === null) {
    throw new Error('composition: createProductionController() called before the repository is ready');
  }
  if (gnssProvider === null) {
    throw new Error('composition: createProductionController() called before gnssProvider is ready');
  }
  const provider = gnssProvider;
  const clock = new PerformanceNowClock();
  const restartProvider = async (): Promise<void> => {
    await provider.stop();
    await provider.start();
  };
  return new SessionController({
    runtimeProfile: TMR_RUNTIME_PROFILE,
    circuitProfile: TMR_CIRCUIT_PROFILE,
    locationProvider: provider,
    clock,
    repository,
    userId: LOCAL_USER_ID,
    appVersion: appVersion(),
    algorithmVersion: ALGORITHM_VERSION,
    restartProvider,
  });
}

/** Callbacks shared by every production `RealSessionFacade` (initial bootstrap AND any later C1 terminal-state rebuild), so the active-session-pointer/history-refresh wiring can never drift between them. */
function productionFacadeCallbacks(): RealSessionFacadeCallbacks {
  return {
    onSessionStarted: (sessionId) => {
      if (db !== null) void setActiveSessionId(db, sessionId);
    },
    onSessionEnded: () => {
      const clearPointer = db !== null ? setActiveSessionId(db, null) : Promise.resolve();
      void clearPointer.then(() => historyStore?.refresh());
    },
  };
}

/** Installs `freshController` as the production controller: assigns it to `controller`/`activeController`, wraps it in a fresh `RealSessionFacade` kept as `productionFacade`, and makes it the live `facade`. */
function installProductionController(freshController: SessionController): void {
  controller = freshController;
  activeController = freshController;
  productionFacade = new RealSessionFacade(freshController, productionFacadeCallbacks());
  facadeWrapper.setInner(productionFacade);
}

const bootstrapPromise = (async (): Promise<void> => {
  try {
    if (IS_WEB_RUNTIME) {
      // Web preview is a development surface only: expo-sqlite's wasm backend
      // (wa-sqlite/OPFS) throws 'disk I/O error' in embedded browsers. Fall
      // back to the in-memory repository -- no persistence across reloads,
      // which is acceptable for the dev preview and keeps every session flow
      // (timing, PB, history) fully functional. Native builds are unaffected.
      console.warn('[composition] web preview: using in-memory storage (expo-sqlite web backend unavailable)');
      repository = new InMemorySessionRepository();
    } else {
      const opened = await openAppDatabase(DB_NAME);
      db = opened.db;
      repository = opened.repository;
    }

    gnssProvider = new GnssLocationProvider();

    installProductionController(createProductionController());

    // One-shot-controller gate (C1 fix): every `startPreflight()` call checks
    // whether the production controller is terminal (a prior session already
    // completed, or ended in `error`) and, if so, disposes it and installs a
    // fresh one BEFORE forwarding the command -- otherwise a second real
    // session on the same app composition would be driven by a controller
    // stuck in `sessionComplete`, which ignores START_PREFLIGHT/calibration
    // transitions entirely. A no-op while a DevReplay controller is active
    // (`activeController !== controller`) -- that swap is `restoreProductionFacade()`'s
    // job, not this gate's.
    facadeWrapper.setPreflightGate(async () => {
      if (controller === null || activeController !== controller) return;
      const state = currentControllerState(controller);
      if (state !== 'sessionComplete' && state !== 'error') return;
      const staleController = controller;
      const staleFacade = productionFacade;
      await staleController.dispose();
      staleFacade?.dispose();
      installProductionController(createProductionController());
    });

    const history = new SqlSessionHistoryStore(
      repository,
      LOCAL_USER_ID,
      TMR_CIRCUIT_PROFILE.circuitId,
      TMR_CIRCUIT_PROFILE.layoutId,
      TMR_CIRCUIT_PROFILE.layoutVersion,
    );
    await history.refresh();
    historyWrapper.setInner(history);
    historyStore = history;

    if (db !== null) {
      const settings = await SqlSettingsStore.create(db);
      settingsWrapper.setInner(settings);
    }

    const activeSessionId = db !== null ? await getActiveSessionId(db) : null;
    if (activeSessionId !== null) {
      const checkpoint = await repository.loadCheckpoint(activeSessionId);
      if (checkpoint !== null && checkpoint.snapshot.state !== 'sessionComplete') {
        const recoveryLapCount = checkpoint.laps.length + (midSessionState(checkpoint.snapshot) ? 1 : 0);
        setPendingRecovery({ sessionId: activeSessionId, lapCount: recoveryLapCount });
      } else if (db !== null) {
        await setActiveSessionId(db, null);
      }
    }
    setBootstrapState('ready');
  } catch (error) {
    // C2 fix: previously an uncaught bootstrap rejection left `facade` on a
    // live, fully-functional `MockSessionFacade` -- calibration could start
    // against a fake timer with no persistence and no user-visible error.
    // `facade`'s inner stays the inert `PendingFacade` installed above (never
    // swapped to `MockSessionFacade`/`RealSessionFacade` on this path), and
    // `bootstrapState` flips to 'failed' so `CircuitDetailScreen` can show a
    // non-modal error banner and keep "Start Session" disabled.
    console.error('[composition] bootstrap failed', error);
    setBootstrapState('failed');
    throw error;
  }
})();
// Bootstrap failures are observable via `bootstrapState`/`subscribeBootstrapState`
// and (for callers that specifically await it) `ready()`'s own rethrow below --
// this no-op catch only prevents Node/Hermes from ever reporting the module-load
// promise itself as an unhandled rejection when nothing else happens to consume it.
bootstrapPromise.catch(() => undefined);

/** Awaited by recovery/dev-replay actions below so they never race the async bootstrap. */
async function ready(): Promise<{ db: SqlDatabase | null; repository: LocalSessionRepository; controller: SessionController }> {
  await bootstrapPromise;
  if (repository === null || controller === null) {
    throw new Error('composition bootstrap failed to produce a repository/controller');
  }
  return { db, repository, controller };
}

// ---------------------------------------------------------------------------
// Recovery operation lock (C10 fix). `resumeRecovery`/`discardRecovery` share
// a single in-flight lock: a second call (of either) while one is already
// running is a no-op that returns the SAME in-flight promise, instead of
// racing a second read/write against the same captured recovery record.
// ---------------------------------------------------------------------------

let recoveryOperationInFlight: Promise<void> | null = null;

function runRecoveryOperation(operation: () => Promise<void>): Promise<void> {
  if (recoveryOperationInFlight !== null) return recoveryOperationInFlight;
  const run = operation().finally(() => {
    recoveryOperationInFlight = null;
  });
  recoveryOperationInFlight = run;
  return run;
}

/**
 * Resumes a recovered session (ADR-0003 §3): restores historical laps into
 * the controller and arms it directly off the last-known stored reference
 * lap (`SessionController.start('session')` -- see that method's doc
 * comment for why this deliberately skips a live recalibration). Caller
 * (CircuitDetailScreen) navigates to `ActiveDashboard` after this resolves.
 */
export async function resumeRecovery(): Promise<void> {
  return runRecoveryOperation(async () => {
    const info = pendingRecovery;
    if (info === null) return;
    const { db: database, repository: repo, controller: ctrl } = await ready();
    const checkpoint = await repo.loadCheckpoint(info.sessionId);
    if (checkpoint !== null) {
      ctrl.restoreFromCheckpoint(info.sessionId, checkpoint.snapshot, checkpoint.laps);
    }
    await ctrl.start('session');
    setPendingRecovery(null);
    // C5 fix: the recovered session is active again -- keep the active-session
    // pointer (re-affirmed, in case it somehow drifted) rather than clearing
    // it. It is cleared only by the existing `onSessionEnded` callback once
    // this session actually finishes; clearing it here meant a SECOND process
    // death mid-resume left no pointer for the next launch to discover, so
    // recovery was silently never offered again.
    if (database !== null) await setActiveSessionId(database, info.sessionId);
  });
}

/** Discards a recoverable checkpoint without resuming (ADR-0003 §3): marks it terminal so it is never offered again -- `LocalSessionRepository` has no delete method, so this overwrites the checkpoint's snapshot to `sessionComplete` instead. */
export async function discardRecovery(): Promise<void> {
  return runRecoveryOperation(async () => {
    const info = pendingRecovery;
    if (info === null) return;
    const { db: database, repository: repo } = await ready();
    await repo.saveCheckpoint(
      info.sessionId,
      { state: 'sessionComplete', lapNumber: 0, context: {} },
      [],
    );
    setPendingRecovery(null);
    if (database !== null) await setActiveSessionId(database, null);
  });
}

// ---------------------------------------------------------------------------
// Data deletion (M3 security-review fix). `SettingsScreen`'s inline
// two-step "Delete all my data" row calls this -- the core-side delete +
// verify-empty logic lives in `@circuit/core`'s `deleteAllUserData` (unit
// tested there; the mobile UI itself is not unit-testable in this repo).
// Refreshes the shared `sessionHistoryStore` cache on success so
// `SessionHistoryScreen` reflects the deletion without a manual reload.
// ---------------------------------------------------------------------------

export async function deleteAllStoredUserData(): Promise<DeleteUserDataResult> {
  const { repository: repo } = await ready();
  const result = await deleteAllUserData(
    repo,
    LOCAL_USER_ID,
    TMR_CIRCUIT_PROFILE.circuitId,
    TMR_CIRCUIT_PROFILE.layoutId,
    TMR_CIRCUIT_PROFILE.layoutVersion,
  );
  if (result.ok && historyStore !== null) await historyStore.refresh();
  return result;
}

// ---------------------------------------------------------------------------
// DevReplayScreen support (MUST DO #6, __DEV__ only).
// ---------------------------------------------------------------------------

/**
 * Restores `facade` to the production controller (C6 fix): disposes any
 * active DevReplay controller first (so its provider/watchdog cannot keep
 * running after the swap), then re-points `facadeWrapper` back at the
 * long-lived `productionFacade` -- no new `RealSessionFacade` is created, so
 * this never leaks a fresh controller subscription. A no-op if there is no
 * replay controller to dispose and the production controller is already
 * active. Called by `DevReplayScreen` on unmount and before starting a new
 * replay/mock session.
 */
export async function restoreProductionFacade(): Promise<void> {
  if (replayController !== null) {
    const stale = replayController;
    replayController = null;
    await stale.dispose();
  }
  if (controller !== null && productionFacade !== null) {
    activeController = controller;
    facadeWrapper.setInner(productionFacade);
  }
}

/**
 * Builds a fresh `SessionController` driven by `ReplayLocationProvider` (10x
 * accelerated) over the SAME real repository/profile/user as the production
 * controller, wraps it in a `RealSessionFacade`, and swaps it in as the
 * app's active `facade` -- so `CalibrationInstructionsScreen`,
 * `ActiveCalibrationScreen`, `CalibrationResultScreen`, and
 * `ActiveDashboardScreen` (unmodified, real production screens) drive this
 * replay session exactly like a live one. Results land in the real SQLite
 * history. __DEV__-only; never referenced outside `DevReplayScreen`.
 *
 * C6 fix: disposes any PREVIOUS replay controller first (defense in depth --
 * `DevReplayScreen` itself already calls `restoreProductionFacade()` before
 * starting a new replay, but this guards any other call path too), so an
 * unfinished earlier replay can never keep its provider/watchdog alive after
 * this swap.
 *
 * Time domain: the controller is given a `ScaledReplayClock` reading a
 * shared `ReplayTimeSource` (`virtualNow = virtualStart + realElapsed *
 * speedFactor`), and samples are re-stamped into that SAME virtual domain by
 * `ReplayTimestampedLocationProvider` -- both driven by `PerformanceNowClock`
 * as the real-time reference. This preserves the fixture's own inter-sample
 * spacing (so `TelemetryQualityEvaluator`'s implied-speed check reads the
 * real recorded speeds, not the speeds compressed by the 10x delivery pace)
 * while still delivering samples at the accelerated wall-clock pace. See
 * `liveTimestampedProvider.ts`'s module doc comment for the full rationale,
 * including watchdog-timing compatibility and cross-run monotonicity. The
 * production GNSS path is unaffected -- it keeps `PerformanceNowClock`
 * directly as `clock` and the raw, un-wrapped `GnssLocationProvider` (see
 * `createProductionController()` above).
 *
 * `restartProvider` (invoked by the ADR-0003 §1 watchdog -- e.g. once a
 * short fixture drains and the app idles on Calibration Result/armed while
 * the watchdog's real-time poll notices no further samples) MUST restart
 * `replayProvider` (the wrapper), not `replayInner` directly: only the
 * wrapper's own `start()` begins a new `ReplayTimeSource` run (re-anchoring
 * at `virtualNow()`, per `liveTimestampedProvider.ts`'s `beginRun()`). A raw
 * `replayInner` restart bypasses that and keeps re-emitting samples through
 * the wrapper's ORIGINAL, by-then-stale anchor -- exactly the follow-up
 * pacing bug (`currentLapMs` showing minutes within seconds of the first
 * crossing after an idle calibration-review pause).
 */
export async function startDevReplaySession(samples: LocationSample[]): Promise<void> {
  const { repository: repo } = await ready();
  if (replayController !== null) {
    const stale = replayController;
    replayController = null;
    await stale.dispose();
  }
  const speedFactor = 10;
  const realClock = new PerformanceNowClock();
  const timeSource = new ReplayTimeSource(realClock, speedFactor);
  const clock = new ScaledReplayClock(timeSource);
  const replayInner = new ReplayLocationProvider(samples, { speedFactor });
  const replayProvider: LocationProvider = new ReplayTimestampedLocationProvider(replayInner, timeSource);

  const devController = new SessionController({
    runtimeProfile: TMR_RUNTIME_PROFILE,
    circuitProfile: TMR_CIRCUIT_PROFILE,
    locationProvider: replayProvider,
    clock,
    repository: repo,
    userId: LOCAL_USER_ID,
    appVersion: appVersion(),
    algorithmVersion: ALGORITHM_VERSION,
    restartProvider: async () => {
      await replayProvider.stop();
      await replayProvider.start();
    },
  });

  replayController = devController;
  activeController = devController;
  facadeWrapper.setInner(
    new RealSessionFacade(devController, {
      // Same post-session cache refresh the production facade gets, so a
      // finished replay session appears in Session History immediately. The
      // active-session pointer is deliberately NOT set for replays — a dev
      // replay must never trigger the recovery banner on next launch.
      onSessionEnded: () => {
        void historyStore?.refresh();
      },
    }),
  );
}

/**
 * Swaps the active `facade` back to a fresh `MockSessionFacade` --
 * DevReplayScreen's `__DEV__` mock toggle. C6 fix: disposes any active replay
 * controller first (defense in depth -- `DevReplayScreen` already calls
 * `restoreProductionFacade()` before this), so switching to the scripted mock
 * can never leave an unfinished replay's provider/watchdog running underneath.
 */
export function useMockFacadeForDevReplay(): void {
  if (replayController !== null) {
    const stale = replayController;
    replayController = null;
    void stale.dispose();
  }
  activeController = null;
  facadeWrapper.setInner(new MockSessionFacade());
}

// ---------------------------------------------------------------------------
// Live diagnostics (MUST DO #3). `GnssDiagnostics` (`platform/gnssLocationProvider.ts`)
// previously had zero UI call sites -- surfaced here as a single composition-level
// accessor `SettingsScreen` and `DevReplayScreen` both read, combining the raw
// GNSS-provider counters with the session-level counters `SessionController.diagnostics()`
// already tracked (rejected-sample count, watchdog restarts). Read-on-demand only
// (screens call this on focus / a manual refresh button) -- deliberately NOT a
// subscription or polling timer, so it adds no background work while a session
// is timing (ticket's explicit "no polling timers while a session is timing").
// ---------------------------------------------------------------------------

export interface LiveDiagnosticsSnapshot {
  controller: SessionControllerDiagnostics;
  /**
   * `null` when the active session isn't the production GNSS-backed one
   * (e.g. mid dev-replay, which drives a `ReplayLocationProvider` instead --
   * there's no real GNSS stream to report on) or before the production
   * `GnssLocationProvider` has been constructed (still booting).
   */
  gnss: GnssDiagnostics | null;
}

/** Snapshot of whichever session is currently live, or `null` before any controller exists (still booting). */
export function getLiveDiagnostics(): LiveDiagnosticsSnapshot | null {
  if (activeController === null) return null;
  return {
    controller: activeController.diagnostics(),
    gnss: activeController === controller && gnssProvider !== null ? gnssProvider.getDiagnostics() : null,
  };
}

/**
 * Estimates the observed GNSS fix rate (Hz) from `GnssDiagnostics.sampleIntervalHistogramMs`'s
 * bucketed inter-sample-interval counts -- `GnssLocationProvider` itself tracks
 * no single rate figure, only the histogram (`platform/gnssLocationProvider.ts`
 * is outside this ticket's write set, so this stays a pure display computation
 * here rather than a new field added there). Uses each bucket's midpoint
 * (the open-ended last bucket's own upper bound plus 1s, arbitrarily but
 * clearly marked in the UI as `5000ms+` when it dominates) weighted by count,
 * inverted to Hz. `null` when no windowed samples have been observed yet.
 */
export function estimateObservedRateHz(histogram: GnssDiagnostics['sampleIntervalHistogramMs']): number | null {
  const totalCount = histogram.reduce((sum, bucket) => sum + bucket.count, 0);
  if (totalCount === 0) return null;
  const weightedMs = histogram.reduce((sum, bucket) => {
    const midpointMs = bucket.maxMs === null ? bucket.minMs + 1_000 : (bucket.minMs + bucket.maxMs) / 2;
    return sum + midpointMs * bucket.count;
  }, 0);
  const meanIntervalMs = weightedMs / totalCount;
  return meanIntervalMs > 0 ? 1_000 / meanIntervalMs : null;
}
