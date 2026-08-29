/**
 * Signal Finder controller (ticket P4m M2; contracts.md "Signal Finder
 * REVISION (2026-08-29, after field test 5)", items 9–12, binding).
 *
 * WHAT FIELD TEST 5 CHANGED. Build 5 (P4l) read at most 16 DIDs per ECU per
 * PASS and ran ONE FULL METRONOME PER PASS: 91 passes on the user's Supra,
 * hypotheses queued last, ~40 real pedal presses before he stopped. His
 * verdict: "inhuman to press the brake that many times — the tests are
 * robotic". Worse, every DID got 1–2 samples per window (`insufficient`
 * everywhere) and the 1372 DIDs never polled at all were reported as "No
 * response". The data he collected anyway contained the brake pedal (DME
 * 0x4002) and the accelerator idle flag (DME 0x4007).
 *
 * SO THIS MODULE NOW OWNS, and only this:
 *   1. ONE HUMAN SCRIPT PER FIND (item 9). `find()` = one metronome, ~21 s.
 *      A second script happens only when the user taps Next round
 *      ({@link SignalFinderController.nextRound}) — never on its own.
 *   2. THE DID BUDGET (item 10, `@circuit/core`'s `planFinderRun`): the DID
 *      COUNT bends to the measured request rate, so every DID in the round
 *      gets ≥ 3 samples per 3 s window. Priority: the target's hypotheses on
 *      every ECU, then DIDs with prior CHANGE evidence (sweep observation
 *      summaries, any rank other than static/insufficient), then plain cached
 *      responders. What does not fit is "not read", with its count.
 *   3. ONE TRANSPORT SESSION FOR EVERY ECU (item 10). HSFZ carries the target
 *      address per frame, so one socket serves 0x12 and 0x29 alike: the round
 *      opens one channel per ECU over the SAME transport
 *      ({@link createEcuChannels}) and lets `@circuit/core`'s
 *      `runFinderRound` poll COMPOSITE (ecu, did) entries across them. No
 *      second socket, no second reservation.
 *   5. P4m-FIX1 (Codex P4m-REV1): a ~2 s PROBE before every script, so the
 *      budget rests on a MEASURED rate and a silent ECU is dropped rather
 *      than left to eat the live ECU's samples; and ONLY the DIDs a request
 *      actually went out for are counted as read.
 *   4. The transport LIFECYCLE per round — acquire the reservation, open a
 *      FRESH transport, run, close, release, strictly in that order on every
 *      path (identical discipline to `didSweepController.ts`, whose
 *      `createRawUdsChannel` is IMPORTED here rather than re-implemented).
 *
 * What it deliberately does NOT own: the change rule and the verdicts (pure,
 * `@circuit/core`'s `signalFinder/scoring.ts`), the budget arithmetic (pure,
 * `signalFinder/plan.ts`), and every vehicle constant (data, the target
 * catalog). No ECU address, DID or decode is written in this file.
 *
 * Both existing flows (the DID sweep and the batched/focused observation) are
 * untouched — this controller shares their reservation and their channel
 * builder, and nothing else.
 */
import {
  ASSUMED_GUIDED_REQ_PER_SEC,
  FINDER_BUDGET_MAX,
  FINDER_PROBE_DURATION_MS,
  FINDER_REQUEST_TIMEOUT_MS,
  buildMetronomeTimeline,
  computeFinderDidBudget,
  findSignalTarget,
  isAsciiLike,
  metronomeCountdownMs,
  metronomeStepAt,
  nextDiscoveryStep,
  planFinderRun,
  resolveSignalActionVerbs,
  resolveSignalTargetCatalog,
  runFinderRound,
  scoreSignalCandidates,
  summarizeFinderProbe,
  targetDeclaredFlagDids,
  targetHypothesisEcus,
  type DidSweepControl,
  type FinderRateSource,
  type FinderRunPlan,
  type MetronomeStep,
  type MetronomeStepKind,
  type MetronomeTimeline,
  type MonotonicClock,
  type NextDiscoveryStep,
  type ObdTransport,
  type SignalCandidateScore,
  type SignalEngineRequirement,
  type SignalFinderPlanEntry,
  type SignalFinderSample,
  type SignalFinderTargetRef,
  type SignalLanguage,
  type SignalTargetCatalog,
  type SignalTargetDefinition,
  type SignalTargetId,
  type SweepTransport,
} from '@circuit/core';
import { createRawUdsChannel } from './didSweepController';
import { enetAdapterReservation as sharedEnetAdapterReservation, type EnetAdapterReservation, type EnetAdapterToken } from './enetAdapterReservation';
import { hexToBytes, type DidSweepStore, type VehicleProfileBinding, type VehicleProfileBindingStore } from '../persistence/didSweepStore';
import { noopSignalFinderHaptics, type SignalFinderHaptics } from './signalFinderHaptics';

