// ---------- Session state machine ----------
// Pure, deterministic reducer implementing the binding SessionReducer contract
// (see docs/architecture/contracts.md and packages/core/src/contracts.ts).
//
// Design notes (not literally specified by the contract, documented here so the
// behavior is auditable):
//
// - `context.lapNumber` mirrors the top-level `SessionMachineSnapshot.lapNumber`
//   field on every transition (the contract carries lapNumber redundantly at
//   both levels; this reducer keeps the two in sync at all times).
// - `pendingInvalidReasons` is cleared whenever a *new* lap begins (i.e. any
//   CROSSING that sets lapNumber to 1 out of `armed`/`outLap`, or increments it
//   while `timing`). Reasons recorded while `inPit`/`outLap` (e.g. PIT_TRANSIT)
//   therefore persist across the pit stop and are only cleared once a fresh lap
//   actually starts being timed.
// - `lapNumber` is preserved (not force-reset) across PIT_ENTERED/PIT_EXITED —
//   the explicit contract rule "from outLap, a forward startFinish CROSSING
//   transitions to timing with lapNumber=1" already guarantees correct
//   renumbering the next time timing starts, regardless of what lapNumber was
//   carried through the pit stop.
// - The `ARMED` event has no described semantics in the ticket (the happy path
//   reaches `armed` via CALIBRATION_ACCEPTED, not via an `ARMED` event) and is
//   therefore treated as a no-op/illegal event in every state.
// - GNSS_LOST / GNSS_RECOVERED are only meaningful while `timing` per the
//   ticket's explicit scoping ("GNSS_LOST while timing -> stay timing but
//   context.gnssDegraded=true"); elsewhere they are ignored.
// - FATAL is legal from every state (including `idle`, `error`,
//   `sessionComplete`); END_SESSION is legal from every state except `idle`.
//   Both are handled once, ahead of the per-state switch, to avoid repeating
//   them in every branch.
// - "Illegal events for a state are ignored" is implemented uniformly: every
//   switch branch that has no explicit rule falls through to a `default` that
//   returns the *same* snapshot reference, unchanged.

import type { SessionMachineSnapshot, SessionReducer, SessionState } from '../contracts';

export interface SessionContext {
  lapNumber: number;
  priorState: SessionState | null;
  pendingInvalidReasons: string[];
  gnssDegraded: boolean;
  calibrationConfidence?: number;
  preflightFailureReasons: string[];
  fatalMessage?: string;
  // Index signature keeps SessionContext structurally assignable to the
  // contract's `Record<string, unknown>` context field.
  [key: string]: unknown;
}

export interface SessionSnapshot extends SessionMachineSnapshot {
  context: SessionContext;
}

export function createInitialSessionSnapshot(): SessionSnapshot {
  return {
    state: 'idle',
    lapNumber: 0,
    context: {
      lapNumber: 0,
      priorState: null,
      pendingInvalidReasons: [],
      gnssDegraded: false,
      preflightFailureReasons: [],
    },
  };
}

function ctxOf(s: SessionMachineSnapshot): SessionContext {
  return s.context as SessionContext;
}

function next(state: SessionState, context: SessionContext): SessionSnapshot {
  return { state, lapNumber: context.lapNumber, context };
}

function withReason(reasons: string[], reason: string): string[] {
  return reasons.includes(reason) ? reasons : [...reasons, reason];
}

function startLap(state: 'timing', ctx: SessionContext, lapNumber: number): SessionSnapshot {
  return next(state, { ...ctx, lapNumber, pendingInvalidReasons: [] });
}

