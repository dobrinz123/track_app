import type {
  CalibrationResult,
  CoachCue,
  DeltaUpdate,
  LapRecord,
  QualityLevel,
  SessionState,
} from '@circuit/core';

/**
 * UI-facing projection of live session state. Deliberately smaller than the
 * domain `SessionMachineSnapshot` (docs/architecture/contracts.md) — only the
 * fields a screen under src/ui/ needs to render. Never grow this by reaching
 * past the facade into `@circuit/core` timing/geometry/state-machine types
 * directly from UI code.
 */
export interface FacadeState {
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
  /**
   * Latest advisory coaching cue (Phase 3 coaching addendum), or `null` when
   * coaching is disabled (`settingsStore`'s `coachingEnabled` toggle), no
   * corner is currently in range, or the cue has gone stale/rolled over --
   * `RealSessionFacade` maps this 1:1 from `FacadeStateCore.coachCue`;
   * `MockSessionFacade` and `PendingFacade` always report `null`. UI
   * rendering of this cue is a later work package -- this ticket only plumbs
   * the data through.
   */
  coachCue: CoachCue | null;
  /**
   * Human-readable message from the most recent async command that failed
   * (C7 fix), or `null` if none has failed since the last successful command.
   * `RealSessionFacade` is the only implementation that ever sets this
   * (catching `beginCalibration`/`endSession` rejections); `MockSessionFacade`
   * and the bootstrap-time `PendingFacade` always report `null`. Screens
   * render it inline via the existing `StatusBanner` -- never a modal.
   */
  lastError: string | null;
}

/**
 * The ONLY surface `apps/mobile/src/ui/**` may consume for live-session data
 * and control. Implementations own all timing/geometry/state-machine logic;
 * screens read `FacadeState` via `subscribe` and invoke these commands —
 * nothing else. See `apps/mobile/src/session/composition.ts` for the single
 * place a concrete implementation is chosen; that is the file a later work
 * package swaps to wire the real pipeline in.
 */
export interface SessionFacade {
  /**
   * Registers a listener that receives the current state immediately and on
   * every subsequent change. Returns an unsubscribe function.
   */
  subscribe(cb: (s: FacadeState) => void): () => void;

  /** Signals the session is entering the preflight-checks phase. */
  startPreflight(): void;
  /** Starts (or restarts) the Learn calibration lap. */
  beginCalibration(): void;
  /** Confirms an accepted calibration result and arms the session. */
  acceptCalibration(): void;
  /** Rejects the current calibration attempt/result and returns to instructions. */
  rejectCalibration(): void;
  /** Confirms the session is armed and starts the drive (out-lap → timing). */
  arm(): void;
  /** Ends the active session, finalizing laps. */
  endSession(): void;
  /** Pauses live timing (e.g. session interrupted). */
  pause(): void;
  /** Resumes a paused session. */
  resume(): void;
}
