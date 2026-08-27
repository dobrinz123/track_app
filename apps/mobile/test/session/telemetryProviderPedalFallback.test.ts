import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Elm327State, TelemetrySample } from '@circuit/core';
import { InMemorySettingsStore } from '../../src/session/settingsStore';
import { createTelemetryProvider } from '../../src/session/telemetryProvider';

/**
 * Field revision 2 (2026-08-27, binding — Phase 4h, P4h ticket item 3):
 * "primary source PID 0x5A ... if the DME answers NRC/unsupported for 0x5A,
 * fall back to 0x49 with a learned rest offset."
 *
 * A DEDICATED scriptable mock `TcpObdTransport` -- separate from
 * `telemetryProvider.test.ts`'s own minimal tracker (which never answers
 * ANY command, so a session built on it can never reach 'polling') -- this
 * one answers ELM327 init commands normally and PID requests per a
 * per-PID script, exercising the REAL `elm327Session.ts` + `pidCodec.ts`
 * decode path end-to-end, exactly what the pedal PID fallback needs proven
 * at the PROVIDER level.
 */
const pidScript = vi.hoisted(() => ({
  /** PIDs (uppercase 2 hex chars) that always answer "NO DATA", regardless of any byte script below. */
  noDataOnPids: new Set<string>(),
  /** PID -> queue of raw BYTE values (0-255) to answer with, in order; once exhausted, the LAST value repeats. Unlisted PIDs fall back to `DEFAULT_BYTE_RESPONSES` if present, else NO DATA. */
  byteSequenceByPid: new Map<string, number[]>(),
  /** Per-PID consumption index into `byteSequenceByPid`, so successive requests for the SAME pid advance through its script. */
  pidRequestCount: new Map<string, number>(),
}));

/** Sane, unchanging defaults for every channel this app's poll plan always includes EXCEPT accelPedalPct (which every test scripts explicitly) -- rpm needs 2 bytes, everything else 1. */
const DEFAULT_BYTE_RESPONSES: Record<string, string> = {
  '0C': '1A F8', // rpm (2 bytes) -- an arbitrary plausible value; no test asserts on it.
  '0D': '32', // speedKph = 50 -- overridden per-test via byteSequenceByPid when "at rest" (0) matters.
  '11': '28', // throttlePct.
  '05': '64', // coolantC.
  '5C': '64', // engineOilC.
};

function nextByteFor(pid: string): string | null {
  if (pidScript.noDataOnPids.has(pid)) return null;
  const sequence = pidScript.byteSequenceByPid.get(pid);
  if (sequence !== undefined && sequence.length > 0) {
    const index = pidScript.pidRequestCount.get(pid) ?? 0;
    const boundedIndex = Math.min(index, sequence.length - 1);
    pidScript.pidRequestCount.set(pid, index + 1);
    const byte = sequence[boundedIndex]!;
    return Math.max(0, Math.min(255, Math.round(byte))).toString(16).padStart(2, '0').toUpperCase();
  }
  return DEFAULT_BYTE_RESPONSES[pid] ?? null;
}

function buildResponse(command: string): string {
  switch (command) {
    case 'ATZ':
      return 'ELM327 v2.2\r';
    case 'ATE0':
    case 'ATL0':
    case 'ATS0':
    case 'ATSP0':
      return 'OK\r';
    default: {
      const match = /^01([0-9A-F]{2})$/.exec(command);
      if (match === null) return '?\r';
      const pid = match[1]!;
      const byteHex = nextByteFor(pid);
      if (byteHex === null) return 'NO DATA\r';
      return `41 ${pid} ${byteHex}\r`;
    }
  }
}

/**
 * P4h-FIX2 F1: counts the RAW transports this provider constructed/closed --
 * the direct evidence for "never two sessions/transports" (a second
 * transport constructed and then orphaned by an overwrite of `current` shows
 * up here as `constructed - closed > 1`).
 */
const transportTracker = vi.hoisted(() => ({ constructed: 0, closedIds: new Set<number>() }));

vi.mock('../../src/session/tcpObdTransport', () => ({
  TcpObdTransport: class {
    private dataListener: ((chunk: string) => void) | null = null;
    /** Identifies THIS transport instance, so a double-close of the same one (the teardown's graceful stop plus its 200 ms force-close race) is not mistaken for two closed transports. */
    private readonly id: number;
    constructor() {
      transportTracker.constructed += 1;
      this.id = transportTracker.constructed;
    }
    async connect(): Promise<void> {}
    send(line: string): void {
      const command = line.replace(/[\r\n\s]+/g, '').toUpperCase();
      queueMicrotask(() => {
        this.dataListener?.(`${buildResponse(command)}>`);
      });
    }
    onData(cb: (chunk: string) => void): () => void {
      this.dataListener = cb;
      return () => {
        this.dataListener = null;
      };
    }
    onClose(): () => void {
      return () => undefined;
    }
    async close(): Promise<void> {
      transportTracker.closedIds.add(this.id);
    }
  },
}));

