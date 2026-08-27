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
    const clock = new FakeClock(500); // non-zero origin -- startedAtMs must reflect it
    const result = await runDidObservation({
      responders: [],
      transport: makeTransport(),
      clock,
      durationMs: 10_000,
      control: control(),
    });
    expect(result).toEqual({ series: [], startedAtMs: 500, errors: 0, cadenceDegraded: false });
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

  it('[P4f-REV4] with a NON-ZERO clock origin, sample tMs is RELATIVE to observation start (starts near 0), not the clock\'s absolute value', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock(1_000_000); // large non-zero origin (e.g. device uptime)
    const onSampleTimes: number[] = [];
    const transport = makeTransport({
      send: () => {
        clock.advance(10); // small, realistic per-request advance
      },
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });

    const resultPromise = runDidObservation({
      responders: [0x10],
      transport,
      clock,
      durationMs: 100,
      control: control(),
      onSample: (_did, _raw, tMs) => onSampleTimes.push(tMs),
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.startedAtMs).toBe(1_000_000); // the anchor -- the clock's own absolute origin
    const [series] = result.series;
    expect(series?.samples.length).toBeGreaterThan(0);
    for (const sample of series?.samples ?? []) {
      // RELATIVE to observation start -- nowhere near the clock's 1,000,000ms
      // absolute origin. Before the fix this was `clock.now()` directly,
      // i.e. ~1,000,000+, corrupting any relative-time alignment (GNSS
      // context, `classifyResponders` nearest-neighbor matching).
      expect(sample.tMs).toBeLessThan(200);
      expect(sample.tMs).toBeGreaterThanOrEqual(0);
    }
    expect(onSampleTimes.every((t) => t < 200)).toBe(true);
    expect(onSampleTimes).toEqual(series?.samples.map((s) => s.tMs));
  });

  it('[P4f-REV4] a pacing wait rechecks paused -- no extra request is sent after pause lands mid-wait', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const ctl = control();
    const seen: number[] = [];
    // did 1 responds instantly; a large pacing floor then forces a real wait
    // before did 2 -- during which we flip `paused` (mid-wait, AFTER the
    // top-of-iteration checks already passed with paused=false).
    setTimeout(() => {
      ctl.paused = true;
    }, 20);
    const transport = makeTransport({
      send: (pdu) => {
        seen.push(didOf(pdu));
      },
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });

    const resultPromise = runDidObservation({
      responders: [1, 2],
      transport,
      clock,
      durationMs: 10_000, // generous -- must not expire on its own during this test (isolates the paused recheck from the deadline recheck)
      control: ctl,
      pacing: { minIntervalMs: 2_000 }, // forces a long pacing wait after did 1
    });

    // Let the FULL 2000ms pacing wait complete, plus several 50ms pause-poll
    // cycles -- all while `paused` has been true since t=20ms.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(seen).toEqual([1]); // did 2 must NOT have been sent -- the post-wait recheck caught `paused`

    ctl.stopped = true; // release the (otherwise indefinite, since this clock never elapses on its own) pause loop, purely to let the promise settle for cleanup
    await vi.runAllTimersAsync();
    await resultPromise;
    expect(seen).toEqual([1]); // still just the one -- no extra send slipped through
  });

  it('[P4f-REV4] a pacing wait rechecks the duration deadline -- expiry mid-wait sends no further request', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const seen: number[] = [];
    // did 1 resolves at clock=0; the pacing floor (2000ms) forces a wait, but
    // a one-shot scheduled bump pushes the clock past the 1000ms window
    // DURING that wait (not before it starts, and not via the top-of-
    // iteration deadline check, which would still see clock=0 at that point).
    setTimeout(() => clock.advance(1_500), 20);
    const transport = makeTransport({
      send: (pdu) => {
        seen.push(didOf(pdu));
      },
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });

    const resultPromise = runDidObservation({
      responders: [1, 2],
      transport,
      clock,
      durationMs: 1_000,
      control: control(),
      pacing: { minIntervalMs: 2_000 },
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(seen).toEqual([1]); // did 2 never sent -- the window expired mid-wait
  });

  it('[P4f-REV5] control.stopped landing during a SLOW successful keep-alive prevents the next send -- no other path to send', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const ctl = control();
    const seen: number[] = [];
    let resolveKeepAlive: (() => void) | undefined;
    let keepAliveCalls = 0;
    const transport: SweepTransport & { sentPdus: Uint8Array[] } = {
      sentPdus: [],
      async send(pdu) {
        this.sentPdus.push(pdu);
        seen.push(didOf(pdu));
      },
      // Advances the clock AFTER did 1's own send/response exchange fully
      // completes (not in `send`, which would instead trip the DIFFERENT,
      // intentionally error-budget-only keep-alive check `resolveDid` makes
      // mid-exchange, before this main-loop, between-responders one).
      async nextResponse(_timeoutMs) {
        clock.advance(60); // crosses the 50ms keep-alive cadence
        return positiveRaw(didOf(this.sentPdus[this.sentPdus.length - 1]!), [1]);
      },
      keepAlive() {
        keepAliveCalls += 1;
        // Slow AND successful -- resolves only when the test says so, well after `stopped` lands.
        return new Promise((resolve) => {
          resolveKeepAlive = resolve;
        });
      },
    };

    const resultPromise = runDidObservation({
      responders: [1, 2],
      transport,
      clock,
      durationMs: 10_000,
      control: ctl,
      keepAliveIntervalMs: 50,
      // Large on purpose: `guardedCall`'s OWN internal safety-timeout is also
      // a real (fake-timer) `setTimeout` of `requestTimeoutMs` -- draining
      // with `runAllTimersAsync()` here would advance PAST it and resolve
      // the "slow" keep-alive as a timeout automatically, never letting the
      // test itself decide when it resolves. Keeping it far above the small,
      // precise advance below avoids that entirely.
      requestTimeoutMs: 60_000,
    });

    // Drains did 1's exchange and the ~60ms pacing wait before did 2 -- NOT
    // `runAllTimersAsync()` (see above) -- landing exactly inside the
    // (hanging) main-loop keep-alive await.
    await vi.advanceTimersByTimeAsync(100);
    expect(keepAliveCalls).toBe(1);
    expect(seen).toEqual([1]); // did 1 already went through; did 2 must not have, yet

    ctl.stopped = true; // lands WHILE the keep-alive is still pending
    resolveKeepAlive?.(); // the keep-alive now succeeds (does NOT trip the error budget)
    await vi.runAllTimersAsync();
    await resultPromise;

    // Before the fix: only `errorBudget.shouldStop()` was checked after
    // `maybeKeepAlive()`, so a stop landing here (with a SUCCESSFUL
    // keep-alive) was invisible and one more DID request still went out.
    expect(seen).toEqual([1]);
  });

  it('[P4f-REV5] control.paused landing during a SLOW successful keep-alive prevents the next send', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const ctl = control();
    const seen: number[] = [];
    let resolveKeepAlive: (() => void) | undefined;
    const transport: SweepTransport & { sentPdus: Uint8Array[] } = {
      sentPdus: [],
      async send(pdu) {
        this.sentPdus.push(pdu);
        seen.push(didOf(pdu));
      },
      async nextResponse(_timeoutMs) {
        clock.advance(60);
        return positiveRaw(didOf(this.sentPdus[this.sentPdus.length - 1]!), [1]);
      },
      keepAlive() {
        return new Promise((resolve) => {
          resolveKeepAlive = resolve;
        });
      },
    };

    const resultPromise = runDidObservation({
      responders: [1, 2],
      transport,
      clock,
      durationMs: 10_000,
      control: ctl,
      keepAliveIntervalMs: 50,
      requestTimeoutMs: 60_000, // see the sibling test's comment -- keeps `guardedCall`'s own safety timeout well out of reach
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([1]);

    ctl.paused = true; // lands WHILE the keep-alive is still pending
    resolveKeepAlive?.();
    // Let the (otherwise indefinite, since `clock` never reaches `endAtMs` on
    // its own once nothing else advances it) paused-wait loop run for a
    // while, proving did 2 is never sent while paused.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(seen).toEqual([1]);

    ctl.stopped = true; // release the loop purely for cleanup
    await vi.runAllTimersAsync();
    await resultPromise;
    expect(seen).toEqual([1]); // no DID request was ever sent while paused
  });
});
