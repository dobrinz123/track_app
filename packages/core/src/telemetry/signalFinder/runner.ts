/**
 * Signal Finder — the ROUND RUNNER and the PROBE (ticket P4m-FIX1, Codex
 * P4m-REV1 findings 1–4).
 *
 * Build 6 drove a find through `runDidObservation`, whose unit of work is a
 * bare DID NUMBER on one implicit channel. Three of the four HIGH/MEDIUM
 * findings are consequences of that single choice:
 *
 *  1. **Nothing was ever measured** (finding 1). The budget came from an
 *     ASSUMED 15.8 req/s and was exported as if measured. A rate that is
 *     assumed cannot promise "≥ 3 samples per 3 s window" to anybody.
 *  2. **A silent ECU starved the live one** (finding 2). Polling is serial:
 *     at the sweep's 1 s per-DID budget, five silent 0x29 DIDs cost five
 *     seconds of a 21 s script, taken straight out of the DME's sampling.
 *  3. **Every planned DID was recorded as read** (finding 3), even the ones a
 *     stop or the deadline never reached — they became "no response", the
 *     exact honesty bug item 12 exists to prevent.
 *  4. **Identity was the DID number** (finding 4), so the same DID on two
 *     ECUs cost the driver a second script.
 *
 * So the finder polls its own way now: COMPOSITE `(ecu, did)` entries, one
 * `SweepTransport` channel per ECU (all over the SAME socket — HSFZ carries
 * the target address per frame), a per-DID request timeout of
 * {@link FINDER_REQUEST_TIMEOUT_MS} and a back-off after
 * {@link FINDER_MISSES_BEFORE_BACKOFF} consecutive misses — the SAME numbers
 * `enetSession.ts` (N5) uses for a binding-sourced poll entry, for the same
 * reason: silence from an ECU that is not on this bus says nothing about the
 * link, and must never be paid for at the full timeout on every pass.
 *
 * The runner reports exactly what it DID: the keys it actually requested, the
 * ECUs that actually answered, and how long the answering exchanges took —
 * which is what {@link summarizeFinderProbe} turns into a MEASURED request
 * rate and a per-ECU liveness verdict.
 *
 * No vehicle constants, no store, no UI. The only I/O is through the injected
 * channels and clock.
 */

import type { MonotonicClock } from '../../contracts';
import type { DidSweepControl, SweepTransport } from '../enet/didSweep';
import {
  UDS_NRC,
  assertAllowedRequest,
  buildReadDataByIdentifierRequest,
  buildTesterPresentRequest,
  parseUdsResponse,
} from '../enet/udsCodec';
import type { SignalFinderSample } from './scoring';
import type { SignalFinderTargetRef } from './plan';

/**
 * P4l-FIX4 N5's own number, reused verbatim (`enetSession.ts`): 300 ms is
 * well above a real answering ECU's p95 latency over Wi-Fi and far below the
 * 1 s a sweep gives a DME that may legitimately stall with 0x78 — a mechanism
 * a silent ECU never uses.
 */
export const FINDER_REQUEST_TIMEOUT_MS = 300;
/** N5 again: three misses, not one — a single dropped frame is normal on Wi-Fi. */
export const FINDER_MISSES_BEFORE_BACKOFF = 3;
/** X1: "before the metronome, a ~2 s PROBE reads every planned DID once per ECU". */
export const FINDER_PROBE_DURATION_MS = 2_000;
/** Bounded 0x78 responsePending extensions inside one exchange (a stalling DME still answers). */
const DEFAULT_MAX_RESPONSE_PENDING_EXTENSIONS = 2;
/** Bounded stray/unmatched replies tolerated inside one exchange's own window. */
const MAX_UNMATCHED_REPLIES = 3;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 2_000;

