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
  TrackMatch,
} from '../contracts';
import { CalibrationEngine, type CalibrationConfig } from '../calibration';
import { CoachEngine, deriveBrakingZones } from '../coach';
import {
  MAX_BRAKE_LATER_M,
  verifyCueEvidence,
  type ActiveCue,
  type CueEvidenceEntry,
  type CuePoint,
  type CueUpdate,
  type CueUpdateEvidence,
} from '../coaching/suggestions';
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
  /**
   * Ticket P5c-B D2 (contracts.md R2-3a): every brake/lift cue this session
   * has moved on the driver's own demonstrated evidence, oldest first. Empty
   * for the whole session whenever coaching is off, the driver has not opted
   * into suggestions, or nothing was demonstrated worth moving to -- which is
   * the default. A moved cue is never silent: this is the record the pit view
   * and the exported report both read.
   */
  coachCueUpdates: AppliedCueUpdate[];
  /**
   * Ticket P7M M2: whether the app currently believes the car is on the
   * mapped circuit at all.
   *
   * `gnssQuality` above is a GNSS metric and nothing more -- it answers "is
   * the fix any good", not "does the fix belong to this track". A car driving
   * 100 m off a centerline traced from aerial imagery, under a clear sky,
   * reads `good` while every lap it drives goes uncounted, and until this
   * field existed there was no live state on the driving screen that could
   * say so. That matters most on the first visit to a circuit whose geometry
   * has never been validated on site, which is exactly when the driver needs
   * to tell "working" from "silently broken" without stopping.
   */
  trackMatch: {
    state: TrackMatchState;
    /** Absolute distance from the centerline of the last matched fix, metres; `null` when the last fix produced no match at all. */
    lateralM: number | null;
    /** The matcher's own confidence in that fix, `[0,1]`; `null` when there was no match. */
    confidence: number | null;
  };
  /**
   * Ticket P7M M6: proof, from the car, that the drive is being kept.
   *
   * The owner has already lost a track day to M1's defect -- drove, came
   * home, found nothing. M1 makes the trace survive; this makes the survival
   * VISIBLE while there is still time to act on it, because discovering it at
   * home is the failure that already happened once.
   *
   * `persistedSampleCount` counts GNSS samples whose `saveTelemetry` call has
   * RESOLVED -- never samples that merely passed through memory -- so it is
   * the write path itself reporting, not an optimistic tally beside it. It is
   * monotonic within a session: a lap claiming samples out of the unclaimed
   * chunks re-keys rows, it does not un-store anything.
   */
  recording: {
    /** GNSS samples durably written this session, confirmed write by confirmed write. */
    persistedSampleCount: number;
    /** Writes that failed this session. Non-zero means the count above has stopped telling the truth. */
    failedWriteCount: number;
  };
  /**
   * Ticket P7R E2: is this session running on matching the calibration gate
   * REFUSED to vouch for?
   *
   * `false` for every session that reached `armed` the ordinary way -- an
   * accepted calibration, or a recovery resume of one. `true` only after
   * {@link SessionController.proceedWithoutValidatedCalibration} concluded a
   * calibration the engine then REJECTED, i.e. the driver chose to go out and
   * collect data rather than lose the day to a gate that could not be
   * satisfied. It stays `false` when that same method force-finishes a lap
   * the engine turns out to ACCEPT -- that is an ordinary calibration and is
   * never labelled as anything else.
   *
   * It exists because the alternative to the escape hatch is a day with no
   * data at all -- that has already happened once -- but a session run on
   * geometry the gate rejected must never be indistinguishable from a
   * normal one. The thresholds are untouched; this is the honest label on
   * the outcome of overriding them.
   */
  matchingUnvalidated: boolean;
}

/**
 * Ticket P7M M2. `'unknown'` until the first live sample of a session (and
 * again after it ends); `'offTrack'` only once the car has failed to match the
 * circuit CONTINUOUSLY for {@link OFF_TRACK_HOLD_MS} -- one rejected fix is
 * ordinary and must never flash a warning at a driver mid-corner.
 */
export type TrackMatchState = 'unknown' | 'matched' | 'offTrack';

/** One {@link CueUpdate} the controller actually applied, with when it happened. */
export interface AppliedCueUpdate extends CueUpdate {
  /** `deps.clock.now()` at the moment the cue moved. */
  appliedAtMono: number;
  /** The session lap number that had just completed when it moved. */
  appliedAfterLapNumber: number;
}

/**
 * Ticket P5c-FIX1 E1/E2 — the identity an async analysis pass binds itself to
 * and must present again at apply time (Codex P5c-REV1 finding 1). A pass that
 * was computed for a different outing, a rebuilt controller, or an earlier
 * stint has nothing to say about the cues live now, and is refused.
 */
export interface CueUpdateContext {
  /** The outing the pass read. `null` before any session has started. */
  sessionId: string | null;
  /** Minted afresh on every session start / checkpoint restore. */
  generation: number;
  /** Advanced at every pit exit — the "per stint" in one change per corner per stint. */
  stintIndex: number;
  /** Completed laps at the moment the context was taken. */
  completedLapCount: number;
}

/** Why {@link SessionController.applyCueUpdates} refused an update (diagnostics). */
export type CueUpdateRejection =
  | 'coaching-disabled'
  | 'context-mismatch'
  | 'evidence-unsealed'
  | 'evidence-context-mismatch'
  | 'unknown-corner'
  | 'not-brake-point'
  | 'already-updated-this-stint'
  | 'cue-moved-underneath'
  | 'no-evidence-for-point'
  | 'evidence-mismatch'
  | 'not-later'
  | 'beyond-bound'
  | 'beyond-demonstrated'
  | 'not-finite';

/** The demonstrated evidence + the context a batch of updates was computed in. */
export interface CueUpdateRequest {
  context: CueUpdateContext;
  evidence: CueUpdateEvidence;
}

/**
 * Ticket P5c-FIX1 E3 (Codex P5c-REV1 finding 3, HIGH). The shipped voice
 * renders a BRAKE cue of severity 1-4 as the spoken word "Lift."
 * (`apps/mobile/src/session/voiceCoach.ts`'s `voiceUtteranceIdForCue`), and a
 * lift always precedes braking. Moving such a cue on the BRAKING envelope
 * would move a spoken "Lift." later than any lift the driver has demonstrated,
 * so those corners are validated against the LIFT envelope instead — and
 * refused outright when the pass carried no lift evidence for them.
 */
export const VOICE_LIFT_MAX_SEVERITY = 4;

/**
 * How far the cue the caller measured may sit from the cue the controller
 * actually has, metres, before the update counts as stale (E2). Distances are
 * projected onto a centerline, so an exact float match is not achievable; a
 * cue that moved by more than this is a different cue.
 */