/** Item 3 (binding): "Insufficient samples (< 2 per window)" — the SCORER's gate. The budget targets 3 (see `planFinderRun`). */
const MIN_SAMPLES_PER_WINDOW = 2;

/** How often the on-screen prompt/countdown is recomputed while a round is running. */
const TICK_INTERVAL_MS = 100;

const RESERVATION_BUSY_MESSAGE = 'The adapter is in use (telemetry, the DID probe or a sweep) -- stop it first.';

/** Ranks a previous observation gives a DID that did NOT change (or could not be judged) — never treated as change evidence (item 10b). */
const NON_CHANGE_RANKS: ReadonlySet<string> = new Set(['static', 'insufficient']);

export type SignalFinderPhase = 'idle' | 'preparing' | 'reading' | 'scoring' | 'result' | 'error';

/** What was read on ONE ECU, cumulatively across the rounds run so far — the export's own per-ECU view. */
export interface SignalFinderEcuPass {
  ecu: number;
  dids: readonly number[];
  /** The subset that came from the target's own hypotheses (data). */
  hypothesisDids: readonly number[];
  /** The subset that carried CHANGE evidence from an earlier observation (item 10b). */
  changedDids: readonly number[];
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
  /** How many scripts the driver has performed for this target: 1 after `find()`, +1 per `nextRound()`. */
  round: number;
  /** Item 10: how many DIDs one round may read at the measured rate. */
  budget: number;
  /** Every (ECU, DID) actually polled so far, in the order the rounds read them. */
  readDids: readonly SignalFinderTargetRef[];
  /** Item 12: eligible DIDs no round has reached — "not read", NEVER "no response". */
  notReadDids: readonly SignalFinderTargetRef[];
  notReadCount: number;
  /** P4m-FIX1 X2: eligible DIDs skipped because their ECU answered nothing in the probe. Never "no response", never "not read (Next round)". */
  silentDids: readonly SignalFinderTargetRef[];
  /** P4m-FIX1 X2: the ECUs those DIDs are on — "not read — ECU 0x29 silent". */
  silentEcus: readonly number[];
  /** {@link readDids}, grouped per ECU (what the result header and the export count). */
  passes: readonly SignalFinderEcuPass[];
  /** The ECUs the CURRENT round is polling (all of them in one session). */
  ecus: readonly number[];
  step: SignalFinderStepSnapshot | null;
  /** Ranked verdicts, `found` first (see `scoreSignalCandidates`). */
  scores: readonly SignalCandidateScore[];
  /** Polled but silent/NRC — item 2: "Reads must tolerate NRC". Never contains a DID that was merely not read. */
  noResponseDids: readonly SignalFinderTargetRef[];
  /** Item 4 (binding): the next concrete step with its duration — present whenever nothing was `found`. */
  nextStep: NextDiscoveryStep | null;
  /** Channels already written into the vehicle profile by {@link SignalFinderController.confirmBinding}. */
  confirmedChannels: readonly string[];
  /** Fresh per `find()` — the id carried into the export. */
  sessionId: string | null;
  startedAtUtc: string | null;
  /** The request rate the budget/durations were derived from. */
  measuredReqPerSec: number;
  /**
   * P4m-FIX1 X1 (Codex P4m-REV1 finding 1, HIGH): was that rate actually
   * MEASURED (by this find's own probe), or is it the assumed fallback? Build
   * 6 exported an assumed 15.8 req/s as if it had been measured, which is
   * exactly the promise ("≥ 3 samples per 3 s window") the budget cannot keep
   * on an adapter nobody timed.
   */
  rateSource: FinderRateSource;
  /** Non-null exactly when something went wrong; never thrown across this API. */
  error: string | null;
}

