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
/**
 * X1: "before the metronome, a ~2 s PROBE reads every planned DID once per
 * ECU". P4m-FIX2 Y1 (Codex P4m-REV2 finding 11, HIGH) demoted this from a
 * DEADLINE to a nominal figure: "the 2 s, one pass over every DID probe cannot
 * satisfy both constraints — the deadline is checked before each entry, so
 * earlier 300 ms timeouts leave later ECUs wholly unattempted, and the summary
 * nevertheless classifies every planned-but-nonresponding ECU as silent".
 *
 * A probe now runs with {@link RunFinderRoundInput.completePass}: it ends when
 * every entry has been ATTEMPTED once, which the per-DID timeout already bounds
 * at `entries x requestTimeoutMs` (≤ 12 × 0.3 s = 3.6 s at the budget ceiling).
 * The number below stays as the round's nominal `durationMs` for callers/
 * telemetry — nothing is classified on it any more.
 */
export const FINDER_PROBE_DURATION_MS = 2_000;
/**
 * P4m-FIX2 Y3 (Codex P4m-REV2 finding 13): the evidence window a back-off
 * cooldown is bounded to — `plan.ts`'s own `FINDER_WINDOW_MS`, repeated here
 * rather than imported so `runner.ts` keeps no dependency on the planner.
 */
export const FINDER_BACKOFF_WINDOW_MS = 3_000;
/**
 * Bounded 0x78 responsePending extensions inside one exchange (a stalling DME
 * still answers).
 *
 * P4m-FIX4 W3 (Codex P4m-REV4 finding 3, MEDIUM) exported it: the screen's
 * "up to N s" line has to be computed from the SAME number the exchange loop
 * obeys — see {@link finderProbeBoundMs}.
 */
export const FINDER_MAX_RESPONSE_PENDING_EXTENSIONS = 2;
/**
 * The slack a response wait is guarded by ON TOP of its own window: the
 * channel promises to resolve at `remainingMs`, and {@link guarded} gives it
 * this much more before deciding the channel itself is stuck.
 *
 * P4m-REV5 M3 (partial) exported it for the same reason as
 * {@link FINDER_MAX_RESPONSE_PENDING_EXTENSIONS}: a bound that omits it is not
 * an upper bound.
 */
export const FINDER_RESPONSE_GUARD_SLACK_MS = 50;
/** Bounded stray/unmatched replies tolerated inside one exchange's own window. */
const MAX_UNMATCHED_REPLIES = 3;
/**
 * How often each channel is kept alive inside a round. P4m-REV5 M3 (partial)
 * exported it so a caller can state a bound that includes those sends
 * ({@link finderProbeBoundMs}'s third argument).
 */
export const FINDER_KEEPALIVE_INTERVAL_MS = 2_000;

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
  /**
   * P4m-FIX2 Y1 (Codex P4m-REV2 finding 11, HIGH) — the PROBE's own mode.
   * `durationMs` stops bounding the round: a pass runs until every entry has
   * been ATTEMPTED once, so a first ECU that times out on all four of its DIDs
   * can no longer leave the ECUs behind it unattempted (and therefore
   * misclassified as silent). Only `control.stopped` still cuts it short — the
   * per-DID timeout bounds the worst case at `entries x requestTimeoutMs`.
   */
  completePass?: boolean;
  /**
   * P4m-FIX2 Y3 (Codex P4m-REV2 finding 13): the evidence window a back-off is
   * bounded to. Default {@link FINDER_BACKOFF_WINDOW_MS}.
   */
  windowMs?: number;
  /**
   * P4m-FIX2 Y8: pace the round so ONE pass over `entries` takes at least
   * `entries.length / targetReqPerSec` seconds. Omitted → no pacing (what the
   * probe wants: it is measuring the adapter, not obeying a plan).
   *
   * P4m-FIX3 Z3 (Codex P4m-REV3 finding 9, HIGH) made that a PER-PASS rule
   * rather than a per-entry schedule — see {@link runFinderRound}.
   */
  targetReqPerSec?: number;
  /** Invoked SYNCHRONOUSLY with the round's own anchor, before the first send — the metronome's `tMs = 0`. */
  onStarted?: (startedAtMs: number) => void;
  /**
   * P4m-FIX3 Z5 (Codex P4m-REV3 finding 11, MEDIUM): called after every
   * ATTEMPTED entry with `(completedThisPass, total)` — `total` being
   * `entries.length`, the count restarting at every pass so it can never run
   * past `total` (the probe is ONE pass, so its line simply counts up to it).
   * The probe is a serial pass that can cost `entries × requestTimeoutMs`, and
   * the driver was left staring at a screen that said nothing for those
   * seconds; this is the `n/N` the screen shows meanwhile.
   */
  onProgress?: (completed: number, total: number) => void;
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
  /**
   * P4m-FIX2 Y1/Y2: the subset of {@link attempted} that produced ANY
   * correlated answer (positive or NRC), in first-answer order. What
   * {@link summarizeFinderProbe} needs to tell "asked and silent" apart from
   * "never asked" — per DID, not only per ECU.
   */
  answered: SignalFinderTargetRef[];
  /** Total requests CONFIRMED SENT (an entry polled 12 times counts 12). P4m-FIX2 Y4: a send that threw/timed out is not one. */
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

