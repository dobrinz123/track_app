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
 *        Priority: (0, ticket P4o O4) the target's own previously
 *        CONFIRMED binding(s); (a) hypotheses of the target on every ECU;
 *        (b) DIDs that CHANGED in earlier observations/finder runs (any rank
 *        other than static, from the sweep/finder stores); (c) other cached
 *        responders of the target's ECUs. All ECUs are polled in the SAME
 *        session (per-entry target address). Whatever does not fit is listed
 *        as 'not read (N) — Next round' with the button; each round is one
 *        more full script."
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

/**
 * Where a planned DID came from — the priority ladder of item 10, in order.
 *
 * Ticket P4o O4 (binding, field test 8): `'confirmed'` LEADS every other
 * source. Field bug: a generic-profile find never even READ the Supra's
 * already field-confirmed 0x58B7 (it was not a hypothesis on that profile),
 * so the two-level DME flag it did read won the round unopposed. A
 * previously confirmed binding is the strongest evidence this app has for a
 * target, on ANY profile — it must be read first, or a fresh find can starve
 * it out of the round's budget entirely.
 */
export type SignalFinderEntrySource = 'confirmed' | 'hypothesis' | 'changed' | 'cached';

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
  /**
   * P4m-FIX1 X2 (Codex P4m-REV1 finding 2, HIGH): ECUs the pre-run probe
   * found ANSWER NOTHING. Their entries are moved to {@link FinderRunPlan.silent}
   * — they never consume the round's budget (that is the starvation the
   * finding is about: 300 ms × every silent DID, every pass, stolen from the
   * ECU that is actually answering) and they are never called "no response"
   * either, because the honest reason is known: the ECU is silent.
   */
  silentEcus?: readonly number[];
  /**
   * P4m-FIX2 Y2 (Codex P4m-REV2 finding 12, HIGH): INDIVIDUAL `(ecu, did)`
   * entries the probe attempted and got nothing from, on ECUs that are alive.
   * "An ECU that answers one probe request ... or has one answering DID plus
   * many silent DIDs ... can retain every DID; 11 retained DIDs can then
   * consume `11 × 3 × 300 ms = 9.9 s`" — of a ~21 s script the driver is
   * physically performing. They go to {@link FinderRunPlan.silent} with that
   * reason.
   *
   * P4m-FIX3 Z4 (Codex P4m-REV3 finding 10, MEDIUM): NO exception, not even a
   * hypothesis. Build 8 kept a silent hypothesis here "for one retry inside the
   * script", and the runner turned that into three misses plus one more attempt
   * in every evidence window — the driver's own script paying for a DID nothing
   * had ever answered from. The one retry a hypothesis deserves is an EXPLICIT
   * single request the caller makes after the probe and before the script
   * (`signalFinderController.ts`), and whatever is still listed here when the
   * plan is built is silent, whatever its source.
   */
  silentDids?: readonly SignalFinderTargetRef[];
}

export interface FinderRunPlan {
  /** How many DIDs this round may read. */
  budget: number;
  /** Exactly what this round polls, in priority order. */
  dids: readonly SignalFinderPlanEntry[];
  /** Item 12 (honesty): eligible DIDs this round does NOT reach — "not read (N) — Next round", never "no response". */
  notRead: readonly SignalFinderPlanEntry[];
  /** P4m-FIX1 X2: eligible DIDs skipped because their ECU answered nothing in the probe — "not read — ECU 0x29 silent". */
  silent: readonly SignalFinderPlanEntry[];
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
 *  2. **Identity is COMPOSITE — (ECU, DID)** (P4m-FIX1 X4, Codex P4m-REV1
 *     finding 4). Build 6 allowed each DID NUMBER only once per round, because
 *     the round was polled through one DID-keyed series: the same DID on two
 *     ECUs cost the driver a second script. `runFinderRound` polls one channel
 *     PER ECU and keys everything by `(ecu, did)`, so both copies belong in the
 *     same round — one press, both ECUs read.
 *  3. A **silent ECU** (probe evidence, X2) is skipped without spending budget.
 */
export function planFinderRun(
  measuredReqPerSec: number,
  /**
   * Ticket P4o O4 (binding): `(ecu, did)` of the target's OWN previously
   * confirmed binding(s) — read FIRST, ahead of every hypothesis. Typically
   * zero or one entry (a channel has at most one current binding per
   * profile), but the caller may offer more than one profile's worth without
   * this function needing to know that.
   */
  confirmedDids: readonly SignalFinderTargetRef[],
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
    ['confirmed', confirmedDids],
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
  const silent: SignalFinderPlanEntry[] = [];
  const silentEcus = new Set(options.silentEcus ?? []);
  const silentDids = new Set((options.silentDids ?? []).map(key));
  for (const entry of ordered) {
    // Y2 + Z4: a silent ECU drops everything on it (X2, hypotheses included --
    // the ECU is not on this bus), and so does an individually silent DID. The
    // hypothesis exception build 8 made here is gone: its one retry happens
    // BEFORE the plan is built, not inside the driver's script.
    if (silentEcus.has(entry.ecu) || silentDids.has(key(entry))) {
      silent.push(entry);
    } else if (dids.length < budget) {
      dids.push(entry);
    } else {
      notRead.push(entry);
    }
  }
  return { budget, dids, notRead, silent };
}
