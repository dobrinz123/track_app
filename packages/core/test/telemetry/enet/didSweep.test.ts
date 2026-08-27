import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ObdTransport } from '../../../src/telemetry/contracts';
import {
  createDidSweepAccumulator,
  createDidSweepPlan,
  runDidSweep,
  type DidSweepControl,
  type SweepTransport,
} from '../../../src/telemetry/enet/didSweep';
import {
  binaryStringToBytes,
  bytesToBinaryString,
  encodeFrame,
  HSFZ_CONTROL,
  HsfzFrameParser,
} from '../../../src/telemetry/enet/hsfzCodec';
import {
  DEFAULT_ENET_DID_SCENARIO,
  ENET_DID_PEDAL_DID,
  ENET_DID_STEERING_DID,
  ENET_DID_TEMPERATURE_DID,
  SimulatedEnetTransport,
} from '../../../src/telemetry/enet/simulatedEnetTransport';
import { UDS_NRC } from '../../../src/telemetry/enet/udsCodec';
import { FakeClock } from '../../controller/testSupport';

afterEach(() => {
  vi.useRealTimers();
});

describe('createDidSweepPlan', () => {
  it('visits [from, to] ascending by default', () => {
    const plan = createDidSweepPlan({ from: 0, to: 5 });
    expect(plan.order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(plan.total).toBe(6);
    expect(plan.visitedCount).toBe(0);
  });

  it('visits priority ranges first (deduped), then the rest of the range', () => {
    const plan = createDidSweepPlan({ from: 0, to: 5, priorityRanges: [{ from: 3, to: 4 }] });
    expect(plan.order).toEqual([3, 4, 0, 1, 2, 5]);
  });

  it('dedupes overlapping priority ranges against each other and clips them to [from, to]', () => {
    const plan = createDidSweepPlan({
      from: 0,
      to: 5,
      priorityRanges: [
        { from: 2, to: 4 },
        { from: 3, to: 10 }, // overlaps + extends past `to`
      ],
    });
    expect(plan.order).toEqual([2, 3, 4, 5, 0, 1]);
  });

  it('next()/peek() advance a resumable cursor without losing progress', () => {
    const plan = createDidSweepPlan({ from: 10, to: 12 });
    expect(plan.peek()).toBe(10);
    expect(plan.next()).toBe(10);
    expect(plan.visitedCount).toBe(1);
    expect(plan.next()).toBe(11);
    expect(plan.next()).toBe(12);
    expect(plan.next()).toBeNull();
    expect(plan.peek()).toBeNull();
    expect(plan.visitedCount).toBe(3);
  });

  it('rejects an inverted or out-of-range plan', () => {
    expect(() => createDidSweepPlan({ from: 5, to: 2 })).toThrow(RangeError);
    expect(() => createDidSweepPlan({ from: -1, to: 5 })).toThrow(RangeError);
    expect(() => createDidSweepPlan({ from: 0, to: 0x1_0000 })).toThrow(RangeError);
  });

  it('rejects a non-finite/non-integer priority range endpoint instead of looping forever', () => {
    expect(() => createDidSweepPlan({ from: 0, to: 10, priorityRanges: [{ from: -Infinity, to: Infinity }] })).toThrow(
      RangeError,
    );
    expect(() => createDidSweepPlan({ from: 0, to: 10, priorityRanges: [{ from: 0, to: Number.NaN }] })).toThrow(
      RangeError,
    );
    expect(() => createDidSweepPlan({ from: 0, to: 10, priorityRanges: [{ from: 0.5, to: 3 }] })).toThrow(RangeError);
  });

  it('clips a huge (but finite) priority range to the plan bounds -- cost proportional to the plan, not the declared range', () => {
    const started = Date.now();
    const plan = createDidSweepPlan({ from: 0, to: 10, priorityRanges: [{ from: -1_000_000, to: 1_000_000 }] });
    const elapsedMs = Date.now() - started;
    expect(plan.order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // clipped -- no phantom out-of-range DIDs
    expect(plan.total).toBe(11);
    expect(elapsedMs).toBeLessThan(1_000); // would be ~2M loop iterations unclipped
  });
});

function positiveRaw(did: number, dataBytes: number[]): Uint8Array {
  return Uint8Array.from([0x62, (did >> 8) & 0xff, did & 0xff, ...dataBytes]);
}
function negativeRaw(requestSid: number, nrc: number): Uint8Array {
  return Uint8Array.from([0x7f, requestSid, nrc]);
}
function didOf(pdu: Uint8Array): number {
  return ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
}

function control(overrides: Partial<DidSweepControl> = {}): DidSweepControl {
  return { paused: false, stopped: false, ...overrides };
}

/** A `SweepTransport` test double: records every `send`/`keepAlive` pdu, and delegates `nextResponse` to a per-test handler that can inspect `sentPdus` to know which DID it's answering. Every method defaults to a harmless no-op/`'timeout'` so a test only overrides what it cares about. */
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

describe('runDidSweep', () => {
  it('collects responders (echoed DID stripped via the REAL UDS parser) and classifies NRCs', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 3 });
    const transport = makeTransport({
      nextResponse: (_t, sentPdus) => {
        const did = didOf(sentPdus[sentPdus.length - 1]!);
        if (did === 0) return positiveRaw(0, [0xaa]);
        if (did === 1) return negativeRaw(0x22, UDS_NRC.SERVICE_NOT_SUPPORTED);
        if (did === 2) return 'timeout';
        return positiveRaw(3, [0xbb, 0xcc]);
      },
    });

    const result = await runDidSweep({ plan, transport, clock: new FakeClock(), control: control() });

    expect(result.responders).toEqual([
      { did: 0, raw: Uint8Array.from([0xaa]), length: 1, rttMs: 0 },
      { did: 3, raw: Uint8Array.from([0xbb, 0xcc]), length: 2, rttMs: 0 },
    ]);
    expect(result.nrcCounts).toEqual({ [UDS_NRC.SERVICE_NOT_SUPPORTED]: 1 });
    expect(result.timeouts).toBe(1);
    expect(result.unmatched).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.lastDid).toBe(3);
  });

  it('builds the request itself through assertAllowedRequest -- transport.send only ever receives a 0x22 pdu for the current DID', async () => {
    const plan = createDidSweepPlan({ from: 0x10, to: 0x11 });
    const transport = makeTransport({
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });
    await runDidSweep({ plan, transport, clock: new FakeClock(), control: control() });
    expect(transport.sentPdus).toEqual([Uint8Array.from([0x22, 0x00, 0x10]), Uint8Array.from([0x22, 0x00, 0x11])]);
  });

  it('treats a response that does not correlate (wrong SID, wrong echoed DID, wrong requestSid) as unmatched -- counted, DID abandoned as a timeout after exhausting the retry budget', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 2 });
    const transport = makeTransport({
      nextResponse: (_t, sentPdus) => {
        const did = didOf(sentPdus[sentPdus.length - 1]!);
        if (did === 0) return Uint8Array.from([0x6e, 0xde, 0xad]); // wrong SID entirely
        if (did === 1) return positiveRaw(0x9999, [1]); // right SID, WRONG echoed DID
        return negativeRaw(0x3e, UDS_NRC.SERVICE_NOT_SUPPORTED); // right NRC shape, wrong requestSid (not 0x22)
      },
    });
    const result = await runDidSweep({ plan, transport, clock: new FakeClock(), control: control(), maxUnmatchedRetries: 0 });
    expect(result.unmatched).toBe(3); // one unmatched event per DID
    expect(result.responders).toEqual([]);
    expect(result.nrcCounts).toEqual({});
    expect(result.timeouts).toBe(3); // each DID gave up after exhausting its (zero) unmatched budget
    expect(result.lastDid).toBe(2);
    // send() called exactly once per DID -- an unmatched reply never triggers a re-send.
    expect(transport.sentPdus).toHaveLength(3);
  });

  it('[P4f-FIX2] unmatched-then-correct-in-sequence: keeps awaiting within the remaining window, no re-send, no lost responder', async () => {
    const plan = createDidSweepPlan({ from: 0x50, to: 0x50 });
    const transport = makeTransport({
      nextResponse: (_t, _s, callNumber) => {
        if (callNumber <= 2) return positiveRaw(0x9999, [0xff]); // 2 unmatched (wrong echoed DID) replies
        return positiveRaw(0x50, [0x42]); // then the real answer
      },
    });
    const result = await runDidSweep({ plan, transport, clock: new FakeClock(), control: control() });
    expect(result.unmatched).toBe(2);
    expect(result.responders).toEqual([{ did: 0x50, raw: Uint8Array.from([0x42]), length: 1, rttMs: 0 }]);
    expect(transport.sentPdus).toHaveLength(1); // send() called ONCE despite 2 unmatched replies first
  });

  it('[P4f-FIX2] 0x78 extends the wait WITHOUT re-sending -- send() called exactly once per DID', async () => {
    const plan = createDidSweepPlan({ from: 0x22, to: 0x22 });
    const transport = makeTransport({
      nextResponse: (_t, _s, callNumber) => {
        if (callNumber <= 2) return negativeRaw(0x22, UDS_NRC.RESPONSE_PENDING); // 2 extensions
        return positiveRaw(0x22, [7]);
      },
    });
    const result = await runDidSweep({ plan, transport, clock: new FakeClock(), control: control() });
    expect(transport.sentPdus).toHaveLength(1); // NOT re-sent for each 0x78 -- fixes the REV2 finding
    expect(result.responders).toEqual([{ did: 0x22, raw: Uint8Array.from([7]), length: 1, rttMs: 0 }]);
  });

  it('exhausting the 0x78 extension budget (default 5) abandons the DID as a timeout, still without re-sending', async () => {
    const plan = createDidSweepPlan({ from: 0x30, to: 0x30 });
    const transport = makeTransport({ nextResponse: () => negativeRaw(0x22, UDS_NRC.RESPONSE_PENDING) }); // never resolves
    const result = await runDidSweep({
      plan,
      transport,
      clock: new FakeClock(),
      control: control(),
      maxResponsePendingExtensions: 5,
    });
    expect(transport.sentPdus).toHaveLength(1); // one send(), 6 nextResponse() calls (1 initial + 5 extensions)
    expect(result.timeouts).toBe(1);
    expect(result.responders).toEqual([]);
  });

  it('[P4f-FIX2] a synchronous THROW from send/nextResponse is contained -- counted as an error, the sweep continues', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 1 });
    const transport = makeTransport({
      send: (pdu) => {
        if (didOf(pdu) === 0) throw new Error('synchronous transport failure'); // NOT a rejected promise -- a real throw
      },
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });
    const result = await runDidSweep({ plan, transport, clock: new FakeClock(), control: control() });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.timeouts).toBe(1); // did 0's send() threw -- no answer for it
    expect(result.responders).toEqual([{ did: 1, raw: Uint8Array.from([1]), length: 1, rttMs: 0 }]); // did 1 still swept normally
  });

  it('[P4f-FIX2] a synchronous THROW from nextResponse is contained the same way', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 1 });
    const transport = makeTransport({
      nextResponse: (_t, sentPdus) => {
        const did = didOf(sentPdus[sentPdus.length - 1]!);
        if (did === 0) throw new Error('synchronous transport failure');
        return positiveRaw(did, [1]);
      },
    });
    const result = await runDidSweep({ plan, transport, clock: new FakeClock(), control: control() });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.timeouts).toBe(1);
    expect(result.responders).toEqual([{ did: 1, raw: Uint8Array.from([1]), length: 1, rttMs: 0 }]);
  });

  it('[P4f-FIX2] maxConsecutiveErrors stops the sweep early, same as control.stopped', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 9 });
    const transport = makeTransport({
      send: () => {
        throw new Error('always fails');
      },
    });
    const result = await runDidSweep({ plan, transport, clock: new FakeClock(), control: control(), maxConsecutiveErrors: 3 });
    expect(result.errors).toBe(3);
    expect(plan.visitedCount).toBeLessThan(10); // stopped well before exhausting the plan
  });

  it('a transport that never resolves cannot hang the sweep -- bounded by requestTimeoutMs', async () => {
    vi.useFakeTimers();
    const plan = createDidSweepPlan({ from: 0, to: 0 });
    const transport = makeTransport({ nextResponse: () => new Promise(() => {}) }); // never settles
    const resultPromise = runDidSweep({ plan, transport, clock: new FakeClock(), control: control(), requestTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;
    expect(result.timeouts).toBe(1);
    expect(plan.visitedCount).toBe(1);
  });

  it('stops immediately once control.stopped is set, never requesting the next DID', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 4 });
    const seen: number[] = [];
    const ctl = control();
    const transport = makeTransport({
      send: (pdu) => {
        seen.push(didOf(pdu));
        if (didOf(pdu) === 1) ctl.stopped = true;
      },
    });
    const result = await runDidSweep({ plan, transport, clock: new FakeClock(), control: ctl });
    expect(seen).toEqual([0, 1]);
    expect(result.lastDid).toBe(1);
    expect(plan.visitedCount).toBe(2);
  });

  it('the cursor advances only AFTER a result -- never before/during the request', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 0 });
    let resolveNext: ((value: Uint8Array | 'timeout') => void) | undefined;
    const transport = makeTransport({
      nextResponse: () =>
        new Promise((resolve) => {
          resolveNext = resolve;
        }),
    });
    const resultPromise = runDidSweep({ plan, transport, clock: new FakeClock(), control: control() });
    // The request now passes through several intermediate microtask hops
    // (guarded send, keep-alive check, guarded nextResponse) before reaching
    // the pending promise -- poll microtask-only until it's actually in
    // flight, rather than assuming a fixed number of ticks.
    for (let i = 0; i < 50 && resolveNext === undefined; i += 1) {
      await Promise.resolve();
    }
    expect(resolveNext).toBeDefined();
    expect(plan.visitedCount).toBe(0); // still not committed -- the request hasn't resolved yet
    resolveNext?.(positiveRaw(0, [1]));
    await resultPromise;
    expect(plan.visitedCount).toBe(1);
  });

  it('pause is re-checked AFTER every wait -- a pause set during the pacing wait is honored before the next DID is sent', async () => {
    vi.useFakeTimers();
    const plan = createDidSweepPlan({ from: 0, to: 2 });
    const clock = new FakeClock();
    const ctl = control();
    const seen: number[] = [];
    const transport = makeTransport({
      send: (pdu) => {
        const did = didOf(pdu);
        seen.push(did);
        clock.advance(200); // measured RTT -- forces a real pacing wait before the NEXT did
        if (did === 0) ctl.paused = true; // paused WHILE did 1 would be waiting to be paced/sent
      },
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });
    const resultPromise = runDidSweep({ plan, transport, clock, control: ctl, pacing: { rttMultiplier: 1 } });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;
    expect(seen).toEqual([0]); // did 1/2 never sent -- pause landed during the pacing wait
    expect(result.lastDid).toBe(0);
    expect(plan.visitedCount).toBe(1);
  });

  it('accumulates results across a paused/resumed sweep via the SAME accumulator', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 3 });
    const ctl = control();
    const acc = createDidSweepAccumulator();
    const transport = makeTransport({
      send: (pdu) => {
        if (didOf(pdu) === 1) ctl.paused = true;
      },
      nextResponse: (_t, sentPdus) => {
        const did = didOf(sentPdus[sentPdus.length - 1]!);
        return positiveRaw(did, [did]);
      },
    });

    const afterFirst = await runDidSweep({ plan, transport, clock: new FakeClock(), control: ctl, accumulator: acc });
    expect(afterFirst).toBe(acc); // same reference back
    expect(afterFirst.responders.map((r) => r.did)).toEqual([0, 1]);

    ctl.paused = false;
    const afterSecond = await runDidSweep({ plan, transport, clock: new FakeClock(), control: ctl, accumulator: acc });
    expect(afterSecond.responders.map((r) => r.did)).toEqual([0, 1, 2, 3]); // both runs' responders, combined
    expect(afterSecond.lastDid).toBe(3);
  });

  it('reports onProgress with the plan-relative 1-based index/total', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 2 });
    const progress: Array<{ did: number; index: number; total: number }> = [];
    const transport = makeTransport();
    await runDidSweep({ plan, transport, clock: new FakeClock(), control: control(), onProgress: (p) => progress.push(p) });
    expect(progress).toEqual([
      { did: 0, index: 1, total: 3 },
      { did: 1, index: 2, total: 3 },
      { did: 2, index: 3, total: 3 },
    ]);
  });

  it('paces requests using the measured round-trip (adaptive pacing)', async () => {
    vi.useFakeTimers();
    const plan = createDidSweepPlan({ from: 0, to: 2 });
    const clock = new FakeClock();
    const transport = makeTransport({
      send: () => {
        clock.advance(40); // simulate a 40ms round-trip on the injected clock
      },
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });

    const resultPromise = runDidSweep({ plan, transport, clock, pacing: { rttMultiplier: 1 }, control: control() });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.responders).toHaveLength(3);
    expect(clock.now()).toBe(120);
  });

  it('caps the pacing interval via maxRequestsPerSec', async () => {
    vi.useFakeTimers();
    const plan = createDidSweepPlan({ from: 0, to: 1 });
    const clock = new FakeClock();
    const transport = makeTransport(); // every nextResponse() -> 'timeout', no RTT signal at all
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const resultPromise = runDidSweep({
      plan,
      transport,
      clock,
      pacing: { maxRequestsPerSec: 20 }, // 50ms floor
      control: control(),
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    const waitDelays = setTimeoutSpy.mock.calls.map((call) => call[1]).filter((delay) => delay === 50);
    expect(waitDelays.length).toBeGreaterThan(0);
    setTimeoutSpy.mockRestore();
  });

  it('clamps pacing into [5, 2000]ms even for an extreme measured RTT', async () => {
    vi.useFakeTimers();
    const plan = createDidSweepPlan({ from: 0, to: 1 });
    const clock = new FakeClock();
    const transport = makeTransport({
      send: () => {
        clock.advance(10_000_000); // an absurd RTT -- pacing must not wait days
      },
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const resultPromise = runDidSweep({ plan, transport, clock, control: control() });
    await vi.runAllTimersAsync();
    await resultPromise;
    const waitDelays = setTimeoutSpy.mock.calls.map((call) => call[1]).filter((d): d is number => typeof d === 'number' && d > 0);
    expect(waitDelays.every((d) => d <= 2_000)).toBe(true);
    setTimeoutSpy.mockRestore();
  });

  it('falls back to defaults for non-finite/negative pacing inputs instead of accepting them', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 1 });
    const transport = makeTransport({
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });
    // Must not throw, hang, or produce a negative/NaN wait.
    const result = await runDidSweep({
      plan,
      transport,
      clock: new FakeClock(),
      control: control(),
      pacing: { rttMultiplier: Number.NaN, minIntervalMs: -50, maxRequestsPerSec: -1 },
    });
    expect(result.responders).toHaveLength(2);
  });

  it('[P4f-FIX2] keepAlive sends a whitelisted TesterPresent roughly every 2s of the injected clock', async () => {
    vi.useFakeTimers();
    const plan = createDidSweepPlan({ from: 0, to: 11 }); // 12 DIDs
    const clock = new FakeClock();
    const transport = makeTransport({
      send: () => {
        clock.advance(500); // 12 * 500ms = 6000ms of injected-clock time total
      },
      nextResponse: (_t, sentPdus) => positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]),
    });

    const resultPromise = runDidSweep({ plan, transport, clock, control: control(), keepAliveIntervalMs: 2_000 });
    await vi.runAllTimersAsync();
    await resultPromise;

    // 6000ms of injected-clock time crosses the 2000ms cadence 3 times (at
    // ~2000/4000/6000ms) -- each a whitelisted 0x3E 0x80.
    expect(transport.keepAlivePdus.length).toBeGreaterThanOrEqual(2);
    for (const pdu of transport.keepAlivePdus) {
      expect(Array.from(pdu)).toEqual([0x3e, 0x80]);
    }
  });

  it('[P4f-REV5] control.stopped landing during a SLOW successful keep-alive prevents the next send -- no other path to send', async () => {
    vi.useFakeTimers();
    const plan = createDidSweepPlan({ from: 1, to: 5 });
    const clock = new FakeClock();
    const ctl = control();
    const seen: number[] = [];
    let resolveKeepAlive: (() => void) | undefined;
    let keepAliveCalls = 0;
    const transport = makeTransport({
      send: (pdu) => {
        seen.push(didOf(pdu));
      },
      // Advances the clock AFTER did 1's own send/response exchange fully
      // completes (not in `send`, which would instead trip the DIFFERENT,
      // intentionally error-budget-only keep-alive check `resolveDid` makes
      // mid-exchange, before this main-loop, between-DIDs one).
      nextResponse: (_t, sentPdus) => {
        clock.advance(60); // crosses the 50ms keep-alive cadence
        return positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]);
      },
      keepAlive: () => {
        keepAliveCalls += 1;
        // Slow AND successful -- resolves only when the test says so, well after `stopped` lands.
        return new Promise((resolve) => {
          resolveKeepAlive = resolve;
        });
      },
    });

    const resultPromise = runDidSweep({
      plan,
      transport,
      clock,
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
    const plan = createDidSweepPlan({ from: 1, to: 5 });
    const clock = new FakeClock();
    const ctl = control();
    const seen: number[] = [];
    let resolveKeepAlive: (() => void) | undefined;
    const transport = makeTransport({
      send: (pdu) => {
        seen.push(didOf(pdu));
      },
      nextResponse: (_t, sentPdus) => {
        clock.advance(60);
        return positiveRaw(didOf(sentPdus[sentPdus.length - 1]!), [1]);
      },
      keepAlive: () =>
        new Promise((resolve) => {
          resolveKeepAlive = resolve;
        }),
    });

    const resultPromise = runDidSweep({
      plan,
      transport,
      clock,
      control: ctl,
      keepAliveIntervalMs: 50,
      requestTimeoutMs: 60_000, // see the sibling test's comment -- keeps `guardedCall`'s own safety timeout well out of reach
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([1]);

    ctl.paused = true; // lands WHILE the keep-alive is still pending
    resolveKeepAlive?.();
    await vi.runAllTimersAsync();
    await resultPromise;

    // `runDidSweep`'s pause semantics simply end this call (resumed later via
    // a fresh call with the same plan) -- either way, did 2 must never be sent.
    expect(seen).toEqual([1]);
    expect(plan.visitedCount).toBe(1);
  });
});

