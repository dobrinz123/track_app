/**
 * ENET auto-discovery & DID sweep addendum (contracts.md, binding, Phase 4f)
 * -- the dev DID-sweep screen's pure state machine: range/plan, start/pause/
 * resume/stop, progress, and (after the sweep, or on demand) an observation
 * phase that re-polls the responders found and classifies them via
 * `@circuit/core`'s `classifyResponders`. No react-native, no react import --
 * only `@circuit/core` and this app's own `enetAdapterReservation` module, so
 * it is directly importable by vitest (same "extract the pure logic"
 * discipline as `didProbe.ts`).
 *
 * CORE API IN FLUX (P4f-FIX1, a PARALLEL ticket the foreman flagged mid-way
 * through this one): `@circuit/core`'s `runDidSweep` is being changed
 * (observed toggling between the OLD and NEW shape in the working tree
 * several times while this ticket was in progress -- not yet committed/
 * stable as of this writing) to build the 0x22 request itself and take a
 * low-level `sendRequest(pdu: Uint8Array) => Promise<Uint8Array | 'timeout'>`
 * (raw UDS response bytes) -- the runner parses/correlates/strips the DID
 * echo and handles 0x78 itself, and accepts/returns a reusable
 * `DidSweepAccumulator` across paused/resumed calls (`createDidSweepAccumulator`).
 * This module is written against THAT shape, matching what is in the tree as
 * of this ticket's final integration pass -- `DidSweepScreen.tsx`'s own
 * `sendRawUdsRequest` (open transport, frame the pdu, wait for a correlated
 * diagnostic response) is passed straight through as `sendRequest`, no
 * adapter layer needed. If a later `packages/core` state reverts to the
 * OLD per-DID `request: (did) => Promise<UdsParsedResponse | 'timeout'>`
 * shape, `runSweepLoop` below is the ONE place that needs a small adapter
 * (build the DID's PDU, call `sendRequest`, parse + strip the echoed DID)
 * restored in front of it -- this controller's own public
 * `DidSweepControllerDeps.sendRequest` shape does not need to change either
 * way.
 */
import {
  assertAllowedRequest,
  buildReadDataByIdentifierRequest,
  classifyResponders,
  createDidSweepAccumulator,
  createDidSweepPlan,
  enetSpecsFromSuggestion,
  extractReadDataByIdentifierData,
  parseUdsResponse,
  runDidSweep,
  type DidHeuristicContext,
  type DidHeuristicSuggestion,
  type DidResponderSample,
  type DidSweepAccumulator,
  type DidSweepControl,
  type DidSweepPacing,
  type DidSweepPlan,
  type DidSweepRange,
  type DidSweepResponder,
  type EnetChannelSpec,
  type MonotonicClock,
  type TelemetryChannelId,
} from '@circuit/core';
import { enetAdapterReservation as sharedEnetAdapterReservation, type EnetAdapterReservation, type EnetAdapterToken } from './enetAdapterReservation';

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
  /** Non-null exactly when something went wrong (invalid range, reservation refused) -- never thrown across this API. */
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
  error: null,
};

const RESERVATION_BUSY_MESSAGE = 'The adapter is in use (telemetry or the DID probe) -- stop it first.';

export interface DidSweepControllerDeps {
  /** Low-level raw transport hook -- see this module's own doc comment. Sends `pdu` and resolves with the raw UDS response PDU bytes, or `'timeout'`. May be called more than once per DID (once per 0x78 extension) by `@circuit/core`'s `runDidSweep`; this controller's own observation phase calls it once per re-poll tick. */
  sendRequest: (pdu: Uint8Array) => Promise<Uint8Array | 'timeout'>;
  clock: MonotonicClock;
  pacing?: DidSweepPacing;
  /** Single-client adapter reservation (binding: "Exclusive via the reservation ('sweep' owner)"). Test-only injection seam (mirrors `telemetryProvider.ts`'s own) -- defaults to the real shared singleton. */
  reservation?: EnetAdapterReservation;
  /** default 60_000 (addendum: "a user-chosen window (default 60 s)"). */
  observationWindowMs?: number;
  /** default 1_000 (addendum: "~1 Hz"). */
  observationIntervalMs?: number;
  /**
   * Called once, when the observation phase finishes, to supply
   * `classifyResponders`'s optional `context` (addendum: "speed-like:
   * correlates with GNSS speed when available"). Omitted entirely when the
   * caller has no GNSS speed series to offer (classification then simply
   * never scores a `speed` candidate above zero -- `classifyResponders`'s
   * own documented behavior for a missing reference).
   */
  gnssSpeedContext?: () => DidHeuristicContext;
}

