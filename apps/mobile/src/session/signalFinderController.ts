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
  FINDER_KEEPALIVE_INTERVAL_MS,
  FINDER_PROBE_DURATION_MS,
  FINDER_REQUEST_TIMEOUT_MS,
  assertAllowedRequest,
  buildMetronomeTimeline,
  buildObdMode01Request,
  computeFinderDidBudget,
  decodeMode01Response,
  engineNotDetectedRunning,
  extractObdMode01Data,
  finderProbeBoundMs,
  findSignalTarget,
  isAsciiLike,
  mergeFinderRounds,
  metronomeCountdownMs,
  metronomeStepAt,
  nextDiscoveryStep,
  parseUdsResponse,
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
  type SignalRecentEngineSample,
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
import {
  hexToBytes,
  type DidSweepStore,
  type SignalFinderRuledOutRecord,
  type SignalFinderRuledOutStore,
  type VehicleProfileBinding,
  type VehicleProfileBindingStore,
} from '../persistence/didSweepStore';
import { noopSignalFinderHaptics, type SignalFinderHaptics } from './signalFinderHaptics';

/** Item 3 (binding): "Insufficient samples (< 2 per window)" — the SCORER's gate. The budget targets 3 (see `planFinderRun`). */
const MIN_SAMPLES_PER_WINDOW = 2;

/** How often the on-screen prompt/countdown is recomputed while a round is running. */
const TICK_INTERVAL_MS = 100;

const RESERVATION_BUSY_MESSAGE = 'The adapter is in use (telemetry, the DID probe or a sweep) -- stop it first.';

/** P4m-FIX3 Z6: the raw (diagnostics) text behind the `adapter-teardown-pending` code. */
const ADAPTER_TEARDOWN_PENDING_MESSAGE = 'The previous transport close() has not settled yet -- the adapter is not free.';

/**
 * P4m-FIX2 Y6 (Codex P4m-REV2 finding 16): a `close()` that never resolves used
 * to block BOTH `stop()` and the reservation release, because it was awaited
 * without a bound before `release()`. Two seconds is generous for a socket
 * teardown and short enough that a driver tapping Stop is never left waiting on
 * a dead adapter.
 */
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

/**
 * P4m-FIX3 Z6 (Codex P4m-REV3 finding 12, MEDIUM): "the timeout fallback merely
 * checks optional, non-contractual `destroy`/`abort` methods and resolves even
 * when neither exists or they throw; the reservation release then occurs while
 * the original `close()` can remain pending".
 *
 * `ObdTransport` promises `close()` and nothing else, so a hard abort cannot be
 * REQUIRED — but the reservation must not be handed to the next client while a
 * socket the last one owns may still be alive either. So: release only after
 * the close SETTLED; if it has not settled by {@link DEFAULT_CLOSE_TIMEOUT_MS},
 * try whatever abort the transport happens to offer and keep waiting to this
 * hard bound; if it STILL has not settled, release with
 * {@link SignalFinderSnapshot.adapterTeardownPending} set and refuse the next
 * find until that close finally settles (the controller stays subscribed to it).
 */
const DEFAULT_TEARDOWN_TIMEOUT_MS = 5_000;

/**
 * P4m-FIX2 Y7 (Codex P4m-REV2 finding 9): WHY a find failed, as a code the
 * screen can translate. {@link SignalFinderSnapshot.error} keeps the raw
 * English/underlying text for the EXPORT's diagnostics (P4m-FIX3 Z7); the
 * driver reads the localized line the code selects, and nothing else.
 */
export type SignalFinderErrorCode = 'adapter-busy' | 'no-target' | 'run-failed' | 'adapter-teardown-pending';

/** Ranks a previous observation gives a DID that did NOT change (or could not be judged) — never treated as change evidence (item 10b). */
const NON_CHANGE_RANKS: ReadonlySet<string> = new Set(['static', 'insufficient']);

/**
 * P4m-FIX3 Z5 (Codex P4m-REV3 finding 11, MEDIUM): `probing` is its own phase.
 * The complete-pass probe costs up to `entries × 300 ms` before the metronome
 * says anything, and build 8 spent those seconds on a screen that looked
 * frozen; `reading` became `running` in the same move, so the two are never
 * confused with each other.
 */
export type SignalFinderPhase = 'idle' | 'preparing' | 'probing' | 'running' | 'scoring' | 'result' | 'error';

/** P4m-FIX3 Z5: how far the pre-script probe has got, and the bound it cannot exceed. */
export interface SignalFinderProbeProgress {
  probed: number;
  total: number;
  /**
   * The worst case the screen states ("up to N s"), from `@circuit/core`'s
   * own {@link finderProbeBoundMs}: `total × (send timeout + response window +
   * 0x78 extension budget)`. P4m-FIX4 W3 — `total × requestTimeoutMs` was a
   * quarter of what one exchange may really cost.
   */
  boundMs: number;
}

/** What was read on ONE ECU, cumulatively across the rounds run so far — the export's own per-ECU view. */
export interface SignalFinderEcuPass {
  ecu: number;
  dids: readonly number[];
  /**
   * Ticket P4o O4 (binding): the subset that came from the target's OWN
   * previously confirmed binding on this profile — read before every other
   * pool, hypotheses included.
   */
  confirmedDids: readonly number[];
  /** The subset that came from the target's own hypotheses (data). */
  hypothesisDids: readonly number[];
  /** The subset that carried CHANGE evidence from an earlier observation (item 10b). */
  changedDids: readonly number[];
  /** The subset that came from `did_sweep_responders` of earlier sweep runs on this ECU. */
  cachedDids: readonly number[];
}

/**
 * Ticket P4o O3 (binding, field test 8): one binding a confirm SILENTLY
 * overwrote before this ticket — field test 8's own defect ("brake pressure
 * became 0/100 %" when a generic-profile confirm on 0x4002 replaced the
 * engine-running-confirmed 0x58B7 with no warning at all). Recorded only
 * once the SECOND, explicit tap actually committed the replacement — never
 * for the first, informational tap.
 */
export interface SignalFinderReplacedBinding {
  channel: SignalTargetId;
  /** The NEW binding's (ecu, did) — what the export's `candidates`/`confirmedBindings` also carry. */
  ecu: number;
  did: number;
  /** The binding this replaced. */
  previousEcu: number;
  previousDid: number;
  replacedAtUtc: string;
}

/**
 * Ticket P4o O3 (binding): armed by a FIRST tap of "Confirm as <target>" when
 * the channel already has a different field-confirmed binding — the second,
 * explicit tap (same `channel`/`ecu`/`did`/`byteOffset`) is what actually
 * writes it. `null` whenever nothing is armed (including right after a
 * successful confirm, a replace or a plain first-ever confirm).
 */
