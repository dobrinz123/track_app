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
import { TMR_CIRCUIT_PROFILE, TMR_CORNERS, TMR_RUNTIME_PROFILE } from './tmrProfile';
import { startVoiceCoach } from './voiceCoach';
import { createTelemetryProvider, type TelemetryProvider } from './telemetryProvider';
import { TelemetryRecorder } from '../persistence/telemetryRecorder';
import { PASSTHROUGH_WRITE_GATE, type SqlWriteGate } from '../persistence/sqlWriteGate';

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

/** `error instanceof Error ? error.message : String(error)`, prefixed like `RealSessionFacade`'s own error mapping (F2 fix: the preflight gate's rejection surfaces through the SAME `FacadeState.lastError` channel a screen already observes, rather than becoming an unhandled promise rejection). */
function gateErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `startPreflight failed: ${detail}`;
}

/** Telemetry addendum — P4b amendment (binding): cap on how long the `sessionComplete` facade-state relay may be held for telemetry shutdown to settle. */
const SESSION_COMPLETE_BARRIER_CAP_MS = 2_000;

/**
 * Telemetry addendum — P4b amendment (binding): generic settle-or-cap relay
 * for facade-state broadcasts. Every state EXCEPT `'sessionComplete'` passes
 * through to `emit` immediately, unchanged. `'sessionComplete'` is held
 * until `getBarrier()`'s promise settles OR `capMs` elapses, whichever is
 * first -- allSettled semantics: a REJECTED or hung barrier promise never
 * blocks past the cap and never rejects/throws through this relay.
 * `getBarrier()` returning `null` means there is nothing to wait for -- the
 * state passes straight through synchronously, with NO timer ever created
 * (zero added latency when telemetry never ran this session). Any state that
 * arrives while a hold is in progress is queued and relayed, IN ORDER, only
 * after the held state itself has been relayed -- so nothing emitted after
 * `sessionComplete` can ever overtake it.
 *
 * A free function (not a `SwappableFacade` method) deliberately: it has no
 * dependency on SQLite/GNSS/React wiring, so this exact algorithm is
 * directly unit-testable (MUST DO #1) by calling it with hand-built
 * promises/fake timers, independent of composition.ts's own bootstrap.
 */
export function relaySessionCompleteBarrier<S extends { sessionState: string }>(
  getBarrier: () => Promise<void> | null,
  capMs: number,
  emit: (s: S) => void,
): (s: S) => void {
  let holding = false;
  let queue: S[] = [];

  function relay(s: S): void {
    if (holding) {
      queue.push(s);
      return;
    }
    if (s.sessionState !== 'sessionComplete') {
      emit(s);
      return;
    }
    const barrier = getBarrier();
    if (barrier === null) {
      emit(s);
      return;
    }
    holding = true;
    let settled = false;
    const timer = setTimeout(() => finish(), capMs);
    barrier.then(finish, finish);
    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      holding = false;
      emit(s);
      const queued = queue;
      queue = [];
      for (const queuedState of queued) relay(queuedState);
    }
  }

  return relay;
}

class SwappableFacade implements SessionFacade {
  private inner: SessionFacade;
  private innerUnsubscribe: () => void;
  private current!: FacadeState;
  private readonly listeners = new Set<(s: FacadeState) => void>();
  /** Telemetry addendum — P4b amendment: supplies the in-flight/settled telemetry-shutdown promise (or `null` when nothing is/was recording) for `relay` below to gate the `sessionComplete` broadcast on. Set once by composition.ts's bootstrap wiring (`setSessionCompleteBarrier`), read fresh on every `'sessionComplete'` state that arrives. */
  private sessionCompleteBarrier: (() => Promise<void> | null) | null = null;
  /** The single relay every inner-facade state passes through on its way to `this.listeners` -- see `relaySessionCompleteBarrier` above. Built once in the constructor so its hold/queue state persists across `setInner` swaps (a queued state from a just-replaced inner must still be relayed, in order, relative to states from the NEW inner). */
  private readonly relay: (s: FacadeState) => void;
  /**
   * One-shot-controller gate (C1 fix). When set, every `startPreflight()`
   * call runs this first and awaits it before forwarding the command to
   * `inner` -- composition.ts uses it to dispose and swap in a fresh
   * production controller/facade if the current one is terminal
   * (`sessionComplete`/`error`) before a new session can begin.
   */
  private preflightGate: (() => Promise<void>) | null = null;
  /**
   * F2 fix (C1 residue): the SAME in-flight gate promise is shared by every
   * `startPreflight()` call that arrives while it's still running, instead
   * of each concurrent call invoking `gate()` (dispose + install a fresh
   * controller) independently -- which raced two replacements against each
   * other. Cleared once the shared attempt settles (success OR failure) so
   * the NEXT `startPreflight()` call starts a fresh gate run.
   */
  private gateInFlight: Promise<void> | null = null;
  /**
   * F2 fix (WPT3, binding): fired synchronously, INSIDE `endSession()`
   * below, BEFORE forwarding the command to `inner` -- so telemetry shutdown
   * starts at the earliest point this wrapper can act, independent of
   * whether `inner.endSession()`'s own (fire-and-forget, per `SessionFacade`)
   * async work later succeeds or rejects. `RealSessionFacadeCallbacks.onSessionEnded`
   * (realFacade.ts, out of this ticket's write set) fires ONLY on the
   * controller-persistence SUCCESS path -- a rejected `controller.endSession()`
   * never reaches it at all, which previously left telemetry recording
   * running forever whenever session-end persistence failed. This hook does
   * not have that gap.
   */
  private endSessionSideEffect: (() => void) | null = null;

