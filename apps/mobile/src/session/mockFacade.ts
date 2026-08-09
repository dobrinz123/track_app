import type {
  CalibrationResult,
  DeltaUpdate,
  LapRecord,
  QualityLevel,
  SectorTime,
} from '@circuit/core';
import type { FacadeState, SessionFacade } from './facade';

const TICK_MS = 200;
const CALIBRATION_DURATION_MS = 6_000;
const ARMED_DURATION_MS = 1_500;
const OUT_LAP_DURATION_MS = 2_500;
const INITIAL_PB_MS = 20_120;

/** One scripted lap's shape: target duration and a plausible oscillating delta. */
interface LapScript {
  targetMs: number;
  deltaAmplitudeMs: number;
  deltaPeriodMs: number;
  deltaPhase: number;
}

/**
 * Three distinct, deterministic lap scripts, cycled indefinitely so the demo
 * keeps producing plausible laps until the user ends the session — the "3
 * timed laps" from the ticket describes this repeating pattern, not a hard
 * stop (S7 only exposes End Session; nothing else can leave the dashboard).
 */
const LAP_SCRIPTS: readonly LapScript[] = [
  { targetMs: 21_400, deltaAmplitudeMs: 350, deltaPeriodMs: 9_000, deltaPhase: 0 },
  { targetMs: 19_800, deltaAmplitudeMs: 420, deltaPeriodMs: 7_500, deltaPhase: 1.4 },
  { targetMs: 20_650, deltaAmplitudeMs: 280, deltaPeriodMs: 8_200, deltaPhase: 2.7 },
];

