import { describe, expect, it } from 'vitest';

import {
  podImuTimeJumpIndicatesLoss,
  podSeqGap,
  PodSequenceTracker,
} from '../../../src/telemetry/pod/podSequence';

describe('podSeqGap: (cur - prev - 1) mod 65536 (PROTOCOL.md §7.1)', () => {
  it('matches the C reference test_seq_gap vectors', () => {
    expect(podSeqGap(10, 11)).toBe(0);
    expect(podSeqGap(10, 13)).toBe(2);
    expect(podSeqGap(0xffff, 0)).toBe(0);
    expect(podSeqGap(0xffff, 1)).toBe(1);
  });
  it('wraps across 65535 -> 0', () => {
    expect(podSeqGap(65530, 2)).toBe(7);
    expect(podSeqGap(0, 0xffff)).toBe(65534);
    expect(podSeqGap(5, 5)).toBe(65535); // the raw formula; the tracker calls this a duplicate
  });
});

describe('PodSequenceTracker', () => {
  it('first, in-order, gap and duplicate', () => {
    const t = new PodSequenceTracker();
    expect(t.observe(0)).toEqual({ kind: 'first', seq: 0 });
    expect(t.observe(1)).toEqual({ kind: 'inOrder', seq: 1 });
    expect(t.observe(4)).toEqual({ kind: 'gap', seq: 4, lost: 2 });
    expect(t.observe(4)).toEqual({ kind: 'duplicate', seq: 4 });
    expect(t.observe(5)).toEqual({ kind: 'inOrder', seq: 5 });
    expect(t.getStats()).toEqual({ received: 4, lost: 2, duplicates: 1, gaps: 1 });
  });

  it('wrap-around without loss and with loss', () => {
    const t = new PodSequenceTracker();
    t.observe(65534);
    expect(t.observe(65535)).toEqual({ kind: 'inOrder', seq: 65535 });
    expect(t.observe(0)).toEqual({ kind: 'inOrder', seq: 0 });
    // a step BACK by one is indistinguishable from 65534 lost frames under §7.1
    expect(t.observe(65535)).toEqual({ kind: 'gap', seq: 65535, lost: 65534 });
    const u = new PodSequenceTracker();
    u.observe(65535);
    expect(u.observe(2)).toEqual({ kind: 'gap', seq: 2, lost: 2 });
  });

  it('0xFFFF is an ordinary DATA seq to the tracker', () => {
    const t = new PodSequenceTracker();
    t.observe(0xfffe);
    expect(t.observe(0xffff)).toEqual({ kind: 'inOrder', seq: 0xffff });
  });

  it('reset() starts over (new connection: seq restarts at 0)', () => {
    const t = new PodSequenceTracker();
    t.observe(100);
    t.observe(105);
    t.reset();
    expect(t.getStats()).toEqual({ received: 0, lost: 0, duplicates: 0, gaps: 0 });
    expect(t.observe(0)).toEqual({ kind: 'first', seq: 0 });
  });

  it('rejects a seq outside u16', () => {
    const t = new PodSequenceTracker();
    expect(() => t.observe(65536)).toThrow(RangeError);
    expect(() => t.observe(-1)).toThrow(RangeError);
    expect(() => t.observe(1.5)).toThrow(RangeError);
  });
});

describe('podImuTimeJumpIndicatesLoss (§4: > 1.5 sample periods)', () => {
  it('120 Hz: period 8333.3 µs, threshold 12500 µs', () => {
    expect(podImuTimeJumpIndicatesLoss(0, 8333, 120)).toBe(false);
    expect(podImuTimeJumpIndicatesLoss(0, 12500, 120)).toBe(false);
    expect(podImuTimeJumpIndicatesLoss(0, 12501, 120)).toBe(true);
    expect(podImuTimeJumpIndicatesLoss(0, 16666, 120)).toBe(true);
  });
  it('no rate -> no verdict', () => {
    expect(podImuTimeJumpIndicatesLoss(0, 1e9, 0)).toBe(false);
  });
});
