/**
 * DID sweep — guided candidate observation addendum (2026-08-27, binding —
 * Phase 4i, user clarification after sweep test 1): "once the responders are
 * written I can't tell whether they change or not; they are written once and
 * stay like that. So the sweep result alone is useless for finding
 * brake/steering; the OBSERVATION on the filtered candidates must be a
 * visible, guided, repeated re-read."
 *
 * Four ~6s phases, in order, each re-reading every candidate DID
 * round-robin (the mobile controller runs core's EXISTING `runDidObservation`
 * once per phase, on the SAME connection -- this module owns none of that
 * wire-level polling, only the pure bookkeeping of what was observed):
 *   1. `baseline` -- "Hold still (baseline)": the reference/control phase --
 *      a DID that's ALSO static everywhere else is not a candidate at all.
 *   2. `brake`    -- "Press the BRAKE pedal a few times"
 *   3. `steering` -- "Turn the STEERING wheel left/right"
 *   4. `throttle` -- "Blip the THROTTLE"
 *
 * Pure, deterministic -- no I/O. `computeDidCandidateSummaries` is the single
 * entry point: fed the FULL flat sample log (every candidate DID, every
 * phase, in chronological arrival order), it computes each DID's per-phase
 * "changed" badge, cross-phase min/max/distinct-value-count/sample-count,
 * and ranks candidates per the user's own ordering: DIDs that changed in
 * EXACTLY ONE active phase (brake/steering/throttle) but were static at
 * baseline first (the strongest brake/steering candidates), then DIDs that
 * changed in several active phases, then static DIDs last (collapsed by the
 * UI).
 */

export type DidObservationPhaseId = 'baseline' | 'brake' | 'steering' | 'throttle';

export interface DidObservationPhaseSpec {
  id: DidObservationPhaseId;
  /** Short label for a collapsed/compact UI (e.g. a badge). */
  label: string;
  /** Full on-screen instruction shown for the phase's whole countdown. */
  prompt: string;
  /** default 6000 (user: "each ~6s"). */
  durationMs: number;
}

const DEFAULT_PHASE_DURATION_MS = 6_000;

/** Fixed, ordered phase plan (user: "baseline -> brake -> steering -> throttle"). */
export const DID_OBSERVATION_PHASES: readonly DidObservationPhaseSpec[] = [
  { id: 'baseline', label: 'Baseline', prompt: 'Hold still (baseline)', durationMs: DEFAULT_PHASE_DURATION_MS },
  { id: 'brake', label: 'Brake', prompt: 'Press the BRAKE pedal a few times', durationMs: DEFAULT_PHASE_DURATION_MS },
  { id: 'steering', label: 'Steering', prompt: 'Turn the STEERING wheel left/right', durationMs: DEFAULT_PHASE_DURATION_MS },
  { id: 'throttle', label: 'Throttle', prompt: 'Blip the THROTTLE', durationMs: DEFAULT_PHASE_DURATION_MS },
];

/** Phases whose "changed" flag counts toward candidate ranking below -- `baseline` is the control/reference phase, never itself "active" driver input. */
const ACTIVE_PHASES: readonly DidObservationPhaseId[] = ['brake', 'steering', 'throttle'];

/**
 * Ticket P4k (binding). Field evidence (test 4,
 * `data/field/sweeps/2026-08-29-test4-ecu29-0x5000-0x58F2.json`, DID 0x500C):
 * baseline/brake read 0x04 (brake genuinely swung to 0x05 mid-phase), but the
 * FIRST steering sample (tMs 312) still read 0x05 -- the driver's foot was
 * still on the brake pedal when the phase prompt switched. That one
 * carried-over sample made steering look "changed" too, mis-ranking a clean
 * single-phase brake signal as `changedInSeveral`. Same pattern: DME 0x5422,
 * a single 0x00 at tMs 815 of the steering phase.
 *
 * The fix is a fixed SETTLE WINDOW at the start of every phase (`baseline`
 * excepted -- it is the reference the driver is already asked to hold still
 * for BEFORE the phase begins, so it needs no settle of its own): a sample
 * whose `tMs` (relative to ITS OWN phase's start -- the same convention every
 * caller of this module already uses) falls inside the window is EXCLUDED
 * from that phase's own change evidence (and, in the mobile controller, from
 * the per-phase sample-count guarantee) -- never from the exported/persisted
 * sample log itself.
 */
export const SETTLE_MS = 1_500;

/** True iff `tMs` (relative to `phase`'s OWN start) falls inside the {@link SETTLE_MS}-style settle window and should be excluded from that phase's own change evidence -- `baseline` is NEVER settling (see {@link SETTLE_MS}'s doc comment). */
export function isSettlingSample(phase: DidObservationPhaseId, tMs: number, settleMs: number): boolean {
  return phase !== 'baseline' && tMs < settleMs;
}