/**
 * P4h-FIX1 H5: wraps the REAL `createElm327Session` so a test can COUNT the
 * generations this provider actually built -- the only direct evidence that a
 * fallback relaunch did (or did not) happen after a Stop.
 */
vi.mock('@circuit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@circuit/core')>();
  return { ...actual, createElm327Session: vi.fn(actual.createElm327Session) };
});
import { createElm327Session } from '@circuit/core';

async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function sessionsBuilt(): number {
  return vi.mocked(createElm327Session).mock.calls.length;
}

function monotonicCounter(): () => number {
  let t = 1_000;
  return () => {
    t += 1;
    return t;
  };
}

function byteFor(pct: number): number {
  return Math.round((pct * 255) / 100);
}

describe('telemetryProvider: accelPedalPct PID fallback (Field revision 2, binding, P4h)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(createElm327Session).mockClear();
    pidScript.noDataOnPids.clear();
    pidScript.byteSequenceByPid.clear();
    pidScript.pidRequestCount.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('0x5A supported -> used as-is (no normalization), diagnostics.pedalSource stays "5A"', async () => {
    pidScript.byteSequenceByPid.set('5A', [byteFor(31.4)]); // ~31.4% -- forwarded UNNORMALIZED.
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'elm327' });
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const states: Elm327State[] = [];
    const samples: TelemetrySample[] = [];
    provider.onStateChange((s) => states.push(s));
    provider.onSample((s) => samples.push(s));

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(states.at(-1)).toBe('polling');
    expect(provider.getDiagnostics().pedalSource).toBe('5A');
    const pedalSamples = samples.filter((s) => s.channel === 'accelPedalPct');
    expect(pedalSamples.length).toBeGreaterThan(0);
    expect(pedalSamples[0]!.value).toBeCloseTo(31.4, 0);

    await provider.stop();
  });

  it('0x5A NO DATA -> after the grace window, switches to 0x49 normalized; the first at-rest sample establishes the offset (normalizes to 0%), a later higher sample normalizes toward the ticket\'s "~28%" class', async () => {
    pidScript.noDataOnPids.add('5A'); // primary source unsupported the whole time.
    // 0x49's own script: first requests answer ~15% (at rest, establishes
    // the offset), later requests answer ~39% (still "at rest" per the
    // speedKph script below, so it never lowers the already-learned
    // offset) -- mirrors contracts.md's exact vector class.
    pidScript.byteSequenceByPid.set('49', [byteFor(15), byteFor(15), byteFor(15), byteFor(39)]);
    // speedKph stays 0 throughout -- every accelPedalPct sample counts as "at rest" for the offset learner.
    pidScript.byteSequenceByPid.set('0D', [0]);

    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'elm327' });
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const states: Elm327State[] = [];
    const samples: TelemetrySample[] = [];
    provider.onStateChange((s) => states.push(s));
    provider.onSample((s) => samples.push(s));

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(states.at(-1)).toBe('polling');
    expect(provider.getDiagnostics().pedalSource).toBe('5A'); // not yet -- the grace window hasn't elapsed.
    expect(samples.some((s) => s.channel === 'accelPedalPct')).toBe(false); // 0x5A never answers.

    // The grace window elapses -- no accelPedalPct sample arrived -- the
    // fallback triggers: teardown, `setAccelPedalPidSource('49')`, relaunch.
    await vi.advanceTimersByTimeAsync(8_000);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000); // the fresh (relaunched) generation reconnects and reaches polling.
    await flushMicrotasks();

    expect(provider.getDiagnostics().pedalSource).toBe('49-normalized');
    expect(states.at(-1)).toBe('polling'); // the relaunched generation is healthy, not stuck/failed.

    await vi.advanceTimersByTimeAsync(2_000); // let several accelPedalPct polls land.
    await flushMicrotasks();

    const pedalSamples = samples.filter((s) => s.channel === 'accelPedalPct');
    expect(pedalSamples.length).toBeGreaterThan(0);
    // The FIRST (at-rest, ~15%) sample establishes the offset AS ITSELF --
    // normalizing it against its own newly-learned floor always yields 0%
    // (contracts.md: "raw 15 -> 0%").
    expect(pedalSamples[0]!.value).toBeCloseTo(0, 0);
    // A LATER (~39%) sample, normalized against that SAME learned offset,
    // lands in the ticket's "~28%" class (contracts.md: "raw 39 -> ~28%").
    const laterSample = pedalSamples.at(-1)!;
    expect(laterSample.value).toBeGreaterThan(20);
    expect(laterSample.value).toBeLessThan(35);

    await provider.stop();
  });
});

