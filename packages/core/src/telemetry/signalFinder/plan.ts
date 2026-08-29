/**
 * Signal Finder — the DID BUDGET for one find (contracts.md "Signal Finder
 * REVISION (2026-08-29, after field test 5)", items 9–10, binding):
 *
 *   9.  "One metronome per FIND. A Find = exactly one human-paced script:
 *        baseline 3 s, then `repetitions` (default 3, max 5) x {press 3 s,
 *        release 3 s} ~ 21 s. Never a second script without an explicit tap."
 *   10. "Budget, not passes. The DIDs read during that script are chosen up
 *        front from the measured request rate so every DID gets >= 3 samples
 *        per 3 s window: `budget = floor(rate x 3 / 3)` clamped to [4, 12].
 *        Priority: (a) hypotheses of the target on every ECU; (b) DIDs that
 *        CHANGED in earlier observations/finder runs (any rank other than
 *        static, from the sweep/finder stores); (c) other cached responders
 *        of the target's ECUs. All ECUs are polled in the SAME session
 *        (per-entry target address). Whatever does not fit is listed as
 *        'not read (N) — Next round' with the button; each round is one more
 *        full script."
 *
 * WHY THIS EXISTS (field test 5, the user's own words: "inhuman to press the
 * brake that many times — the tests are robotic"): build 5 chose the opposite
 * trade. It kept the DID count fixed (<= 16 per pass) and multiplied the
 * SCRIPTS — 91 passes, one full 24 s metronome each, hypotheses queued last,
 * so the user pressed the pedal ~40 times and the DIDs that actually carried
 * the signal were never even reached. The human is the scarce resource: ONE
 * script per find, and the DID COUNT is what bends to the measured rate.
 *
 * Pure, deterministic — no I/O, no clock, no vehicle constants.
 */

/** Where a planned DID came from — the priority ladder of item 10, in order. */
export type SignalFinderEntrySource = 'hypothesis' | 'changed' | 'cached';

/** One (ECU, DID) pair the caller offers to the plan. */
export interface SignalFinderTargetRef {
  /** ECU (HSFZ target) address the DID must be requested from. */
  ecu: number;
  did: number;
}

export interface SignalFinderPlanEntry extends SignalFinderTargetRef {
  source: SignalFinderEntrySource;
}

export interface FinderBudgetOptions {
  /** The window each DID must be sampled inside — item 9's press/release window. Default 3000 ms. */
  windowMs?: number;
  /** Samples per DID per window the budget guarantees. Default {@link DEFAULT_FINDER_MIN_SAMPLES_PER_WINDOW}. */
  minSamplesPerWindow?: number;
  /** Default {@link FINDER_BUDGET_MIN}. */
  minBudget?: number;
  /** Default {@link FINDER_BUDGET_MAX}. */
  maxBudget?: number;
}

export interface PlanFinderRunOptions extends FinderBudgetOptions {
  /** Entries already read by an earlier round of the same find — excluded from this one. */
  exclude?: readonly SignalFinderTargetRef[];
  /** Overrides the rate-derived budget entirely (tests, and a caller that measured its own). */
  budget?: number;
}

export interface FinderRunPlan {
  /** How many DIDs this round may read. */
  budget: number;
  /** Exactly what this round polls, in priority order. */
  dids: readonly SignalFinderPlanEntry[];
  /** Item 12 (honesty): eligible DIDs this round does NOT reach — "not read (N) — Next round", never "no response". */
  notRead: readonly SignalFinderPlanEntry[];
}

/** Item 9's press/release window (ms) — what the budget guarantees samples inside. */
export const FINDER_WINDOW_MS = 3_000;
/** Item 10 (binding): ">= 3 samples per 3 s window". */
export const DEFAULT_FINDER_MIN_SAMPLES_PER_WINDOW = 3;
/** Item 10 (binding): "clamped to [4, 12]". */
export const FINDER_BUDGET_MIN = 4;
export const FINDER_BUDGET_MAX = 12;

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Item 10's own formula: `floor(rate x windowMs / 1000 / minSamplesPerWindow)`
 * clamped to `[minBudget, maxBudget]`. A rate that cannot support even the
 * floor still plans `minBudget` DIDs — the clamp is the contract's, and the
 * scorer reports the resulting sparseness honestly (item 11) rather than the
 * planner silently reading one DID at a time.
 */
export function computeFinderDidBudget(measuredReqPerSec: number, options: FinderBudgetOptions = {}): number {
  const windowMs = positiveOr(options.windowMs, FINDER_WINDOW_MS);
  const minSamples = positiveOr(options.minSamplesPerWindow, DEFAULT_FINDER_MIN_SAMPLES_PER_WINDOW);
  const minBudget = Math.max(1, Math.floor(positiveOr(options.minBudget, FINDER_BUDGET_MIN)));
  const maxBudget = Math.max(minBudget, Math.floor(positiveOr(options.maxBudget, FINDER_BUDGET_MAX)));
  const rate = Number.isFinite(measuredReqPerSec) && measuredReqPerSec > 0 ? measuredReqPerSec : 0;
  const raw = Math.floor((rate * windowMs) / 1_000 / minSamples);
  return Math.min(maxBudget, Math.max(minBudget, raw));
}

function key(ref: SignalFinderTargetRef): string {
  return `${ref.ecu}:${ref.did}`;
}

/**
 * The ordered DID list ONE round of the metronome reads, plus the remainder.
 *
 * Two structural rules beyond the priority ladder:
 *
 *  1. **Each (ECU, DID) once**, at its highest priority — a hypothesis that is
 *     also a cached responder is read as a hypothesis, not twice.
 *  2. **Each DID NUMBER at most once per round.** The whole round runs on ONE
 *     transport session (item 10, "All ECUs are polled in the SAME session"),
 *     and a 0x62 response is correlated back to its request by its DID; the
 *     same DID number answered by two ECUs inside one round would merge two
 *     different channels into one series. The lower-priority one is deferred
 *     to the next round rather than dropped.
 */
export function planFinderRun(
  measuredReqPerSec: number,
  hypotheses: readonly SignalFinderTargetRef[],
  changedDids: readonly SignalFinderTargetRef[],
  cachedDids: readonly SignalFinderTargetRef[],
  options: PlanFinderRunOptions = {},
): FinderRunPlan {
  const budget =
    options.budget !== undefined && Number.isFinite(options.budget) && options.budget >= 0
      ? Math.floor(options.budget)
      : computeFinderDidBudget(measuredReqPerSec, options);

  const excluded = new Set((options.exclude ?? []).map(key));
  const seen = new Set<string>();
  const ordered: SignalFinderPlanEntry[] = [];
  const pools: ReadonlyArray<readonly [SignalFinderEntrySource, readonly SignalFinderTargetRef[]]> = [
    ['hypothesis', hypotheses],
    ['changed', changedDids],
    ['cached', cachedDids],
  ];
  for (const [source, pool] of pools) {
    for (const ref of pool) {
      const id = key(ref);
      if (excluded.has(id) || seen.has(id)) continue;
      seen.add(id);
      ordered.push({ ecu: ref.ecu, did: ref.did, source });
    }
  }

  const dids: SignalFinderPlanEntry[] = [];
  const notRead: SignalFinderPlanEntry[] = [];
  const didNumbersThisRound = new Set<number>();
  for (const entry of ordered) {
    if (dids.length < budget && !didNumbersThisRound.has(entry.did)) {
      didNumbersThisRound.add(entry.did);
      dids.push(entry);
    } else {
      notRead.push(entry);
    }
  }
  return { budget, dids, notRead };
}