  constructor(initial: SessionFacade) {
    this.relay = relaySessionCompleteBarrier<FacadeState>(
      () => this.sessionCompleteBarrier?.() ?? null,
      SESSION_COMPLETE_BARRIER_CAP_MS,
      (s) => this.commit(s),
    );
    this.inner = initial;
    this.innerUnsubscribe = initial.subscribe((s) => this.relay(s));
  }

  private commit(s: FacadeState): void {
    this.current = s;
    for (const listener of this.listeners) listener(s);
  }

  /** Swaps the active implementation. Existing subscribers keep working -- they're subscribed to this wrapper, not `inner`. */
  setInner(next: SessionFacade): void {
    this.innerUnsubscribe();
    this.inner = next;
    this.innerUnsubscribe = next.subscribe((s) => this.relay(s));
  }

  setPreflightGate(gate: (() => Promise<void>) | null): void {
    this.preflightGate = gate;
  }

  setEndSessionSideEffect(fn: (() => void) | null): void {
    this.endSessionSideEffect = fn;
  }

  /** Telemetry addendum — P4b amendment: installs the getter `relay` (via the constructor's `relaySessionCompleteBarrier`) consults every time a `'sessionComplete'` state arrives. `null` clears it back to "nothing to wait for". */
  setSessionCompleteBarrier(fn: (() => Promise<void> | null) | null): void {
    this.sessionCompleteBarrier = fn;
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
    let inFlight = this.gateInFlight;
    if (inFlight === null) {
      inFlight = gate();
      this.gateInFlight = inFlight;
      // `.finally()` re-throws on a rejected `inFlight`, producing its own
      // (otherwise unobserved) derived promise -- the actual per-call
      // `.then()/.catch()` below is what handles the rejection for callers;
      // this trailing `.catch(() => undefined)` exists ONLY to keep THIS
      // bookkeeping promise from being reported as an unhandled rejection.
      inFlight
        .finally(() => {
          if (this.gateInFlight === inFlight) this.gateInFlight = null;
        })
        .catch(() => undefined);
    }
    inFlight
      .then(() => {
        // Forwarded only on the gate's success path: if it rejected, `inner`
        // is whatever it was before this call (the gate itself never swaps
        // it on failure -- see `installProductionController`'s callers), so
        // that STALE facade must never receive this command.
        this.inner.startPreflight();
      })
      .catch((error: unknown) => {
        // No unhandled rejection, and no silent failure: surfaced through
        // the same `FacadeState.lastError` field `RealSessionFacade`
        // already exposes, on THIS wrapper's own broadcast (not `inner`'s,
        // which never changed).
        if (this.current === undefined) return;
        const next = { ...this.current, lastError: gateErrorMessage(error) };
        this.current = next;
        for (const listener of this.listeners) listener(next);
      });
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
    this.endSessionSideEffect?.();
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
  coachCue: null,
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
// Voice coaching (Phase 3 coaching addendum). Wired against the SAME stable
// `facade`/`settingsStore` bindings above -- survives every inner swap
// (bootstrap activation, DevReplay start/restore) because it subscribes to
// the wrapper, not whatever it currently delegates to. `voiceCoach.ts` only
// ever reaches `expo-speech` via a lazy dynamic import gated on
// `voiceCoachEnabled` (default `false`), so this call is safe at module load
// even in tests that never mock `expo-speech`.
// ---------------------------------------------------------------------------
startVoiceCoach(facade, settingsStore);

// ---------------------------------------------------------------------------
// Telemetry (Phase 4 / P4a, Telemetry addendum). `telemetryProvider` is a
// single long-lived singleton (its own clock, independent of any particular
// `SessionController` build) exported for `TelemetryScreen`'s manual
// start/stop monitor. Session-scoped RECORDING -- batching samples into
// `telemetry_samples` and tagging them with the currently-known lap number --
// is wired separately below, into `productionFacadeCallbacks()`'s
// `onSessionStarted`/`onSessionEnded` hooks (MUST DO (g): "provider
// starts/stops with the session lifecycle"). MUST NOT interact with lap
// timing in any way: nothing here ever calls into `facade`'s commands or
// `SessionController` -- only the one-way sample subscription below.
// ---------------------------------------------------------------------------
const telemetryClock = new PerformanceNowClock();
// F8 fix (WPT3, binding): the REAL React Native `__DEV__` global, wired in
// explicitly here (`typeof` guard so this module still loads under vitest,
// which never defines it) -- `telemetryProvider.ts`'s own `isDev` gate
// defaults to the same thing when omitted, but composition.ts is where
// production actually wires it, per this ticket's binding design.
// eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
const telemetryIsDev = typeof __DEV__ !== 'undefined' ? __DEV__ : false;
export const telemetryProvider: TelemetryProvider = createTelemetryProvider({
  settingsStore,
  monotonicNow: () => telemetryClock.now(),
  isDev: telemetryIsDev,
});

let telemetryRecorder: TelemetryRecorder | null = null;
/** In-flight telemetry shutdown (F2 residue fix) -- repeated `stopTelemetryRecording()` calls return this same promise so `onSessionEnded`'s barrier awaits the REAL final flush. Cleared on the next `startTelemetryRecording()`. */
let telemetryShutdown: Promise<void> | null = null;
let telemetryCurrentLapNumber: number | null = null;
let unsubscribeTelemetrySample: (() => void) | null = null;
let unsubscribeTelemetryLapWatch: (() => void) | null = null;

/**
 * Tears down the active recording (if any) and stops `telemetryProvider`.
 * Idempotent (a second concurrent/later call while the first is still
 * in-flight, or after everything is already torn down, is a harmless no-op)
 * -- called from THREE places (F2 fix, WPT3, binding): `SwappableFacade`'s
 * `endSession()` command hook (fires the INSTANT `facade.endSession()` is
 * called, regardless of whether the underlying controller persistence
 * later succeeds or rejects), `productionFacadeCallbacks().onSessionEnded`
 * (the success-path callback, as a defensive second call), and
 * `rebuildProductionController()` (the `'error'`-terminal-state path, which
 * does not run through `endSession()` at all).
 *
 * Returns a promise so a caller CAN await full shutdown (the command hook
 * and `onSessionEnded` both join it into a `Promise.allSettled`) -- never
 * rejects (`Promise.allSettled` internally + `recorder.dispose()` in a
 * `finally`), so a telemetry-side failure can never surface as, or block,
 * a session-end/lap-persistence failure (binding: "telemetry NEVER gates
 * lap timing").
 */
function stopTelemetryRecording(): Promise<void> {
  // F2 residue fix (LEAD takeover): the endSession command hook fires this
  // first (fire-early, promise intentionally not awaited there), then
  // `onSessionEnded` calls it AGAIN inside its `Promise.allSettled` barrier.
  // Returning the SAME in-flight promise on that second call is what makes
  // the barrier actually await the real final flush -- previously the second
  // call saw `telemetryRecorder === null` and resolved after a bare
  // `provider.stop()`, leaving the true flush unawaited.
  if (telemetryRecorder === null && telemetryShutdown !== null) return telemetryShutdown;
  const recorder = telemetryRecorder;
  telemetryRecorder = null;
  unsubscribeTelemetrySample?.();
  unsubscribeTelemetrySample = null;
  unsubscribeTelemetryLapWatch?.();
  unsubscribeTelemetryLapWatch = null;
  telemetryCurrentLapNumber = null;
  if (recorder === null) {
    // P4b amendment: nothing was ever recording for the session that just
    // ended -- there is no real shutdown work to await. Fire `provider.stop()`
    // defensively (a harmless no-op if it never started) without awaiting it,
    // and leave `telemetryShutdown` at `null` (already the case here --
    // `startTelemetryRecording()` unconditionally clears it up front, see
    // there -- this assignment is just defense in depth against any other
    // call path) so the sessionComplete barrier's getter below reads
    // "nothing to wait for" and relays with genuinely zero added latency: no
    // timer is ever created for this path (binding spec).
    telemetryShutdown = null;
    void telemetryProvider.stop();
    return Promise.resolve();
  }
  telemetryShutdown = (async () => {
    try {
      const results = await Promise.allSettled([telemetryProvider.stop(), recorder.endSession()]);
      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn('[composition] telemetry shutdown step failed', result.reason);
        }
      }
    } finally {
      recorder.dispose();
    }
  })();
  return telemetryShutdown;
}