/** One correlated 0x62 response observed for `did` during `phase`, timestamped RELATIVE to that phase's own start (same convention as `runDidObservation`'s `series[].samples[].tMs` -- see didSweep.ts). */
export interface DidPhaseSample {
  did: number;
  phase: DidObservationPhaseId;
  tMs: number;
  raw: Uint8Array;
  /**
   * Ticket P4j (binding, batched guided observation): which batch (0-based,
   * `planObservationBatches`' own `index`) this sample belongs to -- `undefined`
   * for a guided run that never batched its candidates (the original
   * single-pass `startGuidedObservation`/a focused shortlist run). Constant
   * for every sample of a given DID within one guided run (batches partition
   * the candidate set, a DID never moves between batches mid-run).
   */
  batchIndex?: number;
  /**
   * Ticket P4j-FIX2 V3/V4 (binding, after Codex P4j-REV2 NEW MEDIUM #1/#2):
   * which observation run (`didSweepController.ts`'s own `currentObservationId`,
   * a fresh id per `startGuidedObservation`/`startBatchedObservation`/
   * `startFocusedObservation` call) this sample belongs to -- `undefined` for
   * a caller that never tags it (this module's own ranking functions group
   * purely by `did`/`phase` and never read this field; it exists solely so
   * the export can reconcile live vs. persisted samples PER OBSERVATION
   * (never "pick the longer source" across the whole run) and keep each
   * observation's own series/`batchIndex` separate rather than merging two
   * independent runs on the same DID into one).
   */
  observationId?: string;
}

/**
 * F5 fix (P4i-FIX1, binding, after Codex P4hrev2c): a DID that changed in
 * EXACTLY ONE active phase is labelled by THAT phase specifically -- never a
 * merged "brakeOrSteeringCandidate" that throws away which phase actually
 * moved it. `rankOf` below picks the ONE active phase that changed.
 *
 * Ticket P4j-FIX2 V1 (binding, after Codex P4j-REV2 HIGH #1 PARTIAL: "a DID
 * gets five baseline/brake/steering samples, changes only under brake, then
 * fails throttle three times -- it is reported insufficient but still ranks
 * as brakeCandidate"): a DID with `insufficient` evidence in ANY phase
 * (baseline included) is ranked `insufficient` -- EXCLUDED from every other
 * rank, listed separately with its failing phases, never `brakeCandidate`/
 * `steeringCandidate`/`throttleCandidate`/`changedInSeveral` on the strength
 * of the phases it DID have enough evidence for. Under the legacy naive
 * distinctness rule (`useMarginRule: false`, the default) no phase is ever
 * `insufficient`, so this rank never arises there.
 */
export type DidCandidateRank = 'brakeCandidate' | 'steeringCandidate' | 'throttleCandidate' | 'changedInSeveral' | 'static' | 'insufficient';

/**
 * Ticket P4j-FIX1 H2 (binding, after Codex P4j-REV1 HIGH #2): a phase's own
 * verdict is TRI-state, never a bare boolean --
 *  - `changed`      : the phase genuinely differs from baseline under the rule below;
 *  - `unchanged`    : enough evidence, and it does not differ;
 *  - `insufficient` : NOT enough evidence to say either way (fewer than
 *                     `minSamplesPerPhase` positive samples in this phase or in
 *                     baseline, or the DID's samples disagreed on length).
 * The pre-fix code silently fell back to naive "did the bytes ever differ"
 * distinctness in exactly the `insufficient` case, which is what re-flagged
 * ordinary idle jitter (field: DID 0x4522 read 297 -> 305 -> 295 across ONE
 * baseline and TWO brake samples) as a brake candidate. `insufficient` never
 * counts as `changed` for ranking -- it is reported instead.
 */
export type DidPhaseEvidence = 'changed' | 'unchanged' | 'insufficient';

