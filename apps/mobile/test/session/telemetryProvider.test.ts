import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Elm327Session, Elm327State, TelemetrySample } from '@circuit/core';
import { InMemorySettingsStore } from '../../src/session/settingsStore';
import { buildCustomPids, buildPollPlan, createTelemetryProvider } from '../../src/session/telemetryProvider';

/**
 * F2 MED fix test seam (binding): wraps the REAL `createElm327Session` so a
 * single test can force it to throw synchronously (simulating a session
 * CONSTRUCTION failure -- e.g. a future config-validation change, or a
 * transport-build failure) without affecting any other test in this file,
 * which all keep exercising the real implementation via
 * `importOriginal()`.
 */
vi.mock('@circuit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@circuit/core')>();
  return { ...actual, createElm327Session: vi.fn(actual.createElm327Session) };
});
import { createElm327Session } from '@circuit/core';

describe('buildPollPlan (Telemetry addendum — channel revision, binding)', () => {
  it('the default (transOilC unconfigured) plan omits transOilC entirely, in binding order', () => {
    expect(buildPollPlan('')).toEqual([
      { channel: 'rpm', hz: 5 },
      { channel: 'speedKph', hz: 5 },
      { channel: 'throttlePct', hz: 5 },
      { channel: 'engineOilC', hz: 0.5 },
      { channel: 'coolantC', hz: 0.2 },
    ]);
  });

  it('whitespace-only transOilPidHex is treated as unconfigured, same as empty', () => {
    expect(buildPollPlan('   ')).toEqual(buildPollPlan(''));
  });

  it('a configured transOilPidHex adds transOilC at 0.5Hz, between engineOilC and coolantC', () => {
    expect(buildPollPlan('221E0C')).toEqual([
      { channel: 'rpm', hz: 5 },
      { channel: 'speedKph', hz: 5 },
      { channel: 'throttlePct', hz: 5 },
      { channel: 'engineOilC', hz: 0.5 },
      { channel: 'transOilC', hz: 0.5 },
      { channel: 'coolantC', hz: 0.2 },
    ]);
  });
});

