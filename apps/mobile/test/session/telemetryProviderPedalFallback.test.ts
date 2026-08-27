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

vi.mock('../../src/session/tcpObdTransport', () => ({
  TcpObdTransport: class {
    private dataListener: ((chunk: string) => void) | null = null;
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
    async close(): Promise<void> {}
  },
}));

async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
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