function initialState(): FacadeState {
  return {
    sessionState: 'idle',
    lapNumber: 0,
    currentLapMs: 0,
    lastLapMs: null,
    pbMs: INITIAL_PB_MS,
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
}

/**
 * Scripted, timer-driven, fully deterministic stand-in for the real session
 * pipeline. DEV-ONLY — exists purely so `apps/mobile/src/ui/**` has something
 * to render against before the real timing/geometry/state-machine pipeline
 * (a later work package) is wired in. `apps/mobile/src/session/composition.ts`
 * is the single swap point for a production implementation of `SessionFacade`.
 */
export class MockSessionFacade implements SessionFacade {
  private state: FacadeState = initialState();
  private readonly listeners = new Set<(s: FacadeState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Fake monotonic clock — only ever advanced from inside our own tick handlers, so it freezes automatically whenever `timer` is cleared (pause). */
  private simClockMs = 0;

  private lapScriptIndex = 0;
  private currentScript: LapScript | null = null;
  private lapStartSimMs = 0;
  private outLapStartSimMs = 0;
  private calibrationStartSimMs = 0;
  private armedStartSimMs = 0;
  private pausedPhase: 'outLap' | 'timing' | null = null;

  subscribe(cb: (s: FacadeState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private setState(patch: Partial<FacadeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------

  startPreflight(): void {
    this.setState({ sessionState: 'preflight' });
  }

  beginCalibration(): void {
    this.clearTimer();
    this.pausedPhase = null;
    this.calibrationStartSimMs = this.simClockMs;
    this.setState({
      sessionState: 'calibrating',
      calibration: { coverageFraction: 0, onTrack: true },
      calibrationResult: null,
    });
    this.timer = setInterval(() => this.tickCalibration(), TICK_MS);
  }

  private tickCalibration(): void {
    this.simClockMs += TICK_MS;
    const elapsed = this.simClockMs - this.calibrationStartSimMs;
    const coverageFraction = Math.min(1, elapsed / CALIBRATION_DURATION_MS);
    // Deterministic, self-recovering "off track" blip mid-calibration so the
    // onTrack indicator visibly exercises both states in the demo.
    const onTrack = !(elapsed > 2_400 && elapsed < 3_000);
    this.setState({ calibration: { coverageFraction, onTrack } });
    if (coverageFraction >= 1) {
      this.clearTimer();
      this.finishCalibration();
    }
  }

  private finishCalibration(): void {
    const diagnostics: CalibrationResult['diagnostics'] = {
      coverageFraction: 1,
      samplesAccepted: 412,
      samplesRejected: 6,
      rejectionReasons: { ACCURACY_ABOVE_20M: 6 },
      meanLateralM: 1.8,
      p95LateralM: 4.2,
      estimatedBias: { e: 0.6, n: -0.3 },
      directionDetected: 'clockwise',
      observedRateHz: 4.9,
    };
    const result: CalibrationResult = {
      accepted: true,
      confidence: 0.93,
      failureReasons: [],
      appliedBias: diagnostics.estimatedBias,
      diagnostics,
    };
    this.setState({ sessionState: 'calibrationReview', calibrationResult: result });
  }

  acceptCalibration(): void {
    if (this.state.sessionState !== 'calibrationReview') return;
    this.setState({ sessionState: 'armed', calibration: null });
  }

  rejectCalibration(): void {
    // Doubles as "cancel" from mid-calibration and "reject" from the review
    // screen — both return the user to the calibration instructions (S4).
    if (this.state.sessionState !== 'calibrating' && this.state.sessionState !== 'calibrationReview') return;
    this.clearTimer();
    this.setState({ sessionState: 'awaitingCalibration', calibration: null, calibrationResult: null });
  }

  arm(): void {
    if (this.state.sessionState !== 'armed') return;
    this.clearTimer();
    this.armedStartSimMs = this.simClockMs;
    this.timer = setInterval(() => this.tickArmed(), TICK_MS);
  }

  private tickArmed(): void {
    this.simClockMs += TICK_MS;
    if (this.simClockMs - this.armedStartSimMs >= ARMED_DURATION_MS) {
      this.clearTimer();
      this.beginOutLap();
    }
  }

  private beginOutLap(): void {
    this.outLapStartSimMs = this.simClockMs;
    this.setState({ sessionState: 'outLap', lapNumber: 1, currentLapMs: 0, sector: 0 });
    this.timer = setInterval(() => this.tickOutLap(), TICK_MS);
  }

  private tickOutLap(): void {
    this.simClockMs += TICK_MS;
    if (this.simClockMs - this.outLapStartSimMs >= OUT_LAP_DURATION_MS) {
      this.clearTimer();
      this.beginTimingLap();
    }
  }

  private beginTimingLap(): void {
    this.currentScript = LAP_SCRIPTS[this.lapScriptIndex % LAP_SCRIPTS.length]!;
    this.lapStartSimMs = this.simClockMs;
    this.setState({ sessionState: 'timing', currentLapMs: 0, sector: 0 });
    this.timer = setInterval(() => this.tickTimingLap(), TICK_MS);
  }

  private tickTimingLap(): void {
    const script = this.currentScript;
    if (!script) return;
    this.simClockMs += TICK_MS;
    const elapsed = this.simClockMs - this.lapStartSimMs;
    const sector = elapsed < script.targetMs / 3 ? 0 : elapsed < (script.targetMs * 2) / 3 ? 1 : 2;
    const deltaMs = Math.round(
      script.deltaAmplitudeMs * Math.sin((elapsed / script.deltaPeriodMs) * 2 * Math.PI + script.deltaPhase),
    );
    const display: DeltaUpdate['display'] = Math.abs(deltaMs) < 40 ? 'neutral' : deltaMs < 0 ? 'faster' : 'slower';
    const delta: DeltaUpdate = { deltaMs, confidence: 0.85, display, estimatedLapMs: script.targetMs + deltaMs };
    // Deterministic brief GNSS degradation once per lap, exercises the quality pill.
    const gnssQuality: QualityLevel = elapsed > 5_000 && elapsed < 5_800 ? 'degraded' : 'good';
    this.setState({ currentLapMs: elapsed, sector, delta, gnssQuality });
    if (elapsed >= script.targetMs) {
      this.clearTimer();
      this.completeLap(script.targetMs);
    }
  }

  private completeLap(durationMs: number): void {
    const finishedLapNumber = this.state.lapNumber;
    const third = durationMs / 3;
    const sectorTimes: SectorTime[] = [0, 1, 2].map((sectorIndex) => ({
      sectorIndex,
      durationMs: Math.round(third),
      quality: 'good',
    }));
    const lap: LapRecord = {
      lapNumber: finishedLapNumber,
      tStart: this.simClockMs - durationMs,
      tEnd: this.simClockMs,
      durationMs,
      sectorTimes,
      valid: true,
      invalidReasons: [],
      quality: 'good',
    };
    const pbMs = this.state.pbMs === null || durationMs < this.state.pbMs ? durationMs : this.state.pbMs;
    this.lapScriptIndex += 1;
    this.setState({
      lastLapMs: durationMs,
      pbMs,
      laps: [...this.state.laps, lap],
      lapNumber: finishedLapNumber + 1,
    });
    this.beginTimingLap();
  }

  pause(): void {
    const s = this.state.sessionState;
    if (s !== 'timing' && s !== 'outLap') return;
    this.pausedPhase = s;
    this.clearTimer();
    this.setState({ sessionState: 'paused' });
  }

  resume(): void {
    if (this.state.sessionState !== 'paused' || this.pausedPhase === null) return;
    const phase = this.pausedPhase;
    this.pausedPhase = null;
    this.setState({ sessionState: phase });
    // simClockMs was frozen while paused (no ticks ran), so restarting the
    // same phase's tick handler continues exactly where it left off.
    this.timer = setInterval(() => (phase === 'outLap' ? this.tickOutLap() : this.tickTimingLap()), TICK_MS);
  }

  endSession(): void {
    this.clearTimer();
    this.pausedPhase = null;
    this.setState({ sessionState: 'sessionComplete', delta: null });
  }
}
