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
 * Single entry point: given the FULL flat sample log (every candidate DID,
 * every phase, in chronological arrival order -- interleaving across DIDs
 * within a phase is fine, this only cares about grouping by `(did, phase)`),
 * computes one {@link DidCandidateSummary} per distinct `did`, sorted per the
 * user's own ranking (candidates first, then multi-phase changers, then
 * static DIDs last -- ties broken by ascending DID for determinism).
 */
export function computeDidCandidateSummaries(samples: readonly DidPhaseSample[]): DidCandidateSummary[] {
  interface Accum {
    hexesByPhase: Map<DidObservationPhaseId, string[]>;
    allHexes: string[];
    allRaws: Uint8Array[];
  }
  const byDid = new Map<number, Accum>();

  for (const sample of samples) {
    let entry = byDid.get(sample.did);
    if (entry === undefined) {
      entry = { hexesByPhase: new Map(), allHexes: [], allRaws: [] };
      byDid.set(sample.did, entry);
    }
    const hex = bytesToHex(sample.raw);
    const phaseHexes = entry.hexesByPhase.get(sample.phase) ?? [];
    phaseHexes.push(hex);
    entry.hexesByPhase.set(sample.phase, phaseHexes);
    entry.allHexes.push(hex);
    entry.allRaws.push(sample.raw);
  }

  const summaries: DidCandidateSummary[] = [];
  for (const [did, entry] of byDid) {
    const changedInPhase = {} as Record<DidObservationPhaseId, boolean>;
    for (const spec of DID_OBSERVATION_PHASES) {
      const hexes = entry.hexesByPhase.get(spec.id) ?? [];
      changedInPhase[spec.id] = new Set(hexes).size > 1;
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