/**
 * A minimal `SweepTransport` adapter over a live (simulated) `ObdTransport`,
 * mirroring what a real mobile implementation does: frame the pdu as an HSFZ
 * diagnostic request/response, and forward any diagnostic-kind frame from
 * the target with swapped addresses -- correlation by SID/echoed-DID is
 * `runDidSweep`'s own job, NOT this adapter's (amendment). ACK frames
 * (control 0x0002) are NOT "diagnostic PDUs" and are filtered out here at the
 * framing layer, same as a real transport would.
 */
function makeLiveSweepTransport(config: {
  transport: ObdTransport;
  testerAddress: number;
  targetAddress: number;
}): SweepTransport {
  const parser = new HsfzFrameParser();
  const queued: Uint8Array[] = [];
  const waiters: Array<{ resolve: (value: Uint8Array | 'timeout') => void; timer: ReturnType<typeof setTimeout> }> = [];

  config.transport.onData((chunk) => {
    const bytes = binaryStringToBytes(chunk);
    let frames;
    try {
      frames = parser.push(bytes);
    } catch {
      return;
    }
    for (const frame of frames) {
      if (frame.kind !== 'diagnostic' || frame.control !== HSFZ_CONTROL.DIAGNOSTIC_REQ_RES) continue;
      if (frame.source !== config.targetAddress || frame.target !== config.testerAddress) continue;
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame.payload);
      } else {
        queued.push(frame.payload);
      }
    }
  });

  const sendFrame = (pdu: Uint8Array): void => {
    const frame = encodeFrame({
      control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
      source: config.testerAddress,
      target: config.targetAddress,
      payload: pdu,
    });
    config.transport.send(bytesToBinaryString(frame));
  };

  return {
    async send(pdu) {
      sendFrame(pdu);
    },
    nextResponse(timeoutMs) {
      return new Promise((resolve) => {
        const next = queued.shift();
        if (next !== undefined) {
          resolve(next);
          return;
        }
        const timer = setTimeout(() => {
          const index = waiters.findIndex((w) => w.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          resolve('timeout');
        }, timeoutMs);
        waiters.push({ resolve, timer });
      });
    },
    async keepAlive(pdu) {
      sendFrame(pdu);
    },
  };
}