export interface DidCandidateSummary {
  did: number;
  /** Hex of the MOST RECENT sample across every phase, in the order `samples` was given. */
  lastRawHex: string;
  /** Total samples across every phase. */
  sampleCount: number;
  /** Decoded as an unsigned 8-bit (1-byte responses) or 16-bit big-endian (2-byte responses) integer, across every phase; `null` if no sample decoded (e.g. every response was a different length, or longer than 2 bytes). */
  min: number | null;
  max: number | null;
  /** Distinct raw-byte values observed across every phase (hex-string equality). */
  distinctValueCount: number;
  /** Whether THIS did's bytes varied at all during each phase (per-phase "CHANGED" badge). Always has an entry for every {@link DID_OBSERVATION_PHASES} id, `false` if that phase had zero samples. */
  changedInPhase: Record<DidObservationPhaseId, boolean>;
  /**
   * Ticket P4j-FIX1 H2 (binding): the tri-state verdict per phase --
   * `changedInPhase[p]` is exactly `phaseEvidence[p] === 'changed'`; the extra
   * information is WHICH of the two "not changed" cases applies. Legacy
   * callers (`useMarginRule` unset/false) only ever see `changed`/`unchanged`.
   */
  phaseEvidence: Record<DidObservationPhaseId, DidPhaseEvidence>;
  /**
   * Ticket P4j-FIX1 M3 (binding, after Codex P4j-REV1 MEDIUM #3): false when
   * THIS DID's samples disagreed on response length (e.g. a DID alternating
   * between 8 and 9 bytes). Such a DID is marked inconsistent and never ranked
   * as a candidate -- and, critically, is never SPLIT into two apparently
   * consistent candidates by a caller that routes samples to the numeric or
   * block summarizer before grouping them per DID.
   */
  lengthConsistent: boolean;
  rank: DidCandidateRank;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/** `null` unless `raw` is exactly 1 or 2 bytes (an exact-width match, same discipline as `didHeuristics.ts`'s own decode functions -- a response of any OTHER width proves nothing about a physical integer reading). */
function decodeUint(raw: Uint8Array): number | null {
  if (raw.length === 1) return raw[0] ?? 0;
  if (raw.length === 2) return (((raw[0] ?? 0) << 8) | (raw[1] ?? 0)) >>> 0;
  return null;
}

const PHASE_TO_RANK: Readonly<Record<'brake' | 'steering' | 'throttle', DidCandidateRank>> = {
  brake: 'brakeCandidate',
  steering: 'steeringCandidate',
  throttle: 'throttleCandidate',
};

function rankOf(changedInPhase: Record<DidObservationPhaseId, boolean>): DidCandidateRank {
  const changedActivePhases = ACTIVE_PHASES.filter((phase) => changedInPhase[phase]);
  if (!changedInPhase.baseline && changedActivePhases.length === 1) {
    // F5 fix (binding): label by the ONE phase that actually changed --
    // never a merged "brake/steering" guess.
    return PHASE_TO_RANK[changedActivePhases[0] as 'brake' | 'steering' | 'throttle'];
  }
  if (changedActivePhases.length >= 2) return 'changedInSeveral';
  return 'static';
}

const RANK_ORDER: Readonly<Record<DidCandidateRank, number>> = {
  brakeCandidate: 0,
  steeringCandidate: 0,
  throttleCandidate: 0,
  changedInSeveral: 1,
  static: 2,
  // Ticket P4j-FIX2 V1 (binding): sorted LAST -- excluded from ranking, never
  // mixed in among genuine candidates or even the cleanly-ruled-out static set.
  insufficient: 3,
};

/**
 * Ticket P4j (binding): "ranking per DID uses >= 5 samples (a change counts
 * only if the value range in an active phase exceeds the baseline range by a
 * margin, e.g. > 2x baseline spread or > 3 raw units)". Field evidence: with
 * only 1-2 samples/phase (the old fixed-duration flow), 0x4522 read
 * 297 -> 305 -> 295 -- ordinary baseline-level jitter, but the naive "did the
 * raw bytes ever differ" rule flagged it as a brake candidate anyway. The
 * margin rule instead compares the ACTIVE phase's own value RANGE against the
 * BASELINE phase's range, requiring it to exceed `max(marginMultiplier *
 * baselineRange, marginRawUnits)` -- the `marginRawUnits` floor is what still
 * catches a real signal even when the baseline itself happened to be
 * perfectly still (range 0, so "2x baseline" alone would demand nothing).
 *
 * `useMarginRule` defaults to `false` (byte-identical to the pre-ticket
 * behaviour -- naive "changed at all" distinctness, no sample-count gate) so
 * every existing caller/test is unaffected; the batched/focused observation
 * flows (mobile controller) opt in explicitly with `useMarginRule: true` and
 * a `minSamplesPerPhase` matching how many samples that flow actually
 * guarantees (5 for batches, 10 for a focused shortlist). The margin rule
 * also requires an exact-width (1- or 2-byte) numeric decode on EVERY sample
 * of both the active phase and baseline -- a phase that doesn't decode
 * cleanly (mixed/other lengths -- e.g. a mid-size block, see
 * `computeDidBlockCandidateSummaries` for those) falls back to the naive
 * distinctness rule rather than silently reporting "unchanged".
 */
export interface DidCandidateRankingOptions {
  /** Minimum samples BOTH the baseline phase and an active phase must have before the margin rule applies to that active phase at all -- below this, that phase falls back to naive distinctness (not enough evidence either way). Default 1 (no gate). Ignored entirely when `useMarginRule` is `false`. */
  minSamplesPerPhase?: number;
  /** Opts into the margin-based change rule described above. Default `false` (legacy naive distinctness, unchanged). */
  useMarginRule?: boolean;
  /** Default 2 ("> 2x baseline spread"). */
  marginMultiplier?: number;
  /** Default 3 ("> 3 raw units") -- the floor applied even when the baseline range is 0. */
  marginRawUnits?: number;
  /** Ticket P4k (binding): a sample of an ACTIVE phase whose `tMs` (relative to that phase's own start) is below this excludes it from that phase's own change evidence (see {@link isSettlingSample}/{@link SETTLE_MS}) -- `baseline` is never affected. Default 0 (no settle window -- byte-identical to the pre-ticket behaviour). */
  settleMs?: number;
}

// ---------------------------------------------------------------------------
// Ticket P4j-FIX1 H2 (binding) -- the change rule, shared verbatim by the
// numeric summaries, the 5-8-byte byte-wise comparison, and the 9-32-byte
// block per-offset comparison ("Same rule for block offsets").
//
//   A DID "changed in phase P" iff
//     (a) the SET of values seen in P differs from the baseline value set
//         (any value in P not seen in baseline, or vice-versa), AND
//     (b) the phase MEAN shifts vs baseline by more than
//         max(marginRawUnits, marginMultiplier * (baseline P90 - P10))
//         OR the value set is boolean-like (<= 2 distinct values overall)
//         and differs.
//
// (b)'s boolean-like clause is what catches a stable 0 -> 1 switch and a
// 0/1/0/1 toggle -- both have an in-phase RANGE at or below the raw-unit
// floor, which is precisely why the pre-fix "active range > max(2x baseline
// range, 3)" rule missed every boolean brake/clutch signal. The baseline
// P90-P10 spread (never a distinct COUNT) is the noise floor, so baseline
// jitter can no longer disqualify a genuine level shift.
// ---------------------------------------------------------------------------

/** Sorted-ascending linear-interpolated percentile (`q` in 0..1). `0` for an empty list; the single value for a one-element list. */
function percentileOfSorted(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0] as number;
  const position = q * (sortedAsc.length - 1);
  const lowIndex = Math.floor(position);
  const highIndex = Math.ceil(position);
  const low = sortedAsc[lowIndex] as number;
  const high = sortedAsc[highIndex] as number;
  return low + (high - low) * (position - lowIndex);
}