/**
 * P4h-FIX1 H5 (after Codex P4h-REV1 HIGH, `telemetryProvider.ts:621-661,1302-1337`):
 * "pressing Stop while fallback teardown is underway can restart telemetry
 * after Stop completes. `triggerPedalFallback()` always runs
 * `doStop().then(relaunch, relaunch)`; its relaunch guard checks only the
 * settings fingerprint, not an explicit Stop or lifecycle generation."
 */
describe('telemetryProvider: Stop during the pedal-fallback teardown (P4h-FIX1 H5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(createElm327Session).mockClear();
    pidScript.noDataOnPids.clear();
    pidScript.byteSequenceByPid.clear();
    pidScript.pidRequestCount.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Stop issued while the fallback is tearing down leaves the provider STOPPED -- no relaunch, no new session generation', async () => {
    pidScript.noDataOnPids.add('5A'); // forces the fallback path.
    pidScript.byteSequenceByPid.set('49', [byteFor(15)]);
    pidScript.byteSequenceByPid.set('0D', [0]);

    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'elm327' });
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const states: Elm327State[] = [];
    const samples: TelemetrySample[] = [];
    provider.onStateChange((s) => states.push(s));
    provider.onSample((s) => samples.push(s));

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(states.at(-1)).toBe('polling');
    expect(sessionsBuilt()).toBe(1);

    // Fire the 8s fallback-check timer SYNCHRONOUSLY: `triggerPedalFallback()`
    // runs and its `doStop()` teardown is now in flight, its relaunch
    // continuation still queued...
    vi.advanceTimersByTime(8_000);
    // ...and the user presses Stop in exactly that window.
    const stopped = provider.stop();
    await flushMicrotasks();
    await stopped;
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10_000); // give any (wrong) relaunch every chance to appear.
    await flushMicrotasks();

    // The provider stayed stopped: no second generation was ever built...
    expect(sessionsBuilt()).toBe(1);
    // ...and it is not polling again.
    expect(provider.getDiagnostics().state).not.toBe('polling');
    expect(states.at(-1)).not.toBe('polling');
    // 0x49 was never polled, because the relaunch never happened.
    expect(samples.filter((s) => s.channel === 'accelPedalPct')).toHaveLength(0);

    await provider.stop(); // idempotent.
  });

  it('two concurrent stop() calls share one teardown (no latch overwrite) and both settle', async () => {
    pidScript.byteSequenceByPid.set('5A', [byteFor(20)]);
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'elm327' });
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(provider.getDiagnostics().state).toBe('polling');

    const first = provider.stop();
    const second = provider.stop();
    await flushMicrotasks();
    await Promise.all([first, second]);
    await flushMicrotasks();

    expect(provider.getDiagnostics().state).not.toBe('polling');
    expect(sessionsBuilt()).toBe(1);
  });
});

/**
 * P4h-FIX2 F1 (after Codex P4h-REV2 HIGH, `telemetryProvider.ts:697,1688`):
 * "fallback lifecycle is still racy with an intervening Start. During fallback
 * teardown, Start queues `launchFresh()` on `stopping`; that promise resolves
 * before `stopShared()` invokes the fallback's own `relaunch`. Both
 * continuations can therefore launch ... two sessions/transports are
 * constructed and one is overwritten without teardown."
 *
 * Binding fix (ticket P4h-FIX2): ONE lifecycle intent -- every deferred launch
 * (public Start, fallback relaunch) runs through `launchAfterStop(generation)`,
 * a public Start bumps the lifecycle generation, and the older fallback
 * continuation therefore sees its generation stale and exits.
 */