describe('[P4f-FIX2 E2E] SimulatedEnetTransport + runDidSweep + real codec', () => {
  it('sweeps a small range covering the 3 scripted DIDs plus unknown ones: unknown DIDs answer 0x7F 22 31 (non-zero NRC counts), all 3 scripted responders are found', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const testerAddress = 0xf4;
    const targetAddress = 0x12;
    const simulated = new SimulatedEnetTransport({
      monotonicNow: () => clock.now(),
      scenario: DEFAULT_ENET_DID_SCENARIO,
      testerAddress,
      targetAddress,
    });
    await simulated.connect();
    const transport = makeLiveSweepTransport({ transport: simulated, testerAddress, targetAddress });

    // A small range spanning the 3 scripted DIDs (0x1E1C/0x1E20/0x1E24) plus
    // several UNKNOWN DIDs on either side/between them.
    const plan = createDidSweepPlan({ from: 0x1e18, to: 0x1e28 });
    const resultPromise = runDidSweep({ plan, transport, clock, control: { paused: false, stopped: false } });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    // The E2E finding: unknown DIDs must answer 0x7F 22 31 (requestOutOfRange), NOT silently 0/nothing.
    expect(result.nrcCounts[UDS_NRC.REQUEST_OUT_OF_RANGE]).toBeGreaterThan(0);

    const foundDids = result.responders.map((r) => r.did).sort((a, b) => a - b);
    expect(foundDids).toEqual(
      [ENET_DID_TEMPERATURE_DID, ENET_DID_PEDAL_DID, ENET_DID_STEERING_DID].map((hex) => Number.parseInt(hex, 16)).sort((a, b) => a - b),
    );
    expect(result.errors).toBe(0);

    await simulated.close();
  });
});