describe('buildCustomPids (Telemetry addendum — channel revision, binding: "normalized then sent verbatim")', () => {
  it('unconfigured (empty) transOilPidHex returns undefined, not an empty array', () => {
    expect(buildCustomPids('')).toBeUndefined();
  });

  it('whitespace-only transOilPidHex also returns undefined', () => {
    expect(buildCustomPids('   ')).toBeUndefined();
  });

  it('a configured transOilPidHex is normalized (outer whitespace trimmed) then sent verbatim as the transOilC custom request', () => {
    expect(buildCustomPids('221E0C')).toEqual([{ channel: 'transOilC', request: '221E0C' }]);
  });

  it('leading/trailing whitespace is trimmed, internal spacing preserved', () => {
    expect(buildCustomPids('  22 1E 0C  ')).toEqual([{ channel: 'transOilC', request: '22 1E 0C' }]);
  });

  /**
   * F1 HIGH fix (L2, binding): re-validated against the SAME read-service
   * whitelist L1 enforces (`customPidValidation.ts`) -- a persisted value
   * that fails it (saved before this rule existed, or written by any future
   * non-UI caller of `settingsStore.update`) is dropped, not forwarded, with
   * exactly one `console.warn`.
   */
  it('drops a persisted value whose service byte is not 21/22, with a console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(buildCustomPids('04')).toBeUndefined();
      expect(buildCustomPids('0101')).toBeUndefined();
      expect(buildCustomPids('015C')).toBeUndefined(); // F3: mode-01 collision with the standard engineOilC PID.
      expect(warnSpy).toHaveBeenCalledTimes(3);
      for (const call of warnSpy.mock.calls) {
        expect(String(call[0])).toContain('Only read services 21/22 allowed');
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('drops a persisted value with an odd compact hex length, with a console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(buildCustomPids('221E0')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still forwards a valid mode-21/22 request without warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(buildCustomPids('221E1C')).toEqual([{ channel: 'transOilC', request: '221E1C' }]);
      expect(buildCustomPids('21AB')).toEqual([{ channel: 'transOilC', request: '21AB' }]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * `telemetryProvider.ts` never reaches `react-native-tcp-socket` unless
 * `settings.telemetrySimulate` is false (the real-adapter path) -- these
 * tests exercise the simulated transport for the happy-path lifecycle, and
 * mock `./tcpObdTransport` (the SAME way `voiceCoach.test.ts` mocks
 * `expo-speech`/`expo-audio`) to force the real-adapter path to fail
 * deterministically, without ever loading the native module, for the
 * reconnect-policy tests.
 */
const tracker = vi.hoisted(() => ({
  connectCalls: 0,
  /** F3 test seam: when true, `connect()` returns a promise this test controls instead of rejecting immediately -- lets a test hold a session in 'connecting' indefinitely to construct a stop()/start() race deterministically. */
  holdConnect: false,
  pendingConnects: [] as Array<{ resolve: () => void; reject: (error: Error) => void }>,
}));

vi.mock('../../src/session/tcpObdTransport', () => ({
  TcpObdTransport: class {
    async connect(): Promise<void> {
      tracker.connectCalls += 1;
      if (tracker.holdConnect) {
        return new Promise<void>((resolve, reject) => {
          tracker.pendingConnects.push({ resolve, reject });
        });
      }
      throw new Error('adapter unreachable (test double)');
    }
    send(): void {}
    onData(): () => void {
      return () => undefined;
    }
    onClose(): () => void {
      return () => undefined;
    }
    async close(): Promise<void> {}
  },
}));

/** Drains the real microtask queue -- independent of fake vs. real timers (vi.useFakeTimers only replaces timer functions, never native Promise scheduling). */
async function flushMicrotasks(times = 15): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function monotonicCounter(): () => number {
  let t = 1_000;
  return () => {
    t += 1;
    return t;
  };
}

describe('telemetryProvider: start() with simulated transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers samples stamped with the injected monotonic clock, reaches polling, and stop() tears down (no further samples)', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true });

    // F8 fix: `telemetrySimulate` is now gated on `isDev` -- explicit `true`
    // here is what makes THIS test's simulated-transport happy path (still)
    // exercise the simulated transport, not the (mocked, always-failing)
    // real-adapter path.
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const samples: TelemetrySample[] = [];
    const states: Elm327State[] = [];
    provider.onSample((s) => samples.push(s));
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(states).toContain('polling');
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) expect(Number.isFinite(s.tMonoMs)).toBe(true);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]!.tMonoMs).toBeGreaterThanOrEqual(samples[i - 1]!.tMonoMs);
    }

    await provider.stop();
    expect(provider.getDiagnostics().state).toBe('stopped');

    const countAfterStop = samples.length;
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(samples.length).toBe(countAfterStop);
  });

  it('start() is a no-op when telemetryEnabled is false', async () => {
    const store = new InMemorySettingsStore(); // telemetryEnabled defaults to false.
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter() });

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(provider.getDiagnostics().state).toBe('idle');
  });
});

describe('telemetryProvider: reconnect policy (real-adapter path, mocked TcpObdTransport)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.connectCalls = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reaches 'failed', retries exactly ONCE after 3s, then stays failed (no further retries)", async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false });

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter() });
    const states: Elm327State[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(1);
    expect(states.at(-1)).toBe('failed');

    // Before the 3s retry delay elapses: no second attempt yet.
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(1);

    // The single retry fires at 3s.
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(2);
    expect(states.at(-1)).toBe('failed');

    // No further retries, no matter how long the provider is left running.
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(2);
  });

  it('a fresh start() after stop() resets the retry budget (a new session gets its own one retry)', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false });

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter() });
    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(2); // initial attempt + the one retry, used up.

    await provider.stop();
    provider.start();
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(3); // fresh session's first attempt.

    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(4); // fresh session's own retry fires too.
  });
});