/**
 * P4m-FIX4 W3 (Codex P4m-REV4 finding 3, MEDIUM): "the displayed probe bound is
 * not an upper bound". The screen said `entries × 300 ms`, but ONE exchange can
 * legitimately spend a full timeout waiting for `send()` to resolve
 * ({@link guarded}), a second one on its own response window, and one more per
 * allowed `0x78` extension — `4 × 300 ms` at the defaults, four times what the
 * driver was told.
 *
 * So the bound is computed HERE, from the same three constants the exchange
 * loop obeys, and the screen states what it returns:
 * `entries × requestTimeout × (2 + extensions)`.
 */
export function finderProbeBoundMs(
  entryCount: number,
  requestTimeoutMs: number = FINDER_REQUEST_TIMEOUT_MS,
  keepAliveSends = 0,
): number {
  const entries = Number.isFinite(entryCount) && entryCount > 0 ? Math.floor(entryCount) : 0;
  const timeoutMs =
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : FINDER_REQUEST_TIMEOUT_MS;
  const keepAlives = Number.isFinite(keepAliveSends) && keepAliveSends > 0 ? Math.floor(keepAliveSends) : 0;
  const perExchangeMs = timeoutMs * (2 + FINDER_MAX_RESPONSE_PENDING_EXTENSIONS) + FINDER_RESPONSE_GUARD_SLACK_MS;
  return entries * perExchangeMs + keepAlives * timeoutMs;
}

/**
 * P4m-FIX4 W1/W2 (Codex P4m-REV4 findings 1 and 2, both HIGH): the explicit
 * retry round is PART OF THE MEASUREMENT, not an afterthought.
 *
 * Build 9 summarised the probe, then retried the silent hypotheses, then
 * planned from the summary the retry had just invalidated: a hypothesis that
 * answered its retry was retained at a rate measured without its exchange
 * (over-budgeting the script, finding 1), and an ECU whose every probe entry
 * missed was already "silent" before its retry was even considered (finding 2).
 *
 * The fix is one function, not a second code path: the two rounds are MERGED
 * and {@link summarizeFinderProbe} runs once over the result. Liveness (per ECU
 * and per DID) and the retained-entry rate then both rest on probe + retry.
 *
 * `second`'s samples are re-based onto `first`'s anchor, so the merged result
 * keeps ONE origin like any single round.
 */
