import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDidSweepPlan, runDidSweep, type DidSweepControl } from '../../../src/telemetry/enet/didSweep';
import type { UdsParsedResponse } from '../../../src/telemetry/enet/udsCodec';
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
});

function positive(data: number[]): UdsParsedResponse {
  return { kind: 'positive', sid: 0x62, data: Uint8Array.from(data) };
}
function negative(nrc: number): UdsParsedResponse {
  return { kind: 'negative', requestSid: 0x22, nrc };
}

function control(overrides: Partial<DidSweepControl> = {}): DidSweepControl {
  return { paused: false, stopped: false, ...overrides };
}

describe('runDidSweep', () => {
  it('collects responders, classifies NRCs (including 0x78), and counts timeouts', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 4 });
    const request = async (did: number): Promise<UdsParsedResponse | 'timeout'> => {
      if (did === 0) return positive([0xaa]);
      if (did === 1) return negative(0x11); // serviceNotSupported
      if (did === 2) return negative(0x78); // responsePending, surfaced as final by this fake `request`
      if (did === 3) return 'timeout';
      return positive([0xbb, 0xcc]);
    };

    const result = await runDidSweep({ plan, request, clock: new FakeClock(), control: control() });

    expect(result.responders).toEqual([
      { did: 0, raw: Uint8Array.from([0xaa]), length: 1, rttMs: 0 },
      { did: 4, raw: Uint8Array.from([0xbb, 0xcc]), length: 2, rttMs: 0 },
    ]);
    expect(result.nrcCounts).toEqual({ 0x11: 1, 0x78: 1 });
    expect(result.timeouts).toBe(1);
    expect(result.lastDid).toBe(4);
  });

  it('never lets a throwing `request` abort the whole sweep -- counted as a timeout', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 1 });
    const request = async (did: number): Promise<UdsParsedResponse | 'timeout'> => {
      if (did === 0) throw new Error('transport blew up');
      return positive([1]);
    };
    const result = await runDidSweep({ plan, request, clock: new FakeClock(), control: control() });
    expect(result.timeouts).toBe(1);
    expect(result.responders).toEqual([{ did: 1, raw: Uint8Array.from([1]), length: 1, rttMs: 0 }]);
  });

  it('stops immediately once control.stopped is set, never requesting the next DID', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 4 });
    const seen: number[] = [];
    const ctl = control();
    const request = async (did: number): Promise<UdsParsedResponse | 'timeout'> => {
      seen.push(did);
      if (did === 1) ctl.stopped = true;
      return 'timeout';
    };
    const result = await runDidSweep({ plan, request, clock: new FakeClock(), control: ctl });
    expect(seen).toEqual([0, 1]);
    expect(result.lastDid).toBe(1);
    expect(plan.visitedCount).toBe(2);
  });

  it('pauses (stops pulling from the plan) and resumes later from the SAME plan instance', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 4 });
    const seen: number[] = [];
    const ctl = control();
    const request = async (did: number): Promise<UdsParsedResponse | 'timeout'> => {
      seen.push(did);
      if (did === 1) ctl.paused = true;
      return 'timeout';
    };

    const first = await runDidSweep({ plan, request, clock: new FakeClock(), control: ctl });
    expect(seen).toEqual([0, 1]);
    expect(first.lastDid).toBe(1);
    expect(plan.visitedCount).toBe(2);

    ctl.paused = false;
    const second = await runDidSweep({ plan, request, clock: new FakeClock(), control: ctl });
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(second.lastDid).toBe(4);
    expect(plan.visitedCount).toBe(5);
  });

  it('reports onProgress with the plan-relative 1-based index/total', async () => {
    const plan = createDidSweepPlan({ from: 0, to: 2 });
    const progress: Array<{ did: number; index: number; total: number }> = [];
    const request = async (): Promise<UdsParsedResponse | 'timeout'> => 'timeout';
    await runDidSweep({ plan, request, clock: new FakeClock(), control: control(), onProgress: (p) => progress.push(p) });
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
    const request = async (): Promise<UdsParsedResponse | 'timeout'> => {
      clock.advance(40); // simulate a 40ms round-trip on the injected clock
      return positive([1]);
    };

    const resultPromise = runDidSweep({ plan, request, clock, pacing: { rttMultiplier: 1 }, control: control() });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.responders).toHaveLength(3);
    // 3 requests each advancing the clock by 40ms => clock.now() ends at 120,
    // and the pacing wait between requests must have been exercised (real
    // setTimeout calls flushed above) for the 2nd/3rd request to even run.
    expect(clock.now()).toBe(120);
  });

  it('caps the pacing interval via maxRequestsPerSec', async () => {
    vi.useFakeTimers();
    const plan = createDidSweepPlan({ from: 0, to: 1 });
    const clock = new FakeClock();
    const request = async (): Promise<UdsParsedResponse | 'timeout'> => 'timeout'; // no RTT signal at all
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const resultPromise = runDidSweep({
      plan,
      request,
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
});