/** The baseline NOISE FLOOR: its own P90-P10 spread (robust to a single outlier in a 5-sample window, unlike a bare max-min range). */
function spreadP90P10(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return percentileOfSorted(sorted, 0.9) - percentileOfSorted(sorted, 0.1);
}

function meanOf(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return values.length === 0 ? 0 : total / values.length;
}

/** (a): symmetric set difference is non-empty. */
function valueSetsDiffer(baseline: readonly number[], phase: readonly number[]): boolean {
  const baselineSet = new Set(baseline);
  const phaseSet = new Set(phase);
  for (const v of phaseSet) if (!baselineSet.has(v)) return true;
  for (const v of baselineSet) if (!phaseSet.has(v)) return true;
  return false;
}

export interface DidChangeRuleThresholds {
  /** Default 2 ("2x baseline P90-P10"). */
  marginMultiplier: number;
  /** Default 3 ("3 raw units") -- the floor applied even when the baseline spread is 0. */
  marginRawUnits: number;
}

const DEFAULT_MARGIN_MULTIPLIER = 2;
const DEFAULT_MARGIN_RAW_UNITS = 3;

/**
 * The single, shared H2 change rule (see the block comment above). Both
 * series must be non-empty; the caller is responsible for the sample-count
 * gate (below `minSamplesPerPhase` the verdict is `insufficient`, never a
 * call into here).
 */
export function didPhaseValuesChanged(
  baselineValues: readonly number[],
  phaseValues: readonly number[],
  thresholds: DidChangeRuleThresholds,
): boolean {
  if (baselineValues.length === 0 || phaseValues.length === 0) return false;
  if (!valueSetsDiffer(baselineValues, phaseValues)) return false; // (a) fails -- identical value sets are never a change.
  const distinctOverall = new Set([...baselineValues, ...phaseValues]).size;
  if (distinctOverall <= 2) return true; // boolean-like AND differs (a stable 0 -> 1 switch, a 0/1 toggle).
  const noiseFloor = Math.max(thresholds.marginRawUnits, thresholds.marginMultiplier * spreadP90P10(baselineValues));
  return Math.abs(meanOf(phaseValues) - meanOf(baselineValues)) > noiseFloor;
}

/** The byte offsets (0-based) at which `phaseRaws` shifted level vs `baselineRaws` under {@link didPhaseValuesChanged}. `length` is the shared response length of every sample in both lists. */
function changedByteOffsets(
  baselineRaws: readonly Uint8Array[],
  phaseRaws: readonly Uint8Array[],
  length: number,
  thresholds: DidChangeRuleThresholds,
): number[] {
  const changed: number[] = [];
  for (let offset = 0; offset < length; offset += 1) {
    const baselineBytes = baselineRaws.map((raw) => raw[offset] ?? 0);
    const phaseBytes = phaseRaws.map((raw) => raw[offset] ?? 0);
    if (didPhaseValuesChanged(baselineBytes, phaseBytes, thresholds)) changed.push(offset);
  }
  return changed;
}

