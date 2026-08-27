/**
 * ENET auto-discovery & DID sweep addendum (contracts.md, binding, Phase 4f),
 * extended by the "sweep transport interface & lifecycle amendment"
 * (contracts.md, binding, after Codex P4f-REV2) -- the dev DID-sweep
 * screen's state machine: range/plan, start/pause/resume/stop, progress, and
 * (after the sweep, or on demand) an observation phase that re-polls the
 * responders found and classifies them via `@circuit/core`'s
 * `classifyResponders`.
 *
 * CORE INTERFACE IN FLUX (P4f-FIX2, binding): `@circuit/core`'s sweep runner
 * is being changed, in a PARALLEL ticket, to a low-level transport shape
 * `{ send(pdu): Promise<void>; nextResponse(timeoutMs): Promise<Uint8Array |
 * 'timeout'>; keepAlive(pdu): Promise<void> }` -- the runner would then own
 * SID/DID correlation, 0x78 extension, and TesterPresent keep-alive cadence.
 * That core change is NOT in the tree as of this writing (`runDidSweep` is
 * still the older `sendRequest(pdu)`-shaped API, addendum-era). Per the
 * ticket's own instruction ("if not yet in the tree when you integrate, code
 * to this shape and note it"), this module:
 *   1. Implements the `{send, nextResponse, keepAlive}` transport interface
 *      itself, over a raw `ObdTransport` (`createRawUdsChannel` below) --
 *      `nextResponse` does ONLY address-swap correlation (source/target),
 *      never SID/DID, exactly as the binding amendment specifies for the
 *      transport's own contract.
 *   2. OWNS the SID/DID correlation, 0x78 extension (no re-send), and
 *      keep-alive cadence ITSELF (`resolveOneDid`/`startKeepAliveTimer`
 *      below) -- a temporary stand-in for what the future core runner will
 *      do. Once the real core change lands (committed and stable), this
 *      module's `resolveOneDid`/keep-alive logic can be DELETED and replaced
 *      by a call to core's new `runDidSweep({ transport: channel, ... })`;
 *      `createRawUdsChannel`'s `{send, nextResponse, keepAlive}` object is
 *      already shaped to be handed to that new API directly, unchanged.
 *
 * H1/H2 (binding, this ticket): the CONTROLLER owns the transport lifecycle
 * -- `start()` acquires the `'sweep'` reservation FIRST (no generation bump
 * before a successful acquire), THEN opens a FRESH transport via the
 * injected `transportFactory`, runs, closes the transport, and releases the
 * reservation -- release STRICTLY after close, on every path (complete,
 * stop, throw). The screen never connects a transport itself.
 */
import {
  assertAllowedRequest,
  binaryStringToBytes,
  buildReadDataByIdentifierRequest,
  buildTesterPresentRequest,
  bytesToBinaryString,
  classifyResponders,
  createDidSweepPlan,
  encodeFrame,
  enetSpecsFromSuggestion,
  HSFZ_CONTROL,
  HsfzFrameParser,
  parseUdsResponse,
  type DidHeuristicContext,
  type DidHeuristicSuggestion,
  type DidResponderSample,
  type DidSweepPlan,
  type DidSweepRange,
  type DidSweepResponder,
  type EnetChannelSpec,
  type MonotonicClock,
  type ObdTransport,
  type TelemetryChannelId,
} from '@circuit/core';
import { enetAdapterReservation as sharedEnetAdapterReservation, type EnetAdapterReservation, type EnetAdapterToken } from './enetAdapterReservation';

// ---------------------------------------------------------------------------
// Low-level transport interface (binding: "sweep transport interface &
// lifecycle amendment") -- see this module's own doc comment for why this is
// implemented HERE rather than in `@circuit/core`.
// ---------------------------------------------------------------------------

export interface RawUdsChannel {
  /** Frames `pdu` as one HSFZ diagnostic request and sends it. Never correlates a response -- `nextResponse` is the only way to read one back. */
  send(pdu: Uint8Array): Promise<void>;
  /** Resolves with the next diagnostic-control frame's raw UDS payload FROM THE TARGET (address-swapped: source === targetAddress, target === testerAddress) -- NO SID/DID correlation, that is the caller's job (binding). `'timeout'` if none arrives within `timeoutMs`, or if the transport closes while waiting. */
  nextResponse(timeoutMs: number): Promise<Uint8Array | 'timeout'>;
  /** Frames and sends a TesterPresent-shaped `pdu` -- wire-identical to `send`, named separately only to document intent (fire-and-forget, no response expected: TesterPresent 0x3E 0x80 suppresses its own positive response). */
  keepAlive(pdu: Uint8Array): Promise<void>;
}

