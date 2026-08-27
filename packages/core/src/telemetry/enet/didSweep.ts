/**
 * DID sweep planner -- pure orchestrator (contracts.md "ENET auto-discovery &
 * DID sweep addendum", binding, dev-only feature; boundary tightened by the
 * "hard bounds & sweep boundary amendment", then again by the "sweep
 * transport interface & lifecycle amendment"). Iterates a configurable DID
 * range with a single in-flight 0x22 request at a time, recording every
 * correlated positive response and NRC for the rest, with pacing adapted
 * from the measured round-trip.
 *
 * SWEEP TRANSPORT INTERFACE (amendment, binding, BREAKING vs. the prior
 * `sendRequest(pdu)` shape): the injection point is now
 *
 *   { send(pdu): Promise<void>;
 *     nextResponse(timeoutMs): Promise<Uint8Array | 'timeout'>;
 *     keepAlive(pdu): Promise<void> }
 *
 * The runner sends the 0x22 PDU ONCE via `send`, then awaits `nextResponse`.
 * Every response is parsed with the real `parseUdsResponse` and correlated
 * here (the mobile implementation of `nextResponse` returns ANY diagnostic
 * PDU from the target with swapped addresses -- correlation by SID/
 * identifier is entirely this runner's job, not the transport's):
 *   - `0x62` + the request's own echoed DID -> a responder (DID stripped).
 *   - `0x7F`, `requestSid === 0x22`, NRC `0x78` -> the wait EXTENDS: awaits
 *     `nextResponse` AGAIN, WITHOUT re-sending (bounded, default 5
 *     extensions; each extension gets a FRESH `requestTimeoutMs` window,
 *     matching UDS semantics -- 0x78 means "I need more time", not "ask
 *     again").
 *   - `0x7F`, `requestSid === 0x22`, any other NRC -> classified.
 *   - anything else (wrong SID, wrong echoed DID, unparseable bytes,
 *     `requestSid !== 0x22`) -> counted as `unmatched` (a running tally, NOT
 *     a terminal outcome) and the runner keeps awaiting `nextResponse` within
 *     the REMAINING (NOT reset) timeout window, bounded (default 3 retries).
 * A synchronous throw OR a rejection from `send`/`nextResponse`/`keepAlive`
 * is contained -- never propagates out of `runDidSweep` -- and counted in
 * `accumulator.errors`; `maxConsecutiveErrors` consecutive interface failures
 * (across sends, waits, and keep-alives) stop the sweep early (mirrors
 * `enetSession`'s own error-budget pattern), same as `control.stopped`.
 * `keepAlive` sends a whitelisted TesterPresent roughly every
 * `keepAliveIntervalMs` (default 2000) of the injected clock's time, checked
 * both between DIDs and within a single DID's own 0x78/unmatched retry loop
 * (so a slow multi-extension exchange still gets its keep-alives).
 */

import type { MonotonicClock } from '../../contracts';
import type { DidResponderSample, DidResponderSeries } from './didHeuristics';
import { assertAllowedRequest, buildReadDataByIdentifierRequest, buildTesterPresentRequest, parseUdsResponse, UDS_NRC } from './udsCodec';

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
  /** A DID that never resolved to a positive/NRC outcome within its budget -- includes a genuine `nextResponse` timeout, an exhausted 0x78/unmatched budget, and a `send`/`nextResponse` interface failure for that DID. */
  timeouts: number;
  /** Running count of individual responses that arrived but did not correlate to their own request (wrong SID, wrong echoed DID, unparseable) -- may exceed the number of DIDs swept (several per DID are possible), no credit either way. */
  unmatched: number;
  /** Running count of `send`/`nextResponse`/`keepAlive` calls that threw synchronously or rejected (amendment: "counted as errors"). */
  errors: number;
  /** The last DID actually resolved (to ANY outcome) across every run against this accumulator, or `null` if none has been yet. */
  lastDid: number | null;
}

export function createDidSweepAccumulator(): DidSweepAccumulator {
  return { responders: [], nrcCounts: {}, timeouts: 0, unmatched: 0, errors: 0, lastDid: null };
}