/** Unsigned big-endian decode for the NUMERICALLY decodable widths of the H2 rule (1-4 bytes: u8/u16/u24/u32). `null` outside that window -- 5-8 bytes are compared byte-wise instead, > 8 bytes belong to {@link computeDidBlockCandidateSummaries}. Deliberately SEPARATE from {@link decodeUint}, which still backs the 1-2-byte `min`/`max` display fields. */
function decodeNumericValue(raw: Uint8Array): number | null {
  if (raw.length < 1 || raw.length > 4) return null;
  let value = 0;
  for (const byte of raw) value = value * 256 + byte;
  return value;
}

/**
 * H2 (binding), routed by WIDTH: 1-4 bytes decode to one unsigned integer and
 * go through {@link didPhaseValuesChanged}; 5-8 bytes are compared BYTE-WISE
 * (any single offset with a level shift makes the phase changed). `null` for
 * any other width -- the caller reports `insufficient` rather than guessing.
 */
function didNumericPhaseChanged(
  baselineRaws: readonly Uint8Array[],
  phaseRaws: readonly Uint8Array[],
  length: number,
  thresholds: DidChangeRuleThresholds,
): boolean | null {
  if (length >= 1 && length <= 4) {
    const baselineValues: number[] = [];
    const phaseValues: number[] = [];
    for (const raw of baselineRaws) {
      const decoded = decodeNumericValue(raw);
      if (decoded === null) return null;
      baselineValues.push(decoded);
    }
    for (const raw of phaseRaws) {
      const decoded = decodeNumericValue(raw);
      if (decoded === null) return null;
      phaseValues.push(decoded);
    }
    return didPhaseValuesChanged(baselineValues, phaseValues, thresholds);
  }
  if (length >= 5 && length <= 8) {
    return changedByteOffsets(baselineRaws, phaseRaws, length, thresholds).length > 0;
  }
  return null;
}

/**
 * Single entry point: given the FULL flat sample log (every candidate DID,
 * every phase, in chronological arrival order -- interleaving across DIDs
 * within a phase is fine, this only cares about grouping by `(did, phase)`),
 * computes one {@link DidCandidateSummary} per distinct `did`, sorted per the
 * user's own ranking (candidates first, then multi-phase changers, then
 * static DIDs last -- ties broken by ascending DID for determinism).
 */