export interface DidSweepController {
  subscribe(cb: (s: DidSweepSnapshot) => void): () => void;
  getSnapshot(): DidSweepSnapshot;
  /** Acquires the reservation and starts a fresh sweep over `[from, to]` (defaults: the full 0x0000-0xFFFF range). Refused (via `error`) if the reservation is held by another owner, or the range is invalid. */
  start(range?: { from?: number; to?: number; priorityRanges?: readonly DidSweepRange[] }): void;
  /** Stops calling `next()` at the next DID boundary -- the underlying `runDidSweep` call resolves, phase becomes 'paused'. Reservation stays held. */
  pause(): void;
  /** Resumes a paused sweep (same plan + accumulator, so already-visited DIDs/results are never lost or revisited). */
  resume(): void;
  /** Stops the sweep (or observation) permanently and releases the reservation. Idempotent. */
  stop(): void;
  /** Starts the observation phase (addendum: "after the sweep, or on demand") over the responders found so far. No-op if there are none. */
  startObservation(windowMs?: number): void;
  /** Ends the observation phase early (before its window elapses) and computes suggestions from whatever was sampled so far. */
  stopObservationEarly(): void;
  /** Builds the `EnetChannelSpec` a "Tag as <channel>" tap writes -- `null` if `did` has no current suggestion (or the produced spec fails `@circuit/core`'s own validation). Pure; persistence (merge/validate/write) is the caller's job (`enetSettingsValidation.ts`'s `mergeEnetChannelSpecJson`). */
  buildTaggedSpec(did: number, channel: TelemetryChannelId, dateIso: string): EnetChannelSpec | null;
}

