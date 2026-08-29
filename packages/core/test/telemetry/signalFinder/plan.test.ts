import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FINDER_MIN_SAMPLES_PER_WINDOW,
  FINDER_BUDGET_MAX,
  FINDER_BUDGET_MIN,
  computeFinderDidBudget,
  planFinderRun,
  type SignalFinderPlanEntry,
} from '../../../src/telemetry/signalFinder';

/**
 * Ticket P4m M1 / contracts.md "Signal Finder REVISION (2026-08-29, after
 * field test 5)" item 10 (binding):
 *
 *   "Budget, not passes. The DIDs read during that script are chosen up front
 *    from the measured request rate so every DID gets >= 3 samples per 3 s
 *    window: `budget = floor(rate x 3 / 3)` clamped to [4, 12]. Priority:
 *    (a) hypotheses of the target on every ECU; (b) DIDs that CHANGED in
 *    earlier observations/finder runs (any rank other than static, from the
 *    sweep/finder stores); (c) other cached responders of the target's ECUs.
 *    All ECUs are polled in the SAME session (per-entry target address).
 *    Whatever does not fit is listed as 'not read (N) -- Next round'."
 */

function entry(ecu: number, did: number): { ecu: number; did: number } {
  return { ecu, did };
}

function pairs(entries: readonly SignalFinderPlanEntry[]): Array<[number, number]> {
  return entries.map((e) => [e.ecu, e.did]);
}

describe('computeFinderDidBudget (item 10)', () => {
  it('is floor(rate x window / minSamples) -- the field-measured 15 req/s clamps to 12', () => {
    // 15 req/s x 3 s window = 45 requests; 3 samples per DID per window -> 15
    // DIDs, clamped to the ceiling of 12.
    expect(computeFinderDidBudget(15)).toBe(FINDER_BUDGET_MAX);
    expect(FINDER_BUDGET_MAX).toBe(12);
    expect(FINDER_BUDGET_MIN).toBe(4);
    expect(DEFAULT_FINDER_MIN_SAMPLES_PER_WINDOW).toBe(3);
  });

  it('a slower adapter reads fewer DIDs rather than undersampling them', () => {
    expect(computeFinderDidBudget(8)).toBe(8);
    expect(computeFinderDidBudget(5.9)).toBe(5);
  });

  it('never drops below the floor of 4, and never trusts a nonsense rate', () => {
    expect(computeFinderDidBudget(1)).toBe(FINDER_BUDGET_MIN);
    expect(computeFinderDidBudget(0)).toBe(FINDER_BUDGET_MIN);
    expect(computeFinderDidBudget(Number.NaN)).toBe(FINDER_BUDGET_MIN);
  });
});