export interface RunFinderRoundInput {
  /** COMPOSITE entries, in the order one pass polls them (`planFinderRun`'s own order). */
  entries: readonly SignalFinderTargetRef[];
  /** One channel per ECU, all built over the SAME transport. An entry whose ECU has no channel is never attempted. */
  channels: ReadonlyMap<number, SweepTransport>;
  clock: MonotonicClock;
  control: DidSweepControl;
  /** How long the round polls — the metronome's `pollDurationMs`, or {@link FINDER_PROBE_DURATION_MS} for a probe. */
  durationMs: number;
  /** Default {@link FINDER_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** Default {@link FINDER_MISSES_BEFORE_BACKOFF}. */
  missesBeforeBackoff?: number;
  /** Default 2000 ms, per ECU channel. */
  keepAliveIntervalMs?: number;
  /** The probe passes 1: exactly one pass over every entry, then stop. Unlimited by default. */
  maxPasses?: number;
  /** Invoked SYNCHRONOUSLY with the round's own anchor, before the first send — the metronome's `tMs = 0`. */
  onStarted?: (startedAtMs: number) => void;
}

export interface FinderRoundResult {
  /** The clock value every sample's `tMs` is relative to. */
  startedAtMs: number;
  elapsedMs: number;
  /** Every correlated 0x62, `tMs` relative to {@link startedAtMs}. */
  samples: SignalFinderSample[];
  /**
   * X3 (binding): the `(ecu, did)` keys a request was actually SENT for, each
   * once, in first-attempt order. Everything else the caller planned is still
   * "not read" — never "no response".
   */
  attempted: SignalFinderTargetRef[];
  /** Total requests sent (an entry polled 12 times counts 12). */
  requestCount: number;
  /** Exchanges that produced ANY correlated answer, positive or NRC. */
  answeredCount: number;
  /** Total time those answering exchanges took — the honest denominator for a measured rate. */
  answeredElapsedMs: number;
  /** ECUs that answered at least once (positive or NRC — an NRC proves the ECU is there), ascending. */
  respondingEcus: number[];
  /** Entries dropped mid-round after {@link FINDER_MISSES_BEFORE_BACKOFF} consecutive misses, in the order they were dropped. */
  backedOff: SignalFinderTargetRef[];
}

function keyOf(ref: SignalFinderTargetRef): string {
  return `${ref.ecu}:${ref.did}`;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Never lets a channel implementation's throw/rejection/hang escape or exceed its own budget. */
function guarded<T>(fn: () => Promise<T>, timeoutMs: number): Promise<{ ok: true; value: T } | { ok: false }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false });
    }, Math.max(0, timeoutMs));
    const finish = (result: { ok: true; value: T } | { ok: false }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      fn().then(
        (value) => finish({ ok: true, value }),
        () => finish({ ok: false }),
      );
    } catch {
      finish({ ok: false });
    }
  });
}

type ExchangeOutcome =
  | { kind: 'positive'; raw: Uint8Array }
  | { kind: 'nrc' }
  /** No correlated answer inside this entry's own window — a MISS (what the back-off counts). */
  | { kind: 'miss' };

/**
 * One `(ecu, did)` exchange on that ECU's own channel: send 0x22, then
 * correlate whatever comes back by SID + echoed DID, extending on 0x78 and
 * tolerating a bounded number of stray replies. Structurally the same
 * discipline as `didSweep.ts`'s own `resolveDid` (which is private to that
 * module), with the finder's short per-DID budget.
 */
