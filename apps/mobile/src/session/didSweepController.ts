/**
 * ENET auto-discovery & DID sweep addendum (contracts.md, binding, Phase 4f),
 * extended by the "sweep transport interface & lifecycle amendment"
 * (contracts.md, binding) -- the dev DID-sweep screen's state machine:
 * range/plan, start/pause/resume/stop, progress, and (after the sweep, or on
 * demand) an observation phase that re-polls the responders found and
 * classifies them via `@circuit/core`'s `classifyResponders`.
 *
 * SWEEP TRANSPORT INTERFACE (binding, P4f-T3): `@circuit/core`'s `runDidSweep`
 * now OWNS every wire-protocol concern -- SID/DID correlation, 0x78
 * re-await (no re-send), bounded unmatched retries, TesterPresent keep-alive
 * cadence, and containment of a throwing/rejecting transport call. This
 * module implements ONLY the low-level `SweepTransport` contract
 * (`createRawUdsChannel`, below) over a raw `ObdTransport`:
 *   - `send`: frames `pdu` as ONE HSFZ diagnostic request and sends it.
 *   - `nextResponse(timeoutMs)`: resolves with the next diagnostic-control
 *     PDU from the target with swapped addresses (source/target correlation
 *     ONLY -- never SID/DID, that is entirely the core runner's job).
 *   - `keepAlive`: frames and sends a TesterPresent-shaped pdu (the runner
 *     builds it) -- wire-identical to `send`.
 * The controller's own job is ONLY: own the transport lifecycle (acquire the
 * `'sweep'` reservation -> open a fresh transport -> run -> close -> release,
 * strictly in that order on every path), drive `runDidSweep`/the shared
 * `DidSweepAccumulator` across pause/resume, and (M2, P4f-FIX3) the
 * observation phase, which delegates its ENTIRE round-robin/keep-alive/
 * pacing/error-budget loop to core's `runDidObservation` -- ONE call for the
 * whole window (see `runObservationOnChannel`) -- never re-implementing it.
 *
 * H1/H2 (binding): the CONTROLLER owns the transport lifecycle -- `start()`
 * acquires the `'sweep'` reservation FIRST (no generation bump before a
 * successful acquire), THEN opens a FRESH transport via the injected
 * `transportFactory`, runs, closes the transport, and releases the
 * reservation -- release STRICTLY after close, on every path (complete,
 * stop, throw). The screen never connects a transport itself.
 *
 * LIFECYCLE RACE (binding, P4f-FIX3, after Codex P4f-REV3 HIGH): the active
 * transport reference is retained until `close()` genuinely settles (or a
 * 200 ms race elapses -- `teardownActiveTransport`, below) rather than being
 * cleared before the `await`, so a `stop()` that races in while a natural
 * completion's own close is still pending JOINS that same in-flight
 * teardown (never releases early, never double-closes). Every exit path
 * (normal completion, pause, stop, a synchronous throw from channel
 * creation, an unexpected rejection from the core runner) shares ONE
 * lifecycle guard (`runGuarded`) that always closes then releases; every
 * continuation re-checks its own `generation` AFTER awaiting teardown (not
 * only before), so a later terminal state (`stop()`'s `'stopped'`) can never
 * be overwritten by an earlier attempt's `'sweepComplete'`.
 */
import {
  bytesToBinaryString,
  binaryStringToBytes,
  classifyResponders,
  computeDidCandidateSummaries,
  createDidSweepAccumulator,
  createDidSweepPlan,
  DID_OBSERVATION_PHASES,
  encodeFrame,
  filterSweepCandidates,
  enetSpecsFromSuggestion,
  HSFZ_CONTROL,
  HsfzFrameParser,
  runDidObservation,
  runDidSweep,
  type DidCandidateSummary,
  type DidHeuristicContext,
  type DidHeuristicSuggestion,
  type DidObservationPhaseId,
  type DidPhaseSample,
  type DidResponderSeries,
  type DidSweepAccumulator,
  type DidSweepControl,
  type DidSweepPlan,
  type DidSweepRange,
  type DidSweepResponder,
  type EnetChannelSpec,
  type MonotonicClock,
  type ObdTransport,
  type SweepTransport,
  type TelemetryChannelId,
} from '@circuit/core';
import { enetAdapterReservation as sharedEnetAdapterReservation, type EnetAdapterReservation, type EnetAdapterToken } from './enetAdapterReservation';
import { hexToBytes, type DidSweepRunRecord, type DidSweepRunStatus, type DidSweepStore } from '../persistence/didSweepStore';

// ---------------------------------------------------------------------------
// SweepTransport implementation (binding: "sweep transport interface &
// lifecycle amendment") -- the mobile side's ONLY responsibility for the wire
// protocol; every correlation/retry/keep-alive decision lives in
// `@circuit/core`'s `runDidSweep`.
// ---------------------------------------------------------------------------

/** Re-exported for callers/tests that want to name the exact shape this module hands to `runDidSweep` without importing it from `@circuit/core` directly. */
export type RawUdsChannel = SweepTransport;

/**
 * Builds a `SweepTransport` over an already-connected `ObdTransport`. Queues
 * EVERY address-matching diagnostic frame from a chunk, in order (so a
 * wrong-SID frame immediately followed by the correct response, even in the
 * SAME chunk, are both delivered in order -- the core runner is what decides
 * to skip the first as unmatched and accept the second) -- `nextResponse`
 * dequeues FIFO, or waits for the next arrival, or resolves `'timeout'`
 * (never rejects, never hangs past `timeoutMs`, and resolves `'timeout'`
 * immediately if the transport is already closed).
 */