describe('planFinderRun (item 10) -- one round, every ECU, hypotheses FIRST', () => {
  it('orders hypotheses, then previously-CHANGED DIDs, then plain cached responders', () => {
    const plan = planFinderRun(
      15,
      [entry(0x12, 0x4002), entry(0x29, 0x500c)],
      [entry(0x12, 0x4522), entry(0x29, 0x5468)],
      [entry(0x12, 0x1000), entry(0x12, 0x1600)],
    );
    expect(plan.budget).toBe(12);
    expect(pairs(plan.dids)).toEqual([
      [0x12, 0x4002],
      [0x29, 0x500c],
      [0x12, 0x4522],
      [0x29, 0x5468],
      [0x12, 0x1000],
      [0x12, 0x1600],
    ]);
    expect(plan.dids.map((e) => e.source)).toEqual([
      'hypothesis',
      'hypothesis',
      'changed',
      'changed',
      'cached',
      'cached',
    ]);
    expect(plan.notRead).toEqual([]);
  });

  it('build 5 s defect: whatever does not fit is NOT READ, never silently dropped and never re-labelled "no response"', () => {
    const cached = Array.from({ length: 40 }, (_v, i) => entry(0x12, 0x2000 + i));
    const plan = planFinderRun(15, [entry(0x29, 0x500c)], [], cached);
    expect(plan.dids).toHaveLength(12);
    expect(plan.dids[0]).toMatchObject({ ecu: 0x29, did: 0x500c, source: 'hypothesis' });
    expect(plan.notRead).toHaveLength(29);
    // Everything eligible is either read or reported -- nothing vanishes.
    expect(plan.dids.length + plan.notRead.length).toBe(41);
    // The round took the hypothesis + the first 11 cached DIDs; the 12th
    // cached one is the first entry of "not read".
    expect(pairs(plan.notRead)[0]).toEqual([0x12, 0x200b]);
  });

  it('a second round reads the next slice: the caller excludes what round 1 already read', () => {
    const cached = Array.from({ length: 40 }, (_v, i) => entry(0x12, 0x2000 + i));
    const first = planFinderRun(15, [], [], cached);
    const second = planFinderRun(15, [], [], cached, { exclude: first.dids });
    expect(pairs(second.dids)[0]).toEqual([0x12, 0x200c]);
    expect(second.dids).toHaveLength(12);
    expect(second.notRead).toHaveLength(16);
    const overlap = second.dids.filter((s) => first.dids.some((f) => f.ecu === s.ecu && f.did === s.did));
    expect(overlap).toEqual([]);
  });

  it('the same (ecu, did) offered by two pools appears once, at its HIGHEST priority', () => {
    const plan = planFinderRun(15, [entry(0x12, 0x4002)], [entry(0x12, 0x4002)], [entry(0x12, 0x4002)]);
    expect(plan.dids).toHaveLength(1);
    expect(plan.dids[0]).toMatchObject({ source: 'hypothesis' });
    expect(plan.notRead).toEqual([]);
  });

  it('X4 (P4m-FIX1 M4): the SAME DID number on two ECUs lands in the SAME round -- identity is (ecu, did)', () => {
    // Build 6 deferred the second ECU's copy to another human script, because
    // the round was correlated by DID NUMBER alone. `runFinderRound` polls one
    // channel per ECU (composite identity), so the split has no reason to
    // exist: the driver presses once, both ECUs are read.
    const plan = planFinderRun(15, [entry(0x12, 0x500c), entry(0x29, 0x500c)], [], []);
    expect(pairs(plan.dids)).toEqual([
      [0x12, 0x500c],
      [0x29, 0x500c],
    ]);
    expect(plan.notRead).toEqual([]);
  });

  it('X2 (P4m-FIX1 H2): a SILENT ECU s DIDs are dropped from the round and do not consume the budget', () => {
    const cached = Array.from({ length: 6 }, (_v, i) => entry(0x12, 0x2000 + i));
    const plan = planFinderRun(15, [entry(0x29, 0x500c), entry(0x29, 0x500b)], [], cached, {
      budget: 4,
      silentEcus: [0x29],
    });
    // The two 0x29 hypotheses are reported as silent, and the budget is
    // refilled from the next pool rather than spent on an ECU that answers
    // nothing.
    expect(pairs(plan.silent)).toEqual([
      [0x29, 0x500c],
      [0x29, 0x500b],
    ]);
    expect(pairs(plan.dids)).toEqual([
      [0x12, 0x2000],
      [0x12, 0x2001],
      [0x12, 0x2002],
      [0x12, 0x2003],
    ]);
    // A silent entry is neither read nor "not read (Next round)" -- it has its
    // own honest reason.
    expect(pairs(plan.notRead)).toEqual([
      [0x12, 0x2004],
      [0x12, 0x2005],
    ]);
  });

  it('a slow adapter plans a smaller round, and an empty pool plans nothing at all', () => {
    const cached = Array.from({ length: 10 }, (_v, i) => entry(0x12, 0x2000 + i));
    expect(planFinderRun(5, [], [], cached).dids).toHaveLength(5);
    expect(planFinderRun(15, [], [], []).dids).toEqual([]);
    expect(planFinderRun(15, [], [], []).notRead).toEqual([]);
  });
});