describe('telemetryProvider: stop()/start() race is generation-scoped (F3 fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.connectCalls = 0;
    tracker.holdConnect = true;
    tracker.pendingConnects = [];
  });
  afterEach(async () => {
    tracker.holdConnect = false;
    vi.useRealTimers();
  });

  it('a start() during a still-pending stop() gets a fresh generation the old stop() cannot detach -- the OLD session\'s late "stopped" is dropped, and the NEW session keeps forwarding state after', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false });
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter() });
    const states: Elm327State[] = [];
    provider.onStateChange((s) => states.push(s));

    // Generation 1: connect() held pending ('connecting').
    provider.start();
    await flushMicrotasks();
    expect(tracker.pendingConnects).toHaveLength(1);
    const gen1Connect = tracker.pendingConnects[0]!;

    // stop() called while generation 1 is still connecting -- it awaits
    // generation 1's own `session.stop()`, which itself awaits the SAME
    // pending connect() (Elm327Session.stop() awaits its in-flight run()).
    // Neither has settled yet, so this promise is still pending here.
    const stopPromise = provider.stop();
    await flushMicrotasks();

    // A start() while that stop() is still in flight gets generation 2.
    provider.start();
    await flushMicrotasks();
    expect(tracker.pendingConnects).toHaveLength(2);
    const gen2Connect = tracker.pendingConnects[1]!;
    // F10 fix: the leading 'idle' is `onStateChange`'s own immediate replay
    // of the current state at subscribe time (subscribed above before
    // either generation started).
    expect(states).toEqual(['idle', 'connecting', 'connecting']); // both genuinely-live starts are forwarded.

    // Let generation 1 fail its connect() -- its `run()` sees `stopRequested`
    // and settles down to 'stopped' WITHOUT throwing, resolving the pending
    // stop() from above.
    gen1Connect.reject(new Error('gen1 connect aborted'));
    await stopPromise;
    await flushMicrotasks();

    // Generation 1's late 'stopped' must be DROPPED (it is a stale
    // generation once generation 2 exists) -- states must NOT have gained a
    // 'stopped' entry that has nothing to do with generation 2, which is
    // still the genuinely-live session.
    expect(states).toEqual(['idle', 'connecting', 'connecting']);

    // Generation 2 is still alive and must keep forwarding its OWN events --
    // the pre-fix bug used generation 1's stop() to (wrongly) detach
    // generation 2's listeners via shared fields, permanently freezing
    // `states` at whatever generation 1 left it at.
    gen2Connect.reject(new Error('gen2 connect also fails'));
    await flushMicrotasks();

    expect(states).toEqual(['idle', 'connecting', 'connecting', 'failed']);
    expect(provider.getDiagnostics().state).toBe('failed');

    await provider.stop(); // cleanup: cancels generation 2's own reconnect-retry timer.
  });
});

describe('telemetryProvider: onStateChange replays the current state on subscribe (F10 fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.connectCalls = 0;
    tracker.holdConnect = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a late subscriber sees the CURRENT state synchronously, not just future transitions', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false });
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter() });

    // No subscriber yet -- the provider still reaches 'failed' (the mocked
    // TcpObdTransport always rejects immediately).
    provider.start();
    await flushMicrotasks();
    expect(provider.getDiagnostics().state).toBe('failed');

    // A screen mounting AFTER that point (TelemetryScreen's own bug,
    // Codex's finding) must see 'failed' immediately on subscribe, not stay
    // on whatever default it initialized to until the next transition.
    const seen: Elm327State[] = [];
    provider.onStateChange((s) => seen.push(s));
    expect(seen).toEqual(['failed']);
  });
});

describe('telemetryProvider: telemetrySimulate is gated on isDev (F8 fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.connectCalls = 0;
    tracker.holdConnect = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a non-dev build (isDev: false) ignores telemetrySimulate=true and still builds the TCP transport path', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true });

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: false,
    });
    const states: Elm327State[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();

    // The transport-factory spy: the (mocked) TcpObdTransport's connect()
    // was actually reached, proving the REAL-adapter path was built, not
    // `SimulatedElm327Transport` (which never touches `tcpObdTransport.ts`
    // at all and would never reach 'failed' from a rejected connect()).
    expect(tracker.connectCalls).toBe(1);
    expect(states.at(-1)).toBe('failed');
  });

  it('omitting isDev falls back to the real `__DEV__` global, which is undefined under vitest -- same as isDev: false', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true });

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter() });
    provider.start();
    await flushMicrotasks();

    expect(tracker.connectCalls).toBe(1);
    expect(provider.getDiagnostics().state).toBe('failed');
  });
});