/**
 * Low-level transport hook (amendment) -- the runner builds/whitelists every
 * PDU it sends; the transport only ever moves bytes. A synchronous throw or
 * a rejection from ANY method is contained by the runner (never propagates
 * out of `runDidSweep`) and counted in `accumulator.errors`.
 */
export interface SweepTransport {
  /** Sends `pdu` once. Resolves once the bytes are handed off (does not itself wait for a reply). */
  send(pdu: Uint8Array): Promise<void>;
  /** Resolves with the next diagnostic PDU the transport observes (ANY, with swapped addresses already stripped by the transport -- correlation by SID/identifier is the runner's job), or `'timeout'` once `timeoutMs` elapses with none. */
  nextResponse(timeoutMs: number): Promise<Uint8Array | 'timeout'>;
  /** Sends a keep-alive PDU (a whitelisted TesterPresent, built by the runner) without expecting/awaiting a reply. */
  keepAlive(pdu: Uint8Array): Promise<void>;
}

export interface RunDidSweepInput {
  plan: DidSweepPlan;
  transport: SweepTransport;
  clock: MonotonicClock;
  pacing?: DidSweepPacing;
  onProgress?: (progress: DidSweepProgress) => void;
  control: DidSweepControl;
  /** Reused/mutated across resumed calls (amendment: "the runner accepts and returns an accumulator"). A fresh one is created if omitted. */
  accumulator?: DidSweepAccumulator;
  /** default 1000. The overall budget for ONE DID's exchange; reset to a FRESH window on each 0x78 extension, NOT reset by an unmatched reply. */
  requestTimeoutMs?: number;
  /** default 5. Bounded count of 0x78 responsePending extensions before the DID is abandoned as a timeout. */
  maxResponsePendingExtensions?: number;
  /** default 3. Bounded count of unmatched replies tolerated within one DID's remaining timeout window before it's abandoned as a timeout. */
  maxUnmatchedRetries?: number;
  /** default 2000. Cadence (on the injected clock) at which a whitelisted TesterPresent is sent via `transport.keepAlive`. */
  keepAliveIntervalMs?: number;
  /** default 5. Consecutive `send`/`nextResponse`/`keepAlive` failures (throw or rejection) before the sweep stops itself, same as `control.stopped`. Resets to 0 on any successful interface call. */
  maxConsecutiveErrors?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_RESPONSE_PENDING_EXTENSIONS = 5;
const DEFAULT_MAX_UNMATCHED_RETRIES = 3;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 2_000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
/** Small grace added on top of the timeout already passed to `nextResponse` itself -- this runner's OWN backstop against a transport that doesn't honor its `timeoutMs` argument, not a tuning knob. */
const GUARD_GRACE_MS = 50;

type DidOutcome = { type: 'responder'; raw: Uint8Array } | { type: 'nrc'; nrc: number } | { type: 'timeout' };

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
  const maxExtensions = sanitizeNonNegativeInt(input.maxResponsePendingExtensions, DEFAULT_MAX_RESPONSE_PENDING_EXTENSIONS);
  const maxUnmatchedRetries = sanitizeNonNegativeInt(input.maxUnmatchedRetries, DEFAULT_MAX_UNMATCHED_RETRIES);
  const keepAliveIntervalMs = sanitizePositive(input.keepAliveIntervalMs, DEFAULT_KEEPALIVE_INTERVAL_MS);
  const maxConsecutiveErrors = Math.max(1, sanitizeNonNegativeInt(input.maxConsecutiveErrors, DEFAULT_MAX_CONSECUTIVE_ERRORS));

  const rttMultiplier = sanitizePositive(input.pacing?.rttMultiplier, 1);
  const floorIntervalMs = sanitizeNonNegative(input.pacing?.minIntervalMs, 0);
  const rawMaxRequestsPerSec = input.pacing?.maxRequestsPerSec;
  const capIntervalMs =
    rawMaxRequestsPerSec !== undefined && Number.isFinite(rawMaxRequestsPerSec) && rawMaxRequestsPerSec > 0
      ? 1_000 / rawMaxRequestsPerSec
      : 0;

  let lastMeasuredRttMs: number | null = null;
  let nextRequestNotBeforeMs = input.clock.now();

