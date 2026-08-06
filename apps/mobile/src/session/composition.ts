import Constants from 'expo-constants';
import type { LocationProvider, LocationSample, SessionMachineSnapshot, SqlDatabase, SqlSessionRepository } from '@circuit/core';
import { SessionController } from '@circuit/core';
import { GnssLocationProvider, PerformanceNowClock, ReplayLocationProvider } from '../platform';
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
import { LiveTimestampedLocationProvider } from './liveTimestampedProvider';
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
let repository: SqlSessionRepository | null = null;
let controller: SessionController | null = null;
let gnssProvider: GnssLocationProvider | null = null;

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
  const opened = await openAppDatabase(DB_NAME);
  db = opened.db;
  repository = opened.repository;

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

  const history = new SqlSessionHistoryStore(
    repository,
    LOCAL_USER_ID,
    TMR_CIRCUIT_PROFILE.circuitId,
    TMR_CIRCUIT_PROFILE.layoutId,
    TMR_CIRCUIT_PROFILE.layoutVersion,
  );
  await history.refresh();
  historyWrapper.setInner(history);

  const settings = await SqlSettingsStore.create(db);
  settingsWrapper.setInner(settings);

  facadeWrapper.setInner(
    new RealSessionFacade(controller, {
      onSessionStarted: (sessionId) => {
        void setActiveSessionId(db!, sessionId);
      },
      onSessionEnded: () => {
        void setActiveSessionId(db!, null).then(() => history.refresh());
      },
    }),
  );

  const activeSessionId = await getActiveSessionId(db);
  if (activeSessionId !== null) {
    const checkpoint = await repository.loadCheckpoint(activeSessionId);
    if (checkpoint !== null && checkpoint.snapshot.state !== 'sessionComplete') {
      const recoveryLapCount = checkpoint.laps.length + (midSessionState(checkpoint.snapshot) ? 1 : 0);
      setPendingRecovery({ sessionId: activeSessionId, lapCount: recoveryLapCount });
    } else {
      await setActiveSessionId(db, null);
    }
  }
})();

/** Awaited by recovery/dev-replay actions below so they never race the async bootstrap. */
async function ready(): Promise<{ db: SqlDatabase; repository: SqlSessionRepository; controller: SessionController }> {
  await bootstrapPromise;
  if (db === null || repository === null || controller === null) {
    throw new Error('composition bootstrap failed to produce a database/repository/controller');
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
  await setActiveSessionId(database, null);
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
  await setActiveSessionId(database, null);
}

// ---------------------------------------------------------------------------
// DevReplayScreen support (MUST DO #6, __DEV__ only).
// ---------------------------------------------------------------------------

/**
 * Builds a fresh `SessionController` driven by `ReplayLocationProvider` (10x
 * accelerated, re-timestamped to the live clock -- see
 * `liveTimestampedProvider.ts`) over the SAME real repository/profile/user
 * as the production controller, wraps it in a `RealSessionFacade`, and swaps
 * it in as the app's active `facade` -- so `CalibrationInstructionsScreen`,
 * `ActiveCalibrationScreen`, `CalibrationResultScreen`, and
 * `ActiveDashboardScreen` (unmodified, real production screens) drive this
 * replay session exactly like a live one. Results land in the real SQLite
 * history. __DEV__-only; never referenced outside `DevReplayScreen`.
 */
export async function startDevReplaySession(samples: LocationSample[]): Promise<void> {
  const { repository: repo } = await ready();
  const clock = new PerformanceNowClock();
  const replayInner = new ReplayLocationProvider(samples, { speedFactor: 10 });
  const replayProvider: LocationProvider = new LiveTimestampedLocationProvider(replayInner, clock);

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
      await replayInner.stop();
      await replayInner.start();
    },
  });

  facadeWrapper.setInner(new RealSessionFacade(devController));
}

/** Swaps the active `facade` back to a fresh `MockSessionFacade` -- DevReplayScreen's `__DEV__` mock toggle. */
export function useMockFacadeForDevReplay(): void {
  facadeWrapper.setInner(new MockSessionFacade());
}
