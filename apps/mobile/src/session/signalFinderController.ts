/**
 * Signal Finder controller (ticket P4l S2; contracts.md "Signal Finder
 * (Phase 4l, 2026-08-29)", items 2–4, binding).
 *
 * The user's own framing after field tests 1–4: "I want a tool that has
 * targets: find the brake → reads the channels we think carry the brake →
 * tells me to press the brake 5 times → shows the candidates that changed →
 * brake found; then the next missing signal."
 *
 * What this module owns (and ONLY this):
 *   1. Resolving the DID list per ECU for a target — its hypotheses (data,
 *      `@circuit/core`'s `signalFinder/targets.ts`) plus cached responders of
 *      that ECU from previous sweep runs, filtered by the target's expected
 *      shape and capped at {@link MAX_DIDS_PER_PASS}.
 *   2. The transport LIFECYCLE per ECU pass — acquire the `'sweep'`
 *      reservation ONCE for the whole session, then, per ECU, open a FRESH
 *      transport via the injected `transportFactory`, run, close; release
 *      strictly after the last close, on every path. Identical discipline to
 *      `didSweepController.ts`, whose `createRawUdsChannel` is IMPORTED here
 *      rather than re-implemented (no second copy of the wire protocol).
 *   3. Pacing the driver through the metronome and recording what came back.
 *      The polling itself is ONE `runDidObservation` call per ECU pass — the
 *      whole metronome window, exactly as the sweep controller does for its
 *      own phases; this module never re-implements round-robin, keep-alive,
 *      pacing or the error budget.
 *
 * What it deliberately does NOT own: the change rule and the verdicts (pure,
 * `@circuit/core`'s `signalFinder/scoring.ts`), and every vehicle constant
 * (data, the target catalog). No ECU address, DID or decode is written in
 * this file.
 *
 * Both existing flows (the DID sweep and the batched/focused observation)
 * are untouched — this controller shares their reservation and their channel
 * builder, and nothing else.
 */
import {
  ASSUMED_GUIDED_REQ_PER_SEC,
  buildMetronomeTimeline,
  findSignalTarget,
  isAsciiLike,
  metronomeCountdownMs,
  metronomeStepAt,
  nextDiscoveryStep,
  resolveSignalTargetCatalog,
  runDidObservation,
  scoreSignalCandidates,
  targetHypothesisEcus,
  type DidSweepControl,
  type DidSweepPacing,
  type MetronomeStep,
  type MetronomeStepKind,
  type MetronomeTimeline,
  type MonotonicClock,
  type NextDiscoveryStep,
  type ObdTransport,
  type SignalCandidateScore,
  type SignalEngineRequirement,
  type SignalFinderSample,
  type SignalTargetCatalog,
  type SignalTargetDefinition,
  type SignalTargetId,
} from '@circuit/core';
import { createRawUdsChannel } from './didSweepController';
import { enetAdapterReservation as sharedEnetAdapterReservation, type EnetAdapterReservation, type EnetAdapterToken } from './enetAdapterReservation';
import { hexToBytes, type DidSweepStore, type VehicleProfileBinding, type VehicleProfileBindingStore } from '../persistence/didSweepStore';
import { noopSignalFinderHaptics, type SignalFinderHaptics } from './signalFinderHaptics';

/** Item 2 (binding): "it polls at most 16 DIDs per ECU per pass". Same hard ceiling as the batched observation's `MAX_BATCH_SIZE`, for the same reason: a pass only works if every DID in it can be sampled enough times inside one window. */
export const MAX_DIDS_PER_PASS = 16;

/** Item 3 (binding): "Insufficient samples (< 2 per window)". */
const MIN_SAMPLES_PER_WINDOW = 2;

/** How often the on-screen prompt/countdown is recomputed while a pass is running. */
const TICK_INTERVAL_MS = 100;

/** Round-robin rounds per second handed to `runDidObservation`, clamped so a huge/tiny DID count can never ask for an absurd cadence. */
const MIN_TARGET_HZ = 0.5;
const MAX_TARGET_HZ = 20;

const RESERVATION_BUSY_MESSAGE = 'The adapter is in use (telemetry, the DID probe or a sweep) -- stop it first.';

export type SignalFinderPhase = 'idle' | 'preparing' | 'reading' | 'scoring' | 'result' | 'error';

/** One ECU's worth of work: which DIDs will be polled, and where each came from. */
export interface SignalFinderEcuPass {
  ecu: number;
  /** The full poll list, hypotheses first, capped at {@link MAX_DIDS_PER_PASS}. */
  dids: readonly number[];
  /** The subset that came from the target's own hypotheses (data). */
  hypothesisDids: readonly number[];
  /** The subset that came from `did_sweep_responders` of earlier sweep runs on this ECU. */
  cachedDids: readonly number[];
}

