/**
 * DID sweep planner -- pure orchestrator (contracts.md "ENET auto-discovery &
 * DID sweep addendum", binding, dev-only feature; boundary tightened by the
 * "hard bounds & sweep boundary amendment"). Iterates a configurable DID
 * range with a single in-flight 0x22 request at a time, recording every
 * correlated positive response and NRC for the rest, with pacing adapted
 * from the measured round-trip.
 *
 * SWEEP BOUNDARY (amendment, binding, BREAKING vs. the P4f-T1 shape): this
 * module now builds the 0x22 request itself, through `assertAllowedRequest`,
 * and the injection point is the LOW-LEVEL `sendRequest(pdu) => Promise<
 * Uint8Array | 'timeout'>` -- one raw UDS response PDU (or `'timeout'`) per
 * call, not a pre-parsed `UdsParsedResponse`. Every response is parsed with
 * the real `parseUdsResponse` and correlated here:
 *   - `0x62` + the request's own echoed DID -> a responder (DID stripped).
 *   - `0x7F` with `requestSid === 0x22` and NRC `0x78` -> the wait EXTENDS
 *     (bounded, default 5 extensions: `sendRequest(pdu)` is called again for
 *     the SAME pdu, meaning "keep waiting for this already-sent request").
 *   - `0x7F` with `requestSid === 0x22` and any other NRC -> classified.
 *   - anything else (wrong SID, wrong echoed DID, unparseable bytes,
 *     `requestSid !== 0x22`) -> `unmatched`, no credit either way.
 * A per-request timeout (default 1000ms, `requestTimeoutMs`) is enforced BY
 * THE RUNNER around every `sendRequest` call (including each 0x78
 * extension), so an injected function that never resolves cannot hang the
 * sweep. This structurally guarantees only 0x22 is ever reachable -- the
 * injected function only ever receives a pdu THIS module built and
 * whitelist-checked.
 */

