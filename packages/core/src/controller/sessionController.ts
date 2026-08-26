import type {
  BrakingZone,
  CalibrationResult,
  CircuitProfile,
  CoachCue,
  Corner,
  DeltaUpdate,
  LapRecord,
  LocalSessionRepository,
  LocationProvider,
  LocationSample,
  MonotonicClock,
  QualityLevel,
  ReferenceLap,
  SessionMachineSnapshot,
  SessionState,
  SessionSummary,
} from '../contracts';
import { CalibrationEngine, type CalibrationConfig } from '../calibration';
import { CoachEngine, deriveBrakingZones } from '../coach';
import type { RuntimeProfile } from '../profile';
import { buildReferenceLap, shouldReplacePb } from '../reference';
import { SessionPipelineCore, type PipelineCoreConfig } from './pipelineCore';

/**
 * Core-side projection of live session state -- `apps/mobile/src/session/facade.ts`'s
 * `FacadeState` maps to this 1:1 (plus nothing else; the app never reaches
 * past the facade into `@circuit/core` timing/geometry/state-machine types
 * directly). Kept here, not in `contracts.ts` (not this ticket's write set),
 * as the binding shape `RealSessionFacade` adapts from.
 */
export interface FacadeStateCore {
  sessionState: SessionState;
  lapNumber: number;
  currentLapMs: number;
  lastLapMs: number | null;
  pbMs: number | null;
  delta: DeltaUpdate | null;
  sector: number;
  gnssQuality: QualityLevel;
  /** Additive V2 track-map fields (`rawLocalX`/`Y`, `matchedLocalX`/`Y`, `lateralM`,
   * `distanceM`) mirror `CalibrationEngine.progress()`'s own additive fields 1:1 -- the
   * last fed sample's raw and matched-onto-centerline local-frame positions, present
   * once a sample with a valid match has been fed this calibration attempt. */
  calibration: {
    coverageFraction: number;
    onTrack: boolean;
    rawLocalX?: number;
    rawLocalY?: number;
    matchedLocalX?: number;
    matchedLocalY?: number;
    lateralM?: number;
    distanceM?: number;
  } | null;
  calibrationResult: CalibrationResult | null;
  laps: LapRecord[];
  /** Latest known speed in km/h, derived from the most recent sample's `speedMps`; `null` before any sample reports one. */
  speedKph: number | null;
  /**
   * Latest advisory coaching cue (Phase 3 coaching addendum), a LIVE value
   * re-emitted with an updated `distanceToTargetM` on every accepted match
   * while approaching (F1/F2 fix). `null` when coaching is disabled
   * (`SessionControllerDeps.coaching` unset/`enabled: false`), no corner is
   * currently in lead-distance range, the target has been passed, the
   * driver is in the pit lane (F4 fix), or the brief `COACH_CUE_FLICKER_HOLD_MS`
   * grace window has elapsed without a replacement -- see `handleSample`'s
   * coaching block and `restoreFromCheckpoint`'s reset. Cleared on pit entry
   * and lap rollover (S/F crossing) too, so a cue never bleeds into the pit
   * lane or the next lap's display.
   */
  coachCue: CoachCue | null;
}

export interface SessionControllerDiagnostics {
  sessionId: string | null;
  watchRestarts: number;
  qualityCounts: Record<QualityLevel, number>;
  matchedSampleCount: number;
  rejectedSampleCount: number;
  reverseTravelDetected: boolean;
  appliedInvalidReasons: string[];
  /** Current size of the in-flight raw-sample buffer (M2 fix) -- trimmed to the current lap on every lap completion, not the whole session's sample count. */
  rawSampleBufferSize: number;
  /** Number of times braking zones have been regenerated from a NEW personal-best reference lap landing mid-session (Phase 3 coaching addendum) -- 0 when coaching is disabled or no PB has been replaced yet this controller's lifetime. */
  coachZoneRefreshes: number;
}

/** Minimal timer abstraction the watchdog polls through -- see MUST DO #2 (ADR-0003 §1). Defaults to the platform's global `setInterval`/`clearInterval`; tests inject a fake to drive the poll deterministically with a fake clock. */
export interface WatchdogScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultScheduler: WatchdogScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const DEFAULT_WATCHDOG_TIMEOUT_MS = 5_000;
const DEFAULT_WATCHDOG_POLL_MS = 1_000;
/**
 * Calibration is treated as "done" once the Learn lap has observed this much
 * of the centerline. Deliberately set ABOVE `CalibrationEngine.finish()`'s
 * own >=95% `INSUFFICIENT_COVERAGE` bar (`calibration-engine.ts`): finishing
 * the instant coverage first crosses 95% cuts the lap short by a handful of
 * samples relative to driving it to a natural close, which measurably
 * changes the verdict on other criteria that keep firming up until the lap
 * actually completes (direction-vote confidence, observed sample rate,
 * rejected-sample fraction) -- confirmed by feeding a full recognition lap
 * through this exact finish-on-threshold logic in
 * `packages/core/test/controller/sessionController.test.ts`. Coverage bins
 * are monotonically set (never unset), so this can only be reached once and
 * never regresses.
 */
const CALIBRATION_COMPLETE_COVERAGE_FRACTION = 0.98;

