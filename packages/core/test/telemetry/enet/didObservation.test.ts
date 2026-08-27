import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyResponders } from '../../../src/telemetry/enet/didHeuristics';
import { runDidObservation, type DidSweepControl, type SweepTransport } from '../../../src/telemetry/enet/didSweep';
import { FakeClock } from '../../controller/testSupport';

afterEach(() => {
  vi.useRealTimers();
});

function positiveRaw(did: number, dataBytes: number[]): Uint8Array {
  return Uint8Array.from([0x62, (did >> 8) & 0xff, did & 0xff, ...dataBytes]);
}
function didOf(pdu: Uint8Array): number {
  return ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
}
function control(overrides: Partial<DidSweepControl> = {}): DidSweepControl {
  return { paused: false, stopped: false, ...overrides };
}

/** Same shape/contract as `didSweep.test.ts`'s double: records every `send`/`keepAlive` pdu, delegates `nextResponse` to a per-test handler. */
function makeTransport(overrides: {
  send?: (pdu: Uint8Array, sentPdus: readonly Uint8Array[]) => Promise<void> | void;
  nextResponse?: (timeoutMs: number, sentPdus: readonly Uint8Array[], callNumber: number) => Promise<Uint8Array | 'timeout'> | Uint8Array | 'timeout';
  keepAlive?: (pdu: Uint8Array) => Promise<void> | void;
} = {}): SweepTransport & { sentPdus: Uint8Array[]; keepAlivePdus: Uint8Array[] } {
  const sentPdus: Uint8Array[] = [];
  const keepAlivePdus: Uint8Array[] = [];
  let nextResponseCalls = 0;
  return {
    sentPdus,
    keepAlivePdus,
    async send(pdu) {
      sentPdus.push(pdu);
      if (overrides.send) await overrides.send(pdu, sentPdus);
    },
    async nextResponse(timeoutMs) {
      nextResponseCalls += 1;
      if (overrides.nextResponse) return await overrides.nextResponse(timeoutMs, sentPdus, nextResponseCalls);
      return 'timeout';
    },
    async keepAlive(pdu) {
      keepAlivePdus.push(pdu);
      if (overrides.keepAlive) await overrides.keepAlive(pdu);
    },
  };
}

describe('runDidObservation', () => {
  it('returns an empty result immediately for zero responders', async () => {
    const result = await runDidObservation({
      responders: [],
      transport: makeTransport(),
      clock: new FakeClock(),
      durationMs: 10_000,
      control: control(),
    });
    expect(result).toEqual({ series: [], errors: 0, cadenceDegraded: false });
  });

  it('[REV3] keep-alive fires during a 10s window of FAST responses -- owned by the one loop, not reset per poll', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const responders = [0x1e1c, 0x1e20, 0x1e24];
    const transport = makeTransport({
      send: () => {
        clock.advance(50); // a fast response -- well under the old per-poll "reset every 2s" bug window
      },
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });

    const resultPromise = runDidObservation({
      responders,
      transport,
      clock,
      durationMs: 10_000,
      targetHz: 1,
      control: control(),
      keepAliveIntervalMs: 2_000,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    // Before the fix: re-invoking a per-DID runner for every fast poll reset
    // the keep-alive deadline every time, so a whole fast-responding window
    // sent ZERO TesterPresent frames. One continuous loop must send several.
    expect(transport.keepAlivePdus.length).toBeGreaterThanOrEqual(3);
    for (const pdu of transport.keepAlivePdus) {
      expect(Array.from(pdu)).toEqual([0x3e, 0x80]);
    }
    expect(result.series).toHaveLength(3);
  });

  it('the consecutive-error budget stops the run before the window elapses', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = makeTransport({
      send: () => {
        throw new Error('always fails');
      },
    });

    const resultPromise = runDidObservation({
      responders: [1, 2, 3],
      transport,
      clock,
      durationMs: 60_000,
      control: control(),
      maxConsecutiveErrors: 3,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.errors).toBe(3);
    expect(clock.now()).toBeLessThan(60_000); // stopped well before the full window
    expect(result.series.every((s) => s.samples.length === 0)).toBe(true);
  });

  it('reports cadenceDegraded when a round (one poll of every responder) exceeds 1000/targetHz', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const responders = [1, 2, 3, 4, 5];
    const transport = makeTransport({
      send: () => {
        clock.advance(300); // 5 responders * 300ms = 1500ms/round > the 1000ms (targetHz=1) budget
      },
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });

    const resultPromise = runDidObservation({
      responders,
      transport,
      clock,
      durationMs: 1_600, // just over one round -- fast test, one clear round to inspect
      targetHz: 1,
      control: control(),
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.cadenceDegraded).toBe(true);
  });

  it('does NOT report cadenceDegraded when every round comfortably finishes within budget', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const responders = [1, 2, 3];
    const transport = makeTransport({
      send: () => {
        clock.advance(10); // 3 responders * 10ms = 30ms/round -- way under the 1000ms budget
      },
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });

    const resultPromise = runDidObservation({
      responders,
      transport,
      clock,
      durationMs: 3_000,
      targetHz: 1,
      control: control(),
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.cadenceDegraded).toBe(false);
  });

  it('produces a DidResponderSeries[] shape usable directly by classifyResponders, and invokes onSample per correlated response', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const responders = [0x30, 0x40];
    const samplesSeen: Array<{ did: number; raw: number[]; tMs: number }> = [];
    let tick = 0;
    const transport = makeTransport({
      send: () => {
        clock.advance(1_000); // 1 round-trip per second -- ~30+ samples over a 35s window
      },
      nextResponse: (_t, sentPdus) => {
        tick += 1;
        const did = didOf(sentPdus[sentPdus.length - 1]!);
        // did 0x30: monotonic drift (temperature-like); did 0x40: fixed value.
        return positiveRaw(did, did === 0x30 ? [40 + Math.min(60, Math.floor(tick / 2))] : [0x99]);
      },
    });

    const resultPromise = runDidObservation({
      responders,
      transport,
      clock,
      durationMs: 35_000,
      targetHz: 1,
      control: control(),
      onSample: (did, raw, tMs) => samplesSeen.push({ did, raw: Array.from(raw), tMs }),
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.series).toHaveLength(2);
    expect(result.series.map((s) => s.did)).toEqual([0x30, 0x40]);
    expect(result.series.every((s) => s.samples.length > 0)).toBe(true);
    expect(samplesSeen.length).toBe(result.series.reduce((sum, s) => sum + s.samples.length, 0));
    for (const sample of result.series.flatMap((s) => s.samples)) {
      expect(sample.raw).toBeInstanceOf(Uint8Array);
      expect(typeof sample.tMs).toBe('number');
    }

    // Ready to feed straight into classifyResponders (real cross-module usage, not a mock of it).
    const suggestions = classifyResponders(result.series);
    expect(suggestions.map((s) => s.did).sort((a, b) => a - b)).toEqual([0x30, 0x40]);
  });

  it('stops immediately once control.stopped is set, mid-round', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const ctl = control();
    const seen: number[] = [];
    const transport = makeTransport({
      send: (pdu) => {
        const did = didOf(pdu);
        seen.push(did);
        if (did === 2) ctl.stopped = true;
      },
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });

    const resultPromise = runDidObservation({
      responders: [1, 2, 3, 4],
      transport,
      clock,
      durationMs: 10_000,
      control: ctl,
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(seen).toEqual([1, 2]); // DID 3/4 never polled once stopped mid-round
  });
});