export interface SignalFinderPendingReplace {
  channel: SignalTargetId;
  ecu: number;
  did: number;
  byteOffset: number | null;
  /** The existing field-confirmed binding a second tap would replace. */
  existing: VehicleProfileBinding;
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
  /** Ticket P4o O3: non-null exactly while a replace confirm is armed, waiting for its second tap. */
  pendingReplace: SignalFinderPendingReplace | null;
  /** Ticket P4o O3: every binding a confirm has REPLACED so far, for the export's `replaced` section. */
  replacedBindings: readonly SignalFinderReplacedBinding[];
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
  /**
   * P4m-FIX3 Z1 — DIAGNOSTICS ONLY: the probe's OVERALL rate, the timeouts of
   * the entries it then dropped included. `null` before any probe. The budget
   * and every estimate use {@link measuredReqPerSec} (the retained entries'
   * own rate); this figure exists so the export can show what the probe as a
   * whole cost, which is what the LEAD's field run was accidentally sized from.
   */
  diagnosticReqPerSec: number | null;
  /** P4m-FIX3 Z5: non-null exactly while the pre-script probe is running. */
  probeProgress: SignalFinderProbeProgress | null;
  /**
   * Ticket P4p G2 (binding, field test 9 BUG-B): the engine speed THIS find
   * read for itself, with one standard mode-01 0x0C request at probe time,
   * over the channel it already holds. `null` = not read (yet, or the ECU
   * refused/ignored it) -- never a fabricated zero.
   */
  engineRpm: number | null;
  /**
   * {@link engineRpm} judged against {@link FINDER_ENGINE_RPM_MIN}: `true`
   * running, `false` not running, `null` unknown. Fresh BY CONSTRUCTION -- it
   * is read inside the round it describes, which is the whole point: telemetry
   * and the finder can never run at the same time (one adapter reservation),
   * so the old "wait for a fresh telemetry rpm sample" check could never clear.
   */
  engineRunning: boolean | null;
  /**
   * Ticket P4p G5 (binding): how many (ecu, did) pairs earlier COMPLETED finds
   * ruled out for the CURRENT target -- excluded from this find's pools, shown
   * as one line with a "Re-test all" control.
   */
  ruledOutCount: number;
  /**
   * P4m-FIX3 Z6: the last transport's `close()` had not settled when its
   * reservation had to be released. A find is refused while this is true.
   */
  adapterTeardownPending: boolean;
  /** Non-null exactly when something went wrong; never thrown across this API. The RAW text — for the EXPORT's diagnostics only; the screen renders {@link errorCode}'s localized line. */
  error: string | null;
  /** P4m-FIX2 Y7: what KIND of failure {@link error} is, so the screen can say it in the driver's own language. */
  errorCode: SignalFinderErrorCode | null;
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
  /**
   * Ticket P4p G5: where a completed find records the DIDs it scored
   * `unrelated` for the target, and where every later plan reads its
   * exclusions from. Omitted → nothing is ever ruled out (web preview).
   */
  ruledOutStore?: SignalFinderRuledOutStore;
  /**
   * Ticket P4p G2: the ECU the one-shot mode-01 rpm read is addressed to.
   * Defaults to {@link ENGINE_RPM_ECU} (0x12, the DME -- the same target
   * address the ENET settings default to). A test seam, and a way out for a
   * car whose engine data lives elsewhere; never a vehicle constant written
   * into a flow.
   */
  engineRpmEcu?: number;
  haptics?: SignalFinderHaptics;
  /** Caps the rate-derived budget (never raises it above {@link FINDER_BUDGET_MAX}). */
  maxDidsPerRound?: number;
  /** The measured request rate to size the budget from. Default {@link ASSUMED_GUIDED_REQ_PER_SEC}. */
  measuredReqPerSec?: number;
  /** P4m-FIX2 Y6: how long a `close()` may take before the transport is aborted. Default {@link DEFAULT_CLOSE_TIMEOUT_MS} (2 s). */
  closeTimeoutMs?: number;
  /** P4m-FIX3 Z6: how long the teardown waits IN TOTAL before releasing with `adapterTeardownPending`. Default {@link DEFAULT_TEARDOWN_TIMEOUT_MS} (5 s). */
  teardownTimeoutMs?: number;
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
  /** Ticket P4p G5: how many DIDs earlier completed finds ruled out for `targetId` -- the row's "N ruled out from earlier finds" line. */
  ruledOutDidCount(targetId: SignalTargetId): Promise<number>;
  /** Ticket P4p G5: the "Re-test all" control -- drops `targetId`'s exclusions so its DIDs are planned again. */
  clearRuledOut(targetId: SignalTargetId): Promise<void>;
}

/**
 * Ticket P4p G2 (binding): the DME address the one-shot rpm read goes to --
 * the SAME default `DEFAULT_SETTINGS.enetTargetAddress` uses, and overridable
 * through {@link SignalFinderControllerDeps.engineRpmEcu}.
 */
export const ENGINE_RPM_ECU = 0x12;

/** The standard mode-01 PID for engine speed (`pidCodec.ts` owns the decode formula). */
const MODE01_RPM_PID = 0x0c;

/** How many already-received frames the rpm channel drains looking for its `41 0C` answer (the same ECU's DID responses land there too). */
const ENGINE_RPM_DRAIN_LIMIT = 64;

/**
 * Ticket P4p G2 (binding): above this the engine IS running. A real idle sits
 * at 600-900 rpm; a cranking/stalled engine and every "the ECU answered 0" case
 * sit far below. Deliberately not "> 0": a single noisy low reading must not
 * be allowed to say "engine running" about a car that is standing still.
 */
export const FINDER_ENGINE_RPM_MIN = 400;

/**
 * Ticket P4p G2 (binding, field test 9 BUG-B): the ONE rule the Find rows and
 * the result header render, replacing the screen's direct
 * `engineNotDetectedRunning` call.
 *
 * Order matters, and it is the whole fix: the finder's OWN reading
 * (`engineRunning`, read inside the round over the adapter it holds) decides
 * whenever it exists, because it is the only evidence that CAN exist while the
 * finder owns the adapter -- telemetry is stopped for the entire time (user,
 * binding: "telemetry and the Signal Finder never run simultaneously"). A
 * live telemetry sample is used only when the finder has no reading of its
 * own, and then exactly under the old rules (fresh, non-zero).
 */
export function finderEngineWarning(input: {
  engineRequirement: SignalEngineRequirement;
  engineRunning: boolean | null;
  recentSample: SignalRecentEngineSample | null;
  nowMs: number;
}): boolean {
  if (input.engineRequirement !== 'running') return false;
  if (input.engineRunning !== null) return !input.engineRunning;
  return engineNotDetectedRunning(input.engineRequirement, input.recentSample, input.nowMs);
}

