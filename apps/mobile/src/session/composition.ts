import Constants from 'expo-constants';
import type {
  CircuitProfile,
  Corner,
  LocationProvider,
  LocationSample,
  RuntimeProfile,
  SessionControllerDiagnostics,
  SessionMachineSnapshot,
  SessionState,
  LocalSessionRepository,
  SqlDatabase,
  TelemetrySample,
} from '@circuit/core';
import {
  InMemorySessionRepository,
  SessionController,
  deleteAllUserData,
  matchVehicleProfilesByVin,
  readVinFromChannel,
  SIGNAL_TARGET_CATALOGS,
  type DeleteUserDataResult,
  type SignalTargetCatalog,
  type TestLoopCircuit,
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
import { InMemorySettingsStore, chooseInitialActiveVehicleProfileId } from './settingsStore';
import { RealSessionFacade, type RealSessionFacadeCallbacks } from './realFacade';
import { ReplayTimeSource, ReplayTimestampedLocationProvider, ScaledReplayClock } from './liveTimestampedProvider';
import { TMR_CIRCUIT_PROFILE, TMR_CORNERS, TMR_RUNTIME_PROFILE } from './tmrProfile';
import {
  circuitCatalog,
  resolveSelectedCircuit,
  setLearnedCircuits,
  type BundledCircuit,
  type LearnedCatalogEntry,
} from './circuitCatalog';
// Ticket P5d (Test Loop mode): learning an ad-hoc circuit from lap 1, keeping
// it, and the two guards a learned circuit carries for the rest of its life.
import { migrateLearnedCircuitSchema } from '../persistence/learnedCircuitSchema';
import {
  SqlLearnedCircuitStore,
  type LearnedCircuitRecord,
  type RemoveLearnedCircuitResult,
} from './learnedCircuitStore';
import {
  claimAdoptionJournal,
  clearClaimedJournal,
  deleteOrphanSession,
  newJournalId,
  readAdoptionJournal,
  writeAdoptionJournal,
  type AdoptionStage,
  type ClaimedAdoptionJournal,
} from './adoptionJournal';
import { TestLoopController, type TestLoopSnapshot } from './testLoopController';
import { TestLoopLocationProvider } from './testLoopProvider';
import { TEST_LOOP_OUT_LAP_NUMBER, learnedCoachingEnabled } from './testLoopGuards';
// Driver-facing wording lives in the strings table, even when composition is
// the one minting it (ticket P5d-FIX6): a learned circuit's provisional name
// is something the driver reads.
import { defaultLearnedCircuitName } from '../ui/screens/testLoopStrings';
import { createLifecycleLock } from './lifecycleLock';
import type { DevReplayScenario } from './devReplayScenarios';
import { startVoiceCoach } from './voiceCoach';
import { createTelemetryProvider, type TelemetryProvider, type VehicleProfileBindingLike } from './telemetryProvider';
import { createVehicleProfileBindingStore } from '../persistence/didSweepStore';
import { createRawUdsChannel } from './didSweepController';
import { EnetTcpTransport } from './enetTcpTransport';
import { enetAdapterReservation as sharedEnetAdapterReservation } from './enetAdapterReservation';
import { createGForceProvider, type GForceProvider } from './gforceProvider';
import { TelemetryRecorder } from '../persistence/telemetryRecorder';
import { PASSTHROUGH_WRITE_GATE, type SqlWriteGate } from '../persistence/sqlWriteGate';
import { createAnalysisRunner, sessionIsActive, type AnalysisRunner } from './analysisViewModel';
import { createAnalysisSessionLoader } from './analysisSessionLoader';
import { loadSessionTelemetryByLap } from '../persistence/telemetryRead';
import type { AnalysisLapRecording } from './analysisAssembly';
import {
  createBoundaryScheduler,
  createStintCoach,
  createStintRunner,
  createSuggestionJournal,
  type SessionSuggestionRecord,
  type BoundaryScheduler,
  type StintCoach,
  type StintRunner,
  type StintSource,
} from './stintCoaching';

const DB_NAME = 'circuit-timer.db';
/** Single-user local app -- no auth/account system exists (MVP scope, ADR-0001/0004). Stable so `sessionId` (`${userId}--<random>`) and stored data survive across launches. */
const LOCAL_USER_ID = 'local-driver';
const ACTIVE_SESSION_SETTINGS_KEY = 'activeSessionId';
/** M4 fix (contracts.md's "Multi-circuit selection — recovery amendment", binding): the circuit the session named by `ACTIVE_SESSION_SETTINGS_KEY` actually started on -- written/cleared in the SAME transaction as the session id (`setActiveSession` below), so bootstrap recovery never has to guess which bundled circuit a crashed, never-`endSession()`'d checkpoint belongs to. */
const ACTIVE_SESSION_CIRCUIT_SETTINGS_KEY = 'activeSessionCircuitId';
/** Ticket P5c-FIX1 E7: the instant the session named by `ACTIVE_SESSION_SETTINGS_KEY` started, written/cleared in the SAME transaction as the id -- so a RECOVERED outing can head its pit view with its own start date instead of the moment it was resumed. */
const ACTIVE_SESSION_STARTED_SETTINGS_KEY = 'activeSessionStartedAtUtc';
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
 * THE single ordering boundary for session-lifecycle work (contracts.md's
 * "Multi-circuit selection — lifecycle lock amendment" + "facade boundary
 * amendment", both binding) -- see `lifecycleLock.ts`'s own module doc
 * comment for the mutex semantics, and `unlockedRebuildProductionController()`
 * further down for the composition-level rules every section follows.
 *
 * Declared HERE, above `SwappableFacade`, because the facade wrapper itself
 * is now one of its users: `beginCalibration()`/`endSession()` acquire it
 * around the inner command AND the asynchronous work that command starts
 * (provider start/stop, persistence), so a controller can never be `idle` on
 * paper while genuinely starting, and a delete-all can never outrun an
 * in-flight session end.
 */
const lifecycleLock = createLifecycleLock();

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
   * call runs this instead of forwarding directly -- composition.ts uses it
   * to dispose and swap in a fresh production controller/facade if the
   * current one is terminal (`sessionComplete`/`error`) or built for a
   * different circuit than the current selection, before a new session can
   * begin.
   *
   * N3 fix (contracts.md's lifecycle lock amendment, binding, ticket
   * CN-FIX3): the gate is handed a `forward` callback and calls it ITSELF,
   * from INSIDE `lifecycleLock` -- previously this wrapper forwarded after
   * the gate's promise resolved, i.e. AFTER the lock was already released,
   * so a queued selection could commit a different circuit in between and
   * leave the started session running on the other one's geometry. `forward`
   * reads `this.inner` at call time, so it always reaches the controller the
   * gate just validated/rebuilt.
   */
  private preflightGate: ((forward: () => void) => Promise<void>) | null = null;
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

  setPreflightGate(gate: ((forward: () => void) => Promise<void>) | null): void {
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
      // N3 fix: the gate itself forwards, inside the lifecycle lock, once it
      // has validated/rebuilt the controller. Concurrent `startPreflight()`
      // calls still SHARE that one gate run (F2 fix) -- they now share its
      // single forward too, which is exactly right: the duplicate taps were
      // never meant to dispatch START_PREFLIGHT more than once.
      inFlight = gate(() => {
        this.inner.startPreflight();
      });
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
      .then(() => undefined)
      .catch((error: unknown) => {
        // The gate forwards on its own success path only (inside the lock);
        // if it rejected, `inner` is whatever it was before this call (the
        // gate never swaps it on failure -- see `installProductionController`'s
        // callers), and that STALE facade never received the command.
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
  /**
   * A/N3 fix (contracts.md's facade boundary amendment, binding, ticket
   * CN-FIX4): dispatches `command` to `inner` and holds `lifecycleLock`
   * until the asynchronous work that command started has SETTLED
   * (`SessionFacade.whenCommandsSettled`), not merely until the synchronous
   * dispatch returned.
   *
   * Without this, `beginCalibration()` left `SessionController.start()`
   * awaiting provider startup while the controller still reported `idle`:
   * a `selectCircuit()` issued in that window passed the idle allow-list,
   * persisted the other circuit, and disposed the controller that was still
   * starting. Now the selection queues behind this section and is refused.
   *
   * Errors never reach here (a `RealSessionFacade` command settles through
   * its own `guard`, surfacing in `FacadeState.lastError`); a rejection from
   * anywhere else is surfaced the same way the preflight gate's is, so it
   * can never become an unhandled rejection or wedge the lock.
   */
  private runLockedCommand(name: string, command: () => void | 'skipped'): void {
    void lifecycleLock
      .run(async () => {
        // Captured INSIDE the section: `inner` may have been swapped by
        // whatever ran before us (a rebuild, a DevReplay transition), and
        // the command must be dispatched to -- and awaited on -- the facade
        // that is current NOW.
        const target = this.inner;
        // P4h-FIX2 F3 (binding): `'skipped'` means the command dispatched
        // NOTHING (a queued calibration start the driver cancelled meanwhile),
        // so there is no async work of its own to hold the lock for --
        // awaiting `whenCommandsSettled()` here would await some OTHER,
        // unrelated command's pending promise.
        if (command() === 'skipped') return;
        await target.whenCommandsSettled?.();
      })
      .catch((error: unknown) => {
        if (this.current === undefined) return;
        const next = { ...this.current, lastError: `${name} failed: ${error instanceof Error ? error.message : String(error)}` };
        this.current = next;
        for (const listener of this.listeners) listener(next);
      });
  }

  /**
   * P4h-FIX2 F3 (binding, after Codex P4h-REV2 MEDIUM, `composition.ts:323,342`;
   * `CalibrationInstructionsScreen.tsx:48`): "calibration cancellation covers
   * only a start already executing inside the lifecycle lock. If
   * `beginCalibration()` is QUEUED behind another lock holder, navigation still
   * immediately pushes ActiveCalibration; Cancel calls the unlocked
   * `rejectCalibration()` before `SessionController.start()` sets
   * `calibrationStartInFlight`, so it is a no-op. The queued command later
   * starts an invisible calibration after the user has left."
   *
   * One cancel token per calibration start that has not yet ACQUIRED the lock.
   * The token leaves this set the instant its section starts running -- from
   * that point the cancel window belongs to the controller's own
   * `calibrationStartInFlight` (P4h-FIX1 M2), and `SessionController.start()`
   * latches that synchronously, before its first `await`, so the two windows
   * meet with no gap between them.
   */
  private readonly queuedCalibrationStarts = new Set<{ cancelled: boolean }>();

  beginCalibration(): void {
    const token = { cancelled: false };
    this.queuedCalibrationStarts.add(token);
    this.runLockedCommand('beginCalibration', () => {
      this.queuedCalibrationStarts.delete(token);
      // Cancelled while queued: dispatch NOTHING (no session id minted, no
      // provider start, no watchdog) -- the driver already left the screen.
      if (token.cancelled) return 'skipped';
      this.inner.beginCalibration();
      return undefined;
    });
  }
  acceptCalibration(): void {
    this.inner.acceptCalibration();
  }
  rejectCalibration(): void {
    // P4h-FIX2 F3 (binding): deliberately UNLOCKED (a Cancel must act the
    // instant the driver taps it, never queue behind the very start it is
    // cancelling) -- it cancels every calibration start still waiting for the
    // lock, then forwards as before for the in-flight/live cases.
    for (const token of this.queuedCalibrationStarts) token.cancelled = true;
    this.queuedCalibrationStarts.clear();
    this.inner.rejectCalibration();
  }
  arm(): void {
    this.inner.arm();
  }
  endSession(): void {
    // The telemetry-shutdown hook still fires SYNCHRONOUSLY here, before the
    // lock is even acquired (F2 fix, WPT3, binding: shutdown starts at the
    // earliest point this wrapper can act, independent of the controller's
    // own persistence) -- telemetry never gates, and is never gated by, lap
    // timing. Only the controller-side end is serialized, so a delete-all
    // queued behind it observes its session/checkpoint persistence complete
    // (CN-FIX4 item C).
    this.endSessionSideEffect?.();
    this.runLockedCommand('endSession', () => {
      // CN-FIX5 item 1 (contracts.md's closing amendment, binding): the
      // idempotent shutdown runs AGAIN here, inside the lock, immediately
      // before the inner end. The synchronous fire-early call above happens
      // when `endSession()` is invoked -- but if this command QUEUED behind
      // another section (a slow `beginCalibration()`, a `resumeRecovery()`),
      // that holder may have STARTED telemetry after the early stop ran.
      // Without this second call, a controller end that then fails (its
      // success-only `onSessionEnded` never runs) would leave telemetry
      // recording forever -- the exact F2 guarantee this wrapper exists to
      // keep. Stopping nothing is a no-op, so the common case is unchanged.
      this.endSessionSideEffect?.();
      this.inner.endSession();
    });
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

// ---------------------------------------------------------------------------
// P4l-FIX3 J5 (binding, after Codex P4l-REV1 finding 3/HIGH "Confirmed
// bindings never reach live ENET telemetry" -- FIX1 concern 1, the P4l
// worker's own note): `telemetryProvider.ts`'s `readVehicleProfileBindings`
// dep is read SYNCHRONOUSLY (see its own doc comment, `buildEnetConfig()`),
// but the underlying SQLite read is async -- so this composition layer keeps
// a CACHED snapshot for it to read, refreshed asynchronously.
//
// Which profile: ticket P4p G1 (binding, field test 9 BUG-A) replaced the
// hard-coded `'generic'` with the app-level `activeVehicleProfileId` setting.
// Bindings have always been stored PER PROFILE, and the field exports of
// 2026-08-31 show both stores side by side: `generic` carried
// brakePressure = 0x12/0x4002 (a DME two-level flag) while the user's own
// engine-running confirm, 0x12/0x58B7, lived on `toyota-supra-b58`. Reading a
// fixed `'generic'` here is exactly why the monitor showed raw 131/155 =
// 0/100 %. The cache now holds ONE profile's bindings -- the active one -- and
// is re-read whenever that setting changes (see the subscription below).
// ---------------------------------------------------------------------------

/** The vehicle profile every binding read in this module is scoped to. */
export function getActiveVehicleProfileId(): string {
  return settingsStore.getSettings().activeVehicleProfileId;
}

let vehicleProfileBindingsCache: readonly VehicleProfileBindingLike[] = [];

/**
 * Re-reads confirmed vehicle-profile bindings from storage into the cache
 * above. Refreshed (a) once bootstrap resolves `db` (see `runBootstrap()`),
 * (b) whenever the Signal Finder confirms a channel (`SignalFinderScreen.tsx`'s
 * `handleConfirm` calls this), and (c) defensively on every
 * `telemetryProvider.start()` below -- (c) cannot affect the START it is
 * called from (the read is async, `readVehicleProfileBindings()` is not),
 * only the NEXT one, so (a)/(b) are what make a freshly confirmed binding
 * actually reach the very next start. Never throws: a read failure just
 * leaves the previous (or empty) cache in place, matching every other
 * "telemetry must never fail to start" discipline in this module.
 */
export async function refreshVehicleProfileBindingsCache(): Promise<void> {
  try {
    const store = createVehicleProfileBindingStore(getTelemetryReadDb());
    vehicleProfileBindingsCache = await store.listBindings(getActiveVehicleProfileId());
  } catch (error) {
    console.warn('[composition] could not refresh the vehicle profile bindings cache', error);
  }
}

/** Test/diagnostic visibility into the cache above. */
export function getVehicleProfileBindingsCache(): readonly VehicleProfileBindingLike[] {
  return vehicleProfileBindingsCache;
}

/**
 * Ticket P4p G1 (binding): a profile SWITCH (the Signal Finder's chip writes
 * the setting) invalidates the cache immediately -- otherwise the provider
 * would keep polling the previous profile's DIDs until something else happened
 * to refresh it. Registered once, at module load, on the STABLE
 * `settingsStore` wrapper, so it survives bootstrap's inner store swap.
 */
let lastKnownActiveVehicleProfileId = settingsStore.getSettings().activeVehicleProfileId;
settingsStore.subscribe((settings) => {
  if (settings.activeVehicleProfileId === lastKnownActiveVehicleProfileId) return;
  lastKnownActiveVehicleProfileId = settings.activeVehicleProfileId;
  vehicleProfileBindingsCache = [];
  void refreshVehicleProfileBindingsCache();
});

/**
 * Ticket P4p G1 (binding), the ONE-TIME initial-profile migration. Runs from
 * `runBootstrap()` immediately after settings hydrate, and only while the
 * persisted row never carried a profile choice of its own
 * (`SqlSettingsStore.activeVehicleProfileIdWasStored`). The RULE itself is
 * pure and lives in `settingsStore.ts`
 * (`chooseInitialActiveVehicleProfileId`); this function only supplies the
 * persisted bindings, applies the result and LOGS it. Nothing is ever
 * deleted: the other profile's bindings stay exactly where they are, and the
 * user can switch back from the Signal Finder's chip at any time.
 */
export async function applyInitialActiveVehicleProfile(store: SqlSettingsStore): Promise<string | null> {
  if (store.activeVehicleProfileIdWasStored) return null;
  try {
    const bindingStore = createVehicleProfileBindingStore(getTelemetryReadDb());
    const all = await bindingStore.listAllBindings?.();
    if (all === undefined) return null;
    const chosen = chooseInitialActiveVehicleProfileId(all);
    if (chosen === null || chosen === store.getSettings().activeVehicleProfileId) return null;
    console.info(
      `[composition] first run with an active vehicle profile setting: activating "${chosen}" -- it carries field-confirmed bindings for channels the generic profile also has (nothing was deleted; change it from the Signal Finder)`,
    );
    store.update({ activeVehicleProfileId: chosen });
    return chosen;
  } catch (error) {
    console.warn('[composition] could not decide an initial active vehicle profile', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// VIN-based vehicle auto-detection (ticket P4q, binding). User: "the app
// should know the car from OBD from the start if possible; if not, let the
// user choose."
//
// ENET-only (Q1, binding): the ELM327 session (`elm327Session.ts`) has no
// mode-09 (vehicle-info) support at all -- only mode-01 polling and a
// service-21/22 custom-PID escape hatch -- so a VIN read is never attempted
// on that path; `maybeDetectVehicleFromVin()` below is a no-op whenever
// `adapterType !== 'enet'`.
//
// NEVER blocks or steals the adapter: it checks the SHARED reservation is
// free and acquires its OWN token before opening anything; a busy adapter (a
// sweep/telemetry/Signal-Finder session already running) makes this resolve
// `null` immediately, WITHOUT marking detection "done" -- the next trigger
// (another telemetry connect, another Signal Finder screen mount) gets to try
// again. Once a read actually COMPLETES (VIN found or genuinely not), it is
// cached for the rest of this app run -- "one-shot read... result cached per
// app run" -- and persisted into `settings.lastSeenVin` so the Signal Finder
// screen can show "VIN: <value>" even before a LATER run reads one again.
// ---------------------------------------------------------------------------

/** The DME address the VIN read is addressed to -- ISO 14229-1 DID 0xF190 (`@circuit/core`'s `vinRead.ts`). */
const VIN_READ_ECU = 0x12;

/** Codex R3 fix (ticket P4q follow-up, binding, LOW): the whole connect-and-read attempt (lazy native transport import included) may never take longer than this -- see `maybeDetectVehicleFromVin`'s own doc comment. */
const VIN_READ_OVERALL_TIMEOUT_MS = 4_000;

type VinDetectionState = 'idle' | 'attempting' | 'done';
let vinDetectionState: VinDetectionState = 'idle';
/** The result of the ONE completed attempt this app run has made (or will make) -- `null` before `vinDetectionState === 'done'`, and forever after if the read found nothing usable. */
let cachedDetectedVin: string | null = null;

/**
 * Codex R2 fix (ticket P4q follow-up, binding, MEDIUM): "the explicit-choice
 * flag is in-memory only, so after an app restart VIN detection could
 * overwrite a profile the user picked deliberately." Replaces what used to be
 * a plain in-memory `let` -- the question "did the user explicitly choose?"
 * is now answered by `settings.activeVehicleProfileSource === 'user'`, a
 * PERSISTED field (`settingsStore.ts`), so the guard survives a restart
 * exactly like the choice it protects does.
 */
export function hasUserExplicitlyChosenVehicleProfileThisRun(): boolean {
  return settingsStore.getSettings().activeVehicleProfileSource === 'user';
}

/**
 * Ticket P4q (binding): the ONE place a profile CHIP tap (or any other
 * explicit UI choice) must go through -- never `settingsStore.update`
 * directly -- so `activeVehicleProfileSource` is set to `'user'` atomically
 * with the id itself. `SignalFinderScreen.tsx`'s profile chips call this.
 */
export function setActiveVehicleProfileIdExplicit(profileId: string): void {
  settingsStore.update({ activeVehicleProfileId: profileId, activeVehicleProfileSource: 'user' });
}

export interface VinAutoDetectNotice {
  vin: string;
  /** The profile auto-select just activated. The screen resolves its label from the catalog + the app's own language -- never a raw English string cached here. */
  profileId: string;
}

let vinAutoDetectNotice: VinAutoDetectNotice | null = null;
const vinAutoDetectNoticeListeners = new Set<(n: VinAutoDetectNotice | null) => void>();

function setVinAutoDetectNotice(next: VinAutoDetectNotice | null): void {
  vinAutoDetectNotice = next;
  for (const listener of vinAutoDetectNoticeListeners) listener(next);
}

/** Ticket P4q (binding): the Signal Finder screen's dismissible "Detected from VIN — <label>" banner. Replays the current value synchronously on subscribe (same convention as `subscribeRecovery`/`subscribeBootstrapState` above). */
export function subscribeVinAutoDetectNotice(cb: (n: VinAutoDetectNotice | null) => void): () => void {
  vinAutoDetectNoticeListeners.add(cb);
  cb(vinAutoDetectNotice);
  return () => {
    vinAutoDetectNoticeListeners.delete(cb);
  };
}

/** The banner's dismiss control. Purely a UI acknowledgement -- does NOT undo the auto-selected profile (the chip still overrides, same as any other profile switch). */
export function dismissVinAutoDetectNotice(): void {
  setVinAutoDetectNotice(null);
}

/**
 * Ticket P4q Q3 (binding): "exactly ONE profile matches -> auto-select ...
 * zero or multiple matches -> nothing changes (manual choice). Auto-select
 * never overrides a profile the user chose EXPLICITLY."
 *
 * R2 fix (Codex follow-up, binding): the second argument now answers "does
 * `settings.activeVehicleProfileSource` say `'user'` right now?" -- a
 * PERSISTED fact, so a choice made in an earlier app run still blocks
 * auto-select after a restart, not only for the rest of the run it was made
 * in. Still a pure function of its two arguments -- directly unit-testable
 * without any catalog/settings/transport involved.
 */
export function decideVinAutoSelect(
  matchingProfileIds: readonly string[],
  userExplicitlyChoseThisRun: boolean,
): string | null {
  if (userExplicitlyChoseThisRun) return null;
  if (matchingProfileIds.length !== 1) return null;
  return matchingProfileIds[0] ?? null;
}

/**
 * Ticket P4q Q2/Q3 (binding): matches `vin` against `catalogs` (default the
 * real registry) and, on exactly one match (per {@link decideVinAutoSelect}),
 * activates it as `activeVehicleProfileId` and raises the dismissible
 * notice. `catalogs` is a test seam (mirrors `signalFinderController.ts`'s
 * own `deps.catalog` override) -- production never passes it, and in
 * practice never fires yet regardless: the Supra catalog's own `vinPatterns`
 * starts EMPTY (Q2, binding) until a real VIN has been read from the actual
 * car and a pattern added from it.
 */
export function applyVinAutoSelect(vin: string, catalogs: readonly SignalTargetCatalog[] = SIGNAL_TARGET_CATALOGS): void {
  const matches = matchVehicleProfilesByVin(vin, catalogs);
  // R2 fix: read the PERSISTED source fresh, every call -- never a stale
  // in-memory snapshot from whenever this module happened to load.
  const decision = decideVinAutoSelect(
    matches.map((catalog) => catalog.profileId),
    settingsStore.getSettings().activeVehicleProfileSource === 'user',
  );
  if (decision === null) return;
  settingsStore.update({ activeVehicleProfileId: decision, activeVehicleProfileSource: 'vin' });
  setVinAutoDetectNotice({ vin, profileId: decision });
}

/**
 * Codex R4 fix (ticket P4q follow-up, binding, LOW): a VIN is personal data
 * (it identifies the specific vehicle, and via public lookup often the
 * owner) -- never written to a log line in full. Masks to the WMI (first 3
 * chars, the manufacturer/region) + the last 2 chars, e.g.
 * `WBA************34`; everything between is replaced with `*`. The FULL
 * value is never logged anywhere in this module -- only shown in the UI and
 * stored in `settings.lastSeenVin`.
 */
export function maskVin(vin: string): string {
  if (vin.length <= 5) return '*'.repeat(vin.length); // defensive: a strict-validated VIN is always 17 chars, so this never actually triggers.
  return `${vin.slice(0, 3)}${'*'.repeat(vin.length - 5)}${vin.slice(-2)}`;
}

/**
 * Ticket P4q Q1 (binding): the one-shot ENET VIN read -- "runs when the
 * adapter reservation is free (e.g. when the Signal Finder screen opens or
 * telemetry connects)". Safe to call from multiple trigger points and
 * multiple times: after the FIRST attempt actually completes (found or not),
 * every later call returns the cached result immediately without touching
 * the adapter again. A call that finds the reservation held by someone else
 * returns `null` WITHOUT marking detection done, so a later trigger still
 * gets its own chance once the adapter frees up.
 *
 * R3 fix (Codex follow-up, binding, LOW): the connect-and-read attempt
 * (`transport.connect()` -- which itself starts with a LAZY native
 * `react-native-tcp-socket` import -- then the one-shot read) is raced
 * against {@link VIN_READ_OVERALL_TIMEOUT_MS}. A hung `connect()` (a dead
 * adapter, a native import that never resolves) therefore never holds the
 * shared reservation past that bound: `finally` below closes the transport
 * and releases the token EITHER way, whichever branch of the race actually
 * settled it first. The losing side's eventual settlement (a `connect()`
 * that resolves or rejects long after the timeout already won) is harmless --
 * `Promise.race` itself attaches a handler to every promise it is given, so
 * it can never surface as an unhandled rejection, and this function has
 * already returned by then.
 */
export async function maybeDetectVehicleFromVin(): Promise<string | null> {
  if (vinDetectionState !== 'idle') return cachedDetectedVin;
  const settings = settingsStore.getSettings();
  // Q1 (binding): ENET only -- the ELM327 session has no mode-09 support.
  if (settings.adapterType !== 'enet') return null;
  if (settings.enetHost.trim() === '') return null; // nothing configured to connect to.
  if (sharedEnetAdapterReservation.holder() !== null) return null; // never steals a running flow's adapter.
  const token = sharedEnetAdapterReservation.tryAcquire('signalFinder');
  if (token === null) return null; // lost the race to acquire -- another trigger point retries later.

  vinDetectionState = 'attempting';
  const transport = new EnetTcpTransport({ host: settings.enetHost, port: settings.enetPort });
  let vin: string | null = null;
  try {
    const attempt = (async (): Promise<string | null> => {
      await transport.connect();
      const channel = createRawUdsChannel(transport, settings.enetTesterAddress, VIN_READ_ECU);
      return readVinFromChannel(channel);
    })();
    const timedOut = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), VIN_READ_OVERALL_TIMEOUT_MS);
    });
    const raced = await Promise.race([attempt, timedOut]);
    vin = raced === 'timeout' ? null : raced;
  } catch (error) {
    console.warn('[composition] the one-shot VIN read failed', error);
    vin = null;
  } finally {
    await transport.close().catch(() => undefined);
    sharedEnetAdapterReservation.release(token);
  }

  vinDetectionState = 'done';
  cachedDetectedVin = vin;
  if (vin !== null) {
    // Q2 (binding): logged so a pattern can be added LATER from the real
    // car -- never invented here. R4 fix (binding, LOW): MASKED -- a VIN is
    // personal data, and the full value is never written to a log line; the
    // driver reads it in full only on the Signal Finder screen / `lastSeenVin`.
    console.info(`[composition] VIN detected: ${maskVin(vin)}`);
    settingsStore.update({ lastSeenVin: vin });
    applyVinAutoSelect(vin);
  }
  return vin;
}

const baseTelemetryProvider: TelemetryProvider = createTelemetryProvider({
  settingsStore,
  monotonicNow: () => telemetryClock.now(),
  isDev: telemetryIsDev,
  readVehicleProfileBindings: () => vehicleProfileBindingsCache,
});

/**
 * Thin wrapper, not a second implementation: every method delegates straight
 * to {@link baseTelemetryProvider}, EXCEPT `start()`, which also fires a
 * defensive cache refresh (fire-and-forget -- see (c) above) before
 * delegating. Both of this app's `start()` call sites --
 * `startTelemetryRecording()` below and `TelemetryScreen.tsx`'s manual
 * monitor -- go through this SAME exported singleton, so neither needs its
 * own refresh call.
 */
export const telemetryProvider: TelemetryProvider = {
  ...baseTelemetryProvider,
  start(): void {
    void refreshVehicleProfileBindingsCache();
    baseTelemetryProvider.start();
    // Ticket P4q (binding): one of this app's two VIN-detection trigger
    // points ("when ... telemetry connects") -- fire-and-forget, and called
    // AFTER `baseTelemetryProvider.start()` on purpose: that call may itself
    // synchronously acquire the SAME shared reservation (owner `'provider'`)
    // before yielding, and this must never race it for the claim -- "never
    // blocks or steals the adapter from a running flow". `holder()` is
    // therefore whatever telemetry's own start just left it as; a no-op
    // (skipped, not marked done, so a LATER trigger still gets its own
    // chance) whenever that reservation is held.
    void maybeDetectVehicleFromVin();
  },
};

// ---------------------------------------------------------------------------
// G-force telemetry (Telemetry addendum — channel revision, binding):
// `gforceProvider.ts`'s own module doc comment covers its math/portrait-mount
// assumption/unit handling in full. SAME `telemetryClock` as the OBD
// `telemetryProvider` above, so every telemetry channel (OBD + accelerometer)
// shares one time base. Session-scoped, started/stopped alongside the OBD
// provider by `startTelemetryRecording()`/`stopTelemetryRecording()` below --
// but INDEPENDENT of it: neither provider's start/stop/failure ever gates the
// other, and both feed the SAME `TelemetryRecorder`.
// ---------------------------------------------------------------------------
export const gForceProvider: GForceProvider = createGForceProvider({
  monotonicNow: () => telemetryClock.now(),
});

/**
 * P4h-FIX1 H6 (binding, after Codex P4h-REV1 HIGH, `TelemetryScreen.tsx:224-238`;
 * `composition.ts:613-624`): "G-provider ownership is not reference-counted
 * ... monitor Start -> driving session reuses the already-running provider ->
 * session end unconditionally calls `gForceProvider.stop()` -> G rows die
 * while the monitor remains open and still expects ownership."
 *
 * The provider is a singleton with two independent users -- the telemetry
 * monitor screen and a driving session -- so ownership lives HERE, with the
 * singleton, as a reference count (the same "the composition layer owns the
 * provider" principle contracts.md's provider-ownership amendment already
 * applies to GNSS). Each user takes exactly one reference and releases it;
 * the provider starts on the first and stops only at zero.
 */
let gForceHolders = 0;

/** Takes one G-provider reference, starting it if it was not already running. Synchronous, never throws (a provider-side throw is logged, exactly like the session-start path's own backstop). */
export function acquireGForce(): void {
  gForceHolders += 1;
  if (gForceHolders > 1) return;
  try {
    gForceProvider.start();
  } catch (error) {
    console.warn('[composition] gForceProvider.start() threw synchronously', error);
  }
}

/** Releases one G-provider reference; stops the provider only when the LAST holder lets go. An unbalanced extra release is a no-op (never stops a provider nobody holds). */
export function releaseGForce(): Promise<void> {
  if (gForceHolders === 0) return Promise.resolve();
  gForceHolders -= 1;
  if (gForceHolders > 0) return Promise.resolve();
  return gForceProvider.stop();
}

/** Test/diagnostic visibility into the reference count above. */
export function gForceHolderCount(): number {
  return gForceHolders;
}

/**
 * P4h-FIX2 F2 (binding, after Codex P4h-REV2 HIGH, `composition.ts:650,684`):
 * "G-force release is not paired with actual acquisition.
 * `startTelemetryRecording()` returns early when SQLite is unavailable or
 * telemetry is disabled, but `stopTelemetryRecording()`'s `recorder === null`
 * path still calls `releaseGForce()`. Scenario: monitor owns the sole
 * reference; a web/disabled/recovery session starts without acquiring, then
 * session end, controller rebuild, or delete-all releases the monitor's
 * reference and stops its G rows."
 *
 * TRUE only while THIS session's recording actually holds one
 * `acquireGForce()` reference. Every early return in
 * `startTelemetryRecording()` (no on-device database -- web preview --,
 * telemetry disabled) leaves it FALSE, and `stopTelemetryRecording()` releases
 * only when it is TRUE, on every path that reaches it: session end, the
 * `'error'`-terminal rebuild, recovery, and delete-all.
 */
let sessionHoldsGForce = false;

let telemetryRecorder: TelemetryRecorder | null = null;
/** In-flight telemetry shutdown (F2 residue fix) -- repeated `stopTelemetryRecording()` calls return this same promise so `onSessionEnded`'s barrier awaits the REAL final flush. Cleared on the next `startTelemetryRecording()`. */
let telemetryShutdown: Promise<void> | null = null;
let telemetryCurrentLapNumber: number | null = null;
let unsubscribeTelemetrySample: (() => void) | null = null;
let unsubscribeGForceSample: (() => void) | null = null;
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
  unsubscribeGForceSample?.();
  unsubscribeGForceSample = null;
  unsubscribeTelemetryLapWatch?.();
  unsubscribeTelemetryLapWatch = null;
  telemetryCurrentLapNumber = null;
  // P4h-FIX2 F2 (binding): consumed HERE, synchronously, for BOTH branches
  // below -- a second call (this function is idempotent and is invoked from
  // several paths for the same session end) therefore never releases twice,
  // and a session that never acquired never releases at all.
  const releaseSessionGForce = sessionHoldsGForce;
  sessionHoldsGForce = false;
  if (recorder === null) {
    // P4b amendment: nothing was ever recording for the session that just
    // ended -- there is no real shutdown work to await. Fire `provider.stop()`
    // defensively (a harmless no-op if it never started) without awaiting it,
    // and leave `telemetryShutdown` at `null` (already the case here --
    // `startTelemetryRecording()` unconditionally clears it up front, see
    // there -- this assignment is just defense in depth against any other
    // call path) so the sessionComplete barrier's getter below reads
    // "nothing to wait for" and relays with genuinely zero added latency: no
    // timer is ever created for this path (binding spec). Channel revision:
    // `gForceProvider` gets the SAME defensive, un-awaited stop() -- it never
    // recorded through `recorder` either on this path.
    telemetryShutdown = null;
    void telemetryProvider.stop();
    // P4h-FIX1 H6 (binding): releases only THIS session's own reference --
    // the monitor screen's (if it holds one) keeps the provider running.
    // P4h-FIX2 F2 (binding): and ONLY if this session really took one. This is
    // the path a telemetry-disabled / web (no on-device database) / recovery
    // session takes -- it never acquired, so releasing here used to drop the
    // MONITOR's reference and stop its G rows (the same for the rebuild and
    // delete-all paths, which reach this exact branch).
    if (releaseSessionGForce) void releaseGForce();
    return Promise.resolve();
  }
  telemetryShutdown = (async () => {
    try {
      // Channel revision: `gForceProvider.stop()` joins the SAME
      // `allSettled` barrier as the OBD provider and the recorder's own
      // flush -- a G-provider failure here is isolated (logged, never
      // thrown) exactly like an OBD-provider failure already was, and never
      // blocks or fails session-end persistence.
      // P4h-FIX1 H6 (binding): `releaseGForce()` (not a bare
      // `gForceProvider.stop()`) -- the session drops ITS OWN reference; the
      // provider stops only if nothing else (the telemetry monitor) still
      // holds one. It still joins the SAME `allSettled` barrier.
      // P4h-FIX2 F2 (binding): `releaseSessionGForce` is normally true on this
      // branch (a recorder exists only where `acquireGForce()` also ran), and
      // the conditional keeps the pairing honest regardless of how this
      // function is reached.
      const results = await Promise.allSettled([
        telemetryProvider.stop(),
        releaseSessionGForce ? releaseGForce() : Promise.resolve(),
        recorder.endSession(),
      ]);
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
/**
 * P5d-FIX1 H1: writes samples recorded BEFORE the session had an id (the Test
* Loop learn phase) into the session that grew out of them.
 *
 * P5d-FIX2 N4 (Codex P5d-REV2): tagged lap 0 -- the out-lap -- rather than
 * NULL. NULL rows are deliberately excluded from the analysis read path
 * (`readSessionTelemetryByLap`), which would have made the learning lap's
 * channels unreadable for the very lap they belong to.
 */
async function recordPreLapTelemetry(samples: readonly TelemetrySample[]): Promise<void> {
  const recorder = telemetryRecorder;
  if (recorder === null || samples.length === 0) return;
  for (const sample of samples) recorder.record(sample, TEST_LOOP_OUT_LAP_NUMBER);
  // `flush()` alone only awaits writes already in flight -- the rows just
  // buffered have to be pushed out first, or the learning lap's channels sit
  // in memory until some later batch boundary happens to carry them.
  recorder.flushOnLapCrossing();
  await recorder.flush();
}

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
  // Channel revision: `gForceProvider`'s latG/longG samples flow into the
  // SAME recorder/lap-number tagging as the OBD provider's -- a separate
  // subscription, independent lifecycle (see `gForceProvider.ts`'s own doc
  // comment), but one shared `TelemetryRecorder`.
  unsubscribeGForceSample = gForceProvider.onSample((sample) => {
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

  // F2 fix (MED, binding): EACH provider's `start()` is isolated in its own
  // try/catch -- `telemetryProvider.start()` already catches its own
  // synchronous construction failures internally (see its own doc comment)
  // and reports them through `onStateChange('failed', ...)`, but this stays
  // as composition's own defense-in-depth backstop: a synchronous throw from
  // EITHER provider's `start()` must never prevent the OTHER from being
  // called, and must never propagate up through `startTelemetryRecording()`
  // (which runs synchronously inside `onSessionStarted` -- an uncaught throw
  // here would otherwise escape into `RealSessionFacade`'s own session-start
  // path, nowhere near a place that should ever fail lap timing).
  try {
    telemetryProvider.start();
  } catch (error) {
    console.warn('[composition] telemetryProvider.start() threw synchronously', error);
  }
  // Channel revision: started alongside the OBD provider but independently --
  // neither `start()` call is gated on the other, and neither's own state
  // (running/failed) affects whether the other is called. P4h-FIX1 H6
  // (binding): through the reference count, so this session's hold is
  // released (and only this one) when it ends -- `acquireGForce()` carries
  // the same never-throw backstop this call site had. P4h-FIX2 F2 (binding):
  // recorded, so `stopTelemetryRecording()` releases EXACTLY the reference
  // this call took -- and takes at most one per session even if a start were
  // ever to run twice without an intervening stop.
  if (!sessionHoldsGForce) {
    acquireGForce();
    sessionHoldsGForce = true;
  }
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
  /**
   * N1 fix (contracts.md's lifecycle lock amendment, binding, ticket
   * CN-FIX3): the bundled circuit this checkpoint actually belongs to,
   * resolved ONCE at bootstrap (persisted `activeSessionCircuitId` -> catalog
   * scan -> the selection in force at that moment). `resumeRecovery()`
   * resumes on THIS circuit no matter what the user selected in between, and
   * `CircuitDetailScreen`'s banner names it -- previously the recovery
   * carried no circuit identity at all, so a selection made after the crash
   * but before Resume silently retargeted the recovery.
   */
  circuitId: string;
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
/** The bundled circuitId `controller` (the production one) was last BUILT for -- ticket CN-W3's preflight-gate rebuild-on-circuit-change trigger compares this against `settingsStore.getSettings().selectedCircuitId`. Set by `createProductionController()`, read by the gate below and by `resumeRecovery()`'s defensive rebuild guard. */
let productionControllerCircuitId: string | null = null;
/**
 * Ticket P5b B1: the id of the session most recently STARTED on this launch --
 * what `SessionResultsScreen`'s "Analysis" button needs, since `FacadeState`
 * carries lap records but no session id. Written by `onSessionStarted` (the one
 * place the id is known the moment it exists) and deliberately NOT cleared by
 * `onSessionEnded`: the post-session results screen is shown precisely after
 * the session ended, and that is exactly the session it must be able to analyse.
 */
let mostRecentSessionId: string | null = null;
/**
 * Ticket P5c-B: the ISO-8601 UTC instant `mostRecentSessionId` started, so the
 * pit view can head itself with the outing's own date while it is still
 * running (the history store only learns about a session once it has ended).
 */
let mostRecentSessionStartedAtUtc: string | null = null;
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
    // C fix (contracts.md's facade boundary amendment, binding, ticket
    // CN-FIX4): checkpoint ONLY a controller that is genuinely mid-session.
    // `SessionController.checkpointNow()` writes whenever its `sessionId` is
    // non-null -- including a controller sitting in `sessionComplete` -- so
    // a background transition after a completed session (or after
    // `deleteAllStoredUserData()` reported success) used to re-create a
    // checkpoint row for data the user had just deleted. An idle/terminal
    // controller has nothing worth checkpointing by definition: its laps are
    // already persisted by `endSession()`.
    const ctrl = activeController;
    if (ctrl === null) return;
    if (!MID_SESSION_STATES.has(currentControllerState(ctrl))) return;
    ctrl.checkpointNow().catch((error: unknown) => {
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

/** Ticket P5c-FIX1 E7: companion read for `ACTIVE_SESSION_STARTED_SETTINGS_KEY` -- `null` for a session started before this key existed. */
async function getActiveSessionStartedAtUtc(database: SqlDatabase): Promise<string | null> {
  const rows = await database.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
    ACTIVE_SESSION_STARTED_SETTINGS_KEY,
  ]);
  return rows[0]?.value ?? null;
}

/** M4 fix: companion read for `ACTIVE_SESSION_CIRCUIT_SETTINGS_KEY` -- `null` when absent (a legacy checkpoint written before this key existed, or nothing active). */
async function getActiveSessionCircuitId(database: SqlDatabase): Promise<string | null> {
  const rows = await database.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
    ACTIVE_SESSION_CIRCUIT_SETTINGS_KEY,
  ]);
  return rows[0]?.value ?? null;
}

/**
 * M4 fix (contracts.md's "Multi-circuit selection — recovery amendment",
 * binding): `activeSessionId` and `activeSessionCircuitId` are written OR
 * cleared TOGETHER, in one SQLite transaction -- two independent
 * fire-and-forget writes could otherwise leave a NEW `activeSessionId`
 * paired with a PRIOR session's stale circuit id if the process died between
 * them (or if they simply resolved out of order), which would make bootstrap
 * recovery resume the wrong circuit's geometry. `withTransactionAsync`
 * acquires the SAME shared write gate as every other repository transaction
 * (`openAppDatabase`'s own doc comment) -- this never interleaves with a
 * concurrent `SqlSessionRepository` transaction or a `TelemetryRecorder`
 * batch either.
 */
async function setActiveSession(
  database: SqlDatabase,
  session: { sessionId: string; circuitId: string; startedAtUtc?: string } | null,
): Promise<void> {
  await database.withTransactionAsync(async () => {
    if (session === null) {
      await database.runAsync('DELETE FROM settings WHERE key = ?', [ACTIVE_SESSION_SETTINGS_KEY]);
      await database.runAsync('DELETE FROM settings WHERE key = ?', [ACTIVE_SESSION_CIRCUIT_SETTINGS_KEY]);
      await database.runAsync('DELETE FROM settings WHERE key = ?', [ACTIVE_SESSION_STARTED_SETTINGS_KEY]);
    } else {
      await database.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
        ACTIVE_SESSION_SETTINGS_KEY,
        session.sessionId,
      ]);
      await database.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
        ACTIVE_SESSION_CIRCUIT_SETTINGS_KEY,
        session.circuitId,
      ]);
      if (session.startedAtUtc !== undefined) {
        await database.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
          ACTIVE_SESSION_STARTED_SETTINGS_KEY,
          session.startedAtUtc,
        ]);
      }
    }
  });
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
function coachingConfig(
  corners: Corner[],
  profile: Pick<CircuitProfile, 'geometryStatus'>,
): { enabled: boolean; corners: Corner[] } {
  // Ticket P5d T5 (binding): a LEARNED circuit's geometry was never validated
  // on track, so it may be timed and analysed but never coached on -- the
  // driver's own `coachingEnabled` toggle cannot re-enable it. Voice follows
  // for free: it speaks nothing but cues (`testLoopGuards.ts`).
  return {
    enabled: learnedCoachingEnabled(settingsStore.getSettings().coachingEnabled, profile),
    corners,
  };
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
  // P5d-FIX1 H1: while a Test Loop is learning (or has just closed), the
  // controller is built on the BUFFERING provider, not the bare GNSS
  // singleton -- that is what lets lap 1 and everything driven since be
  // replayed into this controller in order, with no fix lost and no watcher
  // stopped. Outside Test Loop mode this is exactly the old wiring.
  const provider: LocationProvider = testLoopProvider ?? gnssProvider;
  const clock = new PerformanceNowClock();
  const restartProvider = async (): Promise<void> => {
    await provider.stop();
    await provider.start();
  };
  // Multi-circuit selection addendum (ticket CN-W3): read fresh at EACH
  // build call site (bootstrap, and every later terminal/circuit-change
  // rebuild) so the just-persisted selection is what a freshly built
  // controller is actually configured for -- a running controller's own
  // circuit stays fixed for its whole lifetime, same as `coachingConfig()`.
  const selected = resolveSelectedCircuit(settingsStore.getSettings());
  productionControllerCircuitId = selected.profile.circuitId;
  return new SessionController({
    runtimeProfile: selected.runtime,
    circuitProfile: selected.profile,
    locationProvider: provider,
    clock,
    repository,
    userId: LOCAL_USER_ID,
    appVersion: appVersion(),
    algorithmVersion: ALGORITHM_VERSION,
    restartProvider,
    coaching: coachingConfig(selected.corners, selected.profile),
  });
}

/**
 * Ticket P5c-FIX1 E7 (Codex P5c-REV1 finding 7): everything an outing needs
 * initialized before its first lap boundary, in ONE place. A normal start
 * reaches it through `onSessionStarted`; `resumeRecovery()` drives the
 * controller directly and so calls it itself -- previously it did neither, and
 * a recovered outing could compute no cues and open no valid pit view because
 * `mostRecentSessionId` was still null.
 *
 * `startedAtUtc` is the outing's OWN start instant (the recovered session's,
 * not "now") so the pit view heads itself with the right date.
 */
function initializeSessionStage(sessionId: string, startedAtUtc: string): void {
  // Ticket P5b B1: remembered for the post-session Analysis entry point.
  mostRecentSessionId = sessionId;
  mostRecentSessionStartedAtUtc = startedAtUtc;
  // Ticket P5c-B: "one change per corner per STINT" is scoped to the outing,
  // and so is everything the pit view reads -- a session starts from a clean
  // journal and an empty stint cache.
  suggestionJournal.clear(sessionId);
  stintRunner?.clear();
  stintTraceCache.clear();
  // P5c-FIX2 L16 wiring (LEAD): a batch queued by a PREVIOUS session must not
  // survive into this one -- discard it loudly through the coach's own path.
  stintCoach?.cancelPending(`session-started:${sessionId}`);
  lastStintLapCount = 0;
  stintBoundaries?.reset();
}

/**
 * Callbacks shared by every production `RealSessionFacade` (initial
 * bootstrap AND any later C1 terminal-state rebuild), so the
 * active-session-pointer/history-refresh wiring can never drift between
 * them. `circuitId` (M4 fix) is the circuit THIS specific controller was
 * built for -- captured by the caller (`buildProductionController()`) at the
 * exact moment it's known, so `onSessionStarted` persists the RIGHT circuit
 * alongside the session id it starts, even if the selection changes again
 * later (never mid-session, per H2, but defense in depth regardless).
 */
function productionFacadeCallbacks(circuitId: string): RealSessionFacadeCallbacks {
  return {
    onSessionStarted: (sessionId) => {
      const startedAtUtc = new Date().toISOString();
      if (db !== null) void setActiveSession(db, { sessionId, circuitId, startedAtUtc });
      initializeSessionStage(sessionId, startedAtUtc);
      startTelemetryRecording(sessionId);
    },
    onSessionEnded: () => {
      // P5c-FIX2 L16 wiring (LEAD): the session is over -- a queued cue-update
      // batch may never be applied later; discard it loudly, never silently.
      stintCoach?.cancelPending('session-ended');
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
        if (db !== null) await setActiveSession(db, null);
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
  // M4 fix: `createProductionController()` (just above, inside this same
  // call) always sets `productionControllerCircuitId` before returning --
  // capture it NOW so `onSessionStarted` persists the circuit THIS
  // controller actually runs, not whatever `selectedCircuitId` reads at the
  // moment a session happens to start (which -- while never reachable
  // mid-session, per H2 -- is a strictly weaker guarantee than closing over
  // the value already fixed for this controller's whole lifetime).
  const circuitId = productionControllerCircuitId;
  if (circuitId === null) {
    throw new Error('composition: productionControllerCircuitId not set after createProductionController()');
  }
  productionFacade = new RealSessionFacade(freshController, productionFacadeCallbacks(circuitId));
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

/*
 * `lifecycleLock` (declared near the top of this file, above `SwappableFacade`)
 * replaces the three separate mechanisms this module used to run
 * (`selectionChain`, `rebuildInFlight`, `withDevReplayLock`): every operation
 * that reads or replaces the production controller runs ENTIRELY inside one
 * `lifecycleLock.run(...)` section, so a controller captured by one operation
 * can never be disposed by another mid-flight, and no two operations can
 * commit different circuits.
 *
 * Call rule (enforced by construction throughout this file): code already
 * INSIDE a section calls the `unlocked*` routines below, never the locked
 * public wrappers -- re-entering `run()` would queue behind itself.
 * `lifecycleLock` intentionally refuses the synchronously-detectable form of
 * that mistake with `LifecycleLockReentry` rather than hanging.
 *
 * Deliberately NOT taken by `runBootstrap()`/`retryBootstrap()`: locked
 * operations `await ready()` from INSIDE their section, so a bootstrap that
 * needed the lock would deadlock against the very first such caller. Nothing
 * bootstrap does needs it -- until `ready()` resolves, `facade` is still the
 * inert `PendingFacade` and every locked operation is parked on `ready()`.
 */

/**
 * Disposes the current production controller/facade and installs a fresh one.
 * MUST be called with `lifecycleLock` already held (H3/N2 fix): the whole
 * dispose+install has to be inside the SAME critical section as the decision
 * that asked for it, so the caller's captured controller reference and the
 * module's `controller` can never diverge. A no-op while a DevReplay
 * controller is active (`activeController !== controller`) -- that swap is
 * `restoreProductionFacade()`'s job, not this rebuild's.
 */
async function unlockedRebuildProductionController(): Promise<void> {
  if (controller === null || activeController !== controller) return;
  const staleController = controller;
  const staleFacade = productionFacade;
  // Telemetry addendum (g): defensively stop any still-active recording
  // before the controller it was recording alongside is disposed -- in the
  // normal flow `onSessionEnded` (above) already did this; this guards the
  // 'error' terminal-state path, which does not run through `endSession()`.
  // Awaited (F2 fix) so the final flush actually lands before disposal
  // proceeds, instead of racing ahead of it.
  //
  // P5d-FIX1 H1: skipped during a Test Loop handover. Nothing is recording
  // through a `TelemetryRecorder` at that moment (the learn phase BUFFERS,
  // and the recorder is created a few lines later, for the session this
  // rebuild is installing), so the only thing this call would do is stop the
  // OBD provider that is mid-stream -- a blink in the very continuity this
  // rebuild exists to preserve.
  if (!testLoopHandoverActive) await stopTelemetryRecording();
  await staleController.dispose();
  staleFacade?.dispose();
  installProductionController();
  // CN-FIX6 (contracts.md's "Multi-circuit selection — provider ownership
  // amendment", binding, user finding): THIS layer owns the GNSS provider
  // singleton, so the provider is stopped here, after the fresh controller
  // is installed.
  //
  // Why it is needed: `SessionController.dispose()` stops only a provider
  // the disposed controller itself had running (`providerRunning`), and a
  // `start()` aborted by disposal deliberately never stops a possibly-shared
  // provider (CN-FIX5 item 2 -- core cannot know who owns it). Both are
  // right core-side, and both can leave the OS watcher running with no
  // session behind it: a lit location indicator and a battery drain the user
  // can see, which is exactly the residual this closes.
  //
  // Why it is safe: the controller just installed is idle BY CONSTRUCTION
  // (nothing has started it), the previous controller's pending `start()` --
  // if any -- is serialized by the provider ahead of this stop, and every
  // command that starts a session is itself a locked section queued BEHIND
  // this one, so it restarts the provider through `ensureProviderRunning()`
  // as usual. Idempotent: stopping an already-stopped provider is a no-op.
  //
  // Failure is logged, never thrown: a provider that cannot be stopped (a
  // revoked permission, an OS hiccup) must not fail the selection/recovery/
  // delete-all operation that drove this rebuild.
  try {
    // P5d-FIX1 H1 (binding, Codex P5d-REV1 HIGH 1): the ONE exception to the
    // ownership stop. While a Test Loop is being learned or handed over, the
    // watcher is NOT session-less -- the learn phase owns it, its fixes are
    // being recorded, and the session about to start on the just-learned
    // circuit is what this very rebuild exists to install. Stopping it here
    // would blind the recording for the length of the rebuild, which is
    // exactly the gap this fix wave removed. Everything the amendment guards
    // against (a lit indicator with nothing behind it) still holds: the
    // Test Loop path stops the provider itself when a learn phase ends
    // without a track (`stopTestLoop`), and the session's own end still runs
    // the ordinary teardown.
    if (!testLoopHandoverActive) await gnssProvider?.stop();
  } catch (error) {
    console.warn('[composition] stopping the GNSS provider after a controller rebuild failed', error);
  }
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
 * that it takes effect next session instead.
 *
 * N2 fix (lifecycle lock amendment, binding): the rebuild runs inside
 * `lifecycleLock`, and the "is the controller genuinely idle/terminal?"
 * decision is re-taken INSIDE that section -- so a coaching toggle flipped
 * while `resumeRecovery()` is awaiting its checkpoint read now queues behind
 * the resume and then correctly SKIPS (the controller is mid-session by
 * then), instead of disposing the controller recovery had already captured.
 * The cheap synchronous pre-check below is kept as-is so a toggle observed
 * before any controller exists (bootstrap's own settings hydration) stays the
 * exact no-op it always was. Registered ONCE at module load (not inside `runBootstrap()`,
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
  void lifecycleLock
    .run(async () => {
      // Re-checked with the lock HELD: whatever was true when the toggle
      // fired may no longer be true by the time this section actually runs.
      if (controller === null || activeController !== controller) return;
      if (!COACHING_REBUILD_STATES.has(currentControllerState(controller))) return;
      await unlockedRebuildProductionController();
    })
    .catch((error: unknown) => {
      console.warn('[composition] coaching-settings rebuild failed', error);
    });
});

/**
 * Resolves which bundled circuit a recoverable checkpoint belongs to
 * (contracts.md's Multi-circuit selection addendum, ticket CN-W3):
 * `LocalSessionRepository.loadCheckpoint` returns only `{ snapshot, laps }`
 * -- no `circuitId` -- so the sole available signal is whether `sessionId`
 * appears in some bundled circuit's COMPLETED-session history
 * (`listSessions`).
 *
 * DEVIATION from the addendum's literal text (flagged in this ticket's
 * report): the addendum reads "a checkpoint whose circuit is not bundled is
 * discarded with a warning", which taken literally would mean "not found in
 * ANY circuit's listSessions -> discard". But `@circuit/core` only ever
 * writes a row into the `sessions` table inside `SessionController.endSession()`
 * (packages/core/src/controller/sessionController.ts:557-568; see also
 * persistence-sql/sqlSessionRepository.ts:218-222's own comment: "a session
 * that has a checkpoint ... but was never saved via saveSession ... has no
 * row in `sessions`") -- a genuinely in-progress or just-crashed session's
 * checkpoint is BY CONSTRUCTION never present in ANY circuit's
 * `listSessions` result yet (its own row cannot exist until the session
 * ends). Discarding on every "not found" would therefore silently disable
 * the ADR-0003 §3 recovery feature on a session's first crash, for EITHER
 * circuit -- including every scenario `composition.recovery.test.ts` already
 * exercises (each seeds a checkpoint with no matching `sessions` row and
 * asserts recovery IS still offered), which would violate this ticket's own
 * "TMR default path must remain behaviorally identical" constraint.
 *
 * Returning `null` here therefore means "no cross-circuit evidence either
 * way -- keep the CURRENTLY SELECTED circuit" rather than "discard": a
 * session can only ever have been started under whatever circuit was
 * selected when it began (mid-session selection changes are unreachable
 * from the UI, per the addendum itself), so the persisted selection is
 * already the right answer in the overwhelmingly common case. A match IS
 * switched to when found -- e.g. an active-session pointer left lingering
 * after a session that actually completed (and so has a real `sessions`
 * row) under a DIFFERENT circuit than the one currently selected.
 *
 * M4 fix (recovery amendment, ticket CN-FIX2): this scan is now only the
 * SECOND priority, behind the persisted `activeSessionCircuitId` (see
 * `runBootstrap()`'s recovery block below) -- it stays exactly as it was for
 * a LEGACY checkpoint written before that key existed (or the web/in-memory
 * preview, which has no persistent key at all).
 */
async function resolveRecoveryCircuitId(repo: LocalSessionRepository, sessionId: string): Promise<string | null> {
  for (const summary of circuitCatalog.list()) {
    const sessions = await repo.listSessions(LOCAL_USER_ID, summary.circuitId);
    if (sessions.some((s) => s.sessionId === sessionId)) return summary.circuitId;
  }
  return null;
}

/** Result of `selectCircuit()` (H2 fix, binding): `{ ok: false, reason: 'SESSION_ACTIVE' }` when refused -- settings/history are left completely untouched on that path. */
export interface SelectCircuitResult {
  ok: boolean;
  reason?: 'SESSION_ACTIVE';
}

/**
 * H2 fix (binding): a selection is refused -- never applied -- unless the
 * controller currently driving `facade` is genuinely BETWEEN sessions.
 *
 * N3 fix (lifecycle lock amendment, binding, ticket CN-FIX3): expressed as
 * the idle/terminal ALLOW-list rather than the old
 * `outLap`/`timing`/`inPit`/`paused` deny-list. The preflight gate now
 * forwards START_PREFLIGHT from inside the lock, so a selection queued behind
 * it observes a controller already in `preflight`/`awaitingCalibration`/
 * `calibrating`/`calibrationReview`/`armed` -- states the deny-list let
 * through, which is exactly how the started session and the persisted
 * selection ended up on different circuits. Every one of them is now a
 * refusal; `idle`/`sessionComplete`/`error` (the same set the coaching
 * rebuild treats as "safe to replace the controller") still pass.
 */
const SELECTABLE_STATES = new Set<SessionState>(['idle', 'sessionComplete', 'error']);

/**
 * Genuinely mid-session (a drive is under way): the states in which tearing
 * anything down under the driver is unacceptable. Used by the app-background
 * checkpoint hook (checkpoint ONLY these) and by `deleteAllStoredUserData()`
 * (refuse for these) -- contracts.md's facade boundary amendment, binding.
 * `'paused'` counts unconditionally, as it does everywhere else in this file.
 */
const MID_SESSION_STATES = new Set<SessionState>(['outLap', 'timing', 'inPit', 'paused']);

/** Applies a validated circuit selection to the persisted settings ONLY -- no bootstrap-await, no session-active refusal, no serialization. Shared by the public `selectCircuit()` below and `runBootstrap()`'s own recovery-circuit switch, which CANNOT go through `selectCircuit()` itself: that function awaits `ready()` (i.e. `bootstrapPromise`), and calling it from inside `runBootstrap()` -- the very function that promise is for -- would deadlock forever. */
function applySelectedCircuit(entry: BundledCircuit): void {
  settingsStore.update({ selectedCircuitId: entry.profile.circuitId });
}

/** Rebuilds/refreshes `SqlSessionHistoryStore` for `entry` and swaps it into `historyWrapper` -- the same no-op-if-bootstrap-incomplete guard `runBootstrap()`'s own initial build and `selectCircuit()` share. Split out from `applySelectedCircuit()` (rather than always paired) so `runBootstrap()`'s recovery block can call both in sequence exactly once, without a second, redundant history rebuild layered on top via a full `selectCircuit()` call. */
async function rebuildHistoryForSelection(entry: BundledCircuit): Promise<void> {
  if (repository === null) return;
  const history = new SqlSessionHistoryStore(
    repository,
    LOCAL_USER_ID,
    entry.profile.circuitId,
    entry.profile.layoutId,
    entry.profile.layoutVersion,
  );
  await history.refresh();
  historyWrapper.setInner(history);
  historyStore = history;
}

/**
 * The selection change itself -- settings + history store, in that order.
 * MUST be called with `lifecycleLock` held (M1 fix's ordering guarantee now
 * comes from the lock, which every other lifecycle operation shares, rather
 * than from a selection-only chain). Callers are the locked `selectCircuit()`
 * below, `resumeRecovery()`'s recovery-circuit switch, and
 * `runDevReplayScenario()`.
 */
async function unlockedApplySelection(entry: BundledCircuit): Promise<void> {
  applySelectedCircuit(entry);
  await rebuildHistoryForSelection(entry);
  // N3 fix (lifecycle lock amendment, binding, ticket CN-FIX3): the
  // production controller is rebuilt for the new circuit HERE, in the same
  // critical section as the settings/history writes, so the invariant "an
  // IDLE production controller is always built for the resolved selection"
  // holds continuously. Previously the rebuild happened lazily, in the
  // preflight gate only -- and `RealSessionFacade.startPreflight()` is a
  // no-op controller-side (the state machine first moves at
  // `beginCalibration()`), so a selection committed after the gate had
  // already run left the NEXT session starting on the previous circuit's
  // geometry while settings/history said otherwise. Restricted to `idle`
  // exactly like the gate's own circuit-change trigger: a terminal
  // (`sessionComplete`/`error`) controller is still the gate's to replace,
  // and a mid-session one is unreachable here (the selection would have been
  // refused before this point).
  if (
    controller !== null &&
    activeController === controller &&
    currentControllerState(controller) === 'idle' &&
    productionControllerCircuitId !== resolveSelectedCircuit(settingsStore.getSettings()).profile.circuitId
  ) {
    await unlockedRebuildProductionController();
  }
}

/** Shared refusal check for every locked selection change -- `null` when the change may proceed. */
function refuseSelectionIfSessionActive(): SelectCircuitResult | null {
  if (activeController !== null && !SELECTABLE_STATES.has(currentControllerState(activeController))) {
    return { ok: false, reason: 'SESSION_ACTIVE' };
  }
  return null;
}

/**
 * Selects the app's ONE active circuit (contracts.md's Multi-circuit
 * selection addendum, ticket CN-W3, extended by the "recovery amendment",
 * ticket CN-FIX2): validates `circuitId` against the bundled catalog (an
 * unknown id is a warned no-op, never a crash/rejection), then --
 *
 *  - H1 fix: awaits `ready()` (bootstrap) FIRST, so a selection tapped
 *    during cold-launch bootstrap is never silently lost to the settings
 *    hydration that follows it (the temporary in-memory settings store
 *    being overwritten by the just-loaded persisted one).
 *  - H3 fix: no rebuild can be in flight while this runs -- rebuilds are
 *    sections of the SAME `lifecycleLock` (ticket CN-FIX3), so one has either
 *    already finished or has not started.
 *  - H2/N3 fix: is REFUSED -- `{ ok: false, reason: 'SESSION_ACTIVE' }`,
 *    settings/history untouched -- unless `activeController` is genuinely
 *    between sessions (`SELECTABLE_STATES`).
 *  - M1 fix: serialized against every other lifecycle operation (not just
 *    other selections) by `lifecycleLock`'s FIFO ordering.
 *
 * Persists the choice, rebuilds/refreshes `SqlSessionHistoryStore` for it --
 * the SAME `historyWrapper.setInner()` + `refresh()` sequence bootstrap
 * itself uses, so History/PB immediately reflect the newly selected circuit
 * -- and (N3 fix) rebuilds the idle production controller for it in the same
 * critical section, so the controller and the persisted selection can never
 * be observed disagreeing. See `unlockedApplySelection()`.
 */
export function selectCircuit(circuitId: string): Promise<SelectCircuitResult> {
  const entry = circuitCatalog.get(circuitId);
  if (entry === null) {
    console.warn(`[composition] selectCircuit: unknown circuitId "${circuitId}" -- ignoring`);
    return Promise.resolve({ ok: true });
  }

  return lifecycleLock.run(async (): Promise<SelectCircuitResult> => {
    // H1 fix: bootstrap must be fully done (settings hydrated, production
    // controller built) before anything below runs. Awaited from INSIDE the
    // section deliberately -- bootstrap never takes this lock, so there is
    // nothing to deadlock against, and holding the lock across the wait is
    // what keeps a selection tapped during cold launch ordered against
    // everything issued after it.
    await ready();
    // H2/N3 fix: refuse unless the controller is genuinely between sessions.
    // No separate rebuild wait is needed any more (H3): a rebuild can only
    // run in its own section, which has already finished by the time this one
    // starts.
    const refusal = refuseSelectionIfSessionActive();
    if (refusal !== null) return refusal;
    await unlockedApplySelection(entry);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Test Loop mode (ticket P5d, contracts.md "Test Loop mode (Phase 5d)";
// hardened by ticket P5d-FIX1 after Codex P5d-REV1).
//
// The learn phase is the ONLY part of the app that consumes GNSS fixes before
// a `SessionController` exists -- there is no circuit to run a session against
// yet, because lap 1 is what creates one. Everything else about it is an
// ORDINARY session, and that is the point of the P5d-FIX1 H1 rework:
//
//   * the recording pipeline (GNSS + IMU + OBD) runs from the moment learning
//     starts, not from the moment a circuit exists;
//   * every fix is kept (`TestLoopLocationProvider`), so the learning lap is
//     recorded rather than merely watched;
//   * when lap 1 closes, the learned circuit is persisted, registered and
//     selected, a controller is built for it, the session starts and is armed,
//     and the whole backlog is replayed into it IN ORDER -- no provider is
//     stopped, nothing is dropped, and the driving that continues is timed
//     against the track just learned. There is no "Start timing" handover any
//     more, because there is nothing left to hand over.
//
// The learning lap becomes the session's OUT-LAP: its trace is stored (as lap
// 0) and its OBD/IMU samples are recorded, and timing starts at the moment the
// car crosses the start point it has just defined -- exactly how a session on
// a bundled circuit behaves after the out-lap.
// ---------------------------------------------------------------------------

/** The learned circuits on this device -- `null` until bootstrap opens the database (and on web, where there is none). */
let learnedCircuitStore: SqlLearnedCircuitStore | null = null;
/** Learned circuits held in memory only (the web dev preview has no database to persist them to). */
let memoryLearnedCircuits: LearnedCatalogEntry[] = [];
/**
 * P5d-FIX1 H1: the buffering provider that spans the learn phase and the
 * session that grows out of it. Non-null for exactly that window; every
 * controller built while it is set is built ON it (see
 * `createProductionController`), which is what makes the handover seamless.
 */
let testLoopProvider: TestLoopLocationProvider | null = null;
/**
 * P5d-FIX2 N5: TRUE only for the handover window (closure -> replay). The two
 * provider-cleanup exceptions are scoped to this flag rather than to the
 * provider reference, so a rebuild AFTER the handover cleans up normally.
 */
let testLoopHandoverActive = false;
/**
 * P5d-FIX2 N2: which adoption steps have already happened, so a retry resumes
 * instead of repeating them. Cleared when the adoption completes.
 */
interface AdoptionProgress {
  circuitId: string;
  storedProfile?: CircuitProfile;
  selected?: boolean;
  sessionId?: string;
  recordingStarted?: boolean;
  outLapSaved?: boolean;
}
let adoptionProgress: AdoptionProgress | null = null;
/** P5d-FIX3 F11: bumped by every new learn phase, so a teardown queued for an older one is a no-op. */
let teardownGeneration = 0;
/** The teardown currently running -- a second caller awaits this one instead of starting another. */
let teardownInFlight: Promise<void> | null = null;
/** OBD/IMU samples recorded during the learn phase, before a session id exists to tag them with. */
let testLoopTelemetryBuffer: TelemetrySample[] = [];
let unsubscribeTestLoopTelemetry: (() => void) | null = null;
let unsubscribeTestLoopGForce: (() => void) | null = null;
/** Whether the learn phase holds its own G-force reference (released when the session takes its own). */
let testLoopHoldsGForce = false;
/** Bound on the learn-phase telemetry backlog -- an hour of 10 Hz channels. */
const MAX_TEST_LOOP_TELEMETRY_SAMPLES = 360_000;
let testLoopTelemetryDropped = 0;

/** Republishes the catalog's learned registry from the store (plus any memory-only entries). */
function publishLearnedCircuits(): void {
  const stored: LearnedCatalogEntry[] =
    learnedCircuitStore === null
      ? []
      : learnedCircuitStore.entries().map((entry) => ({
          circuit: { profile: entry.profile, runtime: entry.runtime, corners: entry.corners },
          listed: entry.record.saved,
        }));
  setLearnedCircuits([...stored, ...memoryLearnedCircuits]);
}

/**
 * The learn phase's state machine. Created once at module load: it holds no
 * database and no provider, so it is safe to exist before bootstrap.
 *
 * `makeCircuitId` is a UUID (P5d-FIX1 item 10) -- learned circuits are keyed
 * by it in the database, and a timestamp-plus-random id invites exactly the
 * collision that an `INSERT OR REPLACE` would silently resolve by destroying
 * somebody's saved circuit.
 */
const testLoopController = new TestLoopController({
  nowUtc: () => new Date().toISOString(),
  makeCircuitId: () => `learned-${newLearnedCircuitId()}`,
  makeDisplayName: (createdAtUtc) =>
    defaultLearnedCircuitName(settingsStore.getSettings().language, createdAtUtc),
  onLearned: (circuit) => adoptLearnedCircuit(circuit),
});

/** RFC-4122 v4 where the runtime offers one, and a random-hex fallback where it does not. */
function newLearnedCircuitId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const hex = (length: number): string =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/**
 * P5d-FIX2 N6 (Codex P5d-REV2): a learn phase that gives up on its own -- the
 * sample cap, most of all -- must not leave the GNSS watcher and the channel
 * buffers running behind a screen that now says it failed. The teardown is the
 * same one `stopTestLoop()` performs, and it is idempotent, so the two paths
 * cannot fight.
 */
testLoopController.subscribe((snapshot) => {
  if (snapshot.phase !== 'failed') return;
  if (testLoopProvider === null && !testLoopHoldsGForce) return;
  void tearDownLearnPhase().catch((error) => {
    console.warn('[composition] tearing down a failed learn phase failed', error);
  });
});

/**
 * The ONE teardown of a learn phase (P5d-FIX3 F11, Codex P5d-REV3): detach the
 * learn-phase recording, release its holds, stop the buffering provider.
 *
 * Memoized and generation-guarded, and it takes `lifecycleLock` itself. Two
 * paths reach it for the same failure -- `stopTestLoop()` and the auto-teardown
 * subscription that the failed phase fires -- and before this they could both
 * be shutting the GLOBAL providers down at once. Now the second caller awaits
 * the first, and a teardown queued behind a learn phase that has meanwhile
 * been restarted does nothing at all (the generation moved on).
 */
function tearDownLearnPhase(): Promise<void> {
  if (teardownInFlight !== null) return teardownInFlight;
  const generation = teardownGeneration;
  const run = lifecycleLock
    .run(async () => {
      if (generation !== teardownGeneration) return;
      detachTestLoopRecording();
      testLoopTelemetryBuffer = [];
      await releaseTestLoopGForce();
      await stopTelemetryRecording();
      await disposeTestLoopProvider();
    })
    .finally(() => {
      if (teardownInFlight === run) teardownInFlight = null;
    });
  teardownInFlight = run;
  return run;
}

/**
 * P5d-FIX3 F10 / P5d-FIX4 G1 -- the Test Loop adoption journal lives in
 * `adoptionJournal.ts` (claim, compare-and-delete, attempt budget, orphan
 * deletion). These are the two thin bindings the adoption path itself needs.
 */

/** The journal identity of the adoption currently in flight. */
let adoptionJournalId: string | null = null;
/** P5d-FIX5 H1: the exact journal row this adoption last wrote -- what it is allowed to clear. */
let adoptionJournalOwned: ClaimedAdoptionJournal | null = null;

async function stageAdoptionJournal(journal: {
  circuitId: string;
  stage: AdoptionStage;
  sessionId?: string;
}): Promise<void> {
  if (db === null) return;
  adoptionJournalId ??= newJournalId();
  // P5d-FIX5 H1: the journal key holds ONE adoption. If another flow (a second
  // launch's repair claim, a newer adoption) has taken it since this one last
  // wrote, it is not ours to overwrite -- this adoption simply proceeds without
  // a journal rather than destroying somebody else's.
  const current = await readAdoptionJournal(db);
  if (current !== null && current.id !== adoptionJournalId) {
    adoptionJournalOwned = null;
    console.warn(
      '[composition] the adoption journal key is held by another flow -- continuing without journalling this adoption',
    );
    return;
  }
  adoptionJournalOwned = await writeAdoptionJournal(db, {
    id: adoptionJournalId,
    attempts: 0,
    circuitId: journal.circuitId,
    stage: journal.stage,
    ...(journal.sessionId === undefined ? {} : { sessionId: journal.sessionId }),
  });
}

/**
 * Clears the journal of a COMPLETED adoption -- and ONLY the row this adoption
 * itself wrote (P5d-FIX5 H1). A blind delete by key would take out whatever
 * journal occupies it by then: a second launch's repair claim, or a newer
 * adoption already in flight. If the row has moved on, it belongs to somebody
 * else and is left exactly where it is.
 */
async function clearOwnAdoptionJournal(): Promise<void> {
  const owned = adoptionJournalOwned;
  adoptionJournalId = null;
  adoptionJournalOwned = null;
  if (db === null || owned === null) return;
  const cleared = await clearClaimedJournal(db, owned);
  if (!cleared) {
    console.warn(
      '[composition] the adoption journal changed while an adoption was finishing -- leaving it to its owner',
    );
  }
}

/**
 * Bootstrap repair: finish a half-adopted Test Loop, or undo it.
 *
 * P5d-FIX4 G1: the journal is CLAIMED first (a compare-and-swap on its own
 * UUID), so of several launches racing over the same database exactly one
 * repairs and the others do nothing. The journal is cleared only once the
 * repair has fully succeeded, and only if it is still the row this launch
 * claimed -- a slow launch can never wipe a newer adoption's journal. A repair
 * that fails leaves the journal in place with its attempt counted; after
 * `MAX_ADOPTION_REPAIR_ATTEMPTS` the app stops trying and says so.
 *
 *  - the learned geometry IS on disk -> the irreversible half succeeded, so the
 *    adoption is COMPLETED here (registered by the caller, selected below);
 *  - the geometry is NOT there -> the orphans are DELETED outright (P5d-FIX4
 *    G3): the half-written circuit row, and the session that was started for
 *    it, with its checkpoint, laps and telemetry, in one transaction.
 *
 * Runs before the production controller and the history store are built, so
 * the selection it settles is the one they are built for. Never throws.
 */
async function repairInterruptedAdoption(database: SqlDatabase): Promise<void> {
  const claim = await claimAdoptionJournal(database, newJournalId());
  if (claim === null) return;
  const journal = claim.journal;

  if (claim.exhausted) {
    // Three launches have now failed to repair this. Stop retrying, say so,
    // and let the driver deal with a device that keeps refusing writes.
    setRecoveryNotice(
      'A test loop could not be repaired after several attempts and has been abandoned.',
    );
    await clearClaimedJournal(database, claim);
    return;
  }

  try {
    const entry = learnedCircuitStore?.get(journal.circuitId) ?? null;
    if (entry !== null) {
      applySelectedCircuit({
        profile: entry.profile,
        runtime: entry.runtime,
        corners: entry.corners,
      });
      setRecoveryNotice(
        `The test loop "${entry.profile.displayName}" was kept, but the session it started was interrupted.`,
      );
    } else {
      // P5d-FIX5 M2: the session and its pointer rows go together, in one
      // transaction -- there is no window where the pointer names a session
      // that has already been deleted.
      if (journal.sessionId !== undefined) {
        await deleteOrphanSession(database, journal.sessionId);
      }
      await database.runAsync('DELETE FROM learned_circuits WHERE circuit_id = ?', [
        journal.circuitId,
      ]);
      if (learnedCircuitStore !== null) await learnedCircuitStore.refresh();
      publishLearnedCircuits();
      setRecoveryNotice(
        'A test loop could not be saved before the app closed, so it was discarded.',
      );
    }
  } catch (error) {
    // The journal STAYS -- with this attempt counted -- so the next launch can
    // try again rather than leaving the half-adopted state unowned forever.
    console.warn('[composition] repairing an interrupted test-loop adoption failed', error);
    return;
  }
  await clearClaimedJournal(database, claim);
}


/** Live learn-phase state for the Test Loop screen. */
export function subscribeTestLoop(listener: (snapshot: TestLoopSnapshot) => void): () => void {
  return testLoopController.subscribe(listener);
}

export function testLoopSnapshot(): TestLoopSnapshot {
  return testLoopController.snapshot();
}

/** Ownership diagnostics for Test Loop mode (P5d-FIX2 N5) -- what still holds the GNSS watcher. */
export function testLoopDiagnostics(): {
  providerAttached: boolean;
  handoverActive: boolean;
  bufferedTelemetry: number;
  droppedTelemetry: number;
} {
  return {
    providerAttached: testLoopProvider !== null,
    handoverActive: testLoopHandoverActive,
    bufferedTelemetry: testLoopTelemetryBuffer.length,
    droppedTelemetry: testLoopTelemetryDropped,
  };
}

/**
 * P5d-FIX1 H1: the OBD and IMU half of the recording pipeline, running from
 * the START of the learn phase. There is no session id yet to tag samples
 * with, so they are buffered here and written the instant one exists -- with
 * `lap_number` NULL, which is exactly what that column means for samples
 * recorded before the first lap (Telemetry addendum).
 */
function startTestLoopRecording(): void {
  testLoopTelemetryBuffer = [];
  testLoopTelemetryDropped = 0;
  if (!settingsStore.getSettings().telemetryEnabled) return;

  const buffer = (sample: TelemetrySample): void => {
    if (testLoopTelemetryBuffer.length >= MAX_TEST_LOOP_TELEMETRY_SAMPLES) {
      testLoopTelemetryDropped += 1;
      return;
    }
    testLoopTelemetryBuffer.push(sample);
  };
  unsubscribeTestLoopTelemetry = telemetryProvider.onSample(buffer);
  unsubscribeTestLoopGForce = gForceProvider.onSample(buffer);
  try {
    telemetryProvider.start();
  } catch (error) {
    console.warn('[composition] telemetryProvider.start() threw synchronously (test loop)', error);
  }
  if (!testLoopHoldsGForce) {
    acquireGForce();
    testLoopHoldsGForce = true;
  }
}

/** Detaches the learn-phase buffers. The providers themselves keep running -- the session owns them now. */
function detachTestLoopRecording(): void {
  unsubscribeTestLoopTelemetry?.();
  unsubscribeTestLoopTelemetry = null;
  unsubscribeTestLoopGForce?.();
  unsubscribeTestLoopGForce = null;
}

/** Releases the learn phase's own G-force hold (the session takes its own in `startTelemetryRecording`). */
async function releaseTestLoopGForce(): Promise<void> {
  if (!testLoopHoldsGForce) return;
  testLoopHoldsGForce = false;
  try {
    await releaseGForce();
  } catch (error) {
    console.warn('[composition] releasing the test-loop G-force hold failed', error);
  }
}

/**
 * Begins a learn phase: starts the GNSS provider through the buffering
 * wrapper, starts the OBD/IMU recording, and feeds every fix to
 * `TestLoopController`. Refuses while a session is live -- learning a track
 * and timing laps are two different uses of the same provider.
 */
export async function startTestLoop(): Promise<
  { ok: true } | { ok: false; reason: 'not-ready' | 'session-active' }
> {
  await ready();
  return lifecycleLock.run(async () => {
    if (gnssProvider === null) return { ok: false as const, reason: 'not-ready' as const };
    if (controller !== null && sessionIsActive(currentControllerState(controller))) {
      return { ok: false as const, reason: 'session-active' as const };
    }
    await disposeTestLoopProvider();
    // A fresh learn phase: any teardown still queued for the previous one must
    // not reach in and stop the providers this one is about to use.
    teardownGeneration += 1;
    const provider = new TestLoopLocationProvider(gnssProvider, (sample) =>
      testLoopController.feed(sample),
    );
    testLoopProvider = provider;
    testLoopController.start();
    await provider.start();
    startTestLoopRecording();
    return { ok: true as const };
  });
}

/**
 * Ends a learn phase that never closed a loop. A loop that WAS learned is
 * already a running session by the time this can be called, and is ended
 * through the ordinary `facade.endSession()` instead.
 */
export async function stopTestLoop(): Promise<TestLoopSnapshot> {
  const snapshot = testLoopController.stop();
  if (snapshot.phase !== 'learned' && snapshot.phase !== 'adopting') {
    await tearDownLearnPhase();
  }
  return snapshot;
}

/** Leaves Test Loop mode entirely (screen dismissed without a learned track). */
export async function resetTestLoop(): Promise<void> {
  await stopTestLoop();
  testLoopController.reset();
}

/** P5d-FIX1 H3: retries a handover that failed, on the SAME learned geometry. */
export function retryTestLoopAdoption(): void {
  testLoopController.retryAdopt();
}

/** Stops and clears the buffering provider, handing the GNSS watcher back to the plain singleton. */
async function disposeTestLoopProvider(): Promise<void> {
  const provider = testLoopProvider;
  testLoopProvider = null;
  testLoopHandoverActive = false;
  if (provider === null) return;
  try {
    await provider.stop();
  } catch (error) {
    console.warn('[composition] stopping the test-loop provider failed', error);
  }
}

/**
 * The moment lap 1 closes (P5d-FIX1 H1 + H3). Everything below is ONE
 * `lifecycleLock` section, and every step is awaited: the driver is only told
 * the track was learned once it is genuinely persisted, registered, selected
 * and being timed. A throw anywhere here surfaces as the controller's `error`
 * phase, with a retry -- never as a session quietly running on the previously
 * selected circuit.
 */
async function adoptLearnedCircuit(circuit: TestLoopCircuit): Promise<void> {
  const provider = testLoopProvider;
  // From here on the learner is done, but every fix still arrives and is
  // still kept -- the controller receives them after it is armed, in order.
  testLoopHandoverActive = true;
  provider?.beginHandover();
  // P5d-FIX2 N7: the out-lap trace is the QUALIFIED lap the geometry was built
  // from, not everything the buffer happens to hold by now.
  const learningSamples = circuit.lapSamples;

  await lifecycleLock.run(async () => {
    // P5d-FIX2 N2 (Codex P5d-REV2 HIGH 2): every step below is recorded in a
    // ledger, and every step is skipped when the ledger says it already
    // happened. A retry after a failure half-way through therefore RESUMES --
    // it never inserts a second circuit, starts a second session, or writes
    // the out-lap trace twice.
    const ledger = (adoptionProgress ??= { circuitId: circuit.profile.circuitId });
    // P5d-FIX3 F10: the journal is on disk BEFORE the first side effect, so a
    // kill at any point below leaves a state the next launch can finish or undo.
    await stageAdoptionJournal({ circuitId: ledger.circuitId, stage: 'staged' });

    // 1. Keep it. A learned circuit that cannot be stored cannot be analysed
    //    after a restart, so this failing is a real failure, not a warning.
    if (ledger.storedProfile === undefined) {
      if (learnedCircuitStore !== null) {
        const stored = await putLearnedCircuitWithFreshId(circuit);
        ledger.storedProfile = stored.profile;
      } else {
        // Web dev preview: no database, so the learned circuit lives for this
        // process only. It is still a real circuit while it lasts.
        const profile = circuit.profile;
        memoryLearnedCircuits = [
          ...memoryLearnedCircuits.filter(
            (entry) => entry.circuit.profile.circuitId !== profile.circuitId,
          ),
          {
            circuit: { profile, runtime: circuit.runtime, corners: circuit.corners },
            listed: false,
          },
        ];
        ledger.storedProfile = profile;
      }
      publishLearnedCircuits();
      await stageAdoptionJournal({ circuitId: ledger.storedProfile.circuitId, stage: 'stored' });
    }
    const profile = ledger.storedProfile;

    // 2. Select it, and rebuild the production controller for it. Both go
    //    through the SAME unlocked routine `selectCircuit()` uses -- this
    //    section already holds the lock, so the public wrapper would deadlock.
    if (!ledger.selected) {
      const entry = circuitCatalog.get(profile.circuitId);
      if (entry === null) {
        throw new Error(`the learned circuit ${profile.circuitId} could not be registered`);
      }
      await unlockedApplySelection(entry);
      if (productionControllerCircuitId !== profile.circuitId) {
        await unlockedRebuildProductionController();
      }
      ledger.selected = true;
      await stageAdoptionJournal({ circuitId: profile.circuitId, stage: 'selected' });
    }
    const ctrl = controller;
    if (ctrl === null) throw new Error('no production controller to run the learned circuit on');

    // 3. Start the session on it and arm it. `start('session')` deliberately
    //    skips calibration (the same path `resumeRecovery()` uses): the
    //    geometry came from this driver, on this road, minutes ago -- there is
    //    nothing a recognition lap could add to it.
    if (ledger.sessionId === undefined) {
      await ctrl.start('session');
      ctrl.arm();
      const startedSessionId = ctrl.diagnostics().sessionId;
      if (startedSessionId === null) throw new Error('the learned-circuit session did not start');
      ledger.sessionId = startedSessionId;
      await stageAdoptionJournal({
        circuitId: profile.circuitId,
        stage: 'session-started',
        sessionId: startedSessionId,
      });
    }
    const sessionId = ledger.sessionId;

    // 4. The recording pipeline the learn phase was already running now
    //    belongs to a session: same hooks a normal start goes through.
    //
    //    P5d-FIX2 N3: the learn-phase subscriptions are detached in the SAME
    //    synchronous step that attaches the session's recorder -- no await
    //    between them, so no sample can ever reach both and be written twice.
    if (!ledger.recordingStarted) {
      detachTestLoopRecording();
      startTelemetryRecording(sessionId);
      const startedAtUtc = new Date().toISOString();
      initializeSessionStage(sessionId, startedAtUtc);
      ledger.recordingStarted = true;
      if (db !== null) {
        await setActiveSession(db, { sessionId, circuitId: profile.circuitId, startedAtUtc });
      }
      await flushTestLoopTelemetry();
      await releaseTestLoopGForce();
      await stageAdoptionJournal({ circuitId: profile.circuitId, stage: 'recording', sessionId });
    }

    // 5. The learning lap is STORED as the session's out-lap trace (lap 0),
    //    so the drive that defined the track is not lost.
    if (!ledger.outLapSaved) {
      if (learningSamples.length > 0 && repository !== null) {
        await repository.saveTelemetry(sessionId, 0, learningSamples);
      }
      ledger.outLapSaved = true;
      await stageAdoptionJournal({ circuitId: profile.circuitId, stage: 'out-lap', sessionId });
    }

    // 6. Finally, hand the whole backlog to the controller in order -- the
    //    learning lap first, then every fix that arrived while this ran. From
    //    the next fix onwards the session is simply live.
    provider?.flushBuffered();
    // P5d-FIX2 N5: the handover is over. The module lets go of the buffering
    // provider (the running controller keeps its own reference) so every later
    // rebuild takes the ORDINARY provider-cleanup path again.
    testLoopProvider = null;
    testLoopHandoverActive = false;
    adoptionProgress = null;
    // The adoption is complete: nothing is left for a later launch to repair.
    await clearOwnAdoptionJournal();
  });
}

/**
 * P5d-FIX1 item 10: a plain INSERT, with a fresh id on the (vanishingly
 * unlikely) collision, instead of an INSERT OR REPLACE that would silently
 * overwrite an existing learned circuit -- along with the sessions recorded
 * on it.
 */
async function putLearnedCircuitWithFreshId(
  circuit: TestLoopCircuit,
): Promise<{ profile: CircuitProfile }> {
  const store = learnedCircuitStore;
  if (store === null) throw new Error('no learned-circuit store');
  let profile = circuit.profile;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await store.insert({ profile, corners: circuit.corners, saved: false });
    if (result.ok) return { profile };
    console.warn(
      `[composition] learned circuit id "${profile.circuitId}" was already taken -- regenerating`,
    );
    profile = Object.freeze({ ...profile, circuitId: `learned-${newLearnedCircuitId()}` });
  }
  throw new Error('could not find a free id for the learned circuit');
}

/** Writes the learn phase's buffered OBD/IMU samples into the session's recorder, tagged pre-lap. */
async function flushTestLoopTelemetry(): Promise<void> {
  const buffered = testLoopTelemetryBuffer;
  testLoopTelemetryBuffer = [];
  if (buffered.length === 0) return;
  if (testLoopTelemetryDropped > 0) {
    console.warn(
      `[composition] ${testLoopTelemetryDropped} learn-phase telemetry samples were dropped (buffer bound)`,
    );
  }
  await recordPreLapTelemetry(buffered);
}

/** Every learned circuit on this device, newest first (saved and unsaved alike). */
export function listLearnedCircuits(): LearnedCircuitRecord[] {
  if (learnedCircuitStore !== null) return learnedCircuitStore.entries().map((e) => e.record);
  return memoryLearnedCircuits.map((entry) => ({
    circuitId: entry.circuit.profile.circuitId,
    displayName: entry.circuit.profile.displayName,
    lengthM: entry.circuit.profile.totalLengthM,
    cornerCount: entry.circuit.corners.length,
    createdAtUtc: entry.circuit.profile.createdAtUtc,
    saved: entry.listed,
  }));
}

/**
 * Ticket T6's "Save circuit": names a learned loop and promotes it to a
 * first-class entry in the circuit list. Never available without a database --
 * a circuit that cannot outlive the process was never saved.
 */
export async function saveLearnedCircuit(
  circuitId: string,
  displayName: string,
): Promise<{ ok: true } | { ok: false; reason: 'not-ready' | 'unknown-circuit' | 'empty-name' }> {
  if (displayName.trim().length === 0) return { ok: false, reason: 'empty-name' };
  if (learnedCircuitStore === null) return { ok: false, reason: 'not-ready' };
  const saved = await learnedCircuitStore.markSaved(circuitId, displayName);
  if (!saved) return { ok: false, reason: 'unknown-circuit' };
  publishLearnedCircuits();
  return { ok: true };
}

/**
 * Deletes a learned circuit.
 *
 * P5d-FIX1 item 9 (Codex P5d-REV1 MEDIUM 9): serialized with the session
 * lifecycle and refused for geometry that is IN USE -- the running session's
 * circuit, or the circuit named by the active-session pointer whose row does
 * not exist yet. Completed sessions still block it too (see
 * `SqlLearnedCircuitStore.remove`): a session whose geometry is gone can no
 * longer be analysed or replayed, so the driver deletes the sessions first.
 */
export async function deleteLearnedCircuit(
  circuitId: string,
): Promise<RemoveLearnedCircuitResult> {
  if (learnedCircuitStore === null) return { ok: false, reason: 'not-found' };
  const store = learnedCircuitStore;
  return lifecycleLock.run(async () => {
    if (
      activeController !== null &&
      sessionIsActive(currentControllerState(activeController)) &&
      productionControllerCircuitId === circuitId
    ) {
      return { ok: false as const, reason: 'active-session' as const };
    }
    if (db !== null) {
      const activeCircuitId = await getActiveSessionCircuitId(db);
      if (activeCircuitId === circuitId) {
        return { ok: false as const, reason: 'active-session' as const };
      }
    }
    const result = await store.remove(circuitId);
    if (result.ok) {
      publishLearnedCircuits();
      // The deleted circuit may have been the selected one; fall back to the
      // catalog's own default rather than leaving a dangling selection.
      if (settingsStore.getSettings().selectedCircuitId === circuitId) {
        const fallback = circuitCatalog.get(TMR_CIRCUIT_PROFILE.circuitId);
        if (fallback !== null) await unlockedApplySelection(fallback);
      }
    }
    return result;
  });
}


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
    // Ticket P5d: a retry re-reads the learned circuits from the database it
    // is about to reopen -- never from a half-built previous attempt.
    learnedCircuitStore = null;

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

    // P4l-FIX3 J5 (binding): primes the vehicle-profile bindings cache as
    // soon as `db` is available, so a binding confirmed by an EARLIER app
    // run is already live for the very first `telemetryProvider.start()` of
    // THIS run, not just ones after the next Signal Finder confirm. Never
    // awaited -- `refreshVehicleProfileBindingsCache()` never throws, and
    // bootstrap must never wait on it.
    void refreshVehicleProfileBindingsCache();

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
      // Ticket P4p G1 (binding): the ONE-TIME initial-profile migration, run
      // here because it needs BOTH the hydrated settings (did the row ever
      // carry a choice?) and the persisted bindings. Awaited -- the cache
      // refresh right after it must read the profile this decided, and the
      // whole thing is bounded by two small SQLite reads. Never throws.
      await applyInitialActiveVehicleProfile(settings);
      // The prime above ran before settings existed, so it read the DEFAULT
      // profile; re-read now that the ACTIVE one is known.
      await refreshVehicleProfileBindingsCache();
    }

    // Ticket P5d T6 (binding): learned circuits are registered in the catalog
    // BEFORE the production controller and the history store are built, so a
    // persisted `selectedCircuitId` naming a learned circuit resolves to its
    // real geometry instead of falling back to the default. A failure here is
    // warned about and survived: one unreadable learned circuit must never
    // stop the app from starting.
    if (db !== null) {
      try {
        await migrateLearnedCircuitSchema(db);
        const learned = new SqlLearnedCircuitStore(db);
        await learned.refresh();
        learnedCircuitStore = learned;
      } catch (error) {
        learnedCircuitStore = null;
        console.warn('[composition] learned circuits unavailable this launch', error);
      }
    }
    publishLearnedCircuits();
    // P5d-FIX3 F10: BEFORE the controller and history store are built, so a
    // repaired selection is the one they are built for.
    if (db !== null) await repairInterruptedAdoption(db);

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
    facadeWrapper.setPreflightGate(async (forward) => {
      // H3/N3 fix (contracts.md's lifecycle lock amendment, binding): the
      // WHOLE gate -- state read, rebuild decision, rebuild, AND the forward
      // of START_PREFLIGHT to the controller it just validated -- is ONE
      // section of `lifecycleLock`. Nothing can dispose that controller or
      // change the selection between the decision and the forward. (The
      // complementary half of N3 lives in `unlockedApplySelection()`: a
      // selection queued behind this section rebuilds the idle controller for
      // itself, so the controller a session actually starts on is always the
      // persisted selection.)
      await lifecycleLock.run(async () => {
        if (controller === null || activeController !== controller) {
          // A DevReplay controller is driving `facade` (or bootstrap has not
          // built one yet): nothing to rebuild, but the command still has to
          // reach whatever `inner` currently is.
          forward();
          return;
        }
        const state = currentControllerState(controller);
        const terminal = state === 'sessionComplete' || state === 'error';
        // Multi-circuit selection addendum (ticket CN-W3, binding): also
        // rebuild when the controller's circuit differs from the current
        // selection AND the controller is genuinely idle -- NEVER during
        // outLap/timing/inPit/paused (a circuit switch mid-session is
        // unreachable from the UI and must never tear down a live session).
        // Since CN-FIX3 a selection change already rebuilds for itself, so
        // this is now the belt-and-braces path (a selection applied while a
        // DevReplay controller was active, say) rather than the only one.
        // L1 fix (binding): compared against the RESOLVED selection (an
        // unknown persisted id falls back to the default, with a warning),
        // never the raw setting -- otherwise a stale/unbundled
        // `selectedCircuitId` would never equal `productionControllerCircuitId`
        // and this gate would rebuild on every single idle preflight.
        const resolvedCircuitId = resolveSelectedCircuit(settingsStore.getSettings()).profile.circuitId;
        const circuitChanged = state === 'idle' && productionControllerCircuitId !== resolvedCircuitId;
        if (terminal || circuitChanged) await unlockedRebuildProductionController();
        forward();
      });
    });

    // Multi-circuit selection addendum (ticket CN-W3): the history store is
    // built for the PERSISTED selection (settings were hydrated above, before
    // this point), not hardcoded TMR -- `selectCircuit()` rebuilds it again
    // later, on demand, the same way.
    const bootSelected = resolveSelectedCircuit(settingsStore.getSettings());
    const history = new SqlSessionHistoryStore(
      repository,
      LOCAL_USER_ID,
      bootSelected.profile.circuitId,
      bootSelected.profile.layoutId,
      bootSelected.profile.layoutVersion,
    );
    await history.refresh();
    historyWrapper.setInner(history);
    historyStore = history;

    const activeSessionId = db !== null ? await getActiveSessionId(db) : null;
    if (activeSessionId !== null) {
      const checkpoint = await repository.loadCheckpoint(activeSessionId);
      if (checkpoint !== null && checkpoint.snapshot.state !== 'sessionComplete') {
        // M4 fix (recovery amendment, ticket CN-FIX2): resolve which bundled
        // circuit this checkpoint belongs to, in the BINDING priority order:
        //   1. the persisted `activeSessionCircuitId` (the exact circuit the
        //      crashed session started under -- written transactionally
        //      alongside `activeSessionId` by `onSessionStarted`/`setActiveSession`)
        //   2. the pre-existing `listSessions` scan (a legacy checkpoint
        //      written before that key existed -- see
        //      `resolveRecoveryCircuitId`'s own doc comment)
        //   3. the currently persisted selection (unchanged), with a warning
        // A persisted `activeSessionCircuitId` naming a circuit that ISN'T
        // bundled is a hard discard (with a warning) -- unlike (2)/(3), which
        // fall through, an explicit-but-invalid pointer is never trusted as
        // "keep the current selection" (that would silently offer recovery
        // against the WRONG circuit's geometry, not just a lost pointer).
        const persistedCircuitId = db !== null ? await getActiveSessionCircuitId(db) : null;
        let discardUnbundled = false;
        let resolvedCircuitId: string | null = null;
        if (persistedCircuitId !== null) {
          if (circuitCatalog.get(persistedCircuitId) !== null) {
            resolvedCircuitId = persistedCircuitId;
          } else {
            console.warn(
              `[composition] recovery: persisted activeSessionCircuitId "${persistedCircuitId}" is not a bundled circuit -- discarding the checkpoint for session "${activeSessionId}"`,
            );
            discardUnbundled = true;
          }
        } else {
          resolvedCircuitId = await resolveRecoveryCircuitId(repository, activeSessionId);
          if (resolvedCircuitId === null) {
            console.warn(
              `[composition] recovery: could not resolve a bundled circuit for session "${activeSessionId}" -- keeping the currently selected circuit "${settingsStore.getSettings().selectedCircuitId}"`,
            );
          }
        }

        if (discardUnbundled) {
          if (db !== null) await setActiveSession(db, null);
        } else {
          // Switch the selection to the resolved circuit BEFORE the
          // controller is (re)built -- otherwise a recovered MotorPark
          // session would resume against a TMR-configured controller.
          // Applied directly (not through `selectCircuit()`, which awaits
          // `ready()`/`bootstrapPromise` -- itself still in flight here,
          // which would deadlock) via the SAME apply+rebuild-history helpers
          // `selectCircuit()` itself uses.
          if (resolvedCircuitId !== null && resolvedCircuitId !== settingsStore.getSettings().selectedCircuitId) {
            const resolvedEntry = circuitCatalog.get(resolvedCircuitId)!;
            applySelectedCircuit(resolvedEntry);
            await rebuildHistoryForSelection(resolvedEntry);
          }
          // The production controller was already built above (`buildProductionController()`),
          // possibly for the PRE-switch selection -- rebuild now, before
          // activation/recovery, if the selection just changed underneath it.
          // No dispose needed: nothing has subscribed to or started this
          // not-yet-activated controller/provider yet. L1 fix: compared
          // against the RESOLVED selection, same as the preflight gate.
          if (
            controller !== null &&
            productionControllerCircuitId !== resolveSelectedCircuit(settingsStore.getSettings()).profile.circuitId
          ) {
            buildProductionController();
          }
          const recoveryLapCount = checkpoint.laps.length + (midSessionState(checkpoint.snapshot) ? 1 : 0);
          // N1 fix (binding): the recovery carries its OWN circuit from here
          // on -- the resolved id when one was found, otherwise the selection
          // in force at this moment (which, per `resolveRecoveryCircuitId`'s
          // doc comment, IS the right answer for the ordinary first-crash
          // case). `resumeRecovery()` never re-derives it from a later
          // selection.
          setPendingRecovery({
            sessionId: activeSessionId,
            lapCount: recoveryLapCount,
            circuitId: resolveSelectedCircuit(settingsStore.getSettings()).profile.circuitId,
          });
        }
      } else if (db !== null) {
        await setActiveSession(db, null);
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
  return runRecoveryOperation(async () =>
    // H3/N1/N2 fix (contracts.md's lifecycle lock amendment, binding): the
    // ENTIRE resume -- checkpoint read, recovery-circuit switch, rebuild,
    // restore, start, and the reassertion of both active-session keys -- is
    // ONE section of `lifecycleLock`. Nothing can rebuild (and dispose) the
    // controller between the read and the restore any more, and nothing can
    // change the selection out from under it. `runRecoveryOperation` stays
    // OUTSIDE the lock as the C10 duplicate-call dedup it always was (a
    // second Resume/Discard tap shares this same in-flight operation rather
    // than queueing a second, by-then-empty one).
    lifecycleLock.run(async () => {
      const info = pendingRecovery;
      if (info === null) return false;
      setRecoveryNotice(null);
      const { db: database, repository: repo } = await ready();
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
        if (database !== null) await setActiveSession(database, null);
        return false;
      }

      // N1 fix (lifecycle lock amendment, binding): the RECOVERY's circuit
      // wins over whatever the user selected between the crash and this tap.
      // The selection change goes through the SAME unlocked apply the public
      // `selectCircuit()` uses (settings + history store) -- it cannot go
      // through `selectCircuit()` itself, which would re-enter the lock this
      // section already holds.
      const recoveryEntry = circuitCatalog.get(info.circuitId);
      if (recoveryEntry === null) {
        // E fix (contracts.md's facade boundary amendment, binding, ticket
        // CN-FIX4): an unbundled recovery circuit is DISCARDED -- never
        // resumed on whatever happens to be selected instead. Restoring a
        // checkpoint into another circuit's geometry would produce
        // meaningless (and silently wrong) lap timing. Bootstrap already
        // refuses to offer such a recovery, so this is the defensive path
        // for a catalog that changed underneath a live banner; it clears
        // both keys exactly like `discardRecovery()` does.
        console.warn(
          `[composition] resumeRecovery: recovery circuit "${info.circuitId}" is not bundled -- discarding the recovery instead of resuming on another circuit`,
        );
        setPendingRecovery(null);
        setRecoveryNotice('The recovered session was recorded on a circuit this app no longer bundles, so it was discarded.');
        if (database !== null) await setActiveSession(database, null);
        return false;
      }
      if (recoveryEntry.profile.circuitId !== settingsStore.getSettings().selectedCircuitId) {
        await unlockedApplySelection(recoveryEntry);
      }
      const recoveryCircuitId = recoveryEntry.profile.circuitId;
      // Rebuild if the built controller isn't already configured for the
      // recovery circuit (L1 fix: compared against the RESOLVED id). Inside
      // the lock, so the controller read immediately below is the one this
      // rebuild just installed.
      if (controller !== null && productionControllerCircuitId !== recoveryCircuitId) {
        await unlockedRebuildProductionController();
      }
      const ctrl = controller;
      if (ctrl === null) throw new Error('composition: resumeRecovery() found no production controller');
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
      // Ticket P5c-FIX1 E7 (Codex P5c-REV1 finding 7): the SAME initializer a
      // normal start goes through -- previously nothing here set
      // `mostRecentSessionId`, so a recovered outing computed no cues and
      // could not open a valid pit view. The outing's OWN start instant is
      // read back from the active-session row (written in the same
      // transaction as its id), falling back to now for a session started
      // before that key existed.
      initializeSessionStage(
        info.sessionId,
        (database === null ? null : await getActiveSessionStartedAtUtc(database)) ??
          new Date().toISOString(),
      );
      setPendingRecovery(null);
      // C5 fix: the recovered session is active again -- keep the active-session
      // pointer (re-affirmed, in case it somehow drifted) rather than clearing
      // it. It is cleared only by the existing `onSessionEnded` callback once
      // this session actually finishes; clearing it here meant a SECOND process
      // death mid-resume left no pointer for the next launch to discover, so
      // recovery was silently never offered again. M4/N1 fix: reasserts
      // `activeSessionCircuitId` alongside it with the RECOVERY's circuit --
      // the circuit `ctrl` (just possibly rebuilt above) is actually
      // configured for -- so a second crash mid-resume still recovers the
      // right circuit.
      if (database !== null) {
        await setActiveSession(database, { sessionId: info.sessionId, circuitId: recoveryCircuitId });
      }
      return true;
    }),
  );
}

/** Discards a recoverable checkpoint without resuming (ADR-0003 §3): marks it terminal so it is never offered again -- `LocalSessionRepository` has no delete method, so this overwrites the checkpoint's snapshot to `sessionComplete` instead. */
export async function discardRecovery(): Promise<void> {
  // Same section discipline as `resumeRecovery()` above: the checkpoint
  // overwrite and the two-key clear are one `lifecycleLock` critical section,
  // behind the C10 duplicate-call dedup.
  return runRecoveryOperation(async () =>
    lifecycleLock.run(async () => {
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
      // M4 fix: clears BOTH keys together (setActiveSession(database, null)).
      if (database !== null) await setActiveSession(database, null);
    }),
  );
}

// ---------------------------------------------------------------------------
// Data deletion (M3 security-review fix). `SettingsScreen`'s inline
// two-step "Delete all my data" row calls this -- the core-side delete +
// verify-empty logic lives in `@circuit/core`'s `deleteAllUserData` (unit
// tested there; the mobile UI itself is not unit-testable in this repo).
// Refreshes the shared `sessionHistoryStore` cache on success so
// `SessionHistoryScreen` reflects the deletion without a manual reload.
// ---------------------------------------------------------------------------

/** M3 fix: `deleteAllStoredUserData()`'s own return shape, layered on top of `@circuit/core`'s `DeleteUserDataResult` -- `failedCircuitIds`/`errorText` cannot live on that type itself (`packages/core/**` is out of this ticket's write set). `errorText` is `null` whenever `ok` is `true`. */
export interface AggregatedDeleteUserDataResult extends DeleteUserDataResult {
  /** Bundled circuit ids whose `deleteAllUserData()` call REJECTED (not just returned `ok: false`) -- empty unless a per-circuit delete actually threw. */
  failedCircuitIds: string[];
  errorText: string | null;
  /**
   * Set when the wipe was REFUSED outright -- nothing was read, deleted, or
   * verified on those paths. `'SESSION_ACTIVE'`: a session is genuinely
   * mid-drive (CN-FIX4, facade boundary amendment). `'DEV_REPLAY_ACTIVE'`: a
   * `__DEV__` replay controller is installed (CN-FIX5, closing amendment).
   */
  reason?: 'SESSION_ACTIVE' | 'DEV_REPLAY_ACTIVE';
}

export async function deleteAllStoredUserData(): Promise<AggregatedDeleteUserDataResult> {
  // Lifecycle lock amendment (binding): delete-all wipes the very data the
  // recovery/selection/rebuild operations read and write, so it runs as one
  // section of the SAME lock they do -- never interleaved with a resume, a
  // selection change, or a controller rebuild.
  return lifecycleLock.run(unlockedDeleteAllStoredUserData);
}

async function unlockedDeleteAllStoredUserData(): Promise<AggregatedDeleteUserDataResult> {
  const { repository: repo } = await ready();
  // C fix (contracts.md's facade boundary amendment, binding, ticket
  // CN-FIX4): durability. Two things had to change for "delete-all means
  // deleted" to actually hold.
  //
  // 1. REFUSE while a session is genuinely mid-drive. A live controller goes
  //    on writing checkpoints/laps/PBs by design, so a wipe underneath it
  //    would be re-populated moments later -- and silently tearing the
  //    driver's session down instead is not this action's job.
  if (activeController !== null && MID_SESSION_STATES.has(currentControllerState(activeController))) {
    return {
      ok: false,
      remainingSessionCount: 0,
      referenceLapCleared: false,
      failedCircuitIds: [],
      reason: 'SESSION_ACTIVE',
      errorText: 'a session is currently active -- end it before deleting all data',
    };
  }
  // 1b. REFUSE while a `__DEV__` DevReplay controller is installed (CN-FIX5
  //    item 3, closing amendment, binding). A replay controller sits in
  //    `calibrating`/`calibrationReview`/`armed` -- none of them
  //    `MID_SESSION_STATES` -- and step 2's rebuild deliberately no-ops
  //    while it owns `facade`, so the wipe would leave a live controller
  //    holding a session id that persists its session/checkpoint right back
  //    over the deleted data. Durability wins over convenience on the dev
  //    path: leave the replay, refuse the delete.
  if (controller !== null && activeController !== controller) {
    return {
      ok: false,
      remainingSessionCount: 0,
      referenceLapCleared: false,
      failedCircuitIds: [],
      reason: 'DEV_REPLAY_ACTIVE',
      errorText: 'a developer replay or mock session is active -- leave the Dev Replay screen before deleting all data',
    };
  }
  // 2. Otherwise: drop any pending recovery and REPLACE the production
  //    controller with a fresh, idle one BEFORE deleting anything. A
  //    terminal (`sessionComplete`) controller still holds a `sessionId`
  //    and a full lap set, so anything that later touches it --
  //    `checkpointNow()` from a background transition, a straggler
  //    `endSession()` persistence path -- would re-create rows this wipe
  //    just removed. A fresh controller has no session identity at all, so
  //    there is nothing left to re-persist. (`endSession()` itself is now
  //    serialized on this same lock, so an in-flight one has already
  //    completed by the time this section runs.)
  setPendingRecovery(null);
  setRecoveryNotice(null);
  await unlockedRebuildProductionController();
  // Multi-circuit selection addendum (ticket CN-W3): delete-all spans EVERY
  // bundled circuit, not just the currently selected one -- `deleteUserData`
  // itself is a single per-userId wipe (not circuit-scoped), so this loop's
  // real job is the per-circuit VERIFY-EMPTY check; success requires every
  // bundled circuit to come back empty.
  //
  // M3 fix (binding): each circuit's call is its own try/catch -- a REJECTED
  // per-circuit `deleteAllUserData()` (e.g. a transient SQLite error) no
  // longer aborts the loop; every remaining bundled circuit is still
  // attempted, and the rejection is reflected in the aggregate `ok: false`
  // plus `failedCircuitIds`/`errorText` instead of silently stopping partway
  // through (previously leaving later circuits' data untouched with no
  // indication why).
  const perCircuitResults: DeleteUserDataResult[] = [];
  const failedCircuitIds: string[] = [];
  for (const summary of circuitCatalog.list()) {
    try {
      perCircuitResults.push(
        await deleteAllUserData(repo, LOCAL_USER_ID, summary.circuitId, summary.layoutId, summary.layoutVersion),
      );
    } catch (error) {
      console.warn(`[composition] deleteAllStoredUserData: circuit "${summary.circuitId}" failed`, error);
      failedCircuitIds.push(summary.circuitId);
    }
  }
  const perCircuitOk = failedCircuitIds.length === 0 && perCircuitResults.every((r) => r.ok);
  const result: DeleteUserDataResult = {
    ok: perCircuitOk,
    remainingSessionCount: perCircuitResults.reduce((sum, r) => sum + r.remainingSessionCount, 0),
    referenceLapCleared: perCircuitResults.length > 0 && perCircuitResults.every((r) => r.referenceLapCleared),
  };
  // F7 fix (WPT3, binding): `telemetry_samples` (Telemetry addendum) is a
  // mobile-owned table (`persistence/telemetrySchema.ts`) that
  // `@circuit/core`'s `deleteAllUserData`/`LocalSessionRepository.deleteUserData`
  // (packages/core, out of this ticket's write set) has no knowledge of at
  // all -- delete it here, in the SAME flow, and verify it actually landed
  // empty before ever reporting success, so the UI's "All stored data
  // deleted" banner is never shown while up to 200,000 rows/session remain.
  //
  // N4 fix (lifecycle lock amendment, binding, ticket CN-FIX3): this step is
  // NO LONGER gated on the per-circuit aggregate. A rejected circuit delete
  // used to suppress the telemetry DELETE + verify-empty entirely, leaving up
  // to 200,000 rows/session on disk after the user asked for a full wipe. The
  // telemetry step always runs; the aggregate `ok` is `circuitsOk &&
  // telemetryOk`, and `errorText` names whichever half failed.
  let telemetryOk = true;
  if (db !== null) {
    // N1-confirm residue fix (LEAD): a session's final telemetry flush can
    // still be in flight when the user reaches delete-all -- await any
    // in-progress shutdown first, then run DELETE + verify while HOLDING the
    // shared write gate, so no straggler batch INSERT can land between (or
    // after) them. `stopTelemetryRecording()` is an idempotent no-op when
    // nothing is recording.
    await stopTelemetryRecording();
    const database = db;
    try {
      telemetryOk = await (dbWriteGate ?? PASSTHROUGH_WRITE_GATE).exclusive(async () => {
        await database.runAsync('DELETE FROM telemetry_samples');
        const remaining = await database.getAllAsync<{ count: number }>(
          'SELECT COUNT(*) AS count FROM telemetry_samples',
        );
        return (remaining[0]?.count ?? 0) === 0;
      });
    } catch (error) {
      // N4 (binding): symmetric with the per-circuit try/catch above -- a
      // rejected telemetry delete/verify is reported as `ok: false` plus the
      // fixed "telemetry" phrase in `errorText`, never as raw exception text
      // and never as a rejection escaping into the UI's delete handler.
      console.warn('[composition] deleteAllStoredUserData: telemetry deletion failed', error);
      telemetryOk = false;
    }
  }
  const finalResult: DeleteUserDataResult = { ...result, ok: result.ok && telemetryOk };
  // M4 fix (binding): a leftover active-session pointer is meaningless once
  // all stored data is gone -- cleared together, the SAME way session
  // end/discard/vanished-checkpoint do (`setActiveSession(db, null)`).
  if (finalResult.ok && db !== null) await setActiveSession(db, null);
  if (finalResult.ok && historyStore !== null) await historyStore.refresh();

  const errorText = finalResult.ok
    ? null
    : [
        failedCircuitIds.length > 0 ? `circuits rejected: ${failedCircuitIds.join(', ')}` : null,
        !perCircuitOk && failedCircuitIds.length === 0 ? 'one or more circuits did not verify empty' : null,
        !telemetryOk ? 'telemetry rows remained or could not be deleted' : null,
      ]
        .filter((part): part is string => part !== null)
        .join('; ') || 'delete-all failed';

  return { ...finalResult, failedCircuitIds, errorText };
}

// ---------------------------------------------------------------------------
// DevReplayScreen support (MUST DO #6, __DEV__ only).
//
// F4 fix (C6 residue): `startDevReplaySession` / `restoreProductionFacade` /
// `useMockFacadeForDevReplay` all mutate the SAME shared state
// (`replayController`/`activeController`/`facadeWrapper`'s inner) but
// previously ran independently -- a rapid start/restore/start "storm"
// (double-tapping a fixture row, `DevReplayScreen` unmounting mid-transition)
// could interleave them.
//
// N5 fix (lifecycle lock amendment, binding, ticket CN-FIX3): the separate
// `withDevReplayLock` queue is GONE -- every replay transition is a section of
// the one `lifecycleLock`, and the screen's whole restore -> select -> start
// sequence is ONE section (`runDevReplayScenario`) rather than three
// independently-locked steps a concurrent unmount cleanup could slot between.
// Cleanup that fires mid-scenario therefore runs strictly AFTER the scenario,
// and the scenario's own `isCancelled()` checks keep it from installing a
// replay (or reporting success) once the screen it belonged to is gone.
// ---------------------------------------------------------------------------

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
 * active. Called by `DevReplayScreen` on unmount (N5 fix: after bumping its
 * run generation, so this queues behind any in-flight scenario, which by then
 * has cancelled itself) and by `runDevReplayScenario()` internally. F4 fix:
 * runs under the shared `lifecycleLock`, and flushes the stale replay
 * controller before disposing it.
 */
export async function restoreProductionFacade(): Promise<void> {
  return lifecycleLock.run(unlockedRestoreProductionFacade);
}

/** `restoreProductionFacade()`'s body -- MUST be called with `lifecycleLock` held (`runDevReplayScenario()` calls it directly, from inside its own section). */
async function unlockedRestoreProductionFacade(): Promise<void> {
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
export async function startDevReplaySession(
  samples: LocationSample[],
  // CN-W2: which circuit's profile+runtime the replay controller is
  // configured with. Defaults to TMR (the pre-existing, byte-identical
  // behavior every current call site relies on) -- DevReplayScreen passes
  // the scenario's OWN resolved circuit explicitly so a MotorPark fixture is
  // matched against MotorPark's centerline, not TMR's.
  circuit: { circuitProfile: CircuitProfile; runtimeProfile: RuntimeProfile } = {
    circuitProfile: TMR_CIRCUIT_PROFILE,
    runtimeProfile: TMR_RUNTIME_PROFILE,
  },
): Promise<void> {
  // N5 fix (binding): the lock is acquired FIRST and `ready()` awaited INSIDE
  // it -- previously the `await ready()` happened before the lock, so a raw
  // `start(); restore();` call order could still execute as restore-then-start.
  return lifecycleLock.run(() => unlockedStartDevReplaySession(samples, circuit));
}

/** `startDevReplaySession()`'s body -- MUST be called with `lifecycleLock` held. */
async function unlockedStartDevReplaySession(
  samples: LocationSample[],
  circuit: { circuitProfile: CircuitProfile; runtimeProfile: RuntimeProfile },
): Promise<void> {
  const { repository: repo } = await ready();
  {
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

    // Multi-circuit selection addendum (ticket CN-W3): coaching corners for
    // the replay controller are resolved from the bundled catalog by the
    // REPLAY's own circuitId -- previously this hardcoded TMR_CORNERS even
    // for a MotorPark fixture. Falls back to TMR_CORNERS (with a warning)
    // only if a caller ever names a circuit outside the bundled catalog,
    // which no real call site does.
    const replayEntry = circuitCatalog.get(circuit.circuitProfile.circuitId);
    if (replayEntry === null) {
      console.warn(
        `[composition] startDevReplaySession: circuitId "${circuit.circuitProfile.circuitId}" is not in the bundled catalog -- coaching corners default to TMR`,
      );
    }
    const devController = new SessionController({
      runtimeProfile: circuit.runtimeProfile,
      circuitProfile: circuit.circuitProfile,
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
      coaching: coachingConfig(replayEntry?.corners ?? TMR_CORNERS, replayEntry?.profile ?? TMR_CIRCUIT_PROFILE),
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
  }
}

/** Outcome of `runDevReplayScenario()` -- `CANCELLED` means the screen's run generation moved on (unmount, or another fixture tapped) and NOTHING was installed. */
export interface DevReplayScenarioResult {
  ok: boolean;
  reason?: 'SESSION_ACTIVE' | 'CANCELLED' | 'UNKNOWN_CIRCUIT';
}

/**
 * N5 fix (contracts.md's lifecycle lock amendment, binding, ticket CN-FIX3):
 * `DevReplayScreen`'s whole restore -> select -> start sequence as ONE
 * `lifecycleLock` section, so an unmount cleanup issued mid-sequence can no
 * longer complete BETWEEN those steps and leave the scenario installing a
 * replay controller into a screen that is already gone.
 *
 * `isCancelled()` is the screen's own run-generation check. Per contracts.md's
 * closing amendment (binding, ticket CN-FIX5 item 4) cancellation is honored
 * ONLY BEFORE the selection write -- at section entry, after `ready()`, and
 * immediately before `unlockedApplySelection()`. Once that write has begun it
 * runs to completion, so settings, the history store and the production
 * controller always agree; the run then skips the install and the navigation
 * and reports `CANCELLED`. There is deliberately NO rollback: a half-applied
 * selection (settings on one circuit, history/controller on another) would be
 * a far worse state than a consistent selection the user did not ask for, and
 * the next real selection overwrites it anyway. The screen calls this ONE
 * function instead of sequencing three separately-locked calls.
 */
export async function runDevReplayScenario(
  scenario: DevReplayScenario,
  isCancelled: () => boolean = () => false,
): Promise<DevReplayScenarioResult> {
  return lifecycleLock.run(async (): Promise<DevReplayScenarioResult> => {
    const entry = circuitCatalog.get(scenario.circuitId);
    if (entry === null) return { ok: false, reason: 'UNKNOWN_CIRCUIT' };
    // D fix (facade boundary amendment, ticket CN-FIX4) + item 4 (closing
    // amendment, ticket CN-FIX5), both binding: before the selection write,
    // `CANCELLED` means NO side effects -- checked at section entry (this
    // run may have waited behind other lifecycle work and be stale before it
    // even begins), after `ready()`, and immediately before the write.
    if (isCancelled()) return { ok: false, reason: 'CANCELLED' };
    await ready();
    if (isCancelled()) return { ok: false, reason: 'CANCELLED' };

    // C6 fix: restore production (disposing any still-active replay
    // controller) before building a new one, every time -- so switching
    // straight from one fixture to another never leaves the previous
    // replay's provider/watchdog running. Runs BEFORE the selection below so
    // the session-active check reads the (by-then idle/terminal) production
    // controller, not a still-live PREVIOUS replay controller.
    await unlockedRestoreProductionFacade();

    // M2 fix (ticket CN-FIX2, binding, dev-only path): the fixture's OWN
    // circuit becomes the app's selection, so the calibration track map,
    // History/PB and Detail all agree with the replay being driven.
    const refusal = refuseSelectionIfSessionActive();
    if (refusal !== null) return { ok: false, reason: 'SESSION_ACTIVE' };
    // The last point at which nothing has been written yet: the selection
    // write (settings + history store + controller rebuild) is the first
    // real side effect this function has.
    if (isCancelled()) return { ok: false, reason: 'CANCELLED' };
    await unlockedApplySelection(entry);

    // The selection is now committed and internally consistent. Item 4
    // (closing amendment): a cancellation observed from here on skips the
    // INSTALL and the navigation -- it never unwinds the selection, and it
    // never installs-then-restores (which would churn the facade for a
    // screen that is already gone).
    if (isCancelled()) return { ok: false, reason: 'CANCELLED' };

    const samples = scenario.build(entry.profile);
    await unlockedStartDevReplaySession(samples, {
      circuitProfile: entry.profile,
      runtimeProfile: entry.runtime,
    });
    return { ok: true };
  });
}

/**
 * Swaps the active `facade` back to a fresh `MockSessionFacade` --
 * DevReplayScreen's `__DEV__` mock toggle. C6 fix: disposes any active replay
 * controller first (defense in depth -- `DevReplayScreen` already calls
 * `restoreProductionFacade()` before this), so switching to the scripted mock
 * can never leave an unfinished replay's provider/watchdog running underneath.
 * F4 fix: now async and runs under the shared `lifecycleLock` (the dispose
 * used to be a fire-and-forget `void stale.dispose()`, racing whichever
 * transition ran next), and flushes the stale replay controller before
 * disposing it.
 */
export async function useMockFacadeForDevReplay(): Promise<void> {
  return lifecycleLock.run(async () => {
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

/**
 * The bundled circuitId the CURRENT production `SessionController` was built
 * for -- `null` before bootstrap has built one. Read-only diagnostic (same
 * read-on-demand shape as `getLiveDiagnostics()` below): it is what makes
 * "the controller really is on the recovery's circuit" directly assertable,
 * rather than inferable only from calibration behavior.
 */
export function getProductionCircuitId(): string | null {
  return productionControllerCircuitId;
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

/**
 * Ticket P5b B2: the shared session repository, so the post-session analysis
 * can read a lap's stored GNSS trace (`loadTelemetry`) -- the same read-only,
 * read-on-demand accessor shape as `getTelemetryReadDb()` immediately above.
 * `null` before bootstrap has built one.
 */
export function getSessionRepository(): LocalSessionRepository | null {
  return repository;
}

/**
 * Ticket P5b B1: the session most recently started on this launch, or `null`
 * when none has been. `SessionResultsScreen` needs it to open the analysis of
 * the session that just finished (`FacadeState` has laps but no id).
 */
export function getMostRecentSessionId(): string | null {
  return mostRecentSessionId;
}

/**
 * Ticket P5b-FIX1 C6 (binding, Codex P5b-REV1 finding 6): ONE analysis runner
 * -- and therefore one cache -- for the whole app.
 *
 * The first cut built a runner inside `AnalysisScreen`, so leaving the screen
 * mid-run and coming back started a SECOND engine pass over the same session
 * while the abandoned one kept running. Hoisted here, re-entering the screen
 * joins the in-flight run (`createAnalysisRunner` de-duplicates by session id)
 * and a finished analysis is instant.
 *
 * Built lazily, because its dependencies (`repository`, `db`) only exist after
 * bootstrap -- and read on demand at every call, so a runner created before
 * bootstrap still reads the real rows afterwards.
 */
let analysisRunner: AnalysisRunner | null = null;

export function getAnalysisRunner(): AnalysisRunner {
  if (analysisRunner !== null) return analysisRunner;
  analysisRunner = createAnalysisRunner({
    // The live session state, snapshotted per call: `subscribe()` always calls
    // back synchronously with the current state (the `SessionFacade` contract).
    isSessionActive: () => {
      let snapshot: FacadeState | undefined;
      const unsubscribe = facade.subscribe((s) => {
        snapshot = s;
      });
      unsubscribe();
      return snapshot === undefined ? false : sessionIsActive(snapshot.sessionState);
    },
    loadSession: createAnalysisSessionLoader({
      getSession: (id) => sessionHistoryStore.getSession(id),
      getCircuit: (id) => circuitCatalog.get(id),
      loadLapGnss: async (id, lapNumber) =>
        (await getSessionRepository()?.loadTelemetry(id, lapNumber)) ?? [],
      loadSessionChannels: async (id) => {
        const readDb = getTelemetryReadDb();
        return readDb === null ? new Map() : await loadSessionTelemetryByLap(readDb, id);
      },
    }),
  });
  return analysisRunner;
}

// ---------------------------------------------------------------------------
// Ticket P5c-B (contracts.md "Phase 5 REVISION 2" R2-3, user-ratified): the
// trackday stage -- bounded live cue updates between laps, and the interactive
// between-stint pit view. The whole stage hangs off ONE setting,
// `suggestionsEnabled`, which is OFF by default: with it off nothing below
// reads a row, moves a cue, or shows an entry point.
// ---------------------------------------------------------------------------

/** One journal per launch: what moved, and what the driver was actually shown. */
const suggestionJournal = createSuggestionJournal();

let stintRunner: StintRunner | null = null;
let stintCoach: StintCoach | null = null;
/** Completed laps the last lap-boundary pass was started for. */
let lastStintLapCount = 0;
/**
 * Ticket P5c-FIX1 E6: retains a boundary that arrived while a pass was in
 * flight and runs exactly one follow-up pass for it after that pass settles --
 * the boundary is never simply dropped (which, after E1, would also strand the
 * previous pass's queued cue moves).
 */
let stintBoundaries: BoundaryScheduler | null = null;
/**
 * Ticket P5c-FIX1 E11: per-lap GNSS traces of the outing being driven, so a
 * lap-boundary pass loads only the lap that just completed instead of
 * re-reading every lap of the outing from SQLite. Keyed by session + lap;
 * emptied by `initializeSessionStage`.
 */
const stintTraceCache = new Map<string, LocationSample[]>();

/**
 * The ACTIVE session's completed laps, assembled out of exactly the rows the
 * post-session analysis already reads -- the live lap records from the facade,
 * each lap's stored GNSS trace, and the decoded channels of the session. The
 * lap in progress is never among them: `FacadeState.laps` holds only completed
 * laps, which is precisely the read-only, "never disturb the running session"
 * contract D3 asks for.
 */
async function loadActiveStint(sessionId: string): Promise<StintSource | null> {
  if (sessionId !== mostRecentSessionId) return null;
  const snapshot = currentFacadeState();
  if (snapshot === null || snapshot.laps.length === 0) return null;
  const circuit = resolveSelectedCircuit(settingsStore.getSettings());
  const bundledCircuit = circuitCatalog.get(circuit.profile.circuitId);
  if (bundledCircuit === null) return null;

  let channelsByLap: ReadonlyMap<number, TelemetrySample[]> = new Map();
  const readDb = getTelemetryReadDb();
  if (readDb !== null) {
    try {
      channelsByLap = await loadSessionTelemetryByLap(readDb, sessionId);
    } catch (error) {
      // A missing channel read is not a failed analysis: the GPS-only tier-0
      // pass still stands and the engine reports the channels as missing.
      console.warn('[composition] stint channel read failed', error);
    }
  }

  const recordings: AnalysisLapRecording[] = [];
  for (const lap of [...snapshot.laps].sort((a, b) => a.lapNumber - b.lapNumber)) {
    // Ticket P5c-FIX1 E11: a completed lap's GNSS trace never changes once it
    // is written, so a lap-boundary pass READS only the lap that just
    // completed; the rest come back from this cache. It is cleared with the
    // rest of the stint stage whenever an outing starts (`initializeSessionStage`).
    const traceKey = `${sessionId}|${lap.lapNumber}`;
    let locationSamples = stintTraceCache.get(traceKey);
    if (locationSamples === undefined) {
      locationSamples = (await repository?.loadTelemetry(sessionId, lap.lapNumber)) ?? [];
      // A lap with no stored trace yet is NOT cached: its write may still be
      // in flight (E5), and the next pass has to look again.
      if (locationSamples.length > 0) stintTraceCache.set(traceKey, locationSamples);
    }
    recordings.push({
      lap: {
        lapNumber: lap.lapNumber,
        durationMs: lap.durationMs,
        valid: lap.valid,
        invalidReasons: lap.invalidReasons,
        quality: lap.quality,
      },
      locationSamples,
      telemetry: channelsByLap.get(lap.lapNumber) ?? [],
      sectorTimes: lap.sectorTimes.map((sector) => ({
        sectorIndex: sector.sectorIndex,
        durationMs: sector.durationMs,
      })),
    });
  }
  return {
    sessionId,
    circuit: bundledCircuit,
    displayDateUtc: mostRecentSessionStartedAtUtc ?? new Date().toISOString(),
    recordings,
  };
}

/** The shared stint runner -- one pass per (session, completed-lap count). */
export function getStintRunner(): StintRunner {
  if (stintRunner !== null) return stintRunner;
  stintRunner = createStintRunner({
    loadCompletedLaps: loadActiveStint,
    // Ticket P5c-FIX1 E5: the lap event reaches this module before the lap's
    // telemetry write settles. `awaitLapPersistence()` is the controller's own
    // completed-lap write queue, so a boundary pass reads a lap only once its
    // trace is actually on disk.
    settleLapPersistence: async (sessionId) => {
      if (sessionId !== mostRecentSessionId) return;
      await activeController?.awaitLapPersistence();
    },
  });
  return stintRunner;
}

/**
 * The shared stint coach. `activeCues`/`applyCueUpdates` go to whichever
 * controller is actually live (`activeController`), and `applyCueUpdates`
 * re-validates every bound itself -- see `SessionController.applyCueUpdates`.
 */
export function getStintCoach(): StintCoach {
  if (stintCoach !== null) return stintCoach;
  stintCoach = createStintCoach({
    runner: getStintRunner(),
    journal: suggestionJournal,
    suggestionsEnabled: () => settingsStore.getSettings().suggestionsEnabled,
    // P5c-FIX1 E1: the identity of whatever controller is live RIGHT NOW. A
    // pass that started against another one (a rebuild, a recovered session, a
    // new outing) presents a context this no longer matches, and applies
    // nothing.
    cueContext: () => activeController?.cueContext() ?? null,
    activeCues: () => activeController?.activeCues() ?? [],
    applyCueUpdates: (updates, request) =>
      activeController?.applyCueUpdates(updates, request) ?? [],
    onError: (error) => console.warn('[composition] stint coaching', error),
  });
  return stintCoach;
}

/** What the trackday stage did in `sessionId`: moves applied, suggestions shown. */
export function getTrackdayRecord(sessionId: string): SessionSuggestionRecord {
  return suggestionJournal.read(sessionId);
}

/** The session the pit view reads, or `null` when no session is running. */
export function getActiveStintContext(): { sessionId: string; completedLapCount: number } | null {
  const snapshot = currentFacadeState();
  if (snapshot === null || !sessionIsActive(snapshot.sessionState)) return null;
  if (mostRecentSessionId === null) return null;
  return { sessionId: mostRecentSessionId, completedLapCount: snapshot.laps.length };
}

/** The facade's current state -- `subscribe()` always calls back synchronously. */
function currentFacadeState(): FacadeState | null {
  let snapshot: FacadeState | undefined;
  const unsubscribe = facade.subscribe((s) => {
    snapshot = s;
  });
  unsubscribe();
  return snapshot ?? null;
}

// The LIVE half (R2-3a). Registered once at module load, like the telemetry
// end-of-session side effect above, so it survives every facade swap. A lap
// boundary is the only trigger: nothing is computed on the sample hot path,
// and with `suggestionsEnabled` off `onLapCompleted` returns before it reads
// anything at all.
facade.subscribe((state) => {
  const completedLapCount = state.laps.length;
  if (!sessionIsActive(state.sessionState)) {
    lastStintLapCount = 0;
    stintBoundaries?.reset();
    return;
  }
  if (completedLapCount === 0 || completedLapCount === lastStintLapCount) return;
  lastStintLapCount = completedLapCount;
  if (!settingsStore.getSettings().suggestionsEnabled) return;
  runStintPass(completedLapCount);
});

/**
 * Ticket P5c-FIX1 E6: one pass at a time, no dropped boundary. The retention +
 * coalescing rule itself lives in `stintCoaching.createBoundaryScheduler`
 * (pure, unit-tested); this is only the binding to the live session.
 */
function runStintPass(completedLapCount: number): void {
  const sessionId = mostRecentSessionId;
  if (sessionId === null) return;
  stintBoundaries ??= createBoundaryScheduler({
    run: (count) => getStintCoach().onLapCompleted(mostRecentSessionId ?? sessionId, count),
    onError: (error) => console.warn('[composition] lap-boundary coaching failed', error),
  });
  stintBoundaries.onBoundary(completedLapCount);
}