describe('telemetryProvider: Start during the pedal-fallback teardown (P4h-FIX2 F1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(createElm327Session).mockClear();
    pidScript.noDataOnPids.clear();
    pidScript.byteSequenceByPid.clear();
    pidScript.pidRequestCount.clear();
    transportTracker.constructed = 0;
    transportTracker.closedIds.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Start tapped while the fallback is tearing down launches EXACTLY ONE session (the fallback relaunch is superseded, not doubled) and resolves the source from settings', async () => {
    pidScript.noDataOnPids.add('5A'); // forces the fallback path.
    pidScript.byteSequenceByPid.set('49', [byteFor(15)]);
    pidScript.byteSequenceByPid.set('0D', [0]);

    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'elm327' });
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const states: Elm327State[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(states.at(-1)).toBe('polling');
    expect(sessionsBuilt()).toBe(1);
    expect(transportTracker.constructed).toBe(1);

    // Fire the 8s fallback-check timer SYNCHRONOUSLY: `triggerPedalFallback()`
    // ran, its teardown is in flight and its relaunch continuation is queued...
    vi.advanceTimersByTime(8_000);
    // ...and the user taps Start in exactly that window (the monitor briefly
    // showed "stopped").
    provider.start();
    await flushMicrotasks();
    // Deliberately well SHORT of another 8s grace window, so nothing here can
    // be a second, legitimate fallback.
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    // HEAD (74a21e9): the queued Start's `launchFresh()` AND the fallback's own
    // `relaunch()` both fire -- 3 sessions, 3 transports, one generation
    // overwritten without teardown.
    expect(sessionsBuilt()).toBe(2);
    expect(transportTracker.constructed).toBe(2);
    // Exactly ONE transport is live: the torn-down generation's was closed,
    // and no orphan was left behind by an overwrite.
    expect(transportTracker.constructed - transportTracker.closedIds.size).toBe(1);
    // The Start won: the source is resolved from settings again (0x5A), not
    // left on the fallback's 0x49.
    expect(provider.getDiagnostics().pedalSource).toBe('5A');
    expect(provider.getDiagnostics().state).toBe('polling');

    await provider.stop();
  });
});

/**
 * P4h-FIX1 M3+M4 (after Codex P4h-REV1 MEDIUM, `pedalNormalization.ts:32-64`;
 * `telemetryProvider.ts:674-684`): "a valid 0x49 byte `FF` observed at speed
 * zero therefore causes emitted pedal samples to become `NaN`", and
 * "diagnostics still say `49-normalized`, although no normalization was
 * learned."
 */
describe('telemetryProvider: 0x49 fallback diagnostics honesty (P4h-FIX1 M3+M4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(createElm327Session).mockClear();
    pidScript.noDataOnPids.clear();
    pidScript.byteSequenceByPid.clear();
    pidScript.pidRequestCount.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Starts a provider, lets the 0x5A grace window elapse, and returns it once the 0x49 generation is polling. */
  async function startFallenBackProvider(): Promise<{
    provider: ReturnType<typeof createTelemetryProvider>;
    samples: TelemetrySample[];
  }> {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'elm327' });
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const samples: TelemetrySample[] = [];
    provider.onSample((s) => samples.push(s));
    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(8_000); // grace window -> fallback.
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000); // the relaunched generation reaches polling.
    await flushMicrotasks();
    return { provider, samples };
  }

  it('0x49 reading FF (100 %) at rest: no NaN is ever emitted, and diagnostics report "49-raw" rather than a normalization that never happened', async () => {
    pidScript.noDataOnPids.add('5A');
    pidScript.byteSequenceByPid.set('49', [255]); // FF -> 100 % raw at rest -> the old offset-100 => 0/0 => NaN.
    pidScript.byteSequenceByPid.set('0D', [0]); // at rest throughout.

    const { provider, samples } = await startFallenBackProvider();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    const pedalSamples = samples.filter((s) => s.channel === 'accelPedalPct');
    expect(pedalSamples.length).toBeGreaterThan(0);
    expect(pedalSamples.every((s) => Number.isFinite(s.value))).toBe(true);
    // A >= 95 % "rest offset" is not credible -- the raw value is kept as-is.
    expect(pedalSamples.every((s) => s.value === 100)).toBe(true);
    expect(provider.getDiagnostics().pedalSource).toBe('49-raw');

    await provider.stop();
  });

  it('the car never stops during the learning window: no offset is learned, so diagnostics say "49-raw" and the values stay raw', async () => {
    pidScript.noDataOnPids.add('5A');
    pidScript.byteSequenceByPid.set('49', [byteFor(39)]);
    pidScript.byteSequenceByPid.set('0D', [50]); // 50 km/h throughout -- never at rest.

    const { provider, samples } = await startFallenBackProvider();
    await vi.advanceTimersByTimeAsync(12_000); // well past the 10s learning window.
    await flushMicrotasks();

    expect(provider.getDiagnostics().pedalSource).toBe('49-raw');
    const pedalSamples = samples.filter((s) => s.channel === 'accelPedalPct');
    expect(pedalSamples.length).toBeGreaterThan(0);
    expect(pedalSamples.at(-1)!.value).toBeCloseTo(39, 0); // raw 0x49 percentage, unnormalized.

    await provider.stop();
  });

  it('once a real rest offset IS learned, diagnostics flip to "49-normalized"', async () => {
    pidScript.noDataOnPids.add('5A');
    pidScript.byteSequenceByPid.set('49', [byteFor(15), byteFor(15), byteFor(15), byteFor(39)]);
    pidScript.byteSequenceByPid.set('0D', [0]);

    const { provider } = await startFallenBackProvider();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(provider.getDiagnostics().pedalSource).toBe('49-normalized');
    await provider.stop();
  });
});