/**
 * Builds a `RawUdsChannel` over an already-connected `ObdTransport`. Queues
 * EVERY address-matching diagnostic frame from a chunk, in order (H3 test:
 * "wrong-SID then correct 0x62 in one chunk -> both delivered in order") --
 * `nextResponse` dequeues FIFO, or waits for the next arrival, or resolves
 * `'timeout'` (never rejects, never hangs past `timeoutMs`, and resolves
 * `'timeout'` immediately if the transport is already closed).
 */
export function createRawUdsChannel(transport: ObdTransport, testerAddress: number, targetAddress: number): RawUdsChannel {
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
      if (frame.source !== targetAddress || frame.target !== testerAddress) continue; // address-swap correlation ONLY (binding) -- SID/DID is the caller's job.
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
// Per-DID resolution + pacing (temporary stand-in for the future core
// runner -- see this module's own doc comment).
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_RESPONSE_PENDING_EXTENSIONS = 5;
/** Safety net only -- the per-DID deadline (`requestTimeoutMs`) is the REAL bound; this just stops a flood of garbage frames from spinning the loop pointlessly within that same deadline. */
const MAX_UNMATCHED_PER_DID = 50;
const PACING_MIN_MS = 5;
const PACING_MAX_MS = 2_000;
/** Binding: "the runner issues TesterPresent via `keepAlive` every 2 s". */
const KEEP_ALIVE_INTERVAL_MS = 2_000;

interface DidOutcome {
  kind: 'responder' | 'nrc' | 'timeout';
  raw?: Uint8Array;
  nrc?: number;
}

/**
 * Resolves ONE DID: sends the 0x22 request once, then calls `nextResponse`
 * repeatedly within the ORIGINAL `requestTimeoutMs` budget (never resetting
 * it) -- 0x78 extends (bounded, no re-send); an unmatched response (wrong
 * SID, or a positive response whose echoed DID doesn't match) is counted and
 * the loop keeps awaiting within whatever time remains (bounded count). A
 * synchronous throw from `send`/`nextResponse` is treated as a timeout for
 * this DID (binding: "contained ... counted as errors").
 */
async function resolveOneDid(
  channel: RawUdsChannel,
  did: number,
  requestTimeoutMs: number,
  maxExtensions: number,
  clock: MonotonicClock,
): Promise<DidOutcome> {
  const pdu = buildReadDataByIdentifierRequest(did);
  assertAllowedRequest(pdu); // hard gate, re-checked even though this builder only ever emits 0x22.
  const deadlineMs = clock.now() + requestTimeoutMs;

  try {
    await channel.send(pdu);
  } catch {
    return { kind: 'timeout' };
  }

  let extensions = 0;
  let unmatched = 0;
  for (;;) {
    const remaining = deadlineMs - clock.now();
    if (remaining <= 0) return { kind: 'timeout' };
    let raw: Uint8Array | 'timeout';
    try {
      raw = await channel.nextResponse(remaining);
    } catch {
      return { kind: 'timeout' };
    }
    if (raw === 'timeout') return { kind: 'timeout' };

    let parsed: ReturnType<typeof parseUdsResponse>;
    try {
      parsed = parseUdsResponse(raw);
    } catch {
      unmatched += 1;
      if (unmatched > MAX_UNMATCHED_PER_DID) return { kind: 'timeout' };
      continue;
    }

    if (parsed.kind === 'negative') {
      if (parsed.requestSid !== 0x22) {
        unmatched += 1;
        if (unmatched > MAX_UNMATCHED_PER_DID) return { kind: 'timeout' };
        continue;
      }
      if (parsed.nrc === 0x78) {
        extensions += 1;
        if (extensions > maxExtensions) return { kind: 'timeout' };
        continue; // extend: keep awaiting the SAME already-sent request, never re-send (binding).
      }
      return { kind: 'nrc', nrc: parsed.nrc };
    }

    if (parsed.sid !== 0x62 || parsed.data.length < 2) {
      unmatched += 1;
      if (unmatched > MAX_UNMATCHED_PER_DID) return { kind: 'timeout' };
      continue;
    }
    const echoedDid = ((parsed.data[0] ?? 0) << 8) | (parsed.data[1] ?? 0);
    if (echoedDid !== did) {
      unmatched += 1;
      if (unmatched > MAX_UNMATCHED_PER_DID) return { kind: 'timeout' };
      continue;
    }
    return { kind: 'responder', raw: parsed.data.slice(2) };
  }
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

function waitMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
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
  /** Responses that arrived but did not correlate to their own request (wrong SID/echoed DID/unparseable). */
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
  /** default 1000. */
  requestTimeoutMs?: number;
  /** default 5. */
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
  /** Resumes a paused sweep on the SAME transport/reservation (no reconnect, no re-acquire). */
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

export function createDidSweepController(deps: DidSweepControllerDeps): DidSweepController {
  const reservation = deps.reservation ?? sharedEnetAdapterReservation;
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxExtensions = deps.maxResponsePendingExtensions ?? DEFAULT_MAX_RESPONSE_PENDING_EXTENSIONS;
  const listeners = new Set<(s: DidSweepSnapshot) => void>();
  let snapshot: DidSweepSnapshot = INITIAL_SNAPSHOT;
  let token: EnetAdapterToken | null = null;
  let plan: DidSweepPlan | null = null;
  let paused = false;
  let stopped = false;
  /** `stopObservationEarly()`'s own flag -- distinct from `stopped` (a full `stop()`): ends the observation WINDOW early but still classifies whatever was sampled (phase 'observationComplete'), never 'stopped'. Never bumps `generation`. */
  let observationCutShort = false;
  let startedAtMs = 0;
  let requestsIssued = 0;
  /** Bumped on `stop()` and on every fresh `start()`/observation-from-terminal-state -- a superseded async continuation checks this before touching shared state (transport/reservation/snapshot). */
  let generation = 0;
  let activeTransport: ObdTransport | null = null;
  let activeChannel: RawUdsChannel | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
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

  function stopKeepAliveTimer(): void {
    if (keepAliveTimer !== null) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function startKeepAliveTimer(channel: RawUdsChannel): void {
    stopKeepAliveTimer();
    keepAliveTimer = setInterval(() => {
      void channel.keepAlive(buildTesterPresentRequest()).catch(() => undefined);
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  /** Closes the active transport (if any) and clears the active transport/channel/keep-alive -- does NOT touch the reservation (callers release separately, strictly AFTER this resolves). */
  async function teardownActiveTransport(): Promise<void> {
    stopKeepAliveTimer();
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

  /** Drains `plan` (sweeping) until exhausted, paused, or stopped -- pacing between DIDs from the last measured RTT, clamped 5-2000ms. */
  async function runSweepLoop(myGeneration: number, channel: RawUdsChannel): Promise<SweepOutcome> {
    if (plan === null) return 'stopped';
    let lastRttMs: number | null = null;
    let nextNotBeforeMs = deps.clock.now();

    for (;;) {
      if (myGeneration !== generation) return 'stopped'; // superseded.
      if (stopped) return 'stopped';
      if (paused) return 'paused';
      const did = plan.peek();
      if (did === null) return 'complete';

      const now = deps.clock.now();
      if (now < nextNotBeforeMs) await waitMs(nextNotBeforeMs - now);
      if (myGeneration !== generation) return 'stopped';
      if (stopped) return 'stopped';
      if (paused) return 'paused';

      const sentAtMs = deps.clock.now();
      const outcome = await resolveOneDid(channel, did, requestTimeoutMs, maxExtensions, deps.clock);
      if (myGeneration !== generation) return 'stopped';
      const rttMs = Math.max(0, deps.clock.now() - sentAtMs);
      plan.next(); // commit to visiting `did` now that it has resolved.

      const nrcCounts = { ...snapshot.nrcCounts };
      let timeouts = snapshot.timeouts;
      let responders = snapshot.responders;
      if (outcome.kind === 'timeout') {
        timeouts += 1;
      } else if (outcome.kind === 'nrc' && outcome.nrc !== undefined) {
        nrcCounts[outcome.nrc] = (nrcCounts[outcome.nrc] ?? 0) + 1;
        lastRttMs = rttMs;
      } else if (outcome.kind === 'responder' && outcome.raw !== undefined) {
        responders = [...responders, { did, raw: outcome.raw, length: outcome.raw.length, rttMs }];
        lastRttMs = rttMs;
      }

      requestsIssued += 1;
      const elapsedS = Math.max(0.001, (deps.clock.now() - startedAtMs) / 1_000);
      emit({
        responders,
        nrcCounts,
        timeouts,
        progress: { did, index: plan.visitedCount, total: plan.total, reqPerSec: requestsIssued / elapsedS },
      });

      const rttMultiplier = sanitizePositive(deps.pacing?.rttMultiplier, 1);
      const floorIntervalMs = sanitizeNonNegative(deps.pacing?.minIntervalMs, 0);
      const rawCap = deps.pacing?.maxRequestsPerSec;
      const capIntervalMs = rawCap !== undefined && Number.isFinite(rawCap) && rawCap > 0 ? 1_000 / rawCap : 0;
      const rttBasedIntervalMs = lastRttMs === null ? 0 : lastRttMs * rttMultiplier;
      const rawIntervalMs = Math.max(floorIntervalMs, capIntervalMs, rttBasedIntervalMs);
      nextNotBeforeMs = deps.clock.now() + clamp(rawIntervalMs, PACING_MIN_MS, PACING_MAX_MS);
    }
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
    startKeepAliveTimer(channel);

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
  // Observation (M2/M3, binding).
  // ---------------------------------------------------------------------

  async function pollObservationSample(channel: RawUdsChannel, did: number): Promise<{ raw: Uint8Array | null; rttMs: number }> {
    const startedMs = deps.clock.now();
    const outcome = await resolveOneDid(channel, did, requestTimeoutMs, 0, deps.clock); // no 0x78 extension budget during observation re-polls -- a stalling ECU just costs this one tick's sample.
    const rttMs = Math.max(0, deps.clock.now() - startedMs);
    return { raw: outcome.kind === 'responder' && outcome.raw !== undefined ? outcome.raw : null, rttMs };
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
    channel: RawUdsChannel,
    windowMs: number,
  ): Promise<'complete' | 'cutShort' | 'stopped'> {
    const dids = [...observationSeries.keys()];
    const observationStartedAtMs = deps.clock.now();
    if (dids.length === 0) return 'complete';

    while (deps.clock.now() - observationStartedAtMs < windowMs) {
      if (myGeneration !== generation || stopped) return 'stopped';
      if (observationCutShort) return 'cutShort';
      const roundStartMs = deps.clock.now();
      for (const did of dids) {
        if (myGeneration !== generation || stopped) return 'stopped';
        if (observationCutShort) return 'cutShort';
        const { raw } = await pollObservationSample(channel, did);
        if (myGeneration !== generation) return 'stopped';
        if (raw !== null) {
          observationSeries.get(did)?.push({ tMs: deps.clock.now() - observationStartedAtMs, raw });
        }
      }
      const roundElapsedMs = deps.clock.now() - roundStartMs;
      const degraded = roundElapsedMs > OBSERVATION_ROUND_TARGET_MS;
      emit({ observationElapsedMs: deps.clock.now() - observationStartedAtMs, observationCadenceDegraded: degraded });
      if (!degraded) await waitMs(OBSERVATION_ROUND_TARGET_MS - roundElapsedMs);
      if (myGeneration !== generation || stopped) return 'stopped';
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

  async function runObservationOnChannel(myGeneration: number, channel: RawUdsChannel, windowMs: number): Promise<void> {
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
    startKeepAliveTimer(channel);
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
      paused = false;
      stopped = false;
      observationCutShort = false;
      requestsIssued = 0;
      startedAtMs = deps.clock.now();
      observationSeries.clear();
      emit({ ...INITIAL_SNAPSHOT, error: null, phase: 'sweeping' });
      void openTransportAndSweep(myGeneration);
    },

    pause(): void {
      if (snapshot.phase !== 'sweeping') return;
      paused = true;
    },

    resume(): void {
      if (snapshot.phase !== 'paused' || plan === null || activeChannel === null) return;
      paused = false;
      const myGeneration = generation; // SAME generation -- the transport/channel/reservation are all still this run's own.
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
      stopped = true;
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
        paused = false;
        stopped = false;
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
      paused = false;
      stopped = false;
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