/** Starts recording for `sessionId` (no-op if telemetry is disabled or there is no on-device database, e.g. web preview) and starts `telemetryProvider`. Samples are tagged with `telemetryCurrentLapNumber`, updated whenever `facade`'s `lapNumber` changes -- a lap-crossing flush is also queued at that point (Telemetry addendum: "flushed on lap crossing"). */
function startTelemetryRecording(sessionId: string): void {
  // P4b amendment: cleared unconditionally, up front -- even on the
  // early-return (disabled/no on-device db) paths below -- so a session that
  // ends up NOT recording never lets the sessionComplete barrier mistake an
  // already-settled `telemetryShutdown` promise LEFT OVER from an earlier,
  // unrelated session for "this session's shutdown is still in flight" (which
  // would otherwise still create -- and immediately clear -- a barrier timer,
  // violating the binding "zero added latency, no timer" requirement for the
  // never-ran case).
  telemetryShutdown = null;
  if (db === null) return;
  if (!settingsStore.getSettings().telemetryEnabled) return;

  const recorder = new TelemetryRecorder(db, sessionId, undefined, dbWriteGate ?? undefined);
  telemetryRecorder = recorder;
  telemetryCurrentLapNumber = null;

  unsubscribeTelemetrySample = telemetryProvider.onSample((sample) => {
    recorder.record(sample, telemetryCurrentLapNumber);
  });
  unsubscribeTelemetryLapWatch = facade.subscribe((state) => {
    // F4 fix (WPT3, binding): `facade.subscribe()` calls back synchronously
    // with the CURRENT state on every subscribe, including lap 0
    // (calibration/armed/out-lap -- no lap has started yet) -- `lapNumber`'s
    // own binding meaning for "no lap in progress" is `0`, but
    // `telemetry_samples.lap_number`'s binding meaning for the same thing is
    // `NULL` (Telemetry addendum: "lap_number NULLABLE"). Map here so
    // pre-lap samples are tagged `NULL`, not the numeral `0`.
    const mappedLap = state.lapNumber === 0 ? null : state.lapNumber;
    if (telemetryCurrentLapNumber === mappedLap) return;
    telemetryCurrentLapNumber = mappedLap;
    recorder.flushOnLapCrossing();
  });

  telemetryProvider.start();
}