import type { MonotonicClock } from '../../contracts';
import { assertAllowedRequest, buildReadDataByIdentifierRequest, parseUdsResponse, UDS_NRC } from './udsCodec';

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
   * against each other and against the main range, then CLIPPED to `[from,
   * to]` -- a huge or unbounded declared range costs work proportional only
   * to the overlap actually inside the plan, never the external range's own
   * size). Each endpoint must be a finite integer (amendment: "validated
   * (finite integers)") -- `RangeError` otherwise, so a non-finite bound
   * (e.g. `Infinity`) can never turn into an unbounded loop.
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

/** Builds the (fixed, deterministic) visitation order for `[from, to]`, priority ranges first (validated + clipped). Throws `RangeError` for an out-of-bounds/inverted range, or a non-finite/non-integer priority range endpoint. */
export function createDidSweepPlan(input: CreateDidSweepPlanInput = {}): DidSweepPlan {
  const from = input.from ?? 0;
  const to = input.to ?? 0xffff;
  assertDid(from, 'from');
  assertDid(to, 'to');
  if (to < from) throw new RangeError(`DID sweep range inverted: from ${from} > to ${to}`);

  const seen = new Set<number>();
  const order: number[] = [];
  const visit = (did: number): void => {
    if (seen.has(did)) return;
    seen.add(did);
    order.push(did);
  };

  for (const range of input.priorityRanges ?? []) {
    assertFiniteInteger(range.from, 'priorityRanges[].from');
    assertFiniteInteger(range.to, 'priorityRanges[].to');
    // Clipped to [from, to] BEFORE looping -- an out-of-plan or huge
    // declared range must cost work proportional to the overlap, never to
    // the range's own (possibly enormous) declared span.
    const lo = Math.max(from, Math.min(range.from, range.to));
    const hi = Math.min(to, Math.max(range.from, range.to));
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

function assertFiniteInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(`DID sweep ${label} must be a finite integer, got ${value}`);
  }
}

// ---------- Running the sweep ----------

export interface DidSweepControl {
  paused: boolean;
  stopped: boolean;
}

export interface DidSweepPacing {
  /** Hard ceiling on request rate (EMPIRICAL default: none -- pacing is driven purely by measured RTT unless a cap is given). Non-finite/non-positive values are ignored (no cap). */
  maxRequestsPerSec?: number;
  /** Multiplier applied to the last measured round-trip to compute the adaptive minimum inter-request gap (default 1.0). Non-finite/non-positive values fall back to the default. */
  rttMultiplier?: number;
  /** Absolute floor on the inter-request gap regardless of RTT/cap (default 0). Non-finite/negative values fall back to 0. */
  minIntervalMs?: number;
}

/** Every computed inter-request gap is clamped into this range regardless of RTT/cap/floor (amendment: "pacing is clamped to 5-2000 ms"). */
export const DID_SWEEP_PACING_MIN_MS = 5;
export const DID_SWEEP_PACING_MAX_MS = 2_000;

export interface DidSweepResponder {
  did: number;
  /** The DID's data bytes with the echoed DID already stripped (the raw `0x62 hi lo ...` response minus its first 3 bytes). */
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

/**
 * Mutable running total across one or more `runDidSweep` calls against the
 * SAME plan (amendment: "results accumulate across resumes"). Create one
 * with `createDidSweepAccumulator()`, pass it in as `accumulator`, and reuse
 * the SAME object (or the one `runDidSweep` returns, which is the same
 * reference) across a paused/resumed sweep.
 */
export interface DidSweepAccumulator {
  responders: DidSweepResponder[];
  /** Keyed by NRC value. */
  nrcCounts: Record<number, number>;
  timeouts: number;
  /** A response that arrived but did not correlate to its own request (wrong SID, wrong echoed DID, unparseable) -- no credit either way, per the amendment. */
  unmatched: number;
  /** The last DID actually resolved (to ANY outcome) across every run against this accumulator, or `null` if none has been yet. */
  lastDid: number | null;
}

export function createDidSweepAccumulator(): DidSweepAccumulator {
  return { responders: [], nrcCounts: {}, timeouts: 0, unmatched: 0, lastDid: null };
}

export interface RunDidSweepInput {
  plan: DidSweepPlan;
  /** Low-level transport hook: sends the exact `pdu` bytes (built and whitelist-checked by this module) and resolves with the raw UDS response PDU, or `'timeout'`. May be called more than once per DID (once per 0x78 extension) -- each call is independently timeout-bounded by this runner, so a `sendRequest` that never resolves cannot hang the sweep. */
  sendRequest: (pdu: Uint8Array) => Promise<Uint8Array | 'timeout'>;
  clock: MonotonicClock;
  pacing?: DidSweepPacing;
  onProgress?: (progress: DidSweepProgress) => void;
  control: DidSweepControl;
  /** Reused/mutated across resumed calls (amendment: "the runner accepts and returns an accumulator"). A fresh one is created if omitted. */
  accumulator?: DidSweepAccumulator;
  /** default 1000. Enforced by the runner around every `sendRequest` call (including each 0x78 extension). */
  requestTimeoutMs?: number;
  /** default 5. Bounded count of 0x78 responsePending extensions before the DID is abandoned as a timeout. */
  maxResponsePendingExtensions?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_RESPONSE_PENDING_EXTENSIONS = 5;

type DidOutcome =
  | { type: 'responder'; raw: Uint8Array }
  | { type: 'nrc'; nrc: number }
  | { type: 'timeout' }
  | { type: 'unmatched' };

/**
 * Drains `plan` one DID at a time (respecting `control.paused`/`control.stopped`
 * -- re-checked BEFORE each DID and again immediately after every pacing
 * wait, so a pause/stop can never be missed mid-wait), pacing requests
 * adaptively from the last measured round-trip. The plan's cursor advances
 * only once a DID has resolved to a definitive outcome (never before/during
 * the request), so a pause/crash mid-request never loses or skips a DID.
 * Resuming a paused sweep: call this again with the SAME `plan` AND the
 * SAME `accumulator` (or the one this returned).
 */
export async function runDidSweep(input: RunDidSweepInput): Promise<DidSweepAccumulator> {
  const acc = input.accumulator ?? createDidSweepAccumulator();
  const requestTimeoutMs = sanitizePositive(input.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const maxResponsePendingExtensions = sanitizeNonNegativeInt(
    input.maxResponsePendingExtensions,
    DEFAULT_MAX_RESPONSE_PENDING_EXTENSIONS,
  );

  const rttMultiplier = sanitizePositive(input.pacing?.rttMultiplier, 1);
  const floorIntervalMs = sanitizeNonNegative(input.pacing?.minIntervalMs, 0);
  const rawMaxRequestsPerSec = input.pacing?.maxRequestsPerSec;
  const capIntervalMs =
    rawMaxRequestsPerSec !== undefined && Number.isFinite(rawMaxRequestsPerSec) && rawMaxRequestsPerSec > 0
      ? 1_000 / rawMaxRequestsPerSec
      : 0;

  let lastMeasuredRttMs: number | null = null;
  let nextRequestNotBeforeMs = input.clock.now();

  for (;;) {
    if (input.control.stopped || input.control.paused) break;
    const did = input.plan.peek();
    if (did === null) break;

    const now = input.clock.now();
    if (now < nextRequestNotBeforeMs) {
      await waitMs(nextRequestNotBeforeMs - now);
      // Re-checked after every wait (amendment): pause/stop set WHILE we were
      // waiting must take effect before this DID is ever sent, not just
      // before the wait started.
      if (input.control.stopped || input.control.paused) break;
    }

    const sentAtMs = input.clock.now();
    const outcome = await resolveDid(did, input.sendRequest, requestTimeoutMs, maxResponsePendingExtensions);
    const rttMs = Math.max(0, input.clock.now() - sentAtMs);

    // The cursor advances only AFTER a result (amendment) -- never before or
    // during the request, so a pause/crash mid-request leaves this DID
    // un-visited for the next resume rather than silently skipping it.
    input.plan.next();
    acc.lastDid = did;

    if (outcome.type === 'timeout') {
      acc.timeouts += 1;
    } else if (outcome.type === 'unmatched') {
      acc.unmatched += 1;
    } else if (outcome.type === 'nrc') {
      acc.nrcCounts[outcome.nrc] = (acc.nrcCounts[outcome.nrc] ?? 0) + 1;
      lastMeasuredRttMs = rttMs;
    } else {
      acc.responders.push({ did, raw: outcome.raw, length: outcome.raw.length, rttMs });
      lastMeasuredRttMs = rttMs;
    }

    input.onProgress?.({ did, index: input.plan.visitedCount, total: input.plan.total });

    const rttBasedIntervalMs = lastMeasuredRttMs === null ? 0 : lastMeasuredRttMs * rttMultiplier;
    const rawIntervalMs = Math.max(floorIntervalMs, capIntervalMs, rttBasedIntervalMs);
    const minIntervalMs = clamp(rawIntervalMs, DID_SWEEP_PACING_MIN_MS, DID_SWEEP_PACING_MAX_MS);
    nextRequestNotBeforeMs = input.clock.now() + minIntervalMs;
  }

  return acc;
}

/** Builds the 0x22 request for `did` (whitelist-checked), sends it via `sendRequest`, and correlates the response -- extending the wait on 0x78 (same pdu, up to `maxExtensions` more calls) and resolving `'timeout'` if any single `sendRequest` call (including an extension) doesn't settle within `requestTimeoutMs`. */
async function resolveDid(
  did: number,
  sendRequest: RunDidSweepInput['sendRequest'],
  requestTimeoutMs: number,
  maxExtensions: number,
): Promise<DidOutcome> {
  const pdu = buildReadDataByIdentifierRequest(did);
  assertAllowedRequest(pdu); // hard gate, re-checked even though this builder only ever emits 0x22.

  for (let extension = 0; ; extension += 1) {
    const raw = await withTimeout(sendRequest(pdu), requestTimeoutMs);
    if (raw === 'timeout') return { type: 'timeout' };

    let parsed;
    try {
      parsed = parseUdsResponse(raw);
    } catch {
      return { type: 'unmatched' }; // correct nothing decodable -- not an answer to this request.
    }

    if (parsed.kind === 'negative') {
      if (parsed.requestSid !== 0x22) return { type: 'unmatched' };
      if (parsed.nrc === UDS_NRC.RESPONSE_PENDING) {
        if (extension >= maxExtensions) return { type: 'timeout' }; // extension budget exhausted -- give up.
        continue; // extend: wait again for the SAME already-sent request.
      }
      return { type: 'nrc', nrc: parsed.nrc };
    }

    // Positive response: only 0x62 with THIS did's own echoed identifier
    // correlates -- anything else (wrong SID, wrong/missing echoed DID) is a
    // stray answer to some other request, not this one.
    if (parsed.sid !== 0x62 || parsed.data.length < 2) return { type: 'unmatched' };
    const echoedDid = ((parsed.data[0] ?? 0) << 8) | (parsed.data[1] ?? 0);
    if (echoedDid !== did) return { type: 'unmatched' };
    return { type: 'responder', raw: parsed.data.slice(2) };
  }
}

/** Races `promise` against `timeoutMs`, resolving `'timeout'` either way (never rejects) -- a `sendRequest` that throws is treated the same as one that never resolves. */
function withTimeout(promise: Promise<Uint8Array | 'timeout'>, timeoutMs: number): Promise<Uint8Array | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve('timeout');
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve('timeout');
      },
    );
  });
}

function waitMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizePositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function sanitizeNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function sanitizeNonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return fallback;
  return value;
}