const DEFAULT_OBSERVATION_WINDOW_MS = 60_000;
const DEFAULT_OBSERVATION_INTERVAL_MS = 1_000;

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
  let control: DidSweepControl = { paused: false, stopped: false };
  let startedAtMs = 0;
  let requestsIssued = 0;
  /** Bumped on every `stop()`/`start()` -- a late async continuation (sweep or observation) from a superseded run checks this before touching `snapshot`. */
  let generation = 0;
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

  async function runSweepLoop(myGeneration: number): Promise<void> {
    if (plan === null || accumulator === null) return;
    const result = await runDidSweep({
      plan,
      sendRequest: deps.sendRequest,
      clock: deps.clock,
      pacing: deps.pacing,
      control,
      accumulator,
      onProgress: (progress) => {
        if (myGeneration !== generation) return;
        requestsIssued += 1;
        const elapsedS = Math.max(0.001, (deps.clock.now() - startedAtMs) / 1_000);
        emit({
          progress: { did: progress.did, index: progress.index, total: progress.total, reqPerSec: requestsIssued / elapsedS },
        });
      },
    });
    if (myGeneration !== generation) return; // superseded by a later stop()/start() -- discard silently.

    emit({
      responders: result.responders,
      nrcCounts: result.nrcCounts,
      timeouts: result.timeouts,
      unmatched: result.unmatched,
    });

    if (control.stopped) {
      emit({ phase: 'stopped' });
      releaseReservation();
      return;
    }
    if (control.paused) {
      emit({ phase: 'paused' });
      return; // reservation stays held -- resume() continues the SAME run.
    }
    // The plan is exhausted (peek() === null, `runDidSweep` returned without
    // pause/stop) -- the sweep finished on its own.
    emit({ phase: 'sweepComplete' });
    releaseReservation();
  }

  /**
   * One observation re-poll: builds/sends/parses a SINGLE ReadDataByIdentifier
   * request for `did` via the SAME raw `sendRequest` primitive the sweep
   * itself uses, correlating the response (positive SID 0x62 + matching
   * echoed DID) -- anything else (timeout, NRC, wrong/missing echo) simply
   * contributes no sample this tick (never a thrown error, never a paused/
   * stopped sweep). Deliberately does NOT extend on a 0x78 responsePending
   * during observation (unlike the sweep itself, which the core runner
   * handles) -- a stalling ECU mid-observation just costs this one tick's
   * sample, not the whole re-poll loop.
   */
  async function pollObservationSample(did: number): Promise<Uint8Array | null> {
    let pdu: Uint8Array;
    try {
      pdu = buildReadDataByIdentifierRequest(did);
      assertAllowedRequest(pdu); // hard gate, re-checked even though this builder only ever emits 0x22.
    } catch {
      return null;
    }
    let raw: Uint8Array | 'timeout';
    try {
      raw = await deps.sendRequest(pdu);
    } catch {
      return null;
    }
    if (raw === 'timeout') return null;
    let parsed: ReturnType<typeof parseUdsResponse>;
    try {
      parsed = parseUdsResponse(raw);
    } catch {
      return null;
    }
    if (parsed.kind !== 'positive' || parsed.sid !== 0x62) return null;
    try {
      return extractReadDataByIdentifierData(parsed.sid, parsed.data, did);
    } catch {
      return null;
    }
  }

  async function runObservationLoop(myGeneration: number, windowMs: number, intervalMs: number): Promise<void> {
    const dids = [...observationSeries.keys()];
    const observationStartedAtMs = deps.clock.now();
    if (dids.length === 0) {
      finishObservation(myGeneration);
      return;
    }
    while (myGeneration === generation && !control.stopped && deps.clock.now() - observationStartedAtMs < windowMs) {
      for (const did of dids) {
        if (myGeneration !== generation || control.stopped) break;
        const dataBytes = await pollObservationSample(did);
        if (myGeneration !== generation) return;
        if (dataBytes !== null) {
          observationSeries.get(did)?.push({ tMs: deps.clock.now() - observationStartedAtMs, raw: dataBytes });
        }
        emit({ observationElapsedMs: deps.clock.now() - observationStartedAtMs });
      }
      if (myGeneration !== generation || control.stopped) break;
      await waitMs(intervalMs);
    }
    if (myGeneration !== generation) return;
    finishObservation(myGeneration);
  }

  function finishObservation(myGeneration: number): void {
    if (myGeneration !== generation) return;
    const series = [...observationSeries.entries()].map(([did, samples]) => ({ did, samples }));
    const context = deps.gnssSpeedContext?.();
    const suggestions = classifyResponders(series, context);
    emit({ phase: 'observationComplete', suggestions });
    releaseReservation();
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
      generation += 1;
      const myGeneration = generation;
      const acquired = reservation.tryAcquire('sweep');
      if (acquired === null) {
        emit({ ...INITIAL_SNAPSHOT, error: RESERVATION_BUSY_MESSAGE });
        return;
      }
      token = acquired;
      requestsIssued = 0;
      startedAtMs = deps.clock.now();
      observationSeries.clear();
      control = { paused: false, stopped: false };
      try {
        plan = createDidSweepPlan(range);
      } catch (error) {
        releaseReservation();
        emit({ ...INITIAL_SNAPSHOT, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      accumulator = createDidSweepAccumulator();
      emit({ ...INITIAL_SNAPSHOT, error: null, phase: 'sweeping' });
      void runSweepLoop(myGeneration);
    },

    pause(): void {
      if (snapshot.phase !== 'sweeping') return;
      control.paused = true;
    },

    resume(): void {
      if (snapshot.phase !== 'paused' || plan === null) return;
      control = { paused: false, stopped: false };
      emit({ phase: 'sweeping' });
      void runSweepLoop(generation);
    },

    stop(): void {
      generation += 1; // supersede any in-flight sweep/observation continuation.
      control.stopped = true;
      releaseReservation();
      plan = null;
      accumulator = null;
      emit({ phase: 'stopped' });
    },

    startObservation(windowMs = DEFAULT_OBSERVATION_WINDOW_MS): void {
      if (snapshot.phase !== 'sweepComplete' && snapshot.phase !== 'paused' && snapshot.phase !== 'stopped') return;
      if (snapshot.responders.length === 0) return;
      generation += 1;
      const myGeneration = generation;
      const acquired = reservation.tryAcquire('sweep');
      if (acquired === null) {
        emit({ error: RESERVATION_BUSY_MESSAGE });
        return;
      }
      token = acquired;
      control = { paused: false, stopped: false };
      observationSeries.clear();
      for (const responder of snapshot.responders) observationSeries.set(responder.did, []);
      emit({ phase: 'observing', observationElapsedMs: 0, error: null });
      void runObservationLoop(myGeneration, windowMs, deps.observationIntervalMs ?? DEFAULT_OBSERVATION_INTERVAL_MS);
    },

    stopObservationEarly(): void {
      if (snapshot.phase !== 'observing') return;
      control.stopped = true;
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
