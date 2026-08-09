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
      // F1(d) fix: `lastError` clears on the controller's NEXT SUCCESSFUL
      // state change, not merely because another guarded command was
      // invoked. `SessionController` only ever calls its listeners after a
      // mutation actually completed (see e.g. `start()`'s F1 fix -- a
      // failed attempt never reaches `emit()` at all), so reaching this
      // callback is itself proof of genuine forward progress. Previously
      // `guard()` cleared `lastError` up front, before attempting the next
      // command -- a retry that ALSO failed briefly flashed the old error
      // away and then immediately reinstated it, and a command that threw
      // before the controller ever changed state (e.g. a synchronous
      // precondition failure) cleared a real, still-accurate error for no
      // reason.
      this.lastError = null;
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
   * Runs an async command body (C7 fix): catches a rejection into
   * `lastError` instead of leaving it as an unhandled promise rejection with
   * no user-visible signal. Does NOT preemptively clear a previous
   * `lastError` before attempting the work (F1(d) fix, binding spec) -- that
   * happens only in the controller-subscription callback above, on the next
   * genuine successful state change, so a retry that also fails never
   * flashes the old message away first.
   */
  private guard(name: string, work: () => Promise<void>): void {
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