async function exchange(
  channel: SweepTransport,
  did: number,
  clock: MonotonicClock,
  requestTimeoutMs: number,
  maxExtensions: number,
): Promise<ExchangeOutcome> {
  const pdu = buildReadDataByIdentifierRequest(did);
  assertAllowedRequest(pdu); // hard gate, re-checked even though this builder only ever emits 0x22.
  const sent = await guarded(() => channel.send(pdu), requestTimeoutMs);
  if (!sent.ok) return { kind: 'miss' };

  let unmatched = 0;
  let extensions = 0;
  let deadlineMs = clock.now() + requestTimeoutMs;
  for (;;) {
    const remainingMs = Math.max(0, deadlineMs - clock.now());
    const call = await guarded(() => channel.nextResponse(remainingMs), remainingMs + 50);
    if (!call.ok || call.value === 'timeout') return { kind: 'miss' };

    let parsed;
    try {
      parsed = parseUdsResponse(call.value);
    } catch {
      unmatched += 1;
      if (unmatched > MAX_UNMATCHED_REPLIES) return { kind: 'miss' };
      continue;
    }

    if (parsed.kind === 'negative') {
      if (parsed.requestSid !== 0x22) {
        unmatched += 1;
        if (unmatched > MAX_UNMATCHED_REPLIES) return { kind: 'miss' };
        continue;
      }
      if (parsed.nrc === UDS_NRC.RESPONSE_PENDING) {
        extensions += 1;
        if (extensions > maxExtensions) return { kind: 'miss' };
        deadlineMs = clock.now() + requestTimeoutMs; // 0x78 means "more time", not "ask again".
        continue;
      }
      // A real NRC is an ANSWER: this ECU is on the bus and refused this DID.
      return { kind: 'nrc' };
    }

    if (parsed.sid !== 0x62 || parsed.data.length < 2) {
      unmatched += 1;
      if (unmatched > MAX_UNMATCHED_REPLIES) return { kind: 'miss' };
      continue;
    }
    const echoedDid = ((parsed.data[0] ?? 0) << 8) | (parsed.data[1] ?? 0);
    if (echoedDid !== did) {
      unmatched += 1;
      if (unmatched > MAX_UNMATCHED_REPLIES) return { kind: 'miss' };
      continue;
    }
    return { kind: 'positive', raw: parsed.data.slice(2) };
  }
}

/**
 * Polls `entries` round-robin for `durationMs`, as fast as the adapter
 * answers (the human script — not an artificial cadence — is what bounds the
 * round). Re-checks `control` before every send, so `stop()` lands inside one
 * exchange at most.
 */
export async function runFinderRound(input: RunFinderRoundInput): Promise<FinderRoundResult> {
  const requestTimeoutMs =
    Number.isFinite(input.requestTimeoutMs) && (input.requestTimeoutMs ?? 0) > 0
      ? (input.requestTimeoutMs as number)
      : FINDER_REQUEST_TIMEOUT_MS;
  const missesBeforeBackoff =
    Number.isFinite(input.missesBeforeBackoff) && (input.missesBeforeBackoff ?? 0) > 0
      ? Math.floor(input.missesBeforeBackoff as number)
      : FINDER_MISSES_BEFORE_BACKOFF;
  const keepAliveIntervalMs =
    Number.isFinite(input.keepAliveIntervalMs) && (input.keepAliveIntervalMs ?? 0) > 0
      ? (input.keepAliveIntervalMs as number)
      : DEFAULT_KEEPALIVE_INTERVAL_MS;

  const startedAtMs = input.clock.now();
  input.onStarted?.(startedAtMs);
  const endAtMs = startedAtMs + Math.max(0, input.durationMs);

  const samples: SignalFinderSample[] = [];
  const attempted: SignalFinderTargetRef[] = [];
  const attemptedKeys = new Set<string>();
  const misses = new Map<string, number>();
  const backedOff: SignalFinderTargetRef[] = [];
  const responding = new Set<number>();
  let requestCount = 0;
  let answeredCount = 0;
  let answeredElapsedMs = 0;
  let nextKeepAliveAtMs = startedAtMs + keepAliveIntervalMs;

  const done = (): boolean => input.control.stopped || input.clock.now() >= endAtMs;

  let pass = 0;
  outer: while (!done()) {
    if (input.maxPasses !== undefined && pass >= input.maxPasses) break;
    pass += 1;
    let polledThisPass = 0;

    for (const entry of input.entries) {
      if (done()) break outer;
      const channel = input.channels.get(entry.ecu);
      if (channel === undefined) continue;
      const key = keyOf(entry);
      if ((misses.get(key) ?? 0) >= missesBeforeBackoff) continue; // backed off for the rest of the round.

      if (input.clock.now() >= nextKeepAliveAtMs) {
        nextKeepAliveAtMs = input.clock.now() + keepAliveIntervalMs;
        const pdu = buildTesterPresentRequest();
        assertAllowedRequest(pdu);
        for (const ecuChannel of input.channels.values()) {
          await guarded(() => ecuChannel.keepAlive(pdu), requestTimeoutMs);
        }
      }
      if (done()) break outer;

      if (!attemptedKeys.has(key)) {
        attemptedKeys.add(key);
        attempted.push({ ecu: entry.ecu, did: entry.did });
      }
      requestCount += 1;
      polledThisPass += 1;
      const sentAtMs = input.clock.now();
      const outcome = await exchange(channel, entry.did, input.clock, requestTimeoutMs, DEFAULT_MAX_RESPONSE_PENDING_EXTENSIONS);
      const elapsedMs = Math.max(0, input.clock.now() - sentAtMs);

      if (outcome.kind === 'miss') {
        const count = (misses.get(key) ?? 0) + 1;
        misses.set(key, count);
        if (count === missesBeforeBackoff) backedOff.push({ ecu: entry.ecu, did: entry.did });
      } else {
        misses.set(key, 0);
        responding.add(entry.ecu);
        answeredCount += 1;
        answeredElapsedMs += elapsedMs;
        if (outcome.kind === 'positive') {
          samples.push({ ecu: entry.ecu, did: entry.did, tMs: input.clock.now() - startedAtMs, raw: outcome.raw });
        }
      }
      // Yield to the event loop between entries: a channel that answers from
      // its own queue resolves synchronously, and a pure microtask loop would
      // starve the screen's metronome ticker for the whole round.
      await waitMs(0);
    }

    if (polledThisPass === 0) break; // nothing left that is worth asking (every entry backed off / unrouted).
  }

  return {
    startedAtMs,
    elapsedMs: Math.max(0, input.clock.now() - startedAtMs),
    samples,
    attempted,
    requestCount,
    answeredCount,
    answeredElapsedMs,
    respondingEcus: [...responding].sort((a, b) => a - b),
    backedOff,
  };
}