export interface SignalFinderControllerDeps {
  /** A FRESH transport per ROUND — this factory is called by the controller, never connected/closed by the screen. */
  transportFactory: () => ObdTransport;
  testerAddress: number;
  clock: MonotonicClock;
  /** Wall-clock ISO string source (defaults to `new Date().toISOString()`) — injected so tests are deterministic. */
  nowUtc?: () => string;
  /** Which vehicle profile's targets/bindings this session works against. Default `'generic'` (hypothesis-free). */
  profileId?: string;
  /** Test seam: overrides the catalog `profileId` would resolve to. Production never passes this. */
  catalog?: SignalTargetCatalog;
  /** The app's language, read at the moment each round builds its prompts (M4). Default English. */
  getLanguage?: () => SignalLanguage;
  /** Single-client adapter reservation — the SAME instance the sweep/probe/provider share. */
  reservation?: EnetAdapterReservation;
  /** P4m-FIX1 X2: the per-DID request budget. Default {@link FINDER_REQUEST_TIMEOUT_MS} (300 ms — enetSession N5's own number). */
  requestTimeoutMs?: number;
  /** Read-only here: the source of cached responders and prior change evidence (item 10b/c). Omitted → hypotheses only. */
  sweepStore?: DidSweepStore;
  /** Where "Confirm as <target>" writes. Omitted → `confirmBinding` is a no-op returning `null` (web preview). */
  bindingStore?: VehicleProfileBindingStore;
  haptics?: SignalFinderHaptics;
  /** Caps the rate-derived budget (never raises it above {@link FINDER_BUDGET_MAX}). */
  maxDidsPerRound?: number;
  /** The measured request rate to size the budget from. Default {@link ASSUMED_GUIDED_REQ_PER_SEC}. */
  measuredReqPerSec?: number;
}

export interface SignalFinderController {
  subscribe(cb: (snapshot: SignalFinderSnapshot) => void): () => void;
  getSnapshot(): SignalFinderSnapshot;
  /** Runs ONE script for `targetId` (round 1, a fresh session). Resolves when the round has finished (or errored) — never rejects. */
  find(targetId: SignalTargetId): Promise<void>;
  /** Item 10: one MORE script, reading the next budget slice of what is still unread. No-op when nothing is left. Never rejects. */
  nextRound(): Promise<void>;
  /**
   * P4m-FIX1 X9 (Codex P4m-REV1 finding 10): how many DIDs a find for
   * `targetId` could read AT ALL (hypotheses + this target's ECUs' cached
   * evidence). `0` means "one script per find" would be zero scripts — the
   * screen disables Find and says why instead of running an empty round.
   */
  eligibleDidCount(targetId: SignalTargetId): Promise<number>;
  /** Ends the run early. Resolves only once the transport is closed and the reservation released. */
  stop(): Promise<void>;
  /** Every sample this session collected, across every round, for the export. */
  getSamples(): readonly SignalFinderSample[];
  /** Item 5 (binding): writes `score` into the persisted vehicle profile as `channel`'s binding. `null` when no binding store is wired. */
  confirmBinding(channel: SignalTargetId, score: SignalCandidateScore): Promise<VehicleProfileBinding | null>;
}

/**
 * Item 10 (binding): "All ECUs are polled in the SAME session (per-entry
 * target address)". `createRawUdsChannel` is single-target by construction
 * (it frames to one ECU and correlates that ECU's replies by the HSFZ address
 * swap), so a round opens ONE such channel per ECU over the SAME transport:
 * every `onData` subscriber sees every chunk, and each channel keeps only its
 * own ECU's frames.
 *
 * P4m-FIX1 X4 (Codex P4m-REV1 finding 4): build 6 merged those channels into
 * one DID-keyed façade, which is why the same DID number on two ECUs had to
 * be split across two human scripts. `runFinderRound` addresses the CHANNEL
 * per entry instead, so the map below is the whole mechanism — no dispatch
 * table, no DID-uniqueness requirement.
 */
