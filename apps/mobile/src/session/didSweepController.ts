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
 * `DidSweepAccumulator` across pause/resume, and the observation phase
 * (round-robin re-polls via `runDidSweep` over a one-DID plan per tick --
 * see `pollObservationSample` -- never re-implementing correlation).
 *
 * H1/H2 (binding): the CONTROLLER owns the transport lifecycle -- `start()`
 * acquires the `'sweep'` reservation FIRST (no generation bump before a
 * successful acquire), THEN opens a FRESH transport via the injected
 * `transportFactory`, runs, closes the transport, and releases the
 * reservation -- release STRICTLY after close, on every path (complete,
 * stop, throw). The screen never connects a transport itself.
 */
import {
  bytesToBinaryString,
  binaryStringToBytes,
  classifyResponders,
  createDidSweepAccumulator,
  createDidSweepPlan,
  encodeFrame,
  enetSpecsFromSuggestion,
  HSFZ_CONTROL,
  HsfzFrameParser,
  runDidSweep,
  type DidHeuristicContext,
  type DidHeuristicSuggestion,
  type DidResponderSample,
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
  /** Non-null exactly when something went wrong (invalid range, reservation refused, connect failure) -- never thrown across this API. */
  error: string | null;
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
  error: null,
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
}

const DEFAULT_OBSERVATION_WINDOW_MS = 60_000;
/** Binding (M3): "round-robin ~1 Hz per responder". */
const OBSERVATION_ROUND_TARGET_MS = 1_000;

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
  let observationControl: DidSweepControl = { paused: false, stopped: false };
  /** `stopObservationEarly()`'s own flag -- distinct from `control.stopped` (a full `stop()`): ends the observation WINDOW early but still classifies whatever was sampled (phase 'observationComplete'), never 'stopped'. Never bumps `generation`. */
  let observationCutShort = false;
  let startedAtMs = 0;
  let requestsIssued = 0;
  /** Bumped on `stop()` and on every fresh `start()`/observation-from-terminal-state -- a superseded async continuation checks this before touching shared state (transport/reservation/snapshot). */
  let generation = 0;
  let activeTransport: ObdTransport | null = null;
  let activeChannel: SweepTransport | null = null;
  const observationSeries = new Map<number, DidResponderSample[]>();

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

  /** Closes the active transport (if any) and clears the active transport/channel -- does NOT touch the reservation (callers release separately, strictly AFTER this resolves). */
  async function teardownActiveTransport(): Promise<void> {
    const transport = activeTransport;
    activeTransport = null;
    activeChannel = null;
    if (transport !== null) {
      try {
        await transport.close();
      } catch {
        // Best-effort: a close failure must never block release/reporting.
      }
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

  /** H1/H2 (binding): acquires the reservation, opens a FRESH transport, runs `runSweepLoop`, and (on complete/stop, never on merely-paused) closes the transport THEN releases the reservation. */
  async function openTransportAndSweep(myGeneration: number): Promise<void> {
    let transport: ObdTransport;
    try {
      transport = deps.transportFactory();
      activeTransport = transport;
      await transport.connect();
    } catch (error) {
      await teardownActiveTransport();
      if (myGeneration !== generation) return; // a stop() already superseded/released this attempt.
      releaseReservation();
      emit({ phase: 'stopped', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (myGeneration !== generation) {
      // stop() raced in during connect() -- it already bumped generation and
      // will close/release via its OWN teardown path; this attempt's
      // `activeTransport` reference was already claimed by that path (or is
      // about to be), so just get out without touching it again.
      return;
    }
    const channel = createRawUdsChannel(transport, deps.testerAddress, deps.targetAddress);
    activeChannel = channel;

    const outcome = await runSweepLoop(myGeneration, channel);
    if (myGeneration !== generation) return; // stop() already handled teardown/release.
    if (outcome === 'paused') {
      emit({ phase: 'paused' });
      return; // transport/reservation stay held -- resume() continues on the SAME channel.
    }
    await teardownActiveTransport();
    emit({ phase: outcome === 'complete' ? 'sweepComplete' : 'stopped' });
    releaseReservation();
  }

  // ---------------------------------------------------------------------
  // Observation (M2/M3, binding). Re-polls each responder DID via
  // `runDidSweep` over a fresh ONE-DID plan+accumulator per tick -- the SAME
  // core runner the sweep itself uses, so correlation/0x78/unmatched
  // handling is never re-implemented here either.
  // ---------------------------------------------------------------------

  async function pollObservationSample(channel: SweepTransport, did: number): Promise<Uint8Array | null> {
    const onePlan = createDidSweepPlan({ from: did, to: did });
    const oneAcc = createDidSweepAccumulator();
    await runDidSweep({
      plan: onePlan,
      transport: channel,
      clock: deps.clock,
      control: { paused: false, stopped: false },
      accumulator: oneAcc,
      requestTimeoutMs: deps.requestTimeoutMs,
      // No 0x78 extension budget during observation re-polls -- a stalling
      // ECU just costs this one tick's sample, not the whole re-poll loop.
      maxResponsePendingExtensions: 0,
    });
    return oneAcc.responders[0]?.raw ?? null;
  }

  /**
   * M3 (binding): round-robin every responder once per "round"; a round
   * targets `OBSERVATION_ROUND_TARGET_MS` (1s) total -- if it finishes
   * faster, the remainder is slept so each responder is genuinely sampled
   * ~1 Hz; if the round itself takes LONGER (N responders x measured RTT
   * exceeds 1s), no extra sleep is added (that would only make the real
   * cadence worse) and `observationCadenceDegraded` is reported `true`.
   */
  async function runObservationLoop(
    myGeneration: number,
    channel: SweepTransport,
    windowMs: number,
  ): Promise<'complete' | 'cutShort' | 'stopped'> {
    const dids = [...observationSeries.keys()];
    const observationStartedAtMs = deps.clock.now();
    if (dids.length === 0) return 'complete';

    while (deps.clock.now() - observationStartedAtMs < windowMs) {
      if (myGeneration !== generation || observationControl.stopped) return 'stopped';
      if (observationCutShort) return 'cutShort';
      const roundStartMs = deps.clock.now();
      for (const did of dids) {
        if (myGeneration !== generation || observationControl.stopped) return 'stopped';
        if (observationCutShort) return 'cutShort';
        const raw = await pollObservationSample(channel, did);
        if (myGeneration !== generation) return 'stopped';
        if (raw !== null) {
          observationSeries.get(did)?.push({ tMs: deps.clock.now() - observationStartedAtMs, raw });
        }
      }
      const roundElapsedMs = deps.clock.now() - roundStartMs;
      const degraded = roundElapsedMs > OBSERVATION_ROUND_TARGET_MS;
      emit({ observationElapsedMs: deps.clock.now() - observationStartedAtMs, observationCadenceDegraded: degraded });
      if (!degraded) await waitMs(OBSERVATION_ROUND_TARGET_MS - roundElapsedMs);
      if (myGeneration !== generation || observationControl.stopped) return 'stopped';
      if (observationCutShort) return 'cutShort';
    }
    return 'complete';
  }

  function finishObservation(): void {
    const series = [...observationSeries.entries()].map(([did, samples]) => ({ did, samples }));
    const context = deps.gnssSpeedContext?.();
    const suggestions = classifyResponders(series, context);
    emit({ phase: 'observationComplete', suggestions });
  }

  async function runObservationOnChannel(myGeneration: number, channel: SweepTransport, windowMs: number): Promise<void> {
    const outcome = await runObservationLoop(myGeneration, channel, windowMs);
    if (myGeneration !== generation) return; // a full stop() already handled teardown/release itself.
    observationCutShort = false; // consumed -- reset so a LATER observation run starts clean.
    await teardownActiveTransport();
    if (outcome === 'stopped') {
      emit({ phase: 'stopped' });
    } else {
      // 'complete' (window elapsed) or 'cutShort' (stopObservationEarly()) --
      // BOTH classify whatever was sampled; only a full stop() skips it.
      finishObservation();
    }
    releaseReservation();
  }

  async function openTransportAndObserve(myGeneration: number, windowMs: number): Promise<void> {
    let transport: ObdTransport;
    try {
      transport = deps.transportFactory();
      activeTransport = transport;
      await transport.connect();
    } catch (error) {
      await teardownActiveTransport();
      if (myGeneration !== generation) return;
      releaseReservation();
      emit({ phase: 'stopped', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (myGeneration !== generation) return;
    const channel = createRawUdsChannel(transport, deps.testerAddress, deps.targetAddress);
    activeChannel = channel;
    await runObservationOnChannel(myGeneration, channel, windowMs);
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
      observationCutShort = false;
      requestsIssued = 0;
      startedAtMs = deps.clock.now();
      observationSeries.clear();
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
      void (async () => {
        const outcome = await runSweepLoop(myGeneration, channel);
        if (myGeneration !== generation) return;
        if (outcome === 'paused') {
          emit({ phase: 'paused' });
          return;
        }
        await teardownActiveTransport();
        emit({ phase: outcome === 'complete' ? 'sweepComplete' : 'stopped' });
        releaseReservation();
      })();
    },

    stop(): void {
      if (snapshot.phase === 'idle' || snapshot.phase === 'stopped') return;
      control.stopped = true;
      observationControl.stopped = true;
      generation += 1; // supersede any in-flight sweep/observation continuation -- ITS OWN teardown/release is now skipped (see the `myGeneration !== generation` guards above), this call owns close-then-release instead.
      emit({ phase: 'stopped' });
      void (async () => {
        await teardownActiveTransport();
        releaseReservation();
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
        observationCutShort = false;
        const myGeneration = generation; // SAME generation/token/transport.
        observationSeries.clear();
        for (const responder of snapshot.responders) observationSeries.set(responder.did, []);
        emit({ phase: 'observing', observationElapsedMs: 0, observationCadenceDegraded: false, error: null });
        void runObservationOnChannel(myGeneration, activeChannel, windowMs);
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
      observationCutShort = false;
      observationSeries.clear();
      for (const responder of snapshot.responders) observationSeries.set(responder.did, []);
      emit({ phase: 'observing', observationElapsedMs: 0, observationCadenceDegraded: false, error: null });
      void openTransportAndObserve(myGeneration, windowMs);
    },

    stopObservationEarly(): void {
      if (snapshot.phase !== 'observing') return;
      // Ends the WINDOW early, but this is NOT a full stop() -- the
      // transport/reservation are still released, but via the 'cutShort'
      // outcome (`runObservationOnChannel` still classifies whatever was
      // sampled, landing on 'observationComplete', never 'stopped'). No
      // generation bump -- the SAME run's own teardown handles it.
      observationCutShort = true;
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
  };
}
