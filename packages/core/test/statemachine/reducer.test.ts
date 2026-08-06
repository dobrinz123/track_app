import { describe, expect, it } from 'vitest';
import { sessionReducer, createInitialSessionSnapshot } from '../../src/statemachine';
import type { SessionSnapshot } from '../../src/statemachine';
import type { CalibrationResult, CrossingEvent, SessionEvent, SessionState } from '../../src/contracts';

// ---------- fixtures ----------

function snap(state: SessionState, overrides: Partial<SessionSnapshot['context']> = {}, lapNumber = 0): SessionSnapshot {
  const base = createInitialSessionSnapshot();
  const context = { ...base.context, lapNumber, ...overrides };
  return { state, lapNumber: context.lapNumber, context };
}

function crossing(kind: CrossingEvent['kind'], direction: CrossingEvent['direction'], overrides: Partial<CrossingEvent> = {}): SessionEvent {
  return {
    type: 'CROSSING',
    event: {
      gateId: 'gate-1',
      kind,
      tCross: 1000,
      direction,
      confidence: 1,
      lapDistanceM: 0,
      ...overrides,
    },
  };
}

function calibrationResult(confidence: number, accepted = true): CalibrationResult {
  return {
    accepted,
    confidence,
    failureReasons: [],
    appliedBias: { e: 0, n: 0 },
    diagnostics: {
      coverageFraction: 1,
      samplesAccepted: 100,
      samplesRejected: 0,
      rejectionReasons: {},
      meanLateralM: 0,
      p95LateralM: 0,
      estimatedBias: { e: 0, n: 0 },
      directionDetected: 'clockwise',
      observedRateHz: 1,
    },
  };
}

// ---------- assertion helpers ----------

function expectIgnored(from: SessionSnapshot, event: SessionEvent) {
  const result = sessionReducer(from, event);
  expect(result).toBe(from); // identical reference, never a new object
}

function expectTransition(from: SessionSnapshot, event: SessionEvent, toState: SessionState) {
  const result = sessionReducer(from, event);
  expect(result).not.toBe(from);
  expect(result.state).toBe(toState);
  return result;
}

const ALL_STATES: SessionState[] = [
  'idle',
  'preflight',
  'awaitingCalibration',
  'calibrating',
  'calibrationReview',
  'armed',
  'outLap',
  'timing',
  'inPit',
  'paused',
  'sessionComplete',
  'error',
];

// Representative event set covering every SessionEvent['type'].
function representativeEvents(): Record<string, SessionEvent> {
  return {
    START_PREFLIGHT: { type: 'START_PREFLIGHT' },
    PREFLIGHT_PASSED: { type: 'PREFLIGHT_PASSED' },
    PREFLIGHT_FAILED: { type: 'PREFLIGHT_FAILED', reasons: ['NO_GNSS_FIX'] },
    CALIBRATION_STARTED: { type: 'CALIBRATION_STARTED' },
    CALIBRATION_FINISHED: { type: 'CALIBRATION_FINISHED', result: calibrationResult(0.9) },
    CALIBRATION_ACCEPTED: { type: 'CALIBRATION_ACCEPTED' },
    CALIBRATION_REJECTED: { type: 'CALIBRATION_REJECTED' },
    ARMED: { type: 'ARMED' },
    CROSSING_FWD_SF: crossing('startFinish', 'forward'),
    CROSSING_FWD_SECTOR: crossing('sector', 'forward'),
    CROSSING_REV_SF: crossing('startFinish', 'reverse'),
    PIT_ENTERED: { type: 'PIT_ENTERED' },
    PIT_EXITED: { type: 'PIT_EXITED' },
    PAUSE: { type: 'PAUSE' },
    RESUME: { type: 'RESUME', gapMs: 1000 },
    GNSS_LOST: { type: 'GNSS_LOST' },
    GNSS_RECOVERED: { type: 'GNSS_RECOVERED' },
    END_SESSION: { type: 'END_SESSION' },
    FATAL: { type: 'FATAL', message: 'boom' },
  };
}

