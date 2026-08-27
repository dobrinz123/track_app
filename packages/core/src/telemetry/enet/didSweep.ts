/**
 * DID sweep planner -- pure orchestrator (contracts.md "ENET auto-discovery &
 * DID sweep addendum", binding, dev-only feature). Iterates a configurable
 * DID range with a single in-flight 0x22 request at a time, recording every
 * positive response and NRC for the rest, with pacing adapted from the
 * measured round-trip.
 *
 * The actual wire exchange (whitelisted codec, TesterPresent cadence, 0x78
 * responsePending extension) is INJECTED via `request` -- this module never
 * touches a transport or builds a PDU itself, so it structurally cannot send
 * anything but "read this one DID" (the whitelist gate lives in `udsCodec`
 * and is re-checked wherever `request` is actually wired to a live session).
 */

import type { MonotonicClock } from '../../contracts';
import type { UdsParsedResponse } from './udsCodec';

export interface DidSweepRange {
  from: number;
  to: number;
}

export interface CreateDidSweepPlanInput {
  /** default 0. */
  from?: number;
  /** default 0xFFFF. */
  to?: number;
  /**
   * Visited BEFORE the rest of `[from, to]`, in the order given (deduped
   * against each other and against the main range) -- lets a caller front-load
   * DIDs likely to matter (e.g. a range a previous sweep flagged) without
   * losing exhaustive coverage of the rest.
   */
  priorityRanges?: readonly DidSweepRange[];
}

/**
 * A resumable DID visitation order. Stateful by design: `next()` advances an
 * internal cursor, so pausing a sweep is simply "stop calling `next()`" and
 * resuming is "call `runDidSweep` again with this SAME plan instance" --
 * every DID already visited is never revisited, with no separate resume
 * token required. `peek()`/`visitedCount` let a caller inspect progress
 * without consuming the next DID.
 */
export interface DidSweepPlan {
  readonly from: number;
  readonly to: number;
  /** Full visitation order (priority ranges first, deduped, then the rest of `[from, to]` ascending). Fixed at construction. */
  readonly order: readonly number[];
  readonly total: number;
  readonly visitedCount: number;
  peek(): number | null;
  next(): number | null;
}

class DidSweepPlanImpl implements DidSweepPlan {
  private cursor = 0;
  constructor(
    readonly from: number,
    readonly to: number,
    readonly order: readonly number[],
  ) {}

  get total(): number {
    return this.order.length;
  }

  get visitedCount(): number {
    return this.cursor;
  }

  peek(): number | null {
    return this.cursor < this.order.length ? (this.order[this.cursor] ?? null) : null;
  }

  next(): number | null {
    if (this.cursor >= this.order.length) return null;
    const did = this.order[this.cursor] ?? null;
    this.cursor += 1;
    return did;
  }
}

/** Builds the (fixed, deterministic) visitation order for `[from, to]`, priority ranges first. Throws `RangeError` for an out-of-bounds or inverted range. */
export function createDidSweepPlan(input: CreateDidSweepPlanInput = {}): DidSweepPlan {
  const from = input.from ?? 0;
  const to = input.to ?? 0xffff;
  assertDid(from, 'from');
  assertDid(to, 'to');
  if (to < from) throw new RangeError(`DID sweep range inverted: from ${from} > to ${to}`);

  const seen = new Set<number>();
  const order: number[] = [];
  const visit = (did: number): void => {
    if (did < from || did > to) return; // priority ranges are clipped to [from, to]
    if (seen.has(did)) return;
    seen.add(did);
    order.push(did);
  };

  for (const range of input.priorityRanges ?? []) {
    const lo = Math.min(range.from, range.to);
    const hi = Math.max(range.from, range.to);
    for (let did = lo; did <= hi; did += 1) visit(did);
  }
  for (let did = from; did <= to; did += 1) visit(did);

  return new DidSweepPlanImpl(from, to, order);
}

function assertDid(did: number, label: string): void {
  if (!Number.isInteger(did) || did < 0 || did > 0xffff) {
    throw new RangeError(`DID sweep ${label} out of range [0, 0xFFFF]: ${did}`);
  }
}

// ---------- Running the sweep ----------

export interface DidSweepControl {
  paused: boolean;
  stopped: boolean;
}