export const sessionReducer: SessionReducer = (snapshot, event) => {
  const ctx = ctxOf(snapshot);

  // FATAL: legal from every state, including idle/error/sessionComplete.
  if (event.type === 'FATAL') {
    return next('error', { ...ctx, fatalMessage: event.message });
  }

  // END_SESSION: legal from every non-idle state.
  if (event.type === 'END_SESSION') {
    if (snapshot.state === 'idle') return snapshot;
    return next('sessionComplete', ctx);
  }

  switch (snapshot.state) {
    case 'idle': {
      switch (event.type) {
        case 'START_PREFLIGHT':
          return next('preflight', { ...ctx, preflightFailureReasons: [] });
        default:
          return snapshot;
      }
    }

    case 'preflight': {
      switch (event.type) {
        case 'PREFLIGHT_PASSED':
          return next('awaitingCalibration', { ...ctx, preflightFailureReasons: [] });
        case 'PREFLIGHT_FAILED':
          return next('preflight', { ...ctx, preflightFailureReasons: event.reasons });
        case 'START_PREFLIGHT':
          return next('preflight', { ...ctx, preflightFailureReasons: [] });
        default:
          return snapshot;
      }
    }

    case 'awaitingCalibration': {
      switch (event.type) {
        case 'CALIBRATION_STARTED':
          return next('calibrating', ctx);
        default:
          return snapshot;
      }
    }

    case 'calibrating': {
      switch (event.type) {
        case 'CALIBRATION_FINISHED':
          return next('calibrationReview', { ...ctx, calibrationConfidence: event.result.confidence });
        case 'PAUSE':
          return next('paused', { ...ctx, priorState: 'calibrating' });
        default:
          return snapshot;
      }
    }

    case 'calibrationReview': {
      switch (event.type) {
        case 'CALIBRATION_ACCEPTED':
          return next('armed', ctx);
        case 'CALIBRATION_REJECTED':
          return next('awaitingCalibration', ctx);
        default:
          return snapshot;
      }
    }

    case 'armed': {
      switch (event.type) {
        case 'CROSSING': {
          const crossing = event.event;
          if (crossing.direction !== 'forward') return snapshot;
          if (crossing.kind === 'startFinish') return startLap('timing', ctx, 1);
          return next('outLap', ctx);
        }
        case 'PAUSE':
          return next('paused', { ...ctx, priorState: 'armed' });
        default:
          return snapshot;
      }
    }

    case 'outLap': {
      switch (event.type) {
        case 'CROSSING': {
          const crossing = event.event;
          if (crossing.direction === 'forward' && crossing.kind === 'startFinish') {
            return startLap('timing', ctx, 1);
          }
          return snapshot;
        }
        case 'PIT_ENTERED':
          return next('inPit', ctx);
        case 'PAUSE':
          return next('paused', { ...ctx, priorState: 'outLap' });
        default:
          return snapshot;
      }
    }

    case 'timing': {
      switch (event.type) {
        case 'CROSSING': {
          const crossing = event.event;
          if (crossing.direction === 'forward' && crossing.kind === 'startFinish') {
            return startLap('timing', ctx, ctx.lapNumber + 1);
          }
          return snapshot;
        }
        case 'PIT_ENTERED':
          return next('inPit', ctx);
        case 'PAUSE':
          return next('paused', { ...ctx, priorState: 'timing' });
        case 'GNSS_LOST':
          return next('timing', { ...ctx, gnssDegraded: true });
        case 'GNSS_RECOVERED':
          return next('timing', { ...ctx, gnssDegraded: false });
        default:
          return snapshot;
      }
    }

    case 'inPit': {
      switch (event.type) {
        case 'PIT_EXITED':
          return next('outLap', { ...ctx, pendingInvalidReasons: withReason(ctx.pendingInvalidReasons, 'PIT_TRANSIT') });
        case 'PAUSE':
          return next('paused', { ...ctx, priorState: 'inPit' });
        default:
          return snapshot;
      }
    }

    case 'paused': {
      switch (event.type) {
        case 'RESUME': {
          const priorState = ctx.priorState;
          if (priorState == null) return snapshot;
          const gainsPauseGap = priorState === 'timing' && event.gapMs > 30000;
          return next(priorState, {
            ...ctx,
            priorState: null,
            pendingInvalidReasons: gainsPauseGap ? withReason(ctx.pendingInvalidReasons, 'PAUSE_GAP') : ctx.pendingInvalidReasons,
          });
        }
        default:
          return snapshot;
      }
    }

    case 'sessionComplete':
    case 'error':
    default:
      return snapshot;
  }
};