// Full transition matrix: expected next state per [fromState][eventKey], or
// 'IGNORED' meaning the snapshot must come back with identical reference.
// Only states that need special context (paused needs a priorState, e.g.) are
// constructed specially below; this matrix covers every state x every
// representative event.
const MATRIX: Record<SessionState, Record<string, SessionState | 'IGNORED'>> = {
  idle: {
    START_PREFLIGHT: 'preflight',
    PREFLIGHT_PASSED: 'IGNORED',
    PREFLIGHT_FAILED: 'IGNORED',
    CALIBRATION_STARTED: 'IGNORED',
    CALIBRATION_FINISHED: 'IGNORED',
    CALIBRATION_ACCEPTED: 'IGNORED',
    CALIBRATION_REJECTED: 'IGNORED',
    ARMED: 'IGNORED',
    CROSSING_FWD_SF: 'IGNORED',
    CROSSING_FWD_SECTOR: 'IGNORED',
    CROSSING_REV_SF: 'IGNORED',
    PIT_ENTERED: 'IGNORED',
    PIT_EXITED: 'IGNORED',
    PAUSE: 'IGNORED',
    RESUME: 'IGNORED',
    GNSS_LOST: 'IGNORED',
    GNSS_RECOVERED: 'IGNORED',
    END_SESSION: 'IGNORED', // idle is excluded from "any non-idle state"
    FATAL: 'error',
  },
  preflight: {
    START_PREFLIGHT: 'preflight', // retry, new context (not identity-preserving)
    PREFLIGHT_PASSED: 'awaitingCalibration',
    PREFLIGHT_FAILED: 'preflight',
    CALIBRATION_STARTED: 'IGNORED',
    CALIBRATION_FINISHED: 'IGNORED',
    CALIBRATION_ACCEPTED: 'IGNORED',
    CALIBRATION_REJECTED: 'IGNORED',
    ARMED: 'IGNORED',
    CROSSING_FWD_SF: 'IGNORED',
    CROSSING_FWD_SECTOR: 'IGNORED',
    CROSSING_REV_SF: 'IGNORED',
    PIT_ENTERED: 'IGNORED',
    PIT_EXITED: 'IGNORED',
    PAUSE: 'IGNORED',
    RESUME: 'IGNORED',
    GNSS_LOST: 'IGNORED',
    GNSS_RECOVERED: 'IGNORED',
    END_SESSION: 'sessionComplete',
    FATAL: 'error',
  },
  awaitingCalibration: {
    START_PREFLIGHT: 'IGNORED',
    PREFLIGHT_PASSED: 'IGNORED',
    PREFLIGHT_FAILED: 'IGNORED',
    CALIBRATION_STARTED: 'calibrating',
    CALIBRATION_FINISHED: 'IGNORED',
    CALIBRATION_ACCEPTED: 'IGNORED',
    CALIBRATION_REJECTED: 'IGNORED',
    ARMED: 'IGNORED',
    CROSSING_FWD_SF: 'IGNORED',
    CROSSING_FWD_SECTOR: 'IGNORED',
    CROSSING_REV_SF: 'IGNORED',
    PIT_ENTERED: 'IGNORED',
    PIT_EXITED: 'IGNORED',
    PAUSE: 'IGNORED',
    RESUME: 'IGNORED',
    GNSS_LOST: 'IGNORED',
    GNSS_RECOVERED: 'IGNORED',
    END_SESSION: 'sessionComplete',
    FATAL: 'error',
  },
  calibrating: {
    START_PREFLIGHT: 'IGNORED',
    PREFLIGHT_PASSED: 'IGNORED',
    PREFLIGHT_FAILED: 'IGNORED',
    CALIBRATION_STARTED: 'IGNORED',
    CALIBRATION_FINISHED: 'calibrationReview',
    CALIBRATION_ACCEPTED: 'IGNORED',
    CALIBRATION_REJECTED: 'IGNORED',
    ARMED: 'IGNORED',
    CROSSING_FWD_SF: 'IGNORED',
    CROSSING_FWD_SECTOR: 'IGNORED',
    CROSSING_REV_SF: 'IGNORED',
    PIT_ENTERED: 'IGNORED',
    PIT_EXITED: 'IGNORED',
    PAUSE: 'paused',
    RESUME: 'IGNORED',
    GNSS_LOST: 'IGNORED',
    GNSS_RECOVERED: 'IGNORED',
    END_SESSION: 'sessionComplete',
    FATAL: 'error',
  },
  calibrationReview: {
    START_PREFLIGHT: 'IGNORED',
    PREFLIGHT_PASSED: 'IGNORED',
    PREFLIGHT_FAILED: 'IGNORED',
    CALIBRATION_STARTED: 'IGNORED',
    CALIBRATION_FINISHED: 'IGNORED',
    CALIBRATION_ACCEPTED: 'armed',
    CALIBRATION_REJECTED: 'awaitingCalibration',
    ARMED: 'IGNORED',
    CROSSING_FWD_SF: 'IGNORED',
    CROSSING_FWD_SECTOR: 'IGNORED',
    CROSSING_REV_SF: 'IGNORED',
    PIT_ENTERED: 'IGNORED',
    PIT_EXITED: 'IGNORED',
    PAUSE: 'IGNORED',
    RESUME: 'IGNORED',
    GNSS_LOST: 'IGNORED',
    GNSS_RECOVERED: 'IGNORED',
    END_SESSION: 'sessionComplete',
    FATAL: 'error',
  },
  armed: {
    START_PREFLIGHT: 'IGNORED',
    PREFLIGHT_PASSED: 'IGNORED',
    PREFLIGHT_FAILED: 'IGNORED',
    CALIBRATION_STARTED: 'IGNORED',
    CALIBRATION_FINISHED: 'IGNORED',
    CALIBRATION_ACCEPTED: 'IGNORED',
    CALIBRATION_REJECTED: 'IGNORED',
    ARMED: 'IGNORED',
    CROSSING_FWD_SF: 'timing',
    CROSSING_FWD_SECTOR: 'outLap',
    CROSSING_REV_SF: 'IGNORED',
    PIT_ENTERED: 'IGNORED',
    PIT_EXITED: 'IGNORED',
    PAUSE: 'paused',
    RESUME: 'IGNORED',
    GNSS_LOST: 'IGNORED',
    GNSS_RECOVERED: 'IGNORED',
    END_SESSION: 'sessionComplete',
    FATAL: 'error',
  },
  outLap: {
    START_PREFLIGHT: 'IGNORED',
    PREFLIGHT_PASSED: 'IGNORED',
    PREFLIGHT_FAILED: 'IGNORED',
    CALIBRATION_STARTED: 'IGNORED',
    CALIBRATION_FINISHED: 'IGNORED',
    CALIBRATION_ACCEPTED: 'IGNORED',
    CALIBRATION_REJECTED: 'IGNORED',
    ARMED: 'IGNORED',
    CROSSING_FWD_SF: 'timing',
    CROSSING_FWD_SECTOR: 'IGNORED',
    CROSSING_REV_SF: 'IGNORED',
    PIT_ENTERED: 'inPit',
    PIT_EXITED: 'IGNORED',
    PAUSE: 'paused',
    RESUME: 'IGNORED',
    GNSS_LOST: 'IGNORED',
    GNSS_RECOVERED: 'IGNORED',
    END_SESSION: 'sessionComplete',
    FATAL: 'error',
  },
  timing: {
    START_PREFLIGHT: 'IGNORED',
    PREFLIGHT_PASSED: 'IGNORED',
    PREFLIGHT_FAILED: 'IGNORED',
    CALIBRATION_STARTED: 'IGNORED',
    CALIBRATION_FINISHED: 'IGNORED',
    CALIBRATION_ACCEPTED: 'IGNORED',
    CALIBRATION_REJECTED: 'IGNORED',
    ARMED: 'IGNORED',
    CROSSING_FWD_SF: 'timing',
    CROSSING_FWD_SECTOR: 'IGNORED',
    CROSSING_REV_SF: 'IGNORED',
    PIT_ENTERED: 'inPit',
    PIT_EXITED: 'IGNORED',
    PAUSE: 'paused',
    RESUME: 'IGNORED',
    GNSS_LOST: 'timing',
    GNSS_RECOVERED: 'timing',
    END_SESSION: 'sessionComplete',
    FATAL: 'error',
  },
  inPit: {
    START_PREFLIGHT: 'IGNORED',
    PREFLIGHT_PASSED: 'IGNORED',
    PREFLIGHT_FAILED: 'IGNORED',
    CALIBRATION_STARTED: 'IGNORED',
    CALIBRATION_FINISHED: 'IGNORED',
    CALIBRATION_ACCEPTED: 'IGNORED',
    CALIBRATION_REJECTED: 'IGNORED',
    ARMED: 'IGNORED',
    CROSSING_FWD_SF: 'IGNORED',
    CROSSING_FWD_SECTOR: 'IGNORED',
    CROSSING_REV_SF: 'IGNORED',
    PIT_ENTERED: 'IGNORED',
    PIT_EXITED: 'outLap',
    PAUSE: 'paused',
    RESUME: 'IGNORED',
    GNSS_LOST: 'IGNORED',
    GNSS_RECOVERED: 'IGNORED',
    END_SESSION: 'sessionComplete',
    FATAL: 'error',
  },
  paused: {
    START_PREFLIGHT: 'IGNORED',
    PREFLIGHT_PASSED: 'IGNORED',
    PREFLIGHT_FAILED: 'IGNORED',
    CALIBRATION_STARTED: 'IGNORED',
    CALIBRATION_FINISHED: 'IGNORED',
    CALIBRATION_ACCEPTED: 'IGNORED',
    CALIBRATION_REJECTED: 'IGNORED',
    ARMED: 'IGNORED',
    CROSSING_FWD_SF: 'IGNORED',
    CROSSING_FWD_SECTOR: 'IGNORED',
    CROSSING_REV_SF: 'IGNORED',
    PIT_ENTERED: 'IGNORED',
    PIT_EXITED: 'IGNORED',
    PAUSE: 'IGNORED',
    RESUME: 'timing', // fixture below sets priorState='timing'
    GNSS_LOST: 'IGNORED',
    GNSS_RECOVERED: 'IGNORED',
    END_SESSION: 'sessionComplete',
    FATAL: 'error',
  },
  sessionComplete: {
    START_PREFLIGHT: 'IGNORED',
    PREFLIGHT_PASSED: 'IGNORED',
    PREFLIGHT_FAILED: 'IGNORED',
    CALIBRATION_STARTED: 'IGNORED',
    CALIBRATION_FINISHED: 'IGNORED',
    CALIBRATION_ACCEPTED: 'IGNORED',
    CALIBRATION_REJECTED: 'IGNORED',
    ARMED: 'IGNORED',
    CROSSING_FWD_SF: 'IGNORED',
    CROSSING_FWD_SECTOR: 'IGNORED',
    CROSSING_REV_SF: 'IGNORED',
    PIT_ENTERED: 'IGNORED',
    PIT_EXITED: 'IGNORED',
    PAUSE: 'IGNORED',
    RESUME: 'IGNORED',
    GNSS_LOST: 'IGNORED',
    GNSS_RECOVERED: 'IGNORED',
    END_SESSION: 'sessionComplete', // legal repeat, new reference, same state
    FATAL: 'error',
  },
  error: {
    START_PREFLIGHT: 'IGNORED',
    PREFLIGHT_PASSED: 'IGNORED',
    PREFLIGHT_FAILED: 'IGNORED',
    CALIBRATION_STARTED: 'IGNORED',
    CALIBRATION_FINISHED: 'IGNORED',
    CALIBRATION_ACCEPTED: 'IGNORED',
    CALIBRATION_REJECTED: 'IGNORED',
    ARMED: 'IGNORED',
    CROSSING_FWD_SF: 'IGNORED',
    CROSSING_FWD_SECTOR: 'IGNORED',
    CROSSING_REV_SF: 'IGNORED',
    PIT_ENTERED: 'IGNORED',
    PIT_EXITED: 'IGNORED',
    PAUSE: 'IGNORED',
    RESUME: 'IGNORED',
    GNSS_LOST: 'IGNORED',
    GNSS_RECOVERED: 'IGNORED',
    END_SESSION: 'sessionComplete',
    FATAL: 'error',
  },
};