export function computeDidCandidateSummaries(
  samples: readonly DidPhaseSample[],
  options: DidCandidateRankingOptions = {},
): DidCandidateSummary[] {
  const minSamplesPerPhase = options.minSamplesPerPhase ?? 1;
  const useMarginRule = options.useMarginRule ?? false;
  const settleMs = options.settleMs ?? 0;
  const thresholds: DidChangeRuleThresholds = {
    marginMultiplier: options.marginMultiplier ?? DEFAULT_MARGIN_MULTIPLIER,
    marginRawUnits: options.marginRawUnits ?? DEFAULT_MARGIN_RAW_UNITS,
  };

  interface Accum {
    hexesByPhase: Map<DidObservationPhaseId, string[]>;
    /** Every raw response per phase, in arrival order -- the H2 rule needs the BYTES (numeric decode for 1-4 bytes, byte-wise for 5-8), never a pre-filtered subset. */
    rawsByPhase: Map<DidObservationPhaseId, Uint8Array[]>;
    allHexes: string[];
    allRaws: Uint8Array[];
    /** M3 (binding): the response length every sample agreed on, or `null` once two samples disagreed. */
    length: number | null;
    lengthConsistent: boolean;
  }
  const byDid = new Map<number, Accum>();

  for (const sample of samples) {
    let entry = byDid.get(sample.did);
    if (entry === undefined) {
      entry = { hexesByPhase: new Map(), rawsByPhase: new Map(), allHexes: [], allRaws: [], length: null, lengthConsistent: true };
      byDid.set(sample.did, entry);
    }
    const hex = bytesToHex(sample.raw);
    // Ticket P4k (binding): a settling sample still contributes to the
    // DID's overall stats (allHexes/allRaws/length below) -- it is only
    // excluded from THIS PHASE's own change evidence, never from the
    // sample log itself (the controller still exports/persists it).
    if (!isSettlingSample(sample.phase, sample.tMs, settleMs)) {
      const phaseHexes = entry.hexesByPhase.get(sample.phase) ?? [];
      phaseHexes.push(hex);
      entry.hexesByPhase.set(sample.phase, phaseHexes);
      const phaseRaws = entry.rawsByPhase.get(sample.phase) ?? [];
      phaseRaws.push(sample.raw);
      entry.rawsByPhase.set(sample.phase, phaseRaws);
    }
    if (entry.length === null) entry.length = sample.raw.length;
    else if (entry.length !== sample.raw.length) entry.lengthConsistent = false;
    entry.allHexes.push(hex);
    entry.allRaws.push(sample.raw);
  }

  const summaries: DidCandidateSummary[] = [];
  for (const [did, entry] of byDid) {
    const changedInPhase = {} as Record<DidObservationPhaseId, boolean>;
    const phaseEvidence = {} as Record<DidObservationPhaseId, DidPhaseEvidence>;
    const baselineRaws = entry.rawsByPhase.get('baseline') ?? [];
    const length = entry.length;

    if (!useMarginRule) {
      // Legacy (pre-ticket) behaviour, byte-identical: naive "did the raw
      // bytes ever differ within this phase" distinctness, no sample gate,
      // and never an `insufficient` verdict.
      for (const spec of DID_OBSERVATION_PHASES) {
        const changed = new Set(entry.hexesByPhase.get(spec.id) ?? []).size > 1;
        changedInPhase[spec.id] = changed;
        phaseEvidence[spec.id] = changed ? 'changed' : 'unchanged';
      }
    } else {
      // H2 (binding). Baseline is the CONTROL: its own spread is the noise
      // floor consumed by every active phase's test below, so it never
      // reports `changed` and can never disqualify a candidate on its own
      // jitter (the pre-fix defect). It only reports `insufficient` when
      // there is not enough of it to be a noise floor at all.
      // M3 (binding): a length-inconsistent DID supports no comparison of any
      // kind -- every phase is `insufficient`, and the DID ranks `static`.
      const baselineUsable = entry.lengthConsistent && length !== null && baselineRaws.length >= minSamplesPerPhase;
      phaseEvidence.baseline = baselineUsable ? 'unchanged' : 'insufficient';
      changedInPhase.baseline = false;
      for (const phaseId of ACTIVE_PHASES) {
        const phaseRaws = entry.rawsByPhase.get(phaseId) ?? [];
        if (!baselineUsable || phaseRaws.length < minSamplesPerPhase) {
          phaseEvidence[phaseId] = 'insufficient';
          changedInPhase[phaseId] = false;
          continue;
        }
        const changed = didNumericPhaseChanged(baselineRaws, phaseRaws, length as number, thresholds);
        if (changed === null) {
          // A width this rule cannot decode either numerically (1-4 bytes) or
          // byte-wise (5-8) -- e.g. a mid-size block fed here by mistake.
          // NEVER a naive-distinctness fallback (that is the H2 defect).
          phaseEvidence[phaseId] = 'insufficient';
          changedInPhase[phaseId] = false;
          continue;
        }
        phaseEvidence[phaseId] = changed ? 'changed' : 'unchanged';
        changedInPhase[phaseId] = changed;
      }
    }

    let min: number | null = null;
    let max: number | null = null;
    for (const raw of entry.allRaws) {
      const decoded = decodeUint(raw);
      if (decoded === null) continue;
      min = min === null ? decoded : Math.min(min, decoded);
      max = max === null ? decoded : Math.max(max, decoded);
    }

    // Ticket P4j-FIX2 V1 (binding): `insufficient` in ANY phase (baseline
    // included) excludes this DID from every other rank -- it is NEVER
    // reported as a candidate on the strength of the phases it happened to
    // have enough evidence for. Under the legacy naive rule no phase is ever
    // `insufficient`, so this never overrides `rankOf`'s own result there.
    const anyPhaseInsufficient = Object.values(phaseEvidence).some((evidence) => evidence === 'insufficient');

    summaries.push({
      did,
      lastRawHex: entry.allHexes[entry.allHexes.length - 1] ?? '',
      sampleCount: entry.allHexes.length,
      min,
      max,
      distinctValueCount: new Set(entry.allHexes).size,
      changedInPhase,
      phaseEvidence,
      lengthConsistent: entry.lengthConsistent,
      rank: anyPhaseInsufficient ? 'insufficient' : rankOf(changedInPhase),
    });
  }

  return summaries.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || a.did - b.did);
}

/**
 * Ticket P4j (binding): "Mid-size blocks (9-32 bytes) join the candidate pool
 * with per-byte-offset diffing: a block is 'changed in phase' if any byte
 * offset changes beyond baseline; the export lists changed offsets; UI shows
 * '0x40B5 - bytes 4-5 changed (brake)'." A mid-size response is too wide for
 * `decodeUint`'s single-integer decode (see {@link computeDidCandidateSummaries})
 * to mean anything, so this computes the SAME margin-based change rule
 * independently PER BYTE OFFSET, then ranks the DID exactly like a numeric
 * candidate (single active phase changed -> that phase's rank; several ->
 * `changedInSeveral`; none -> `static`).
 */