export interface SignalFinderStepSnapshot {
  /** 0-based index into the metronome timeline. */
  index: number;
  total: number;
  kind: MetronomeStepKind;
  repetition: number;
  prompt: string;
  /** Milliseconds left in this step — the big on-screen countdown. */
  countdownMs: number;
}

export interface SignalFinderSnapshot {
  phase: SignalFinderPhase;
  profileId: string;
  targetId: SignalTargetId | null;
  targetLabel: string | null;
  engineRequirement: SignalEngineRequirement | null;
  /** The metronome this session is (or was) paced by; `null` before a find. */
  timeline: MetronomeTimeline | null;
  passes: readonly SignalFinderEcuPass[];
  /** 0-based index into `passes` while reading; `-1` otherwise. */
  passIndex: number;
  /** The ECU currently being read, or `null`. */
  ecu: number | null;
  step: SignalFinderStepSnapshot | null;
  /** Ranked verdicts, `found` first (see `scoreSignalCandidates`). */
  scores: readonly SignalCandidateScore[];
  /** Item 2 (binding): "Reads must tolerate NRC (→ 'no response' for that DID)." */
  noResponseDids: readonly { ecu: number; did: number }[];
  /** Item 4 (binding): the next concrete step with its duration — present whenever nothing was `found`. */
  nextStep: NextDiscoveryStep | null;
  /** Channels already written into the vehicle profile by {@link SignalFinderController.confirmBinding}. */
  confirmedChannels: readonly string[];
  /** Fresh per `find()` — the id carried into the export. */
  sessionId: string | null;
  startedAtUtc: string | null;
  /** The request rate the durations/window sizes were derived from. */
  measuredReqPerSec: number;
  /** Non-null exactly when something went wrong; never thrown across this API. */
  error: string | null;
}

export interface SignalFinderControllerDeps {
  /** A FRESH transport per ECU pass — this factory is called by the controller, never connected/closed by the screen. */
  transportFactory: () => ObdTransport;
  testerAddress: number;
  clock: MonotonicClock;
  /** Wall-clock ISO string source (defaults to `new Date().toISOString()`) — injected so tests are deterministic. */
  nowUtc?: () => string;
  /** Which vehicle profile's targets/bindings this session works against. Default `'generic'` (hypothesis-free). */
  profileId?: string;
  /** Test seam: overrides the catalog `profileId` would resolve to. Production never passes this. */
  catalog?: SignalTargetCatalog;
  /** Single-client adapter reservation — the SAME instance the sweep/probe/provider share. */
  reservation?: EnetAdapterReservation;
  pacing?: DidSweepPacing;
  requestTimeoutMs?: number;
  maxResponsePendingExtensions?: number;
  /** Read-only here: the source of cached responders per ECU (item 2). Omitted → hypotheses only. */
  sweepStore?: DidSweepStore;
  /** Where "Confirm as <target>" writes. Omitted → `confirmBinding` is a no-op returning `null` (web preview). */
  bindingStore?: VehicleProfileBindingStore;
  haptics?: SignalFinderHaptics;
  /** Default {@link MAX_DIDS_PER_PASS}; values above it are clamped, never accepted. */
  maxDidsPerPass?: number;
  /** The measured request rate to size windows/durations from. Default {@link ASSUMED_GUIDED_REQ_PER_SEC}. */
  measuredReqPerSec?: number;
}