// F2 fix (WPT3, binding): registered once at module load (independent of
// bootstrap, mirroring `startLifecycleListener`'s own registration just
// below) -- `facade.endSession()` always triggers telemetry shutdown, no
// matter which inner facade (production, DevReplay, mock) is currently
// active or whether the controller's own persistence succeeds. Harmless when
// nothing is currently recording (`stopTelemetryRecording()` is idempotent).
facadeWrapper.setEndSessionSideEffect(() => {
  void stopTelemetryRecording();
});

// Telemetry addendum — P4b amendment (binding): the `sessionComplete` facade
// state is held until `telemetryShutdown` settles (capped, allSettled) --
// see `relaySessionCompleteBarrier`/`SwappableFacade` above. Read fresh
// every time a `'sessionComplete'` state arrives: by then,
// `endSessionSideEffect` above has ALREADY run synchronously inside
// `SwappableFacade.endSession()` (before `inner.endSession()` was even
// forwarded), so `telemetryShutdown` already reflects the shutdown this
// specific session's teardown kicked off -- or stays `null` when nothing
// was ever recording (disabled/web), giving that path zero added latency.
facadeWrapper.setSessionCompleteBarrier(() => telemetryShutdown);

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

/**
 * F5 fix (C10 residue): a lastError-style inline notice for recovery
 * operations that fail in a way `PendingRecovery`'s own banner can't
 * represent -- specifically, `resumeRecovery()` discovering the checkpoint
 * it was about to resume has vanished from disk between bootstrap's initial
 * read and the resume attempt. `CircuitDetailScreen` renders this as a
 * non-modal error banner, mirroring `bootstrapState==='failed'`'s.
 */
let recoveryNotice: string | null = null;
const recoveryNoticeListeners = new Set<(n: string | null) => void>();

function setRecoveryNotice(next: string | null): void {
  recoveryNotice = next;
  for (const listener of recoveryNoticeListeners) listener(next);
}

export function subscribeRecoveryNotice(cb: (n: string | null) => void): () => void {
  recoveryNoticeListeners.add(cb);
  cb(recoveryNotice);
  return () => {
    recoveryNoticeListeners.delete(cb);
  };
}

// ---------------------------------------------------------------------------
// Production bootstrap: opens the on-device SQLite database, builds the real
// `SessionController` + `GnssLocationProvider`, checks for a recoverable
// checkpoint, and swaps every wrapper above from its in-memory placeholder
// to the real implementation. Kicked off once, at module load.
// ---------------------------------------------------------------------------

let db: SqlDatabase | null = null;
/** Shared transaction/telemetry write gate from `openAppDatabase()` (N1 fix) -- null on the in-memory/web path, where there is no shared connection to protect. */
let dbWriteGate: SqlWriteGate | null = null;
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
 * Phase 3 coaching addendum config shared by every `SessionController` this
 * module builds (production AND DevReplay, MUST DO #2) -- `TMR_CORNERS` is
 * the single, once-computed corner set (`tmrProfile.ts`); `enabled` is read
 * fresh from `settingsStore` at EACH controller-build call site so a toggle
 * flip is honored by the next controller built (a running controller's
 * coaching config is fixed for its own lifetime -- see
 * `SessionControllerDeps.coaching`'s own doc comment in `@circuit/core`).
 */
function coachingConfig(): { enabled: boolean; corners: typeof TMR_CORNERS } {
  return { enabled: settingsStore.getSettings().coachingEnabled, corners: TMR_CORNERS };
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
    coaching: coachingConfig(),
  });
}

/** Callbacks shared by every production `RealSessionFacade` (initial bootstrap AND any later C1 terminal-state rebuild), so the active-session-pointer/history-refresh wiring can never drift between them. */
function productionFacadeCallbacks(): RealSessionFacadeCallbacks {
  return {
    onSessionStarted: (sessionId) => {
      if (db !== null) void setActiveSessionId(db, sessionId);
      startTelemetryRecording(sessionId);
    },
    onSessionEnded: () => {
      // F2 fix (WPT3, binding): both kicked off independently (neither
      // awaits/depends on the other), then joined via `Promise.allSettled`
      // so an error in either is isolated -- a rejected `controllerPersistence`
      // (the active-session-pointer clear + history refresh) can never
      // suppress the telemetry flush, and vice versa. `telemetryFinalFlush`
      // is ALSO already independently guaranteed to run by
      // `SwappableFacade`'s `endSessionSideEffect` hook (fires the instant
      // `facade.endSession()` was called, before this success-only callback
      // even exists to be scheduled) -- calling `stopTelemetryRecording()`
      // again here is a defensive, idempotent no-op in the common case, and
      // matters only if that hook were ever bypassed.
      const controllerPersistence = (async () => {
        if (db !== null) await setActiveSessionId(db, null);
        await historyStore?.refresh();
      })();
      const telemetryFinalFlush = stopTelemetryRecording();
      void Promise.allSettled([controllerPersistence, telemetryFinalFlush]).then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            console.warn('[composition] session-end persistence step failed', result.reason);
          }
        }
      });
    },
  };
}