export interface DidBlockCandidateSummary {
  did: number;
  /** The response length every sample for this DID shared (a DID whose samples DISAGREE on length is excluded entirely -- see this function's own doc comment). */
  length: number;
  sampleCount: number;
  /** Byte offsets (0-based) whose value RANGE exceeded the baseline's own range at that offset by the margin, per active phase. Always has an entry for every phase id (baseline's is always `[]` -- it is the reference, never "changed" against itself). */
  changedOffsetsByPhase: Record<DidObservationPhaseId, number[]>;
  /** Ticket P4j-FIX1 H2 (binding): the SAME tri-state verdict the numeric summaries carry -- an under-sampled phase reports `insufficient`, never a bare empty offset list that reads as "nothing changed". `baseline` is always `unchanged` (the control) or `insufficient`. */
  phaseEvidence: Record<DidObservationPhaseId, DidPhaseEvidence>;
  rank: DidCandidateRank;
}

export interface DidBlockCandidateOptions {
  /** Minimum samples BOTH baseline and an active phase must have before that phase's offsets are evaluated at all (below this, every offset for that phase reports unchanged -- not enough evidence). Default 1. */
  minSamplesPerPhase?: number;
  /** Default 2 ("> 2x baseline spread"), same convention as {@link DidCandidateRankingOptions}. */
  marginMultiplier?: number;
  /** Default 3 ("> 3 raw units"), the floor applied even when an offset's baseline range is 0. */
  marginRawUnits?: number;
  /** Default 9 (ticket: "Mid-size blocks (9-32 bytes)"). */
  minLen?: number;
  /** Default 32. */
  maxLen?: number;
  /** Ticket P4k (binding): same settle window as {@link DidCandidateRankingOptions.settleMs} -- excludes a settling sample from that phase's own per-offset evidence. Default 0 (no settle window). */
  settleMs?: number;
}

/**
 * Pure, deterministic: groups `samples` by DID, keeps only DIDs whose
 * response length is CONSTANT across every sample and falls in
 * `[minLen, maxLen]` (default 9-32), and for each such DID computes which
 * byte offsets changed (by the same margin rule as the numeric candidate
 * summaries) in each active phase relative to baseline.
 */
export function computeDidBlockCandidateSummaries(
  samples: readonly DidPhaseSample[],
  options: DidBlockCandidateOptions = {},
): DidBlockCandidateSummary[] {
  const minSamplesPerPhase = options.minSamplesPerPhase ?? 1;
  const thresholds: DidChangeRuleThresholds = {
    marginMultiplier: options.marginMultiplier ?? DEFAULT_MARGIN_MULTIPLIER,
    marginRawUnits: options.marginRawUnits ?? DEFAULT_MARGIN_RAW_UNITS,
  };
  const minLen = options.minLen ?? 9;
  const maxLen = options.maxLen ?? 32;
  const settleMs = options.settleMs ?? 0;

  interface Accum {
    byPhase: Map<DidObservationPhaseId, Uint8Array[]>;
    length: number | null;
    consistentLength: boolean;
    sampleCount: number;
  }
  const byDid = new Map<number, Accum>();
  for (const sample of samples) {
    let entry = byDid.get(sample.did);
    if (entry === undefined) {
      entry = { byPhase: new Map(), length: null, consistentLength: true, sampleCount: 0 };
      byDid.set(sample.did, entry);
    }
    if (entry.length === null) entry.length = sample.raw.length;
    else if (entry.length !== sample.raw.length) entry.consistentLength = false;
    entry.sampleCount += 1;
    // Ticket P4k (binding): same settle-window exclusion as the numeric
    // summaries -- a settling sample still counts toward `sampleCount`/length
    // consistency above, but never toward this phase's own per-offset
    // evidence below.
    if (!isSettlingSample(sample.phase, sample.tMs, settleMs)) {
      const list = entry.byPhase.get(sample.phase) ?? [];
      list.push(sample.raw);
      entry.byPhase.set(sample.phase, list);
    }
  }

  const summaries: DidBlockCandidateSummary[] = [];
  for (const [did, entry] of byDid) {
    const length = entry.length;
    if (length === null || !entry.consistentLength) continue; // a DID that disagreed on its own length across samples proves nothing offset-by-offset.
    if (length < minLen || length > maxLen) continue;

    const baselineRaws = entry.byPhase.get('baseline') ?? [];
    const baselineEnough = baselineRaws.length >= minSamplesPerPhase;
    const changedOffsetsByPhase = {} as Record<DidObservationPhaseId, number[]>;
    const phaseEvidence = {} as Record<DidObservationPhaseId, DidPhaseEvidence>;
    for (const spec of DID_OBSERVATION_PHASES) changedOffsetsByPhase[spec.id] = [];
    phaseEvidence.baseline = baselineEnough ? 'unchanged' : 'insufficient';

    for (const phaseId of ACTIVE_PHASES) {
      const phaseRaws = entry.byPhase.get(phaseId) ?? [];
      if (!baselineEnough || phaseRaws.length < minSamplesPerPhase) {
        // H2 (binding): NOT enough evidence -- reported as `insufficient`,
        // never silently as "no offset changed".
        phaseEvidence[phaseId] = 'insufficient';
        continue;
      }
      // H2 (binding): "Same rule for block offsets" -- the identical
      // set-difference + mean-shift/boolean-like rule the numeric summaries
      // use, applied per byte offset.
      const changed = changedByteOffsets(baselineRaws, phaseRaws, length, thresholds);
      changedOffsetsByPhase[phaseId] = changed;
      phaseEvidence[phaseId] = changed.length > 0 ? 'changed' : 'unchanged';
    }

    const changedActivePhases = ACTIVE_PHASES.filter((phase) => changedOffsetsByPhase[phase].length > 0);
    let rank: DidCandidateRank;
    if (changedActivePhases.length === 1) {
      rank = PHASE_TO_RANK[changedActivePhases[0] as 'brake' | 'steering' | 'throttle'];
    } else if (changedActivePhases.length >= 2) {
      rank = 'changedInSeveral';
    } else {
      rank = 'static';
    }
    // Ticket P4j-FIX2 V1 (binding): same exclusion as the numeric summaries --
    // `insufficient` in ANY phase overrides whatever `rank` the phases WITH
    // enough evidence would otherwise have earned.
    if (Object.values(phaseEvidence).some((evidence) => evidence === 'insufficient')) rank = 'insufficient';

    summaries.push({ did, length, sampleCount: entry.sampleCount, changedOffsetsByPhase, phaseEvidence, rank });
  }

  return summaries.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || a.did - b.did);
}