function fixtureFor(state: SessionState): SessionSnapshot {
  if (state === 'paused') return snap('paused', { priorState: 'timing' }, 3);
  return snap(state);
}

describe('sessionReducer: full transition matrix', () => {
  for (const state of ALL_STATES) {
    describe(`from ${state}`, () => {
      const events = representativeEvents();
      for (const [key, event] of Object.entries(events)) {
        const expected = MATRIX[state][key];
        if (expected === undefined) throw new Error(`missing matrix entry for ${state}/${key}`);
        it(`${key} -> ${expected}`, () => {
          const from = fixtureFor(state);
          if (expected === 'IGNORED') {
            expectIgnored(from, event);
          } else {
            expectTransition(from, event, expected);
          }
        });
      }
    });
  }
});

describe('sessionReducer: illegal events are ignored with identical reference (never throw)', () => {
  it('does not throw for any state x event combination', () => {
    for (const state of ALL_STATES) {
      const events = Object.values(representativeEvents());
      for (const event of events) {
        expect(() => sessionReducer(fixtureFor(state), event)).not.toThrow();
      }
    }
  });

  it('idle ignores PAUSE and returns the exact same object reference', () => {
    const s = snap('idle');
    const result = sessionReducer(s, { type: 'PAUSE' });
    expect(result).toBe(s);
  });

  it('calibrationReview ignores PAUSE (not in the pausable state set)', () => {
    const s = snap('calibrationReview');
    const result = sessionReducer(s, { type: 'PAUSE' });
    expect(result).toBe(s);
  });
});

