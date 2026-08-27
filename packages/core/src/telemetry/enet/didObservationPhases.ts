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

export type DidCandidateRank = 'brakeOrSteeringCandidate' | 'changedInSeveral' | 'static';

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

function rankOf(changedInPhase: Record<DidObservationPhaseId, boolean>): DidCandidateRank {
  const activeChangedCount = ACTIVE_PHASES.filter((phase) => changedInPhase[phase]).length;
  if (!changedInPhase.baseline && activeChangedCount === 1) return 'brakeOrSteeringCandidate';
  if (activeChangedCount >= 2) return 'changedInSeveral';
  return 'static';
}

const RANK_ORDER: Readonly<Record<DidCandidateRank, number>> = {
  brakeOrSteeringCandidate: 0,
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
