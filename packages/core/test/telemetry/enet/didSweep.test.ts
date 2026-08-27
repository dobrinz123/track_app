import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDidSweepAccumulator,
  createDidSweepPlan,
  runDidSweep,
  type DidSweepControl,
} from '../../../src/telemetry/enet/didSweep';
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

function control(overrides: Partial<DidSweepControl> = {}): DidSweepControl {
  return { paused: false, stopped: false, ...overrides };
}

describe('runDidSweep', () => {
  it('collects responders (echoed DID stripped via the REAL UDS parser) and classifies NRCs', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 3 });
    const sendRequest = async (pdu: Uint8Array): Promise<Uint8Array | 'timeout'> => {
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      if (did === 0) return positiveRaw(0, [0xaa]);
      if (did === 1) return negativeRaw(0x22, UDS_NRC.SERVICE_NOT_SUPPORTED);
      if (did === 2) return 'timeout';
      return positiveRaw(3, [0xbb, 0xcc]);
    };

    const result = await runDidSweep({ plan, sendRequest, clock: new FakeClock(), control: control() });

    expect(result.responders).toEqual([
      { did: 0, raw: Uint8Array.from([0xaa]), length: 1, rttMs: 0 },
      { did: 3, raw: Uint8Array.from([0xbb, 0xcc]), length: 2, rttMs: 0 },
    ]);
    expect(result.nrcCounts).toEqual({ [UDS_NRC.SERVICE_NOT_SUPPORTED]: 1 });
    expect(result.timeouts).toBe(1);
    expect(result.unmatched).toBe(0);
    expect(result.lastDid).toBe(3);
  });

  it('builds the request itself through assertAllowedRequest -- sendRequest only ever receives a 0x22 pdu for the current DID', async () => {
    const seenPdus: Uint8Array[] = [];
    const plan = createDidSweepPlan({ from: 0x10, to: 0x11 });
    const sendRequest = async (pdu: Uint8Array): Promise<Uint8Array | 'timeout'> => {
      seenPdus.push(pdu);
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      return positiveRaw(did, [1]);
    };
    await runDidSweep({ plan, sendRequest, clock: new FakeClock(), control: control() });
    expect(seenPdus).toEqual([Uint8Array.from([0x22, 0x00, 0x10]), Uint8Array.from([0x22, 0x00, 0x11])]);
  });

  it('treats a response that does not correlate (wrong SID, wrong echoed DID, wrong requestSid) as unmatched -- no credit either way', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 2 });
    const sendRequest = async (pdu: Uint8Array): Promise<Uint8Array | 'timeout'> => {
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      if (did === 0) return Uint8Array.from([0x6e, 0xde, 0xad]); // wrong SID entirely
      if (did === 1) return positiveRaw(0x9999, [1]); // right SID, WRONG echoed DID
      return negativeRaw(0x3e, UDS_NRC.SERVICE_NOT_SUPPORTED); // right NRC shape, wrong requestSid (not 0x22)
    };
    const result = await runDidSweep({ plan, sendRequest, clock: new FakeClock(), control: control() });
    expect(result.unmatched).toBe(3);
    expect(result.responders).toEqual([]);
    expect(result.nrcCounts).toEqual({});
    expect(result.timeouts).toBe(0);
    expect(result.lastDid).toBe(2); // the cursor still advances -- an unmatched reply IS a resolved outcome for this DID
  });

  it('0x78 extends the wait (same pdu, re-sent) up to the bound, then the real answer resolves it', async () => {
    const plan = createDidSweepPlan({ from: 0x22, to: 0x22 });
    let calls = 0;
    const sendRequest = async (): Promise<Uint8Array | 'timeout'> => {
      calls += 1;
      if (calls <= 2) return negativeRaw(0x22, UDS_NRC.RESPONSE_PENDING); // 2 extensions
      return positiveRaw(0x22, [7]);
    };
    const result = await runDidSweep({ plan, sendRequest, clock: new FakeClock(), control: control() });
    expect(calls).toBe(3);
    expect(result.responders).toEqual([{ did: 0x22, raw: Uint8Array.from([7]), length: 1, rttMs: 0 }]);
  });

  it('exhausting the 0x78 extension budget (default 5) abandons the DID as a timeout', async () => {
    const plan = createDidSweepPlan({ from: 0x30, to: 0x30 });
    let calls = 0;
    const sendRequest = async (): Promise<Uint8Array | 'timeout'> => {
      calls += 1;
      return negativeRaw(0x22, UDS_NRC.RESPONSE_PENDING); // never actually resolves
    };
    const result = await runDidSweep({
      plan,
      sendRequest,
      clock: new FakeClock(),
      control: control(),
      maxResponsePendingExtensions: 5,
    });
    expect(calls).toBe(6); // 1 initial + 5 extensions
    expect(result.timeouts).toBe(1);
    expect(result.responders).toEqual([]);
  });

  it('a sendRequest that never resolves cannot hang the sweep -- bounded by requestTimeoutMs', async () => {
    vi.useFakeTimers();
    const plan = createDidSweepPlan({ from: 0, to: 0 });
    const sendRequest = (): Promise<Uint8Array | 'timeout'> => new Promise(() => {}); // never settles
    const resultPromise = runDidSweep({ plan, sendRequest, clock: new FakeClock(), control: control(), requestTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;
    expect(result.timeouts).toBe(1);
    expect(plan.visitedCount).toBe(1);
  });

  it('never lets a throwing sendRequest abort the whole sweep -- counted as a timeout', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 1 });
    const sendRequest = async (pdu: Uint8Array): Promise<Uint8Array | 'timeout'> => {
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      if (did === 0) throw new Error('transport blew up');
      return positiveRaw(1, [1]);
    };
    const result = await runDidSweep({ plan, sendRequest, clock: new FakeClock(), control: control() });
    expect(result.timeouts).toBe(1);
    expect(result.responders).toEqual([{ did: 1, raw: Uint8Array.from([1]), length: 1, rttMs: 0 }]);
  });

  it('stops immediately once control.stopped is set, never requesting the next DID', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 4 });
    const seen: number[] = [];
    const ctl = control();
    const sendRequest = async (pdu: Uint8Array): Promise<Uint8Array | 'timeout'> => {
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      seen.push(did);
      if (did === 1) ctl.stopped = true;
      return 'timeout';
    };
    const result = await runDidSweep({ plan, sendRequest, clock: new FakeClock(), control: ctl });
    expect(seen).toEqual([0, 1]);
    expect(result.lastDid).toBe(1);
    expect(plan.visitedCount).toBe(2);
  });

  it('the cursor advances only AFTER a result -- never before/during the request', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 0 });
    let resolveSend!: (value: Uint8Array | 'timeout') => void;
    const sendRequest = (): Promise<Uint8Array | 'timeout'> =>
      new Promise((resolve) => {
        resolveSend = resolve;
      });
    const resultPromise = runDidSweep({ plan, sendRequest, clock: new FakeClock(), control: control() });
    // Give the microtask queue a turn so the request is actually in flight.
    await Promise.resolve();
    await Promise.resolve();
    expect(plan.visitedCount).toBe(0); // still not committed -- the request hasn't resolved yet
    resolveSend(positiveRaw(0, [1]));
    await resultPromise;
    expect(plan.visitedCount).toBe(1);
  });

  it('pause is re-checked AFTER every wait -- a pause set during the pacing wait is honored before the next DID is sent', async () => {
    vi.useFakeTimers();
    const plan = createDidSweepPlan({ from: 0, to: 2 });
    const clock = new FakeClock();
    const ctl = control();
    const seen: number[] = [];
    const sendRequest = async (pdu: Uint8Array): Promise<Uint8Array | 'timeout'> => {
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      seen.push(did);
      clock.advance(200); // measured RTT -- forces a real pacing wait before the NEXT did
      if (did === 0) ctl.paused = true; // paused WHILE did 1 would be waiting to be paced/sent
      return positiveRaw(did, [1]);
    };
    const resultPromise = runDidSweep({ plan, sendRequest, clock, control: ctl, pacing: { rttMultiplier: 1 } });
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
    const sendRequest = async (pdu: Uint8Array): Promise<Uint8Array | 'timeout'> => {
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      if (did === 1) ctl.paused = true;
      return positiveRaw(did, [did]);
    };

    const afterFirst = await runDidSweep({ plan, sendRequest, clock: new FakeClock(), control: ctl, accumulator: acc });
    expect(afterFirst).toBe(acc); // same reference back
    expect(afterFirst.responders.map((r) => r.did)).toEqual([0, 1]);

    ctl.paused = false;
    const afterSecond = await runDidSweep({ plan, sendRequest, clock: new FakeClock(), control: ctl, accumulator: acc });
    expect(afterSecond.responders.map((r) => r.did)).toEqual([0, 1, 2, 3]); // both runs' responders, combined
    expect(afterSecond.lastDid).toBe(3);
  });

  it('reports onProgress with the plan-relative 1-based index/total', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 2 });
    const progress: Array<{ did: number; index: number; total: number }> = [];
    const sendRequest = async (): Promise<Uint8Array | 'timeout'> => 'timeout';
    await runDidSweep({ plan, sendRequest, clock: new FakeClock(), control: control(), onProgress: (p) => progress.push(p) });
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
    const sendRequest = async (pdu: Uint8Array): Promise<Uint8Array | 'timeout'> => {
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      clock.advance(40); // simulate a 40ms round-trip on the injected clock
      return positiveRaw(did, [1]);
    };

    const resultPromise = runDidSweep({ plan, sendRequest, clock, pacing: { rttMultiplier: 1 }, control: control() });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.responders).toHaveLength(3);
    expect(clock.now()).toBe(120);
  });

  it('caps the pacing interval via maxRequestsPerSec', async () => {
    vi.useFakeTimers();
    const plan = createDidSweepPlan({ from: 0, to: 1 });
    const clock = new FakeClock();
    const sendRequest = async (): Promise<Uint8Array | 'timeout'> => 'timeout'; // no RTT signal at all
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const resultPromise = runDidSweep({
      plan,
      sendRequest,
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
    const sendRequest = async (pdu: Uint8Array): Promise<Uint8Array | 'timeout'> => {
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      clock.advance(10_000_000); // an absurd RTT -- pacing must not wait days
      return positiveRaw(did, [1]);
    };
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const resultPromise = runDidSweep({ plan, sendRequest, clock, control: control() });
    await vi.runAllTimersAsync();
    await resultPromise;
    const waitDelays = setTimeoutSpy.mock.calls.map((call) => call[1]).filter((d): d is number => typeof d === 'number' && d > 0);
    expect(waitDelays.every((d) => d <= 2_000)).toBe(true);
    setTimeoutSpy.mockRestore();
  });

  it('falls back to defaults for non-finite/negative pacing inputs instead of accepting them', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 1 });
    const sendRequest = async (pdu: Uint8Array): Promise<Uint8Array | 'timeout'> => {
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      return positiveRaw(did, [1]);
    };
    // Must not throw, hang, or produce a negative/NaN wait.
    const result = await runDidSweep({
      plan,
      sendRequest,
      clock: new FakeClock(),
      control: control(),
      pacing: { rttMultiplier: Number.NaN, minIntervalMs: -50, maxRequestsPerSec: -1 },
    });
    expect(result.responders).toHaveLength(2);
  });
});