describe('sessionReducer: happy path', () => {
  it('idle -> preflight -> awaitingCalibration -> calibrating -> calibrationReview -> armed -> outLap -> timing -> sessionComplete', () => {
    let s = createInitialSessionSnapshot() as SessionSnapshot;
    expect(s.state).toBe('idle');

    s = sessionReducer(s, { type: 'START_PREFLIGHT' }) as SessionSnapshot;
    expect(s.state).toBe('preflight');

    s = sessionReducer(s, { type: 'PREFLIGHT_PASSED' }) as SessionSnapshot;
    expect(s.state).toBe('awaitingCalibration');

    s = sessionReducer(s, { type: 'CALIBRATION_STARTED' }) as SessionSnapshot;
    expect(s.state).toBe('calibrating');

    s = sessionReducer(s, { type: 'CALIBRATION_FINISHED', result: calibrationResult(0.95) }) as SessionSnapshot;
    expect(s.state).toBe('calibrationReview');
    expect(s.context.calibrationConfidence).toBe(0.95);

    s = sessionReducer(s, { type: 'CALIBRATION_ACCEPTED' }) as SessionSnapshot;
    expect(s.state).toBe('armed');

    // non-startFinish forward crossing while armed -> outLap
    s = sessionReducer(s, crossing('sector', 'forward')) as SessionSnapshot;
    expect(s.state).toBe('outLap');
    expect(s.lapNumber).toBe(0);

    // forward startFinish crossing while outLap -> timing, lap 1
    s = sessionReducer(s, crossing('startFinish', 'forward')) as SessionSnapshot;
    expect(s.state).toBe('timing');
    expect(s.lapNumber).toBe(1);
    expect(s.context.lapNumber).toBe(1);

    // subsequent forward startFinish crossings increment lapNumber
    s = sessionReducer(s, crossing('startFinish', 'forward')) as SessionSnapshot;
    expect(s.state).toBe('timing');
    expect(s.lapNumber).toBe(2);

    s = sessionReducer(s, { type: 'END_SESSION' }) as SessionSnapshot;
    expect(s.state).toBe('sessionComplete');
  });

  it('armed -> timing directly on a forward startFinish crossing, lap 1', () => {
    const armed = snap('armed');
    const result = sessionReducer(armed, crossing('startFinish', 'forward')) as SessionSnapshot;
    expect(result.state).toBe('timing');
    expect(result.lapNumber).toBe(1);
  });

  it('reverse-direction startFinish crossings never start or complete laps', () => {
    const armed = snap('armed');
    expectIgnored(armed, crossing('startFinish', 'reverse'));

    const timing = snap('timing', {}, 4);
    expectIgnored(timing, crossing('startFinish', 'reverse'));

    const outLap = snap('outLap');
    expectIgnored(outLap, crossing('startFinish', 'reverse'));
  });

  it('PREFLIGHT_FAILED stays in preflight, stores reasons, and retry via START_PREFLIGHT clears them', () => {
    const s0 = snap('preflight');
    const s1 = sessionReducer(s0, { type: 'PREFLIGHT_FAILED', reasons: ['NO_GNSS_FIX', 'LOW_ACCURACY'] }) as SessionSnapshot;
    expect(s1.state).toBe('preflight');
    expect(s1.context.preflightFailureReasons).toEqual(['NO_GNSS_FIX', 'LOW_ACCURACY']);

    const s2 = sessionReducer(s1, { type: 'START_PREFLIGHT' }) as SessionSnapshot;
    expect(s2.state).toBe('preflight');
    expect(s2.context.preflightFailureReasons).toEqual([]);
  });

  it('calibrationReview --CALIBRATION_REJECTED--> awaitingCalibration allows retry', () => {
    const s0 = snap('calibrationReview', { calibrationConfidence: 0.4 });
    const s1 = sessionReducer(s0, { type: 'CALIBRATION_REJECTED' }) as SessionSnapshot;
    expect(s1.state).toBe('awaitingCalibration');

    const s2 = sessionReducer(s1, { type: 'CALIBRATION_STARTED' }) as SessionSnapshot;
    expect(s2.state).toBe('calibrating');
  });
});

