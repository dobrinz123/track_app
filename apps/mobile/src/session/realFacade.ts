import { SessionController, type FacadeStateCore } from '@circuit/core';
import type { FacadeState, SessionFacade } from './facade';

function mapState(core: FacadeStateCore): FacadeState {
  return {
    sessionState: core.sessionState,
    lapNumber: core.lapNumber,
    currentLapMs: core.currentLapMs,
    lastLapMs: core.lastLapMs,
    pbMs: core.pbMs,
    delta: core.delta,
    sector: core.sector,
    gnssQuality: core.gnssQuality,
    calibration: core.calibration,
    calibrationResult: core.calibrationResult,
    laps: core.laps,
    speedKph: core.speedKph,
  };
}

export interface RealSessionFacadeCallbacks {
  /** Fired once a session id is known (right after `start()`), so composition.ts can persist an "active session" pointer for ADR-0003 §3 recovery. */
  onSessionStarted?: (sessionId: string) => void;
  /** Fired after `endSession()` has finished saving the session summary. */
  onSessionEnded?: () => void;
}

/**
 * Adapts `SessionController` (`@circuit/core`) to the app's `SessionFacade`
 * interface (MUST DO #4). Owns no pipeline logic itself -- every command is a
 * direct pass-through to the controller; `FacadeState` is `FacadeStateCore`
 * mapped 1:1 (`mapState` above).
 */
export class RealSessionFacade implements SessionFacade {
  private readonly listeners = new Set<(s: FacadeState) => void>();
  private latest: FacadeState;

  constructor(
    private readonly controller: SessionController,
    private readonly callbacks: RealSessionFacadeCallbacks = {},
  ) {
    // `SessionController.subscribe` always calls back synchronously with the
    // current state, so `this.latest` is definitely assigned by the time the
    // constructor returns.
    this.latest = mapState(
      (() => {
        let snapshot: FacadeStateCore | undefined;
        const unsubscribe = controller.subscribe((s) => {
          snapshot = s;
        });
        unsubscribe();
        return snapshot as FacadeStateCore;
      })(),
    );
    controller.subscribe((s) => {
      this.latest = mapState(s);
      for (const listener of this.listeners) listener(this.latest);
    });
  }

  subscribe(cb: (s: FacadeState) => void): () => void {
    this.listeners.add(cb);
    cb(this.latest);
    return () => {
      this.listeners.delete(cb);
    };
  }

  startPreflight(): void {
    // Preflight itself runs the real collectors independently (see
    // `PreflightScreen`/`platform/preflight.ts`); the controller's own
    // START_PREFLIGHT/PREFLIGHT_PASSED dispatch happens atomically inside
    // `start()` once calibration begins, so there is nothing controller-side
    // to trigger yet. This exists only to satisfy `SessionFacade`.
  }

  beginCalibration(): void {
    void this.controller.start('calibration').then(() => {
      const sessionId = this.controller.diagnostics().sessionId;
      if (sessionId !== null) this.callbacks.onSessionStarted?.(sessionId);
    });
  }

  acceptCalibration(): void {
    this.controller.acceptCalibration();
  }

  rejectCalibration(): void {
    this.controller.rejectCalibration();
  }

  arm(): void {
    this.controller.arm();
  }

  endSession(): void {
    void this.controller.endSession().then(() => this.callbacks.onSessionEnded?.());
  }

  pause(): void {
    this.controller.pause();
  }

  resume(): void {
    this.controller.resume();
  }
}
