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
}

/**
 * F5 fix (P4i-FIX1, binding, after Codex P4hrev2c): a DID that changed in
 * EXACTLY ONE active phase is labelled by THAT phase specifically -- never a
 * merged "brakeOrSteeringCandidate" that throws away which phase actually
 * moved it. `rankOf` below picks the ONE active phase that changed.
 */
export type DidCandidateRank = 'brakeCandidate' | 'steeringCandidate' | 'throttleCandidate' | 'changedInSeveral' | 'static';

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
}

function rangeOf(values: readonly number[]): number {
  let min = values[0] as number;
  let max = values[0] as number;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
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
  const marginMultiplier = options.marginMultiplier ?? 2;
  const marginRawUnits = options.marginRawUnits ?? 3;

  interface Accum {
    hexesByPhase: Map<DidObservationPhaseId, string[]>;
    /** Decoded values per phase -- only pushed when `decodeUint` succeeds for that sample (ticket P4j margin rule); `undefined` entry means the phase was never sampled at all. */
    valuesByPhase: Map<DidObservationPhaseId, number[]>;
    allHexes: string[];
    allRaws: Uint8Array[];
  }
  const byDid = new Map<number, Accum>();

  for (const sample of samples) {
    let entry = byDid.get(sample.did);
    if (entry === undefined) {
      entry = { hexesByPhase: new Map(), valuesByPhase: new Map(), allHexes: [], allRaws: [] };
      byDid.set(sample.did, entry);
    }
    const hex = bytesToHex(sample.raw);
    const phaseHexes = entry.hexesByPhase.get(sample.phase) ?? [];
    phaseHexes.push(hex);
    entry.hexesByPhase.set(sample.phase, phaseHexes);
    const decoded = decodeUint(sample.raw);
    if (decoded !== null) {
      const phaseValues = entry.valuesByPhase.get(sample.phase) ?? [];
      phaseValues.push(decoded);
      entry.valuesByPhase.set(sample.phase, phaseValues);
    }
    entry.allHexes.push(hex);
    entry.allRaws.push(sample.raw);
  }

  const summaries: DidCandidateSummary[] = [];
  for (const [did, entry] of byDid) {
    const changedInPhase = {} as Record<DidObservationPhaseId, boolean>;
    const baselineHexes = entry.hexesByPhase.get('baseline') ?? [];
    const baselineValues = entry.valuesByPhase.get('baseline');
    // ticket P4j: the margin rule needs EVERY baseline sample to have decoded
    // (a phase with even one non-numeric-width response can't support a
    // meaningful "baseline range" -- fall back to naive distinctness instead
    // of comparing a partial range).
    const baselineDecodedFully = baselineValues !== undefined && baselineValues.length === baselineHexes.length;
    const baselineRange = baselineDecodedFully ? rangeOf(baselineValues!) : null;

    for (const spec of DID_OBSERVATION_PHASES) {
      const hexes = entry.hexesByPhase.get(spec.id) ?? [];
      const naiveChanged = new Set(hexes).size > 1;
      if (spec.id === 'baseline' || !useMarginRule) {
        changedInPhase[spec.id] = naiveChanged;
        continue;
      }
      const values = entry.valuesByPhase.get(spec.id);
      const decodedFully = values !== undefined && values.length === hexes.length;
      const enoughSamples = hexes.length >= minSamplesPerPhase && baselineHexes.length >= minSamplesPerPhase;
      if (!enoughSamples || !decodedFully || baselineRange === null) {
        changedInPhase[spec.id] = naiveChanged; // insufficient evidence for the margin rule -- fall back rather than silently reporting "unchanged".
        continue;
      }
      const activeRange = rangeOf(values!);
      changedInPhase[spec.id] = activeRange > Math.max(marginMultiplier * baselineRange, marginRawUnits);
    }

    let min: number | null = null;
    let max: number | null = null;
    for (const raw of entry.allRaws) {
      const decoded = decodeUint(raw);
      if (decoded === null) continue;
      min = min === null ? decoded : Math.min(min, decoded);
      max = max === null ? decoded : Math.max(max, decoded);
    }

    summaries.push({
      did,
      lastRawHex: entry.allHexes[entry.allHexes.length - 1] ?? '',
      sampleCount: entry.allHexes.length,
      min,
      max,
      distinctValueCount: new Set(entry.allHexes).size,
      changedInPhase,
      rank: rankOf(changedInPhase),
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
  const marginMultiplier = options.marginMultiplier ?? 2;
  const marginRawUnits = options.marginRawUnits ?? 3;
  const minLen = options.minLen ?? 9;
  const maxLen = options.maxLen ?? 32;

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
    const list = entry.byPhase.get(sample.phase) ?? [];
    list.push(sample.raw);
    entry.byPhase.set(sample.phase, list);
  }

  const summaries: DidBlockCandidateSummary[] = [];
  for (const [did, entry] of byDid) {
    const length = entry.length;
    if (length === null || !entry.consistentLength) continue; // a DID that disagreed on its own length across samples proves nothing offset-by-offset.
    if (length < minLen || length > maxLen) continue;

    const baselineRaws = entry.byPhase.get('baseline') ?? [];
    const baselineEnough = baselineRaws.length >= minSamplesPerPhase;
    const changedOffsetsByPhase = {} as Record<DidObservationPhaseId, number[]>;
    for (const spec of DID_OBSERVATION_PHASES) changedOffsetsByPhase[spec.id] = [];

    for (const phaseId of ACTIVE_PHASES) {
      const phaseRaws = entry.byPhase.get(phaseId) ?? [];
      if (!baselineEnough || phaseRaws.length < minSamplesPerPhase) continue; // not enough evidence -- every offset stays unchanged.
      const changed: number[] = [];
      for (let offset = 0; offset < length; offset += 1) {
        let baselineMin = baselineRaws[0]![offset] ?? 0;
        let baselineMax = baselineMin;
        for (const raw of baselineRaws) {
          const b = raw[offset] ?? 0;
          if (b < baselineMin) baselineMin = b;
          if (b > baselineMax) baselineMax = b;
        }
        let phaseMin = phaseRaws[0]![offset] ?? 0;
        let phaseMax = phaseMin;
        for (const raw of phaseRaws) {
          const b = raw[offset] ?? 0;
          if (b < phaseMin) phaseMin = b;
          if (b > phaseMax) phaseMax = b;
        }
        const baselineRange = baselineMax - baselineMin;
        const phaseRange = phaseMax - phaseMin;
        if (phaseRange > Math.max(marginMultiplier * baselineRange, marginRawUnits)) changed.push(offset);
      }
      changedOffsetsByPhase[phaseId] = changed;
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

    summaries.push({ did, length, sampleCount: entry.sampleCount, changedOffsetsByPhase, rank });
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