describe('sessionReducer: pit-transit invalidation', () => {
  it('PIT_ENTERED from timing -> inPit, PIT_EXITED -> outLap flags PIT_TRANSIT and preserves lapNumber', () => {
    const timingLap3 = snap('timing', {}, 3);
    const inPit = sessionReducer(timingLap3, { type: 'PIT_ENTERED' }) as SessionSnapshot;
    expect(inPit.state).toBe('inPit');
    expect(inPit.lapNumber).toBe(3);
    expect(inPit.context.pendingInvalidReasons).toEqual([]);

    const outLap = sessionReducer(inPit, { type: 'PIT_EXITED' }) as SessionSnapshot;
    expect(outLap.state).toBe('outLap');
    expect(outLap.lapNumber).toBe(3);
    expect(outLap.context.pendingInvalidReasons).toEqual(['PIT_TRANSIT']);

    // next lap start clears the pit-transit flag and renumbers to 1
    const timing = sessionReducer(outLap, crossing('startFinish', 'forward')) as SessionSnapshot;
    expect(timing.state).toBe('timing');
    expect(timing.lapNumber).toBe(1);
    expect(timing.context.pendingInvalidReasons).toEqual([]);
  });

  it('PIT_ENTERED from outLap -> inPit -> PIT_EXITED -> outLap also flags PIT_TRANSIT', () => {
    const outLap = snap('outLap');
    const inPit = sessionReducer(outLap, { type: 'PIT_ENTERED' }) as SessionSnapshot;
    expect(inPit.state).toBe('inPit');

    const backToOutLap = sessionReducer(inPit, { type: 'PIT_EXITED' }) as SessionSnapshot;
    expect(backToOutLap.state).toBe('outLap');
    expect(backToOutLap.context.pendingInvalidReasons).toEqual(['PIT_TRANSIT']);
  });

  it('PIT_TRANSIT is not duplicated on repeated pit stops before a new lap starts', () => {
    let s = snap('inPit', { pendingInvalidReasons: ['PIT_TRANSIT'] }, 2);
    s = sessionReducer(s, { type: 'PIT_EXITED' }) as SessionSnapshot;
    expect(s.context.pendingInvalidReasons).toEqual(['PIT_TRANSIT']);
  });
});