export function mergeFinderRounds(first: FinderRoundResult, second: FinderRoundResult): FinderRoundResult {
  const offsetMs = second.startedAtMs - first.startedAtMs;
  const attempted = [...first.attempted];
  const attemptedKeys = new Set(attempted.map(keyOf));
  for (const ref of second.attempted) {
    if (attemptedKeys.has(keyOf(ref))) continue;
    attemptedKeys.add(keyOf(ref));
    attempted.push({ ecu: ref.ecu, did: ref.did });
  }
  const answered = [...first.answered];
  const answeredKeys = new Set(answered.map(keyOf));
  for (const ref of second.answered) {
    if (answeredKeys.has(keyOf(ref))) continue;
    answeredKeys.add(keyOf(ref));
    answered.push({ ecu: ref.ecu, did: ref.did });
  }
  const backedOff = [...first.backedOff];
  const backedOffKeys = new Set(backedOff.map(keyOf));
  for (const ref of second.backedOff) {
    if (backedOffKeys.has(keyOf(ref))) continue;
    backedOffKeys.add(keyOf(ref));
    backedOff.push({ ecu: ref.ecu, did: ref.did });
  }
  return {
    startedAtMs: first.startedAtMs,
    /**
     * P4m-REV5 L7: the SPAN from the first round's anchor, not the sum of two
     * elapsed times — a gap between the rounds would otherwise leave a re-based
     * sample sitting past the round's own `elapsedMs`.
     */
    elapsedMs: Math.max(first.elapsedMs, offsetMs + second.elapsedMs),
    samples: [
      ...first.samples,
      ...second.samples.map((sample) => ({ ...sample, tMs: Math.max(0, sample.tMs + offsetMs) })),
    ],
    attempted,
    answered,
    requestCount: first.requestCount + second.requestCount,
    answeredCount: first.answeredCount + second.answeredCount,
    answeredElapsedMs: first.answeredElapsedMs + second.answeredElapsedMs,
    respondingEcus: [...new Set([...first.respondingEcus, ...second.respondingEcus])].sort((a, b) => a - b),
    backedOff,
  };
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

/**
 * P4m-FIX2 Y4 (Codex P4m-REV2 finding 14): every outcome carries whether
 * `channel.send()` ACTUALLY RESOLVED. Build 7 counted the request before the
 * send, so a thrown/rejected/timed-out send was exported as "read, no
 * response" although nothing was ever confirmed on the wire — the same class
 * of honesty bug item 12 exists to prevent.
 */
type ExchangeOutcome = { sent: boolean } & (
  | { kind: 'positive'; raw: Uint8Array }
  | { kind: 'nrc' }
  /** No correlated answer inside this entry's own window — a MISS (what the back-off counts). */
  | { kind: 'miss' }
);

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
  // Y4: nothing below may be counted as a request until THIS resolved.
  if (!sent.ok) return { kind: 'miss', sent: false };

  let unmatched = 0;
  let extensions = 0;
  let deadlineMs = clock.now() + requestTimeoutMs;
  for (;;) {
    const remainingMs = Math.max(0, deadlineMs - clock.now());
    const call = await guarded(() => channel.nextResponse(remainingMs), remainingMs + FINDER_RESPONSE_GUARD_SLACK_MS);
    if (!call.ok || call.value === 'timeout') return { kind: 'miss', sent: true };

    let parsed;
    try {
      parsed = parseUdsResponse(call.value);
    } catch {
      unmatched += 1;
      if (unmatched > MAX_UNMATCHED_REPLIES) return { kind: 'miss', sent: true };
      continue;
    }

    if (parsed.kind === 'negative') {
      if (parsed.requestSid !== 0x22) {
        unmatched += 1;
        if (unmatched > MAX_UNMATCHED_REPLIES) return { kind: 'miss', sent: true };
        continue;
      }
      if (parsed.nrc === UDS_NRC.RESPONSE_PENDING) {
        extensions += 1;
        if (extensions > maxExtensions) return { kind: 'miss', sent: true };
        deadlineMs = clock.now() + requestTimeoutMs; // 0x78 means "more time", not "ask again".
        continue;
      }
      // A real NRC is an ANSWER: this ECU is on the bus and refused this DID.
      return { kind: 'nrc', sent: true };
    }

    if (parsed.sid !== 0x62 || parsed.data.length < 2) {
      unmatched += 1;
      if (unmatched > MAX_UNMATCHED_REPLIES) return { kind: 'miss', sent: true };
      continue;
    }
    const echoedDid = ((parsed.data[0] ?? 0) << 8) | (parsed.data[1] ?? 0);
    if (echoedDid !== did) {
      unmatched += 1;
      if (unmatched > MAX_UNMATCHED_REPLIES) return { kind: 'miss', sent: true };
      continue;
    }
    return { kind: 'positive', sent: true, raw: parsed.data.slice(2) };
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
      : FINDER_KEEPALIVE_INTERVAL_MS;

  const windowMs =
    Number.isFinite(input.windowMs) && (input.windowMs ?? 0) > 0 ? (input.windowMs as number) : FINDER_BACKOFF_WINDOW_MS;
  const completePass = input.completePass === true;
  /**
   * Y8: one pass over `entries` must take at least `entries / targetReqPerSec`
   * seconds. Without it an in-memory/loopback channel that answers inside one
   * tick turns the round into a hot loop (the LEAD's own E2E observation),
   * over-polling the adapter far past the rate the budget was sized from.
   *
   * P4m-FIX3 Z3 (Codex P4m-REV3 finding 9, HIGH): the budget is PER PASS, and
   * so is the pacing. Build 8 gave each ENTRY a slot of `1000 / rate` ms and
   * advanced the schedule with `max(nextSlot, now) + interval`, so every slow
   * exchange pushed the schedule permanently forward: a pass paid
   * `Σ max(exchange, interval)` instead of `max(Σ exchange, Σ interval)`, and
   * the six live entries behind two 300 ms timeouts lost a whole sample per
   * window. Now a pass runs at whatever speed the adapter allows and only the
   * REMAINDER of `entries × 1000 / rate` is slept off at the end of it — a
   * timeout inside the pass is absorbed by that remainder instead of being
   * added to it, and nothing is ever carried into the next pass.
   */
  const passIntervalMs =
    Number.isFinite(input.targetReqPerSec) && (input.targetReqPerSec ?? 0) > 0
      ? (input.entries.length * 1_000) / (input.targetReqPerSec as number)
      : 0;

  const startedAtMs = input.clock.now();
  input.onStarted?.(startedAtMs);
  const endAtMs = startedAtMs + Math.max(0, input.durationMs);

  const samples: SignalFinderSample[] = [];
  const attempted: SignalFinderTargetRef[] = [];
  const attemptedKeys = new Set<string>();
  const answered: SignalFinderTargetRef[] = [];
  const answeredKeys = new Set<string>();
  /**
   * Y3 + P4m-FIX3 Z2: per key, the evidence window the counter belongs to and
   * the misses counted INSIDE that window. One flag, no cooldown bookkeeping:
   * an entry is cooling exactly while `misses >= missesBeforeBackoff` in the
   * CURRENT window, and a new window starts it from zero again.
   */
  const state = new Map<string, { window: number; misses: number }>();
  const backedOff: SignalFinderTargetRef[] = [];
  const backedOffKeys = new Set<string>();
  const responding = new Set<number>();
  let requestCount = 0;
  let answeredCount = 0;
  let answeredElapsedMs = 0;
  let nextKeepAliveAtMs = startedAtMs + keepAliveIntervalMs;

  const stateOf = (key: string, currentWindow: number): { window: number; misses: number } => {
    let entryState = state.get(key);
    if (entryState === undefined) {
      entryState = { window: currentWindow, misses: 0 };
      state.set(key, entryState);
    }
    // Z2: a new evidence window is a clean slate for this entry.
    if (entryState.window !== currentWindow) {
      entryState.window = currentWindow;
      entryState.misses = 0;
    }
    return entryState;
  };
  const windowAt = (nowMs: number): number => Math.floor(Math.max(0, nowMs - startedAtMs) / windowMs);

  // Y1: a probe (`completePass`) is bounded by its ENTRY COUNT, not by a
  // deadline -- only a stop may cut it short. Everything else keeps the
  // duration the metronome gave it.
  const done = (): boolean => input.control.stopped || (!completePass && input.clock.now() >= endAtMs);

  let pass = 0;
  outer: while (!done()) {
    if (input.maxPasses !== undefined && pass >= input.maxPasses) break;
    pass += 1;
    const passStartedAtMs = input.clock.now();
    /** Z5: progress is counted WITHIN a pass, so it can never run past `total`. */
    let completedThisPass = 0;
    let polledThisPass = 0;
    /** Y3: entries skipped only because they are cooling down — they come back next window. */
    let coolingThisPass = 0;

    for (const entry of input.entries) {
      if (done()) break outer;
      const channel = input.channels.get(entry.ecu);
      if (channel === undefined) continue;
      const key = keyOf(entry);
      /**
       * Y3 (Codex P4m-REV2 finding 13): the back-off is a bounded COOLDOWN,
       * not removal for the rest of the round. Build 7's three transient
       * misses emptied every later 3 s window of that DID, so a DID that
       * recovered still scored `insufficient`.
       *
       * P4m-FIX3 Z2 (Codex P4m-REV3 finding 8, HIGH) fixed what build 8 made
       * of that: it granted the new window a SINGLE retry (misses reset to
       * `threshold - 1`), so the first miss in a window immediately re-cooled
       * the entry for the rest of it and a DID recovering moments later was
       * never sampled again. Every window now hands back the FULL allowance:
       * three misses inside THIS window cool the entry until the next one.
       */
      const currentWindow = windowAt(input.clock.now());
      const entryState = stateOf(key, currentWindow);
      if (entryState.misses >= missesBeforeBackoff) {
        coolingThisPass += 1;
        continue;
      }

      if (input.clock.now() >= nextKeepAliveAtMs) {
        nextKeepAliveAtMs = input.clock.now() + keepAliveIntervalMs;
        const pdu = buildTesterPresentRequest();
        assertAllowedRequest(pdu);
        for (const ecuChannel of input.channels.values()) {
          await guarded(() => ecuChannel.keepAlive(pdu), requestTimeoutMs);
        }
      }
      if (done()) break outer;

      polledThisPass += 1;
      const sentAtMs = input.clock.now();
      const outcome = await exchange(channel, entry.did, input.clock, requestTimeoutMs, FINDER_MAX_RESPONSE_PENDING_EXTENSIONS);
      const elapsedMs = Math.max(0, input.clock.now() - sentAtMs);

      // Y4 (Codex P4m-REV2 finding 14): a key becomes "attempted" -- and a
      // request becomes countable -- only once `channel.send()` RESOLVED. A
      // throw/rejection/timeout on the send leaves it not read, never "read,
      // no response".
      if (outcome.sent) {
        requestCount += 1;
        if (!attemptedKeys.has(key)) {
          attemptedKeys.add(key);
          attempted.push({ ecu: entry.ecu, did: entry.did });
        }
      }

      completedThisPass += 1;
      input.onProgress?.(completedThisPass, input.entries.length); // Z5: the probe's own n/N.

      if (outcome.kind === 'miss') {
        entryState.misses += 1;
        if (entryState.misses >= missesBeforeBackoff && !backedOffKeys.has(key)) {
          backedOffKeys.add(key);
          backedOff.push({ ecu: entry.ecu, did: entry.did });
        }
      } else {
        entryState.misses = 0;
        responding.add(entry.ecu);
        if (!answeredKeys.has(key)) {
          answeredKeys.add(key);
          answered.push({ ecu: entry.ecu, did: entry.did });
        }
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

    if (polledThisPass === 0) {
      // Y3: "every entry is cooling down" is TEMPORARY -- each of them gets its
      // full allowance back at the next evidence window, so the round sleeps to
      // that boundary instead of ending. Only a pass with nothing cooling
      // (every entry unrouted) is genuinely finished.
      if (coolingThisPass === 0) break;
      const boundaryMs = startedAtMs + (windowAt(input.clock.now()) + 1) * windowMs;
      await waitMs(Math.min(boundaryMs - input.clock.now(), Math.max(0, endAtMs - input.clock.now())));
      if (input.clock.now() < boundaryMs) break; // the round's own duration ran out first.
      continue;
    }

    // Z3: pace the PASS, not the entry. Whatever the pass did not spend on
    // exchanges is slept off here; a pass that already took longer than its
    // interval starts the next one immediately, carrying no debt forward.
    if (passIntervalMs > 0) {
      const remainingMs = passIntervalMs - (input.clock.now() - passStartedAtMs);
      if (remainingMs > 0) await waitMs(remainingMs);
    }
  }

  return {
    startedAtMs,
    elapsedMs: Math.max(0, input.clock.now() - startedAtMs),
    samples,
    attempted,
    answered,
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
  /**
   * The measured request rate of the RETAINED entries (P4m-FIX3 Z1): answers
   * over the wall time those answering exchanges took. `null` when the probe
   * could not measure one (nothing answered).
   */
  measuredReqPerSec: number | null;
  rateSource: FinderRateSource;
  /** What the caller should use: the measured rate, else the assumed fallback it passed in. */
  reqPerSec: number;
  /**
   * P4m-FIX3 Z1 — DIAGNOSTICS ONLY: every confirmed send over the probe's own
   * wall time, the timeouts of the entries the round is about to DROP
   * included. Never sizes a budget and never scales an estimate.
   */
  timeoutInclusiveReqPerSec: number | null;
  /** ECUs that answered at least once during the probe, ascending. */
  liveEcus: number[];
  /**
   * Planned ECUs EVERY one of whose probe entries was actually attempted and
   * missed — their DIDs are dropped from the round (X2), with that reason
   * stated. P4m-FIX2 Y1: an ECU with even one unattempted entry is never here.
   */
  silentEcus: number[];
  /**
   * P4m-FIX2 Y1: planned ECUs the probe did not finish (a stop landed mid-pass)
   * and that answered nothing. Neither live nor silent — nothing is claimed
   * about them, and their DIDs stay plannable.
   */
  unprobedEcus: number[];
  /**
   * P4m-FIX2 Y2 (Codex P4m-REV2 finding 12, HIGH): the INDIVIDUAL entries that
   * were attempted and answered nothing, on ECUs that are otherwise alive. One
   * answering DID used to keep all eleven of its silent neighbours in the
   * round, at `11 x 3 x 300 ms = 9.9 s` of the driver's own script.
   */
  silentDids: SignalFinderTargetRef[];
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
 * P4m-FIX2 Y2 (Codex P4m-REV2 finding 12, HIGH) made the rate timeout-
 * INCLUSIVE, because one answering DID plus many silent ones on the same ECU
 * kept every DID and the round then paid `misses x timeout` per pass against a
 * rate that had never counted a single timeout.
 *
 * P4m-FIX3 Z1 (the LEAD's own E2E run, HIGH) put that back the other way,
 * because Y2 removed the premise: the silent entries are now DROPPED (silent
 * ECUs by X2, individual silent DIDs by Y2, silent hypotheses by Z4's explicit
 * retry), so the entries the round RETAINS are exactly the ones that answered.
 * Charging them for timeouts nobody will pay again is what produced the field
 * reading "rate 1.8/s measured" from one instant answer plus two dropped silent
 * entries — and from it a 4-DID floor budget and a "≈ 56 min" next step for a
 * sweep the same adapter does in ~7. So the rate is the RETAINED entries' own:
 * answers over the wall time those answers took. The timeout-inclusive figure
 * survives as {@link FinderProbeSummary.timeoutInclusiveReqPerSec},
 * diagnostics only.
 *
 * P4m-FIX2 Y1 (finding 11) settled the liveness verdict: a planned ECU is
 * `silent` only when EVERY one of its planned entries was actually ATTEMPTED
 * and none answered. An ECU whose entries a stop never reached is `unprobed`,
 * and nothing is claimed about it.
 */
export function summarizeFinderProbe(
  result: FinderRoundResult,
  plannedEntries: readonly SignalFinderTargetRef[],
  assumedReqPerSec: number,
): FinderProbeSummary {
  const attemptedKeys = new Set(result.attempted.map(keyOf));
  const answeredKeys = new Set(result.answered.map(keyOf));
  const live = new Set(result.respondingEcus);

  const planned = [...new Set(plannedEntries.map((entry) => entry.ecu))].sort((a, b) => a - b);
  const fullyAttempted = new Set(planned);
  for (const entry of plannedEntries) {
    if (!attemptedKeys.has(keyOf(entry))) fullyAttempted.delete(entry.ecu);
  }

  const measurable = result.answeredCount >= MIN_PROBE_EXCHANGES && result.requestCount > 0;
  // The clock's own resolution floors the measurement at 1 ms per exchange
  // (a simulated/loopback transport answers inside one tick): the honest
  // reading of that is "at least 1000 req/s", which the budget clamp then
  // bounds — not "unmeasurable".
  const measuredReqPerSec = measurable
    ? (result.answeredCount * 1_000) / Math.max(result.answeredElapsedMs, result.answeredCount)
    : null;
  const timeoutInclusiveReqPerSec =
    result.requestCount > 0 ? (result.requestCount * 1_000) / Math.max(result.elapsedMs, result.requestCount) : null;

  // Individually silent DIDs: attempted, never answered, on an ECU that is
  // otherwise alive (a wholly silent ECU is reported at ECU granularity below,
  // and its DIDs are dropped by that rule instead).
  const silentDids = plannedEntries
    .filter((entry) => live.has(entry.ecu) && attemptedKeys.has(keyOf(entry)) && !answeredKeys.has(keyOf(entry)))
    .map((entry) => ({ ecu: entry.ecu, did: entry.did }));

  return {
    measuredReqPerSec,
    rateSource: measuredReqPerSec === null ? 'assumed' : 'measured',
    reqPerSec: measuredReqPerSec ?? assumedReqPerSec,
    timeoutInclusiveReqPerSec,
    liveEcus: planned.filter((ecu) => live.has(ecu)),
    silentEcus: planned.filter((ecu) => !live.has(ecu) && fullyAttempted.has(ecu)),
    unprobedEcus: planned.filter((ecu) => !live.has(ecu) && !fullyAttempted.has(ecu)),
    silentDids,
  };
}