  const errorBudget = createErrorBudget(maxConsecutiveErrors, () => {
    acc.errors += 1;
  });
  const maybeKeepAlive = createKeepAliveTicker(
    input.transport,
    input.clock,
    keepAliveIntervalMs,
    requestTimeoutMs,
    errorBudget.recordCallOutcome,
  );

  for (;;) {
    if (input.control.stopped || input.control.paused || errorBudget.shouldStop()) break;
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

    await maybeKeepAlive();
    if (errorBudget.shouldStop()) break; // a keep-alive failure just tipped us over -- stop before sending anything more.

    const sentAtMs = input.clock.now();
    const { outcome, unmatchedCount } = await resolveDid(
      did,
      input.transport,
      input.clock,
      requestTimeoutMs,
      maxExtensions,
      maxUnmatchedRetries,
      errorBudget.recordCallOutcome,
      errorBudget.shouldStop,
      maybeKeepAlive,
    );
    const rttMs = Math.max(0, input.clock.now() - sentAtMs);

    // The cursor advances only AFTER a result (amendment) -- never before or
    // during the request, so a pause/crash mid-request leaves this DID
    // un-visited for the next resume rather than silently skipping it.
    input.plan.next();
    acc.lastDid = did;
    acc.unmatched += unmatchedCount;

    if (outcome.type === 'timeout') {
      acc.timeouts += 1;
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

// ---------- Observation runner (amendment: "observation runner & lifecycle race") ----------

export interface RunDidObservationInput {
  /** Fixed set of DIDs to poll round-robin. Order is preserved in the returned `series`. */
  responders: readonly number[];
  transport: SweepTransport;
  clock: MonotonicClock;
  durationMs: number;
  /** default 1. Target full ROUNDS (one poll of every responder) per second -- amendment: "round-robin over responders at targetHz". Non-finite/non-positive falls back to the default. */
  targetHz?: number;
  pacing?: DidSweepPacing;
  control: DidSweepControl;
  /** Invoked for every correlated 0x62 response (DID-stripped payload), in addition to being accumulated into the returned `series`. */
  onSample?: (did: number, raw: Uint8Array, tMs: number) => void;
  /** default 1000. Same meaning as `RunDidSweepInput.requestTimeoutMs`, applied per responder poll. */
  requestTimeoutMs?: number;
  /** default 5. */
  maxResponsePendingExtensions?: number;
  /** default 3. */
  maxUnmatchedRetries?: number;
  /** default 2000. Owned by this ONE loop for the entire window (amendment/REV3 fix: a caller that instead re-invoked a per-DID runner for every poll reset this deadline every time, so keep-alive could go unsent for an entire fast-responding observation). */
  keepAliveIntervalMs?: number;
  /** default 5. Consecutive interface failures across the WHOLE window (not reset between responders) before the loop stops itself, same as `control.stopped`. */
  maxConsecutiveErrors?: number;
}

export interface RunDidObservationResult {
  /** One entry per input responder (same order), each ready to feed straight into `classifyResponders`. */
  series: DidResponderSeries[];
  /** Consecutive-interface-failure count across the whole window (see `RunDidSweepInput.maxConsecutiveErrors`'s doc for what counts as an "error"). */
  errors: number;
  /** True if ANY full round (one poll of every responder) took longer than `1000 / targetHz` ms. */
  cadenceDegraded: boolean;
}

const DEFAULT_TARGET_HZ = 1;
/** How often `runDidObservation` re-checks `control.paused`/the window deadline while paused. Not a tuning knob. */
const PAUSE_POLL_INTERVAL_MS = 50;

/**
 * ONE long-running loop (amendment: "the mobile observation phase uses it --
 * never per-DID sweep runs") that polls `responders` round-robin for
 * `durationMs`, targeting `targetHz` full rounds per second. Keep-alive
 * cadence, pacing, and the consecutive-error budget are owned by THIS loop
 * for the WHOLE window -- the REV3 defect this fixes was re-invoking a
 * per-DID sweep run for every single poll, which recreated (and therefore
 * effectively disabled) all three every time a response arrived quickly.
 * Every correlated 0x62 is reported via `onSample` AND accumulated into the
 * returned per-responder `series` (same shape `classifyResponders` expects).
 * `control` is re-checked at every responder boundary and while paused, same
 * discipline as `runDidSweep`.
 */
export async function runDidObservation(input: RunDidObservationInput): Promise<RunDidObservationResult> {
  if (input.responders.length === 0) {
    return { series: [], errors: 0, cadenceDegraded: false };
  }

  const requestTimeoutMs = sanitizePositive(input.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const maxExtensions = sanitizeNonNegativeInt(input.maxResponsePendingExtensions, DEFAULT_MAX_RESPONSE_PENDING_EXTENSIONS);
  const maxUnmatchedRetries = sanitizeNonNegativeInt(input.maxUnmatchedRetries, DEFAULT_MAX_UNMATCHED_RETRIES);
  const keepAliveIntervalMs = sanitizePositive(input.keepAliveIntervalMs, DEFAULT_KEEPALIVE_INTERVAL_MS);
  const maxConsecutiveErrors = Math.max(1, sanitizeNonNegativeInt(input.maxConsecutiveErrors, DEFAULT_MAX_CONSECUTIVE_ERRORS));
  const targetHz = sanitizePositive(input.targetHz, DEFAULT_TARGET_HZ);
  const roundBudgetMs = 1_000 / targetHz;

  const rttMultiplier = sanitizePositive(input.pacing?.rttMultiplier, 1);
  const floorIntervalMs = sanitizeNonNegative(input.pacing?.minIntervalMs, 0);
  const rawMaxRequestsPerSec = input.pacing?.maxRequestsPerSec;
  const capIntervalMs =
    rawMaxRequestsPerSec !== undefined && Number.isFinite(rawMaxRequestsPerSec) && rawMaxRequestsPerSec > 0
      ? 1_000 / rawMaxRequestsPerSec
      : 0;

  let errors = 0;
  const errorBudget = createErrorBudget(maxConsecutiveErrors, () => {
    errors += 1;
  });
  const maybeKeepAlive = createKeepAliveTicker(
    input.transport,
    input.clock,
    keepAliveIntervalMs,
    requestTimeoutMs,
    errorBudget.recordCallOutcome,
  );

  const samplesByDid = new Map<number, DidResponderSample[]>();
  for (const did of input.responders) samplesByDid.set(did, []);

  const startedAtMs = input.clock.now();
  const endAtMs = startedAtMs + Math.max(0, input.durationMs);
  let cadenceDegraded = false;
  let lastMeasuredRttMs: number | null = null;
  let nextRequestNotBeforeMs = startedAtMs;

  /** Re-checked at every responder boundary (same discipline as `runDidSweep`'s pacing-wait recheck). Returns true once the caller should stop entirely -- `control.stopped`, or the window elapsing while paused. */
  const waitWhilePaused = async (): Promise<boolean> => {
    while (input.control.paused && !input.control.stopped) {
      if (input.clock.now() >= endAtMs) return true;
      await waitMs(PAUSE_POLL_INTERVAL_MS);
    }
    return input.control.stopped;
  };

  outer: while (input.clock.now() < endAtMs) {
    if (input.control.stopped) break;
    if (await waitWhilePaused()) break;
    if (errorBudget.shouldStop()) break;

    const roundStartMs = input.clock.now();

    for (const did of input.responders) {
      if (input.control.stopped) break outer;
      if (await waitWhilePaused()) break outer;
      if (errorBudget.shouldStop()) break outer;
      if (input.clock.now() >= endAtMs) break outer;

      const now = input.clock.now();
      if (now < nextRequestNotBeforeMs) {
        await waitMs(nextRequestNotBeforeMs - now);
        if (input.control.stopped) break outer;
      }

      await maybeKeepAlive();
      if (errorBudget.shouldStop()) break outer;

      const sentAtMs = input.clock.now();
      const { outcome } = await resolveDid(
        did,
        input.transport,
        input.clock,
        requestTimeoutMs,
        maxExtensions,
        maxUnmatchedRetries,
        errorBudget.recordCallOutcome,
        errorBudget.shouldStop,
        maybeKeepAlive,
      );
      const rttMs = Math.max(0, input.clock.now() - sentAtMs);

      if (outcome.type === 'responder') {
        const tMs = input.clock.now();
        samplesByDid.get(did)?.push({ tMs, raw: outcome.raw });
        input.onSample?.(did, outcome.raw, tMs);
        lastMeasuredRttMs = rttMs;
      } else if (outcome.type === 'nrc') {
        lastMeasuredRttMs = rttMs;
      }

      const rttBasedIntervalMs = lastMeasuredRttMs === null ? 0 : lastMeasuredRttMs * rttMultiplier;
      const rawIntervalMs = Math.max(floorIntervalMs, capIntervalMs, rttBasedIntervalMs);
      const minIntervalMs = clamp(rawIntervalMs, DID_SWEEP_PACING_MIN_MS, DID_SWEEP_PACING_MAX_MS);
      nextRequestNotBeforeMs = input.clock.now() + minIntervalMs;
    }

    const roundElapsedMs = input.clock.now() - roundStartMs;
    if (roundElapsedMs > roundBudgetMs) {
      cadenceDegraded = true;
    } else if (!input.control.stopped && input.clock.now() < endAtMs) {
      const remainingMs = roundBudgetMs - roundElapsedMs;
      if (remainingMs > 0) await waitMs(remainingMs);
    }
  }

  const series: DidResponderSeries[] = input.responders.map((did) => ({ did, samples: samplesByDid.get(did) ?? [] }));
  return { series, errors, cadenceDegraded };
}

interface ErrorBudget {
  /** Call after EVERY interface (`send`/`nextResponse`/`keepAlive`) attempt: `true` resets the consecutive count, `false` bumps it (and invokes `onError`, e.g. to increment a caller-owned `.errors` counter). */
  recordCallOutcome: (ok: boolean) => void;
  /** True once `maxConsecutiveErrors` consecutive failures have been recorded. */
  shouldStop: () => boolean;
}

/** Shared consecutive-interface-failure budget, used identically by `runDidSweep` and `runDidObservation` (extracted so both runners enforce the amendment's error-budget rule the SAME way, not two hand-copied ones). */
function createErrorBudget(maxConsecutiveErrors: number, onError: () => void): ErrorBudget {
  let consecutive = 0;
  return {
    recordCallOutcome: (ok) => {
      if (ok) {
        consecutive = 0;
      } else {
        onError();
        consecutive += 1;
      }
    },
    shouldStop: () => consecutive >= maxConsecutiveErrors,
  };
}

/** Shared keep-alive ticker, used identically by `runDidSweep` and `runDidObservation`: best-effort, checked at call sites throughout each runner's own loop (between DIDs/responders AND inside a single exchange's own retry loop), never resetting its own schedule just because a call failed (amendment: "every 2 s"). */
function createKeepAliveTicker(
  transport: SweepTransport,
  clock: MonotonicClock,
  keepAliveIntervalMs: number,
  requestTimeoutMs: number,
  recordCallOutcome: (ok: boolean) => void,
): () => Promise<void> {
  let nextKeepAliveAtMs = clock.now() + keepAliveIntervalMs;
  return async () => {
    if (clock.now() < nextKeepAliveAtMs) return;
    nextKeepAliveAtMs = clock.now() + keepAliveIntervalMs; // scheduled regardless of outcome -- never a tight retry loop on repeated failure.
    const pdu = buildTesterPresentRequest();
    assertAllowedRequest(pdu);
    const result = await guardedCall(() => transport.keepAlive(pdu), requestTimeoutMs);
    recordCallOutcome(result.ok);
  };
}

/**
 * Builds the 0x22 request for `did` (whitelist-checked), sends it ONCE via
 * `transport.send`, then correlates whatever `transport.nextResponse`
 * yields -- extending on 0x78 (fresh window, no re-send) and tolerating a
 * bounded number of unmatched replies within the remaining window. Every
 * `transport` call is guarded: a synchronous throw, a rejection, or exceeding
 * its own timeout all resolve the SAME way (never propagate), reported via
 * `onCallOutcome`. `shouldStopForErrors`/`maybeKeepAlive` are re-checked
 * between attempts so a long multi-extension exchange still respects the
 * error budget and keep-alive cadence.
 */
async function resolveDid(
  did: number,
  transport: SweepTransport,
  clock: MonotonicClock,
  requestTimeoutMs: number,
  maxExtensions: number,
  maxUnmatchedRetries: number,
  onCallOutcome: (ok: boolean) => void,
  shouldStopForErrors: () => boolean,
  maybeKeepAlive: () => Promise<void>,
): Promise<{ outcome: DidOutcome; unmatchedCount: number }> {
  const pdu = buildReadDataByIdentifierRequest(did);
  assertAllowedRequest(pdu); // hard gate, re-checked even though this builder only ever emits 0x22.

  const sendResult = await guardedCall(() => transport.send(pdu), requestTimeoutMs);
  onCallOutcome(sendResult.ok);
  if (!sendResult.ok) return { outcome: { type: 'timeout' }, unmatchedCount: 0 };

  let unmatchedCount = 0;
  let extensionsUsed = 0;
  let windowDeadlineMs = clock.now() + requestTimeoutMs;

  for (;;) {
    if (shouldStopForErrors()) return { outcome: { type: 'timeout' }, unmatchedCount };
    await maybeKeepAlive();

    const remainingMs = Math.max(0, windowDeadlineMs - clock.now());
    const callResult = await guardedCall(() => transport.nextResponse(remainingMs), remainingMs + GUARD_GRACE_MS);
    onCallOutcome(callResult.ok);
    if (!callResult.ok) return { outcome: { type: 'timeout' }, unmatchedCount };

    const raw = callResult.value;
    if (raw === 'timeout') return { outcome: { type: 'timeout' }, unmatchedCount };

    let parsed;
    try {
      parsed = parseUdsResponse(raw);
    } catch {
      unmatchedCount += 1;
      if (unmatchedCount > maxUnmatchedRetries) return { outcome: { type: 'timeout' }, unmatchedCount };
      continue; // keep awaiting within the SAME (not reset) remaining window.
    }

    if (parsed.kind === 'negative') {
      if (parsed.requestSid !== 0x22) {
        unmatchedCount += 1;
        if (unmatchedCount > maxUnmatchedRetries) return { outcome: { type: 'timeout' }, unmatchedCount };
        continue;
      }
      if (parsed.nrc === UDS_NRC.RESPONSE_PENDING) {
        extensionsUsed += 1;
        if (extensionsUsed > maxExtensions) return { outcome: { type: 'timeout' }, unmatchedCount };
        windowDeadlineMs = clock.now() + requestTimeoutMs; // FRESH window -- 0x78 means "more time", not "ask again".
        continue; // await nextResponse again WITHOUT re-sending.
      }
      return { outcome: { type: 'nrc', nrc: parsed.nrc }, unmatchedCount };
    }

    // Positive response: only 0x62 with THIS did's own echoed identifier
    // correlates -- anything else (wrong SID, wrong/missing echoed DID) is a
    // stray answer to some other request, not this one.
    if (parsed.sid !== 0x62 || parsed.data.length < 2) {
      unmatchedCount += 1;
      if (unmatchedCount > maxUnmatchedRetries) return { outcome: { type: 'timeout' }, unmatchedCount };
      continue;
    }
    const echoedDid = ((parsed.data[0] ?? 0) << 8) | (parsed.data[1] ?? 0);
    if (echoedDid !== did) {
      unmatchedCount += 1;
      if (unmatchedCount > maxUnmatchedRetries) return { outcome: { type: 'timeout' }, unmatchedCount };
      continue;
    }
    return { outcome: { type: 'responder', raw: parsed.data.slice(2) }, unmatchedCount };
  }
}

type GuardedCallResult<T> = { ok: true; value: T } | { ok: false };

/**
 * Invokes `fn` and normalizes EVERY failure mode -- a synchronous throw, an
 * async rejection, or exceeding `timeoutMs` -- to the SAME `{ok: false}`
 * shape; never itself throws or rejects. This is what makes a synchronous-
 * throwing `SweepTransport` implementation safe to call directly (amendment:
 * "synchronous throws from any interface call are contained").
 */
function guardedCall<T>(fn: () => Promise<T>, timeoutMs: number): Promise<GuardedCallResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false });
    }, Math.max(0, timeoutMs));

    let promise: Promise<T>;
    try {
      promise = fn();
    } catch {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ ok: false });
      }
      return;
    }

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false });
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