describe('sessionReducer: pause/resume round-trip', () => {
  it.each<[SessionState]>([['calibrating'], ['armed'], ['outLap'], ['timing'], ['inPit']])(
    'PAUSE from %s remembers priorState; RESUME (short gap) returns to it and preserves lapNumber',
    (state) => {
      const before = snap(state, {}, 5);
      const paused = sessionReducer(before, { type: 'PAUSE' }) as SessionSnapshot;
      expect(paused.state).toBe('paused');
      expect(paused.context.priorState).toBe(state);
      expect(paused.lapNumber).toBe(5);

      const resumed = sessionReducer(paused, { type: 'RESUME', gapMs: 500 }) as SessionSnapshot;
      expect(resumed.state).toBe(state);
      expect(resumed.lapNumber).toBe(5);
      expect(resumed.context.priorState).toBeNull();
      expect(resumed.context.pendingInvalidReasons).toEqual([]);
    },
  );

  it('RESUME with gapMs > 30000 while resuming into timing adds PAUSE_GAP to the in-progress lap', () => {
    const timing = snap('timing', {}, 7);
    const paused = sessionReducer(timing, { type: 'PAUSE' }) as SessionSnapshot;
    const resumed = sessionReducer(paused, { type: 'RESUME', gapMs: 30001 }) as SessionSnapshot;

    expect(resumed.state).toBe('timing');
    expect(resumed.lapNumber).toBe(7);
    expect(resumed.context.pendingInvalidReasons).toEqual(['PAUSE_GAP']);
  });

  it('RESUME with gapMs > 30000 resuming into a non-timing state does not add PAUSE_GAP', () => {
    const armed = snap('armed');
    const paused = sessionReducer(armed, { type: 'PAUSE' }) as SessionSnapshot;
    const resumed = sessionReducer(paused, { type: 'RESUME', gapMs: 99999 }) as SessionSnapshot;

    expect(resumed.state).toBe('armed');
    expect(resumed.context.pendingInvalidReasons).toEqual([]);
  });

  it('RESUME with gapMs exactly 30000 does not add PAUSE_GAP (strictly greater-than)', () => {
    const timing = snap('timing', {}, 1);
    const paused = sessionReducer(timing, { type: 'PAUSE' }) as SessionSnapshot;
    const resumed = sessionReducer(paused, { type: 'RESUME', gapMs: 30000 }) as SessionSnapshot;

    expect(resumed.context.pendingInvalidReasons).toEqual([]);
  });
});

