import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MonotonicClock } from '../../../src/contracts';
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

/**
 * A `MonotonicClock` that advances by `stepMs` on EVERY single `.now()` call
 * (unlike `FakeClock`, which only moves via explicit `.advance()`) --
 * deliberately hostile to any code path that reads the clock more than once
 * expecting the same "current" value. `reads` records every value the clock
 * has ever actually returned, in call order, so a test can independently
 * verify which real clock reading a later computed value (e.g. a sample's
 * `tMs`) must have come from.
 */
function makeTickingClock(stepMs: number): { clock: MonotonicClock; reads: number[] } {
  const reads: number[] = [];
  let t = 0;
  return {
    reads,
    clock: {
      now: () => {
        const value = t;
        reads.push(value);
        t += stepMs;
        return value;
      },
    },
  };
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
    expect(result).toEqual({ series: [], startedAtMs: 500, errors: 0, cadenceDegraded: false, nextResponderIndex: 0 });
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

  it('[P4f-REV6] onStarted receives EXACTLY result.startedAtMs, the same anchor used for samples’ relative tMs, even with a clock that advances between every read', async () => {
    vi.useFakeTimers();
    const { clock, reads } = makeTickingClock(7);
    let observedStartedAtMs: number | undefined;
    let onStartedCallCount = 0;
    const transport = makeTransport({
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });

    const resultPromise = runDidObservation({
      responders: [0x10],
      transport,
      clock,
      durationMs: 50, // small on purpose -- the ticking clock's own reads (several per iteration) exceed this within the first round, so the run ends without ever needing a real pacing wait
      control: control(),
      onStarted: (startedAtMs) => {
        onStartedCallCount += 1;
        observedStartedAtMs = startedAtMs;
      },
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(onStartedCallCount).toBe(1);
    expect(observedStartedAtMs).toBeDefined();
    // The core requirement: `onStarted` gets the EXACT SAME value the result
    // itself reports -- never a value computed from a second, independent
    // clock read (which, on THIS clock, would differ from the first by at
    // least one multiple of 7ms).
    expect(observedStartedAtMs).toBe(result.startedAtMs);

    const [series] = result.series;
    const sample = series?.samples[0];
    expect(sample).toBeDefined();
    // Reconstruct the RAW absolute clock reading the sample's `tMs` must have
    // been computed against (`tMs = rawReading - startedAtMs`), and confirm
    // it is one of the clock's own ACTUAL recorded reads -- proving
    // `observedStartedAtMs` (== `onStarted`'s value) really is the anchor
    // this runner used for the sample's relative `tMs`, not merely a value
    // that happens to look plausible.
    const reconstructedRawReading = (observedStartedAtMs ?? Number.NaN) + (sample?.tMs ?? Number.NaN);
    expect(reads).toContain(reconstructedRawReading);
    expect(reconstructedRawReading).toBeGreaterThan(observedStartedAtMs ?? Number.NaN); // the sample was correlated strictly after the anchor was captured
  });

  describe('[F2, P4i-FIX1] nextResponderIndex -- the persistent round-robin cursor', () => {
    it('stopping mid-round reports the index one past the last responder actually attempted', async () => {
      // Real timers -- the SAME response cadence pushes each `nextRequestNotBeforeMs`
      // wait past `now` (the pacing floor's clamp is 5ms), and this test's
      // assertion doesn't need fake-timer control; a real 5ms wait is trivial.
      const clock = new FakeClock();
      const ctl = control();
      const seen: number[] = [];
      const transport = makeTransport({
        send: (pdu) => {
          const did = didOf(pdu);
          seen.push(did);
          if (did === 20) ctl.stopped = true; // stop right after the 2nd of 4 responders is attempted.
        },
        nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
      });

      const result = await runDidObservation({
        responders: [10, 20, 30, 40],
        transport,
        clock,
        durationMs: 10_000,
        control: ctl,
      });

      expect(seen).toEqual([10, 20]); // 30/40 never attempted.
      expect(result.nextResponderIndex).toBe(2); // one past index 1 (did 20) -- a continuation should resume AT did 30.
    });

    it('a window that ends before any responder is attempted reports index 0 (nothing consumed)', async () => {
      vi.useFakeTimers();
      const clock = new FakeClock();
      const result = await runDidObservation({
        responders: [10, 20, 30],
        transport: makeTransport(),
        clock,
        durationMs: 0, // expires immediately, before the first send.
        control: control(),
      });
      expect(result.nextResponderIndex).toBe(0);
    });

    it('completing a full round wraps the cursor back to 0', async () => {
      vi.useFakeTimers();
      const clock = new FakeClock();
      const transport = makeTransport({
        send: () => {
          clock.advance(10);
        },
        nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
      });
      const resultPromise = runDidObservation({
        responders: [10, 20, 30],
        transport,
        clock,
        durationMs: 25, // just enough for one full round (3 x 10ms sends) and no more.
        control: control(),
      });
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.nextResponderIndex).toBe(0); // wrapped after attempting index 2 (the last responder).
    });

    it('a caller rotating `responders` by nextResponderIndex between two calls continues coverage instead of restarting at index 0', async () => {
      // Real timers -- same reasoning as the sibling test above.
      const clock = new FakeClock();
      const seenFirstCall: number[] = [];
      const transportA = makeTransport({
        send: (pdu) => {
          seenFirstCall.push(didOf(pdu));
          clock.advance(7); // each request/response round-trip costs the clock some real time.
        },
        nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
      });
      const firstResult = await runDidObservation({
        responders: [10, 20, 30, 40],
        transport: transportA,
        clock,
        durationMs: 15, // enough for did 10 and 20 only (2 x 7ms), not the full round.
        control: control(),
      });
      // Whatever the exact cutoff, the cursor tells us precisely where to resume.
      const rotated = [
        ...[10, 20, 30, 40].slice(firstResult.nextResponderIndex),
        ...[10, 20, 30, 40].slice(0, firstResult.nextResponderIndex),
      ];

      const clockB = new FakeClock();
      const seenSecondCall: number[] = [];
      const transportB = makeTransport({
        send: (pdu) => {
          seenSecondCall.push(didOf(pdu));
          clockB.advance(7);
        },
        nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
      });
      await runDidObservation({
        responders: rotated,
        transport: transportB,
        clock: clockB,
        durationMs: 5, // short -- this assertion only needs the FIRST send to land.
        control: control(),
      });

      // The rotated continuation must START with whatever responder the
      // cursor pointed at -- never restarting the sequence at responder 10
      // (the REV bug: a naive per-phase caller always began at index 0,
      // over-sampling the front of a large candidate list and starving the
      // tail).
      expect(seenSecondCall[0]).toBe(rotated[0]);
      expect(seenSecondCall[0]).not.toBe(seenFirstCall[0]);
    });
  });
});