export const CUE_POSITION_TOLERANCE_M = 0.5;

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
  /**
   * Ticket P7M M1: how many continuous raw-trace chunk rows this run has
   * written that still hold samples no completed lap has claimed (out-lap,
   * learn-lap, in-pit and -- the case this exists for -- an entire session in
   * which no crossing was ever detected). `0` before the first flush and
   * after every sample so far has been claimed by a lap row.
   */
  rawTraceChunkCount: number;
  /** Ticket P7M M1: samples currently held in those chunk rows. */
  rawTraceSampleCount: number;
  /** Ticket P7M M1: samples captured but not yet flushed to storage (at most one flush interval's worth). */
  rawTracePendingCount: number;
  /** Ticket P7M M1: raw-trace writes that failed this run. Never thrown (the trace must not be able to abort the session summary), so this is how a failing disk becomes visible. */
  rawTraceWriteFailures: number;
  /** Ticket P7M M6: GNSS samples this session has durably written, counted only as each write resolves. */
  persistedSampleCount: number;
  /** Number of times braking zones have been regenerated from a NEW personal-best reference lap landing mid-session (Phase 3 coaching addendum) -- 0 when coaching is disabled or no PB has been replaced yet this controller's lifetime. */
  coachZoneRefreshes: number;
}

/** Minimal timer abstraction the watchdog polls through -- see MUST DO #2 (ADR-0003 §1). Defaults to the platform's global `setInterval`/`clearInterval`; tests inject a fake to drive the poll deterministically with a fake clock. */
export interface WatchdogScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Wrap-safe positive remainder -- lap distances are cyclic. */
function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** Distance forward along the lap from `fromM` to `toM`, metres. */
function forwardDistance(fromM: number, toM: number, totalLengthM: number): number {
  return modulo(toM - fromM, totalLengthM);
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

/**
 * Ticket P7M M1 -- continuous raw-GNSS-trace persistence.
 *
 * Before this, `saveTelemetry` was called from exactly ONE place
 * (`onLapCompleted`), filtered to `lap.tStart..lap.tEnd`. A session in which
 * no start/finish crossing was ever detected -- the realistic outcome of a
 * first visit to a circuit whose gate geometry has never been validated on
 * site -- therefore persisted NOTHING of the drive, and a force-quit between
 * stints lost the in-flight lap the same way. The trace is the raw material
 * the circuit geometry itself can be rebuilt from, so it must reach storage
 * whether or not the timing logic ever agrees that a lap happened.
 *
 * The OBD recorder (`apps/mobile/src/persistence/telemetryRecorder.ts`) already
 * solves this with 25-sample/1-second batches tagged `lap_number = NULL` until
 * a lap exists, and these constants mirror its cadence. The GNSS telemetry
 * table cannot copy its ROW SHAPE, though: `telemetry` is keyed
 * `(sessionId, lapNumber)` with the whole lap's samples in ONE JSON payload
 * column (`persistence-sql/schema.ts`), so there is no per-row `lap_number` to
 * re-tag in place, and appending to a single growing "untagged" row would
 * re-serialize the entire session's trace every second (quadratic, on a phone,
 * while driving).
 *
 * So the untagged trace is chunked across its own reserved key space instead:
 * one row per flush, at a NEGATIVE `lapNumber` (real laps are >= 1 and the
 * learned-circuit out-lap trace already owns 0 -- see
 * `apps/mobile/src/session/composition.ts`'s adoption flow). Nothing in the app
 * reads telemetry except by a specific known lap number, so these rows are
 * invisible to every existing reader, and `deleteUserData`'s sweeps are
 * lapNumber-agnostic so they are cleaned up with the rest of a session.
 *
 * Double-writing is avoided by RECLAIM rather than by not writing: when a lap
 * does complete, its row is written from the in-memory buffer exactly as
 * before (byte-for-byte the same content as pre-P7M), and the chunks are then
 * rewritten with the samples in `tStart..tEnd` removed -- the closest this
 * schema allows to "tag the rows that were already written". Samples OUTSIDE
 * every completed lap (out-lap, cool-down, pit) deliberately stay in the
 * chunks: they belong to no lap row, and losing them is exactly the failure
 * this change exists to prevent.
 */
const TRACE_FLUSH_SAMPLE_COUNT = 25;
/**
 * Longest a captured sample may sit in memory before it is written (ms).
 * Bounds what a force-quit can cost.
 *
 * Cost of choosing durability over row count: the shipped GNSS provider runs
 * at roughly 1 Hz (`BestForNavigation`, `gnssLocationProvider.ts`), so the
 * sample-count threshold is never the one that fires -- this interval is, and
 * each flush becomes its own small row. A 30-minute stint is therefore ~1800
 * one-sample rows, and each completed lap's reclaim rewrites the ~90 of them
 * it covers. Both are small, serialized off the sample path, and the price of
 * never losing more than a second of trace; if row churn ever shows up in the
 * field, the fix is to keep the newest chunk OPEN and rewrite it in place
 * until it reaches `TRACE_FLUSH_SAMPLE_COUNT`, which cuts both figures ~25x
 * without changing durability.
 */
const TRACE_FLUSH_INTERVAL_MS = 1_000;
/**
 * Chunk keys are `-(runBase * STRIDE + sequence)`, where `runBase` is the
 * millisecond at which the run began, counted from {@link TRACE_KEY_EPOCH_MS}.
 *
 * A session id can legally be driven TWICE -- ADR-0003 §3 recovery resumes the
 * SAME id in a new process -- and a plain `-1, -2, -3...` sequence would then
 * overwrite the pre-crash trace, the very data the resume exists to protect.
 * Banding by start instant makes two runs' keys disjoint with no read-back
 * probe, which the repository API could not answer anyway: `loadTelemetry`
 * returns `[]` for both "no row" and "row emptied by reclaim", so a free key
 * is not findable through the contract. Millisecond resolution (rather than
 * whole seconds) so an immediate crash-and-relaunch still lands in its own
 * band.
 *
 * Sizing: the epoch keeps `runBase` near 2.1e11, so `runBase * 10_000` stays
 * an order of magnitude inside `Number.MAX_SAFE_INTEGER` (9.0e15) for decades,
 * and the stride allows 10k chunks per run -- over an hour even at the fastest
 * flush cadence this writer can reach.
 */
const TRACE_CHUNK_KEY_STRIDE = 10_000;
/** 2020-01-01T00:00:00Z. Only the ORIGIN of the key band; nothing reads a date back out of a key. */
const TRACE_KEY_EPOCH_MS = Date.UTC(2020, 0, 1);

/**
 * Ticket P7M M2: how long the car must fail to match the circuit before the
 * driving screen is allowed to call it off-track. Three seconds is ~125 m at
 * 150 km/h -- far beyond a dropped fix or a moment's jitter, and short enough
 * that a driver who has just discovered the gate geometry is wrong learns it
 * on the out-lap rather than at the end of the day.
 */
const OFF_TRACK_HOLD_MS = 3_000;

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
  /**
   * Ticket P5c-FIX1 E2: where a refused cue update is reported. Defaults to
   * `console.warn` in the app; tests inject their own. A refusal is never
   * silent -- a suggestion engine that computed one wrongly has to be
   * observable, not just ineffective.
   */
  logger?: (message: string) => void;
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
  /** Ticket P7M M2 -- see {@link FacadeStateCore.trackMatch}. */
  private trackMatchState: TrackMatchState = 'unknown';
  private latestLateralM: number | null = null;
  private latestMatchConfidence: number | null = null;
  /** `deps.clock.now()` of the first sample in the current unbroken run of unmatched fixes; `null` while matched. */
  private offTrackSinceMono: number | null = null;
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
  /** Ticket P7R E2: see {@link FacadeStateCore.matchingUnvalidated}. Set ONLY by `proceedWithoutValidatedCalibration()`, and only on its rejected branch; cleared by every path that starts or restores a run. */
  private matchingUnvalidated = false;
  private lastLapMs: number | null = null;
  private pbMs: number | null = null;
  private currentReference: ReferenceLap | null = null;
  private rawSamples: LocationSample[] = [];
  /** Ticket P7M M1: samples captured since the last flush. Never more than one flush interval's worth. */
  private pendingTrace: LocationSample[] = [];
  /** Metadata for the chunk rows this run has written -- enough to decide which of them a completed lap has claimed, WITHOUT holding the trace itself in memory. */
  private traceChunks: Array<{ key: number; tMin: number; tMax: number; count: number }> = [];
  /** Whole-second wall clock at which the current run began; the high half of every chunk key (see {@link TRACE_CHUNK_KEY_STRIDE}). */
  private traceRunBase = 0;
  private traceSequence = 0;
  private traceSampleCount = 0;
  private lastTraceFlushMono: number | null = null;
  /**
   * Serializes ALL raw-trace storage work -- appends and reclaims alike -- in
   * issue order. Reclaim reads a chunk back before rewriting it, so it must
   * never interleave with the write that created it, and a chunk appended
   * while a reclaim is mid-flight must land after it.
   */
  private tracePersistenceTail: Promise<void> = Promise.resolve();
  /** Raw-trace writes that failed this run. Counted, logged, never thrown -- see `noteTraceFailure`. */
  private traceWriteFailures = 0;
  /**
   * Ticket P7M M6 -- see {@link FacadeStateCore.recording}. Advanced ONLY
   * from a resolved `saveTelemetry`, and only by samples that write actually
   * put on disk for the first time: a chunk flush counts its batch, and a lap
   * row counts only the samples that were still unflushed when the lap
   * completed (everything else in the lap's range was already counted when
   * its chunk was written, and reclaim re-keys those rows rather than
   * re-storing them).
   */
  private persistedSampleCount = 0;
  /** Phase 3 coaching addendum. `null` whenever coaching is disabled (`deps.coaching` unset/`enabled: false`) or the supplied corner set is empty -- every coaching code path below is a no-op in that case. */
  private readonly coachEngine: CoachEngine | null;
  private readonly coachCorners: Corner[];
  private currentCue: CoachCue | null = null;
  private coachCueSetAtMono: number | null = null;
  private coachZoneRefreshes = 0;
  /**
   * Ticket P5c-B D2: per corner, the cue's own brake point as metres BEFORE
   * the corner entry, once it has been moved on demonstrated evidence. Held
   * separately from the derived zones so a mid-session zone refresh (a new PB
   * landing, `refreshCoachZones`) re-derives everything else and then re-applies
   * the driver's own move on top, instead of silently rolling it back.
   * A corner present here has already used its ONE change for this stint.
   */
  private readonly cueOverridesByCorner = new Map<number, number>();
  /**
   * Ticket P5c-FIX1 E10: corners that have used their ONE change in the
   * CURRENT stint. Held apart from `cueOverridesByCorner` (the positions,
   * which stay where the driver's own evidence put them for the rest of the
   * outing) so a pit exit re-arms the allowance without rolling a cue back.
   */
  private stintChangedCorners = new Set<number>();
  /** Ticket P5c-FIX1 E1: minted on every session start / checkpoint restore. */
  private cueGeneration = 0;
  /** Ticket P5c-FIX1 E10: advanced at every pit exit. */
  private stintIndex = 0;
  /** Latched pit state, so leaving the pit lane is observed exactly once. */
  private inPitLatched = false;
  private appliedCueUpdatesLog: AppliedCueUpdate[] = [];
  /** Why the LAST `applyCueUpdates` call refused what it refused (E2). */
  private lastCueRejections: CueUpdateRejection[] = [];
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
  /**
   * P4h-FIX1 M2 (binding, after Codex P4h-REV1 MEDIUM): true for exactly the
   * window in which `start('calibration')` is awaiting its asynchronous
   * startup (reference-lap I/O, above all `locationProvider.start()`), during
   * which this controller still reports `idle`. `rejectCalibration()` -- the
   * UI's Cancel, which the driver can reach the instant the app navigates to
   * ActiveCalibration -- is a no-op in `idle`, so a cancel landing in this
   * window used to be swallowed and the start then completed into an
   * INVISIBLE calibrating session (watchdog running, provider subscribed,
   * session id minted) that nothing on screen owned.
   */
  private calibrationStartInFlight = false;
  /** Set by `rejectCalibration()` while {@link calibrationStartInFlight}; consumed by `start()` at its next `disposed` re-check, which then unwinds exactly like the disposal abort. */
  private calibrationStartCancelled = false;

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
    // Ticket P7M M1: the raw-trace chain is awaited here so a caller that has
    // flushed knows the trace is on disk too. It is deliberately NOT part of
    // `pendingWork`: its writes are already serialized on their own chain, so
    // awaiting the tail covers every earlier one, and a per-flush entry in
    // `pendingWork` would grow an array once a second for the whole session.
    // It also never rejects -- see `noteTraceFailure`.
    await this.tracePersistenceTail;
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
      coachCueUpdates: [...this.appliedCueUpdatesLog],
      trackMatch: {
        state: this.trackMatchState,
        lateralM: this.latestLateralM,
        confidence: this.latestMatchConfidence,
      },
      recording: {
        persistedSampleCount: this.persistedSampleCount,
        failedWriteCount: this.traceWriteFailures,
      },
      matchingUnvalidated: this.matchingUnvalidated,
    };
  }

  /**
   * Ticket P7M M2. "On the circuit" is deliberately NOT just
   * `match !== null`: `TrackMatcher` still returns a match for a fix well
   * outside the corridor (it only raises its own internal `lost` flag after
   * `offCorridorLimit` of them), carrying a large `lateralM` and a confidence
   * driven to zero -- which is precisely the misplaced-centerline case this
   * state exists to make visible. A pit-lane match is on-track by definition:
   * the pit lane is part of the mapped circuit and its offset from the racing
   * centerline is expected.
   */
  private updateTrackMatch(match: TrackMatch | null): void {
    const now = this.deps.clock.now();
    this.latestLateralM = match === null ? null : Math.abs(match.lateralM);
    this.latestMatchConfidence = match?.confidence ?? null;
    const onTrack =
      match !== null &&
      (match.onPitLane || Math.abs(match.lateralM) <= this.deps.circuitProfile.corridorWidthM);
    if (onTrack) {
      this.offTrackSinceMono = null;
      this.trackMatchState = 'matched';
      return;
    }
    this.offTrackSinceMono ??= now;
    if (now - this.offTrackSinceMono >= OFF_TRACK_HOLD_MS) this.trackMatchState = 'offTrack';
  }

  /** Back to "nothing known" -- a session that is not running makes no claim about where the car is. */
  private resetTrackMatch(): void {
    this.trackMatchState = 'unknown';
    this.latestLateralM = null;
    this.latestMatchConfidence = null;
    this.offTrackSinceMono = null;
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
      rawTraceChunkCount: this.traceChunks.length,
      rawTraceSampleCount: this.traceSampleCount,
      rawTracePendingCount: this.pendingTrace.length,
      rawTraceWriteFailures: this.traceWriteFailures,
      persistedSampleCount: this.persistedSampleCount,
      coachZoneRefreshes: this.coachZoneRefreshes,
    };
  }

  /**
   * Ticket P7M M1: the `lapNumber` keys this run's unclaimed raw-trace chunks
   * are stored under, oldest first -- read them back with
   * `repository.loadTelemetry(sessionId, key)` and concatenate to recover the
   * drive that no lap row claimed. In-process only (the keys are not
   * persisted); a trace left behind by a previous launch is recovered by
   * reading every negative `lapNumber` the `telemetry` table holds for that
   * session id.
   */
  rawTraceChunkKeys(): number[] {
    return this.traceChunks.map((chunk) => chunk.key);
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
    // CN-FIX4 (contracts.md's "Multi-circuit selection — facade boundary
    // amendment", binding): `disposed` is re-checked after EVERY await
    // below. A start is not instantaneous -- it awaits reference-lap I/O
    // and, above all, `locationProvider.start()` -- and the controller
    // still reports `idle` for that whole window, so an app-side lifecycle
    // operation (circuit change, coaching rebuild, delete-all) can legally
    // `dispose()` it mid-start. Before this guard the awaited start then
    // resumed and installed a sample subscription on the SHARED provider
    // that `dispose()` had just detached from, moved a disposed controller
    // into calibration, started its watchdog, and persisted a session
    // pointer for a session nothing was driving. Each check below aborts
    // cleanly: no subscription, no session, no persistence.
    if (this.disposed) return;
    const assignedSessionIdHere = this.sessionId === null;
    if (assignedSessionIdHere) {
      this.sessionId = `${this.deps.userId}--${randomToken()}`;
      this.sessionStartedAtUtc = new Date().toISOString();
      // Ticket P5c-B D2: "one change per corner per stint" is scoped to the
      // outing, so a brand-new session starts from the derived cues again --
      // never carrying another outing's moves into this one.
      this.cueOverridesByCorner.clear();
      this.stintChangedCorners = new Set();
      this.appliedCueUpdatesLog = [];
      // P5c-FIX1 E1: a new outing is a new generation, so an analysis pass
      // still in flight from the previous one can never apply to this one.
      this.cueGeneration += 1;
      this.stintIndex = 0;
      this.inPitLatched = false;
    }
    // Ticket P7M M1: a fresh run of the raw-trace writer. Called for the
    // recovery path too (`phase === 'session'`, same session id as a previous
    // launch), where the run band is what keeps this run's chunks from
    // overwriting the pre-crash ones.
    this.beginTraceRun();
    // Ticket P7M M2: a starting session knows nothing yet about where the car is.
    this.resetTrackMatch();

    /** Undoes the session identity THIS call minted, so an aborted start leaves nothing for `checkpointNow()`/`endSession()` to persist later. A session id restored from a checkpoint (recovery) is never touched. */
    const abortStart = (): void => {
      if (assignedSessionIdHere) {
        this.sessionId = null;
        this.sessionStartedAtUtc = null;
      }
    };

    // P4h-FIX1 M2 (binding): opens the cancellable window -- see
    // `calibrationStartInFlight`'s own doc comment. `cancelledMidStart()`
    // below is checked at EXACTLY the same points as `disposed` (after every
    // await) and unwinds identically: no dispatch, no mode change, no
    // watchdog, no session identity left behind. Like the disposal abort it
    // deliberately does NOT stop the (possibly shared) location provider --
    // ownership is not knowable in core (contracts.md's closing amendment).
    this.calibrationStartInFlight = true;
    this.calibrationStartCancelled = false;
    /** True once a `rejectCalibration()` landed during this start; consumes the flag so the cancel applies to THIS start only. */
    const cancelledMidStart = (): boolean => {
      if (!this.calibrationStartCancelled) return false;
      this.calibrationStartCancelled = false;
      this.calibrationStartInFlight = false;
      abortStart();
      return true;
    };

    if (phase === 'session') {
      // Pure repository I/O -- doesn't touch `core.state`/`mode`, so its
      // position relative to `ensureProviderRunning()` below is immaterial;
      // done here so `this.currentReference`/`this.pbMs` are ready by the
      // time the CALIBRATION_ACCEPTED dispatch below runs.
      await this.loadReferenceForSession();
      if (this.disposed) {
        this.calibrationStartInFlight = false;
        abortStart();
        return;
      }
      if (cancelledMidStart()) return;
    }

    await this.ensureProviderRunning();
    if (cancelledMidStart()) {
      // The driver cancelled while the provider was starting. Detach the
      // subscription `ensureProviderRunning()` just installed (it is THIS
      // controller's own -- nothing else could have replaced it in the same
      // microtask) so no sample can reach a calibration that was never
      // entered, and leave the provider itself alone.
      if (this.providerUnsubscribe !== null) {
        this.providerUnsubscribe();
        this.providerUnsubscribe = null;
      }
      this.providerRunning = false;
      return;
    }
    if (this.disposed) {
      this.calibrationStartInFlight = false;
      // `ensureProviderRunning()` itself already declined to subscribe (see
      // its own disposed guard) and deliberately leaves the shared provider
      // running (ownership is not knowable here), so there is nothing to
      // unwind beyond the session identity.
      abortStart();
      return;
    }

    // P4h-FIX1 M2: past this point the start is committed -- every remaining
    // step below is synchronous, so no cancel can land "mid-start" any more;
    // a `rejectCalibration()` after this takes the ordinary
    // `calibrating -> calibrationReview -> awaitingCalibration` path.
    this.calibrationStartInFlight = false;

    this.core.dispatch({ type: 'START_PREFLIGHT' });
    this.core.dispatch({ type: 'PREFLIGHT_PASSED' });

    if (phase === 'calibration') {
      this.calibrationEngine = new CalibrationEngine(this.deps.runtimeProfile, {
        corridorWidthM: this.deps.circuitProfile.corridorWidthM,
        ...this.deps.config?.calibration,
      });
      this.calibrationResult = null;
      // Ticket P7R E2: a fresh Learn lap is a fresh claim about the matching.
      this.matchingUnvalidated = false;
      this.calibrationSnapshot = { coverageFraction: 0, onTrack: true };
      this.core.dispatch({ type: 'CALIBRATION_STARTED' });
      this.mode = 'calibrating';
    } else {
      this.core.dispatch({ type: 'CALIBRATION_STARTED' });
      this.core.dispatch({ type: 'CALIBRATION_FINISHED', result: recoverySkippedCalibrationResult() });
      this.core.dispatch({ type: 'CALIBRATION_ACCEPTED' });
      this.calibrationResult = null;
      this.matchingUnvalidated = false;
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

  /**
   * Ticket P7R E2 (binding) -- THE CALIBRATION GATE IS NOT A DEAD END.
   *
   * The owner has already lost a whole track day here: at Transilvania Motor
   * Ring coverage parked at ~0.83, retry, ~0.83 again, no session ever
   * started, nothing recorded. A quality gate may refuse to VOUCH for data.
   * It must never refuse to let the data be COLLECTED, and any threshold can
   * fail on geometry nobody has validated on site.
   *
   * THE WALL IS NOT WHERE IT LOOKS. A Learn lap only reaches
   * `calibrationReview` once coverage passes
   * {@link CALIBRATION_COMPLETE_COVERAGE_FRACTION} (0.98) -- so a lap stuck
   * below the 0.85 ACCEPTANCE bar never produces a result at all. It does not
   * fail; it simply never finishes, and the only control the driver has left
   * is Cancel. That is the failure that cost the day, and it is why this
   * method covers BOTH states rather than only the review screen:
   *
   *  - `calibrating`: the Learn lap is force-finished HERE AND NOW, through
   *    the engine's own `finish()`. The verdict is the engine's, computed
   *    from what was actually driven -- no threshold is lowered, skipped or
   *    second-guessed.
   *  - `calibrationReview`: the verdict already exists; it is used as it
   *    stands.
   *
   * Then, honestly, one of two things happens:
   *
   *  - the engine ACCEPTED what it was given (possible when a driver
   *    force-finishes a lap that was in fact good enough) -- this is an
   *    ordinary accepted calibration and is NOT labelled as anything else;
   *  - the engine rejected it -- the session is still armed, and
   *    {@link FacadeStateCore.matchingUnvalidated} goes `true` and stays true
   *    for the rest of the run, so the host can say so on screen and record
   *    it against the stored session.
   *
   * `'refused'` -- and nothing mutated at all -- when there is no calibration
   * to conclude: not in either state, or in `calibrating` with no engine.
   */
  proceedWithoutValidatedCalibration(): 'armed-accepted' | 'armed-unvalidated' | 'refused' {
    if (this.core.state.state === 'calibrating') {
      if (this.calibrationEngine === null) return 'refused';
      // The engine's own verdict on the partial lap -- the same call the
      // 0.98 completion trigger makes, at a moment the driver chose.
      this.finishCalibrationNow();
    }
    if (this.core.state.state !== 'calibrationReview') return 'refused';
    const result = this.calibrationResult;
    if (result === null) return 'refused';
    if (result.accepted) {
      this.acceptCalibration();
      return 'armed-accepted';
    }
    this.matchingUnvalidated = true;
    this.core.dispatch({ type: 'CALIBRATION_ACCEPTED' });
    this.calibrationSnapshot = null;
    this.calibrationEngine = null;
    this.trackAsync(this.loadReferenceForSession().then(() => this.emit()));
    this.emit();
    return 'armed-unvalidated';
  }

  rejectCalibration(): void {
    // P4h-FIX1 M2 (binding, after Codex P4h-REV1 MEDIUM): a Cancel that lands
    // while `start('calibration')` is still awaiting GNSS startup -- the
    // controller reports `idle` for that whole window, so every branch below
    // would be a no-op and the start would later complete into an invisible
    // calibrating session. Recorded here; `start()` consumes it at its next
    // await checkpoint and unwinds itself (no dispatch, no watchdog, no
    // subscription, ends idle).
    if (this.calibrationStartInFlight) {
      this.calibrationStartCancelled = true;
      return;
    }
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
    this.matchingUnvalidated = false;
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
    // Ticket P7M M1: unconditional, and BEFORE the flush barrier -- a session
    // that completed no lap at all still leaves its whole drive on disk, and
    // a session that did completes with nothing of the cool-down lap pending.
    await this.flushRawTrace();
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
    // Ticket P7M M2: an ended session makes no claim about the car's position.
    this.resetTrackMatch();
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
    // Ticket P7R E2: a restored run makes no claim about the calibration of
    // the run before it -- the host owns the DURABLE record of which stored
    // sessions were run on unvalidated matching.
    this.matchingUnvalidated = false;
    this.paused = false;
    this.resetTrackMatch();
    // Ticket P7M M1: a restore is a new run of the trace writer. Its own
    // key band keeps whatever the previous launch wrote for this SAME session
    // id intact (see `TRACE_CHUNK_KEY_STRIDE`).
    this.beginTraceRun();
    // A restored checkpoint carries no live coaching state to resume (the
    // engine's per-lap rearm bookkeeping is meaningless across a process
    // restart) -- clear the displayed cue and rearm the engine itself so a
    // stale cue from the prior process can never resurface.
    this.currentCue = null;
    this.coachCueSetAtMono = null;
    this.coachEngine?.reset();
    // P5c-FIX1 E1/E7: a restore is a new cue generation (an analysis pass from
    // before it can never apply afterwards) and re-arms the stint allowance --
    // the recovered outing starts from the cues its own derivation produces.
    this.cueGeneration += 1;
    this.stintIndex = 0;
    this.inPitLatched = false;
    this.cueOverridesByCorner.clear();
    this.stintChangedCorners = new Set();
    this.appliedCueUpdatesLog = [];

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
      // CN-FIX4 (facade boundary amendment) + CN-FIX5 item 2 (closing
      // amendment), both binding: disposed WHILE the provider was starting.
      // Return without installing a subscription -- a disposed controller
      // must never receive another sample -- and deliberately WITHOUT
      // stopping the provider. `locationProvider` may be SHARED (mobile's
      // composition hands one `GnssLocationProvider` to every successive
      // production controller), its start/stop calls are serialized, and by
      // the time this continuation runs a replacement controller may already
      // have started it and be depending on the native watcher. Ownership is
      // not knowable from inside core, so the only safe action is to take
      // none: whichever controller legitimately owns the provider stops it
      // when its own session ends (`endSession()`) or when it is disposed
      // while genuinely running (`dispose()`'s `providerRunning` branch).
      if (this.disposed) return;
      // P4h-FIX1 M2 (binding): the SAME rule for a Cancel that landed while
      // the provider was starting -- do not subscribe at all (the start that
      // awaited this is about to unwind), and, exactly like the disposal
      // guard above, do not stop the possibly-shared provider.
      if (this.calibrationStartCancelled) return;
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

    // Ticket P7M M1: capture happens HERE -- above the mode branches -- not
    // inside the `live` branch with `rawSamples`. A Learn lap that never
    // reaches its coverage threshold (the first symptom of geometry that is
    // wrong on site) leaves `mode === 'calibrating'` forever and used to
    // discard every fix it was fed; that trace is precisely what the geometry
    // would be rebuilt from. Paused is still excluded: the car is stationary
    // and the driver has said so.
    this.recordRawTrace(sample);

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
    this.updateTrackMatch(result.match);
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
      // H13 fix (Codex P5c-REV2 finding 13, HIGH -- the same gap ticket
      // P5c-FIX1 E10 accepted at LOW severity, Codex P5c-REV1 finding 10, is
      // now closed here rather than carried as a residual). The STINT
      // boundary -- the one-change-per-corner allowance re-arming -- must
      // react ONLY to the pipeline's hysteresis-debounced `inPit` SESSION
      // STATE: a confirmed pit-entry-then-exit sequence, gated behind a real
      // gate crossing plus >=2 consecutive on-pit-lane matches
      // (`pipelineCore.ts`'s `pitEvidenceSamples`). The raw per-match
      // `onPitLane` flag the cue-suppression branch below still ORs in is a
      // single-sample GEOMETRIC proximity test with NO debounce at all
      // (`track-matcher.ts`'s `isOnPitLane` -- true whenever the fix sits
      // closer to the pit-lane polyline than to the centerline, which a
      // pit lane running alongside a straight makes a perfectly ordinary
      // wide line, or a moment's GPS jitter, produce). Trusting that flag for
      // the LATCH (as the pre-FIX2 code did, via the same `inPit` OR) let one
      // noisy sample latch and the very next un-latch, calling `beginStint()`
      // and re-arming the allowance with no real pit stop at all.
      const confirmedInPit = this.core.state.state === 'inPit';
      // Display suppression stays the conservative OR: showing no
      // racing-line advice the instant a raw pit-proximity signal fires,
      // even before it is confirmed, is always the SAFE direction to err --
      // unlike re-arming the allowance, which must never happen on
      // unconfirmed evidence.
      const inPit = confirmedInPit || (result.match?.onPitLane ?? false);
      if (confirmedInPit) {
        this.inPitLatched = true;
      } else if (this.inPitLatched) {
        this.inPitLatched = false;
        this.beginStint();
      }
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

  // -------------------------------------------------------------------
  // Raw-trace persistence (ticket P7M M1)
  // -------------------------------------------------------------------

  /** Starts a fresh run of the chunk writer -- see {@link TRACE_CHUNK_KEY_STRIDE} for why the band is taken from the wall clock, and `Math.max` for why two runs inside the same millisecond still get their own bands (in-process; across processes the millisecond itself separates them). */
  private beginTraceRun(): void {
    this.pendingTrace = [];
    this.traceChunks = [];
    this.traceSequence = 0;
    this.traceSampleCount = 0;
    this.traceWriteFailures = 0;
    this.persistedSampleCount = 0;
    this.lastTraceFlushMono = null;
    this.traceRunBase = Math.max(Date.now() - TRACE_KEY_EPOCH_MS, this.traceRunBase + 1);
  }

  private recordRawTrace(sample: LocationSample): void {
    if (this.sessionId === null) return;
    this.pendingTrace.push(sample);
    const now = this.deps.clock.now();
    if (this.lastTraceFlushMono === null) this.lastTraceFlushMono = now;
    if (
      this.pendingTrace.length >= TRACE_FLUSH_SAMPLE_COUNT ||
      now - this.lastTraceFlushMono >= TRACE_FLUSH_INTERVAL_MS
    ) {
      // Never rejects (see `noteTraceFailure`) and is awaited via
      // `tracePersistenceTail` in `flush()`, so there is nothing to track and
      // no unhandled rejection to leak out of the sample callback.
      void this.flushRawTrace();
    }
  }

  /**
   * Writes everything captured since the last flush as one chunk row.
   * Public so a host can force it at a moment the controller cannot see --
   * the app's OS-background transition, above all (`checkpointNow()` calls it
   * for exactly that reason). A no-op with nothing pending.
   */
  flushRawTrace(): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId === null || this.pendingTrace.length === 0) return this.tracePersistenceTail;
    const batch = this.pendingTrace;
    this.pendingTrace = [];
    this.lastTraceFlushMono = this.deps.clock.now();
    this.traceSequence += 1;
    const key = -(this.traceRunBase * TRACE_CHUNK_KEY_STRIDE + this.traceSequence);
    let tMin = batch[0]!.tMono;
    let tMax = tMin;
    for (const sample of batch) {
      if (sample.tMono < tMin) tMin = sample.tMono;
      if (sample.tMono > tMax) tMax = sample.tMono;
    }
    // Metadata is recorded SYNCHRONOUSLY (before the write resolves) so a lap
    // completing in the same tick already knows this chunk exists and can
    // reclaim from it.
    this.traceChunks.push({ key, tMin, tMax, count: batch.length });
    this.traceSampleCount += batch.length;
    const write = this.tracePersistenceTail
      .then(async () => {
        await this.deps.repository.saveTelemetry(sessionId, key, batch);
        // P7M M6: counted HERE, after the write resolved -- a failing write
        // must freeze the driver's indicator, never advance it.
        //
        // Deliberately does NOT `emit()`. The counter is read from
        // `snapshotState()`, so it is already current in the next emission
        // the ordinary sample path makes -- at the ~1 Hz the fixes
        // themselves arrive, which is the cadence the number is counting.
        // Emitting per write instead would add a second, unrelated stream of
        // state notifications to every subscriber for a value that changes
        // nothing else on screen.
        this.persistedSampleCount += batch.length;
      })
      .catch((error: unknown) => this.noteTraceFailure('flush', error));
    this.tracePersistenceTail = write;
    return write;
  }

  /**
   * A failed trace write is counted and reported, never thrown. The trace is
   * best-effort insurance against losing the day; making it able to reject
   * `endSession()` would let it take down the session summary and PB write it
   * exists to back up, which is precisely the wrong trade.
   */
  private noteTraceFailure(stage: 'flush' | 'reclaim', error: unknown): void {
    this.traceWriteFailures += 1;
    const detail = error instanceof Error ? error.message : String(error);
    const message = `[sessionController] raw-trace ${stage} failed: ${detail}`;
    if (this.deps.logger === undefined) console.warn(message);
    else this.deps.logger(message);
  }

  /**
   * Removes `tStart..tEnd` from the unclaimed chunks after the lap row for
   * that range has been written -- the "tag the rows that already exist"
   * half of M1, as close as a one-payload-per-lap schema gets to it. Ordered
   * strictly AFTER the lap row's own write by its caller, so there is never
   * an instant at which those samples are in neither place.
   */
  private reclaimTraceRange(sessionId: string, tStart: number, tEnd: number): Promise<void> {
    const work = this.tracePersistenceTail.then(async () => {
      const affected = this.traceChunks.filter(
        (chunk) => chunk.count > 0 && chunk.tMax >= tStart && chunk.tMin <= tEnd,
      );
      for (const chunk of affected) {
        if (chunk.tMin >= tStart && chunk.tMax <= tEnd) {
          // Wholly inside the lap: the lap row now owns every sample in it.
          // Emptied rather than deleted -- the repository contract has no
          // telemetry delete, and an empty payload reads back as `[]`, which
          // is what "no unclaimed samples here" means to every reader.
          await this.deps.repository.saveTelemetry(sessionId, chunk.key, []);
          this.traceSampleCount -= chunk.count;
          chunk.count = 0;
          continue;
        }
        const stored = await this.deps.repository.loadTelemetry(sessionId, chunk.key);
        const kept = stored.filter((sample) => sample.tMono < tStart || sample.tMono > tEnd);
        if (kept.length === stored.length) continue;
        await this.deps.repository.saveTelemetry(sessionId, chunk.key, kept);
        this.traceSampleCount -= chunk.count - kept.length;
        chunk.count = kept.length;
        if (kept.length > 0) {
          chunk.tMin = kept.reduce((min, s) => (s.tMono < min ? s.tMono : min), kept[0]!.tMono);
          chunk.tMax = kept.reduce((max, s) => (s.tMono > max ? s.tMono : max), kept[0]!.tMono);
        }
      }
      this.traceChunks = this.traceChunks.filter((chunk) => chunk.count > 0);
    })
      .catch((error: unknown) => this.noteTraceFailure('reclaim', error));
    this.tracePersistenceTail = work;
    return work;
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
    // Ticket P7M M1: the same samples must not ALSO stay queued for the
    // unclaimed trace. Done synchronously, here, so nothing still in memory
    // can be flushed into a chunk after `reclaimTraceRange` below has already
    // swept the rows. Samples OUTSIDE the lap stay pending on purpose -- they
    // are in no lap row.
    const keptPending = this.pendingTrace.filter(
      (sample) => sample.tMono < lap.tStart || sample.tMono > lap.tEnd,
    );
    // Ticket P7M M6: these are the lap's samples that no chunk write had
    // reached yet, so the lap row below is the FIRST time they are stored --
    // the only part of that row the persisted counter has not already counted.
    const firstStoredByLapRow = this.pendingTrace.length - keptPending.length;
    this.pendingTrace = keptPending;
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
      this.persistedSampleCount += firstStoredByLapRow;
      // Ticket P7M M1: only now that the lap row is durable are the same
      // samples dropped from the unclaimed chunks.
      await this.reclaimTraceRange(sessionId, lap.tStart, lap.tEnd);
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
    this.coachEngine.configure(this.coachCorners, this.withCueOverrides(zones), options);
  }

  /**
   * Ticket P5c-B D2: re-applies the driver's own demonstrated cue moves on top
   * of freshly derived zones. Nothing here invents a point -- an override is
   * only ever a value `applyCueUpdates()` already validated against the
   * demonstrated envelope and the safety bounds.
   */
  private withCueOverrides(zones: readonly BrakingZone[]): BrakingZone[] {
    if (this.cueOverridesByCorner.size === 0) return [...zones];
    const totalLengthM = this.deps.circuitProfile.totalLengthM;
    return zones.map((zone) => {
      const overrideM = this.cueOverridesByCorner.get(zone.cornerId);
      const corner = this.coachCorners.find((entry) => entry.id === zone.cornerId);
      if (overrideM === undefined || corner === undefined) return zone;
      return {
        ...zone,
        brakeStartDistanceM: modulo(corner.entryDistanceM - overrideM, totalLengthM),
        brakeCueAvailable: overrideM > 0,
      };
    });
  }

  /**
   * The live coaching cue set, as metres BEFORE each corner's entry, ascending
   * by corner id (ticket P5c-B D2). Empty whenever coaching is disabled. The
   * `lift` slot is always `null`: the shipped cue engine has one cue point per
   * corner (`CoachCue.kind` is `BRAKE` / `CORNER_AHEAD`), and the spoken
   * "Lift." callout is that SAME point rendered differently by
   * `voiceCoach.ts` -- so moving the brake point moves both callouts, with no
   * new text and no new cue kind.
   */
  activeCues(): ActiveCue[] {
    if (this.coachEngine === null) return [];
    const totalLengthM = this.deps.circuitProfile.totalLengthM;
    const zones = this.withCueOverrides(
      deriveBrakingZones(this.currentReference, this.coachCorners, { totalLengthM }),
    );
    return [...this.coachCorners]
      .sort((left, right) => left.id - right.id)
      .map((corner) => {
        const zone = zones.find((entry) => entry.cornerId === corner.id);
        const usable = zone !== undefined && zone.brakeCueAvailable !== false;
        const brakeStartM = usable
          ? forwardDistance(zone.brakeStartDistanceM, corner.entryDistanceM, totalLengthM)
          : 0;
        return {
          cornerId: corner.id,
          brakeStartM: usable && brakeStartM > 0 ? brakeStartM : null,
          liftPointM: null,
        };
      });
  }

  /**
   * The identity an analysis pass must bind itself to and present again at
   * apply time (ticket P5c-FIX1 E1). Read before the pass starts and again
   * when it finishes: any difference means the pass is talking about an outing,
   * a controller or a stint that is no longer the live one.
   */
  cueContext(): CueUpdateContext {
    return {
      sessionId: this.sessionId,
      generation: this.cueGeneration,
      stintIndex: this.stintIndex,
      completedLapCount: this.core.laps.length,
    };
  }

  /**
   * Starts the next stint (ticket P5c-FIX1 E10). Called by the pit-exit
   * detector in `handleSample`; public so a host that knows about a stint the
   * geometry cannot see (a session paused in the paddock, say) can say so.
   * Re-arms the one-change-per-corner allowance and does NOT move any cue:
   * a point the driver's own laps demonstrated stays where it was put.
   */
  beginStint(): void {
    this.stintIndex += 1;
    this.stintChangedCorners = new Set();
  }

  /**
   * Ticket P5c-FIX1 E5 (Codex P5c-REV1 finding 5): resolves once every
   * completed lap's telemetry/checkpoint write queued so far has settled. The
   * lap event reaches the app BEFORE its trace is on disk, so an analysis pass
   * triggered by that event must await this barrier or it reads a lap with no
   * trace. Rejections are absorbed -- a failed write is not this barrier's to
   * report (`flush()` still surfaces it); the caller only needs to know the
   * queue has drained.
   */
  async awaitLapPersistence(): Promise<void> {
    await this.lapPersistenceTail.catch(() => undefined);
  }

  /** The demonstrated bound this corner's spoken cue must be validated against. */
  private evidenceFor(
    evidence: CueUpdateEvidence,
    cornerId: number,
    point: CuePoint,
  ): CueEvidenceEntry | null {
    return (
      evidence.entries.find((entry) => entry.cornerId === cornerId && entry.point === point) ?? null
    );
  }

  /**
   * Applies bounded cue updates produced by `coaching/suggestions.ts`
   * (contracts.md R2-3a). This is the LAST line of defence, not a pass-through,
   * and after ticket P5c-FIX1 E2 it trusts NOTHING the update says about
   * itself: the cue it is moving is read from this controller, the bound it may
   * move to is recomputed from `request.evidence`, and the update's own
   * `fromM`/`demonstratedM` only have to AGREE with those. An update is refused
   * when
   *
   *  - coaching is off, or the corner is not in this session's coaching set;
   *  - `request.context` is not this controller's live session / generation /
   *    stint (E1: the pass outlived what it was computed for);
   *  - `request.evidence` does not hash to its own checksum, or was sealed for
   *    another context;
   *  - it targets anything but the live brake cue point;
   *  - the corner already used its ONE change this stint;
   *  - the cue has MOVED underneath the pass (`fromM` no longer matches the
   *    controller's own cue within {@link CUE_POSITION_TOLERANCE_M});
   *  - the pass carried no evidence for the point this corner is actually
   *    SPOKEN as -- "Lift." for severity 1-4 (E3) -- or the update's cited
   *    evidence disagrees with the sealed evidence;
   *  - the step exceeds `MAX_BRAKE_LATER_M`, is not strictly later, or is not
   *    finite;
   *  - the target is PAST the demonstrated value the EVIDENCE proves.
   *
   * Returns exactly the updates that were applied, in ascending corner order,
   * each carrying the value the controller itself clamped it to.
   */
  applyCueUpdates(updates: readonly CueUpdate[], request: CueUpdateRequest): AppliedCueUpdate[] {
    this.lastCueRejections = [];
    const reject = (reason: CueUpdateRejection): void => {
      this.lastCueRejections.push(reason);
      this.deps.logger?.(`[sessionController] cue update refused: ${reason}`);
    };
    if (this.coachEngine === null) {
      if (updates.length > 0) reject('coaching-disabled');
      return [];
    }
    if (updates.length === 0) return [];
    const live = this.cueContext();
    const { context, evidence } = request;
    if (
      live.sessionId === null ||
      context.sessionId !== live.sessionId ||
      context.generation !== live.generation ||
      context.stintIndex !== live.stintIndex
    ) {
      reject('context-mismatch');
      return [];
    }
    if (!verifyCueEvidence(evidence)) {
      reject('evidence-unsealed');
      return [];
    }
    if (
      evidence.sessionId !== live.sessionId ||
      evidence.generation !== live.generation ||
      evidence.stintIndex !== live.stintIndex
    ) {
      reject('evidence-context-mismatch');
      return [];
    }

    // The cue set as THIS controller has it right now -- never the caller's.
    const currentCues = new Map(this.activeCues().map((cue) => [cue.cornerId, cue]));
    const appliedAfterLapNumber = this.snapshotState().lapNumber;
    const appliedAtMono = this.deps.clock.now();
    const applied: AppliedCueUpdate[] = [];
    for (const update of [...updates].sort((left, right) => left.cornerId - right.cornerId)) {
      if (update.point !== 'brake') {
        reject('not-brake-point');
        continue;
      }
      if (this.stintChangedCorners.has(update.cornerId)) {
        reject('already-updated-this-stint');
        continue;
      }
      const corner = this.coachCorners.find((entry) => entry.id === update.cornerId);
      if (corner === undefined) {
        reject('unknown-corner');
        continue;
      }
      const currentM = currentCues.get(update.cornerId)?.brakeStartM ?? null;
      if (currentM === null || !Number.isFinite(currentM)) {
        reject('cue-moved-underneath');
        continue;
      }
      if (![update.fromM, update.toM, update.demonstratedM].every((v) => Number.isFinite(v))) {
        reject('not-finite');
        continue;
      }
      if (Math.abs(currentM - update.fromM) > CUE_POSITION_TOLERANCE_M) {
        reject('cue-moved-underneath');
        continue;
      }
      // E3: what this cue is actually SPOKEN as decides which envelope bounds
      // it. Severity 1-4 is voiced "Lift.", and a lift precedes braking.
      const spokenPoint: CuePoint = corner.severity <= VOICE_LIFT_MAX_SEVERITY ? 'lift' : 'brake';
      const entry = this.evidenceFor(evidence, update.cornerId, spokenPoint);
      if (entry === null || !Number.isFinite(entry.demonstratedM)) {
        reject('no-evidence-for-point');
        continue;
      }
      // The update may cite its own numbers, but they have to match the seal.
      if (spokenPoint === 'brake' && Math.abs(entry.demonstratedM - update.demonstratedM) > 1e-6) {
        reject('evidence-mismatch');
        continue;
      }
      // Everything below is computed from the CONTROLLER's cue and the SEALED
      // evidence; `update.toM` is only ever an upper bound on how far it moves.
      //
      // Asking for MORE than the step bound is a malformed update -- something
      // computed it against numbers this controller does not recognise -- and
      // is refused outright rather than quietly trimmed. Asking for more than
      // the EVIDENCE supports is clamped back onto the evidence instead: that
      // is the case E3's lift rule produces (the pass reasoned about braking,
      // the voice says "Lift."), and the clamped move is fully backed by a
      // clean lap of this outing.
      const stepFloorM = currentM - MAX_BRAKE_LATER_M;
      if (update.toM < stepFloorM - 1e-9) {
        reject('beyond-bound');
        continue;
      }
      const floorM = Math.max(entry.demonstratedM, stepFloorM);
      const toM = Math.max(update.toM, floorM);
      if (toM >= currentM || toM <= 0) {
        reject('not-later');
        continue;
      }
      if (currentM - toM > MAX_BRAKE_LATER_M) {
        reject('beyond-bound');
        continue;
      }
      if (toM < entry.demonstratedM) {
        reject('beyond-demonstrated');
        continue;
      }
      this.cueOverridesByCorner.set(update.cornerId, toM);
      this.stintChangedCorners.add(update.cornerId);
      applied.push({
        ...update,
        fromM: currentM,
        toM,
        movedLaterM: currentM - toM,
        demonstratedM: entry.demonstratedM,
        evidenceLapNumber: entry.evidenceLapNumber,
        cleanLapCount: entry.cleanLapCount,
        appliedAtMono,
        appliedAfterLapNumber,
      });
    }
    if (applied.length === 0) return [];
    // `preserveEmitted`: a corner already driven past this lap must not become
    // a fresh candidate again purely because its cue moved (same reasoning as
    // the PB-refresh path above).
    this.refreshCoachZones(this.currentReference, { preserveEmitted: true });
    this.appliedCueUpdatesLog = [...this.appliedCueUpdatesLog, ...applied];
    this.emit();
    return applied;
  }

  /** Every cue move applied this session, oldest first (ticket P5c-B D2/D4). */
  appliedCueUpdates(): AppliedCueUpdate[] {
    return [...this.appliedCueUpdatesLog];
  }

  /**
   * Why the last {@link applyCueUpdates} call refused what it refused, in the
   * order the refusals happened (ticket P5c-FIX1 E2). Empty after a call that
   * refused nothing.
   */
  cueUpdateRejections(): CueUpdateRejection[] {
    return [...this.lastCueRejections];
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
    // Ticket P7M M1: the app-background transition is the best warning a
    // force-quit ever gives, so the trace captured since the last interval
    // flush goes out with the checkpoint rather than waiting for a tick that
    // may never come.
    await this.flushRawTrace();
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
