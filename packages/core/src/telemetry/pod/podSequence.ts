/**
 * Loss detection for the TRACE Pod DATA stream (PROTOCOL.md §7.1, §4).
 *
 * `seq` is ONE u16 counter per connection shared by every pod->app frame type.
 * It starts at 0 on connect, goes up by 1 for every frame the pod GENERATES
 * (also when the BLE stack then refuses it) and wraps 65535 -> 0. Frames lost
 * between two received frames: `(cur - prev - 1) mod 65536`.
 *
 * Caller obligations (seams the transport owns):
 *  - Feed ONLY DATA-characteristic notifications. An INFO read carries seq
 *    0xFFFF and is NOT part of the sequence -- but 0xFFFF is also a legitimate
 *    DATA seq after 65535 frames, so the tracker cannot filter INFO by value.
 *  - Call `reset()` on every (re)connect: the pod restarts seq at 0.
 */

/** Frames lost between `prev` and `cur` per §7.1: `(cur - prev - 1) mod 65536`. */
export function podSeqGap(prev: number, cur: number): number {
  return (cur - prev - 1) & 0xffff;
}

/**
 * One observation of a received DATA frame's seq:
 *  - `first`     first frame since `reset()` (nothing to compare with)
 *  - `inOrder`   cur == prev + 1 (mod 65536)
 *  - `gap`       `lost` frames missing (the §7.1 formula, 1..65534)
 *  - `duplicate` cur == prev. §7.1's formula would read this as 65535 lost;
 *                it is classified as a duplicate instead and does not move
 *                the tracker (see the module report: §7.1 does not name
 *                duplicates).
 *
 * A frame that arrives OUT OF ORDER is indistinguishable from a large gap under
 * §7.1 and is reported as one (BLE notifications on one link are delivered in
 * order, so this is not expected).
 */
export type PodSeqObservation =
  | { kind: 'first'; seq: number }
  | { kind: 'inOrder'; seq: number }
  | { kind: 'gap'; seq: number; lost: number }
  | { kind: 'duplicate'; seq: number };

export interface PodSeqStats {
  received: number;
  lost: number;
  duplicates: number;
  gaps: number;
}

export class PodSequenceTracker {
  private prev: number | null = null;
  private stats: PodSeqStats = { received: 0, lost: 0, duplicates: 0, gaps: 0 };

  /** Forget the previous seq and the counters (call on every connect). */
  reset(): void {
    this.prev = null;
    this.stats = { received: 0, lost: 0, duplicates: 0, gaps: 0 };
  }

  observe(seq: number): PodSeqObservation {
    if (!Number.isInteger(seq) || seq < 0 || seq > 0xffff) {
      throw new RangeError(`seq must be an integer 0..65535, got ${seq}`);
    }
    const prev = this.prev;
    if (prev === null) {
      this.prev = seq;
      this.stats.received++;
      return { kind: 'first', seq };
    }
    if (seq === prev) {
      this.stats.duplicates++;
      return { kind: 'duplicate', seq };
    }
    this.prev = seq;
    this.stats.received++;
    const lost = podSeqGap(prev, seq);
    if (lost === 0) return { kind: 'inOrder', seq };
    this.stats.lost += lost;
    this.stats.gaps++;
    return { kind: 'gap', seq, lost };
  }

  getStats(): PodSeqStats {
    return { ...this.stats };
  }
}

/**
 * §4: a jump in IMU sample time larger than 1.5 sample periods means samples
 * were lost. `prevTPodUs`/`curTPodUs` are consecutive sample times (pod µs,
 * `t0PodUs + dtUs`), `rateHz` the batch's nominal rate. Returns false when
 * `rateHz` is not positive (no period to compare with).
 */
export function podImuTimeJumpIndicatesLoss(
  prevTPodUs: number,
  curTPodUs: number,
  rateHz: number,
): boolean {
  if (!(rateHz > 0)) return false;
  return curTPodUs - prevTPodUs > 1.5 * (1e6 / rateHz);
}