/**
 * F2 fix (P4i-FIX1, binding, after Codex P4hrev2c): "if the [candidate] set is
 * larger than ~rate×phaseSeconds, raise the phase length automatically (show
 * it) so every candidate is sampled ≥ 2× per phase." `ASSUMED_GUIDED_REQ_PER_SEC`
 * is the field-measured baseline (contracts.md P4i addendum: "~15.8 req/s on
 * the real adapter") -- a conservative, fixed estimate (no live rate is known
 * before a phase starts) used ONLY to size the phase window generously enough
 * that round-robin coverage twice over is achievable at that rate.
 */
export const ASSUMED_GUIDED_REQ_PER_SEC = 15;
/** "every candidate is sampled ≥ 2× per phase" (binding). */
export const MIN_SAMPLES_PER_CANDIDATE_PER_PHASE = 2;

/**
 * Pure, deterministic: the ACTUAL duration a guided phase (or the two-sample
 * pre-pass round -- pass `minSamplesPerCandidate: 1` for that case) should run
 * for, given how many candidates it must cover. Never shorter than
 * `baseDurationMs` (the fixed ~6s phase length is still the floor for a small
 * candidate set); grows only when the candidate count would otherwise leave
 * the tail of the list under-sampled within the base window.
 */
export function computeGuidedPhaseDurationMs(
  candidateCount: number,
  baseDurationMs: number,
  assumedReqPerSec: number = ASSUMED_GUIDED_REQ_PER_SEC,
  minSamplesPerCandidate: number = MIN_SAMPLES_PER_CANDIDATE_PER_PHASE,
): number {
  if (!Number.isFinite(candidateCount) || candidateCount <= 0) return baseDurationMs;
  if (!Number.isFinite(assumedReqPerSec) || assumedReqPerSec <= 0) return baseDurationMs;
  const neededMs = Math.ceil((minSamplesPerCandidate * candidateCount) / assumedReqPerSec * 1_000);
  return Math.max(baseDurationMs, neededMs);
}

/**
 * R6 fix (P4i-FIX2, binding, after Codex P4hrev3-REV3 NEW MEDIUM "the new
 * pre-pass countdown is materially wrong"): the two-sample changing-value
 * pre-pass' own REAL total duration -- one round's duration (via
 * {@link computeGuidedPhaseDurationMs} with `minSamplesPerCandidate: 1`,
 * matching how the controller actually sizes each of its two rounds) counted
 * TWICE, plus the fixed gap between them. The pre-fix controller advertised a
 * frozen `2000`ms regardless of candidate count/round duration and never
 * advanced elapsed time at all -- even a single candidate's ~6s pre-pass
 * showed a stuck "2s" countdown; a large candidate set could stay there far
 * longer. Pure/deterministic so the controller's own snapshot (and the core
 * test below) can assert on the exact total the UI countdown must reflect.
 */
export function computeChangingValuePrePassDurationMs(
  candidateCount: number,
  roundBaseDurationMs: number,
  gapMs: number,
  assumedReqPerSec: number = ASSUMED_GUIDED_REQ_PER_SEC,
): number {
  const roundDurationMs = computeGuidedPhaseDurationMs(candidateCount, roundBaseDurationMs, assumedReqPerSec, 1);
  return roundDurationMs * 2 + gapMs;
}