/** X1: whether the rate a budget/duration was derived from was actually MEASURED, or assumed. */
export type FinderRateSource = 'measured' | 'assumed';

export interface FinderProbeSummary {
  /** The measured request rate, or `null` when the probe could not measure one (nothing answered). */
  measuredReqPerSec: number | null;
  rateSource: FinderRateSource;
  /** What the caller should use: the measured rate, else the assumed fallback it passed in. */
  reqPerSec: number;
  /** ECUs that answered at least once during the probe, ascending. */
  liveEcus: number[];
  /** Planned ECUs that answered NOTHING — their DIDs are dropped from the round (X2), with that reason stated. */
  silentEcus: number[];
}

/**
 * How many answering exchanges the probe needs before it may call its rate
 * MEASURED. One is enough — a single completed round trip IS a measurement,
 * and erring slow (a cold first exchange) only shrinks the budget, which is
 * the safe direction. Zero answers is what "assumed" is for.
 */
const MIN_PROBE_EXCHANGES = 1;

/**
 * X1 (binding): "the budget is (re)computed from the measured rate; the
 * export/snapshot say `measuredReqPerSec` only when measured, else
 * `rateSource: 'assumed'` with the value".
 *
 * The rate is taken from the exchanges that ANSWERED (`answeredCount /
 * answeredElapsedMs`), not from wall-clock over all requests: a probe that
 * spent 900 ms timing out on a silent ECU it is about to DROP would otherwise
 * report a rate the round will never see again, and undersize the budget for
 * the ECU that does answer.
 */
export function summarizeFinderProbe(
  result: FinderRoundResult,
  plannedEcus: readonly number[],
  assumedReqPerSec: number,
): FinderProbeSummary {
  const live = new Set(result.respondingEcus);
  const planned = [...new Set(plannedEcus)].sort((a, b) => a - b);
  const measurable = result.answeredCount >= MIN_PROBE_EXCHANGES;
  // The clock's own resolution floors the measurement at 1 ms per exchange
  // (a simulated/loopback transport answers inside one tick): the honest
  // reading of that is "at least 1000 req/s", which the budget clamp then
  // bounds — not "unmeasurable".
  const measuredReqPerSec = measurable
    ? (result.answeredCount * 1_000) / Math.max(result.answeredElapsedMs, result.answeredCount)
    : null;
  return {
    measuredReqPerSec,
    rateSource: measuredReqPerSec === null ? 'assumed' : 'measured',
    reqPerSec: measuredReqPerSec ?? assumedReqPerSec,
    liveEcus: planned.filter((ecu) => live.has(ecu)),
    silentEcus: planned.filter((ecu) => !live.has(ecu)),
  };
}