const PAUSABLE_STATES = new Set<SessionState>(['calibrating', 'armed', 'outLap', 'timing', 'inPit']);
const MID_SESSION_STATES = new Set<SessionState>(['outLap', 'timing', 'inPit']);
/**
 * A displayed `currentCue` with no confirming match update for longer than
 * this is cleared (F1/F2 fix). `CoachEngine.onMatch` now re-emits the live
 * cue every accepted match while approaching (see `coach-engine.ts`'s class
 * doc comment), so a genuinely passed/rejected corner is expected to clear
 * almost immediately -- this short grace window exists ONLY to bridge a
 * single brief quality/matching gap (e.g. one dropped fix) without the strip
 * visibly flickering off and back on for what is, in practice, the SAME
 * corner still being approached when the very next match resumes. It is
 * deliberately far shorter than the old 5s "stale" hold, which could leave a
 * cue for a corner already driven past on screen for seconds.
 */
const COACH_CUE_FLICKER_HOLD_MS = 2_000;

export interface SessionControllerConfig {
  pipeline?: PipelineCoreConfig;
  calibration?: Partial<CalibrationConfig>;
  /** Milliseconds with no sample while active+unpaused before the watchdog restarts the provider (default 5000, ADR-0003 §1). */
  watchdogTimeoutMs?: number;
  /** How often the watchdog checks for a stale sample (default 1000). */
  watchdogPollMs?: number;
  scheduler?: WatchdogScheduler;
}

export interface SessionControllerDeps {
  runtimeProfile: RuntimeProfile;
  /**
   * Provenance/geometry fields `buildReferenceLap`/`SessionSummary` need -- a
   * subset of the full `CircuitProfile`. Includes `corridorWidthM` (MUST DO
   * #1): `RuntimeProfile` (the validated, projected companion) deliberately
   * drops it, so the live matcher/calibration configs source their corridor
   * base from here instead of silently falling back to each engine's own
   * default.
   */
  circuitProfile: Pick<
    CircuitProfile,
    'circuitId' | 'layoutId' | 'layoutVersion' | 'schemaVersion' | 'totalLengthM' | 'corridorWidthM'
  >;
  locationProvider: LocationProvider;
  clock: MonotonicClock;
  repository: LocalSessionRepository;
  userId: string;
  appVersion: string;
  algorithmVersion: number;
  device?: string;
  /** Restarts the location provider (stop then start) -- the app passes `GnssLocationProvider`'s own stop/start (ADR-0003 §1). Invoked by the watchdog. */
  restartProvider: () => Promise<void> | void;
  /**
   * Phase 3 coaching addendum, optional (undefined/`enabled: false` -> no
   * `CoachEngine` is ever instantiated and `FacadeStateCore.coachCue` stays
   * `null` for the controller's whole lifetime).
   *
   * Design choice: the caller supplies only the deterministic, profile-derived
   * `corners` (e.g. `analyzeCorners(runtimeProfile)` optionally passed through
   * `applyObservedSpeeds`) computed ONCE by composition -- not braking zones.
   * `BrakingZone[]` depends on the CURRENT reference lap (`deriveBrakingZones`'s
   * `reference` argument), which only this controller tracks the lifecycle of
   * (loaded at session start, replaced atomically on a new PB). Accepting
   * precomputed zones here would require the caller to duplicate that
   * lifecycle just to keep them in sync; instead the controller itself calls
   * `deriveBrakingZones` -- once when the reference lap is (re)loaded for a
   * session (`loadReferenceForSession`) and again whenever `maybeReplacePb`
   * atomically swaps in a new PB (incrementing `coachZoneRefreshes`).
   */
  coaching?: { enabled: boolean; corners: Corner[] };
  config?: SessionControllerConfig;
}

function randomToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function cancelledCalibrationResult(): CalibrationResult {
  return {
    accepted: false,
    confidence: 0,
    failureReasons: ['CANCELLED'],
    appliedBias: { e: 0, n: 0 },
    diagnostics: {
      coverageFraction: 0,
      samplesAccepted: 0,
      samplesRejected: 0,
      rejectionReasons: {},
      meanLateralM: 0,
      p95LateralM: 0,
      estimatedBias: { e: 0, n: 0 },
      directionDetected: 'unknown',
      observedRateHz: 0,
    },
  };
}

/** Synthetic, always-accepted "calibration" used only on `start('session')` (recovery resume), which deliberately skips a live Learn lap -- see `restoreFromCheckpoint`'s doc comment for why a fresh recalibration is NOT forced there. */
function recoverySkippedCalibrationResult(): CalibrationResult {
  return {
    accepted: true,
    confidence: 1,
    failureReasons: [],
    appliedBias: { e: 0, n: 0 },
    diagnostics: {
      coverageFraction: 1,
      samplesAccepted: 0,
      samplesRejected: 0,
      rejectionReasons: {},
      meanLateralM: 0,
      p95LateralM: 0,
      estimatedBias: { e: 0, n: 0 },
      directionDetected: 'unknown',
      observedRateHz: 0,
    },
  };
}

/**
 * The production session orchestrator (MUST DO #1). Composes the SAME
 * pipeline pieces as `runSessionPipeline` (via the shared
 * `SessionPipelineCore`, `./pipelineCore.ts`) driven live, one
 * `LocationProvider` sample at a time, instead of in a batch loop over a
 * fixture array. Owns: calibration flow, arm/out-lap/timing, checkpointing,
 * PB replacement (immediate + session-end), the live delta engine fed from
 * the stored reference lap, the ADR-0003 §1 watchdog, and ADR-0003 §3
 * recovery.
 */