describe('sessionReducer: gnss degradation flag', () => {
  it('GNSS_LOST sets gnssDegraded while timing; GNSS_RECOVERED clears it; state never changes', () => {
    const s0 = snap('timing', {}, 2);
    const s1 = sessionReducer(s0, { type: 'GNSS_LOST' }) as SessionSnapshot;
    expect(s1.state).toBe('timing');
    expect(s1.context.gnssDegraded).toBe(true);

    const s2 = sessionReducer(s1, { type: 'GNSS_RECOVERED' }) as SessionSnapshot;
    expect(s2.state).toBe('timing');
    expect(s2.context.gnssDegraded).toBe(false);
  });

  it('GNSS_LOST outside of timing is ignored', () => {
    const armed = snap('armed');
    expectIgnored(armed, { type: 'GNSS_LOST' });
  });
});

describe('sessionReducer: FATAL and END_SESSION', () => {
  it('FATAL transitions from any state to error, storing the message', () => {
    for (const state of ALL_STATES) {
      const from = fixtureFor(state);
      const result = sessionReducer(from, { type: 'FATAL', message: `err-${state}` }) as SessionSnapshot;
      expect(result.state).toBe('error');
      expect(result.context.fatalMessage).toBe(`err-${state}`);
    }
  });

  it('END_SESSION transitions from any non-idle state to sessionComplete', () => {
    for (const state of ALL_STATES.filter((s) => s !== 'idle')) {
      const from = fixtureFor(state);
      const result = sessionReducer(from, { type: 'END_SESSION' }) as SessionSnapshot;
      expect(result.state).toBe('sessionComplete');
    }
  });

  it('END_SESSION from idle is ignored', () => {
    expectIgnored(snap('idle'), { type: 'END_SESSION' });
  });
});

