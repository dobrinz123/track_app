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
  assertAllowedRequest,
  bytesToBinaryString,
  binaryStringToBytes,
  buildTesterPresentRequest,
  classifyResponders,
  computeChangingValuePrePassDurationMs,
  computeDidBlockCandidateSummaries,
  computeDidCandidateSummaries,
  computeGuidedPhaseDurationMs,
  createDidSweepAccumulator,
  createDidSweepPlan,
  DEFAULT_MIN_SAMPLES_PER_PHASE,
  DID_OBSERVATION_PHASES,
  encodeFrame,
  filterCandidatePool,
  filterSweepCandidates,
  enetSpecsFromSuggestion,
  MAX_BATCH_SIZE,
  MAX_FOCUSED_SHORTLIST_SIZE,
  MAX_MIN_SAMPLES_PER_PHASE,
  orderChangingCandidatesFirst,
  planObservationBatches,
  HSFZ_CONTROL,
  HsfzFrameParser,
  isSettlingSample,
  runDidObservation,
  runDidSweep,
  SETTLE_MS,
  type DidBlockCandidateSummary,
  type DidCandidateSummary,
  type DidChangeSamplePair,
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
  type ObservationBatch,
  type SweepTransport,
  type TelemetryChannelId,
} from '@circuit/core';
import { enetAdapterReservation as sharedEnetAdapterReservation, type EnetAdapterReservation, type EnetAdapterToken } from './enetAdapterReservation';
import { hexToBytes, type DidSweepRunProgressPatch, type DidSweepRunRecord, type DidSweepRunStatus, type DidSweepStore } from '../persistence/didSweepStore';

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
   * F2 fix (P4i-FIX1, binding): `'prePass'` is the two-sample changing-value
   * pre-pass that runs BEFORE `DID_OBSERVATION_PHASES`' own baseline phase --
   * not one of the fixed phase ids (never fed into `computeDidCandidateSummaries`).
   */
  guidedPhase: DidObservationPhaseId | 'prePass' | null;
  /** Elapsed ms within the CURRENT guided phase (resets to 0 at each phase boundary) -- pairs with `guidedPhaseDurationMs` for an on-screen countdown. */
  guidedPhaseElapsedMs: number;
  /**
   * F2 fix (P4i-FIX1, binding, after Codex P4hrev2c): the ACTUAL duration the
   * current guided phase is running for -- `DID_OBSERVATION_PHASES`' own
   * fixed ~6s `durationMs` when the candidate set is small, or the AUTO-RAISED
   * length (`computeGuidedPhaseDurationMs`) when it's large enough that the
   * fixed 6s would under-sample the tail of the list ("show it": the UI's own
   * countdown must reflect the REAL window, not the fixed spec). `0` before a
   * guided run has started.
   */
  guidedPhaseDurationMs: number;
  /** Live-updated (per sample, and finalized once the guided run ends) ranked candidate summaries -- see `didObservationPhases.ts`'s `computeDidCandidateSummaries`. `[]` before a guided observation has ever run. */
  candidateSummaries: readonly DidCandidateSummary[];
  /**
   * Ticket P4j (binding): mid-size (9-32 byte) block candidates, ranked by
   * WHICH byte offsets changed per phase (`didObservationPhases.ts`'s
   * `computeDidBlockCandidateSummaries`) -- populated alongside
   * `candidateSummaries` once a batched or focused guided run finishes (the
   * ORIGINAL single-pass `startGuidedObservation()` never populates this;
   * mid-size blocks simply are not ranked there). `[]` before either flow has
   * ever run.
   */
  blockCandidateSummaries: readonly DidBlockCandidateSummary[];
  /**
   * Ticket P4j (binding, batched guided observation): "progress 'Batch 3/8'".
   * The 0-based index of the batch currently running (`startBatchedObservation()`),
   * and the total batch count -- both `null` outside a batched run (idle, a
   * legacy single-pass guided run, or a focused-shortlist run, none of which
   * batch).
   */
  batchIndex: number | null;
  batchTotal: number | null;
  /**
   * Ticket P4j-FIX1 H1 (binding, after Codex P4j-REV1 HIGH #1): true while the
   * CURRENT guided phase is still running PAST its nominal
   * `guidedPhaseDurationMs` in order to finish the per-DID sample guarantee.
   * The countdown keeps showing the NOMINAL duration (never silently grows);
   * the UI shows "extending…" off this flag instead. Always `false` outside a
   * running phase.
   */
  guidedPhaseExtending: boolean;
  /**
   * Ticket P4j-FIX1 H1 (binding): DIDs that could NOT reach
   * `minSamplesPerPhase` positive samples in at least one phase of the most
   * recent guided run -- either because they exhausted the per-phase failure
   * budget (3 consecutive misses: NRC/timeout) or the phase hit its hard
   * duration cap first. They are EXCLUDED from ranking (never a
   * brake/steering/throttle candidate on partial evidence) and REPORTED here.
   */
  observationInsufficientDids: readonly number[];
  /** Ticket P4j-FIX1 H1 + coordinator addendum (binding): the subset of {@link observationInsufficientDids} that produced ZERO positive samples in the whole run -- the UI's "no response" (e.g. a typed shortlist DID the ECU answers with an NRC). */
  observationNoResponseDids: readonly number[];
  /** Ticket P4j-FIX1 M3 (binding): DIDs whose observation samples disagreed on response length -- marked inconsistent and routed to NEITHER the numeric nor the block summarizer (never split into two apparently consistent candidates). */
  inconsistentCandidateDids: readonly number[];
  /** Ticket P4j-FIX1 H3 (binding): the id of the most recent observation run on the CURRENT sweep run -- one persisted `observationId` group per guided/batched/focused observation, so a later one APPENDS rather than resetting. `null` before any observation. */
  observationId: string | null;
  /**
   * X1 fix (P4i-FIX3, binding, after Codex P4irev3 R1 PARTIAL): non-null
   * exactly when the MOST RECENT terminal persistence checkpoint (the forced
   * flush at pause/stop/natural-completion) failed to commit -- the sweep's
   * results are still fully intact IN MEMORY (nothing here ever drops a
   * responder/sample), only the on-disk checkpoint is stale/behind. The
   * screen surfaces this as "Save failed -- results kept in memory, share
   * now" (export reads straight from the live controller/memory, never
   * blocked by this). Cleared to `null` by a fresh `start()`/`resumePersistedRun()`,
   * and by any LATER terminal flush that succeeds.
   */
  persistError: string | null;
  /**
   * X1 fix (P4i-FIX3, binding): true from the instant a TERMINAL (forced)
   * flush is issued -- pause/stop/natural-completion -- until it settles
   * (success or failure). The phase itself still flips to its terminal value
   * (`sweepComplete`/`paused`/`stopped`) SYNCHRONOUSLY, at the same instant it
   * always did (existing callers -- including a fresh `start()`/`resumePersistedRun()`
   * mid-flush, `canStart()`'s own set -- are unaffected); this is the
   * ticket's own "(or emit a saving state first)" alternative: "Share is
   * enabled only once persisted or explicitly failed" reads THIS flag (never
   * gates Start/Resume/observation, which must remain immediately available).
   */
  persisting: boolean;
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
  guidedPhaseDurationMs: 0,
  candidateSummaries: [],
  blockCandidateSummaries: [],
  batchIndex: null,
  batchTotal: null,
  guidedPhaseExtending: false,
  observationInsufficientDids: [],
  observationNoResponseDids: [],
  inconsistentCandidateDids: [],
  observationId: null,
  persistError: null,
  persisting: false,
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
  /**
   * Refused (no generation bump, no acquire attempt even) unless idle/complete
   * -- see this module's own doc comment (H1). Acquires the reservation, THEN
   * opens a fresh transport.
   *
   * P4j-FIX2 V2 (binding, after Codex P4j-REV2 MEDIUM #2): a refused first
   * `tryAcquire` reports "adapter in use" IMMEDIATELY, same as ever -- UNLESS
   * the CURRENT holder has itself `markReleasing`'d (its own `stop()`'s
   * close-then-release is already in flight -- exactly a just-superseded
   * controller instance's unmount teardown), in which case this instead
   * awaits `enetAdapterReservation`'s `whenFree()` (bounded by a short race,
   * never indefinitely) and retries once before falling back to the busy
   * report. A caller that never held a pending-release holder sees BYTE-
   * IDENTICAL synchronous behaviour to before this fix.
   */
  start(range?: { from?: number; to?: number; priorityRanges?: readonly DidSweepRange[] }): void;
  /**
   * Stops calling `next()` at the next DID boundary -- phase becomes 'paused'
   * (as soon as the in-flight request notices, same as before). The
   * transport/reservation are NOT touched -- `resume()`/`startObservation()`
   * reuse them.
   *
   * R1 fix (P4i-FIX2, binding, after Codex P4hrev3 H3 PARTIAL): returns a
   * `Promise` that resolves only once THIS pause's own terminal persistence
   * checkpoint has actually committed (or immediately, if there is nothing to
   * persist, or the sweep never reaches 'paused' at all -- e.g. a `stop()`
   * supersedes it first) -- callers that want to know "it's safe now" (the
   * screen shows "Saving…" meanwhile) can `await` it; the phase itself still
   * flips to `'paused'` at the same moment it always did (unchanged for
   * every existing caller that never awaits this).
   *
   * X1 fix (P4i-FIX3, binding, after Codex P4irev3 R1 PARTIAL): the returned
   * promise now REJECTS if that terminal flush fails (never silently
   * swallowed) -- `snapshot.persistError` is also set at the same time so a
   * caller that isn't awaiting this can still show the failure. The 'paused'
   * phase itself still flips synchronously either way -- results stay fully
   * intact in memory (export still works) even when the checkpoint failed.
   */
  pause(): Promise<void>;
  /** Resumes a paused sweep on the SAME transport/reservation/accumulator (no reconnect, no re-acquire, no lost results). */
  resume(): void;
  /**
   * Stops the sweep (or observation) permanently: closes the transport, THEN
   * releases the reservation (H1/H2, binding, strictly in that order, on
   * every path). Idempotent.
   *
   * R1 fix (P4i-FIX2, binding, after Codex P4hrev3 H3 PARTIAL): returns a
   * `Promise` that resolves once this stop's own terminal persistence
   * checkpoint has committed (or immediately if there is nothing to persist).
   * The phase flips to `'stopped'` synchronously, exactly as before --
   * awaiting this is for callers that need the write itself to be durable
   * (e.g. before navigating away) and want to show "Saving…" until then.
   *
   * X1 fix (P4i-FIX3, binding, after Codex P4irev3 R1 PARTIAL): the returned
   * promise now REJECTS if that terminal flush fails (never silently
   * swallowed) -- `snapshot.persistError` is also set at the same time so a
   * caller that isn't awaiting this can still show the failure. Results stay
   * fully intact in memory (export still works from it) even when the
   * checkpoint failed -- only the on-disk copy is behind.
   */
  stop(): Promise<void>;
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
   * Ticket P4j (binding): runs the SAME fixed 4-phase guided re-read
   * batch-by-batch over the WIDENED candidate pool (`filterCandidatePool`:
   * 1-32 bytes, so mid-size blocks join numeric candidates), instead of one
   * pass over every candidate at once -- each batch (default 16 DIDs) gets
   * its own phase duration sized from the run's OWN measured req/s so every
   * DID gets >= `minSamplesPerPhase` (default 5) samples/phase, fixing the
   * noise the old single-pass-over-everything flow produced when the
   * candidate set was large (field evidence: 128 candidates -> 1-2
   * samples/phase). Progress exposes `batchIndex`/`batchTotal` ("Batch
   * 3/8"); ONE continuous connection + keep-alive ticker spans every batch.
   * Same preconditions as `startGuidedObservation()`; no-op with no
   * candidates after filtering.
   */
  startBatchedObservation(options?: { batchSize?: number; minSamplesPerPhase?: number }): void;
  /**
   * Ticket P4j (binding): "the user can tick candidates (or type DIDs) -> one
   * long guided cycle on the shortlist only (>= 10 samples per phase)." Runs
   * the SAME 4-phase cycle over EXACTLY `dids` (deduplicated, no candidate
   * filtering -- a typed DID need not even be a discovered responder), sized
   * for >= 10 samples/phase at the run's measured req/s. Same preconditions
   * as `startGuidedObservation()`; no-op with an empty/invalid `dids` list.
   */
  startFocusedObservation(dids: readonly number[], options?: { minSamplesPerPhase?: number }): void;
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
   *
   * F1 fix (P4i-FIX1, binding, after Codex P4hrev2c) -- THE RESUME BOUND:
   * resuming picks up from `lastDid` as of the LAST successfully COMMITTED
   * flush (`store.flushRunProgress`'s own transaction), never anything more
   * recent -- a real process kill mid-batch-window (up to `FLUSH_INTERVAL_MS`,
   * 1s, or `FLUSH_RESPONDER_COUNT`, 50 responders, whichever came due first)
   * loses only the DIDs visited SINCE that last commit, which are simply
   * re-swept (harmless: `runDidSweep`'s own idempotent DID handling, and the
   * store's upsert semantics dedupe any re-discovered responder). It NEVER
   * re-sends a DID already reflected in that last committed checkpoint --
   * the flush's atomicity (responders + progress in ONE transaction)
   * guarantees `lastDid` and its corresponding responder rows always land
   * together, so a resumed sweep can never see a `lastDid` ahead of the
   * responders actually persisted for it.
   */
  resumePersistedRun(runId: string): Promise<void>;
  /** Every persisted run (most-recently-updated first), for the screen's own "Resume" affordance -- `[]` if `deps.store` is undefined. Delegates straight to the store; never throws. */
  listPersistedRuns(): Promise<DidSweepRunRecord[]>;
  /** The runId THIS controller instance is currently persisting to (set by `start()`/`resumePersistedRun()`), or `null` before any run/without a `store`. The screen's own "Share results" reads the run+responders straight from `deps.store` using this id. */
  getCurrentRunId(): string | null;
  /**
   * F3 fix (P4i-FIX1, binding, after Codex P4hrev2c): "controller exposes
   * `getGuidedSamples()` (per DID, per phase, relative timestamps, raw hex);
   * the screen passes them to `buildDidSweepExportDocument`." Every phase-
   * tagged sample collected by the MOST RECENT guided run (`startGuidedObservation()`),
   * `[]` before any guided run has ever completed at least one sample. The
   * pre-pass's own two reads are NEVER included here (they are not phase-
   * tagged, and exist only to narrow the candidate set BEFORE the phases
   * start) -- only samples from `DID_OBSERVATION_PHASES` itself.
   */
  getGuidedSamples(): readonly DidPhaseSample[];
}

const DEFAULT_OBSERVATION_WINDOW_MS = 60_000;
/** Ticket P4j (binding): "FOCUSED observation ... one long guided cycle on the shortlist only (>= 10 samples per phase)." */
const FOCUSED_MIN_SAMPLES_PER_PHASE = 10;

/**
 * Ticket P4j-FIX1 M1 (binding, after Codex P4j-REV1 MEDIUM #1): "invalid hex
 * tokens shown as an error (not silently dropped)". The screen's own
 * `1234,ZZZZ,5678` case used to start a TWO-DID run without a word about the
 * third token. Pure and exported so it is testable without a React renderer
 * (this app's vitest project has no component-render harness).
 *
 * Accepts comma- and/or whitespace-separated 1-4 digit hex DIDs, each with an
 * optional `0x` prefix, deduplicated in first-seen order. ANY invalid token
 * (or more than {@link MAX_FOCUSED_SHORTLIST_SIZE} valid ones) yields
 * `dids: []` plus a user-facing `error` -- never a partially-honoured list.
 */
export function parseFocusedDidList(text: string): { dids: number[]; error: string | null } {
  const invalid: string[] = [];
  const seen = new Set<number>();
  const dids: number[] = [];
  for (const token of text.split(/[\s,]+/)) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    const compact = trimmed.replace(/^0[Xx]/, '');
    if (!/^[0-9A-Fa-f]{1,4}$/.test(compact)) {
      invalid.push(trimmed);
      continue;
    }
    const value = Number.parseInt(compact, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      invalid.push(trimmed);
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    dids.push(value);
  }
  if (invalid.length > 0) {
    return { dids: [], error: `Not valid hex DIDs (0000-FFFF): ${invalid.join(', ')}` };
  }
  if (dids.length > MAX_FOCUSED_SHORTLIST_SIZE) {
    return { dids: [], error: `Pick at most ${MAX_FOCUSED_SHORTLIST_SIZE} DIDs for a focused run (got ${dids.length}).` };
  }
  return { dids, error: null };
}

/** M1 (binding): clamps a caller-supplied `minSamplesPerPhase` into `[1, MAX_MIN_SAMPLES_PER_PHASE]` -- an absurd value must never create an effectively infinite phase. */
function sanitizeMinSamplesPerPhase(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(MAX_MIN_SAMPLES_PER_PHASE, Math.floor(value));
}

/**
 * Ticket P4j-FIX1 H1 (binding): a phase's ROUND slice -- long enough for one
 * full round-robin pass over the DIDs still needing samples, at the run's
 * measured rate, and never shorter than core `runDidObservation`'s own
 * `targetHz: 1` round budget (a shorter slice would simply be spent waiting).
 */
const PHASE_SLICE_BASE_MS = 1_000;
/** H1 (binding): "a hard cap of 3x the nominal duration ends the phase." */
const PHASE_HARD_CAP_MULTIPLIER = 3;
/** H1 (binding): "a DID that fails (NRC/timeout) 3x in a phase is marked `insufficient` for that phase." A "failure" is one round slice in which the DID produced no new positive sample. */
const PHASE_MAX_CONSECUTIVE_MISSES = 3;

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
  /**
   * Ticket P4j (binding): "phase duration per batch from the MEASURED rate of
   * the sweep run (not the assumed 15)" -- the sweep's own last-observed
   * req/s (mirrors `snapshot.progress.reqPerSec`, updated at every sweep
   * `onProgress` tick), fed to `planObservationBatches` as the measured rate.
   * Falls back to `ASSUMED_GUIDED_REQ_PER_SEC` (via `planObservationBatches`'
   * own default) when no sweep has run yet in this controller instance
   * (e.g. an observation started straight from a resumed/persisted run).
   */
  let lastMeasuredReqPerSec = 0;
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
  /** P4j-FIX2 V2 (binding): the bound on `start()`/`resumePersistedRun()`'s wait for a PENDING release (see `isReleasePending()`) -- comfortably above `TEARDOWN_RACE_MS` so a normal close+release finishes well within it, but never indefinite even if a `markReleasing` call was somehow never followed by a real `release()`. */
  const RESERVATION_WAIT_RACE_MS = 300;

  // -------------------------------------------------------------------
  // Persistence (binding, P4i: results persistence, export & candidate
  // filtering addendum) -- entirely a no-op (every function below is a
  // guarded early-return) when `deps.store` is undefined, so every EXISTING
  // caller/test that doesn't pass one keeps working byte-identically.
  // -------------------------------------------------------------------
  const RETENTION_RUNS = deps.retentionRuns ?? 5;
  /**
   * F1 fix (P4i-FIX1, binding, after Codex P4hrev2c): "batch window ≤ 1 s" (was 2s).
   * R1 fix (P4i-FIX2, binding, after Codex P4hrev3 H3 PARTIAL): this batch
   * window is the ACCEPTED residual noted on the export document itself (see
   * `didSweepExport.ts`'s `DID_SWEEP_RESUME_BOUND`) -- a real, unattended
   * process kill (never touching `stop()`/`pause()` at all) can still lose up
   * to one interval's worth of already-visited DIDs, which are simply
   * re-swept on resume (harmless: idempotent DID handling, upsert semantics).
   * What is NOT accepted, and what `stop()`/`pause()` now fix: THEIR OWN
   * terminal flush being merely enqueued rather than awaited, which could
   * otherwise leave an explicit Stop/Pause's own checkpoint uncommitted
   * indefinitely (not bounded by this interval at all) if the app happened to
   * be killed right after the tap.
   */
  const FLUSH_INTERVAL_MS = 1_000;
  const FLUSH_RESPONDER_COUNT = 50;
  let currentRunId: string | null = null;
  /** Index into `accumulator.responders` up to which persistence has already flushed (or is currently claimed by an in-flight flush) -- only the SLICE past this is claimed by the NEXT flush. Never rolled back on failure (X2/R3 fix, below) -- a later flush's own claim is never re-derived from this. */
  let lastPersistedResponderIndex = 0;
  let lastFlushAtMs = 0;
  /**
   * X2 fix (P4i-FIX3, binding, after Codex P4irev3 R3 PARTIAL): the exact
   * `[fromIndex, toIndex)` slice of `accumulator.responders` a FAILED flush
   * claimed, eligible for exactly ONE retry on the next flush (folded into
   * that flush's own write, then cleared unconditionally -- win or lose,
   * never retried a second time). This is what replaces the pre-fix
   * `Math.min` rollback on `lastPersistedResponderIndex`: that rollback could
   * reset the SHARED marker backwards even after a LATER flush had already
   * validly claimed (and possibly committed) the next slice, causing that
   * later slice to be double-sent (`sample_count` incremented twice) on the
   * following retry. Tracking the failed slice BY ITS OWN INDEX RANGE instead
   * means a later flush's already-claimed (and/or already-committed) range is
   * never touched, never re-derived, and never resent.
   *
   * Y2 fix (P4i-FIX4, binding, after Codex P4irev4 X2 PARTIAL): a LIST, not a
   * single slot -- the pre-fix single `pendingRetrySlice` slot meant a SECOND
   * failed flush (queued behind a first one that ALSO failed, before either
   * got its retry chance) silently overwrote the first slice, losing it
   * forever. Every failed flush's own `[fromIndex, toIndex)` is pushed here;
   * the NEXT flush folds in EVERY entry (each still retried exactly once --
   * the whole list is cleared, unconditionally, the instant it is read here,
   * win or lose for that next attempt).
   */
  let pendingRetrySlices: Array<{ fromIndex: number; toIndex: number }> = [];
  /** Result of one `maybeFlushPersistence` attempt -- NEVER thrown across this module's own API (mirrors every other "never throws" discipline here); `error` is set only when `persisted` is `false`. */
  interface PersistFlushResult {
    persisted: boolean;
    error?: string;
  }
  /**
   * F1 fix (P4i-FIX1, binding, after Codex P4hrev2c): ONE serialized tail --
   * EVERY flush (forced or not) is chained onto this, in order, never
   * dropped. This is what makes a forced stop/complete flush unconditionally
   * land even while a periodic tick's own flush is still in flight (the prior
   * defect: a boolean "one in flight, skip" latch silently discarded a forced
   * flush that happened to race a periodic one).
   */
  let persistenceTail: Promise<PersistFlushResult> = Promise.resolve({ persisted: true });
  /** True while a NON-forced flush is queued/running -- coalesces rapid `onProgress` ticks into whatever is already pending instead of piling up redundant work. A forced flush is NEVER gated by this (always chained). */
  let periodicFlushQueued = false;
  /**
   * R1 fix (P4i-FIX2, binding): resolvers for every outstanding public
   * `pause()` call, waiting on the sweep loop noticing `control.paused` and
   * `finishSweepRun`'s own 'paused' branch committing its terminal flush.
   *
   * X1 fix (P4i-FIX3, binding, after Codex P4irev3 R1 PARTIAL): each entry now
   * carries a `reject` too -- `settlePendingPauses(result)` rejects every
   * outstanding `pause()` when `result.persisted` is `false` (a genuine
   * checkpoint failure), and resolves them (never rejects) when `result` is
   * omitted entirely -- the case where `stop()` supersedes a pause BEFORE the
   * sweep ever reaches 'paused' at all (nothing to report as failed; the
   * pause simply never happened).
   */
  let pendingPauseResolvers: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  function settlePendingPauses(result?: PersistFlushResult): void {
    const resolvers = pendingPauseResolvers;
    pendingPauseResolvers = [];
    for (const r of resolvers) {
      if (result !== undefined && !result.persisted) {
        r.reject(new Error(result.error !== undefined ? `Save failed -- results kept in memory: ${result.error}` : 'Save failed -- results kept in memory'));
      } else {
        r.resolve();
      }
    }
  }

  /**
   * Y1 fix (P4i-FIX4, binding, after Codex P4irev4 X1 PARTIAL): count of
   * terminal ("tracked") flushes -- pause's own, natural-completion/stop's
   * own -- still outstanding for the CURRENT run. The pre-fix bug: `pause()`'s
   * flush (A) and a LATER natural-completion flush (B, queued after a
   * `resume()` that never changes `generation`) each independently emitted
   * `persisting: false` the instant THEIR OWN flush settled, so A settling
   * first flipped `persisting` to false while B was still in flight -- Share
   * became enabled mid-save. `beginTrackedFlush`/`endTrackedFlush` bracket
   * every one of those three call sites; `persisting` only ever reads back as
   * false once the count has drained to zero, however many are stacked up.
   */
  let pendingFlushCount = 0;

  function beginTrackedFlush(): void {
    pendingFlushCount += 1;
  }

  /** Decrements the tracked count and (if `myGeneration` is still current) emits `persisting`/`persistError` from THIS flush's own settled result -- `persisting` reflects whether any OTHER tracked flush is still outstanding, never just this one. */
  function endTrackedFlush(myGeneration: number, result: PersistFlushResult): void {
    pendingFlushCount = Math.max(0, pendingFlushCount - 1);
    if (myGeneration !== generation) return;
    emit({ persisting: pendingFlushCount > 0, persistError: result.persisted ? null : (result.error ?? 'Save failed -- results kept in memory') });
  }

  function nowIso(): string {
    return new Date().toISOString();
  }

  function currentNrcCountsAsStrings(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [nrc, count] of Object.entries(accumulator?.nrcCounts ?? {})) out[nrc] = count;
    return out;
  }

  /**
   * F1 fix (P4i-FIX1, binding, after Codex P4hrev2c): batched incremental
   * persistence -- QUEUED (never fire-and-forget dropped), RUN-SCOPED (every
   * flush captures its own `runId`/responder slice/patch snapshot up front,
   * so a run that changed by the time this flush actually executes can never
   * corrupt a DIFFERENT run's bookkeeping), and ATOMIC (`store.flushRunProgress`
   * writes the responders AND the progress patch in ONE transaction).
   *
   * Called on every sweep `onProgress` tick (`force: false`) and at every
   * phase boundary -- pause/stop/complete (`force: true`). A forced flush is
   * ALWAYS chained onto `persistenceTail` (queued after whatever is currently
   * running, never skipped); a non-forced tick coalesces into whatever is
   * already queued/running via `periodicFlushQueued` rather than piling up
   * redundant work, but still queues immediately once that one settles if
   * another became due in the meantime -- the LAST persisted state is never
   * more than one flush interval stale.
   *
   * R1 fix (P4i-FIX2, binding): returns the QUEUED flush's own `Promise` (or
   * an already-resolved one when nothing is due/persistence is disabled) so
   * `stop()`/`pause()`/`finishSweepRun`/`finishObservation` can await their
   * OWN terminal checkpoint landing, instead of firing-and-forgetting it.
   *
   * R3 fix (P4i-FIX2, binding, after Codex P4hrev3 NEW MEDIUM "queued flushes
   * can double-count responder samples"): `lastPersistedResponderIndex`
   * advances HERE, synchronously, at SNAPSHOT time -- not after the write
   * settles. The pre-fix bug: a forced flush queued WHILE an earlier
   * (periodic) flush's write was still in flight re-sliced
   * `accumulator.responders` from the SAME stale index (since the earlier
   * flush hadn't advanced it yet), re-sending the identical responder(s) a
   * second time (`sample_count` incremented again). Advancing the marker
   * immediately means ANY later flush call -- forced or not, however many are
   * still in-flight -- always slices from AFTER what this one already
   * claimed.
   *
   * X2 fix (P4i-FIX3, binding, after Codex P4irev3 R3 PARTIAL): a FAILED
   * write no longer rolls `lastPersistedResponderIndex` back at all (the
   * pre-fix `Math.min` bug: rolling the SHARED marker backwards could undo a
   * LATER flush's already-valid claim on the next slice, causing that later
   * slice to be resent -- and double-counted -- on the following retry
   * instead). Failure instead records the exact `[fromIndex, toIndex)` this
   * call itself claimed as `pendingRetrySlice`, folded into the NEXT flush's
   * own write (whichever runs next, forced or periodic) and cleared right
   * then -- retried exactly once, win or lose; a later flush's own
   * (disjoint, already-claimed) slice is never touched or re-derived.
   */
  function maybeFlushPersistence(force: boolean, status: DidSweepRunStatus): Promise<PersistFlushResult> {
    if (deps.store === undefined || currentRunId === null || accumulator === null) return Promise.resolve({ persisted: true });
    const now = deps.clock.now();
    const ownFromIndex = lastPersistedResponderIndex;
    const newResponders = accumulator.responders.slice(ownFromIndex);
    const dueByTime = now - lastFlushAtMs >= FLUSH_INTERVAL_MS;
    const dueByCount = newResponders.length >= FLUSH_RESPONDER_COUNT;
    const dueByRetry = pendingRetrySlices.length > 0; // X2 fix: a slice awaiting its one retry is never left stuck behind an otherwise-quiet periodic check.
    if (!force && !dueByTime && !dueByCount && !dueByRetry) return Promise.resolve({ persisted: true });
    if (!force) {
      if (periodicFlushQueued) return persistenceTail; // already one queued/running -- it (or the next due tick after it) will catch up.
      periodicFlushQueued = true;
    }

    // Snapshot EVERYTHING this flush will write, right now -- never read
    // `currentRunId`/`accumulator`/`plan` again once this async flush is
    // actually running (by then a NEW run may have started and reassigned
    // every one of those).
    const store = deps.store;
    const runId = currentRunId;
    const flushedThroughIndex = accumulator.responders.length;
    // X2/Y2 fix (binding): fold in EVERY prior failed slice's own responders
    // (each one's own retry attempt) BEFORE this call's own new range -- a gap
    // of ALREADY-COMMITTED responders between a retry slice and `ownFromIndex`
    // (claimed and persisted by an intervening flush) is correctly excluded,
    // never resent. Y2 fix (P4i-FIX4, binding): a LIST, not a single slot -- a
    // second failed flush queued behind a first (neither yet retried) no
    // longer overwrites the first's own slice; ALL outstanding slices are
    // folded into this one attempt, in order.
    const retrySlices = pendingRetrySlices;
    pendingRetrySlices = []; // consumed by THIS attempt regardless of outcome -- each retried at most once.
    const retryResponders = retrySlices.flatMap((slice) => accumulator!.responders.slice(slice.fromIndex, slice.toIndex));
    const respondersToWrite = [...retryResponders, ...newResponders].map((r) => ({ did: r.did, raw: r.raw, rttMs: r.rttMs }));
    // R3 fix (binding): advance NOW, before the write even starts -- unchanged
    // for the NEW range (see this function's own doc comment); never rolled
    // back on failure (X2 fix, above).
    if (newResponders.length > 0) lastPersistedResponderIndex = flushedThroughIndex;
    const patch: DidSweepRunProgressPatch = {
      status,
      lastDid: accumulator.lastDid,
      visitedCount: plan?.visitedCount ?? 0,
      timeoutCount: accumulator.timeouts,
      unmatchedCount: accumulator.unmatched,
      errorCount: accumulator.errors,
      nrcCounts: currentNrcCountsAsStrings(),
    };
    const flushNowIso = nowIso();

    const runOneFlush = async (): Promise<PersistFlushResult> => {
      try {
        await store.flushRunProgress(runId, respondersToWrite, patch, flushNowIso);
        // Only advance the SHARED bookkeeping if `currentRunId` is STILL this
        // run -- a superseding `start()`/`resumePersistedRun()` already reset
        // both to ITS OWN state, which this (now-stale) flush must never
        // overwrite (the exact REV finding: "a quick new Start ... lets that
        // old flush ... overwrite lastPersistedResponderIndex").
        if (currentRunId === runId) lastFlushAtMs = deps.clock.now();
        return { persisted: true };
      } catch (error) {
        // X1/X2/Y2 fix (binding): the failure is NEVER swallowed silently --
        // `persisted: false` propagates to every awaiter (`stop()`/`pause()`/
        // `finishSweepRun`), and exactly THIS call's own new range (if any) is
        // PUSHED for one retry -- never overwriting any OTHER slice still
        // awaiting its own retry (Y2 fix: a list, not a single shared slot).
        if (currentRunId === runId && newResponders.length > 0) {
          pendingRetrySlices.push({ fromIndex: ownFromIndex, toIndex: flushedThroughIndex });
        }
        return { persisted: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        if (!force) periodicFlushQueued = false;
      }
    };
    // Queued, never dropped: chained after whatever is currently in flight,
    // regardless of that prior flush's own outcome.
    const chained = persistenceTail.then(runOneFlush, runOneFlush);
    persistenceTail = chained;
    return chained;
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
        const reqPerSec = requestsIssued / elapsedS;
        // Ticket P4j (binding): the LATEST measured sweep rate -- fed to
        // `planObservationBatches` for the batched guided flow, rather than
        // its own assumed fallback.
        lastMeasuredReqPerSec = reqPerSec;
        emit({
          responders: accumulator!.responders,
          nrcCounts: accumulator!.nrcCounts,
          timeouts: accumulator!.timeouts,
          unmatched: accumulator!.unmatched,
          progress: { did: progress.did, index: progress.index, total: progress.total, reqPerSec },
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
   *
   * R1 fix (P4i-FIX2, binding): the phase transition itself still emits
   * SYNCHRONOUSLY, at the exact same point it always did (existing callers
   * that read the snapshot right after a bounded timer advance are
   * unaffected) -- but this function's OWN completion now additionally
   * awaits that terminal flush landing before it returns, and (for the
   * 'paused' branch) resolves any outstanding public `pause()` promise only
   * once it has. "Complete must await the terminal flush" (binding): a
   * natural completion's own async chain is not considered done until the
   * checkpoint commits, even though the visible phase already flipped.
   *
   * X1 fix (P4i-FIX3, binding, after Codex P4irev3 R1 PARTIAL): the NATURAL
   * completion/stop branch below now emits its own terminal phase (`'sweepComplete'`/
   * `'stopped'`) only AFTER that flush settles -- never before -- so nothing
   * (Share, a fresh `start()`) can observe "done" while the checkpoint backing
   * it is still in flight. `persistError` is set on the SAME emit, from the
   * settled result, so a failure is visible the instant the phase appears
   * (never a silent, unreported gap). The `'paused'` branch's phase flip stays
   * SYNCHRONOUS (existing callers rely on it) -- `persistError` there is
   * updated in a second, immediate follow-up emit once the flush settles.
   *
   * Y1 fix (P4i-FIX4, binding, after Codex P4irev4 X1 PARTIAL): both branches
   * now bracket their own flush with `beginTrackedFlush()`/`endTrackedFlush()`
   * instead of unconditionally emitting `persisting: false` the instant THEIR
   * OWN flush settles -- a pause's flush (A) settling while a LATER,
   * Resume-then-natural-completion flush (B, same `generation` -- `resume()`
   * never bumps it) is still in flight no longer flips `persisting` back to
   * false out from under B.
   */
  async function finishSweepRun(myGeneration: number, outcome: SweepOutcome): Promise<void> {
    if (myGeneration !== generation) return; // stop() already handled teardown/release.
    if (outcome === 'paused') {
      beginTrackedFlush();
      const flushPromise = maybeFlushPersistence(true, 'paused');
      emit({ phase: 'paused', persisting: true });
      const result = await flushPromise;
      endTrackedFlush(myGeneration, result);
      settlePendingPauses(result);
      return; // transport/reservation stay held -- resume() continues on the SAME channel.
    }
    await teardownActiveTransport();
    if (myGeneration !== generation) return; // stop() raced in while close was settling -- it owns the final phase.
    // X1 fix (P4i-FIX3, binding): the phase flip + release stay SYNCHRONOUS
    // here (unchanged for every existing caller, INCLUDING a fresh `start()`
    // that re-acquires the reservation while this SAME flush is still in
    // flight -- `canStart()`'s own terminal set must open back up immediately,
    // never gated on persistence) -- `persisting`/`persistError` instead
    // surface the checkpoint's own outcome once it settles, satisfying "emit a
    // saving state first" (the ticket's own alternative to delaying the
    // phase itself).
    beginTrackedFlush();
    const flushPromise = maybeFlushPersistence(true, outcome === 'complete' ? 'complete' : 'stopped');
    emit({ phase: outcome === 'complete' ? 'sweepComplete' : 'stopped', persisting: true });
    releaseReservation();
    const result = await flushPromise;
    endTrackedFlush(myGeneration, result);
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

  /** Accumulates every phase's samples for the CURRENT guided run -- reset at the start of `runGuidedObservationOnChannel`, read by `computeDidCandidateSummaries` both live (after each sample) and at the end. NEVER includes the pre-pass' own two reads (see `runChangingValuePrePass`) -- only `DID_OBSERVATION_PHASES`-tagged samples (F3: exactly what `getGuidedSamples()` hands the export builder). */
  let guidedSamples: DidPhaseSample[] = [];
  /**
   * R2 fix (P4i-FIX2, binding, after Codex P4hrev3 NEW MEDIUM "guided export
   * samples leak across runs"): the `currentRunId` (or `null` if persistence
   * is disabled) `guidedSamples` above ACTUALLY belongs to. Reset alongside
   * `guidedSamples` every time it is cleared (a fresh `start()`, a resumed
   * run, or a NEW guided run) -- `getGuidedSamples()` returns `[]` whenever
   * this no longer matches `currentRunId`, so a run that never ran its own
   * guided observation can never surface a PRIOR run's series in its export
   * (the exact scenario: run A completes guided observation; run B is
   * started and shared without running guided observation -- run B's export
   * must show an EMPTY series, never run A's).
   */
  let guidedSamplesRunId: string | null = null;

  /**
   * Ticket P4j-FIX1 H3 (binding): the `observationId` the CURRENT observation
   * run persists under. A new one per `startGuidedObservation()` /
   * `startBatchedObservation()` / `startFocusedObservation()`, so a later
   * observation on the SAME sweep run APPENDS a new group to the store rather
   * than resetting what the earlier one recorded (the pre-fix
   * `resetGuidedSamples()` destroyed the earlier batched series before export
   * could ever see it).
   */
  let currentObservationId: string | null = null;
  /**
   * Ticket P4j-FIX1 M2 (binding): a `pause()` requested while a BATCHED
   * observation is running. Honoured at the next batch boundary (never
   * mid-batch -- a half-observed batch would leave its DIDs short of the
   * sample guarantee); `resume()` clears it and releases the waiters.
   */
  let observationPauseRequested = false;
  let observationResumeWaiters: Array<() => void> = [];
  /** Resolvers for the `pause()` promise(s) outstanding on a BATCHED observation -- settled once the pause has actually taken effect AND its sample checkpoint has been written. */
  let pendingObservationPauseResolvers: Array<() => void> = [];
  /** H3 (binding): index into `guidedSamples` up to which persistence has already appended -- only the slice past this is written at each checkpoint. */
  let persistedSampleIndex = 0;
  /** H1 (binding): per-DID, per-phase POSITIVE sample counts for the current observation run -- keyed `did:phase`. Ticket P4k (binding): counts only NON-settling samples (see {@link isSettlingSample}) -- a phase's own count guarantee must be met by samples taken AFTER the settle window, never by the settling ones alone. */
  let phaseSampleCounts = new Map<string, number>();
  /** Ticket P4k (binding): per-DID, per-phase count of EVERY positive sample (settling included) -- used ONLY to detect whether a slice's round-robin pass reached a DID at all (see `runCountGuaranteedPhase`'s miss-budget check). A genuine response that happens to land inside the settle window must reset the miss counter same as any other -- it is not a timeout, only not-yet-countable. */
  let phaseResponseCounts = new Map<string, number>();
  /** H1 (binding): DIDs that exhausted the failure budget / hit the phase hard cap in at least one phase of the current run. */
  let insufficientDids = new Set<number>();

  function resetGuidedSamples(): void {
    guidedSamples = [];
    guidedSamplesRunId = currentRunId;
    persistedSampleIndex = 0;
    phaseSampleCounts = new Map();
    phaseResponseCounts = new Map();
    insufficientDids = new Set();
    // H3 (binding): a fresh `start()`/`resumePersistedRun()` must not leave a
    // PRIOR run's `observationId` addressable -- the next observation mints
    // its own (see `beginObservationRun`).
    currentObservationId = null;
  }

  function beginObservationRun(): void {
    resetGuidedSamples();
    currentObservationId = `obs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    emit({ observationId: currentObservationId });
  }

  /**
   * H3 (binding): appends every guided sample collected since the last
   * checkpoint to the store, under this observation's own `observationId`.
   * Best-effort (a failed write never affects the live run -- same discipline
   * as `maybeFlushPersistence`), and a no-op without a store.
   */
  async function persistObservationSamples(): Promise<void> {
    const store = deps.store;
    const runId = currentRunId;
    const observationId = currentObservationId;
    if (store === undefined || runId === null || observationId === null) return;
    const pending = guidedSamples.slice(persistedSampleIndex);
    if (pending.length === 0) return;
    persistedSampleIndex = guidedSamples.length;
    try {
      await store.appendObservationSamples(runId, observationId, pending);
    } catch {
      // Results stay fully intact in memory; only the on-disk copy is behind.
    }
  }

  /**
   * M2 (binding): parks the batched sequence at a batch boundary until
   * `resume()` (or a `stop()` / `stopGuidedObservationEarly()`). The samples
   * collected so far are checkpointed to the store FIRST, so the pause is a
   * genuinely durable state, then the phase flips to `'paused'` and any
   * outstanding `pause()` promise resolves.
   */
  async function pauseAtBatchBoundary(myGeneration: number): Promise<void> {
    await persistObservationSamples();
    if (myGeneration !== generation || observationControl.stopped) {
      observationPauseRequested = false;
      settleObservationPauses();
      return;
    }
    emit({ phase: 'paused', guidedPhase: null, guidedPhaseExtending: false });
    settleObservationPauses();
    await new Promise<void>((resolve) => {
      observationResumeWaiters.push(resolve);
    });
  }

  function settleObservationPauses(): void {
    const resolvers = pendingObservationPauseResolvers;
    pendingObservationPauseResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  function releaseObservationPause(): void {
    observationPauseRequested = false;
    const waiters = observationResumeWaiters;
    observationResumeWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** H3 (binding): "summaries JSON on the run" -- one blob per observation, written at the classify tail so a kill/reopen Share still reports what the observation concluded. */
  async function persistObservationSummary(summary: unknown): Promise<void> {
    const store = deps.store;
    const runId = currentRunId;
    const observationId = currentObservationId;
    if (store === undefined || runId === null || observationId === null) return;
    try {
      await store.saveObservationSummary(runId, observationId, JSON.stringify(summary), nowIso());
    } catch {
      // Best-effort, same as above.
    }
  }

  // -------------------------------------------------------------------
  // F4 fix (P4i-FIX1, binding, after Codex P4hrev2c MEDIUM finding): "one
  // TesterPresent ticker across the pre-pass and all phases ... never > 2s
  // between keep-alives at phase boundaries." Each phase (and the pre-pass'
  // own two rounds) still runs its OWN `runDidObservation` call -- which owns
  // ITS OWN internal 2s keep-alive ticker for the duration of THAT one call --
  // but that internal ticker resets at every call boundary, leaving up to
  // ~2 * keepAliveIntervalMs between the last keep-alive of one call and the
  // first of the next. This controller-owned ticker runs continuously across
  // the ENTIRE guided sequence (started once the channel opens, stopped once
  // it's torn down), sending its own whitelisted TesterPresent well inside
  // the 2s deadline regardless of phase boundaries -- redundant with core's
  // own per-call ticker (harmless: extra keep-alives are always safe), but
  // the ONLY one that survives the transition between calls.
  // -------------------------------------------------------------------
  const GUIDED_KEEPALIVE_INTERVAL_MS = 1_500;
  let guidedKeepAliveTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * R5 fix (P4i-FIX2, binding, after Codex P4hrev3 NEW MEDIUM "the continuous
   * keep-alive ticker can produce an unhandled rejection"): `channel.keepAlive`
   * is ASYNC -- a synchronous `try/catch` around a bare (fire-and-forget)
   * `void channel.keepAlive(pdu)` call can never contain a REJECTION (only a
   * synchronous throw, which `keepAlive` never does per the sweep transport
   * contract), so a transport send failure became an unhandled rejection.
   * Wrapping the call itself in `Promise.resolve().then(...)` normalizes BOTH
   * a synchronous throw and an async rejection into the SAME rejected
   * promise, which `.catch(onGuidedKeepAliveFailure)` below always contains.
   */
  function sendGuidedKeepAlive(channel: SweepTransport): Promise<void> {
    return Promise.resolve().then(() => {
      const pdu = buildTesterPresentRequest();
      assertAllowedRequest(pdu);
      return channel.keepAlive(pdu);
    });
  }

  /**
   * R5 fix (binding): a keep-alive failure is NOT swallowed -- it ends the
   * guided sequence with a VISIBLE error (the ticket's own wording) and lets
   * the already-running `runDidObservation` call notice `observationControl.stopped`
   * at its own next boundary, which reaches `runGuidedObservationOnChannel`'s
   * normal close-then-release tail (same discipline as `stopGuidedObservationEarly()`)
   * -- never a second, ad-hoc teardown path here.
   */
  function onGuidedKeepAliveFailure(myGeneration: number, error: unknown): void {
    if (myGeneration !== generation) return; // already superseded (a full stop()) -- that call owns teardown/release/the final phase.
    observationControl.stopped = true;
    emit({ error: `DID sweep keep-alive failed -- ending the guided observation: ${error instanceof Error ? error.message : String(error)}` });
  }

  function startGuidedKeepAliveTicker(myGeneration: number, channel: SweepTransport): void {
    stopGuidedKeepAliveTicker();
    guidedKeepAliveTimer = setInterval(() => {
      void sendGuidedKeepAlive(channel).catch((error) => onGuidedKeepAliveFailure(myGeneration, error));
    }, GUIDED_KEEPALIVE_INTERVAL_MS);
  }

  function stopGuidedKeepAliveTicker(): void {
    if (guidedKeepAliveTimer !== null) {
      clearInterval(guidedKeepAliveTimer);
      guidedKeepAliveTimer = null;
    }
  }

  /**
   * F2 fix (P4i-FIX1, binding, after Codex P4hrev2c HIGH finding #4): runs
   * `dids` round-robin for ONE pass (sized via `computeGuidedPhaseDurationMs`
   * with `minSamplesPerCandidate: 1`), returning the LAST correlated sample
   * per DID (a DID that never answered within the pass is simply absent from
   * the returned map).
   *
   * R6 fix (P4i-FIX2, binding, after Codex P4hrev3 NEW MEDIUM "the new
   * pre-pass countdown is materially wrong"): `baseElapsedMs` shifts every
   * `onSample` tick's own relative `tMs` (which restarts at 0 for THIS round)
   * into the pre-pass' OVERALL elapsed time -- 0 for the first round, this
   * round's own duration + the gap for the second -- so the snapshot's
   * `guidedPhaseElapsedMs` genuinely advances across the WHOLE pre-pass
   * (round -> gap -> round), never staying frozen.
   *
   * X3 fix (P4i-FIX3, binding, after Codex P4irev3 R6 PARTIAL): a WALL-CLOCK
   * ticker (`ELAPSED_TICKER_INTERVAL_MS`) now runs alongside this round's own
   * `runDidObservation` call, independent of `onSample` -- so the countdown
   * still reaches this round's own duration even when NOTHING answers (every
   * candidate times out). `onSample` can still report finer-grained progress
   * in between ticks; the two are combined via a monotonic "never regress"
   * guard (`bumpElapsed`) so neither can un-advance what the other already
   * showed.
   */
  async function sampleOnceRoundRobin(
    myGeneration: number,
    channel: SweepTransport,
    dids: readonly number[],
    baseElapsedMs: number,
  ): Promise<Map<number, Uint8Array>> {
    const samples = new Map<number, Uint8Array>();
    if (dids.length === 0) return samples;
    const durationMs = computeGuidedPhaseDurationMs(dids.length, PRE_PASS_ROUND_BASE_MS, undefined, 1);
    let highestElapsedMs = 0;
    const bumpElapsed = (ms: number): void => {
      if (myGeneration !== generation || ms <= highestElapsedMs) return;
      highestElapsedMs = ms;
      emit({ guidedPhaseElapsedMs: baseElapsedMs + ms });
    };
    const tickerStartedAtMs = deps.clock.now();
    const ticker = setInterval(() => {
      bumpElapsed(Math.min(durationMs, deps.clock.now() - tickerStartedAtMs));
    }, ELAPSED_TICKER_INTERVAL_MS);
    try {
      await runDidObservation({
        responders: dids,
        transport: channel,
        clock: deps.clock,
        durationMs,
        pacing: deps.pacing,
        control: observationControl,
        requestTimeoutMs: deps.requestTimeoutMs,
        maxResponsePendingExtensions: deps.maxResponsePendingExtensions,
        onSample: (did, raw, tMs) => {
          if (myGeneration !== generation) return;
          samples.set(did, raw);
          bumpElapsed(tMs);
        },
      });
    } finally {
      clearInterval(ticker);
    }
    return samples;
  }

  const PRE_PASS_ROUND_BASE_MS = 2_000;
  /** "each candidate read twice ~2s apart" (addendum). */
  const PRE_PASS_GAP_MS = 2_000;
  /**
   * R6 fix (binding): how often the gap-wait ticks `guidedPhaseElapsedMs`
   * forward -- fine enough that a 1s-stepped fake-timer test still observes
   * intermediate progress. X3 fix (P4i-FIX3, binding): also the shared
   * wall-clock tick rate for `sampleOnceRoundRobin`'s and `runGuidedPhase`'s
   * own tickers (the ticket's own "wall-clock ticker (250 ms)").
   */
  const ELAPSED_TICKER_INTERVAL_MS = 250;

  /**
   * R6 fix (P4i-FIX2, binding): advances `guidedPhaseElapsedMs` (relative to
   * the pre-pass' own start, via `baseElapsedMs`) through the dead gap
   * between the two rounds -- there are no samples during this wait, so
   * nothing else would otherwise move the countdown forward. Waits the FULL
   * `durationMs` regardless of `stop()`/`stopGuidedObservationEarly()` (same
   * discipline the pre-fix `waitMs` already had here -- both flags are
   * re-checked by the CALLER immediately after this resolves); bounded
   * (`PRE_PASS_GAP_MS`, 2s), so this never hangs.
   */
  function waitWithElapsedTicking(myGeneration: number, baseElapsedMs: number, durationMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const startedAtMs = deps.clock.now();
      const timer = setInterval(() => {
        const elapsedInGap = Math.min(durationMs, deps.clock.now() - startedAtMs);
        if (myGeneration === generation) emit({ guidedPhaseElapsedMs: baseElapsedMs + elapsedInGap });
        if (elapsedInGap >= durationMs) {
          clearInterval(timer);
          resolve();
        }
      }, ELAPSED_TICKER_INTERVAL_MS);
    });
  }

  /**
   * F2 fix (P4i-FIX1, binding): "integrate the binding two-sample changing-
   * value pre-pass: before the guided phases, read every filtered candidate
   * twice (~2s apart, user prompted 'blip throttle / press brake / turn
   * wheel') and keep changed-or-plausible DIDs (`selectChangingCandidates` --
   * now with a production caller)." A DID that never answered in EITHER round
   * (no pair to compare) is simply excluded -- still kept in the full export
   * (the responders table), just never fed to the guided phases.
   *
   * R6 fix (P4i-FIX2, binding): the emitted `guidedPhaseDurationMs` is now the
   * REAL total window -- one round's own (candidate-count-scaled) duration
   * counted twice, plus the fixed gap (`computeChangingValuePrePassDurationMs`,
   * the SAME formula `sampleOnceRoundRobin` itself sizes each round with) --
   * never the old fixed `2000`ms regardless of how long the pre-pass actually
   * runs. `guidedPhaseElapsedMs` now advances continuously across BOTH rounds
   * and the gap between them, matching that total.
   */
  async function runChangingValuePrePass(myGeneration: number, channel: SweepTransport, candidateDids: readonly number[]): Promise<number[]> {
    if (candidateDids.length === 0) return [];
    const roundDurationMs = computeGuidedPhaseDurationMs(candidateDids.length, PRE_PASS_ROUND_BASE_MS, undefined, 1);
    const totalDurationMs = computeChangingValuePrePassDurationMs(candidateDids.length, PRE_PASS_ROUND_BASE_MS, PRE_PASS_GAP_MS);
    emit({ guidedPhase: 'prePass', guidedPhaseElapsedMs: 0, guidedPhaseDurationMs: totalDurationMs });
    const firstRound = await sampleOnceRoundRobin(myGeneration, channel, candidateDids, 0);
    if (myGeneration !== generation || observationControl.stopped) return [...candidateDids];
    await waitWithElapsedTicking(myGeneration, roundDurationMs, PRE_PASS_GAP_MS);
    if (myGeneration !== generation || observationControl.stopped) return [...candidateDids];
    const secondRound = await sampleOnceRoundRobin(myGeneration, channel, candidateDids, roundDurationMs + PRE_PASS_GAP_MS);

    const pairs: DidChangeSamplePair[] = [];
    for (const did of candidateDids) {
      const first = firstRound.get(did);
      const second = secondRound.get(did);
      if (first !== undefined && second !== undefined) pairs.push({ did, first, second });
    }
    // Coordinator addendum to P4j-FIX1 (binding, from field evidence): the
    // pre-pass is ADVISORY -- it ORDERS candidates (changed-first) and NEVER
    // excludes one. In the user's own guided run, DME 0x4A1D (brake booster),
    // 0x4811/0x4812 (accelerator) answered the sweep but never reached the
    // phases at all, because the pre-pass ran before the "press the brake"
    // prompt and dropped them as static. A pre-pass cannot know what the
    // guided phases exist to find.
    return orderChangingCandidatesFirst(pairs, candidateDids);
  }

  interface GuidedPhaseRunResult {
    nextResponderIndex: number;
  }

  /**
   * Ticket P4j (binding): `durationMs`/`batchIndex` let the BATCHED
   * (`startBatchedObservation`) and FOCUSED (`startFocusedObservation`)
   * flows reuse this SAME per-phase runner instead of re-implementing the
   * ticker/keep-alive/sample-tagging plumbing -- `durationMs` overrides the
   * legacy auto-raise-from-candidate-count sizing (the caller already sized
   * it, from a batch plan or a focused-shortlist calculation); `batchIndex`
   * (when given) tags every sample this phase collects, so the export can
   * report which batch a DID's series belongs to.
   */
  interface RunGuidedPhaseOptions {
    durationMs?: number;
    batchIndex?: number;
    /**
     * Ticket P4j-FIX1 H1 (binding): when set, this phase is COUNT-guaranteed --
     * it keeps running round-robin slices until EVERY DID has at least this
     * many POSITIVE samples, bounded by the failure budget and the hard cap
     * (see {@link runCountGuaranteedPhase}). When omitted, the phase is the
     * legacy fixed-duration window (byte-identical behaviour for
     * `startGuidedObservation()`'s own phases).
     */
    minSamplesPerPhase?: number;
  }

  function phaseCountKey(did: number, phase: DidObservationPhaseId): string {
    return `${did}:${phase}`;
  }

  /**
   * Ticket P4j-FIX1 H1 (binding, after Codex P4j-REV1 HIGH #1: "The '>= 5
   * samples per DID per phase' guarantee is not enforced" -- the pre-fix code
   * converted the aggregate request rate into a FIXED window, so one DID
   * timing out on every visit could finish the phase with zero samples).
   *
   * This runs the phase as a sequence of round SLICES, each sized for one full
   * round-robin pass over the DIDs that still need samples, and stops only
   * when one of three bounded conditions holds:
   *   1. every DID has `minSamplesPerPhase` POSITIVE samples;
   *   2. a DID missed {@link PHASE_MAX_CONSECUTIVE_MISSES} slices in a row
   *      (NRC/timeout) -- it is marked `insufficient` for this phase, dropped
   *      from the remaining slices, reported, and EXCLUDED from ranking;
   *   3. the phase reached {@link PHASE_HARD_CAP_MULTIPLIER}x its nominal
   *      duration -- every DID still short is marked `insufficient`.
   * The countdown keeps advertising the NOMINAL duration; `guidedPhaseExtending`
   * says when the phase is running past it.
   */
  async function runCountGuaranteedPhase(
    myGeneration: number,
    channel: SweepTransport,
    phase: (typeof DID_OBSERVATION_PHASES)[number],
    responders: readonly number[],
    nominalMs: number,
    minSamplesPerPhase: number,
    batchIndex: number | undefined,
  ): Promise<GuidedPhaseRunResult> {
    emit({ guidedPhase: phase.id, guidedPhaseElapsedMs: 0, guidedPhaseDurationMs: nominalMs, guidedPhaseExtending: false });
    if (responders.length === 0) return { nextResponderIndex: 0 };

    const hardCapMs = nominalMs * PHASE_HARD_CAP_MULTIPLIER;
    const phaseStartedAtMs = deps.clock.now();
    const misses = new Map<number, number>();
    let order: number[] = [...responders];
    let nextResponderIndex = 0;
    let highestElapsedMs = 0;
    let extending = false;

    const ticker = setInterval(() => {
      if (myGeneration !== generation) return;
      const rawElapsed = deps.clock.now() - phaseStartedAtMs;
      const shown = Math.min(nominalMs, rawElapsed);
      const nowExtending = rawElapsed > nominalMs;
      if (shown <= highestElapsedMs && nowExtending === extending) return;
      if (shown > highestElapsedMs) highestElapsedMs = shown;
      extending = nowExtending;
      emit({ guidedPhaseElapsedMs: highestElapsedMs, guidedPhaseExtending: extending });
    }, ELAPSED_TICKER_INTERVAL_MS);

    const stillShort = (did: number): boolean =>
      (phaseSampleCounts.get(phaseCountKey(did, phase.id)) ?? 0) < minSamplesPerPhase &&
      (misses.get(did) ?? 0) < PHASE_MAX_CONSECUTIVE_MISSES;

    try {
      for (;;) {
        if (myGeneration !== generation || observationControl.stopped) break;
        const pending = order.filter(stillShort);
        if (pending.length === 0) break;
        // K1 fix (P4k-FIX1, binding, after Codex P4k-REV1 MEDIUM #1: "the 3x
        // hard cap is checked only before launching a full slice -- the
        // final slice can overrun the cap"): the remaining budget is
        // computed HERE, once, and used both to break (when exhausted) and
        // to CLAMP the slice actually run -- a full-length slice can no
        // longer carry the phase past `hardCapMs`, however large the
        // candidate-count/rate formula below sizes it.
        const remainingHardCapMs = hardCapMs - (deps.clock.now() - phaseStartedAtMs);
        if (remainingHardCapMs <= 0) break; // (3) hard cap.

        const sliceMs = Math.min(
          computeGuidedPhaseDurationMs(
            pending.length,
            PHASE_SLICE_BASE_MS,
            lastMeasuredReqPerSec || undefined,
            1,
          ),
          remainingHardCapMs,
        );
        // Ticket P4k (binding): the miss/no-miss check uses `phaseResponseCounts`
        // (every positive sample, settling included) -- a response that lands
        // inside the settle window is still a RESPONSE, never a timeout.
        const before = new Map(pending.map((did) => [did, phaseResponseCounts.get(phaseCountKey(did, phase.id)) ?? 0]));
        // V5 (binding): how far into this WHOLE phase (not this slice) we
        // are right now -- added to every sample this slice collects so
        // exported timestamps stay monotone across every slice, not just
        // within one.
        const phaseElapsedAtSliceStartMs = deps.clock.now() - phaseStartedAtMs;
        const result = await runSingleGuidedSlice(myGeneration, channel, phase, pending, sliceMs, batchIndex, phaseElapsedAtSliceStartMs);
        if (myGeneration !== generation) break;

        for (const did of pending) {
          const after = phaseResponseCounts.get(phaseCountKey(did, phase.id)) ?? 0;
          if (after > (before.get(did) ?? 0)) misses.set(did, 0);
          else misses.set(did, (misses.get(did) ?? 0) + 1); // (2) NRC/timeout budget.
        }

        // Live ranking + H3 checkpoint once per SLICE (not per sample): the
        // ranking is O(samples) and the store write is I/O, so doing either on
        // every correlated response would dominate a 16-DID batch's own
        // pacing. A kill mid-phase therefore loses at most one slice.
        if (myGeneration === generation) {
          emitLiveCandidateSummaries(minSamplesPerPhase);
          void persistObservationSamples();
        }

        // Persistent round-robin cursor, mapped back onto the FULL responder
        // list so the next phase continues from where this one stopped.
        const nextDid = pending[result.nextResponderIndex % pending.length];
        if (nextDid !== undefined) {
          const indexInOrder = order.indexOf(nextDid);
          if (indexInOrder >= 0) {
            order = [...order.slice(indexInOrder), ...order.slice(0, indexInOrder)];
            nextResponderIndex = responders.indexOf(nextDid);
          }
        }
      }
    } finally {
      clearInterval(ticker);
    }

    // Anything still short of the guarantee is `insufficient` for this phase --
    // reported, and never ranked on partial evidence.
    for (const did of responders) {
      if ((phaseSampleCounts.get(phaseCountKey(did, phase.id)) ?? 0) < minSamplesPerPhase) insufficientDids.add(did);
    }
    if (myGeneration === generation) {
      emit({ guidedPhaseExtending: false, observationInsufficientDids: [...insufficientDids].sort((a, b) => a - b) });
    }
    return { nextResponderIndex: nextResponderIndex < 0 ? 0 : nextResponderIndex };
  }

  /**
   * One round SLICE of a count-guaranteed phase: a single `runDidObservation`
   * call over `pending`, tagging and counting every positive sample.
   *
   * Ticket P4j-FIX2 V5 (binding, after Codex P4j-REV2 NEW MEDIUM #3): EVERY
   * slice invokes a FRESH `runDidObservation`, whose own `tMs` starts back at
   * (near) zero -- storing that raw value made a count-guaranteed phase's
   * exported timestamps look like `20, 18, 25, 21, 19 ms` across five slices
   * instead of increasing across the phase. `phaseElapsedAtSliceStartMs` (the
   * caller's own `clock.now() - phaseStartedAtMs` at the moment THIS slice
   * begins) is added to every sample's `tMs` so timestamps stay monotone
   * across the WHOLE phase, not just within one slice.
   */
  async function runSingleGuidedSlice(
    myGeneration: number,
    channel: SweepTransport,
    phase: (typeof DID_OBSERVATION_PHASES)[number],
    pending: readonly number[],
    sliceMs: number,
    batchIndex: number | undefined,
    phaseElapsedAtSliceStartMs: number,
  ): Promise<GuidedPhaseRunResult> {
    const observationId = currentObservationId ?? undefined;
    const result = await runDidObservation({
      responders: pending,
      transport: channel,
      clock: deps.clock,
      durationMs: sliceMs,
      pacing: deps.pacing,
      control: observationControl,
      requestTimeoutMs: deps.requestTimeoutMs,
      maxResponsePendingExtensions: deps.maxResponsePendingExtensions,
      onStarted: (startedAtMs) => {
        if (myGeneration === generation) deps.onObservationStarted?.({ wallClockMs: startedAtMs });
      },
      onSample: (did, raw, tMs) => {
        if (myGeneration !== generation) return;
        const phaseRelativeTMs = tMs + phaseElapsedAtSliceStartMs;
        guidedSamples.push(
          batchIndex === undefined
            ? { did, phase: phase.id, tMs: phaseRelativeTMs, raw, observationId }
            : { did, phase: phase.id, tMs: phaseRelativeTMs, raw, batchIndex, observationId },
        );
        const key = phaseCountKey(did, phase.id);
        // Ticket P4k (binding): `phaseResponseCounts` tracks EVERY positive
        // sample (settling included -- see the miss-budget check above);
        // `phaseSampleCounts` -- the one the count guarantee itself reads --
        // only ever counts a sample taken AFTER this phase's own settle
        // window (baseline is never settling; see `isSettlingSample`).
        phaseResponseCounts.set(key, (phaseResponseCounts.get(key) ?? 0) + 1);
        if (!isSettlingSample(phase.id, phaseRelativeTMs, SETTLE_MS)) {
          phaseSampleCounts.set(key, (phaseSampleCounts.get(key) ?? 0) + 1);
        }
      },
    });
    return { nextResponderIndex: result.nextResponderIndex };
  }

  async function runGuidedPhase(
    myGeneration: number,
    channel: SweepTransport,
    phase: (typeof DID_OBSERVATION_PHASES)[number],
    responders: readonly number[],
    options: RunGuidedPhaseOptions = {},
  ): Promise<GuidedPhaseRunResult> {
    if (options.minSamplesPerPhase !== undefined) {
      return runCountGuaranteedPhase(
        myGeneration,
        channel,
        phase,
        responders,
        options.durationMs ?? computeGuidedPhaseDurationMs(responders.length, phase.durationMs),
        options.minSamplesPerPhase,
        options.batchIndex,
      );
    }
    // F2 fix (binding): "if the [candidate] set is larger than
    // ~rate×phaseSeconds, raise the phase length automatically (show it) so
    // every candidate is sampled ≥ 2× per phase." Ticket P4j: a caller that
    // already sized this phase itself (a batch plan, a focused-shortlist
    // calculation) passes `options.durationMs` and skips this auto-raise.
    const durationMs = options.durationMs ?? computeGuidedPhaseDurationMs(responders.length, phase.durationMs);
    emit({ guidedPhase: phase.id, guidedPhaseElapsedMs: 0, guidedPhaseDurationMs: durationMs });
    if (responders.length === 0) return { nextResponderIndex: 0 };
    // X3 fix (P4i-FIX3, binding, after Codex P4irev3 R6 PARTIAL): same
    // wall-clock floor as `sampleOnceRoundRobin` -- this fixed phase's own
    // countdown must still reach `durationMs` even when nothing answers.
    let highestElapsedMs = 0;
    const tickerStartedAtMs = deps.clock.now();
    const ticker = setInterval(() => {
      if (myGeneration !== generation) return;
      const elapsed = Math.min(durationMs, deps.clock.now() - tickerStartedAtMs);
      if (elapsed <= highestElapsedMs) return;
      highestElapsedMs = elapsed;
      emit({ guidedPhaseElapsedMs: elapsed });
    }, ELAPSED_TICKER_INTERVAL_MS);
    let result: { nextResponderIndex: number };
    try {
      result = await runDidObservation({
        responders,
        transport: channel,
        clock: deps.clock,
        durationMs,
        pacing: deps.pacing,
        control: observationControl,
        requestTimeoutMs: deps.requestTimeoutMs,
        maxResponsePendingExtensions: deps.maxResponsePendingExtensions,
        onStarted: (startedAtMs) => {
          if (myGeneration === generation) deps.onObservationStarted?.({ wallClockMs: startedAtMs });
        },
        onSample: (did, raw, tMs) => {
          if (myGeneration !== generation) return;
          const observationId = currentObservationId ?? undefined;
          guidedSamples.push(
            options.batchIndex === undefined
              ? { did, phase: phase.id, tMs, raw, observationId }
              : { did, phase: phase.id, tMs, raw, batchIndex: options.batchIndex, observationId },
          );
          const advanced = tMs > highestElapsedMs;
          if (advanced) highestElapsedMs = tMs;
          emit({
            ...(advanced ? { guidedPhaseElapsedMs: tMs } : {}),
            // Ticket P4k (binding): the settle window applies here too --
            // `startGuidedObservation()`'s single fixed-duration pass is the
            // SAME phase plan (baseline/brake/steering/throttle) with the
            // SAME phase-transition contamination risk.
            candidateSummaries: computeDidCandidateSummaries(guidedSamples, { settleMs: SETTLE_MS }),
          });
        },
      });
    } finally {
      clearInterval(ticker);
    }
    return { nextResponderIndex: result.nextResponderIndex };
  }

  /**
   * Runs the changing-value pre-pass, THEN every phase in
   * `DID_OBSERVATION_PHASES`, in order, on ONE channel -- a full `stop()`
   * (bumps `generation`) or `stopGuidedObservationEarly()` (flips
   * `observationControl.stopped` without bumping `generation`, same
   * discipline as `stopObservationEarly()`) both end the CURRENT phase's
   * `runDidObservation` call early; only a phase boundary check decides
   * whether the NEXT phase still runs.
   *
   * F2 fix (binding): "round-robin must CONTINUE from where the previous
   * phase stopped (persistent cursor)" -- `responderOrder` is ROTATED by each
   * phase's own `nextResponderIndex` before the next phase runs, so a phase
   * boundary landing mid-round never restarts coverage back at the front of
   * the candidate list (the REV finding: "each six-second phase starts again
   * from the first DID, so ... only the same first ~95 DIDs are sampled").
   */
  async function runGuidedObservationOnChannel(myGeneration: number, channel: SweepTransport): Promise<void> {
    const orderedDids = await runChangingValuePrePass(myGeneration, channel, observationResponderDids);
    if (myGeneration === generation) observationResponderDids = orderedDids;
    let responderOrder = orderedDids;
    for (const phase of DID_OBSERVATION_PHASES) {
      if (myGeneration !== generation || observationControl.stopped) break;
      const result = await runGuidedPhase(myGeneration, channel, phase, responderOrder);
      if (responderOrder.length > 0) {
        const next = ((result.nextResponderIndex % responderOrder.length) + responderOrder.length) % responderOrder.length;
        responderOrder = [...responderOrder.slice(next), ...responderOrder.slice(0, next)];
      }
    }
    if (myGeneration !== generation) return; // a full stop() already handled teardown/release + the final phase itself.
    await teardownActiveTransport();
    if (myGeneration !== generation) return; // stop() raced in while close was settling -- it owns the final phase.
    emit({ phase: 'observationComplete', guidedPhase: null, candidateSummaries: computeDidCandidateSummaries(guidedSamples, { settleMs: SETTLE_MS }) });
    await persistObservationSamples();
    await persistObservationSummary({
      observationId: currentObservationId,
      mode: 'guided',
      candidates: computeDidCandidateSummaries(guidedSamples, { settleMs: SETTLE_MS }),
      blockCandidates: [],
      inconsistentDids: [],
      insufficientDids: [],
      noResponseDids: [],
    });
    releaseReservation();
  }

  /** Same single `runGuarded` lifecycle as `openTransportAndObserve` -- a synchronous throw from `transportFactory`/`createRawUdsChannel`, a `connect()` rejection, or an unexpected rejection from the guided loop are ALL caught, closing then releasing before surfacing the error. The F4 keep-alive ticker starts the instant the channel opens and stops on EVERY exit path (a `finally`), including a synchronous throw from `createRawUdsChannel` itself. */
  async function openTransportAndGuidedObserve(myGeneration: number): Promise<void> {
    await runGuarded(myGeneration, async () => {
      const transport = deps.transportFactory();
      activeTransport = transport;
      await transport.connect();
      if (myGeneration !== generation) return;
      const channel = createRawUdsChannel(transport, deps.testerAddress, deps.targetAddress);
      activeChannel = channel;
      startGuidedKeepAliveTicker(myGeneration, channel);
      try {
        await runGuidedObservationOnChannel(myGeneration, channel);
      } finally {
        stopGuidedKeepAliveTicker();
      }
    });
  }

  // -------------------------------------------------------------------
  // Batched guided observation (ticket P4j, binding). Field evidence: a
  // single 128-candidate phase at the measured ~9 req/s gave every DID only
  // 1-2 samples -- not enough to tell a real brake/steering signal from
  // ordinary sensor jitter (0x4522: 297 -> 305 -> 295). `planObservationBatches`
  // splits the candidate pool into small fixed-size batches and sizes each
  // batch's own phase duration from the run's OWN measured req/s so every DID
  // gets >= `minSamplesPerPhase` samples/phase -- this runs the SAME
  // baseline -> brake -> steering -> throttle cycle batch after batch, on ONE
  // connection for the whole sequence (keep-alive ticker spans every batch,
  // never restarted between them), reporting "Batch index+1/total" progress.
  // -------------------------------------------------------------------

  /**
   * Ticket P4j-FIX1 M3 (binding, after Codex P4j-REV1 MEDIUM #3: "Variable-
   * length responses crossing a category boundary evade the consistency
   * check"): every sample is GROUPED BY DID and length-validated FIRST, and
   * only then routed as a whole DID to the numeric (1-8 byte) or block (9-32
   * byte) summarizer.
   *
   * The pre-fix code routed each SAMPLE independently, so a DID alternating
   * between 8 and 9 bytes became two apparently consistent candidates, and one
   * alternating between 32 and 33 bytes silently dropped its 33-byte samples
   * and looked like a clean 32-byte block. Such a DID is now marked
   * INCONSISTENT: routed to NEITHER summarizer, and reported.
   */
  function groupSamplesForRanking(samplesToRoute: readonly DidPhaseSample[]): {
    numeric: DidPhaseSample[];
    block: DidPhaseSample[];
    inconsistentDids: number[];
  } {
    const byDid = new Map<number, DidPhaseSample[]>();
    for (const sample of samplesToRoute) {
      const list = byDid.get(sample.did) ?? [];
      list.push(sample);
      byDid.set(sample.did, list);
    }
    const numeric: DidPhaseSample[] = [];
    const block: DidPhaseSample[] = [];
    const inconsistentDids: number[] = [];
    for (const [did, didSamples] of byDid) {
      const length = didSamples[0]?.raw.length ?? 0;
      if (!didSamples.every((s) => s.raw.length === length)) {
        inconsistentDids.push(did);
        continue;
      }
      if (length >= 1 && length <= 8) numeric.push(...didSamples);
      else if (length >= 9 && length <= 32) block.push(...didSamples);
      // Anything else (0 bytes, or > 32) is not ranked by either summarizer --
      // `filterCandidatePool` already excludes it from the pool.
    }
    return { numeric, block, inconsistentDids: inconsistentDids.sort((a, b) => a - b) };
  }

  /** Recomputes and emits the ranked candidate/block summaries from whatever has been sampled so far, under the H2 margin rule (never the naive fallback). Ticket P4k (binding): `settleMs` excludes each phase's own settling samples from the change evidence -- see `didObservationPhases.ts`. */
  function emitLiveCandidateSummaries(minSamplesPerPhase: number): void {
    const { numeric, block, inconsistentDids } = groupSamplesForRanking(guidedSamples);
    emit({
      candidateSummaries: computeDidCandidateSummaries(numeric, { useMarginRule: true, minSamplesPerPhase, settleMs: SETTLE_MS }),
      blockCandidateSummaries: computeDidBlockCandidateSummaries(block, { minSamplesPerPhase, settleMs: SETTLE_MS }),
      inconsistentCandidateDids: inconsistentDids,
    });
  }

  /**
   * The shared classify-and-persist tail for the batched and focused flows
   * (P4j-FIX1 H1/H3/M3, binding): final ranking under the margin rule, the
   * `insufficient` / `no response` reports, the last sample checkpoint, and
   * the observation SUMMARY blob so a kill/reopen Share still has all of it.
   */
  async function finishGuidedRun(observedDids: readonly number[], minSamplesPerPhase: number): Promise<void> {
    const { numeric, block, inconsistentDids } = groupSamplesForRanking(guidedSamples);
    const candidateSummaries = computeDidCandidateSummaries(numeric, { useMarginRule: true, minSamplesPerPhase, settleMs: SETTLE_MS });
    const blockCandidateSummaries = computeDidBlockCandidateSummaries(block, { minSamplesPerPhase, settleMs: SETTLE_MS });
    const sampledDids = new Set(guidedSamples.map((s) => s.did));
    const noResponseDids = observedDids.filter((did) => !sampledDids.has(did)).sort((a, b) => a - b);
    for (const did of noResponseDids) insufficientDids.add(did);
    const insufficient = [...insufficientDids].sort((a, b) => a - b);
    emit({
      phase: 'observationComplete',
      guidedPhase: null,
      guidedPhaseExtending: false,
      batchIndex: null,
      batchTotal: null,
      candidateSummaries,
      blockCandidateSummaries,
      inconsistentCandidateDids: inconsistentDids,
      observationInsufficientDids: insufficient,
      observationNoResponseDids: noResponseDids,
    });
    await persistObservationSamples();
    await persistObservationSummary({
      observationId: currentObservationId,
      minSamplesPerPhase,
      candidates: candidateSummaries,
      blockCandidates: blockCandidateSummaries,
      inconsistentDids,
      insufficientDids: insufficient,
      noResponseDids,
    });
  }

  async function runBatchedObservationOnChannel(
    myGeneration: number,
    channel: SweepTransport,
    batches: readonly ObservationBatch[],
    minSamplesPerPhase: number,
  ): Promise<void> {
    const observedDids = batches.flatMap((batch) => [...batch.dids]);
    for (const batch of batches) {
      if (myGeneration !== generation || observationControl.stopped) break;
      // M2 (binding, P4j-FIX1, after Codex P4j-REV1 MEDIUM #2: "Pause is not
      // supported mid-batch"): pause takes effect at a BATCH BOUNDARY -- the
      // batch that is running always finishes its own four phases, so no
      // batch is ever left half-observed, and everything sampled so far is
      // checkpointed to the store before the wait.
      if (observationPauseRequested) {
        await pauseAtBatchBoundary(myGeneration);
        if (myGeneration !== generation || observationControl.stopped) break;
      }
      emit({ batchIndex: batch.index, batchTotal: batch.total });
      let responderOrder: readonly number[] = batch.dids;
      for (const phase of DID_OBSERVATION_PHASES) {
        if (myGeneration !== generation || observationControl.stopped) break;
        const result = await runGuidedPhase(myGeneration, channel, phase, responderOrder, {
          durationMs: batch.phaseDurationMs,
          batchIndex: batch.index,
          // Ticket P4j-FIX1 H1 (binding): the phase runs until every DID in
          // the batch has this many POSITIVE samples (bounded), never for a
          // fixed window sized from a rate estimate.
          minSamplesPerPhase,
        });
        if (responderOrder.length > 0) {
          const next = ((result.nextResponderIndex % responderOrder.length) + responderOrder.length) % responderOrder.length;
          responderOrder = [...responderOrder.slice(next), ...responderOrder.slice(0, next)];
        }
      }
    }
    if (myGeneration !== generation) return; // a full stop() already handled teardown/release + the final phase itself.
    await teardownActiveTransport();
    if (myGeneration !== generation) return; // stop() raced in while close was settling -- it owns the final phase.
    // Ticket P4j (binding): the margin-based ranking rule -- opted in here
    // (never on the legacy single-pass `startGuidedObservation`, which keeps
    // its pre-ticket naive-distinctness behaviour byte-identical) because
    // batching is specifically what guarantees the `minSamplesPerPhase` this
    // rule needs to be meaningful.
    await finishGuidedRun(observedDids, minSamplesPerPhase);
    releaseReservation();
  }

  /** Same lifecycle discipline as `openTransportAndGuidedObserve` -- one connection, one continuous keep-alive ticker, for the WHOLE batched sequence. */
  async function openTransportAndBatchedObserve(myGeneration: number, batches: readonly ObservationBatch[], minSamplesPerPhase: number): Promise<void> {
    await runGuarded(myGeneration, async () => {
      const transport = deps.transportFactory();
      activeTransport = transport;
      await transport.connect();
      if (myGeneration !== generation) return;
      const channel = createRawUdsChannel(transport, deps.testerAddress, deps.targetAddress);
      activeChannel = channel;
      startGuidedKeepAliveTicker(myGeneration, channel);
      try {
        await runBatchedObservationOnChannel(myGeneration, channel, batches, minSamplesPerPhase);
      } finally {
        stopGuidedKeepAliveTicker();
      }
    });
  }

  // -------------------------------------------------------------------
  // Focused observation (ticket P4j, binding): "the user can tick candidates
  // (or type DIDs) -> one long guided cycle on the shortlist only (>= 10
  // samples per phase)." A single (unbatched) run over EXACTLY the DIDs the
  // user chose -- typed DIDs need not even be in the current responder set
  // (the user is deliberately probing something specific).
  // -------------------------------------------------------------------

  async function runFocusedObservationOnChannel(myGeneration: number, channel: SweepTransport, dids: readonly number[], minSamplesPerPhase: number): Promise<void> {
    const phaseDurationMs = computeGuidedPhaseDurationMs(dids.length, DID_OBSERVATION_PHASES[0]!.durationMs, lastMeasuredReqPerSec || undefined, minSamplesPerPhase);
    let responderOrder: readonly number[] = dids;
    for (const phase of DID_OBSERVATION_PHASES) {
      if (myGeneration !== generation || observationControl.stopped) break;
      // H1 (binding): the focused shortlist gets the SAME count guarantee as a
      // batch -- "one long guided cycle on the shortlist only (>= 10 samples
      // per phase)" is a COUNT, not a window.
      const result = await runGuidedPhase(myGeneration, channel, phase, responderOrder, { durationMs: phaseDurationMs, minSamplesPerPhase });
      if (responderOrder.length > 0) {
        const next = ((result.nextResponderIndex % responderOrder.length) + responderOrder.length) % responderOrder.length;
        responderOrder = [...responderOrder.slice(next), ...responderOrder.slice(0, next)];
      }
    }
    if (myGeneration !== generation) return;
    await teardownActiveTransport();
    if (myGeneration !== generation) return;
    await finishGuidedRun(dids, minSamplesPerPhase);
    releaseReservation();
  }

  async function openTransportAndFocusedObserve(myGeneration: number, dids: readonly number[], minSamplesPerPhase: number): Promise<void> {
    await runGuarded(myGeneration, async () => {
      const transport = deps.transportFactory();
      activeTransport = transport;
      await transport.connect();
      if (myGeneration !== generation) return;
      const channel = createRawUdsChannel(transport, deps.testerAddress, deps.targetAddress);
      activeChannel = channel;
      startGuidedKeepAliveTicker(myGeneration, channel);
      try {
        await runFocusedObservationOnChannel(myGeneration, channel, dids, minSamplesPerPhase);
      } finally {
        stopGuidedKeepAliveTicker();
      }
    });
  }

  function canStart(phase: DidSweepPhase): boolean {
    return phase === 'idle' || phase === 'sweepComplete' || phase === 'stopped' || phase === 'observationComplete';
  }

  /**
   * The rest of `start()`'s work once a token is actually in hand -- plan
   * creation through opening the transport. Split out (P4j-FIX2 V2, binding)
   * so BOTH the immediate-acquire path and the retry-after-pending-release
   * path (see `start()`'s own doc comment) share this ONE body rather than
   * two hand-copied ones.
   */
  function proceedStart(acquired: EnetAdapterToken, range: { from?: number; to?: number; priorityRanges?: readonly DidSweepRange[] }): void {
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
    // X2/Y2 fix (P4i-FIX3/FIX4, binding): a PRIOR run's still-pending retry
    // slice(s) (index ranges into ITS OWN, now-replaced
    // `accumulator.responders`) must never survive into a fresh run --
    // those indices are meaningless against a brand-new accumulator.
    pendingRetrySlices = [];
    // Y1 fix (P4i-FIX4, binding): a PRIOR run's outstanding tracked-flush
    // count must never leak into a fresh run either.
    pendingFlushCount = 0;
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
    // R2 fix (P4i-FIX2, binding): "guidedSamples cleared on every fresh
    // sweep start / resume, keyed by runId" -- a fresh `start()` never
    // inherits a PRIOR run's guided observation series.
    resetGuidedSamples();
    emit({ ...INITIAL_SNAPSHOT, error: null, phase: 'sweeping' });
    void openTransportAndSweep(myGeneration);
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
      if (acquired !== null) {
        proceedStart(acquired, range);
        return;
      }
      // P4j-FIX2 V2 (binding, after Codex P4j-REV2 MEDIUM #2): ONLY worth a
      // wait when the CURRENT holder itself signalled a release is already
      // in flight (a just-superseded controller instance's `stop()`, kicked
      // off fire-and-forget by an unmount cleanup that cannot await it) --
      // a live, unrelated owner (e.g. the telemetry provider actually
      // polling) still reports "adapter in use" IMMEDIATELY, byte-identical
      // to before this fix.
      if (!reservation.isReleasePending()) {
        emit({ ...INITIAL_SNAPSHOT, error: RESERVATION_BUSY_MESSAGE });
        return;
      }
      void (async (): Promise<void> => {
        await Promise.race([reservation.whenFree().catch(() => undefined), waitMs(RESERVATION_WAIT_RACE_MS)]);
        if (!canStart(snapshot.phase)) return; // superseded while waiting (e.g. a later start()/resumePersistedRun() already proceeded).
        const retryAcquired = reservation.tryAcquire('sweep');
        if (retryAcquired === null) {
          emit({ ...INITIAL_SNAPSHOT, error: RESERVATION_BUSY_MESSAGE });
          return;
        }
        proceedStart(retryAcquired, range);
      })();
    },

    pause(): Promise<void> {
      // R1 fix (P4i-FIX2, binding): `control.paused` is still flipped
      // synchronously (the request loop notices it at its own next boundary,
      // exactly as before) -- the returned promise resolves once
      // `finishSweepRun`'s 'paused' branch actually reaches (and commits) its
      // own terminal flush, or immediately if pausing never applies here.
      //
      // X1 fix (P4i-FIX3, binding): REJECTS instead if that terminal flush
      // fails (see `settlePendingPauses`) -- never silently resolved over a
      // checkpoint that didn't actually commit.
      // Ticket P4j-FIX1 M2 (binding): pause is ALSO honoured during a batched
      // observation -- at the next BATCH boundary (see `pauseAtBatchBoundary`).
      if (snapshot.phase === 'observing' && snapshot.batchTotal !== null) {
        if (observationPauseRequested) {
          return new Promise<void>((resolve) => pendingObservationPauseResolvers.push(resolve));
        }
        observationPauseRequested = true;
        return new Promise<void>((resolve) => pendingObservationPauseResolvers.push(resolve));
      }
      if (snapshot.phase !== 'sweeping') return Promise.resolve();
      control.paused = true;
      return new Promise<void>((resolve, reject) => {
        pendingPauseResolvers.push({ resolve, reject });
      });
    },

    resume(): void {
      // M2 (binding): a batched observation parked at a batch boundary resumes
      // on the SAME transport/reservation/generation -- nothing is re-acquired
      // and no sample is lost.
      if (snapshot.phase === 'paused' && observationPauseRequested) {
        emit({ phase: 'observing' });
        releaseObservationPause();
        return;
      }
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

    stop(): Promise<void> {
      // F7 fix (P4i-FIX1, binding, after Codex P4hrev2c): "stop() is a no-op
      // on completed; status transitions are monotone" -- a no-op on ANY
      // terminal/idle state (`canStart`'s own set: idle/sweepComplete/stopped/
      // observationComplete), not only idle/stopped. Reaching sweepComplete
      // or observationComplete already closed the transport and released the
      // reservation (see `finishSweepRun`/`finishObservation`'s own tails) --
      // there is nothing left here to tear down, and persisting a SECOND,
      // synthetic 'stopped' over an already-`'complete'` run (e.g. from the
      // screen's unmount cleanup firing after a natural completion) would
      // violate that monotone-status invariant.
      if (canStart(snapshot.phase)) return Promise.resolve();
      control.stopped = true;
      observationControl.stopped = true;
      generation += 1; // supersede any in-flight sweep/observation continuation -- ITS OWN teardown/release is now skipped (see the `myGeneration !== generation` guards above), this call owns close-then-release instead.
      const myGeneration = generation;
      // R1 fix (P4i-FIX2, binding): a pause() that never got a chance to reach
      // its own 'paused' branch (this stop() superseded it first) must not
      // hang forever -- resolve it now, since the sweep will never pause.
      settlePendingPauses();
      // R1 fix (P4i-FIX2, binding): `stop()` returns this flush's OWN promise
      // -- the phase still flips to 'stopped' synchronously below (unchanged
      // for every existing caller), but a caller that awaits `stop()` only
      // sees it resolve once the terminal checkpoint has actually committed.
      //
      // X1 fix (P4i-FIX3, binding): the returned promise now REJECTS if that
      // flush fails -- `persistError` is set on the snapshot from the settled
      // result regardless (guarded by `myGeneration`, so a stale attempt can
      // never clobber a LATER run's own state) so a caller that isn't
      // awaiting this can still see the failure.
      //
      // Y1 fix (P4i-FIX4, binding): tracked like `finishSweepRun`'s own two
      // flushes -- `persisting` only reads back false once every OTHER
      // outstanding tracked flush (e.g. a still-settling `pause()` flush this
      // `stop()` raced in ahead of) has ALSO settled.
      // Ticket P4j-FIX1 M2 (binding): a `stop()` that lands while a batched
      // observation is parked at a batch boundary must not leave that loop
      // waiting forever -- release it so it can reach its own exit path.
      releaseObservationPause();
      settleObservationPauses();
      beginTrackedFlush();
      const flushPromise = maybeFlushPersistence(true, 'stopped');
      emit({ phase: 'stopped', persisting: true });
      // P4f-FIX4 (binding, HIGH, after Codex REV4): release is UNCONDITIONAL
      // -- a `finally`, not a second sequential statement -- so it always
      // runs even if something besides `teardownActiveTransport()` itself
      // (already made non-rejecting, see `closeQuietly`) were ever to throw
      // here; the claim must never outlive this `stop()` call.
      //
      // Ticket P4j-FIX1 M2 (binding, after Codex P4j-REV1 MEDIUM #2: "`stop()`
      // can resolve before teardown/release"): this teardown is no longer a
      // DETACHED task -- the returned promise now settles only after the
      // socket has closed AND the reservation has been released, so an
      // immediate navigation to telemetry can no longer transiently see
      // "adapter in use".
      // P4j-FIX2 V2 (binding, after Codex P4j-REV2 MEDIUM #2): marked
      // SYNCHRONOUSLY, before the async teardown below ever awaits anything --
      // a caller (e.g. a remounted screen's fresh controller's `start()`) that
      // races in on this SAME tick or shortly after already sees
      // `isReleasePending()` true, so it knows a short wait is worth trying
      // instead of reporting "adapter in use" for a claim that is, in fact,
      // already on its way out.
      const tokenBeingReleased = token;
      if (tokenBeingReleased !== null) reservation.markReleasing(tokenBeingReleased);
      const teardownPromise = (async (): Promise<void> => {
        try {
          await teardownActiveTransport();
        } finally {
          releaseReservation();
        }
      })();
      return teardownPromise.then(() =>
        flushPromise.then((result) => {
          endTrackedFlush(myGeneration, result);
          if (!result.persisted) {
            throw new Error(result.error !== undefined ? `Save failed -- results kept in memory: ${result.error}` : 'Save failed -- results kept in memory, share now');
          }
        }),
      );
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
        // Ticket P4j-FIX1 M5 (binding, after Codex P4j-REV1 MEDIUM #5): back to
        // `filterSweepCandidates` (1-8 bytes). P4j had widened this legacy
        // single-window flow to `filterCandidatePool` (1-32), letting a
        // changing 24-byte block consume heuristic polling capacity -- the
        // widened pool belongs to the BATCHED flow alone.
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
      // Ticket P4j-FIX1 M5 (binding): the legacy flows stay on the 1-8-byte filter.
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
      // Ticket P4j-FIX1 M5 (binding): the LEGACY guided flow stays on the
      // binding 1-8-byte filter -- mid-size blocks belong to the batched flow.
      observationResponderDids = filterSweepCandidates(snapshot.responders).map((r) => r.did);
      emit({
        phase: 'observing',
        guidedPhase: null,
        guidedPhaseElapsedMs: 0,
        guidedPhaseDurationMs: 0,
        guidedPhaseExtending: false,
        candidateSummaries: [],
        blockCandidateSummaries: [],
        inconsistentCandidateDids: [],
        observationInsufficientDids: [],
        observationNoResponseDids: [],
        batchIndex: null,
        batchTotal: null,
        error: null,
      });
      beginObservationRun();
      void openTransportAndGuidedObserve(myGeneration);
    },

    stopGuidedObservationEarly(): void {
      if (snapshot.phase !== 'observing') return;
      // Same semantics as `stopObservationEarly()`: ends the CURRENT phase's
      // `runDidObservation` call at its next boundary WITHOUT bumping
      // `generation` -- `runGuidedObservationOnChannel`'s own per-phase loop
      // check (`observationControl.stopped`) is what then skips every
      // REMAINING phase too, still reaching the classify-and-release tail.
      // Ticket P4j: the SAME flag drives the batched/focused loops' own
      // per-phase-and-per-batch checks -- this one flip cuts short whichever
      // of the three guided flows is currently running.
      observationControl.stopped = true;
    },

    startBatchedObservation(options = {}): void {
      if (snapshot.phase !== 'sweepComplete' && snapshot.phase !== 'stopped' && snapshot.phase !== 'observationComplete') {
        return;
      }
      if (snapshot.responders.length === 0) return;
      // Ticket P4j: the WIDENED pool -- 1-32 bytes, mid-size blocks join
      // numeric candidates (`filterCandidatePool`, vs. the legacy 1-8-byte
      // `filterSweepCandidates` `startGuidedObservation()` still uses).
      const candidateDids = filterCandidatePool(snapshot.responders).map((r) => r.did);
      if (candidateDids.length === 0) return;
      const acquired = reservation.tryAcquire('sweep');
      if (acquired === null) {
        emit({ error: RESERVATION_BUSY_MESSAGE });
        return;
      }
      generation += 1;
      const myGeneration = generation;
      token = acquired;
      observationControl = { paused: false, stopped: false };
      observationResponderDids = candidateDids;
      observationPauseRequested = false;
      // M1 (binding): the ranking's own `minSamplesPerPhase` is clamped the
      // SAME way `planObservationBatches` clamps its copy -- the two must
      // never disagree about what the phase actually guaranteed.
      const minSamplesPerPhase = sanitizeMinSamplesPerPhase(options.minSamplesPerPhase, DEFAULT_MIN_SAMPLES_PER_PHASE);
      const batches = planObservationBatches(candidateDids, {
        // M1 (binding): `planObservationBatches` clamps this to MAX_BATCH_SIZE.
        batchSize: options.batchSize === undefined ? undefined : Math.min(MAX_BATCH_SIZE, options.batchSize),
        minSamplesPerPhase,
        // Ticket P4j: "phase duration per batch from the MEASURED rate of the
        // sweep run (not the assumed 15)" -- falls back to
        // `planObservationBatches`' own assumed default when nothing has been
        // measured yet in this controller instance (`lastMeasuredReqPerSec`
        // starts at 0, which `planObservationBatches` treats as "not measured").
        measuredReqPerSec: lastMeasuredReqPerSec,
      });
      emit({
        phase: 'observing',
        guidedPhase: null,
        guidedPhaseElapsedMs: 0,
        guidedPhaseDurationMs: 0,
        guidedPhaseExtending: false,
        candidateSummaries: [],
        blockCandidateSummaries: [],
        inconsistentCandidateDids: [],
        observationInsufficientDids: [],
        observationNoResponseDids: [],
        batchIndex: batches.length > 0 ? 0 : null,
        batchTotal: batches.length > 0 ? batches.length : null,
        error: null,
      });
      beginObservationRun();
      void openTransportAndBatchedObserve(myGeneration, batches, minSamplesPerPhase);
    },

    startFocusedObservation(dids: readonly number[], options = {}): void {
      if (snapshot.phase !== 'sweepComplete' && snapshot.phase !== 'stopped' && snapshot.phase !== 'observationComplete') {
        return;
      }
      // Ticket P4j: "the user can tick candidates (or type DIDs)" -- typed
      // DIDs need not be discovered responders at all, only valid DID values
      // (deduplicated, in the caller's own order). Coordinator addendum
      // (binding): a typed DID the sweep never saw is read DIRECTLY; an NRC
      // answer surfaces as "no response", never as a silent omission.
      const uniqueDids = Array.from(new Set(dids)).filter((did) => Number.isInteger(did) && did >= 0 && did <= 0xffff);
      if (uniqueDids.length === 0) return;
      // M1 (binding): "focused shortlist <= 16 DIDs (error shown)" -- a longer
      // shortlist cannot reach 10 samples/DID/phase in any sane window, so it
      // is REFUSED with a visible error rather than silently run.
      if (uniqueDids.length > MAX_FOCUSED_SHORTLIST_SIZE) {
        emit({ error: `Pick at most ${MAX_FOCUSED_SHORTLIST_SIZE} DIDs for a focused run (got ${uniqueDids.length}).` });
        return;
      }
      const acquired = reservation.tryAcquire('sweep');
      if (acquired === null) {
        emit({ error: RESERVATION_BUSY_MESSAGE });
        return;
      }
      generation += 1;
      const myGeneration = generation;
      token = acquired;
      observationControl = { paused: false, stopped: false };
      observationResponderDids = uniqueDids;
      observationPauseRequested = false;
      const minSamplesPerPhase = sanitizeMinSamplesPerPhase(options.minSamplesPerPhase, FOCUSED_MIN_SAMPLES_PER_PHASE);
      emit({
        phase: 'observing',
        guidedPhase: null,
        guidedPhaseElapsedMs: 0,
        guidedPhaseDurationMs: 0,
        guidedPhaseExtending: false,
        candidateSummaries: [],
        blockCandidateSummaries: [],
        inconsistentCandidateDids: [],
        observationInsufficientDids: [],
        observationNoResponseDids: [],
        batchIndex: null,
        batchTotal: null,
        error: null,
      });
      beginObservationRun();
      void openTransportAndFocusedObserve(myGeneration, uniqueDids, minSamplesPerPhase);
    },

    async resumePersistedRun(runId: string): Promise<void> {
      if (deps.store === undefined) return;
      if (!canStart(snapshot.phase)) return;
      const run = await deps.store.getRun(runId).catch(() => null);
      if (run === null) return;
      const responderRecords = await deps.store.getResponders(runId).catch(() => []);

      let acquired = reservation.tryAcquire('sweep');
      if (acquired === null && reservation.isReleasePending()) {
        // P4j-FIX2 V2 (binding): same reacquire-after-pending-release retry
        // as `start()` -- see its own doc comment. Gated (never unconditional)
        // and bounded, so a genuinely busy reservation (a live, unrelated
        // owner that never signalled it's releasing) still reports "adapter
        // in use" promptly rather than hanging.
        await Promise.race([reservation.whenFree().catch(() => undefined), waitMs(RESERVATION_WAIT_RACE_MS)]);
        if (!canStart(snapshot.phase)) return; // superseded while waiting.
        acquired = reservation.tryAcquire('sweep');
      }
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
      // X2/Y2/Y1 fix (P4i-FIX3/FIX4, binding): see `start()`'s own comment --
      // a resumed run gets its own fresh accumulator too.
      pendingRetrySlices = [];
      pendingFlushCount = 0;
      lastFlushAtMs = deps.clock.now();
      // R2 fix (P4i-FIX2, binding): "cleared on every fresh sweep start /
      // resume" -- a resumed run never inherits a PRIOR run's guided
      // observation series either.
      resetGuidedSamples();
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

    getGuidedSamples(): readonly DidPhaseSample[] {
      // R2 fix (P4i-FIX2, binding): only ever return samples that belong to
      // the CURRENTLY active run -- see `guidedSamplesRunId`'s own doc
      // comment. A fresh `start()`/`resumePersistedRun()` already resets both
      // together, so this is redundant defense-in-depth for any path that
      // might reassign `currentRunId` without going through
      // `resetGuidedSamples()`.
      // A COPY, never the live array: a caller that snapshots this (the export
      // builder, a test asserting on a paused observation) must not see it
      // keep growing underneath them as later phases sample.
      return guidedSamplesRunId === currentRunId ? [...guidedSamples] : [];
    },
  };
}
