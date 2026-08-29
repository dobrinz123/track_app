/**
 * DID sweep — batched guided observation addendum (ticket P4j, binding).
 * Field evidence (`data/field/sweeps/2026-08-29-supra-dme12-0x4000-0x4FFF.json`):
 * 533 responders, 128 short/plausible candidates; the guided phases ran a
 * fixed 17s each but the REAL measured rate over the whole candidate set was
 * only ~8-11 req/s, so round-robin over all 128 candidates in one phase gave
 * each DID only 1-2 samples -- not enough to tell a real signal from noise
 * (e.g. 0x4522 read 297, then 305, then 295: that is baseline-level jitter,
 * not a brake signal, but a naive "did the bytes change at all" rule would
 * still flag it).
 *
 * The fix is BATCHING: split the candidate pool into small, fixed-size
 * batches (default 16) and run the full baseline -> brake -> steering ->
 * throttle cycle on ONE batch at a time, sizing each batch's phase duration
 * from the MEASURED request rate of the run (never the old fixed assumed
 * rate) so every DID in the batch gets at least `minSamplesPerPhase` (default
 * 5) samples per phase. `planObservationBatches` is the pure planning step;
 * the mobile controller runs the actual wire-level phases per batch.
 */

import { DID_OBSERVATION_PHASES, computeGuidedPhaseDurationMs, ASSUMED_GUIDED_REQ_PER_SEC } from './didObservationPhases';

/** ticket P4j: "batchSize=16". */
export const DEFAULT_BATCH_SIZE = 16;
/** ticket P4j: "minSamplesPerPhase=5". */
export const DEFAULT_MIN_SAMPLES_PER_PHASE = 5;
/**
 * Ticket P4j-FIX1 M1 (binding, after Codex P4j-REV1 MEDIUM #1: "`batchSize:
 * 128` therefore creates a 128-DID batch"): a HARD ceiling, not a default --
 * batching only works because a batch is small enough for every DID in it to
 * reach `minSamplesPerPhase` inside one phase window.
 */
export const MAX_BATCH_SIZE = 16;
/** Ticket P4j-FIX1 M1 (binding): "Extremely large `minSamplesPerPhase` values are also uncapped and can create effectively infinite phase durations." */
export const MAX_MIN_SAMPLES_PER_PHASE = 20;
/** Ticket P4j-FIX1 M1 (binding): "focused shortlist <= 16 DIDs (error shown)" -- enforced by the controller/screen, defined here alongside the other observation bounds. */
export const MAX_FOCUSED_SHORTLIST_SIZE = 16;

/** A phase's own base (fixed, unscaled) duration -- reuses `DID_OBSERVATION_PHASES`' own ~6s baseline as the floor a batch's computed duration never shrinks below (mirrors `computeGuidedPhaseDurationMs`'s own floor discipline). */
const BASE_PHASE_DURATION_MS = DID_OBSERVATION_PHASES[0]?.durationMs ?? 6_000;

export interface PlanObservationBatchesOptions {
  /** Candidates per batch (default {@link DEFAULT_BATCH_SIZE}, 16). Non-finite or < 1 falls back to the default. */
  batchSize?: number;
  /** Minimum samples every DID in a batch must get per phase (default {@link DEFAULT_MIN_SAMPLES_PER_PHASE}, 5). Non-finite or < 1 falls back to the default. */
  minSamplesPerPhase?: number;
  /**
   * The ACTUAL measured requests/sec of the run this batch plan is sized for
   * (binding: "phase duration per batch from the MEASURED rate of the sweep
   * run, not the assumed 15") -- e.g. the sweep's own final `reqPerSec`.
   * Non-finite or <= 0 falls back to {@link ASSUMED_GUIDED_REQ_PER_SEC}
   * (no live measurement is available yet, e.g. before any sweep has run).
   */
  measuredReqPerSec: number;
}

export interface ObservationBatch {
  /** 0-based position of this batch within the plan. */
  index: number;
  /** Total number of batches in the plan (same value on every batch -- convenience for "Batch index+1/total" progress text). */
  total: number;
  /** The candidate DIDs THIS batch covers, in the same relative order as the input (a partition -- every candidate appears in exactly one batch). */
  dids: readonly number[];
  /** The duration (ms) EACH of the four guided phases (baseline/brake/steering/throttle) should run for THIS batch, sized so every DID in `dids` gets >= `minSamplesPerPhase` samples at `measuredReqPerSec` (never below the fixed ~6s floor). */
  phaseDurationMs: number;
}

/** M1 (binding): non-finite/below-1 falls back to `fallback`; anything above `max` is CLAMPED to it (never accepted as given). */
function sanitizeCount(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

/**
 * Pure, deterministic: partitions `candidates` into fixed-size batches (in
 * order, last batch may be smaller) and sizes each batch's own guided-phase
 * duration from the measured rate. `[]` for an empty candidate list.
 *
 * Field-file shape (binding test fixture): 128 candidates, `batchSize: 16`,
 * `measuredReqPerSec: 9` -> 8 batches of 16, each phase sized to
 * `ceil(5 * 16 / 9 * 1000)` = 8889ms (>= 5 samples/DID/phase at the measured
 * rate -- comfortably longer than the old fixed 17s-for-128-candidates
 * arrangement gave any single DID, since that same window is now spent on
 * 1/8th as many candidates).
 */
export function planObservationBatches(
  candidates: readonly number[],
  options: PlanObservationBatchesOptions,
): ObservationBatch[] {
  if (candidates.length === 0) return [];
  const batchSize = sanitizeCount(options.batchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
  const minSamplesPerPhase = sanitizeCount(options.minSamplesPerPhase, DEFAULT_MIN_SAMPLES_PER_PHASE, MAX_MIN_SAMPLES_PER_PHASE);
  const measuredReqPerSec =
    Number.isFinite(options.measuredReqPerSec) && options.measuredReqPerSec > 0
      ? options.measuredReqPerSec
      : ASSUMED_GUIDED_REQ_PER_SEC;

  const chunks: number[][] = [];
  for (let start = 0; start < candidates.length; start += batchSize) {
    chunks.push(candidates.slice(start, start + batchSize));
  }

  return chunks.map((dids, index) => ({
    index,
    total: chunks.length,
    dids,
    phaseDurationMs: computeGuidedPhaseDurationMs(dids.length, BASE_PHASE_DURATION_MS, measuredReqPerSec, minSamplesPerPhase),
  }));
}
