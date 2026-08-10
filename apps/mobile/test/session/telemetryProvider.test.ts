import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Elm327State, TelemetrySample } from '@circuit/core';
import { InMemorySettingsStore } from '../../src/session/settingsStore';
import { createTelemetryProvider } from '../../src/session/telemetryProvider';

/**
 * `telemetryProvider.ts` never reaches `react-native-tcp-socket` unless
 * `settings.telemetrySimulate` is false (the real-adapter path) -- these
 * tests exercise the simulated transport for the happy-path lifecycle, and
 * mock `./tcpObdTransport` (the SAME way `voiceCoach.test.ts` mocks
 * `expo-speech`/`expo-audio`) to force the real-adapter path to fail
 * deterministically, without ever loading the native module, for the
 * reconnect-policy tests.
 */
const tracker = vi.hoisted(() => ({ connectCalls: 0 }));

vi.mock('../../src/session/tcpObdTransport', () => ({
  TcpObdTransport: class {
    async connect(): Promise<void> {
      tracker.connectCalls += 1;
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

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter() });
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