/**
 * Ticket P4p G3 (binding, field test 9): what a target's "the plan is empty
 * because its discovery range was never swept" row hands the DID sweep screen
 * -- the FIRST unswept discovery range of `target`, as navigation params.
 * `null` when the target declares no range at all (nothing to offer, so no
 * button). A thin, pure wrapper over `@circuit/core`'s own
 * `nextDiscoveryStep`, so the button and the next-step line can never disagree
 * about which range comes next.
 */
export interface DidSweepScanParams {
  /** `null` = "every ECU that answered" (the generic catalog's own wording). */
  ecu: number | null;
  fromDid: number;
  toDid: number;
  estimatedMinutes: number;
}

export function discoverySweepParamsForTarget(
  target: SignalTargetDefinition,
  measuredReqPerSec: number,
): DidSweepScanParams | null {
  const step = nextDiscoveryStep(target, measuredReqPerSec);
  if (step === null) return null;
  return { ecu: step.ecu, fromDid: step.fromDid, toDid: step.toDid, estimatedMinutes: step.estimatedMinutes };
}

/** `58F3–6FFF` — the range as the scan button states it (the ECU is named separately). */
export function formatDidRange(fromDid: number, toDid: number): string {
  const hex = (did: number): string => did.toString(16).toUpperCase().padStart(4, '0');
  return `${hex(fromDid)}–${hex(toDid)}`;
}

/**
 * Ticket P4p G3: the DID sweep screen's own From/To drafts, hydrated from the
 * navigation params the finder handed it. Anything missing or out of range
 * falls back to that screen's full-range defaults -- a prefilled sweep must
 * never start from a nonsense range, and a screen opened directly (no params)
 * behaves exactly as it always did.
 */