export interface SignalFinderController {
  subscribe(cb: (snapshot: SignalFinderSnapshot) => void): () => void;
  getSnapshot(): SignalFinderSnapshot;
  /** Runs one full find for `targetId`. Resolves when the session has finished (or errored) — never rejects. */
  find(targetId: SignalTargetId): Promise<void>;
  /** Ends the run early. Resolves only once the transport is closed and the reservation released. */
  stop(): Promise<void>;
  /** Every sample this session collected, for the export. */
  getSamples(): readonly SignalFinderSample[];
  /** Item 5 (binding): writes `score` into the persisted vehicle profile as `channel`'s binding. `null` when no binding store is wired. */
  confirmBinding(channel: SignalTargetId, score: SignalCandidateScore): Promise<VehicleProfileBinding | null>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Item 2 (binding): cached responders are "filtered by the target's expected
 * shape (1–4 bytes for switches/analogs; blocks with per-byte diff allowed)".
 * Short responders come first (they decode to one number and score directly);
 * mid-size blocks follow, scored per byte offset by
 * `scoreSignalCandidates`. ASCII-looking responses are identification
 * strings, never physical channels — excluded at any length (the same
 * `isAsciiLike` rule the sweep's own candidate filter uses).
 */
function partitionCachedResponders(records: readonly { did: number; rawHex: string; length: number }[]): {
  short: number[];
  blocks: number[];
} {
  const short: number[] = [];
  const blocks: number[] = [];
  for (const record of records) {
    const raw = hexToBytes(record.rawHex);
    if (isAsciiLike(raw)) continue;
    if (record.length >= 1 && record.length <= 4) short.push(record.did);
    else if (record.length >= 5 && record.length <= 32) blocks.push(record.did);
  }
  short.sort((a, b) => a - b);
  blocks.sort((a, b) => a - b);
  return { short, blocks };
}

export function createSignalFinderController(deps: SignalFinderControllerDeps): SignalFinderController {
  const reservation = deps.reservation ?? sharedEnetAdapterReservation;
  const nowUtc = deps.nowUtc ?? ((): string => new Date().toISOString());
  const profileId = deps.profileId ?? 'generic';
  const catalog = deps.catalog ?? resolveSignalTargetCatalog(profileId);
  const haptics = deps.haptics ?? noopSignalFinderHaptics;
  const maxDidsPerPass = clamp(Math.floor(deps.maxDidsPerPass ?? MAX_DIDS_PER_PASS), 1, MAX_DIDS_PER_PASS);
  const measuredReqPerSec =
    deps.measuredReqPerSec !== undefined && Number.isFinite(deps.measuredReqPerSec) && deps.measuredReqPerSec > 0
      ? deps.measuredReqPerSec
      : ASSUMED_GUIDED_REQ_PER_SEC;

  const listeners = new Set<(snapshot: SignalFinderSnapshot) => void>();
  let snapshot: SignalFinderSnapshot = {
    phase: 'idle',
    profileId,
    targetId: null,
    targetLabel: null,
    engineRequirement: null,
    timeline: null,
    passes: [],
    passIndex: -1,
    ecu: null,
    step: null,
    scores: [],
    noResponseDids: [],
    nextStep: null,
    confirmedChannels: [],
    sessionId: null,
    startedAtUtc: null,
    measuredReqPerSec,
    error: null,
  };

  let samples: SignalFinderSample[] = [];
  let generation = 0;
  let activeRun: Promise<void> | null = null;
  let control: DidSweepControl = { paused: false, stopped: false };
  let activeTransport: ObdTransport | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  function emit(patch: Partial<SignalFinderSnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[signalFinderController] a subscriber threw -- ignored', error);
      }
    }
  }