export class SessionController {
  private core: SessionPipelineCore;
  private calibrationEngine: CalibrationEngine | null = null;
  private mode: 'idle' | 'calibrating' | 'live' = 'idle';
  private sessionId: string | null = null;
  private sessionStartedAtUtc: string | null = null;
  private providerRunning = false;
  private lastSampleAtMono: number | null = null;
  private watchdogHandle: unknown = null;
  private watchRestarts = 0;
  private paused = false;
  private pauseStartedAtMono: number | null = null;
  private latestDelta: DeltaUpdate | null = null;
  private latestSpeedKph: number | null = null;
  private latestGnssQuality: QualityLevel = 'good';
  private calibrationSnapshot: {
    coverageFraction: number;
    onTrack: boolean;
    rawLocalX?: number;
    rawLocalY?: number;
    matchedLocalX?: number;
    matchedLocalY?: number;
    lateralM?: number;
    distanceM?: number;
  } | null = null;
  private calibrationResult: CalibrationResult | null = null;
  private lastLapMs: number | null = null;
  private pbMs: number | null = null;
  private currentReference: ReferenceLap | null = null;
  private rawSamples: LocationSample[] = [];
  /** Phase 3 coaching addendum. `null` whenever coaching is disabled (`deps.coaching` unset/`enabled: false`) or the supplied corner set is empty -- every coaching code path below is a no-op in that case. */
  private readonly coachEngine: CoachEngine | null;
  private readonly coachCorners: Corner[];
  private currentCue: CoachCue | null = null;
  private coachCueSetAtMono: number | null = null;
  private coachZoneRefreshes = 0;
  /**
   * Sync mechanism for MUST DO #5 (lap-number collision after recovery
   * resume). `SessionMachineSnapshot.lapNumber` (the reducer's own counter,
   * `statemachine/reducer.ts`) is intentionally unaware of restored history:
   * its `armed`/`outLap -> timing` transition always stamps the literal `1`
   * on the first live crossing, exactly as it would for a brand-new session
   * -- the reducer is a pure function of state+event and has no way to know
   * a resumed session already has laps 1..N on record. Rather than teach the
   * reducer about recovery (out of this ticket's write set), the controller
   * keeps the two counters in sync itself: `restoreFromCheckpoint` seeds
   * this offset to the highest restored lap number, `LapTimingEngine` is
   * separately given a matching `initialLapNumber` (so real `LapRecord`s it
   * produces are already correct), and `snapshotState()` below adds this
   * offset to the reducer's `state.lapNumber` whenever a lap is actually in
   * progress (non-zero) so the live "current lap" display agrees with it.
   * `0` for a session that was never restored, so fresh sessions are
   * unaffected (offset addition is a no-op).
   */
  private lapNumberOffset = 0;
  private readonly listeners = new Set<(s: FacadeStateCore) => void>();
  /** Fire-and-forget async work (telemetry/checkpoint/PB persistence) started from the synchronous sample handler -- see `flush()`. */
  private pendingWork: Array<Promise<unknown>> = [];
  /**
   * Serializes completed-lap SQL work in crossing order. A burst of samples
   * can complete several laps before the first async write resumes; without
   * this chain, atomic PB replacements can open overlapping SQLite
   * transactions on the same connection. Raw telemetry capture/trimming is
   * deliberately performed before joining this chain so live memory remains
   * bounded even during such a burst.
   */
  private lapPersistenceTail: Promise<void> = Promise.resolve();
  /** Unsubscribes this controller's `handleSample` callback from `deps.locationProvider` -- captured so `dispose()` (C1 fix) can detach it, letting a shared provider (e.g. one `GnssLocationProvider` instance reused across successive production controllers) be handed to a fresh controller without both instances receiving samples. */
  private providerUnsubscribe: (() => void) | null = null;
  /** Set by `dispose()`; makes it idempotent (a second call is a no-op). */
  private disposed = false;

  constructor(private readonly deps: SessionControllerDeps) {
    this.core = new SessionPipelineCore(deps.runtimeProfile, {
      corridorWidthM: deps.circuitProfile.corridorWidthM,
      ...deps.config?.pipeline,
      boundedTelemetry: true,
    });
    const coaching = deps.coaching;
    this.coachCorners = coaching?.enabled === true ? coaching.corners : [];
    this.coachEngine =
      coaching?.enabled === true && coaching.corners.length > 0
        ? new CoachEngine({ totalLengthM: deps.circuitProfile.totalLengthM })
        : null;
  }

  private trackAsync(work: Promise<unknown>): void {
    this.pendingWork.push(work);
  }

  /**
   * Awaits every persistence side-effect kicked off from a synchronous
   * sample callback (telemetry/checkpoint saves, PB replacement, reference
   * reload) so a caller -- tests, or the app before navigating away -- can
   * be sure the repository reflects everything ingested so far.
   */
  async flush(): Promise<void> {
    const pending = this.pendingWork;
    this.pendingWork = [];
    // Persistence failures must reach the caller; silently settling them made
    // a completed flush indistinguishable from lost telemetry/PB writes.
    await Promise.all(pending);
  }

  // -------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------

