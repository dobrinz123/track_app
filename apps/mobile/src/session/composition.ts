import Constants from 'expo-constants';
import type {
  LocationProvider,
  LocationSample,
  SessionControllerDiagnostics,
  SessionMachineSnapshot,
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
import { RealSessionFacade } from './realFacade';
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

  subscribe(cb: (s: FacadeState) => void): () => void {
    this.listeners.add(cb);
    cb(this.current);
    return () => {
      this.listeners.delete(cb);
    };
  }

  startPreflight(): void {
    this.inner.startPreflight();
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

/**
 * Single composition root for session-layer singletons consumed by
 * `apps/mobile/src/ui/**`. Screens must always import `facade`,
 * `sessionHistoryStore`, and `settingsStore` from here — never `Mock*` or
 * `Sql*`/`Real*` implementations directly.
 */
const facadeWrapper = new SwappableFacade(new MockSessionFacade());
export const facade: SessionFacade = facadeWrapper;

const historyWrapper = new SwappableSessionHistoryStore(new MockSessionHistoryStore());
export const sessionHistoryStore: SessionHistoryStore = historyWrapper;

const settingsWrapper = new SwappableSettingsStore(new InMemorySettingsStore());
export const settingsStore: SettingsStore = settingsWrapper;

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
// ---------------------------------------------------------------------------
startLifecycleListener({
  onBackground: () => {
    void activeController?.checkpointNow();
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

const bootstrapPromise = (async (): Promise<void> => {
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
  const clock = new PerformanceNowClock();
  const restartProvider = async (): Promise<void> => {
    await gnssProvider!.stop();
    await gnssProvider!.start();
  };

  controller = new SessionController({
    runtimeProfile: TMR_RUNTIME_PROFILE,
    circuitProfile: TMR_CIRCUIT_PROFILE,
    locationProvider: gnssProvider,
    clock,
    repository,
    userId: LOCAL_USER_ID,
    appVersion: appVersion(),
    algorithmVersion: ALGORITHM_VERSION,
    restartProvider,
  });
  activeController = controller;

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

  facadeWrapper.setInner(
    new RealSessionFacade(controller, {
      onSessionStarted: (sessionId) => {
        if (db !== null) void setActiveSessionId(db, sessionId);
      },
      onSessionEnded: () => {
        const clearPointer = db !== null ? setActiveSessionId(db, null) : Promise.resolve();
        void clearPointer.then(() => history.refresh());
      },
    }),
  );

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
})();

/** Awaited by recovery/dev-replay actions below so they never race the async bootstrap. */
async function ready(): Promise<{ db: SqlDatabase | null; repository: LocalSessionRepository; controller: SessionController }> {
  await bootstrapPromise;
  if (repository === null || controller === null) {
    throw new Error('composition bootstrap failed to produce a repository/controller');
  }
  return { db, repository, controller };
}

/**
 * Resumes a recovered session (ADR-0003 §3): restores historical laps into
 * the controller and arms it directly off the last-known stored reference
 * lap (`SessionController.start('session')` -- see that method's doc
 * comment for why this deliberately skips a live recalibration). Caller
 * (CircuitDetailScreen) navigates to `ActiveDashboard` after this resolves.
 */
export async function resumeRecovery(): Promise<void> {
  const info = pendingRecovery;
  if (info === null) return;
  const { db: database, repository: repo, controller: ctrl } = await ready();
  const checkpoint = await repo.loadCheckpoint(info.sessionId);
  if (checkpoint !== null) {
    ctrl.restoreFromCheckpoint(info.sessionId, checkpoint.snapshot, checkpoint.laps);
  }
  await ctrl.start('session');
  setPendingRecovery(null);
  if (database !== null) await setActiveSessionId(database, null);
}

/** Discards a recoverable checkpoint without resuming (ADR-0003 §3): marks it terminal so it is never offered again -- `LocalSessionRepository` has no delete method, so this overwrites the checkpoint's snapshot to `sessionComplete` instead. */
export async function discardRecovery(): Promise<void> {
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
 * Builds a fresh `SessionController` driven by `ReplayLocationProvider` (10x
 * accelerated) over the SAME real repository/profile/user as the production
 * controller, wraps it in a `RealSessionFacade`, and swaps it in as the
 * app's active `facade` -- so `CalibrationInstructionsScreen`,
 * `ActiveCalibrationScreen`, `CalibrationResultScreen`, and
 * `ActiveDashboardScreen` (unmodified, real production screens) drive this
 * replay session exactly like a live one. Results land in the real SQLite
 * history. __DEV__-only; never referenced outside `DevReplayScreen`.
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
 * the `bootstrapPromise` above).
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

/** Swaps the active `facade` back to a fresh `MockSessionFacade` -- DevReplayScreen's `__DEV__` mock toggle. */
export function useMockFacadeForDevReplay(): void {
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