export interface DidSweepPacing {
  /** Hard ceiling on request rate (EMPIRICAL default: none -- pacing is driven purely by measured RTT unless a cap is given). */
  maxRequestsPerSec?: number;
  /** Multiplier applied to the last measured round-trip to compute the adaptive minimum inter-request gap (default 1.0 -- wait at least one RTT). */
  rttMultiplier?: number;
  /** Absolute floor on the inter-request gap regardless of RTT/cap (default 0). */
  minIntervalMs?: number;
}

export interface DidSweepResponder {
  did: number;
  raw: Uint8Array;
  length: number;
  rttMs: number;
}

export interface DidSweepProgress {
  did: number;
  /** 1-based position within the plan's full `order` (persists across a paused/resumed run, since it comes from the plan's own cursor). */
  index: number;
  total: number;
}

export interface RunDidSweepInput {
  plan: DidSweepPlan;
  /** Sends ONE 0x22 request for `did` and resolves with the parsed response, or `'timeout'`. Never expected to throw -- if it does, the DID is counted as a timeout (never aborts the whole sweep). */
  request: (did: number) => Promise<UdsParsedResponse | 'timeout'>;
  clock: MonotonicClock;
  pacing?: DidSweepPacing;
  onProgress?: (progress: DidSweepProgress) => void;
  control: DidSweepControl;
}

export interface RunDidSweepResult {
  responders: DidSweepResponder[];
  /** Keyed by NRC value (e.g. `0x78` counts every responsePending `request` itself surfaced as a final outcome, same as any other NRC). */
  nrcCounts: Record<number, number>;
  timeouts: number;
  /** The last DID actually requested this run, or `null` if none was (already exhausted, or paused/stopped before the first request). */
  lastDid: number | null;
}

/**
 * Drains `plan` one DID at a time (respecting `control.paused`/`control.stopped`,
 * checked before every request so a pause/stop takes effect at the next DID
 * boundary, never mid-request), pacing requests adaptively from the last
 * measured round-trip. Resuming a paused sweep is done by calling this again
 * with the SAME `plan` (its cursor already reflects everything visited so far).
 */
export async function runDidSweep(input: RunDidSweepInput): Promise<RunDidSweepResult> {
  const responders: DidSweepResponder[] = [];
  const nrcCounts: Record<number, number> = {};
  let timeouts = 0;
  let lastDid: number | null = null;
  let lastMeasuredRttMs: number | null = null;

  const rttMultiplier = input.pacing?.rttMultiplier ?? 1;
  const floorIntervalMs = input.pacing?.minIntervalMs ?? 0;
  const capIntervalMs =
    input.pacing?.maxRequestsPerSec !== undefined && input.pacing.maxRequestsPerSec > 0
      ? 1_000 / input.pacing.maxRequestsPerSec
      : 0;

  let nextRequestNotBeforeMs = input.clock.now();

  for (;;) {
    if (input.control.stopped || input.control.paused) break;
    const did = input.plan.peek();
    if (did === null) break;

    const now = input.clock.now();
    if (now < nextRequestNotBeforeMs) {
      await waitMs(nextRequestNotBeforeMs - now);
    }

    input.plan.next(); // commit to visiting `did` now that pacing has been honored
    const sentAtMs = input.clock.now();
    let outcome: UdsParsedResponse | 'timeout';
    try {
      outcome = await input.request(did);
    } catch {
      outcome = 'timeout';
    }
    const rttMs = Math.max(0, input.clock.now() - sentAtMs);
    lastDid = did;

    if (outcome === 'timeout') {
      timeouts += 1;
    } else if (outcome.kind === 'negative') {
      nrcCounts[outcome.nrc] = (nrcCounts[outcome.nrc] ?? 0) + 1;
      lastMeasuredRttMs = rttMs;
    } else {
      responders.push({ did, raw: outcome.data, length: outcome.data.length, rttMs });
      lastMeasuredRttMs = rttMs;
    }

    input.onProgress?.({ did, index: input.plan.visitedCount, total: input.plan.total });

    const rttBasedIntervalMs = lastMeasuredRttMs === null ? 0 : lastMeasuredRttMs * rttMultiplier;
    const minIntervalMs = Math.max(floorIntervalMs, capIntervalMs, rttBasedIntervalMs);
    nextRequestNotBeforeMs = input.clock.now() + minIntervalMs;
  }

  return { responders, nrcCounts, timeouts, lastDid };
}

function waitMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}