/**
 * Builds a fresh production `SessionController` + `RealSessionFacade` and
 * assigns them to `controller`/`activeController`/`productionFacade` --
 * WITHOUT swapping `facadeWrapper`'s inner (F3 fix: that swap is
 * `activateProductionFacade()` below, done separately so callers that need
 * a staging window -- initial bootstrap -- can build first and activate
 * only once everything else is actually ready).
 */
function buildProductionController(): void {
  const freshController = createProductionController();
  controller = freshController;
  activeController = freshController;
  productionFacade = new RealSessionFacade(freshController, productionFacadeCallbacks());
}

/**
 * Swaps `facadeWrapper`'s inner to the current `productionFacade` -- the
 * ONLY place the real production facade is ever exposed to `apps/mobile/src/ui/**`
 * (F3 fix). Until this runs, every command still reaches the inert
 * `PendingFacade`/whatever `facadeWrapper` was last pointed at, no matter
 * how far `buildProductionController()`/the rest of bootstrap has otherwise
 * progressed.
 */
function activateProductionFacade(): void {
  if (productionFacade !== null) facadeWrapper.setInner(productionFacade);
}

/** Builds AND immediately activates a fresh production controller in one step -- used by the preflight gate's terminal-state rebuild (`setPreflightGate` below), where bootstrap is already `'ready'` and there is no staging window to preserve. */
function installProductionController(): void {
  buildProductionController();
  activateProductionFacade();
}

/**
 * Shared, serialized rebuild (F3 fix) -- disposes the current production
 * controller/facade and installs a fresh one. Used by BOTH the preflight
 * gate's terminal-state rebuild (C1 fix, below) and the coaching-settings
 * rebuild (F3 fix, below): `rebuildInFlight` makes the two mutually
 * exclusive -- whichever starts first is awaited by whichever calls in
 * while it's still running, instead of two dispose+install attempts racing
 * each other. This IS "the gate's serialization", generalized to its
 * second trigger. A no-op while a DevReplay controller is active
 * (`activeController !== controller`) -- that swap is
 * `restoreProductionFacade()`'s job, not this rebuild's.
 */
let rebuildInFlight: Promise<void> | null = null;

function rebuildProductionController(): Promise<void> {
  if (rebuildInFlight !== null) return rebuildInFlight;
  const attempt = (async () => {
    if (controller === null || activeController !== controller) return;
    const staleController = controller;
    const staleFacade = productionFacade;
    // Telemetry addendum (g): defensively stop any still-active recording
    // before the controller it was recording alongside is disposed -- in the
    // normal flow `onSessionEnded` (above) already did this; this guards the
    // 'error' terminal-state path, which does not run through `endSession()`.
    // Awaited (F2 fix) so the final flush actually lands before disposal
    // proceeds, instead of racing ahead of it.
    await stopTelemetryRecording();
    await staleController.dispose();
    staleFacade?.dispose();
    installProductionController();
  })();
  rebuildInFlight = attempt;
  attempt
    .finally(() => {
      if (rebuildInFlight === attempt) rebuildInFlight = null;
    })
    .catch(() => undefined);
  return attempt;
}

/**
 * F3 fix: `coachingConfig()` is baked into a `SessionController` for its own
 * whole lifetime (`SessionControllerDeps.coaching`'s own doc comment) --
 * previously, flipping the coaching toggle before the first session (or
 * while idle between sessions) had NO effect until some UNRELATED
 * terminal-state rebuild happened to fire later; the UI showed a fresh
 * coaching slot immediately, but it stayed empty. Rebuild immediately
 * whenever `coachingEnabled` actually CHANGES while the controller is
 * genuinely not in an active session (idle/sessionComplete/error). A
 * mid-active-session change is deliberately left alone here -- tearing down
 * live timing/GNSS state under a driver mid-lap would be far worse than a
 * stale coaching setting for one more lap -- `SettingsScreen` shows a note
 * that it takes effect next session instead. Routed through the SAME
 * `rebuildProductionController()` the preflight gate uses, so the two can
 * never race. Registered ONCE at module load (not inside `runBootstrap()`,
 * which re-runs on `retryBootstrap()`) so a failed-then-retried bootstrap
 * never accumulates duplicate subscriptions -- this callback reads the
 * live module-level `controller`/`activeController` on every invocation
 * regardless of how many times bootstrap itself has (re)run, and is a
 * harmless no-op before `controller` exists yet.
 */
let lastKnownCoachingEnabled = settingsStore.getSettings().coachingEnabled;
const COACHING_REBUILD_STATES = new Set<SessionState>(['idle', 'sessionComplete', 'error']);
settingsStore.subscribe((settings) => {
  const changed = settings.coachingEnabled !== lastKnownCoachingEnabled;
  lastKnownCoachingEnabled = settings.coachingEnabled;
  if (!changed) return;
  if (controller === null || activeController !== controller) return;
  const state = currentControllerState(controller);
  if (!COACHING_REBUILD_STATES.has(state)) return;
  void rebuildProductionController();
});