export function sweepRangeDraftsFromParams(
  params: { fromDid?: number; toDid?: number } | undefined,
): { from: string; to: string } {
  const draft = (did: number | undefined): string | null =>
    typeof did === 'number' && Number.isInteger(did) && did >= 0 && did <= 0xffff
      ? did.toString(16).toUpperCase().padStart(4, '0')
      : null;
  const from = draft(params?.fromDid);
  const to = draft(params?.toDid);
  return from === null || to === null ? { from: '0000', to: 'FFFF' } : { from, to };
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

/**
 * The priority pools of item 10, already ECU-tagged — extended by ticket P4o
 * O4 with `confirmed` (the target's own previously confirmed binding(s),
 * read before every other pool). Computed once per `find()` and reused by
 * every `nextRound()`.
 */
interface FinderPools {
  confirmed: SignalFinderTargetRef[];
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
  /** P4m-FIX1 X2: the per-DID request budget — and, times the entry count, the bound Z5's probe line states. */
  const requestTimeoutMs =
    deps.requestTimeoutMs !== undefined && Number.isFinite(deps.requestTimeoutMs) && deps.requestTimeoutMs > 0
      ? deps.requestTimeoutMs
      : FINDER_REQUEST_TIMEOUT_MS;

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
    pendingReplace: null,
    replacedBindings: [],
    sessionId: null,
    startedAtUtc: null,
    measuredReqPerSec: assumedReqPerSec,
    rateSource: 'assumed',
    diagnosticReqPerSec: null,
    probeProgress: null,
    engineRpm: null,
    engineRunning: null,
    ruledOutCount: 0,
    adapterTeardownPending: false,
    error: null,
    errorCode: null,
  };

  let samples: SignalFinderSample[] = [];
  let generation = 0;
  let activeRun: Promise<void> | null = null;
  let control: DidSweepControl = { paused: false, stopped: false };
  let activeTransport: ObdTransport | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  /** P4m-FIX3 Z6: a `close()` the teardown gave up WAITING for but not tracking. Non-null → no new find. */
  let pendingClose: Promise<void> | null = null;
  /**
   * P4m-REV5 M6: the phase a teardown REFUSAL displaced. Clearing the refusal
   * used to force `'idle'`, so a driver who tapped Find one moment too early
   * lost the finished round he was still reading. The refusal is a detour, and
   * a detour ends where it started.
   */
  let phaseBeforeTeardownRefusal: SignalFinderPhase | null = null;

  /** Everything a `nextRound()` needs from the find that started it. */
  let currentTarget: SignalTargetDefinition | null = null;
  let currentPools: FinderPools = { confirmed: [], hypotheses: [], changed: [], cached: [] };
  let readEntries: SignalFinderPlanEntry[] = [];
  let noResponse: SignalFinderTargetRef[] = [];
  /** Ticket P4p G5: the `ecu:did` keys earlier COMPLETED finds ruled out for the CURRENT target -- read once per find, applied to every pool. */
  let ruledOutKeys: ReadonlySet<string> = new Set();

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

  /** Resolves after `ms`, and can be cancelled so no timer is left running. */
  function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
    });
    return {
      promise,
      cancel: () => {
        if (timer !== null) clearTimeout(timer);
      },
    };
  }

  /**
   * P4m-FIX2 Y6 (Codex P4m-REV2 finding 16, MEDIUM): "normal success, connect
   * failure, runner error and stop all call `close()`, but an indefinitely
   * pending `close()` blocks BOTH `stop()` and the reservation release because
   * it is awaited without a bound".
   *
   * P4m-FIX3 Z6 (Codex P4m-REV3 finding 12, MEDIUM): "the timeout fallback
   * merely checks optional, non-contractual `destroy`/`abort` methods and
   * resolves even when neither exists or they throw; reservation release then
   * occurs while the original `close()` can remain pending". So the ORDER is
   * now explicit, and honest at every step:
   *
   *  1. wait for `close()` to SETTLE — that is the normal path, and the
   *     reservation is released only after it;
   *  2. at {@link DEFAULT_CLOSE_TIMEOUT_MS}, try whatever hard abort the
   *     transport happens to expose (the ENet TCP transport destroys its socket
   *     inside `close()`; `ObdTransport` promises nothing more) and keep
   *     waiting for the close;
   *  3. at {@link DEFAULT_TEARDOWN_TIMEOUT_MS} give up WAITING, not TRACKING:
   *     {@link pendingClose} stays subscribed to that close, the snapshot says
   *     `adapterTeardownPending`, and a new find is refused until it settles.
   */
  async function teardownTransport(): Promise<void> {
    const transport = activeTransport;
    if (transport === null) return;
    activeTransport = null;
    const closeTimeoutMs =
      deps.closeTimeoutMs !== undefined && Number.isFinite(deps.closeTimeoutMs) && deps.closeTimeoutMs > 0
        ? deps.closeTimeoutMs
        : DEFAULT_CLOSE_TIMEOUT_MS;
    const teardownTimeoutMs =
      deps.teardownTimeoutMs !== undefined && Number.isFinite(deps.teardownTimeoutMs) && deps.teardownTimeoutMs > 0
        ? Math.max(deps.teardownTimeoutMs, closeTimeoutMs)
        : Math.max(DEFAULT_TEARDOWN_TIMEOUT_MS, closeTimeoutMs);

    let settled = false;
    const closed = (async (): Promise<void> => {
      try {
        await transport.close();
      } catch {
        // A transport that fails to close is as gone as one that closed.
      }
      settled = true;
    })();

    const soft = delay(closeTimeoutMs);
    await Promise.race([closed, soft.promise]);
    soft.cancel();
    if (settled) return;

    // (2) Best effort, and only best effort: neither method is contractual.
    const abortable = transport as ObdTransport & { destroy?: () => void; abort?: () => void };
    try {
      if (typeof abortable.destroy === 'function') abortable.destroy();
      else if (typeof abortable.abort === 'function') abortable.abort();
    } catch {
      // A transport that cannot even be destroyed must still not hold the
      // reservation hostage -- step (3) is what covers that.
    }
    const hard = delay(teardownTimeoutMs - closeTimeoutMs);
    await Promise.race([closed, hard.promise]);
    hard.cancel();
    if (settled) return;

    // (3) Released, tracked, and SAID.
    pendingClose = closed;
    emit({ adapterTeardownPending: true });
    void closed.then(() => {
      if (pendingClose !== closed) return;
      pendingClose = null;
      /**
       * P4m-FIX4 W5 (Codex P4m-REV4 finding 5, LOW): the flag was cleared and
       * the ERROR it installed was not, so a driver who had tapped Find while
       * the close was outstanding kept reading "the adapter is still shutting
       * down" after it had shut down — an error with nothing left behind it.
       * The adapter confirming its own teardown is the end of that refusal:
       * the message goes with the flag, and the screen leaves the error phase
       * unless something else put it there.
       */
      const stale = snapshot.errorCode === 'adapter-teardown-pending';
      const displaced = phaseBeforeTeardownRefusal;
      phaseBeforeTeardownRefusal = null;
      emit({
        adapterTeardownPending: false,
        ...(stale
          ? {
              error: null,
              errorCode: null,
              // M6: back to whatever the refusal interrupted (a finished
              // result, most often), never a blanket 'idle'.
              phase: snapshot.phase === 'error' ? (displaced ?? 'idle') : snapshot.phase,
            }
          : {}),
      });
    });
  }

  /**
   * Item 10's three pools, for the WHOLE find (every ECU at once — this is no
   * longer a per-ECU pass list). Hypotheses are ordered by ECU then DID so a
   * round is reproducible; change evidence keeps the order the observation
   * itself ranked it in; cached responders keep the sweep's own order (short
   * responses before blocks).
   */
  /**
   * Ticket P4p G5 (binding): the `ecu:did` keys earlier COMPLETED finds ruled
   * out for `target` on THIS profile. Never throws: a store that fails to read
   * degrades to "nothing is excluded", which is the pre-ticket behaviour --
   * a find must never be blocked by the memory of an earlier one.
   */
  async function readRuledOutKeys(target: SignalTargetDefinition): Promise<ReadonlySet<string>> {
    if (deps.ruledOutStore === undefined) return new Set();
    try {
      const rows = await deps.ruledOutStore.listRuledOut(profileId, target.id);
      return new Set(rows.map((row) => `${row.ecu}:${row.did}`));
    } catch (error) {
      console.warn('[signalFinderController] could not read the ruled-out DIDs -- none are excluded', error);
      return new Set();
    }
  }

  async function collectPools(
    target: SignalTargetDefinition,
    /** Ticket P4p G5: excluded BEFORE the budget, so what a round can read is what is still worth reading. */
    excluded: ReadonlySet<string> = new Set(),
  ): Promise<FinderPools> {
    /**
     * P4o O4 (binding, field test 8): the target's OWN previously confirmed
     * binding, on THIS profile — read before every other pool. A
     * generic-profile find for `brakePressure` used to never even OFFER the
     * Supra's field-confirmed 0x58B7 (it is not a hypothesis on the generic
     * catalog), so the two-level DME flag 0x4002 — a plain cached responder
     * — won the round unopposed and got silently confirmed over it.
     */
    const confirmed: SignalFinderTargetRef[] = [];
    if (deps.bindingStore !== undefined) {
      const existing = await deps.bindingStore.getBinding(profileId, target.id);
      if (existing !== null) confirmed.push({ ecu: existing.ecu, did: existing.did });
    }
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
    // Ticket P4p G5 (binding, the user's own words after field test 9: "they
    // found nothing -- never offer them again"): every pool minus what an
    // earlier COMPLETED find already scored `unrelated` for THIS target. The
    // `confirmed` pool is deliberately exempt -- it is the user's own confirm,
    // and it leads every round by design (P4o O4).
    const keep = (entry: SignalFinderTargetRef): boolean => !excluded.has(`${entry.ecu}:${entry.did}`);
    return {
      confirmed,
      hypotheses: hypotheses.filter(keep),
      changed: changed.filter(keep),
      cached: cached.filter(keep),
    };
  }

  /** {@link readEntries}, grouped per ECU — what the result header and the export count. */
  function passesFromReadEntries(entries: readonly SignalFinderPlanEntry[]): SignalFinderEcuPass[] {
    const byEcu = new Map<number, SignalFinderEcuPass>();
    for (const entry of entries) {
      let pass = byEcu.get(entry.ecu);
      if (pass === undefined) {
        pass = { ecu: entry.ecu, dids: [], confirmedDids: [], hypothesisDids: [], changedDids: [], cachedDids: [] };
        byEcu.set(entry.ecu, pass);
      }
      (pass.dids as number[]).push(entry.did);
      if (entry.source === 'confirmed') (pass.confirmedDids as number[]).push(entry.did);
      else if (entry.source === 'hypothesis') (pass.hypothesisDids as number[]).push(entry.did);
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

  /**
   * One slice of the eligible pools at `reqPerSec`, minus what earlier rounds
   * read, minus the ECUs the probe found silent and (P4m-FIX2 Y2) minus the
   * INDIVIDUAL DIDs it attempted and got nothing from.
   */
  function planRound(
    reqPerSec: number,
    silentEcus: readonly number[],
    silentDids: readonly SignalFinderTargetRef[] = [],
  ): FinderRunPlan {
    return planFinderRun(
      reqPerSec,
      currentPools.confirmed,
      currentPools.hypotheses,
      currentPools.changed,
      currentPools.cached,
      {
        budget: budgetFor(reqPerSec),
        exclude: readEntries,
        silentEcus,
        silentDids,
      },
    );
  }

  /**
   * Ticket P4p G2 (binding, field test 9 BUG-B): ONE standard mode-01 0x0C
   * request, on the finder's own channel, at probe time -- the engine check
   * the driver actually needs while the finder owns the adapter.
   *
   * Everything here is existing, whitelisted machinery: `buildObdMode01Request`
   * (SID 0x01, inside the read-only whitelist by construction, re-asserted
   * before sending), `parseUdsResponse` + `extractObdMode01Data` for the
   * `41 0C A B` frame, and `pidCodec`'s own `decodeMode01Response` for the
   * (256A+B)/4 formula -- the finder never writes an rpm formula of its own.
   *
   * `null` on ANY doubt (timeout, NRC, an echoed PID that is not 0x0C, a short
   * frame, a throw): an unknown engine state is reported as unknown, never as
   * running. Bounded by the SAME per-request timeout every finder exchange
   * uses, so a mute ECU costs one 300 ms window before the script.
   */
  async function sendEngineRpmRequest(channel: SweepTransport): Promise<void> {
    try {
      const request = buildObdMode01Request(MODE01_RPM_PID);
      assertAllowedRequest(request);
      await channel.send(request);
    } catch (error) {
      // A refused/failed send is not evidence about the engine, and must never
      // break the find it was asked inside of.
      console.warn('[signalFinderController] the engine rpm request could not be sent', error);
    }
  }

  /**
   * Reads whatever the rpm channel has ALREADY received -- never a wait of its
   * own (`nextResponse(0)`), so the engine check costs the driver no time at
   * all: the request went out before the probe, and by the time the probe is
   * over a live DME has long since answered. Anything that is not a
   * `41 0C A B` frame (a DID response from the same ECU, an NRC, a stray) is
   * skipped, bounded by {@link ENGINE_RPM_DRAIN_LIMIT}; `null` means "nothing
   * that answers the question has arrived", which the snapshot reports as
   * UNKNOWN and never as "not running".
   */
  async function pollEngineRpm(channel: SweepTransport): Promise<number | null> {
    for (let attempt = 0; attempt < ENGINE_RPM_DRAIN_LIMIT; attempt += 1) {
      try {
        const response = await channel.nextResponse(0);
        if (response === 'timeout') return null;
        const parsed = parseUdsResponse(response);
        if (parsed.kind !== 'positive') continue;
        if (parsed.sid !== 0x41) continue; // a DID answer from the same ECU -- not this question.
        const data = extractObdMode01Data(parsed.sid, parsed.data, MODE01_RPM_PID);
        const hex = [0x41, MODE01_RPM_PID, ...data].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const rpm = decodeMode01Response('rpm', hex);
        return Number.isFinite(rpm) ? rpm : null;
      } catch {
        // A malformed/mismatched frame proves nothing -- keep draining.
        continue;
      }
    }
    return null;
  }

  /** Applies an rpm reading (or the absence of one) to the snapshot. */
  function emitEngineReading(rpm: number | null): void {
    emit({ engineRpm: rpm, engineRunning: rpm === null ? null : rpm > FINDER_ENGINE_RPM_MIN });
  }

  /**
   * Ticket P4p G5 (binding): what a COMPLETED find leaves behind for the next
   * one. A `(ecu, did)` is ruled out only when EVERY score it produced this
   * session says `unrelated` -- a block DID with one unrelated byte offset and
   * one `insufficient` offset has not been judged, and stays in the pool.
   * `insufficient`, silent and never-read DIDs are never written here at all:
   * they are the absence of evidence, which is exactly what item 12's honesty
   * rule protects.
   */
  async function persistRuledOut(target: SignalTargetDefinition, scores: readonly SignalCandidateScore[]): Promise<void> {
    const store = deps.ruledOutStore;
    if (store === undefined) return;
    const byKey = new Map<string, { ecu: number; did: number; allUnrelated: boolean }>();
    for (const score of scores) {
      const key = `${score.ecu}:${score.did}`;
      const entry = byKey.get(key) ?? { ecu: score.ecu, did: score.did, allUnrelated: true };
      entry.allUnrelated = entry.allUnrelated && score.verdict === 'unrelated';
      byKey.set(key, entry);
    }
    const at = nowUtc();
    const records: SignalFinderRuledOutRecord[] = [];
    for (const entry of byKey.values()) {
      if (!entry.allUnrelated) continue;
      records.push({
        profileId,
        targetId: target.id,
        ecu: entry.ecu,
        did: entry.did,
        verdict: 'unrelated',
        sessionId: snapshot.sessionId ?? '',
        ruledOutAtUtc: at,
      });
    }
    if (records.length === 0) return;
    try {
      await store.addRuledOut(records);
      const merged = new Set(ruledOutKeys);
      for (const record of records) merged.add(`${record.ecu}:${record.did}`);
      ruledOutKeys = merged;
      emit({ ruledOutCount: merged.size });
    } catch (error) {
      console.warn('[signalFinderController] could not persist the ruled-out DIDs', error);
    }
  }

  /**
   * P4m-FIX3 Z4: `silentEcus` is the list of ECUs the PROBE found wholly
   * silent, not "every ECU that has a silent DID on it". Build 8 derived it
   * from `plan.silent`, so one individually silent DID — which is now the
   * normal fate of a hypothesis that missed its retry — made the screen and the
   * export say "ECU 0x29 silent" about an ECU that had answered on every other
   * DID. Item 12's honesty rule applies to reasons as much as to counts.
   */
  function emitPlan(
    plan: FinderRunPlan,
    unattempted: readonly SignalFinderTargetRef[] = [],
    probeSilentEcus: readonly number[] = [],
  ): void {
    const inPlan = new Set(plan.silent.map((entry) => entry.ecu));
    emit({
      budget: plan.budget,
      ecus: [...new Set(plan.dids.map((entry) => entry.ecu))].sort((a, b) => a - b),
      notReadDids: [...plan.notRead.map(refOf), ...unattempted.map(refOf)],
      notReadCount: plan.notRead.length + unattempted.length,
      silentDids: plan.silent.map(refOf),
      silentEcus: [...new Set(probeSilentEcus)].filter((ecu) => inPlan.has(ecu)).sort((a, b) => a - b),
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
        errorCode: null,
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

      // Y5 (Codex P4m-REV2 finding 15): the LAST gate before anything is
      // acquired or connected. A stop that landed while the pools were being
      // collected must never be followed by a reservation or a socket.
      if (myGeneration !== generation || control.stopped) return;

      token = reservation.tryAcquire('signalFinder');
      if (token === null && reservation.isReleasePending()) {
        // A prior holder's close+release is already in flight -- wait it out
        // once rather than reporting a busy adapter (same discipline as the
        // sweep controller's own reacquire).
        await reservation.whenFree();
        token = reservation.tryAcquire('signalFinder');
      }
      if (token === null) {
        emit({ phase: 'error', error: RESERVATION_BUSY_MESSAGE, errorCode: 'adapter-busy', step: null });
        return;
      }

      // Z5: the probe is a phase of its own, and it counts out loud.
      // P4m-FIX4 W3: the bound it states is the RUNNER's own exchange bound
      // (`finderProbeBoundMs`) — one exchange can spend a timeout in `send()`,
      // another on its response window and one more per allowed 0x78, so
      // `entries × 300 ms` was a quarter of the truth.
      const probeTotal = provisional.dids.length;
      /**
       * P4m-REV5 M3 (partial): the round also pays for a keep-alive on EVERY
       * channel once per keep-alive interval, so the stated bound counts those
       * sends too — one round of them per interval the exchanges can span.
       */
      const probeEcuCount = new Set(provisional.dids.map((entry) => entry.ecu)).size;
      const boundFor = (total: number): number => {
        const exchangesMs = finderProbeBoundMs(total, requestTimeoutMs);
        const keepAliveRounds = Math.ceil(exchangesMs / FINDER_KEEPALIVE_INTERVAL_MS);
        return finderProbeBoundMs(total, requestTimeoutMs, probeEcuCount * keepAliveRounds);
      };
      const probeProgress = {
        probed: 0,
        total: probeTotal,
        boundMs: boundFor(probeTotal),
      };
      emit({ phase: 'probing', probeProgress });

      let plan = provisional;
      /** Z4: the ECUs the probe found WHOLLY silent — the only ones a "ECU N silent" line may name. */
      let probeSilentEcus: readonly number[] = [];
      let attempted: readonly SignalFinderTargetRef[] = [];
      let scriptStarted = false;

      if (myGeneration !== generation || control.stopped) return; // Y5, again: nothing is opened after a stop.
      const transport = deps.transportFactory();
      activeTransport = transport;
      try {
        await transport.connect();
        if (myGeneration !== generation || control.stopped) return;
        const channels = createEcuChannels(transport, deps.testerAddress, provisional.dids.map((entry) => entry.ecu));

        // Ticket P4p G2 (binding, field test 9 BUG-B): the engine check, sent
        // BEFORE the probe and read after it -- one mode-01 0x0C request on a
        // channel of its OWN (never inserted into `channels`, so the round's
        // entries and keep-alives are untouched, and draining it cannot steal
        // a probe answer). The send costs nothing to wait for, and the read
        // takes only what has already arrived, so the driver never waits on
        // an ECU that refuses the request. Fresh by construction: it happens
        // inside the very round it describes, while telemetry is stopped
        // because this find holds the single adapter reservation.
        const engineRpmChannel = createRawUdsChannel(
          transport,
          deps.testerAddress,
          deps.engineRpmEcu ?? ENGINE_RPM_ECU,
        );
        await sendEngineRpmRequest(engineRpmChannel);

        // X1: MEASURE. P4m-FIX2 Y1: ONE ATTEMPT PER PLANNED ENTRY -- not a 2 s
        // deadline. A first ECU that times out on all of its DIDs used to leave
        // the ECUs behind it unattempted while the summary still called them
        // silent; the per-DID timeout bounds this at entries x 300 ms instead.
        const probe = await runFinderRound({
          entries: provisional.dids,
          channels,
          clock: deps.clock,
          control,
          durationMs: FINDER_PROBE_DURATION_MS,
          requestTimeoutMs,
          maxPasses: 1,
          completePass: true,
          // Z5: `probed/total`, so the up-to-`entries × 300 ms` wait before the
          // metronome is something the driver can watch instead of guess at.
          onProgress: (probed, total) => {
            if (myGeneration !== generation) return;
            emit({ probeProgress: { probed, total, boundMs: boundFor(total) } });
          },
        });
        if (myGeneration !== generation || control.stopped) return;
        // G2: the DME has had the whole probe to answer -- read it now, before
        // the driver is asked to perform anything, so the row's warning is
        // already right when the metronome starts.
        emitEngineReading(await pollEngineRpm(engineRpmChannel));

        /**
         * Z4 (Codex P4m-REV3 finding 10): the ONE retry a silent HYPOTHESIS is
         * worth — a single dropped frame inside a 300 ms probe attempt proves
         * nothing — is a single explicit request made HERE, before the driver
         * starts pressing anything. Build 8 instead kept the hypothesis in the
         * round, where the runner spent three misses on it and one more in
         * every evidence window, out of the script's own 21 seconds.
         *
         * P4m-FIX4 W1/W2 (Codex P4m-REV4 findings 1 and 2, both HIGH) settled
         * WHICH hypotheses get it and WHEN the probe is summarised. Build 9
         * summarised first and retried afterwards, so:
         *
         *  - the candidates came from `summary.silentDids`, which by
         *    construction holds only misses on ECUs that are ALREADY alive: a
         *    hypothesis on a wholly silent ECU — and, when nothing answered at
         *    all, EVERY hypothesis — never got the retry it was promised, and
         *    the ECU was declared silent without it;
         *  - a hypothesis recovered by the retry was then kept in a round whose
         *    budget rested on a rate measured WITHOUT its exchange.
         *
         * So the candidates are the attempted-but-unanswered HYPOTHESES of the
         * probe itself, and the retry is MERGED into the probe
         * (`mergeFinderRounds`) before anything is summarised. One summary over
         * probe + retry decides the rate, the silent ECUs and the silent DIDs
         * alike.
         */
        const hypothesisKeys = new Set(currentPools.hypotheses.map(keyOf));
        const probeAnswered = new Set(probe.answered.map(keyOf));
        const silentHypotheses = probe.attempted.filter(
          (entry) => hypothesisKeys.has(keyOf(entry)) && !probeAnswered.has(keyOf(entry)),
        );
        let measured = probe;
        if (silentHypotheses.length > 0) {
          const retry = await runFinderRound({
            entries: silentHypotheses,
            channels,
            clock: deps.clock,
            control,
            durationMs: FINDER_PROBE_DURATION_MS,
            requestTimeoutMs,
            maxPasses: 1,
            completePass: true,
            // W3: the retry is part of the probe the driver is watching — its
            // entries are counted into the same n/N (and the same bound), so
            // the line keeps moving and reaches N/N instead of freezing.
            onProgress: (probed, total) => {
              if (myGeneration !== generation) return;
              emit({
                probeProgress: {
                  probed: probeTotal + probed,
                  total: probeTotal + total,
                  boundMs: boundFor(probeTotal + total),
                },
              });
            },
          });
          if (myGeneration !== generation || control.stopped) return;
          measured = mergeFinderRounds(probe, retry);
        }
        const summary = summarizeFinderProbe(measured, provisional.dids, assumedReqPerSec);
        const silentDids: readonly SignalFinderTargetRef[] = summary.silentDids;

        // Z1 (the LEAD's E2E defect): the budget and every estimate are sized
        // from the RETAINED entries' own rate; the probe's overall figure, the
        // timeouts of everything just dropped included, is kept as diagnostics.
        emit({
          measuredReqPerSec: summary.reqPerSec,
          rateSource: summary.rateSource,
          diagnosticReqPerSec: summary.timeoutInclusiveReqPerSec,
          probeProgress: null,
        });

        // X2 + Y2 + Z4: re-plan at that rate, without the silent ECUs and
        // without the individual DIDs that missed (a hypothesis included, once
        // its one retry has missed too) -- the budget they were consuming is
        // refilled from the next pool.
        plan = planRound(summary.reqPerSec, summary.silentEcus, silentDids);
        probeSilentEcus = summary.silentEcus;
        emitPlan(plan, [], probeSilentEcus);
        if (plan.dids.length > 0) {
          for (const ecu of new Set(plan.dids.map((entry) => entry.ecu))) {
            if (!channels.has(ecu)) channels.set(ecu, createRawUdsChannel(transport, deps.testerAddress, ecu));
          }
          emit({ phase: 'running' }); // Z5: the script -- and only now -- is what the metronome paces.
          const result = await runFinderRound({
            entries: plan.dids,
            channels,
            clock: deps.clock,
            control,
            durationMs: timeline.pollDurationMs,
            requestTimeoutMs,
            // P4m-FIX2 Y3: the back-off cooldown is bounded to THIS script's
            // own evidence window (its shortest step), so a DID that goes quiet
            // for one press is retried at the next one instead of being written
            // off for the rest of the round -- the defect that made a recovered
            // DID score `insufficient`.
            windowMs: timeline.steps.reduce(
              (shortest, step) => Math.min(shortest, step.durationMs),
              Number.POSITIVE_INFINITY,
            ),
            // P4m-FIX2 Y8: poll no faster than the rate the budget was sized
            // from. On a real adapter the adapter is the bottleneck anyway; on
            // the in-memory simulator this is what stops the round becoming a
            // hot loop that over-polls every entry.
            targetReqPerSec: summary.reqPerSec,
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
          // G2: a DME that answered slower than the probe still gets counted --
          // a second, equally free look at what has arrived since. Never
          // overwrites a reading the first look already got.
          if (snapshot.engineRpm === null) emitEngineReading(await pollEngineRpm(engineRpmChannel));
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
      emitPlan(plan, unattempted, probeSilentEcus);

      const answered = new Set(samples.map((sample) => `${sample.ecu}:${sample.did}`));
      noResponse = readEntries.filter((entry) => !answered.has(keyOf(entry))).map(refOf);
      const scores = rescore(target, timeline);
      const found = scores.some((score) => score.verdict === 'found');
      // Ticket P4p G5 (binding): only a COMPLETED script (the driver actually
      // performed the metronome, and nothing stopped it) is evidence worth
      // remembering -- a run cut short says nothing about the DIDs it read.
      if (scriptStarted && !control.stopped) await persistRuledOut(target, scores);
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
      if (myGeneration === generation) emit({ phase: 'error', error: message, errorCode: 'run-failed', step: null });
    } finally {
      stopTicker();
      // Z5: whatever ended the round (a stop mid-probe included), the probe's
      // own progress line is over.
      if (myGeneration === generation && snapshot.probeProgress !== null) emit({ probeProgress: null });
      // Y6: the release lives in a NESTED finally, so even a teardown that
      // somehow still throws or hangs past its own bound cannot leave the
      // adapter reserved for a session that has ended.
      try {
        await teardownTransport();
      } finally {
        if (token !== null) reservation.release(token);
      }
    }
  }

  function busy(): boolean {
    return (
      snapshot.phase === 'preparing' ||
      snapshot.phase === 'probing' ||
      snapshot.phase === 'running' ||
      snapshot.phase === 'scoring'
    );
  }

  /**
   * P4m-FIX3 Z6: a find is refused while the LAST transport's `close()` is
   * still unsettled — opening a second socket to an adapter that may still hold
   * the first is exactly what the reservation exists to prevent, and the
   * reservation itself was already released (bounded) to keep `stop()` honest.
   */
  function teardownPending(): boolean {
    if (pendingClose === null) return false;
    // M6: the FIRST refusal is the one that displaced something; a second tap
    // must not overwrite the phase we owe the driver back.
    if (snapshot.errorCode !== 'adapter-teardown-pending') phaseBeforeTeardownRefusal = snapshot.phase;
    emit({ phase: 'error', error: ADAPTER_TEARDOWN_PENDING_MESSAGE, errorCode: 'adapter-teardown-pending', step: null });
    return true;
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
      if (busy() || teardownPending()) return;
      const target = findSignalTarget(catalog, targetId);
      if (target === null) {
        emit({
          phase: 'error',
          error: `No target definition for "${targetId}" in profile "${catalog.profileId}".`,
          errorCode: 'no-target',
        });
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
        // P4o O3: a fresh find (a new target, or the same one again) starts
        // with nothing armed — an armed replace belongs to the SCORE ROW that
        // armed it, and that row is gone the moment a new script runs.
        pendingReplace: null,
        // Ticket P4o-FIX1 V2 (Codex P4o-REV1 finding 3, MEDIUM): `replaced[]`
        // is documented as "every binding a confirm in THIS session replaced"
        // (`signalFinderExport.ts`) — a fresh find is a NEW session (a fresh
        // `sessionId`, below), so it must start with nothing replaced either,
        // never carrying a previous session's replacements into this one's
        // export.
        replacedBindings: [],
        error: null,
        errorCode: null,
        // X1: a fresh find has measured NOTHING yet -- it says so until its
        // own probe reports, and never inherits the last find's reading.
        measuredReqPerSec: assumedReqPerSec,
        rateSource: 'assumed',
        // Z1/Z5: a fresh find has probed nothing yet. (`adapterTeardownPending`
        // is deliberately NOT reset here -- it belongs to the teardown that set
        // it, and only that close settling may clear it.)
        diagnosticReqPerSec: null,
        probeProgress: null,
        // Ticket P4p G2: a fresh find has read no rpm of its own yet -- and
        // must never inherit the previous find's reading, which could be
        // minutes old and about a different engine state entirely.
        engineRpm: null,
        engineRunning: null,
        budget: budgetFor(assumedReqPerSec),
        sessionId: `signal-finder-${deps.clock.now()}-${Math.random().toString(36).slice(2, 8)}`,
        startedAtUtc: nowUtc(),
        timeline: null,
      });
      /**
       * P4m-FIX2 Y5 (Codex P4m-REV2 finding 15, MEDIUM): "`stop()` does not
       * await a find still collecting pools because `activeRun` is assigned
       * only afterwards; stop can resolve and the old find can subsequently
       * acquire/connect a transport before noticing `control.stopped`".
       *
       * So the WHOLE find — pool collection included — is one promise,
       * registered SYNCHRONOUSLY before the first await. `stop()` awaits that,
       * and `doRound` re-checks `control.stopped` before the reservation and
       * before the transport.
       */
      const run = (async (): Promise<void> => {
        // Ticket P4p G5: the exclusions are read ONCE per find and applied to
        // every pool (and to every `nextRound()` slice, which reuses these
        // pools).
        ruledOutKeys = await readRuledOutKeys(target);
        emit({ ruledOutCount: ruledOutKeys.size });
        currentPools = await collectPools(target, ruledOutKeys);
        if (myGeneration !== generation || control.stopped) return;
        await doRound(myGeneration, target, 1);
      })();
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
      // Ticket P4p G5: a DID that is ruled out is not eligible -- so a target
      // whose whole pool has been ruled out reports 0 and its row offers the
      // discovery scan (G3) instead of a find that would re-read the same
      // DIDs the user already watched fail.
      const pools = await collectPools(target, await readRuledOutKeys(target));
      const keys = new Set<string>();
      for (const pool of [pools.confirmed, pools.hypotheses, pools.changed, pools.cached]) {
        for (const entry of pool) keys.add(`${entry.ecu}:${entry.did}`);
      }
      return keys.size;
    },

    async nextRound(): Promise<void> {
      const target = currentTarget;
      if (busy() || target === null || snapshot.notReadCount === 0) return;
      if (teardownPending()) return; // Z6: one more script is one more socket.
      generation += 1;
      const myGeneration = generation;
      control = { paused: false, stopped: false };
      // Ticket P4o-FIX1 V4 (Codex P4o-REV1 finding 5, LOW): a fresh script is
      // read against a RE-SORTED score list (a new round's samples can change
      // every row's rank) — row identity no longer guarantees an armed
      // replace still names the row the driver actually saw it on, so a
      // pending replace does not survive into another round.
      emit({ pendingReplace: null });
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
      // Ticket P4o-FIX1 V4 (Codex P4o-REV1 finding 5, LOW): `find()` already
      // resets `pendingReplace`, but a driver who stops mid-run and then just
      // taps Confirm again (never a fresh find) used to keep whatever was
      // armed from before the stop — a tap the screen shows as a plain
      // confirm could silently commit as a REPLACE instead.
      if (snapshot.pendingReplace !== null) emit({ pendingReplace: null });
    },

    getSamples(): readonly SignalFinderSample[] {
      return samples;
    },

    async ruledOutDidCount(targetId): Promise<number> {
      const target = findSignalTarget(catalog, targetId);
      if (target === null) return 0;
      return (await readRuledOutKeys(target)).size;
    },

    async clearRuledOut(targetId): Promise<void> {
      const store = deps.ruledOutStore;
      if (store === undefined) return;
      const target = findSignalTarget(catalog, targetId);
      if (target === null) return;
      try {
        await store.clearRuledOut(profileId, target.id);
      } catch (error) {
        console.warn('[signalFinderController] could not clear the ruled-out DIDs', error);
        return;
      }
      // The pools of a find already in progress are not rebuilt here (that
      // would change what the CURRENT script is reading mid-run); the next
      // find picks the restored DIDs up, which is what the control promises.
      if (currentTarget?.id === target.id || snapshot.targetId === target.id || snapshot.targetId === null) {
        ruledOutKeys = new Set();
        emit({ ruledOutCount: 0 });
      }
    },

    async confirmBinding(channel, score): Promise<VehicleProfileBinding | null> {
      if (deps.bindingStore === undefined) return null;
      /**
       * Ticket P4o O3 (binding, field test 8): "when a target already has a
       * field-confirmed binding on a different (ecu,did), the confirm button
       * reads 'Replace 0x58B7 → 0x4002' and requires a second tap (inline
       * confirm) ... the export lists the replaced binding in a `replaced`
       * entry." Field bug this closes: a plain re-confirm used to overwrite
       * the engine-running-confirmed 0x58B7 with the generic profile's
       * two-level 0x4002 silently — the monitor's brake pressure became
       * 0/100 % with no warning anywhere.
       *
       * The state machine lives HERE (not in the screen) so it is testable
       * without rendering anything: a FIRST call for a differing binding
       * arms {@link SignalFinderSnapshot.pendingReplace} and writes nothing;
       * only a SECOND call naming the SAME (channel, ecu, did, byteOffset)
       * actually commits the replacement.
       */
      const byteOffset = score.byteOffset ?? null;
      const existing = await deps.bindingStore.getBinding(profileId, channel);
      const isReplace =
        existing !== null &&
        existing.status === 'field-confirmed' &&
        (existing.ecu !== score.ecu || existing.did !== score.did);
      if (isReplace) {
        const pending = snapshot.pendingReplace;
        const armed =
          pending !== null &&
          pending.channel === channel &&
          pending.ecu === score.ecu &&
          pending.did === score.did &&
          pending.byteOffset === byteOffset;
        if (!armed) {
          emit({ pendingReplace: { channel, ecu: score.ecu, did: score.did, byteOffset, existing } });
          return null;
        }
      }
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
          // Ticket P4n-FIX1 Q1 (binding), R5 fix (Codex re-review MEDIUM): the
          // boolean decode's second precedence, right after `flagBit` --
          // `@circuit/core`'s scorer derives this from the samples it actually
          // observed (`scoreSignalCandidates`'s own `deriveActiveValueHex`),
          // never re-inferred here from `min`/`max` (which cannot prove a
          // two-level series and has no answer for a block series at all).
          // `undefined` (an analog reading, or no active sample ever
          // observed) persists as `null` -- falls back to (c) coarse.
          activeValueHex: score.activeValueHex ?? null,
          correlationSign: score.correlationSign,
          restValueHex: score.restValueHex,
          min: score.min,
          max: score.max,
        }),
        updatedAtUtc: nowUtc(),
      };
      await deps.bindingStore.upsertBinding(binding);

      emit({
        confirmedChannels: [...new Set([...snapshot.confirmedChannels, channel])],
        pendingReplace: null,
        replacedBindings: isReplace
          ? [
              ...snapshot.replacedBindings,
              {
                channel,
                ecu: score.ecu,
                did: score.did,
                previousEcu: existing!.ecu,
                previousDid: existing!.did,
                replacedAtUtc: binding.updatedAtUtc,
              },
            ]
          : snapshot.replacedBindings,
      });
      return binding;
    },
  };
}