export function createEcuChannels(
  transport: ObdTransport,
  testerAddress: number,
  ecus: Iterable<number>,
): Map<number, SweepTransport> {
  const channels = new Map<number, SweepTransport>();
  for (const ecu of new Set(ecus)) channels.set(ecu, createRawUdsChannel(transport, testerAddress, ecu));
  return channels;
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

/** The DIDs an earlier observation summary says CHANGED, in the order that summary ranked them. */
function changedDidsFromSummaryJson(summaryJson: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(summaryJson);
  } catch {
    return []; // A corrupt blob is no evidence -- never a crash mid-find.
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const blob = parsed as { candidates?: unknown; blockCandidates?: unknown };
  const dids: number[] = [];
  for (const list of [blob.candidates, blob.blockCandidates]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const candidate = entry as { did?: unknown; rank?: unknown };
      if (typeof candidate.did !== 'number') continue;
      if (typeof candidate.rank === 'string' && NON_CHANGE_RANKS.has(candidate.rank)) continue;
      dids.push(candidate.did);
    }
  }
  return dids;
}

/** The three priority pools of item 10, already ECU-tagged. Computed once per `find()` and reused by every `nextRound()`. */
interface FinderPools {
  hypotheses: SignalFinderTargetRef[];
  changed: SignalFinderTargetRef[];
  cached: SignalFinderTargetRef[];
}

