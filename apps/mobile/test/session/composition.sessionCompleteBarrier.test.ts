import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `relaySessionCompleteBarrier` (Telemetry addendum — P4b amendment,
 * binding): a free, plain-TS function in `composition.ts` with no
 * SQLite/GNSS/React dependency of its own (MUST DO #1) -- these tests drive
 * it directly with hand-built promises/fake timers, never booting a real
 * session. Importing `composition.ts` at all still requires the SAME
 * minimal module-load mocks every other `composition.*.test.ts` file in this
 * directory uses (its module body kicks off `runBootstrap()` at import time)
 * -- here `openAppDatabase` is left rejecting, since none of these tests
 * exercise bootstrap itself; that rejection is caught internally by
 * `runBootstrap()` and never surfaces as an unhandled rejection.
 */
vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'session-complete-barrier-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubGnssLocationProvider {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    subscribe(): () => void {
      return () => undefined;
    }
    getDiagnostics(): unknown {
      return {
        samplesEmitted: 0,
        samplesRejectedMocked: 0,
        sampleIntervalHistogramMs: [],
        accuracyDistributionM: { sampleCount: 0, minM: null, p50M: null, p95M: null },
        reducedAccuracy: false,
      };
    }
  }
  class StubClock {
    now(): number {
      return Date.now();
    }
  }
  return {
    GnssLocationProvider: StubGnssLocationProvider,
    PerformanceNowClock: StubClock,
    ReplayLocationProvider: class {},
    startLifecycleListener: () => {},
  };
});

vi.mock('../../src/persistence/expoSqlDatabase', () => ({
  openAppDatabase: async () => {
    throw new Error('sessionCompleteBarrier tests never need a real on-device database');
  },
}));

import { relaySessionCompleteBarrier } from '../../src/session/composition';

interface TestState {
  sessionState: string;
  seq: number;
}

function state(sessionState: string, seq: number): TestState {
  return { sessionState, seq };
}

/** Flushes a handful of microtask turns -- enough for a chain of `.then()`s (barrier settle -> `finish()` -> `emit()`) to run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('relaySessionCompleteBarrier (Telemetry addendum — P4b amendment, binding)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('holds sessionComplete until the barrier promise settles, then relays it exactly once', async () => {
    const emitted: TestState[] = [];
    let resolveBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });
    const relay = relaySessionCompleteBarrier<TestState>(() => barrier, 2_000, (s) => emitted.push(s));

    relay(state('sessionComplete', 1));
    await flushMicrotasks();
    expect(emitted).toHaveLength(0);

    resolveBarrier();
    await flushMicrotasks();

    expect(emitted).toEqual([state('sessionComplete', 1)]);
  });

  it('caps the hold at 2000ms when the barrier promise never settles (hung telemetry shutdown)', () => {
    vi.useFakeTimers();
    try {
      const emitted: TestState[] = [];
      const hungBarrier = new Promise<void>(() => {}); // intentionally never settles
      const relay = relaySessionCompleteBarrier<TestState>(() => hungBarrier, 2_000, (s) => emitted.push(s));

      relay(state('sessionComplete', 1));
      expect(emitted).toHaveLength(0);

      vi.advanceTimersByTime(1_999);
      expect(emitted).toHaveLength(0);

      vi.advanceTimersByTime(1);
      expect(emitted).toEqual([state('sessionComplete', 1)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a REJECTED barrier promise still relays the state (allSettled semantics) instead of throwing or blocking past the cap', async () => {
    const emitted: TestState[] = [];
    const rejecting = Promise.reject(new Error('telemetry shutdown failed (test)'));
    const relay = relaySessionCompleteBarrier<TestState>(() => rejecting, 2_000, (s) => emitted.push(s));

    expect(() => relay(state('sessionComplete', 1))).not.toThrow();
    await flushMicrotasks();

    expect(emitted).toEqual([state('sessionComplete', 1)]);
  });

  it('zero added latency when there is nothing to wait for (getBarrier returns null) -- no timer, straight through synchronously', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const emitted: TestState[] = [];
    const relay = relaySessionCompleteBarrier<TestState>(() => null, 2_000, (s) => emitted.push(s));

    relay(state('sessionComplete', 1));

    // Relayed SYNCHRONOUSLY -- no await needed to observe it.
    expect(emitted).toEqual([state('sessionComplete', 1)]);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('every non-sessionComplete state passes straight through immediately, untouched, even with a barrier configured', () => {
    const emitted: TestState[] = [];
    const relay = relaySessionCompleteBarrier<TestState>(
      () => new Promise(() => {}),
      2_000,
      (s) => emitted.push(s),
    );

    relay(state('idle', 1));
    relay(state('timing', 2));
    relay(state('paused', 3));

    expect(emitted).toEqual([state('idle', 1), state('timing', 2), state('paused', 3)]);
  });

  it('ordering: states arriving while sessionComplete is held are queued and relayed, in order, only AFTER it -- never overtaking it', async () => {
    const emitted: TestState[] = [];
    let resolveBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });
    const relay = relaySessionCompleteBarrier<TestState>(() => barrier, 2_000, (s) => emitted.push(s));

    relay(state('sessionComplete', 1));
    relay(state('idle', 2)); // arrives while the hold is in progress -- must not overtake.
    relay(state('outLap', 3));

    expect(emitted).toHaveLength(0);

    resolveBarrier();
    await flushMicrotasks();

    expect(emitted).toEqual([state('sessionComplete', 1), state('idle', 2), state('outLap', 3)]);
  });
});