/**
 * Runs the full bootstrap sequence: opens the on-device SQLite database,
 * builds the real `SessionController` + `GnssLocationProvider`, checks for a
 * recoverable checkpoint, and swaps every wrapper above from its in-memory
 * placeholder to the real implementation. Named (not an anonymous IIFE) and
 * re-invocable -- F3 fix's `retryBootstrap()` below calls it again from a
 * clean slate after a failed attempt.
 */
async function runBootstrap(): Promise<void> {
  try {
    // F3 fix: clean slate -- discard anything a previous, failed attempt may
    // have partially built, so a retry never reuses a possibly-inconsistent
    // db/controller/facade left over from that attempt.
    db = null;
    repository = null;
    controller = null;
    productionFacade = null;
    gnssProvider = null;
    historyStore = null;
    activeController = null;

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
      dbWriteGate = opened.writeGate;
      repository = opened.repository;
    }

    gnssProvider = new GnssLocationProvider();

    // Settings are hydrated BEFORE the production controller is built
    // (reordered ahead of its historical position further down) so
    // `createProductionController()`'s read of `settingsStore.getSettings()
    // .coachingEnabled` (Phase 3 coaching addendum) reflects the user's
    // actually-persisted preference on the very first controller this
    // process builds -- not the in-memory placeholder's default. `facade`
    // itself still stays on the inert `PendingFacade` regardless (that gate
    // is `activateProductionFacade()` below), so this reorder changes
    // nothing about when commands become live.
    if (db !== null) {
      const settings = await SqlSettingsStore.create(db);
      settingsWrapper.setInner(settings);
    }

    // F3 fix: build the production controller/facade now (so `controller`
    // exists for the preflight gate registered just below), but do NOT
    // activate it yet -- `facade` stays on the inert placeholder until
    // `activateProductionFacade()` runs, immediately before `'ready'`, once
    // history/settings/recovery have ALL actually finished initializing.
    buildProductionController();

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
      await rebuildProductionController();
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

    // F3 fix: the ONLY place the real production facade becomes reachable --
    // immediately before 'ready', now that history/settings/recovery have
    // ALL genuinely finished. Every command issued before this line still
    // reaches the inert `PendingFacade` no matter how much of the sequence
    // above already ran.
    activateProductionFacade();
    setBootstrapState('ready');
  } catch (error) {
    // C2 fix: previously an uncaught bootstrap rejection left `facade` on a
    // live, fully-functional `MockSessionFacade` -- calibration could start
    // against a fake timer with no persistence and no user-visible error.
    // F3 fix: `facade`'s inner NOW genuinely stays the inert `PendingFacade`
    // on this path (never `activateProductionFacade()`d -- that call is the
    // very last thing the try block does, after every other step already
    // succeeded), matching what this comment always claimed. `bootstrapState`
    // flips to 'failed' so `CircuitDetailScreen` can show a non-modal error
    // banner (with an inline Retry button, see `retryBootstrap()` below) and
    // keep "Start Session" disabled.
    console.error('[composition] bootstrap failed', error);
    setBootstrapState('failed');
    throw error;
  }
}

let bootstrapPromise: Promise<void> = runBootstrap();
// Bootstrap failures are observable via `bootstrapState`/`subscribeBootstrapState`
// and (for callers that specifically await it) `ready()`'s own rethrow below --
// this no-op catch only prevents Node/Hermes from ever reporting the module-load
// promise itself as an unhandled rejection when nothing else happens to consume it.
bootstrapPromise.catch(() => undefined);

/**
 * F3 fix: re-runs `runBootstrap()` from a clean slate -- e.g. from
 * `CircuitDetailScreen`'s inline Retry button once `bootstrapState` has
 * flipped to `'failed'` -- so a transient failure (a locked/corrupt database
 * file, a one-off native-module hiccup) doesn't require a full app restart
 * to recover from. Concurrent calls share the SAME in-flight attempt instead
 * of racing two bootstraps against each other.
 */
let bootstrapRetryInFlight: Promise<void> | null = null;

export async function retryBootstrap(): Promise<void> {
  if (bootstrapRetryInFlight !== null) return bootstrapRetryInFlight;
  setBootstrapState('pending');
  const attempt = runBootstrap();
  bootstrapPromise = attempt;
  attempt.catch(() => undefined);
  const trackedAttempt = attempt.finally(() => {
    if (bootstrapRetryInFlight === trackedAttempt) bootstrapRetryInFlight = null;
  });
  bootstrapRetryInFlight = trackedAttempt;
  return trackedAttempt;
}

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

let recoveryOperationInFlight: Promise<unknown> | null = null;