export function createSignalFinderController(deps: SignalFinderControllerDeps): SignalFinderController {
  const reservation = deps.reservation ?? sharedEnetAdapterReservation;
  const nowUtc = deps.nowUtc ?? ((): string => new Date().toISOString());
  const profileId = deps.profileId ?? 'generic';
  const catalog = deps.catalog ?? resolveSignalTargetCatalog(profileId);
  const haptics = deps.haptics ?? noopSignalFinderHaptics;
  const getLanguage = deps.getLanguage ?? ((): SignalLanguage => 'en');
  /**
   * P4m-FIX1 X1: the FALLBACK rate only — what a find reports when its own
   * probe measured nothing. `deps.measuredReqPerSec` is a test seam and the
   * app's prior estimate, never evidence about THIS adapter right now.
   */
  const assumedReqPerSec =
    deps.measuredReqPerSec !== undefined && Number.isFinite(deps.measuredReqPerSec) && deps.measuredReqPerSec > 0
      ? deps.measuredReqPerSec
      : ASSUMED_GUIDED_REQ_PER_SEC;
  const maxDidsPerRound =
    deps.maxDidsPerRound !== undefined && Number.isFinite(deps.maxDidsPerRound) && deps.maxDidsPerRound > 0
      ? Math.floor(deps.maxDidsPerRound)
      : FINDER_BUDGET_MAX;
  /** The budget for a rate — recomputed per round from what the probe actually measured. */
  const budgetFor = (reqPerSec: number): number => Math.min(computeFinderDidBudget(reqPerSec), maxDidsPerRound);

  const listeners = new Set<(snapshot: SignalFinderSnapshot) => void>();
  let snapshot: SignalFinderSnapshot = {
    phase: 'idle',
    profileId,
    targetId: null,
    targetLabel: null,
    engineRequirement: null,
    timeline: null,
    round: 0,
    budget: budgetFor(assumedReqPerSec),
    readDids: [],
    notReadDids: [],
    notReadCount: 0,
    silentDids: [],
    silentEcus: [],
    passes: [],
    ecus: [],
    step: null,
    scores: [],
    noResponseDids: [],
    nextStep: null,
    confirmedChannels: [],
    sessionId: null,
    startedAtUtc: null,
    measuredReqPerSec: assumedReqPerSec,
    rateSource: 'assumed',
    error: null,
  };

  let samples: SignalFinderSample[] = [];
  let generation = 0;
  let activeRun: Promise<void> | null = null;
  let control: DidSweepControl = { paused: false, stopped: false };
  let activeTransport: ObdTransport | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  /** Everything a `nextRound()` needs from the find that started it. */
  let currentTarget: SignalTargetDefinition | null = null;
  let currentPools: FinderPools = { hypotheses: [], changed: [], cached: [] };
  let readEntries: SignalFinderPlanEntry[] = [];
  let noResponse: SignalFinderTargetRef[] = [];

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

  /** Drives the on-screen prompt/countdown (and the haptic) from the round's own anchor. */
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

  /**
   * Item 10's three pools, for the WHOLE find (every ECU at once — this is no
   * longer a per-ECU pass list). Hypotheses are ordered by ECU then DID so a
   * round is reproducible; change evidence keeps the order the observation
   * itself ranked it in; cached responders keep the sweep's own order (short
   * responses before blocks).
   */
  async function collectPools(target: SignalTargetDefinition): Promise<FinderPools> {
    const hypotheses: SignalFinderTargetRef[] = [];
    for (const ecu of targetHypothesisEcus(target)) {
      for (const hypothesis of target.hypotheses.filter((h) => h.ecu === ecu)) {
        hypotheses.push({ ecu, did: hypothesis.did });
      }
    }
    /**
     * P4m-FIX1 X5 (Codex P4m-REV1 finding 5): the cached pools belong to THIS
     * TARGET's ECUs — the ones it has a hypothesis on, plus the ones its own
     * discovery ranges name. Build 6 pulled cached responders from every ECU
     * the sweep store had ever seen, so a bounded 12-DID round could be spent
     * on an address that has nothing to do with the signal being hunted. A
     * range with `ecu: null` ("every ECU that answered", the generic catalog)
     * is the one case where all of them are eligible.
     */
    const allowedEcus = new Set<number>(targetHypothesisEcus(target));
    let allEcusAllowed = false;
    for (const discoveryRange of target.discoveryRanges) {
      if (discoveryRange.ecu === null) allEcusAllowed = true;
      else allowedEcus.add(discoveryRange.ecu);
    }
    const changed: SignalFinderTargetRef[] = [];
    const cached: SignalFinderTargetRef[] = [];
    const store = deps.sweepStore;
    if (store !== undefined) {
      const runs = await store.listRuns();
      const ecus = [...new Set(runs.map((run) => run.targetAddress).filter((address): address is number => address !== null))]
        .filter((ecu) => allEcusAllowed || allowedEcus.has(ecu))
        .sort((a, b) => a - b);
      for (const ecu of ecus) {
        const ecuRuns = runs.filter((run) => run.targetAddress === ecu);
        // (b) prior CHANGE evidence, from the observation summaries of this
        // ECU's runs -- "any rank other than static" (item 10b).
        const changedSeen = new Set<number>();
        for (const run of ecuRuns) {
          for (const summary of await store.getObservationSummaries(run.runId)) {
            for (const did of changedDidsFromSummaryJson(summary.summaryJson)) {
              if (changedSeen.has(did)) continue;
              changedSeen.add(did);
              changed.push({ ecu, did });
            }
          }
        }
        // (c) every other cached responder of this ECU, shape-filtered.
        const records: { did: number; rawHex: string; length: number }[] = [];
        const seenCached = new Set<number>();
        for (const run of ecuRuns) {
          for (const responder of await store.getResponders(run.runId)) {
            if (seenCached.has(responder.did)) continue;
            seenCached.add(responder.did);
            records.push({ did: responder.did, rawHex: responder.rawHex, length: responder.length });
          }
        }
        const { short, blocks } = partitionCachedResponders(records);
        for (const did of [...short, ...blocks]) cached.push({ ecu, did });
      }
    }
    return { hypotheses, changed, cached };
  }

  /** {@link readEntries}, grouped per ECU — what the result header and the export count. */
  function passesFromReadEntries(entries: readonly SignalFinderPlanEntry[]): SignalFinderEcuPass[] {
    const byEcu = new Map<number, SignalFinderEcuPass>();
    for (const entry of entries) {
      let pass = byEcu.get(entry.ecu);
      if (pass === undefined) {
        pass = { ecu: entry.ecu, dids: [], hypothesisDids: [], changedDids: [], cachedDids: [] };
        byEcu.set(entry.ecu, pass);
      }
      (pass.dids as number[]).push(entry.did);
      if (entry.source === 'hypothesis') (pass.hypothesisDids as number[]).push(entry.did);
      else if (entry.source === 'changed') (pass.changedDids as number[]).push(entry.did);
      else (pass.cachedDids as number[]).push(entry.did);
    }
    return [...byEcu.values()].sort((a, b) => a.ecu - b.ecu);
  }

  /** Rescores EVERY sample of the session (rounds read disjoint DIDs, so one pass over all of them is the whole picture). */
  function rescore(target: SignalTargetDefinition, timeline: MetronomeTimeline): SignalCandidateScore[] {
    return scoreSignalCandidates({
      samples,
      timeline,
      shape: target.expectedShape,
      // P4m-FIX1 X6: the flag exception is DATA — which DIDs this target
      // declares to be a boolean flag inside a word (DME 0x4007).
      declaredFlagDids: targetDeclaredFlagDids(target),
      options: { minSamplesPerWindow: MIN_SAMPLES_PER_WINDOW },
    });
  }

  function refOf(entry: SignalFinderTargetRef): SignalFinderTargetRef {
    return { ecu: entry.ecu, did: entry.did };
  }

  function keyOf(entry: SignalFinderTargetRef): string {
    return `${entry.ecu}:${entry.did}`;
  }

  /** One slice of the eligible pools at `reqPerSec`, minus what earlier rounds read and minus the ECUs the probe found silent. */
  function planRound(reqPerSec: number, silentEcus: readonly number[]): FinderRunPlan {
    return planFinderRun(reqPerSec, currentPools.hypotheses, currentPools.changed, currentPools.cached, {
      budget: budgetFor(reqPerSec),
      exclude: readEntries,
      silentEcus,
    });
  }

  function emitPlan(plan: FinderRunPlan, unattempted: readonly SignalFinderTargetRef[] = []): void {
    emit({
      budget: plan.budget,
      ecus: [...new Set(plan.dids.map((entry) => entry.ecu))].sort((a, b) => a - b),
      notReadDids: [...plan.notRead.map(refOf), ...unattempted.map(refOf)],
      notReadCount: plan.notRead.length + unattempted.length,
      silentDids: plan.silent.map(refOf),
      silentEcus: [...new Set(plan.silent.map((entry) => entry.ecu))].sort((a, b) => a - b),
    });
  }

  /**
   * One round: plan → reserve → PROBE → re-plan → ONE script → score.
   * `roundNumber` is 1 for `find()`, +1 per `nextRound()`.
   *
   * P4m-FIX1 X1/X2/X3 (Codex P4m-REV1 findings 1–3, all HIGH) are the three
   * steps that were missing here:
   *
   *  - the ~2 s PROBE reads every planned DID once, which is where the
   *    MEASURED request rate and the per-ECU liveness come from. The budget is
   *    then recomputed from that rate, not from an assumption;
   *  - a silent ECU's DIDs are dropped before the human script starts, and the
   *    freed budget is refilled from the next pool;
   *  - what the script ATTEMPTED is what counts as read. Everything else stays
   *    "not read", whatever ended the round.
   */
  async function doRound(myGeneration: number, target: SignalTargetDefinition, roundNumber: number): Promise<void> {
    let token: EnetAdapterToken | null = null;
    try {
      const language = getLanguage();
      const timeline = buildMetronomeTimeline(target.actionScript, { verbs: resolveSignalActionVerbs(target, language) });
      emit({
        phase: 'preparing',
        targetId: target.id,
        targetLabel: target.label,
        engineRequirement: target.engineRequirement,
        round: roundNumber,
        step: null,
        nextStep: null,
        error: null,
        timeline,
      });

      // Sized from whatever rate is known so far (the probe's own reading from
      // the previous round, else the assumed fallback) -- this list is what the
      // probe then measures against.
      const provisional = planRound(snapshot.measuredReqPerSec, []);
      emitPlan(provisional);

      if (provisional.dids.length === 0) {
        // Item 4 (binding): never "no brake on this car" -- say what was read
        // and what the next concrete step is. X9: no DIDs means NO script,
        // and the round counter must not pretend otherwise.
        emit({
          phase: 'result',
          round: Math.max(0, roundNumber - 1),
          nextStep: nextDiscoveryStep(target, snapshot.measuredReqPerSec, [], language),
          step: null,
        });
        return;
      }

      token = reservation.tryAcquire('signalFinder');
      if (token === null && reservation.isReleasePending()) {
        // A prior holder's close+release is already in flight -- wait it out
        // once rather than reporting a busy adapter (same discipline as the
        // sweep controller's own reacquire).
        await reservation.whenFree();
        token = reservation.tryAcquire('signalFinder');
      }
      if (token === null) {
        emit({ phase: 'error', error: RESERVATION_BUSY_MESSAGE, step: null });
        return;
      }

      emit({ phase: 'reading' });
      const requestTimeoutMs =
        deps.requestTimeoutMs !== undefined && Number.isFinite(deps.requestTimeoutMs) && deps.requestTimeoutMs > 0
          ? deps.requestTimeoutMs
          : FINDER_REQUEST_TIMEOUT_MS;

      let plan = provisional;
      let attempted: readonly SignalFinderTargetRef[] = [];
      let scriptStarted = false;

      const transport = deps.transportFactory();
      activeTransport = transport;
      try {
        await transport.connect();
        if (myGeneration !== generation || control.stopped) return;
        const channels = createEcuChannels(transport, deps.testerAddress, provisional.dids.map((entry) => entry.ecu));

        // X1: MEASURE. One pass over the planned DIDs, capped at ~2 s.
        const probe = await runFinderRound({
          entries: provisional.dids,
          channels,
          clock: deps.clock,
          control,
          durationMs: FINDER_PROBE_DURATION_MS,
          requestTimeoutMs,
          maxPasses: 1,
        });
        const summary = summarizeFinderProbe(
          probe,
          provisional.dids.map((entry) => entry.ecu),
          assumedReqPerSec,
        );
        emit({ measuredReqPerSec: summary.reqPerSec, rateSource: summary.rateSource });
        if (myGeneration !== generation || control.stopped) return;

        // X2: re-plan at the measured rate, without the silent ECUs -- the
        // budget they were consuming is refilled from the next pool.
        plan = planRound(summary.reqPerSec, summary.silentEcus);
        emitPlan(plan);
        if (plan.dids.length > 0) {
          for (const ecu of new Set(plan.dids.map((entry) => entry.ecu))) {
            if (!channels.has(ecu)) channels.set(ecu, createRawUdsChannel(transport, deps.testerAddress, ecu));
          }
          const result = await runFinderRound({
            entries: plan.dids,
            channels,
            clock: deps.clock,
            control,
            durationMs: timeline.pollDurationMs,
            requestTimeoutMs,
            onStarted: (startedAtMs) => {
              if (myGeneration !== generation) return;
              scriptStarted = true;
              startTicker(timeline, startedAtMs);
            },
          });
          stopTicker();
          // `samples[].tMs` is relative to THIS script's own start -- the same
          // origin the metronome timeline uses, and the same one every other
          // round uses, so rounds are directly comparable.
          samples.push(...result.samples);
          attempted = result.attempted;
        }
      } finally {
        stopTicker();
        await teardownTransport();
      }
      if (myGeneration !== generation) return;

      emit({ phase: 'scoring', step: null });
      // X3 (binding): ONLY what a request actually went out for is "read".
      const attemptedKeys = new Set(attempted.map(keyOf));
      const attemptedEntries = plan.dids.filter((entry) => attemptedKeys.has(keyOf(entry)));
      const unattempted = plan.dids.filter((entry) => !attemptedKeys.has(keyOf(entry)));
      readEntries = [...readEntries, ...attemptedEntries];
      emitPlan(plan, unattempted);

      const answered = new Set(samples.map((sample) => `${sample.ecu}:${sample.did}`));
      noResponse = readEntries.filter((entry) => !answered.has(keyOf(entry))).map(refOf);
      const scores = rescore(target, timeline);
      const found = scores.some((score) => score.verdict === 'found');
      emit({
        phase: 'result',
        scores,
        // A script the driver never performed (stopped during the probe) does
        // not count as a round -- "in R round(s)" must never overstate it.
        round: scriptStarted ? roundNumber : Math.max(0, roundNumber - 1),
        readDids: readEntries.map(refOf),
        passes: passesFromReadEntries(readEntries),
        noResponseDids: noResponse,
        // Item 4 (binding). NOT excluding the ECUs this session read: reading
        // a handful of hypothesis/cached DIDs on an ECU is not the same as
        // SWEEPING its remaining range, and the unswept remainder is exactly
        // the step the user needs told about next.
        nextStep: found ? null : nextDiscoveryStep(target, snapshot.measuredReqPerSec, [], language),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (myGeneration === generation) emit({ phase: 'error', error: message, step: null });
    } finally {
      stopTicker();
      await teardownTransport();
      if (token !== null) reservation.release(token);
    }
  }

  function busy(): boolean {
    return snapshot.phase === 'preparing' || snapshot.phase === 'reading' || snapshot.phase === 'scoring';
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
      if (busy()) return;
      const target = findSignalTarget(catalog, targetId);
      if (target === null) {
        emit({ phase: 'error', error: `No target definition for "${targetId}" in profile "${catalog.profileId}".` });
        return;
      }
      generation += 1;
      const myGeneration = generation;
      control = { paused: false, stopped: false };
      samples = [];
      readEntries = [];
      noResponse = [];
      currentTarget = target;
      emit({
        phase: 'preparing',
        targetId: target.id,
        targetLabel: target.label,
        engineRequirement: target.engineRequirement,
        round: 0,
        readDids: [],
        notReadDids: [],
        notReadCount: 0,
        silentDids: [],
        silentEcus: [],
        passes: [],
        ecus: [],
        step: null,
        scores: [],
        noResponseDids: [],
        nextStep: null,
        error: null,
        // X1: a fresh find has measured NOTHING yet -- it says so until its
        // own probe reports, and never inherits the last find's reading.
        measuredReqPerSec: assumedReqPerSec,
        rateSource: 'assumed',
        budget: budgetFor(assumedReqPerSec),
        sessionId: `signal-finder-${deps.clock.now()}-${Math.random().toString(36).slice(2, 8)}`,
        startedAtUtc: nowUtc(),
        timeline: null,
      });
      currentPools = await collectPools(target);
      if (myGeneration !== generation) return;
      const run = doRound(myGeneration, target, 1);
      activeRun = run;
      await run;
      if (activeRun === run) activeRun = null;
    },

    async eligibleDidCount(targetId): Promise<number> {
      // X9 (binding): "Find is disabled (with reason) when the plan has zero
      // DIDs" -- so the screen must be able to ASK, before the driver taps
      // anything, whether one script would read anything at all.
      const target = findSignalTarget(catalog, targetId);
      if (target === null) return 0;
      const pools = await collectPools(target);
      const keys = new Set<string>();
      for (const pool of [pools.hypotheses, pools.changed, pools.cached]) {
        for (const entry of pool) keys.add(`${entry.ecu}:${entry.did}`);
      }
      return keys.size;
    },

    async nextRound(): Promise<void> {
      const target = currentTarget;
      if (busy() || target === null || snapshot.notReadCount === 0) return;
      generation += 1;
      const myGeneration = generation;
      control = { paused: false, stopped: false };
      const run = doRound(myGeneration, target, snapshot.round + 1);
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
          sparse: score.sparse ?? false,
          matchedEdges: score.matchedEdges,
          windowMatchedEdges: score.windowMatchedEdges ?? null,
          expectedEdges: score.expectedEdges,
          baselineChanges: score.baselineChanges,
          responseBaselineChanges: score.responseBaselineChanges,
          sampleCount: score.sampleCount,
          byteOffset: score.byteOffset,
          flagBit: score.flagBit ?? null,
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