describe('sessionReducer: determinism', () => {
  it('same snapshot + same event always produces deep-equal output', () => {
    const s = snap('timing', {}, 4);
    const event = crossing('startFinish', 'forward');

    const r1 = sessionReducer(s, event);
    const r2 = sessionReducer(s, event);

    expect(r1).toEqual(r2);
    expect(r1).not.toBe(r2); // distinct objects, same content
  });

  it('never mutates the input snapshot', () => {
    const s = snap('armed');
    const before = JSON.parse(JSON.stringify(s));
    sessionReducer(s, crossing('startFinish', 'forward'));
    expect(s).toEqual(before);
  });

  it('a long deterministic sequence replayed twice yields identical final snapshots', () => {
    const events: SessionEvent[] = [
      { type: 'START_PREFLIGHT' },
      { type: 'PREFLIGHT_PASSED' },
      { type: 'CALIBRATION_STARTED' },
      { type: 'CALIBRATION_FINISHED', result: calibrationResult(0.8) },
      { type: 'CALIBRATION_ACCEPTED' },
      crossing('startFinish', 'forward'),
      crossing('startFinish', 'forward'),
      { type: 'PIT_ENTERED' },
      { type: 'PIT_EXITED' },
      crossing('startFinish', 'forward'),
      { type: 'PAUSE' },
      { type: 'RESUME', gapMs: 40000 },
      { type: 'END_SESSION' },
    ];

    function run(): SessionSnapshot {
      let s = createInitialSessionSnapshot() as SessionSnapshot;
      for (const e of events) s = sessionReducer(s, e) as SessionSnapshot;
      return s;
    }

    expect(run()).toEqual(run());
  });
});

describe('sessionReducer: serializability', () => {
  it('a JSON round-tripped snapshot behaves identically to the original when fed events', () => {
    const original = snap('timing', { gnssDegraded: true, pendingInvalidReasons: ['PIT_TRANSIT'] }, 6);
    const revived = JSON.parse(JSON.stringify(original)) as SessionSnapshot;

    expect(revived).toEqual(original);

    const event = crossing('startFinish', 'forward');
    const resultFromOriginal = sessionReducer(original, event);
    const resultFromRevived = sessionReducer(revived, event);

    expect(resultFromRevived).toEqual(resultFromOriginal);
  });

  it('the initial snapshot survives a JSON round trip unchanged', () => {
    const initial = createInitialSessionSnapshot();
    const revived = JSON.parse(JSON.stringify(initial));
    expect(revived).toEqual(initial);
  });
});