  subscribe(cb: (s: FacadeStateCore) => void): () => void {
    this.listeners.add(cb);
    cb(this.snapshotState());
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(): void {
    const state = this.snapshotState();
    for (const listener of this.listeners) listener(state);
  }

  private snapshotState(): FacadeStateCore {
    const currentLap = this.core.currentLap();
    const currentLapMs = currentLap !== null ? currentLap.elapsedMs(this.deps.clock.now()) : 0;
    // See `lapNumberOffset`'s doc comment: only applied once a lap is
    // actually in progress (non-zero), so idle/armed/pre-lap phases still
    // read 0 exactly as a fresh session would.
    const rawLapNumber = this.core.state.lapNumber;
    return {
      sessionState: this.core.state.state,
      lapNumber: rawLapNumber === 0 ? 0 : rawLapNumber + this.lapNumberOffset,
      currentLapMs,
      lastLapMs: this.lastLapMs,
      pbMs: this.pbMs,
      delta: this.latestDelta,
      sector: currentLap?.sectorIndex ?? 0,
      gnssQuality: this.latestGnssQuality,
      calibration: this.calibrationSnapshot,
      calibrationResult: this.calibrationResult,
      laps: [...this.core.laps],
      speedKph: this.latestSpeedKph,
      coachCue: this.currentCue,
    };
  }

  diagnostics(): SessionControllerDiagnostics {
    return {
      sessionId: this.sessionId,
      watchRestarts: this.watchRestarts,
      qualityCounts: { ...this.core.qualityCounts },
      matchedSampleCount: this.core.matchedTotal,
      rejectedSampleCount: this.core.rejectedTotal,
      reverseTravelDetected: this.core.reverseTravelDetected,
      appliedInvalidReasons: [...this.core.appliedInvalidReasons],
      rawSampleBufferSize: this.rawSamples.length,
      coachZoneRefreshes: this.coachZoneRefreshes,
    };
  }

  // -------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------

  /**
   * Begins a session. `'calibration'` (the normal path) starts a fresh Learn
   * lap; `'session'` skips straight to `armed` using the already-stored
   * reference lap and is used only by the recovery flow after
   * `restoreFromCheckpoint` (see that method's doc comment for why recovery
   * never resumes a live calibration).
   *
   * F1 fix (C7 regression, HIGH -- duplicate sample listener after a
   * failed-then-retried start): every state-machine dispatch AND the mode
   * transition below run ONLY AFTER `ensureProviderRunning()` has confirmed
   * `deps.locationProvider.start()` actually succeeded. Previously those
   * dispatches ran FIRST, so a `start()` whose provider then failed left the
   * controller mutated into `'calibrating'` with no way back -- AND
   * `ensureProviderRunning` had already installed a sample-listener
   * subscription before awaiting `provider.start()`, so a caller's retry
   * (another `start()` call after the failure) installed a SECOND
   * subscription while the first -- never unsubscribed, since the failed
   * attempt threw before it could be -- kept receiving every sample too,
   * double-ingesting each fix. Ordering the provider confirmation first
   * means a failed `start()` leaves `core.state`, `mode`, and every
   * calibration field completely untouched (nothing to snapshot/roll back:
   * there is nothing here left to undo), and `ensureProviderRunning` itself
   * only ever subscribes once it has proof `provider.start()` already
   * resolved -- see that method's own doc comment for the retry-safety
   * guard.
   */
  async start(phase: 'calibration' | 'session'): Promise<void> {
    if (this.sessionId === null) {
      this.sessionId = `${this.deps.userId}--${randomToken()}`;
      this.sessionStartedAtUtc = new Date().toISOString();
    }

    if (phase === 'session') {
      // Pure repository I/O -- doesn't touch `core.state`/`mode`, so its
      // position relative to `ensureProviderRunning()` below is immaterial;
      // done here so `this.currentReference`/`this.pbMs` are ready by the
      // time the CALIBRATION_ACCEPTED dispatch below runs.
      await this.loadReferenceForSession();
    }

    await this.ensureProviderRunning();

    this.core.dispatch({ type: 'START_PREFLIGHT' });
    this.core.dispatch({ type: 'PREFLIGHT_PASSED' });

    if (phase === 'calibration') {
      this.calibrationEngine = new CalibrationEngine(this.deps.runtimeProfile, {
        corridorWidthM: this.deps.circuitProfile.corridorWidthM,
        ...this.deps.config?.calibration,
      });
      this.calibrationResult = null;
      this.calibrationSnapshot = { coverageFraction: 0, onTrack: true };
      this.core.dispatch({ type: 'CALIBRATION_STARTED' });
      this.mode = 'calibrating';
    } else {
      this.core.dispatch({ type: 'CALIBRATION_STARTED' });
      this.core.dispatch({ type: 'CALIBRATION_FINISHED', result: recoverySkippedCalibrationResult() });
      this.core.dispatch({ type: 'CALIBRATION_ACCEPTED' });
      this.calibrationResult = null;
      this.mode = 'idle';
    }

    this.startWatchdog();
    this.emit();
  }

  private finishCalibrationNow(): void {
    if (this.calibrationEngine === null) return;
    const result = this.calibrationEngine.finish();
    this.calibrationResult = result;
    this.core.dispatch({ type: 'CALIBRATION_FINISHED', result });
    this.mode = 'idle';
    this.emit();
  }

  acceptCalibration(): void {
    if (this.core.state.state !== 'calibrationReview') return;
    this.core.dispatch({ type: 'CALIBRATION_ACCEPTED' });
    this.calibrationSnapshot = null;
    this.calibrationEngine = null;
    this.trackAsync(this.loadReferenceForSession().then(() => this.emit()));
    this.emit();
  }

  rejectCalibration(): void {
    const state = this.core.state.state;
    if (state === 'calibrating') {
      // Mid-lap cancel: no CALIBRATION_REJECTED transition is legal directly
      // from `calibrating` (see statemachine/reducer.ts) -- force a legal
      // CALIBRATION_FINISHED(accepted:false) first so the state machine's
      // real `calibrationReview -> awaitingCalibration` path applies, rather
      // than shortcutting around it.
      const cancelled = this.calibrationEngine?.finish() ?? cancelledCalibrationResult();
      this.core.dispatch({
        type: 'CALIBRATION_FINISHED',
        result: { ...cancelled, accepted: false, failureReasons: [...new Set([...cancelled.failureReasons, 'CANCELLED'])] },
      });
    }
    if (this.core.state.state !== 'calibrationReview') return;
    this.core.dispatch({ type: 'CALIBRATION_REJECTED' });
    this.calibrationEngine = null;
    this.calibrationSnapshot = null;
    this.calibrationResult = null;
    this.mode = 'idle';
    this.emit();
  }

  /** Confirms the session is armed and starts feeding live samples into the timing pipeline (out-lap -> timing begins on the next forward start/finish crossing). */
  arm(): void {
    if (this.core.state.state !== 'armed') return;
    this.mode = 'live';
    this.emit();
  }

  pause(): void {
    if (!PAUSABLE_STATES.has(this.core.state.state)) return;
    this.paused = true;
    this.pauseStartedAtMono = this.deps.clock.now();
    this.core.dispatch({ type: 'PAUSE' });
    this.trackAsync(this.checkpointNow());
    this.emit();
  }

  resume(): void {
    if (this.core.state.state !== 'paused') return;
    const gapMs =
      this.pauseStartedAtMono === null ? 0 : Math.max(0, this.deps.clock.now() - this.pauseStartedAtMono);
    this.paused = false;
    this.pauseStartedAtMono = null;
    this.core.dispatch({ type: 'RESUME', gapMs });
    this.emit();
  }

  /**
   * Ends the session. Order (C4 fix, binding): provider stop -> flush ->
   * saveSession -> emit `sessionComplete`. `flush()` is awaited BEFORE the
   * session summary is saved so every telemetry/checkpoint/PB write already
   * queued from the last completed lap(s) is durably committed first --
   * previously `saveSession`/the final checkpoint could race ahead of that
   * work, so killing the app from the just-reached Results screen could lose
   * it. `flush()` rejecting (a persistence failure) propagates out of this
   * method instead of being swallowed, so it reaches the facade's error path
   * (C7) rather than silently leaving `sessionComplete` un-emitted.
   */
  async endSession(): Promise<void> {
    this.stopWatchdog();
    if (this.providerRunning) {
      await this.deps.locationProvider.stop();
      this.providerRunning = false;
    }
    this.core.dispatch({ type: 'END_SESSION' });
    await this.flush();
    const sessionId = this.sessionId;
    if (sessionId !== null) {
      const summary: SessionSummary = {
        sessionId,
        circuitId: this.deps.circuitProfile.circuitId,
        layoutId: this.deps.circuitProfile.layoutId,
        layoutVersion: this.deps.circuitProfile.layoutVersion,
        startedAtUtc: this.sessionStartedAtUtc ?? new Date().toISOString(),
        laps: this.core.laps,
        userId: this.deps.userId,
      };
      await this.deps.repository.saveSession(summary);
      // Persist a terminal checkpoint too, so recovery never re-offers a
      // session that has already been fully saved.
      await this.deps.repository.saveCheckpoint(sessionId, this.core.state, this.core.laps);
    }
    this.mode = 'idle';
    this.latestDelta = null;
    this.currentCue = null;
    this.coachCueSetAtMono = null;
    this.emit();
  }

  /**
   * Disposes this controller (C1 fix, one-shot-controller bug): stops the
   * watchdog scheduler, stops the location provider and detaches this
   * controller's sample listener from it (`providerUnsubscribe`), and clears
   * every state listener -- so a disposed controller can never emit again
   * and never double-handles samples if its (possibly shared) provider is
   * handed to a freshly constructed replacement controller. Idempotent: a
   * second call is a no-op. Does not touch persisted data -- `endSession()`
   * already saved anything worth keeping before a caller would dispose.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopWatchdog();
    try {
      if (this.providerRunning) {
        await this.deps.locationProvider.stop();
      }
    } finally {
      // F2 residue fix: detachment (the sample-listener unsubscribe and
      // clearing every state listener) must happen even when `stop()`
      // rejects -- previously a rejecting `stop()` threw out of this method
      // before reaching either, leaving the listener attached to a
      // (possibly shared) provider that a freshly constructed replacement
      // controller is about to subscribe to as well. The rejection itself
      // still propagates to this method's own caller after detachment
      // completes (a genuine provider failure shouldn't be silently
      // swallowed), it just no longer skips cleanup on the way out.
      this.providerRunning = false;
      if (this.providerUnsubscribe !== null) {
        this.providerUnsubscribe();
        this.providerUnsubscribe = null;
      }
      this.listeners.clear();
    }
  }

  /**
   * ADR-0003 §3 recovery. Restores historical laps from a persisted
   * checkpoint into a fresh pipeline. Per `platform/clock.ts`'s binding
   * monotonic-timing rule, a `tMono` recorded in a previous process launch
   * is never comparable to a new `performance.now()` origin -- so this
   * deliberately does NOT try to resume an in-flight lap's live timer. Any
   * lap that was still open when the checkpoint was written (state is
   * `outLap`/`timing`/`inPit`, or `paused` with one of those as
   * `priorState`) is appended as a zero-duration, explicitly invalid
   * `RECOVERY` lap record instead of a fabricated real time. The session
   * then re-enters `awaitingCalibration` (a fresh Learn lap is required
   * before timing can safely resume) -- callers needing to skip that (e.g. a
   * "resume without recalibrating" UX) use `start('session')` instead, which
   * goes straight to `armed` off the last-known stored reference lap.
   */
  restoreFromCheckpoint(sessionId: string, snapshot: SessionMachineSnapshot, laps: LapRecord[]): void {
    this.sessionId = sessionId;

    const priorState = snapshot.context.priorState;
    const midSession =
      MID_SESSION_STATES.has(snapshot.state) ||
      (snapshot.state === 'paused' && typeof priorState === 'string' && MID_SESSION_STATES.has(priorState as SessionState));

    // MUST DO #5: seed the lap-number sync offset from the highest restored
    // lap number (including the synthetic in-flight RECOVERY lap below, if
    // any) BEFORE the fresh pipeline is built, so both halves of the sync
    // mechanism -- `LapTimingEngine.initialLapNumber` (real completed laps)
    // and `lapNumberOffset` (the reducer-driven live display, applied in
    // `snapshotState()`) -- agree on the same next-lap-number from the
    // start. `0` when there's no restored history (matches a fresh session).
    const restoredLapNumbers = laps.map((lap) => lap.lapNumber);
    if (midSession) restoredLapNumbers.push(snapshot.lapNumber);
    this.lapNumberOffset = restoredLapNumbers.length === 0 ? 0 : Math.max(...restoredLapNumbers);

    this.core = new SessionPipelineCore(this.deps.runtimeProfile, {
      corridorWidthM: this.deps.circuitProfile.corridorWidthM,
      ...this.deps.config?.pipeline,
      boundedTelemetry: true,
      timing: { ...this.deps.config?.pipeline?.timing, initialLapNumber: this.lapNumberOffset + 1 },
    });
    this.mode = 'idle';
    this.calibrationEngine = null;
    this.calibrationSnapshot = null;
    this.calibrationResult = null;
    this.paused = false;
    // A restored checkpoint carries no live coaching state to resume (the
    // engine's per-lap rearm bookkeeping is meaningless across a process
    // restart) -- clear the displayed cue and rearm the engine itself so a
    // stale cue from the prior process can never resurface.
    this.currentCue = null;
    this.coachCueSetAtMono = null;
    this.coachEngine?.reset();

    for (const lap of laps) this.core.laps.push(lap);
    if (midSession) {
      const recoveryLap: LapRecord = {
        lapNumber: snapshot.lapNumber,
        tStart: 0,
        tEnd: 0,
        durationMs: 0,
        sectorTimes: [],
        valid: false,
        invalidReasons: ['RECOVERY'],
        quality: 'invalid',
      };
      this.core.laps.push(recoveryLap);
    }

    this.core.dispatch({ type: 'START_PREFLIGHT' });
    this.core.dispatch({ type: 'PREFLIGHT_PASSED' });
    const lastLap = this.core.laps[this.core.laps.length - 1];
    this.lastLapMs = lastLap?.durationMs ?? null;
    this.emit();
  }

  // -------------------------------------------------------------------
  // Location provider plumbing
  // -------------------------------------------------------------------

  /**
   * F1 fix: confirms `deps.locationProvider.start()` has actually resolved
   * BEFORE installing this controller's sample-listener subscription (not
   * before, as previously) -- see `start()`'s doc comment for the double-
   * ingestion bug this closes. `providerUnsubscribe` is defensively cleared
   * first too: `providerRunning` only flips to `true` once this method has
   * both started the provider AND subscribed, so under normal single-
   * threaded control flow it should already be `null` here on every call
   * that reaches the subscribe line -- but a retry after a failed attempt is
   * exactly the scenario this bug lived in, so the guard stays as a
   * defense-in-depth invariant: a retry must always end up with exactly ONE
   * live subscription, never two.
   */
  private async ensureProviderRunning(): Promise<void> {
    if (!this.providerRunning) {
      await this.deps.locationProvider.start();
      if (this.providerUnsubscribe !== null) {
        this.providerUnsubscribe();
        this.providerUnsubscribe = null;
      }
      this.providerUnsubscribe = this.deps.locationProvider.subscribe((sample) => this.handleSample(sample));
      this.providerRunning = true;
    }
    // Seed the watchdog baseline at (re)start so a slow first fix isn't
    // immediately flagged as a gap.
    this.lastSampleAtMono = this.deps.clock.now();
  }

  private handleSample(sample: LocationSample): void {
    this.lastSampleAtMono = this.deps.clock.now();
    if (this.paused) return;

    if (this.mode === 'calibrating' && this.calibrationEngine !== null) {
      this.calibrationEngine.feed(sample);
      const progress = this.calibrationEngine.progress();
      this.calibrationSnapshot = {
        coverageFraction: progress.coverageFraction,
        onTrack: progress.onTrack,
        rawLocalX: progress.rawLocalX,
        rawLocalY: progress.rawLocalY,
        matchedLocalX: progress.matchedLocalX,
        matchedLocalY: progress.matchedLocalY,
        lateralM: progress.lateralM,
        distanceM: progress.distanceM,
      };
      this.latestGnssQuality = progress.qualityOk ? 'good' : 'degraded';
      if (progress.coverageFraction >= CALIBRATION_COMPLETE_COVERAGE_FRACTION) this.finishCalibrationNow();
      this.emit();
      return;
    }

    if (this.mode !== 'live') return;

    this.rawSamples.push(sample);
    const result = this.core.ingest(sample);
    this.latestGnssQuality = result.assessment.level;
    if (sample.speedMps !== undefined) this.latestSpeedKph = sample.speedMps * 3.6;
    if (result.completingStartFinish) {
      // SessionPipelineCore resets its delta engine at this boundary. Clear
      // the facade value in the same sample so the just-finished lap's delta
      // is never displayed as though it belonged to the new lap.
      this.latestDelta = null;
      // Coaching addendum: lap rollover always clears the displayed cue too
      // (MUST DO #1) -- a cue from the lap that just ended must never bleed
      // into the new lap's first samples, even if it hasn't gone stale yet.
      this.currentCue = null;
      this.coachCueSetAtMono = null;
    } else if (result.match === null) {
      // A rejected fix must never leave a stale faster/slower indication on
      // screen. The delta engine cannot observe rejected matches itself, so
      // neutralize at the controller boundary until trustworthy matching
      // resumes (track-day soak defect: invalid GNSS window retained delta).
      this.latestDelta = {
        deltaMs: this.latestDelta?.deltaMs ?? 0,
        confidence: 0,
        display: 'neutral',
      };
    } else if (result.currentLapElapsedMs !== null && !result.completingStartFinish) {
      this.latestDelta = this.core.computeDelta(result.match, result.currentLapElapsedMs);
    }
    // Coaching addendum (F1/F2/F4 fix): fed only from an ACCEPTED match --
    // `result.match` is already `null` for a sample the pipeline rejected on
    // quality grounds (the SAME gate `computeDelta` above relies on), so no
    // separate quality check is needed here. F4: racing-line brake/corner
    // advice must never show or be computed while in the pit lane (pit speed
    // limits and traffic procedures govern there, not the racing line) --
    // `CoachEngine` is not even fed a pit-lane match, and any cue already on
    // screen is cleared the SAME sample pit entry is observed, from EITHER
    // signal (the hysteresis-debounced `inPit` session state, or the raw
    // per-match `onPitLane` flag, whichever trips first). Otherwise, a fresh
    // cue replaces the displayed one immediately; a `null` result holds the
    // previous cue for at most `COACH_CUE_FLICKER_HOLD_MS` (bridging a single
    // brief quality/matching gap) before clearing.
    if (this.coachEngine !== null) {
      const inPit = this.core.state.state === 'inPit' || (result.match?.onPitLane ?? false);
      if (inPit) {
        this.currentCue = null;
        this.coachCueSetAtMono = null;
      } else {
        const cue = result.match !== null ? this.coachEngine.onMatch(result.match, sample.speedMps) : null;
        if (cue !== null) {
          this.currentCue = cue;
          this.coachCueSetAtMono = this.deps.clock.now();
        } else if (result.match !== null) {
          // An ACCEPTED match returning no cue is ground truth (target passed
          // or corner exited): clear immediately. The flicker-hold below is
          // reserved for rejected/unmatched samples only — holding here left
          // a stale "BRAKE IN" visible ~80 m past the corner at speed.
          this.currentCue = null;
          this.coachCueSetAtMono = null;
        } else if (
          this.currentCue !== null &&
          this.coachCueSetAtMono !== null &&
          this.deps.clock.now() - this.coachCueSetAtMono > COACH_CUE_FLICKER_HOLD_MS
        ) {
          this.currentCue = null;
          this.coachCueSetAtMono = null;
        }
      }
    }
    for (const lap of result.completedLaps) {
      this.trackAsync(this.onLapCompleted(lap));
    }
    this.emit();
  }

  private onLapCompleted(lap: LapRecord): Promise<void> {
    this.lastLapMs = lap.durationMs;
    const sessionId = this.sessionId;
    if (sessionId === null) return Promise.resolve();
    const telemetry = this.rawSamples.filter(
      (sample) => sample.tMono >= lap.tStart && sample.tMono <= lap.tEnd,
    );
    // Trim the buffer down to only the still in-flight tail (samples after
    // this lap's end) so it stays O(current lap), not O(whole session) --
    // M2 fix. Every sample up to and including this lap's end has now either
    // been persisted above or belonged to an earlier, already-saved lap.
    this.rawSamples = this.rawSamples.filter((sample) => sample.tMono > lap.tEnd);
    // Build while this lap's matches are guaranteed to still be present in
    // SessionPipelineCore's bounded rolling buffer. Deferring construction
    // into the SQL queue can let a burst of later laps evict this telemetry
    // before persistence resumes, silently skipping a legitimate PB.
    const pbCandidate = this.buildPbCandidate(lap, sessionId);
    // Capture the checkpoint at this boundary too. Reading `core.state` and
    // `core.laps` later inside the queue can make an early checkpoint claim
    // later laps whose telemetry has not been written yet.
    const checkpointSnapshot = this.core.state;
    const checkpointLaps = [...this.core.laps];
    const persistence = this.lapPersistenceTail.then(async () => {
      await this.deps.repository.saveTelemetry(sessionId, lap.lapNumber, telemetry);
      await this.deps.repository.saveCheckpoint(
        sessionId,
        checkpointSnapshot,
        checkpointLaps,
      );
      await this.maybeReplacePb(lap, pbCandidate);
      this.emit();
    });
    // Keep later laps moving even if one write fails; `persistence` itself is
    // still tracked by `flush()` so the original rejection reaches the caller.
    this.lapPersistenceTail = persistence.catch(() => undefined);
    return persistence;
  }

  private buildPbCandidate(lap: LapRecord, sessionId: string): ReferenceLap | null {
    if (!lap.valid) return null;
    const built = buildReferenceLap({
      profile: this.deps.circuitProfile,
      lap,
      matches: this.core.matches,
      userId: this.deps.userId,
      recordedAtUtc: new Date().toISOString(),
      sessionId,
      appVersion: this.deps.appVersion,
      algorithmVersion: this.deps.algorithmVersion,
      ...(this.deps.device === undefined ? {} : { device: this.deps.device }),
    });
    return built.ok ? built.reference : null;
  }

  private async maybeReplacePb(lap: LapRecord, candidate: ReferenceLap | null): Promise<void> {
    if (candidate === null) return;
    const expectedSectorCount = this.deps.runtimeProfile.sectorGates.length + 1;
    const replace = shouldReplacePb(this.currentReference, {
      reference: candidate,
      lap,
      fullTelemetry: true,
      expectedSectorCount,
    });
    if (!replace) return;
    // Atomic replace (write-new-then-swap is `putReferenceLap`'s own
    // contract, contracts.md's PB rules) applied immediately -- not deferred
    // to session end.
    await this.deps.repository.putReferenceLap(candidate);
    this.currentReference = candidate;
    this.pbMs = candidate.durationMs;
    this.core.setReference(candidate);
    // Coaching addendum (MUST DO #1): a NEW PB reference lap landing
    // mid-session upgrades the braking-zone `source` from 'physics' to
    // 'reference' (deriveBrakingZones prefers real telemetry over the decel
    // model whenever a usable reference is supplied) -- regenerate zones from
    // it and count the refresh, so diagnostics/tests can observe it happened.
    // M-PB-refresh fix: `preserveEmitted: true` -- this can resolve mid-lap
    // (PB persistence is asynchronous), and the driver may already be partway
    // into the NEW lap by the time it lands. Wiping `coachEngine`'s per-lap
    // "already driven past" memory here would let an already-completed
    // corner earlier in that same lap become a fresh candidate again purely
    // because its zone geometry changed underneath it.
    if (this.coachEngine !== null) {
      this.refreshCoachZones(candidate, { preserveEmitted: true });
      this.coachZoneRefreshes += 1;
    }
  }

  /** Rebuilds this controller's braking zones from `this.coachCorners` + the given reference lap (or `null` for the physics-only fallback) and reconfigures `coachEngine` with them. A no-op when coaching is disabled. `options.preserveEmitted` forwards straight to `CoachEngine.configure()` -- see its own doc comment (`contracts.ts`). */
  private refreshCoachZones(reference: ReferenceLap | null, options?: { preserveEmitted?: boolean }): void {
    if (this.coachEngine === null) return;
    const zones: BrakingZone[] = deriveBrakingZones(reference, this.coachCorners, {
      totalLengthM: this.deps.circuitProfile.totalLengthM,
    });
    this.coachEngine.configure(this.coachCorners, zones, options);
  }

  private async loadReferenceForSession(): Promise<void> {
    const stored = await this.deps.repository.getReferenceLap(
      this.deps.userId,
      this.deps.circuitProfile.circuitId,
      this.deps.circuitProfile.layoutId,
      this.deps.circuitProfile.layoutVersion,
    );
    this.currentReference = stored;
    this.pbMs = stored?.durationMs ?? null;
    this.core.setReference(stored);
    this.refreshCoachZones(stored);
  }

  /**
   * Persists a checkpoint immediately (MUST DO #4). Public so composition
   * can drive it from outside a live sample callback -- specifically the
   * app-background lifecycle listener (`apps/mobile/src/session/composition.ts`),
   * which fires on an OS-level background transition, not a pipeline event.
   * A no-op before any session has started (`sessionId === null`), so it's
   * always safe to call unconditionally. Also used internally by `pause()`
   * and after every completed lap.
   */
  async checkpointNow(): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId === null) return;
    await this.deps.repository.saveCheckpoint(sessionId, this.core.state, this.core.laps);
  }

  // -------------------------------------------------------------------
  // Watchdog (ADR-0003 §1, binding)
  // -------------------------------------------------------------------

  private startWatchdog(): void {
    this.stopWatchdog();
    const scheduler = this.deps.config?.scheduler ?? defaultScheduler;
    const timeoutMs = this.deps.config?.watchdogTimeoutMs ?? DEFAULT_WATCHDOG_TIMEOUT_MS;
    const pollMs = this.deps.config?.watchdogPollMs ?? DEFAULT_WATCHDOG_POLL_MS;
    this.watchdogHandle = scheduler.setInterval(() => this.checkWatchdog(timeoutMs), pollMs);
  }

  private stopWatchdog(): void {
    if (this.watchdogHandle !== null) {
      const scheduler = this.deps.config?.scheduler ?? defaultScheduler;
      scheduler.clearInterval(this.watchdogHandle);
      this.watchdogHandle = null;
    }
  }

  private checkWatchdog(timeoutMs: number): void {
    if (this.paused) return;
    const state = this.core.state.state;
    if (state === 'idle' || state === 'sessionComplete' || state === 'error') return;
    if (this.lastSampleAtMono === null) return;
    const gapMs = this.deps.clock.now() - this.lastSampleAtMono;
    if (gapMs > timeoutMs) {
      this.watchRestarts += 1;
      // Reset the baseline so a slow-restarting provider doesn't re-fire the
      // watchdog on every subsequent poll tick before its next real sample.
      this.lastSampleAtMono = this.deps.clock.now();
      this.trackAsync(Promise.resolve(this.deps.restartProvider()));
    }
  }
}