describe('telemetryProvider: start() isolates a synchronous session-construction throw (F2 MED fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a synchronous throw from createElm327Session resets running=false and reports failed, without wedging the provider', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true });
    vi.mocked(createElm327Session).mockImplementationOnce(() => {
      throw new Error('boom: synchronous session construction failure (test double)');
    });

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const states: Elm327State[] = [];
    const details: Array<string | undefined> = [];
    provider.onStateChange((s, d) => {
      states.push(s);
      details.push(d);
    });

    // Must not throw OUT of start() -- the whole point of the fix.
    expect(() => provider.start()).not.toThrow();
    await flushMicrotasks();

    expect(provider.getDiagnostics().state).toBe('failed');
    expect(states.at(-1)).toBe('failed');
    expect(details.at(-1)).toContain('boom: synchronous session construction failure');

    // Not wedged: running was reset to false, so a second start() (now
    // reaching the real, non-throwing implementation) proceeds normally
    // instead of being swallowed by the stale `if (running) return;` guard.
    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(provider.getDiagnostics().state).toBe('polling');

    await provider.stop();
  });
});

/**
 * P4e-FIX5 MED fix (binding, Codex P4e-REV5): the ENET-only reservation work
 * (P4e-FIX4) introduced an unconditional `finally` around `stop()`'s
 * cleanup that also applied to ELM327 -- a rejecting ELM `session.stop()`
 * used to leave listener/diagnostics state INTACT (no unsubscribe, no
 * `current` clearing -- the behavior at HEAD 3027d94, before that wave),
 * but started being cleared regardless of the rejection. This pins the
 * restored, byte-identical ELM327 behavior directly against a
 * hand-built `Elm327Session` double whose `stop()` rejects.
 */
describe('telemetryProvider: ELM327 stop() semantics are byte-identical to pre-P4e-FIX4 (P4e-FIX5, binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a rejecting ELM stop() leaves listener/diagnostics state intact -- unsubscribe and current-clearing are SKIPPED, matching pre-wave behavior', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true }); // adapterType defaults to 'elm327'.

    const stateListeners = new Set<(state: Elm327State, detail?: string) => void>();
    let stateUnsubscribed = false;
    let sampleUnsubscribed = false;
    const stopError = new Error('ELM stop failed (test double)');
    const fakeSession: Elm327Session = {
      start(): void {
        queueMicrotask(() => {
          for (const listener of [...stateListeners]) listener('polling');
        });
      },
      stop(): Promise<void> {
        return Promise.reject(stopError);
      },
      onSample(): () => void {
        return () => {
          sampleUnsubscribed = true;
        };
      },
      onStateChange(cb: (state: Elm327State, detail?: string) => void): () => void {
        stateListeners.add(cb);
        return () => {
          stateListeners.delete(cb);
          stateUnsubscribed = true;
        };
      },
      getDiagnostics() {
        return { observedHzByChannel: { rpm: 5 }, errorCount: 3, lastError: 'diagnostic sentinel' };
      },
    };
    vi.mocked(createElm327Session).mockImplementationOnce(() => fakeSession);

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(provider.getDiagnostics().state).toBe('polling');
    expect(provider.getDiagnostics().errorCount).toBe(3);
    expect(provider.getDiagnostics().lastError).toBe('diagnostic sentinel');

    await expect(provider.stop()).rejects.toBe(stopError);

    // Byte-identical to pre-P4e-FIX4 (HEAD 3027d94) behavior: a rejecting
    // stop() propagates immediately, BEFORE any cleanup runs -- the
    // generation's own listeners are still subscribed, `current` still
    // points at it, and `getDiagnostics()` still reads its (unchanged) live
    // values straight through.
    expect(stateUnsubscribed).toBe(false);
    expect(sampleUnsubscribed).toBe(false);
    expect(provider.getDiagnostics().state).toBe('polling');
    expect(provider.getDiagnostics().errorCount).toBe(3);
    expect(provider.getDiagnostics().lastError).toBe('diagnostic sentinel');
  });
});