function runRecoveryOperation<T>(operation: () => Promise<T>): Promise<T> {
  // Concurrent mixed-type callers (resume vs discard) share the in-flight
  // promise; the cast is unsound in theory but safe in practice -- the only
  // typed consumer treats a non-true result as 'do not navigate'.
  if (recoveryOperationInFlight !== null) return recoveryOperationInFlight as Promise<T>;
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
export async function resumeRecovery(): Promise<boolean> {
  return runRecoveryOperation(async () => {
    const info = pendingRecovery;
    if (info === null) return false;
    setRecoveryNotice(null);
    const { db: database, repository: repo, controller: ctrl } = await ready();
    const checkpoint = await repo.loadCheckpoint(info.sessionId);
    if (checkpoint === null) {
      // F5 fix (C10 residue): the checkpoint this banner was offering to
      // resume has vanished from disk since bootstrap's initial read (e.g.
      // `deleteAllStoredUserData()` ran, or the row was otherwise removed
      // out-of-band). Previously this fell through to `ctrl.start('session')`
      // anyway -- with no restored history, that mints a BRAND NEW session id
      // on the fresh controller, then this method persisted the OLD, now-
      // vanished `info.sessionId` as the active-session pointer, permanently
      // desyncing the pointer from the session actually running. Abort
      // instead: clear the banner, clear the pointer (so next launch doesn't
      // re-offer a recovery that can never succeed), and never start a
      // session here at all.
      setPendingRecovery(null);
      setRecoveryNotice('The recovered session could not be found and was discarded.');
      if (database !== null) await setActiveSessionId(database, null);
      return false;
    }
    ctrl.restoreFromCheckpoint(info.sessionId, checkpoint.snapshot, checkpoint.laps);
    await ctrl.start('session');
    // F6 fix (WPT3, binding): normal session start reaches
    // `startTelemetryRecording()` through `RealSessionFacadeCallbacks.onSessionStarted`
    // (`productionFacadeCallbacks()` above) -- `resumeRecovery()` drives the
    // SAME `ctrl` directly and never goes through that facade callback at
    // all, so a recovered session previously recorded no OBD data even with
    // telemetry enabled. Same hook, same gating (`telemetryEnabled`/no
    // on-device db are both still checked inside `startTelemetryRecording()`
    // itself) -- just called explicitly for the id already known here.
    startTelemetryRecording(info.sessionId);
    setPendingRecovery(null);
    // C5 fix: the recovered session is active again -- keep the active-session
    // pointer (re-affirmed, in case it somehow drifted) rather than clearing
    // it. It is cleared only by the existing `onSessionEnded` callback once
    // this session actually finishes; clearing it here meant a SECOND process
    // death mid-resume left no pointer for the next launch to discover, so
    // recovery was silently never offered again.
    if (database !== null) await setActiveSessionId(database, info.sessionId);
    return true;
  });
}

/** Discards a recoverable checkpoint without resuming (ADR-0003 §3): marks it terminal so it is never offered again -- `LocalSessionRepository` has no delete method, so this overwrites the checkpoint's snapshot to `sessionComplete` instead. */
export async function discardRecovery(): Promise<void> {
  return runRecoveryOperation(async () => {
    const info = pendingRecovery;
    if (info === null) return;
    setRecoveryNotice(null);
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
  // F7 fix (WPT3, binding): `telemetry_samples` (Telemetry addendum) is a
  // mobile-owned table (`persistence/telemetrySchema.ts`) that
  // `@circuit/core`'s `deleteAllUserData`/`LocalSessionRepository.deleteUserData`
  // (packages/core, out of this ticket's write set) has no knowledge of at
  // all -- delete it here, in the SAME flow, and verify it actually landed
  // empty before ever reporting success, so the UI's "All stored data
  // deleted" banner is never shown while up to 200,000 rows/session remain.
  let telemetryOk = true;
  if (result.ok && db !== null) {
    // N1-confirm residue fix (LEAD): a session's final telemetry flush can
    // still be in flight when the user reaches delete-all -- await any
    // in-progress shutdown first, then run DELETE + verify while HOLDING the
    // shared write gate, so no straggler batch INSERT can land between (or
    // after) them. `stopTelemetryRecording()` is an idempotent no-op when
    // nothing is recording.
    await stopTelemetryRecording();
    const database = db;
    telemetryOk = await (dbWriteGate ?? PASSTHROUGH_WRITE_GATE).exclusive(async () => {
      await database.runAsync('DELETE FROM telemetry_samples');
      const remaining = await database.getAllAsync<{ count: number }>('SELECT COUNT(*) AS count FROM telemetry_samples');
      return (remaining[0]?.count ?? 0) === 0;
    });
  }
  const finalResult: DeleteUserDataResult = { ...result, ok: result.ok && telemetryOk };
  if (finalResult.ok && historyStore !== null) await historyStore.refresh();
  return finalResult;
}

// ---------------------------------------------------------------------------
// DevReplayScreen support (MUST DO #6, __DEV__ only).
//
// F4 fix (C6 residue): `startDevReplaySession` / `restoreProductionFacade` /
// `useMockFacadeForDevReplay` all mutate the SAME shared state
// (`replayController`/`activeController`/`facadeWrapper`'s inner) but
// previously ran independently -- a rapid start/restore/start "storm"
// (double-tapping a fixture row, `DevReplayScreen` unmounting mid-transition)
// could interleave them: one call's `replayController = null` racing
// another's read of it, or a just-installed replay controller getting
// silently overwritten by a stale restore that started before it. All three
// now run through `withDevReplayLock`, a single async transition queue --
// never overlapping, always executing in call order.
// ---------------------------------------------------------------------------

let devReplayLock: Promise<void> = Promise.resolve();

/** Queues `op` behind whatever DevReplay transition is already running, and keeps the chain alive even if `op` throws (mirrors `GnssLocationProvider`'s own `op` chain, C3 fix) so one failed transition can never wedge every later one behind a never-settling link. */
function withDevReplayLock<T>(op: () => Promise<T>): Promise<T> {
  const result = devReplayLock.then(op, op);
  devReplayLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Flushes a stale replay controller's pending persistence (F4 fix: a completed lap's telemetry/checkpoint/PB write) BEFORE disposing it, so switching away mid-replay can never drop a just-finished lap. A flush failure is logged, not thrown -- it must never block the transition it's guarding (`restoreProductionFacade()` runs unconditionally, including from `DevReplayScreen`'s fire-and-forget unmount cleanup). */
async function flushAndDisposeReplay(stale: SessionController): Promise<void> {
  await stale.flush().catch((error: unknown) => {
    console.warn('[composition] replay flush before transition failed', error);
  });
  await stale.dispose();
}

/**
 * Restores `facade` to the production controller (C6 fix): disposes any
 * active DevReplay controller first (so its provider/watchdog cannot keep
 * running after the swap), then re-points `facadeWrapper` back at the
 * long-lived `productionFacade` -- no new `RealSessionFacade` is created, so
 * this never leaks a fresh controller subscription. A no-op if there is no
 * replay controller to dispose and the production controller is already
 * active. Called by `DevReplayScreen` on unmount and before starting a new
 * replay/mock session. F4 fix: runs under `withDevReplayLock`, and flushes
 * the stale replay controller before disposing it.
 */
export async function restoreProductionFacade(): Promise<void> {
  return withDevReplayLock(async () => {
    if (replayController !== null) {
      const stale = replayController;
      replayController = null;
      await flushAndDisposeReplay(stale);
    }
    if (controller !== null && productionFacade !== null) {
      activeController = controller;
      // M2 fix: a stale `telemetryShutdown` left over from whatever session
      // was active before this swap (production or a prior replay/mock) must
      // never be mistaken for THIS newly-installed facade's own in-flight
      // shutdown -- see `startDevReplaySession`'s matching comment below for
      // the full failure mode this closes.
      telemetryShutdown = null;
      facadeWrapper.setInner(productionFacade);
    }
  });
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
  return withDevReplayLock(async () => {
    if (replayController !== null) {
      const stale = replayController;
      replayController = null;
      await flushAndDisposeReplay(stale);
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
      coaching: coachingConfig(),
    });

    replayController = devController;
    activeController = devController;
    // M2 fix (Codex cross-review finding): DevReplay facades have no
    // session-start telemetry callback of their own (`startTelemetryRecording()`
    // -- the ONLY other place that clears `telemetryShutdown` -- is wired
    // exclusively into `productionFacadeCallbacks().onSessionStarted`, below).
    // Without this clear, a settled `telemetryShutdown` promise left over
    // from an earlier PRODUCTION session stays sitting in module state, and
    // `stopTelemetryRecording()`'s own `telemetryRecorder === null &&
    // telemetryShutdown !== null` reuse branch (F2 fix, above) hands that
    // stale promise right back out when THIS replay's `endSession()` fires --
    // `facadeWrapper`'s `sessionCompleteBarrier` getter then sees a non-null
    // barrier and creates a real `setTimeout` for it, even though this
    // replay never ran telemetry at all (violating the binding "zero added
    // latency, no timer" never-ran guarantee). Clearing it HERE, at every
    // facade swap-in point, closes that regardless of which prior session
    // (production, another replay, or the mock) left it behind.
    telemetryShutdown = null;
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
  });
}

/**
 * Swaps the active `facade` back to a fresh `MockSessionFacade` --
 * DevReplayScreen's `__DEV__` mock toggle. C6 fix: disposes any active replay
 * controller first (defense in depth -- `DevReplayScreen` already calls
 * `restoreProductionFacade()` before this), so switching to the scripted mock
 * can never leave an unfinished replay's provider/watchdog running underneath.
 * F4 fix: now async and runs under `withDevReplayLock` (the dispose used to
 * be a fire-and-forget `void stale.dispose()`, racing whichever transition
 * ran next), and flushes the stale replay controller before disposing it.
 */
export async function useMockFacadeForDevReplay(): Promise<void> {
  return withDevReplayLock(async () => {
    if (replayController !== null) {
      const stale = replayController;
      replayController = null;
      await flushAndDisposeReplay(stale);
    }
    activeController = null;
    // M2 fix: same stale-`telemetryShutdown` guard as `startDevReplaySession`/
    // `restoreProductionFacade` above -- the mock facade never runs telemetry
    // either.
    telemetryShutdown = null;
    facadeWrapper.setInner(new MockSessionFacade());
  });
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

/**
 * Telemetry addendum — P4b amendment (binding): minimal read-only accessor
 * exposing the shared on-device database so `LapDetailScreen`'s TELEMETRY
 * section can call `telemetryRead.ts`'s `readLapTelemetry()` — mirrors
 * `getLiveDiagnostics()`'s read-on-demand shape just above rather than a
 * subscription. `null` before bootstrap resolves `db`, or permanently on the
 * web/in-memory preview path (no on-device SQLite there, see `runBootstrap()`'s
 * `IS_WEB_RUNTIME` branch) — callers must treat that the same as "no rows".
 */
export function getTelemetryReadDb(): SqlDatabase | null {
  return db;
}
