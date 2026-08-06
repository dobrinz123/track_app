import type {
  CalibrationResult,
  CircuitProfile,
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
  calibration: { coverageFraction: number; onTrack: boolean } | null;
  calibrationResult: CalibrationResult | null;
  laps: LapRecord[];
  /** Latest known speed in km/h, derived from the most recent sample's `speedMps`; `null` before any sample reports one. */
  speedKph: number | null;
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
  /** Provenance/geometry fields `buildReferenceLap`/`SessionSummary` need -- a subset of the full `CircuitProfile`. */
  circuitProfile: Pick<CircuitProfile, 'circuitId' | 'layoutId' | 'layoutVersion' | 'schemaVersion' | 'totalLengthM'>;
  locationProvider: LocationProvider;
  clock: MonotonicClock;
  repository: LocalSessionRepository;
  userId: string;
  appVersion: string;
  algorithmVersion: number;
  device?: string;
  /** Restarts the location provider (stop then start) -- the app passes `GnssLocationProvider`'s own stop/start (ADR-0003 §1). Invoked by the watchdog. */
  restartProvider: () => Promise<void> | void;
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
  private calibrationSnapshot: { coverageFraction: number; onTrack: boolean } | null = null;
  private calibrationResult: CalibrationResult | null = null;
  private lastLapMs: number | null = null;
  private pbMs: number | null = null;
  private currentReference: ReferenceLap | null = null;
  private rawSamples: LocationSample[] = [];
  private readonly listeners = new Set<(s: FacadeStateCore) => void>();
  /** Fire-and-forget async work (telemetry/checkpoint/PB persistence) started from the synchronous sample handler -- see `flush()`. */
  private pendingWork: Array<Promise<unknown>> = [];

  constructor(private readonly deps: SessionControllerDeps) {
    this.core = new SessionPipelineCore(deps.runtimeProfile, {
      ...deps.config?.pipeline,
      boundedTelemetry: true,
    });
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
    await Promise.allSettled(pending);
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
    return {
      sessionState: this.core.state.state,
      lapNumber: this.core.state.lapNumber,
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
   */
  async start(phase: 'calibration' | 'session'): Promise<void> {
    if (this.sessionId === null) {
      this.sessionId = `${this.deps.userId}--${randomToken()}`;
      this.sessionStartedAtUtc = new Date().toISOString();
    }
    this.core.dispatch({ type: 'START_PREFLIGHT' });
    this.core.dispatch({ type: 'PREFLIGHT_PASSED' });

    if (phase === 'calibration') {
      this.calibrationEngine = new CalibrationEngine(this.deps.runtimeProfile, this.deps.config?.calibration);
      this.calibrationResult = null;
      this.calibrationSnapshot = { coverageFraction: 0, onTrack: true };
      this.core.dispatch({ type: 'CALIBRATION_STARTED' });
      this.mode = 'calibrating';
    } else {
      await this.loadReferenceForSession();
      this.core.dispatch({ type: 'CALIBRATION_STARTED' });
      this.core.dispatch({ type: 'CALIBRATION_FINISHED', result: recoverySkippedCalibrationResult() });
      this.core.dispatch({ type: 'CALIBRATION_ACCEPTED' });
      this.calibrationResult = null;
      this.mode = 'idle';
    }

    await this.ensureProviderRunning();
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

  async endSession(): Promise<void> {
    this.stopWatchdog();
    if (this.providerRunning) {
      await this.deps.locationProvider.stop();
      this.providerRunning = false;
    }
    this.core.dispatch({ type: 'END_SESSION' });
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
    this.emit();
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
    this.core = new SessionPipelineCore(this.deps.runtimeProfile, {
      ...this.deps.config?.pipeline,
      boundedTelemetry: true,
    });
    this.mode = 'idle';
    this.calibrationEngine = null;
    this.calibrationSnapshot = null;
    this.calibrationResult = null;
    this.paused = false;

    const priorState = snapshot.context.priorState;
    const midSession =
      MID_SESSION_STATES.has(snapshot.state) ||
      (snapshot.state === 'paused' && typeof priorState === 'string' && MID_SESSION_STATES.has(priorState as SessionState));

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

  private async ensureProviderRunning(): Promise<void> {
    if (!this.providerRunning) {
      this.deps.locationProvider.subscribe((sample) => this.handleSample(sample));
      await this.deps.locationProvider.start();
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
      this.calibrationSnapshot = { coverageFraction: progress.coverageFraction, onTrack: progress.onTrack };
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
    if (result.match !== null && result.currentLapElapsedMs !== null && !result.completingStartFinish) {
      this.latestDelta = this.core.computeDelta(result.match, result.currentLapElapsedMs);
    }
    for (const lap of result.completedLaps) {
      this.trackAsync(this.onLapCompleted(lap));
    }
    this.emit();
  }

  private async onLapCompleted(lap: LapRecord): Promise<void> {
    this.lastLapMs = lap.durationMs;
    const sessionId = this.sessionId;
    if (sessionId === null) return;
    const telemetry = this.rawSamples.filter((sample) => sample.tMono >= lap.tStart && sample.tMono <= lap.tEnd);
    // Trim the buffer down to only the still in-flight tail (samples after
    // this lap's end) so it stays O(current lap), not O(whole session) --
    // M2 fix. Every sample up to and including this lap's end has now either
    // been persisted above or belonged to an earlier, already-saved lap.
    this.rawSamples = this.rawSamples.filter((sample) => sample.tMono > lap.tEnd);
    await this.deps.repository.saveTelemetry(sessionId, lap.lapNumber, telemetry);
    await this.checkpointNow();
    await this.maybeReplacePb(lap);
    this.emit();
  }

  private async maybeReplacePb(lap: LapRecord): Promise<void> {
    if (!lap.valid) return;
    const sessionId = this.sessionId;
    if (sessionId === null) return;
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
    if (!built.ok) return;
    const candidate = built.reference;
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
  }

  private async checkpointNow(): Promise<void> {
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