  function stopTicker(): void {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  /** Drives the on-screen prompt/countdown (and the haptic) from the pass's own anchor. */
  function startTicker(timeline: MetronomeTimeline, anchorMs: number): void {
    stopTicker();
    let lastStepIndex: number | null = null;
    const tick = (): void => {
      const elapsedMs = deps.clock.now() - anchorMs;
      const step: MetronomeStep | null = metronomeStepAt(timeline, elapsedMs);
      if (step === null) return;
      if (step.index !== lastStepIndex) {
        lastStepIndex = step.index;
        try {
          haptics.step(step.kind);
        } catch {
          // A haptics implementation must never be able to stall the metronome.
        }
      }
      emit({
        step: {
          index: step.index,
          total: timeline.steps.length,
          kind: step.kind,
          repetition: step.repetition,
          prompt: step.prompt,
          countdownMs: metronomeCountdownMs(step, elapsedMs),
        },
      });
    };
    tick();
    tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  }

  async function teardownTransport(): Promise<void> {
    const transport = activeTransport;
    if (transport === null) return;
    activeTransport = null;
    try {
      await transport.close();
    } catch {
      // A transport that fails to close is already gone as far as we care --
      // never let it block the reservation release below.
    }
  }

  /** Item 2 (binding): the DID list for ONE ECU — hypotheses first, then cached responders of that ECU, capped. */
  async function buildPass(target: SignalTargetDefinition, ecu: number): Promise<SignalFinderEcuPass> {
    const hypothesisDids = target.hypotheses.filter((h) => h.ecu === ecu).map((h) => h.did);
    const seen = new Set(hypothesisDids);
    const cachedDids: number[] = [];
    if (deps.sweepStore !== undefined) {
      const runs = await deps.sweepStore.listRuns();
      const records: { did: number; rawHex: string; length: number }[] = [];
      const seenCached = new Set<number>();
      for (const run of runs) {
        if (run.targetAddress !== ecu) continue;
        for (const responder of await deps.sweepStore.getResponders(run.runId)) {
          if (seenCached.has(responder.did)) continue;
          seenCached.add(responder.did);
          records.push({ did: responder.did, rawHex: responder.rawHex, length: responder.length });
        }
      }
      const { short, blocks } = partitionCachedResponders(records);
      for (const did of [...short, ...blocks]) {
        if (seen.has(did)) continue;
        seen.add(did);
        cachedDids.push(did);
      }
    }
    const dids = [...hypothesisDids, ...cachedDids].slice(0, maxDidsPerPass);
    const keptCached = cachedDids.filter((did) => dids.includes(did));
    return { ecu, dids, hypothesisDids, cachedDids: keptCached };
  }

  /** Runs the whole metronome once against ONE ECU on a FRESH transport. */
  async function runPass(myGeneration: number, pass: SignalFinderEcuPass, timeline: MetronomeTimeline): Promise<void> {
    const transport = deps.transportFactory();
    activeTransport = transport;
    try {
      await transport.connect();
      if (myGeneration !== generation || control.stopped) return;
      const channel = createRawUdsChannel(transport, deps.testerAddress, pass.ecu);
      const targetHz = clamp(measuredReqPerSec / Math.max(1, pass.dids.length), MIN_TARGET_HZ, MAX_TARGET_HZ);
      const result = await runDidObservation({
        responders: pass.dids,
        transport: channel,
        clock: deps.clock,
        durationMs: timeline.pollDurationMs,
        targetHz,
        pacing: deps.pacing,
        control,
        requestTimeoutMs: deps.requestTimeoutMs,
        maxResponsePendingExtensions: deps.maxResponsePendingExtensions,
        onStarted: (startedAtMs) => {
          if (myGeneration === generation) startTicker(timeline, startedAtMs);
        },
      });
      stopTicker();
      // `series[].samples[].tMs` is already relative to THIS pass's own start
      // -- the same origin the metronome timeline uses.
      for (const series of result.series) {
        for (const sample of series.samples) {
          samples.push({ ecu: pass.ecu, did: series.did, tMs: sample.tMs, raw: sample.raw });
        }
      }
    } finally {
      stopTicker();
      await teardownTransport();
    }
  }

  async function doFind(myGeneration: number, target: SignalTargetDefinition): Promise<void> {
    let token: EnetAdapterToken | null = null;
    try {
      emit({
        phase: 'preparing',
        targetId: target.id,
        targetLabel: target.label,
        engineRequirement: target.engineRequirement,
        passes: [],
        passIndex: -1,
        ecu: null,
        step: null,
        scores: [],
        noResponseDids: [],
        nextStep: null,
        error: null,
        sessionId: `signal-finder-${deps.clock.now()}-${Math.random().toString(36).slice(2, 8)}`,
        startedAtUtc: nowUtc(),
        timeline: null,
      });
      samples = [];

      // Every ECU worth reading: the target's own hypothesis ECUs plus any
      // ECU earlier sweeps found responders on (an unprofiled car has no
      // hypotheses at all, so the cache is the only source there).
      const ecus = new Set<number>(targetHypothesisEcus(target));
      if (deps.sweepStore !== undefined) {
        for (const run of await deps.sweepStore.listRuns()) {
          if (run.targetAddress !== null) ecus.add(run.targetAddress);
        }
      }
      const passes: SignalFinderEcuPass[] = [];
      for (const ecu of [...ecus].sort((a, b) => a - b)) {
        const pass = await buildPass(target, ecu);
        if (pass.dids.length > 0) passes.push(pass);
      }

      const widestPass = passes.reduce((max, pass) => Math.max(max, pass.dids.length), 1);
      const timeline = buildMetronomeTimeline(target.actionScript, {
        verbs: target.verbs,
        samplesPerSecPerDid: measuredReqPerSec / widestPass,
        minSamplesPerWindow: MIN_SAMPLES_PER_WINDOW,
      });
      emit({ passes, timeline });

      if (passes.length === 0) {
        // Item 4 (binding): never "no brake on this car" -- say what was read
        // (nothing) and what the next concrete step is.
        emit({
          phase: 'result',
          nextStep: nextDiscoveryStep(target, measuredReqPerSec),
          scores: [],
          step: null,
        });
        return;
      }

      token = reservation.tryAcquire('sweep');
      if (token === null && reservation.isReleasePending()) {
        // A prior holder's close+release is already in flight -- wait it out
        // once rather than reporting a busy adapter (same discipline as the
        // sweep controller's own reacquire).
        await reservation.whenFree();
        token = reservation.tryAcquire('sweep');
      }
      if (token === null) {
        emit({ phase: 'error', error: RESERVATION_BUSY_MESSAGE, step: null });
        return;
      }

      emit({ phase: 'reading' });
      for (let index = 0; index < passes.length; index += 1) {
        if (myGeneration !== generation || control.stopped) break;
        const pass = passes[index] as SignalFinderEcuPass;
        emit({ passIndex: index, ecu: pass.ecu });
        await runPass(myGeneration, pass, timeline);
      }

      if (myGeneration !== generation) return;
      emit({ phase: 'scoring', step: null, ecu: null, passIndex: -1 });
      const scores = scoreSignalCandidates({
        samples,
        timeline,
        shape: target.expectedShape,
        options: { minSamplesPerWindow: MIN_SAMPLES_PER_WINDOW },
      });
      const answered = new Set(samples.map((sample) => `${sample.ecu}:${sample.did}`));
      const noResponseDids: { ecu: number; did: number }[] = [];
      for (const pass of passes) {
        for (const did of pass.dids) {
          if (!answered.has(`${pass.ecu}:${did}`)) noResponseDids.push({ ecu: pass.ecu, did });
        }
      }
      const found = scores.some((score) => score.verdict === 'found');
      emit({
        phase: 'result',
        scores,
        noResponseDids,
        // Item 4 (binding). NOT excluding the ECUs this session read: reading
        // 16 hypothesis/cached DIDs on an ECU is not the same as SWEEPING its
        // remaining range, and the unswept remainder is exactly the step the
        // user needs told about next.
        nextStep: found ? null : nextDiscoveryStep(target, measuredReqPerSec),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (myGeneration === generation) emit({ phase: 'error', error: message, step: null, ecu: null, passIndex: -1 });
    } finally {
      stopTicker();
      await teardownTransport();
      if (token !== null) reservation.release(token);
    }
  }

  return {
    subscribe(cb): () => void {
      listeners.add(cb);
      cb(snapshot);
      return () => listeners.delete(cb);
    },

    getSnapshot(): SignalFinderSnapshot {
      return snapshot;
    },

    async find(targetId): Promise<void> {
      if (snapshot.phase === 'preparing' || snapshot.phase === 'reading' || snapshot.phase === 'scoring') return;
      const target = findSignalTarget(catalog, targetId);
      if (target === null) {
        emit({ phase: 'error', error: `No target definition for "${targetId}" in profile "${catalog.profileId}".` });
        return;
      }
      generation += 1;
      const myGeneration = generation;
      control = { paused: false, stopped: false };
      const run = doFind(myGeneration, target);
      activeRun = run;
      await run;
      if (activeRun === run) activeRun = null;
    },

    async stop(): Promise<void> {
      control.stopped = true;
      const run = activeRun;
      if (run !== null) await run.catch(() => undefined);
      stopTicker();
    },

    getSamples(): readonly SignalFinderSample[] {
      return samples;
    },

    async confirmBinding(channel, score): Promise<VehicleProfileBinding | null> {
      if (deps.bindingStore === undefined) return null;
      const target = findSignalTarget(catalog, channel);
      const hypothesis = target?.hypotheses.find((h) => h.ecu === score.ecu && h.did === score.did) ?? null;
      const binding: VehicleProfileBinding = {
        profileId,
        channel,
        ecu: score.ecu,
        did: score.did,
        length: score.length,
        // The hypothesis' own decode note when the winner IS one of them,
        // else the honest observation: which byte offset moved, between which
        // raw levels.
        decode:
          hypothesis?.decode ??
          `${score.byteOffset === null ? 'whole response' : `byte ${score.byteOffset}`}: ${score.restValueHex ?? '?'} at rest, ${score.min ?? '?'}..${score.max ?? '?'} observed`,
        status: 'field-confirmed',
        evidenceJson: JSON.stringify({
          sessionId: snapshot.sessionId,
          verdict: score.verdict,
          matchedEdges: score.matchedEdges,
          expectedEdges: score.expectedEdges,
          baselineChanges: score.baselineChanges,
          responseBaselineChanges: score.responseBaselineChanges,
          sampleCount: score.sampleCount,
          byteOffset: score.byteOffset,
          correlationSign: score.correlationSign,
          restValueHex: score.restValueHex,
          min: score.min,
          max: score.max,
        }),
        updatedAtUtc: nowUtc(),
      };
      await deps.bindingStore.upsertBinding(binding);
      emit({ confirmedChannels: [...new Set([...snapshot.confirmedChannels, channel])] });
      return binding;
    },
  };
}