export function createRawUdsChannel(transport: ObdTransport, testerAddress: number, targetAddress: number): SweepTransport {
  const queue: Uint8Array[] = [];
  let waiting: { resolve: (v: Uint8Array | 'timeout') => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let closed = false;
  const parser = new HsfzFrameParser();

  transport.onData((chunk) => {
    if (closed) return;
    let frames: ReturnType<HsfzFrameParser['push']>;
    try {
      frames = parser.push(binaryStringToBytes(chunk));
    } catch {
      return; // a malformed chunk proves nothing either way -- never crashes the channel.
    }
    for (const frame of frames) {
      if (frame.control !== HSFZ_CONTROL.DIAGNOSTIC_REQ_RES) continue; // ack/alive-check/status -- not a diagnostic response.
      if (frame.source !== targetAddress || frame.target !== testerAddress) continue; // address-swap correlation ONLY (binding) -- SID/DID is the core runner's job.
      deliver(frame.payload);
    }
  });
  transport.onClose(() => {
    closed = true;
    if (waiting !== null) {
      clearTimeout(waiting.timer);
      const w = waiting;
      waiting = null;
      w.resolve('timeout');
    }
  });

  function deliver(payload: Uint8Array): void {
    if (waiting !== null) {
      clearTimeout(waiting.timer);
      const w = waiting;
      waiting = null;
      w.resolve(payload);
      return;
    }
    queue.push(payload);
  }

  function frameAndSend(pdu: Uint8Array): void {
    const frame = encodeFrame({ control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES, source: testerAddress, target: targetAddress, payload: pdu });
    transport.send(bytesToBinaryString(frame));
  }

  return {
    async send(pdu: Uint8Array): Promise<void> {
      frameAndSend(pdu);
    },
    nextResponse(timeoutMs: number): Promise<Uint8Array | 'timeout'> {
      return new Promise((resolve) => {
        if (queue.length > 0) {
          resolve(queue.shift()!);
          return;
        }
        if (closed) {
          resolve('timeout');
          return;
        }
        const timer = setTimeout(() => {
          waiting = null;
          resolve('timeout');
        }, Math.max(0, timeoutMs));
        waiting = { resolve, timer };
      });
    },
    async keepAlive(pdu: Uint8Array): Promise<void> {
      frameAndSend(pdu);
    },
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export type DidSweepPhase =
  | 'idle'
  | 'sweeping'
  | 'paused'
  | 'sweepComplete'
  | 'observing'
  | 'observationComplete'
  | 'stopped';

export interface DidSweepProgressSnapshot {
  did: number;
  index: number;
  total: number;
  /** Requests/sec averaged over the run so far -- ticket's own "req/s" progress field. */
  reqPerSec: number;
}

export interface DidSweepSnapshot {
  phase: DidSweepPhase;
  progress: DidSweepProgressSnapshot | null;
  responders: readonly DidSweepResponder[];
  /** Keyed by NRC value. */
  nrcCounts: Readonly<Record<number, number>>;
  timeouts: number;
  /** Responses that arrived but did not correlate to their own request (wrong SID/echoed DID/unparseable) -- `@circuit/core`'s own `DidSweepAccumulator.unmatched`. */
  unmatched: number;
  /** Populated once an observation phase finishes (or is stopped early); `[]` before that. */
  suggestions: readonly DidHeuristicSuggestion[];
  observationElapsedMs: number;
  /** M3 (binding): true whenever a completed observation round took longer than 1 s to cover every responder once -- true ~1 Hz per responder is not achievable given the measured RTT and responder count. */
  observationCadenceDegraded: boolean;
  /**
   * P4f-FIX5 (binding, after Codex P4f-REV5): the wall-clock instant (same
   * domain as `Date.now()`) at which THIS observation run's core loop
   * actually began -- i.e. AFTER the transport finished connecting, not at
   * the moment `startObservation()` was tapped. `null` before an observation
   * has started, or while one is still connecting. Mirrors (and is set at
   * the exact same instant as) the `onObservationStarted` deps callback --
   * exposed on the snapshot too for callers/tests that would rather poll it.
   */
  observationAnchorWallClockMs: number | null;
  /** Non-null exactly when something went wrong (invalid range, reservation refused, connect failure) -- never thrown across this API. */
  error: string | null;
  /**
   * DID sweep — guided candidate observation addendum (2026-08-27, binding —
   * Phase 4i, user clarification): the CURRENT phase of a guided observation
   * run (`startGuidedObservation()`), or `null` when none is running. The UI
   * drives its countdown/prompt off this + `guidedPhaseElapsedMs`.
   */
  guidedPhase: DidObservationPhaseId | null;
  /** Elapsed ms within the CURRENT guided phase (resets to 0 at each phase boundary) -- pairs with the phase's own `durationMs` (`DID_OBSERVATION_PHASES`) for an on-screen countdown. */
  guidedPhaseElapsedMs: number;
  /** Live-updated (per sample, and finalized once the guided run ends) ranked candidate summaries -- see `didObservationPhases.ts`'s `computeDidCandidateSummaries`. `[]` before a guided observation has ever run. */
  candidateSummaries: readonly DidCandidateSummary[];
}

const INITIAL_SNAPSHOT: DidSweepSnapshot = {
  phase: 'idle',
  progress: null,
  responders: [],
  nrcCounts: {},
  timeouts: 0,
  unmatched: 0,
  suggestions: [],
  observationElapsedMs: 0,
  observationCadenceDegraded: false,
  observationAnchorWallClockMs: null,
  error: null,
  guidedPhase: null,
  guidedPhaseElapsedMs: 0,
  candidateSummaries: [],
};

const RESERVATION_BUSY_MESSAGE = 'The adapter is in use (telemetry or the DID probe) -- stop it first.';

export interface DidSweepPacing {
  maxRequestsPerSec?: number;
  rttMultiplier?: number;
  minIntervalMs?: number;
}

export interface DidSweepControllerDeps {
  /** H1/H2 (binding): the controller owns the transport -- a FRESH one is built by calling this on every `start()`/observation-from-terminal-state, never reused across runs. */
  transportFactory: () => ObdTransport;
  testerAddress: number;
  targetAddress: number;
  clock: MonotonicClock;
  pacing?: DidSweepPacing;
  /** default 1000 (core's own default). Forwarded to `runDidSweep` verbatim. */
  requestTimeoutMs?: number;
  /** default 5 (core's own default). Forwarded to `runDidSweep` verbatim. */
  maxResponsePendingExtensions?: number;
  /** Single-client adapter reservation (binding: "Exclusive via the reservation ('sweep' owner)"). Test-only injection seam (mirrors `telemetryProvider.ts`'s own) -- defaults to the real shared singleton. */
  reservation?: EnetAdapterReservation;
  /** default 60_000 (addendum: "a user-chosen window (default 60 s)"). */
  observationWindowMs?: number;
  /**
   * Called once, when the observation phase finishes, to supply
   * `classifyResponders`'s optional `context` (addendum: "speed-like:
   * correlates with GNSS speed when available"). Omitted entirely when the
   * caller has no GNSS speed series to offer.
   */
  gnssSpeedContext?: () => DidHeuristicContext;
  /**
   * P4f-FIX5/FIX6 (binding, after Codex P4f-REV5/REV6): fired ONCE per
   * observation run, forwarding core `runDidObservation`'s OWN `onStarted`
   * callback verbatim -- `anchor.wallClockMs` is EXACTLY the `startedAtMs`
   * value core captured (synchronously, before its first send), never a
   * separately-read `deps.clock.now()` here (REV6: two independent reads of
   * the same clock instance can still disagree if it advances between the
   * calls). This fires AFTER the transport has finished connecting (or
   * immediately, resuming from paused, where no connect delay applies). A
   * caller collecting its OWN wall-clock-timestamped series (e.g. GNSS
   * speed) to feed `gnssSpeedContext` MUST re-baseline against THIS anchor,
   * not against whenever it happened to call `startObservation()` --
   * anchoring at the tap instead silently offsets every sample by the
   * connection delay, corrupting `classifyResponders`' nearest-time
   * correlation (the REV5 defect this callback exists to let the caller
   * avoid; REV6 closed the remaining double-clock-read skew).
   */
  onObservationStarted?: (anchor: { wallClockMs: number }) => void;
  /**
   * DID sweep — results persistence, export & candidate filtering addendum
   * (2026-08-27, binding — Phase 4i): "every sweep run is persisted
   * incrementally ... A run survives app kill and can be resumed from
   * `lastDid`." Omitted entirely (undefined) disables persistence
   * altogether -- every EXISTING test/caller that doesn't pass this keeps
   * working exactly as before, byte-identical.
   */
  store?: DidSweepStore;
  /** default 5 (addendum: "Retention: keep the last 5 runs"). Applied once, right after a fresh `start()` creates its own run row. */
  retentionRuns?: number;
}

export interface DidSweepController {
  subscribe(cb: (s: DidSweepSnapshot) => void): () => void;
  getSnapshot(): DidSweepSnapshot;
  /** Refused (no generation bump, no acquire attempt even) unless idle/complete -- see this module's own doc comment (H1). Acquires the reservation, THEN opens a fresh transport. */
  start(range?: { from?: number; to?: number; priorityRanges?: readonly DidSweepRange[] }): void;
  /** Stops calling `next()` at the next DID boundary -- phase becomes 'paused'. The transport/reservation are NOT touched -- `resume()`/`startObservation()` reuse them. */
  pause(): void;
  /** Resumes a paused sweep on the SAME transport/reservation/accumulator (no reconnect, no re-acquire, no lost results). */
  resume(): void;
  /** Stops the sweep (or observation) permanently: closes the transport, THEN releases the reservation (H1/H2, binding, strictly in that order, on every path). Idempotent. */
  stop(): void;
  /** Starts the observation phase over the responders found so far. From `'paused'`, reuses the held claim/open transport (M2, binding) -- no second acquire, no reconnect. From a terminal state (sweepComplete/stopped/observationComplete), acquires and connects fresh, exactly like `start()`. No-op if there are no responders. */
  startObservation(windowMs?: number): void;
  /** Ends the observation phase early and computes suggestions from whatever was sampled so far. */
  stopObservationEarly(): void;
  /** Builds the `EnetChannelSpec` a "Tag as <channel>" tap writes -- `null` if `did` has no current suggestion (or the produced spec fails `@circuit/core`'s own validation). Pure; persistence is the caller's job (`enetSettingsValidation.ts`'s `mergeEnetChannelSpecJson`). */
  buildTaggedSpec(did: number, channel: TelemetryChannelId, dateIso: string): EnetChannelSpec | null;
  /**
   * DID sweep — guided candidate observation addendum (2026-08-27, binding —
   * Phase 4i, user clarification): runs the fixed 4-phase guided re-read
   * (`DID_OBSERVATION_PHASES`: baseline -> brake -> steering -> throttle,
   * ~6s each) over the candidate DIDs (`snapshot.responders`), on ONE
   * connection for the whole run -- same preconditions/lifecycle as
   * `startObservation()`'s terminal-state (fresh acquire+connect) branch;
   * no-op if there are no responders, or the phase isn't idle/terminal.
   */
  startGuidedObservation(): void;
  /** Ends the CURRENT (and every remaining) guided phase early, computing candidate summaries from whatever was sampled so far -- same semantics as `stopObservationEarly()`. */
  stopGuidedObservationEarly(): void;
  /**
   * DID sweep — results persistence, export & candidate filtering addendum
   * (2026-08-27, binding — Phase 4i): resumes a run persisted by an earlier
   * (possibly app-killed) `start()`, continuing from its `lastDid` with the
   * accumulator restored from the store. No-op (never throws) if `deps.store`
   * is undefined, the run doesn't exist, the phase isn't idle/terminal, or
   * the reservation is unavailable. Named distinctly from the existing
   * no-arg `resume()` (which continues a PAUSED in-memory run on its own
   * still-open transport) -- this one is a fresh acquire+connect, exactly
   * like `start()`, just seeded from persisted state instead of an empty one.
   */
  resumePersistedRun(runId: string): Promise<void>;
  /** Every persisted run (most-recently-updated first), for the screen's own "Resume" affordance -- `[]` if `deps.store` is undefined. Delegates straight to the store; never throws. */
  listPersistedRuns(): Promise<DidSweepRunRecord[]>;
  /** The runId THIS controller instance is currently persisting to (set by `start()`/`resumePersistedRun()`), or `null` before any run/without a `store`. The screen's own "Share results" reads the run+responders straight from `deps.store` using this id. */
  getCurrentRunId(): string | null;
}

const DEFAULT_OBSERVATION_WINDOW_MS = 60_000;

type SweepOutcome = 'complete' | 'paused' | 'stopped';

function waitMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

export function createDidSweepController(deps: DidSweepControllerDeps): DidSweepController {
  const reservation = deps.reservation ?? sharedEnetAdapterReservation;
  const listeners = new Set<(s: DidSweepSnapshot) => void>();
  let snapshot: DidSweepSnapshot = INITIAL_SNAPSHOT;
  let token: EnetAdapterToken | null = null;
  let plan: DidSweepPlan | null = null;
  let accumulator: DidSweepAccumulator | null = null;
  /** Shared, mutable, live-read by `@circuit/core`'s `runDidSweep` while it runs -- `pause()`/`stop()` flip these to make an in-flight call return promptly at its next check point. */
  let control: DidSweepControl = { paused: false, stopped: false };
  /**
   * M2 (binding, P4f-FIX3): shared with core's `runDidObservation` for the
   * WHOLE observation window (a single call, never re-created per poll).
   * `stopObservationEarly()` flips `.stopped` on this SAME object -- WITHOUT
   * bumping `generation` -- to make that one call's loop end at its next
   * boundary while still classifying whatever was sampled; a full `stop()`
   * flips the SAME flag AND bumps `generation`, which is what
   * `runObservationOnChannel` actually keys "skip classify" off of (see its
   * own doc comment) -- not a second, separate cut-short flag.
   */
  let observationControl: DidSweepControl = { paused: false, stopped: false };
  let startedAtMs = 0;
  let requestsIssued = 0;
  /** Bumped on `stop()` and on every fresh `start()`/observation-from-terminal-state -- a superseded async continuation checks this before touching shared state (transport/reservation/snapshot). */
  let generation = 0;
  let activeTransport: ObdTransport | null = null;
  let activeChannel: SweepTransport | null = null;
  /** M2 (binding): the fixed responder-DID set `runDidObservation` polls round-robin for the current/next observation run -- set once when an observation starts, never mutated mid-run (core owns the round-robin itself). */
  let observationResponderDids: number[] = [];
  /** REV3 fix (binding, HIGH): the in-flight `teardownActiveTransport()` call, if one is running -- a concurrent caller (e.g. `stop()` racing a natural completion's own close) JOINS this SAME promise instead of finding `activeTransport` already cleared and releasing early. */
  let teardownInFlight: Promise<void> | null = null;
  /** REV3 (binding): "close() settles (or its 200ms race elapses)" -- mirrors discovery's own close-race pattern (P4f-REV1) so a hanging real-world close can never block `stop()`/release indefinitely. */
  const TEARDOWN_RACE_MS = 200;

  // -------------------------------------------------------------------
  // Persistence (binding, P4i: results persistence, export & candidate
  // filtering addendum) -- entirely a no-op (every function below is a
  // guarded early-return) when `deps.store` is undefined, so every EXISTING
  // caller/test that doesn't pass one keeps working byte-identically.
  // -------------------------------------------------------------------
  const RETENTION_RUNS = deps.retentionRuns ?? 5;
  const FLUSH_INTERVAL_MS = 2_000;
  const FLUSH_RESPONDER_COUNT = 50;
  let currentRunId: string | null = null;
  /** Index into `accumulator.responders` up to which persistence has already flushed -- only the SLICE past this is upserted on the next flush. */
  let lastPersistedResponderIndex = 0;
  let lastFlushAtMs = 0;
  /** Guards against overlapping flushes (a slow persist racing the next tick's attempt) -- a tick that finds one already in flight simply skips; the NEXT due tick (or the forced flush at a phase boundary) catches up. */
  let persistFlushInFlight = false;

  function nowIso(): string {
    return new Date().toISOString();
  }

  function currentNrcCountsAsStrings(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [nrc, count] of Object.entries(accumulator?.nrcCounts ?? {})) out[nrc] = count;
    return out;
  }

  async function persistRunProgress(status: DidSweepRunStatus): Promise<void> {
    if (deps.store === undefined || currentRunId === null) return;
    await deps.store.updateRunProgress(
      currentRunId,
      {
        status,
        lastDid: accumulator?.lastDid ?? null,
        visitedCount: plan?.visitedCount ?? 0,
        timeoutCount: accumulator?.timeouts ?? 0,
        unmatchedCount: accumulator?.unmatched ?? 0,
        errorCount: accumulator?.errors ?? 0,
        nrcCounts: currentNrcCountsAsStrings(),
      },
      nowIso(),
    );
  }

  /**
   * Batched incremental persistence (addendum: "writes incrementally,
   * batched every 2s or 50 responders"). Called on every sweep `onProgress`
   * tick; `force` (pause/stop/complete) always flushes regardless of the
   * batch thresholds, so the LAST persisted state is never more than one
   * tick stale.
   */
  function maybeFlushPersistence(force: boolean, status: DidSweepRunStatus): void {
    if (deps.store === undefined || currentRunId === null || accumulator === null || persistFlushInFlight) return;
    const newResponders = accumulator.responders.slice(lastPersistedResponderIndex);
    const now = deps.clock.now();
    const dueByTime = now - lastFlushAtMs >= FLUSH_INTERVAL_MS;
    const dueByCount = newResponders.length >= FLUSH_RESPONDER_COUNT;
    if (!force && !dueByTime && !dueByCount) return;

    const store = deps.store;
    const runId = currentRunId;
    const flushedThroughIndex = accumulator.responders.length;
    persistFlushInFlight = true;
    void (async () => {
      try {
        if (newResponders.length > 0) {
          await store.upsertResponders(
            runId,
            newResponders.map((r) => ({ did: r.did, raw: r.raw, rttMs: r.rttMs })),
            nowIso(),
          );
          lastPersistedResponderIndex = flushedThroughIndex;
        }
        await persistRunProgress(status);
        lastFlushAtMs = deps.clock.now();
      } catch {
        // Best-effort (mirrors `SqlSettingsStore.persist()`'s own discipline)
        // -- a failed write never affects the LIVE sweep; the next due tick
        // retries from wherever `lastPersistedResponderIndex` still is.
      } finally {
        persistFlushInFlight = false;
      }
    })();
  }

  function generateRunId(): string {
    return `did-sweep-${Date.now()}-${Math.floor(Math.random() * 1_000_000)
      .toString(36)
      .padStart(4, '0')}`;
  }

  /** Fast-forwards a FRESH plan's cursor past every DID up to and including `lastDid` (a resumed run's own "already resolved" boundary) -- cheap, pure-JS, no I/O; `createDidSweepPlan`'s `order` is deterministic so this reproduces exactly where the ORIGINAL run's cursor was. No-op if `lastDid` is `null` (nothing resolved yet). */
  function fastForwardPlan(freshPlan: DidSweepPlan, lastDid: number | null): void {
    if (lastDid === null) return;
    let next = freshPlan.next();
    while (next !== null && next !== lastDid) next = freshPlan.next();
  }

  function emit(next: Partial<DidSweepSnapshot>): void {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[didSweepController] a subscriber threw -- ignored, other subscribers still notified', error);
      }
    }
  }

  function releaseReservation(): void {
    if (token !== null) {
      reservation.release(token);
      token = null;
    }
  }

  /**
   * P4f-FIX4 (binding, HIGH, after Codex REV4): `transport.close()` may throw
   * SYNCHRONOUSLY (never returning a promise at all), not only reject one --
   * calling it directly inside `Promise.race([transport.close().catch(...), ...])`
   * only contains a REJECTION (the `.catch` is on the promise IT returns); a
   * synchronous throw happens before `.catch` can even be attached, so it
   * would propagate out of `teardownActiveTransport`'s `try/finally` (finally
   * runs, but the throw is re-raised after it) and reject `teardownInFlight`
   * -- every awaiter (`stop()` included) would then never reach its own
   * release. This wrapper never rejects, regardless of how `close()` fails.
   */
  function closeQuietly(transport: ObdTransport): Promise<void> {
    try {
      return Promise.resolve(transport.close()).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * Closes the active transport (if any) -- does NOT touch the reservation
   * (callers release separately, strictly AFTER this resolves). REV3
   * (binding): retains `activeTransport`/`activeChannel` until `close()`
   * settles (or the 200ms race elapses), NEVER before, and a concurrent call
   * while one is already running joins the SAME promise rather than starting
   * a second (redundant) close or -- the original bug -- finding the
   * reference already nulled and returning as a no-op. `closeQuietly` (above)
   * guarantees the returned promise NEVER rejects (REV4, binding) -- every
   * caller can safely `await` this without its own try/catch.
   */
  function teardownActiveTransport(): Promise<void> {
    if (teardownInFlight !== null) return teardownInFlight;
    const transport = activeTransport;
    if (transport === null) return Promise.resolve();
    const promise = (async () => {
      try {
        await Promise.race([closeQuietly(transport), waitMs(TEARDOWN_RACE_MS)]);
      } finally {
        activeTransport = null;
        activeChannel = null;
        teardownInFlight = null;
      }
    })();
    teardownInFlight = promise;
    return promise;
  }

  /**
   * H1 (binding, REV3): the ONE lifecycle guard every entry point runs
   * through -- `body` does its own work (connect, build the channel, run the
   * core loop, and on a normal exit call `finishSweepRun`/its observation
   * counterpart, which already close+release themselves). Whatever `body`
   * does NOT catch (a synchronous throw from `transportFactory`/channel
   * creation, a `connect()` rejection, or an unexpected rejection from the
   * core runner) lands here: teardown (close) THEN release, on every path,
   * with the run's OWN generation re-checked after the (possibly-joined)
   * teardown resolves so a superseded attempt never re-emits over a later
   * terminal state.
   */
  async function runGuarded(myGeneration: number, body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (error) {
      await teardownActiveTransport();
      if (myGeneration !== generation) return; // a stop()/fresh start() already superseded this attempt -- it owns the final phase.
      releaseReservation();
      emit({ phase: 'stopped', error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Runs `@circuit/core`'s `runDidSweep` against `plan`/`accumulator` (both module-level, reused across pause/resume) until it returns -- SID/DID correlation, 0x78, unmatched retries, and keep-alive cadence are ENTIRELY the core runner's job; this only drives it and reflects its accumulator into the snapshot. */
  async function runSweepLoop(myGeneration: number, channel: SweepTransport): Promise<SweepOutcome> {
    if (plan === null || accumulator === null) return 'stopped';
    await runDidSweep({
      plan,
      transport: channel,
      clock: deps.clock,
      pacing: deps.pacing,
      control,
      accumulator,
      requestTimeoutMs: deps.requestTimeoutMs,
      maxResponsePendingExtensions: deps.maxResponsePendingExtensions,
      onProgress: (progress) => {
        if (myGeneration !== generation) return;
        requestsIssued += 1;
        const elapsedS = Math.max(0.001, (deps.clock.now() - startedAtMs) / 1_000);
        emit({
          responders: accumulator!.responders,
          nrcCounts: accumulator!.nrcCounts,
          timeouts: accumulator!.timeouts,
          unmatched: accumulator!.unmatched,
          progress: { did: progress.did, index: progress.index, total: progress.total, reqPerSec: requestsIssued / elapsedS },
        });
        maybeFlushPersistence(false, 'running');
      },
    });
    if (myGeneration !== generation) return 'stopped'; // superseded -- stop() owns its own teardown/release.
    // Final snapshot merge -- `onProgress` already reflects every INDIVIDUAL
    // DID's result, but the accumulator itself may have settled further
    // (e.g. an interface-error-triggered stop with no matching onProgress
    // tick) -- this keeps the snapshot exactly consistent with the returned
    // accumulator regardless.
    emit({
      responders: accumulator.responders,
      nrcCounts: accumulator.nrcCounts,
      timeouts: accumulator.timeouts,
      unmatched: accumulator.unmatched,
    });
    if (control.stopped) return 'stopped';
    if (control.paused) return 'paused';
    return 'complete'; // neither flag caused the return -- the plan is exhausted.
  }

  /**
   * Shared tail for a `runSweepLoop` outcome, whether reached from a fresh
   * `start()` or a `resume()` on the SAME channel. `'paused'` leaves the
   * transport/reservation held (untouched) for a later `resume()`/
   * `startObservation()`; `'complete'`/`'stopped'` close then release --
   * with the generation re-checked AFTER teardown (REV3, binding), so a
   * `stop()` that raced in while THIS close was still settling (and already
   * emitted its own `'stopped'`+released) is never overwritten here.
   */
  async function finishSweepRun(myGeneration: number, outcome: SweepOutcome): Promise<void> {
    if (myGeneration !== generation) return; // stop() already handled teardown/release.
    if (outcome === 'paused') {
      maybeFlushPersistence(true, 'paused');
      emit({ phase: 'paused' });
      return; // transport/reservation stay held -- resume() continues on the SAME channel.
    }
    await teardownActiveTransport();
    if (myGeneration !== generation) return; // stop() raced in while close was settling -- it owns the final phase.
    maybeFlushPersistence(true, outcome === 'complete' ? 'complete' : 'stopped');
    emit({ phase: outcome === 'complete' ? 'sweepComplete' : 'stopped' });
    releaseReservation();
  }

  /**
   * H1/H2/REV3 (binding): acquires the reservation (by the caller, before
   * this runs), opens a FRESH transport, builds the channel, runs
   * `runSweepLoop`, and hands the outcome to `finishSweepRun` -- all inside
   * ONE `runGuarded` lifecycle: a synchronous throw from `transportFactory`/
   * `createRawUdsChannel`, a `connect()` rejection, or an unexpected
   * rejection from the core runner are ALL caught by `runGuarded`, which
   * closes the transport then releases the reservation before surfacing the
   * error -- nothing here can leak an open transport or a held claim.
   */
  async function openTransportAndSweep(myGeneration: number): Promise<void> {
    await runGuarded(myGeneration, async () => {
      const transport = deps.transportFactory();
      activeTransport = transport;
      await transport.connect();
      if (myGeneration !== generation) {
        // stop() raced in during connect() -- it already bumped generation
        // and will close/release via its OWN teardown path (joining this
        // same in-flight transport reference); just get out.
        return;
      }
      const channel = createRawUdsChannel(transport, deps.testerAddress, deps.targetAddress);
      activeChannel = channel;
      const outcome = await runSweepLoop(myGeneration, channel);
      await finishSweepRun(myGeneration, outcome);
    });
  }

  // ---------------------------------------------------------------------
  // Observation (M2/M3, binding). ONE call to core's `runDidObservation`
  // owns the whole window: round-robin polling, keep-alive cadence, pacing,
  // and the consecutive-error budget, all for the ENTIRE run (never
  // re-created per poll -- the REV3 defect this replaces re-invoked a
  // per-DID `runDidSweep` for every single poll, which reset the keep-alive
  // deadline/pacing/error budget every time a response arrived quickly).
  // ---------------------------------------------------------------------

  function finishObservation(series: readonly DidResponderSeries[], cadenceDegraded: boolean): void {
    const context = deps.gnssSpeedContext?.();
    const suggestions = classifyResponders(series, context);
    emit({ phase: 'observationComplete', suggestions, observationCadenceDegraded: cadenceDegraded });
  }

  /**
   * M2 (binding, P4f-FIX3): delegates the ENTIRE round-robin/keep-alive/
   * pacing/error-budget loop to core's `runDidObservation` -- a SINGLE call
   * for the whole window, never re-implemented here. `stopObservationEarly()`
   * and a full `stop()` both end that one call early by flipping the SAME
   * `observationControl.stopped` core polls; they are told apart AFTER the
   * call resolves purely by `generation` (`stop()` bumps it, `stopObservationEarly()`
   * does not) -- REV3's "generation re-checked after teardown, not only
   * before" discipline is what keeps a full stop()'s own 'stopped' emit from
   * ever being overwritten by this call's classify tail.
   */
  async function runObservationOnChannel(myGeneration: number, channel: SweepTransport, windowMs: number): Promise<void> {
    const result = await runDidObservation({
      responders: observationResponderDids,
      transport: channel,
      clock: deps.clock,
      durationMs: windowMs,
      pacing: deps.pacing,
      control: observationControl,
      requestTimeoutMs: deps.requestTimeoutMs,
      maxResponsePendingExtensions: deps.maxResponsePendingExtensions,
      // P4f-FIX6 (binding, after Codex P4f-REV6): the ONLY source of the
      // anchor -- core's OWN clock read, handed back synchronously at the
      // EXACT instant it captures `startedAtMs` (before the first send),
      // never a SEPARATELY-read `deps.clock.now()` here (the REV6 defect:
      // two independent reads of the same clock instance can still disagree
      // if it advances between the calls). This guarantees the controller's
      // anchor and every relative `tMs` this run reports (`onSample` and
      // `result.series` alike) are structurally the SAME value.
      onStarted: (startedAtMs) => {
        if (myGeneration === generation) emit({ observationAnchorWallClockMs: startedAtMs });
        deps.onObservationStarted?.({ wallClockMs: startedAtMs });
      },
      onSample: (_did, _raw, tMs) => {
        if (myGeneration !== generation) return;
        emit({ observationElapsedMs: tMs });
      },
    });
    if (myGeneration !== generation) return; // a full stop() already handled teardown/release + the final 'stopped' phase itself.
    await teardownActiveTransport();
    if (myGeneration !== generation) return; // stop() raced in while close was settling -- it owns the final phase.
    // Reaching here means this call was NOT superseded by a full stop() --
    // window elapsed naturally, `stopObservationEarly()` ended it, or the
    // error budget stopped it -- ALL classify whatever was sampled.
    finishObservation(result.series, result.cadenceDegraded);
    releaseReservation();
  }

  /** H1/REV3 (binding): same single `runGuarded` lifecycle as `openTransportAndSweep` -- a synchronous throw from `transportFactory`/`createRawUdsChannel`, a `connect()` rejection, or an unexpected rejection from the observation loop are ALL caught, closing then releasing before surfacing the error. */
  async function openTransportAndObserve(myGeneration: number, windowMs: number): Promise<void> {
    await runGuarded(myGeneration, async () => {
      const transport = deps.transportFactory();
      activeTransport = transport;
      await transport.connect();
      if (myGeneration !== generation) return; // stop() raced in during connect() -- it owns teardown/release.
      const channel = createRawUdsChannel(transport, deps.testerAddress, deps.targetAddress);
      activeChannel = channel;
      await runObservationOnChannel(myGeneration, channel, windowMs);
    });
  }

  // -------------------------------------------------------------------
  // Guided candidate observation (binding, P4i, user clarification): the
  // fixed 4-phase re-read (`DID_OBSERVATION_PHASES`) -- ONE `runDidObservation`
  // call per phase, on the SAME connection for the whole run (never torn
  // down between phases), tagging every correlated sample with its phase so
  // `computeDidCandidateSummaries` (core, pure) can rank candidates by
  // WHICH phase(s) actually changed their bytes.
  // -------------------------------------------------------------------

  /** Accumulates every phase's samples for the CURRENT guided run -- reset at the start of `runGuidedObservationOnChannel`, read by `computeDidCandidateSummaries` both live (after each sample) and at the end. */
  let guidedSamples: DidPhaseSample[] = [];

  async function runGuidedPhase(
    myGeneration: number,
    channel: SweepTransport,
    phase: (typeof DID_OBSERVATION_PHASES)[number],
  ): Promise<void> {
    emit({ guidedPhase: phase.id, guidedPhaseElapsedMs: 0 });
    await runDidObservation({
      responders: observationResponderDids,
      transport: channel,
      clock: deps.clock,
      durationMs: phase.durationMs,
      pacing: deps.pacing,
      control: observationControl,
      requestTimeoutMs: deps.requestTimeoutMs,
      maxResponsePendingExtensions: deps.maxResponsePendingExtensions,
      onStarted: (startedAtMs) => {
        if (myGeneration === generation) deps.onObservationStarted?.({ wallClockMs: startedAtMs });
      },
      onSample: (did, raw, tMs) => {
        if (myGeneration !== generation) return;
        guidedSamples.push({ did, phase: phase.id, tMs, raw });
        emit({ guidedPhaseElapsedMs: tMs, candidateSummaries: computeDidCandidateSummaries(guidedSamples) });
      },
    });
  }

  /**
   * Runs every phase in `DID_OBSERVATION_PHASES`, in order, on ONE channel --
   * a full `stop()` (bumps `generation`) or `stopGuidedObservationEarly()`
   * (flips `observationControl.stopped` without bumping `generation`, same
   * discipline as `stopObservationEarly()`) both end the CURRENT phase's
   * `runDidObservation` call early; only a phase boundary check decides
   * whether the NEXT phase still runs.
   */
  async function runGuidedObservationOnChannel(myGeneration: number, channel: SweepTransport): Promise<void> {
    guidedSamples = [];
    for (const phase of DID_OBSERVATION_PHASES) {
      if (myGeneration !== generation || observationControl.stopped) break;
      await runGuidedPhase(myGeneration, channel, phase);
    }
    if (myGeneration !== generation) return; // a full stop() already handled teardown/release + the final phase itself.
    await teardownActiveTransport();
    if (myGeneration !== generation) return; // stop() raced in while close was settling -- it owns the final phase.
    emit({ phase: 'observationComplete', guidedPhase: null, candidateSummaries: computeDidCandidateSummaries(guidedSamples) });
    releaseReservation();
  }

  /** Same single `runGuarded` lifecycle as `openTransportAndObserve` -- a synchronous throw from `transportFactory`/`createRawUdsChannel`, a `connect()` rejection, or an unexpected rejection from the guided loop are ALL caught, closing then releasing before surfacing the error. */
  async function openTransportAndGuidedObserve(myGeneration: number): Promise<void> {
    await runGuarded(myGeneration, async () => {
      const transport = deps.transportFactory();
      activeTransport = transport;
      await transport.connect();
      if (myGeneration !== generation) return;
      const channel = createRawUdsChannel(transport, deps.testerAddress, deps.targetAddress);
      activeChannel = channel;
      await runGuidedObservationOnChannel(myGeneration, channel);
    });
  }

  function canStart(phase: DidSweepPhase): boolean {
    return phase === 'idle' || phase === 'sweepComplete' || phase === 'stopped' || phase === 'observationComplete';
  }

  return {
    subscribe(cb): () => void {
      listeners.add(cb);
      cb(snapshot);
      return () => listeners.delete(cb);
    },

    getSnapshot(): DidSweepSnapshot {
      return snapshot;
    },

    start(range = {}): void {
      // H1 (binding): refused unless idle/complete -- checked BEFORE touching
      // generation/reservation at all, so a reentrant Start while sweeping
      // neither leaks a claim nor bumps `generation` out from under the
      // ACTIVE run (which keys its own "am I superseded?" checks off it).
      if (!canStart(snapshot.phase)) return;
      const acquired = reservation.tryAcquire('sweep');
      if (acquired === null) {
        emit({ ...INITIAL_SNAPSHOT, error: RESERVATION_BUSY_MESSAGE });
        return;
      }
      let freshPlan: DidSweepPlan;
      try {
        freshPlan = createDidSweepPlan(range);
      } catch (error) {
        reservation.release(acquired);
        emit({ ...INITIAL_SNAPSHOT, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      generation += 1; // ONLY bumped after both the acquire and the plan succeeded.
      const myGeneration = generation;
      token = acquired;
      plan = freshPlan;
      accumulator = createDidSweepAccumulator();
      control = { paused: false, stopped: false };
      requestsIssued = 0;
      startedAtMs = deps.clock.now();
      observationResponderDids = [];
      // Persistence (binding, P4i): a FRESH run row per `start()` -- never
      // per resume/pause/observation, matching "every sweep run is
      // persisted incrementally" (ONE run per Start tap, resumed rather than
      // re-created by `resumePersistedRun`).
      lastPersistedResponderIndex = 0;
      lastFlushAtMs = deps.clock.now();
      if (deps.store !== undefined) {
        currentRunId = generateRunId();
        const runId = currentRunId;
        const store = deps.store;
        void store
          .createRun({
            runId,
            adapterType: 'enet',
            targetAddress: deps.targetAddress,
            rangeFrom: freshPlan.from,
            rangeTo: freshPlan.to,
            lastDid: null,
            startedAtUtc: nowIso(),
            updatedAtUtc: nowIso(),
            status: 'running',
            visitedCount: 0,
            timeoutCount: 0,
            unmatchedCount: 0,
            errorCount: 0,
            nrcCounts: {},
          })
          .then(() => store.enforceRetention(RETENTION_RUNS))
          .catch(() => undefined); // best-effort -- a failed write never affects the live sweep (mirrors maybeFlushPersistence's own discipline).
      } else {
        currentRunId = null;
      }
      emit({ ...INITIAL_SNAPSHOT, error: null, phase: 'sweeping' });
      void openTransportAndSweep(myGeneration);
    },

    pause(): void {
      if (snapshot.phase !== 'sweeping') return;
      control.paused = true;
    },

    resume(): void {
      if (snapshot.phase !== 'paused' || plan === null || accumulator === null || activeChannel === null) return;
      control.paused = false;
      const myGeneration = generation; // SAME generation -- the transport/channel/reservation/accumulator are all still this run's own.
      emit({ phase: 'sweeping' });
      const channel = activeChannel;
      void runGuarded(myGeneration, async () => {
        const outcome = await runSweepLoop(myGeneration, channel);
        await finishSweepRun(myGeneration, outcome);
      });
    },

    stop(): void {
      if (snapshot.phase === 'idle' || snapshot.phase === 'stopped') return;
      control.stopped = true;
      observationControl.stopped = true;
      generation += 1; // supersede any in-flight sweep/observation continuation -- ITS OWN teardown/release is now skipped (see the `myGeneration !== generation` guards above), this call owns close-then-release instead.
      maybeFlushPersistence(true, 'stopped');
      emit({ phase: 'stopped' });
      void (async () => {
        // P4f-FIX4 (binding, HIGH, after Codex REV4): release is UNCONDITIONAL
        // -- a `finally`, not a second sequential statement -- so it always
        // runs even if something besides `teardownActiveTransport()` itself
        // (already made non-rejecting, see `closeQuietly`) were ever to throw
        // here; the claim must never outlive this `stop()` call.
        try {
          await teardownActiveTransport();
        } finally {
          releaseReservation();
        }
      })();
    },

    startObservation(windowMs = DEFAULT_OBSERVATION_WINDOW_MS): void {
      if (snapshot.phase !== 'sweepComplete' && snapshot.phase !== 'paused' && snapshot.phase !== 'stopped' && snapshot.phase !== 'observationComplete') {
        return;
      }
      if (snapshot.responders.length === 0) return;

      // M2 (binding): resuming FROM PAUSED reuses the held claim/open
      // transport -- no second `tryAcquire`, no reconnect.
      if (snapshot.phase === 'paused' && activeChannel !== null) {
        observationControl = { paused: false, stopped: false };
        const myGeneration = generation; // SAME generation/token/transport.
        const channel = activeChannel;
        // Addendum (binding, P4i): "the observation phase uses the filtered candidate set" -- length 1-8 bytes, not ASCII-looking (see `didCandidates.ts`).
        observationResponderDids = filterSweepCandidates(snapshot.responders).map((r) => r.did);
        emit({ phase: 'observing', observationElapsedMs: 0, observationCadenceDegraded: false, observationAnchorWallClockMs: null, error: null });
        void runGuarded(myGeneration, () => runObservationOnChannel(myGeneration, channel, windowMs));
        return;
      }

      // A terminal state with no held claim (sweepComplete/stopped/
      // observationComplete) -- open fresh, exactly like `start()`.
      const acquired = reservation.tryAcquire('sweep');
      if (acquired === null) {
        emit({ error: RESERVATION_BUSY_MESSAGE });
        return;
      }
      generation += 1;
      const myGeneration = generation;
      token = acquired;
      observationControl = { paused: false, stopped: false };
      // Addendum (binding, P4i): "the observation phase uses the filtered candidate set" -- length 1-8 bytes, not ASCII-looking (see `didCandidates.ts`).
      observationResponderDids = filterSweepCandidates(snapshot.responders).map((r) => r.did);
      emit({ phase: 'observing', observationElapsedMs: 0, observationCadenceDegraded: false, observationAnchorWallClockMs: null, error: null });
      void openTransportAndObserve(myGeneration, windowMs);
    },

    stopObservationEarly(): void {
      if (snapshot.phase !== 'observing') return;
      // M2 (binding, P4f-FIX3): flips the SAME `control.stopped` core's
      // `runDidObservation` polls (ending that one call's loop at its next
      // boundary) WITHOUT bumping `generation` -- `runObservationOnChannel`'s
      // post-call generation check is what tells this apart from a full
      // `stop()` (which flips the identical flag AND bumps `generation`):
      // only a full `stop()` skips the classify tail; this always reaches it.
      observationControl.stopped = true;
    },

    buildTaggedSpec(did, channel, dateIso): EnetChannelSpec | null {
      const suggestion = snapshot.suggestions.find((s) => s.did === did);
      if (suggestion === undefined) return null;
      try {
        return enetSpecsFromSuggestion(suggestion, channel, dateIso);
      } catch {
        return null;
      }
    },

    startGuidedObservation(): void {
      if (snapshot.phase !== 'sweepComplete' && snapshot.phase !== 'stopped' && snapshot.phase !== 'observationComplete') {
        return;
      }
      if (snapshot.responders.length === 0) return;
      const acquired = reservation.tryAcquire('sweep');
      if (acquired === null) {
        emit({ error: RESERVATION_BUSY_MESSAGE });
        return;
      }
      generation += 1;
      const myGeneration = generation;
      token = acquired;
      observationControl = { paused: false, stopped: false };
      // Addendum (binding, P4i): "the observation phase uses the filtered candidate set" -- length 1-8 bytes, not ASCII-looking (see `didCandidates.ts`).
      observationResponderDids = filterSweepCandidates(snapshot.responders).map((r) => r.did);
      guidedSamples = [];
      emit({ phase: 'observing', guidedPhase: null, guidedPhaseElapsedMs: 0, candidateSummaries: [], error: null });
      void openTransportAndGuidedObserve(myGeneration);
    },

    stopGuidedObservationEarly(): void {
      if (snapshot.phase !== 'observing') return;
      // Same semantics as `stopObservationEarly()`: ends the CURRENT phase's
      // `runDidObservation` call at its next boundary WITHOUT bumping
      // `generation` -- `runGuidedObservationOnChannel`'s own per-phase loop
      // check (`observationControl.stopped`) is what then skips every
      // REMAINING phase too, still reaching the classify-and-release tail.
      observationControl.stopped = true;
    },

    async resumePersistedRun(runId: string): Promise<void> {
      if (deps.store === undefined) return;
      if (!canStart(snapshot.phase)) return;
      const run = await deps.store.getRun(runId).catch(() => null);
      if (run === null) return;
      const responderRecords = await deps.store.getResponders(runId).catch(() => []);

      const acquired = reservation.tryAcquire('sweep');
      if (acquired === null) {
        emit({ ...INITIAL_SNAPSHOT, error: RESERVATION_BUSY_MESSAGE });
        return;
      }
      let freshPlan: DidSweepPlan;
      try {
        freshPlan = createDidSweepPlan({ from: run.rangeFrom, to: run.rangeTo });
      } catch (error) {
        reservation.release(acquired);
        emit({ ...INITIAL_SNAPSHOT, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      fastForwardPlan(freshPlan, run.lastDid);

      generation += 1;
      const myGeneration = generation;
      token = acquired;
      plan = freshPlan;
      const restoredResponders: DidSweepResponder[] = responderRecords.map((r) => ({
        did: r.did,
        raw: hexToBytes(r.rawHex),
        length: r.length,
        rttMs: r.rttMs ?? 0,
      }));
      const restoredNrcCounts: Record<number, number> = {};
      for (const [nrc, count] of Object.entries(run.nrcCounts)) restoredNrcCounts[Number(nrc)] = count;
      accumulator = {
        responders: restoredResponders,
        nrcCounts: restoredNrcCounts,
        timeouts: run.timeoutCount,
        unmatched: run.unmatchedCount,
        errors: run.errorCount,
        lastDid: run.lastDid,
      };
      control = { paused: false, stopped: false };
      requestsIssued = 0;
      startedAtMs = deps.clock.now();
      observationResponderDids = [];
      currentRunId = runId;
      lastPersistedResponderIndex = restoredResponders.length;
      lastFlushAtMs = deps.clock.now();
      emit({
        ...INITIAL_SNAPSHOT,
        error: null,
        phase: 'sweeping',
        responders: restoredResponders,
        nrcCounts: restoredNrcCounts,
        timeouts: run.timeoutCount,
        unmatched: run.unmatchedCount,
      });
      void openTransportAndSweep(myGeneration);
    },

    async listPersistedRuns(): Promise<DidSweepRunRecord[]> {
      if (deps.store === undefined) return [];
      try {
        return await deps.store.listRuns();
      } catch {
        return [];
      }
    },

    getCurrentRunId(): string | null {
      return currentRunId;
    },
  };
}
