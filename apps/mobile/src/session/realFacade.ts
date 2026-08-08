import { SessionController, type FacadeStateCore } from '@circuit/core';
import type { FacadeState, SessionFacade } from './facade';

function mapState(core: FacadeStateCore, lastError: string | null): FacadeState {
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
    lastError,
  };
}

function errorMessage(command: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${command} failed: ${detail}`;
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
 * mapped 1:1 (`mapState` above), plus this facade's own `lastError` (C7 fix).
 */
export class RealSessionFacade implements SessionFacade {
  private readonly listeners = new Set<(s: FacadeState) => void>();
  private latest: FacadeState;
  private lastError: string | null = null;
  /** Unsubscribes from `controller` -- retained (C6 fix) so `dispose()` can detach this facade instead of leaking a subscription past the point composition.ts stops using it (e.g. a DevReplay swap). */
  private readonly controllerUnsubscribe: () => void;

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
      null,
    );
    this.controllerUnsubscribe = controller.subscribe((s) => {
      this.latest = mapState(s, this.lastError);
      for (const listener of this.listeners) listener(this.latest);
    });
  }

  /** Detaches this facade from `controller` (C6 fix) -- does NOT dispose the controller itself, which composition.ts owns and disposes separately. Safe to call multiple times. */
  dispose(): void {
    this.controllerUnsubscribe();
    this.listeners.clear();
  }

  subscribe(cb: (s: FacadeState) => void): () => void {
    this.listeners.add(cb);
    cb(this.latest);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emitLatest(): void {
    for (const listener of this.listeners) listener(this.latest);
  }

  /**
   * Runs an async command body (C7 fix): clears any previous `lastError`
   * before attempting it (so a retry that succeeds visibly clears the old
   * message), and catches a rejection into `lastError` instead of leaving it
   * as an unhandled promise rejection with no user-visible signal.
   */
  private guard(name: string, work: () => Promise<void>): void {
    if (this.lastError !== null) {
      this.lastError = null;
      this.latest = { ...this.latest, lastError: null };
      this.emitLatest();
    }
    work().catch((error: unknown) => {
      this.lastError = errorMessage(name, error);
      this.latest = { ...this.latest, lastError: this.lastError };
      this.emitLatest();
    });
  }

  startPreflight(): void {
    // Preflight itself runs the real collectors independently (see
    // `PreflightScreen`/`platform/preflight.ts`); the controller's own
    // START_PREFLIGHT/PREFLIGHT_PASSED dispatch happens atomically inside
    // `start()` once calibration begins, so there is nothing controller-side
    // to trigger yet. This exists only to satisfy `SessionFacade`.
  }

  beginCalibration(): void {
    this.guard('beginCalibration', async () => {
      await this.controller.start('calibration');
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
    this.guard('endSession', async () => {
      await this.controller.endSession();
      this.callbacks.onSessionEnded?.();
    });
  }

  pause(): void {
    this.controller.pause();
  }

  resume(): void {
    this.controller.resume();
  }
}
