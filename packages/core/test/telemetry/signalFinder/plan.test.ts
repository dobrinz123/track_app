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
 * field test 5)" item 10 (binding), extended by ticket P4o O4 (binding, field
 * test 8):
 *
 *   "Budget, not passes. The DIDs read during that script are chosen up front
 *    from the measured request rate so every DID gets >= 3 samples per 3 s
 *    window: `budget = floor(rate x 3 / 3)` clamped to [4, 12]. Priority:
 *    (0, P4o O4) the target's own previously CONFIRMED binding(s);
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
      [],
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
    const plan = planFinderRun(15, [], [entry(0x29, 0x500c)], [], cached);
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
    const first = planFinderRun(15, [], [], [], cached);
    const second = planFinderRun(15, [], [], [], cached, { exclude: first.dids });
    expect(pairs(second.dids)[0]).toEqual([0x12, 0x200c]);
    expect(second.dids).toHaveLength(12);
    expect(second.notRead).toHaveLength(16);
    const overlap = second.dids.filter((s) => first.dids.some((f) => f.ecu === s.ecu && f.did === s.did));
    expect(overlap).toEqual([]);
  });

  it('the same (ecu, did) offered by two pools appears once, at its HIGHEST priority', () => {
    const plan = planFinderRun(15, [], [entry(0x12, 0x4002)], [entry(0x12, 0x4002)], [entry(0x12, 0x4002)]);
    expect(plan.dids).toHaveLength(1);
    expect(plan.dids[0]).toMatchObject({ source: 'hypothesis' });
    expect(plan.notRead).toEqual([]);
  });

  it('X4 (P4m-FIX1 M4): the SAME DID number on two ECUs lands in the SAME round -- identity is (ecu, did)', () => {
    // Build 6 deferred the second ECU's copy to another human script, because
    // the round was correlated by DID NUMBER alone. `runFinderRound` polls one
    // channel per ECU (composite identity), so the split has no reason to
    // exist: the driver presses once, both ECUs are read.
    const plan = planFinderRun(15, [], [entry(0x12, 0x500c), entry(0x29, 0x500c)], [], []);
    expect(pairs(plan.dids)).toEqual([
      [0x12, 0x500c],
      [0x29, 0x500c],
    ]);
    expect(plan.notRead).toEqual([]);
  });

  it('X2 (P4m-FIX1 H2): a SILENT ECU s DIDs are dropped from the round and do not consume the budget', () => {
    const cached = Array.from({ length: 6 }, (_v, i) => entry(0x12, 0x2000 + i));
    const plan = planFinderRun(15, [], [entry(0x29, 0x500c), entry(0x29, 0x500b)], [], cached, {
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
    expect(planFinderRun(5, [], [], [], cached).dids).toHaveLength(5);
    expect(planFinderRun(15, [], [], [], []).dids).toEqual([]);
    expect(planFinderRun(15, [], [], [], []).notRead).toEqual([]);
  });
});

/**
 * Ticket P4o O4 (binding, field test 8): "Previously confirmed bindings are
 * read FIRST in every profile: the plan's pool order becomes
 * confirmed-binding DIDs of the target → hypotheses → changed → cached.
 * Test: generic profile + confirmed 0x58B7 → 0x58B7 in the first round."
 *
 * Field bug this closes: a generic-profile find for `brakePressure` never
 * even offered the Supra's field-confirmed 0x58B7 (it is not a hypothesis on
 * the generic catalog), so the two-level DME flag 0x4002 that WAS a cached
 * responder won the round unopposed and got silently confirmed over it.
 */
describe('planFinderRun -- confirmed bindings lead every other pool (P4o O4)', () => {
  it('a confirmed DID is read in round 1, ahead of hypotheses, changed and cached DIDs alike', () => {
    const plan = planFinderRun(
      15,
      [entry(0x12, 0x58b7)],
      [entry(0x12, 0x4002)],
      [entry(0x12, 0x4522)],
      [entry(0x12, 0x1000)],
    );
    expect(pairs(plan.dids)[0]).toEqual([0x12, 0x58b7]);
    expect(plan.dids[0]).toMatchObject({ source: 'confirmed' });
    expect(pairs(plan.dids)).toEqual([
      [0x12, 0x58b7],
      [0x12, 0x4002],
      [0x12, 0x4522],
      [0x12, 0x1000],
    ]);
  });

  it('a confirmed DID never eaten by the budget -- it is refilled from the front, not the back', () => {
    const cached = Array.from({ length: 20 }, (_v, i) => entry(0x12, 0x2000 + i));
    const plan = planFinderRun(15, [entry(0x12, 0x58b7)], [], [], cached, { budget: 4 });
    expect(pairs(plan.dids)).toEqual([
      [0x12, 0x58b7],
      [0x12, 0x2000],
      [0x12, 0x2001],
      [0x12, 0x2002],
    ]);
    expect(plan.dids[0]).toMatchObject({ source: 'confirmed' });
  });

  it('a confirmed DID that is ALSO a hypothesis appears once, still as `confirmed` (highest priority)', () => {
    const plan = planFinderRun(15, [entry(0x12, 0x4002)], [entry(0x12, 0x4002)], [], []);
    expect(plan.dids).toHaveLength(1);
    expect(plan.dids[0]).toMatchObject({ ecu: 0x12, did: 0x4002, source: 'confirmed' });
  });

  it('a wholly silent ECU still drops its confirmed DID like any other (P4m-FIX1 X2 applies here too)', () => {
    const plan = planFinderRun(15, [entry(0x29, 0x500c)], [], [], [entry(0x12, 0x2000)], {
      budget: 4,
      silentEcus: [0x29],
    });
    expect(pairs(plan.silent)).toEqual([[0x29, 0x500c]]);
    expect(pairs(plan.dids)).toEqual([[0x12, 0x2000]]);
  });

  it('no confirmed binding at all is a no-op -- hypotheses still lead as before', () => {
    const plan = planFinderRun(15, [], [entry(0x12, 0x4002)], [], []);
    expect(pairs(plan.dids)).toEqual([[0x12, 0x4002]]);
    expect(plan.dids[0]).toMatchObject({ source: 'hypothesis' });
  });
});

/**
 * Ticket P4m-FIX2 Y2 (Codex P4m-REV2 finding 12, HIGH): "an ECU that answers
 * one probe request and then goes silent -- or has one answering DID plus many
 * silent DIDs -- can produce a fast measured rate and retain every DID; 11
 * retained DIDs can then consume 11 x 3 x 300 ms = 9.9 s".
 *
 * So the plan drops INDIVIDUAL silent DIDs too, not only wholly silent ECUs.
 *
 * P4m-FIX3 Z4 (Codex P4m-REV3 finding 10, MEDIUM) removed the one exception
 * build 8 made here. A silent HYPOTHESIS used to be kept "for one retry inside
 * the script", which the runner then turned into three misses plus one more in
 * every evidence window -- paid for out of the driver's own script. The single
 * retry is now an EXPLICIT request the controller makes AFTER the probe and
 * BEFORE the script; whatever is still silent when the plan is built is silent,
 * hypothesis or not.
 */
describe('planFinderRun -- individually silent DIDs (P4m-FIX2 Y2, P4m-FIX3 Z4)', () => {
  it('Z4: a hypothesis still silent after its one retry is dropped like any other silent DID', () => {
    const hypotheses = [entry(0x12, 0x4002)];
    const cached = Array.from({ length: 12 }, (_v, i) => entry(0x12, 0x5000 + i));
    const plan = planFinderRun(15, [], hypotheses, [], cached, {
      budget: 4,
      // The probe -- and then the explicit retry -- answered on 0x5000 only.
      silentDids: [entry(0x12, 0x4002), entry(0x12, 0x5001), entry(0x12, 0x5002), entry(0x12, 0x5003)],
    });
    // The hypothesis is NOT polled during the script: it is "not read -- silent".
    expect(pairs(plan.silent)).toEqual([
      [0x12, 0x4002],
      [0x12, 0x5001],
      [0x12, 0x5002],
      [0x12, 0x5003],
    ]);
    // ... and every slot it would have taken is refilled from the pool behind it.
    expect(pairs(plan.dids)).toEqual([
      [0x12, 0x5000],
      [0x12, 0x5004],
      [0x12, 0x5005],
      [0x12, 0x5006],
    ]);
    // Nothing vanished.
    expect(plan.dids.length + plan.silent.length + plan.notRead.length).toBe(13);
  });

  it('a hypothesis the probe never called silent is still planned FIRST', () => {
    const plan = planFinderRun(15, [], [entry(0x12, 0x4002)], [], [entry(0x12, 0x5000)], {
      budget: 4,
      silentDids: [entry(0x12, 0x5000)],
    });
    expect(pairs(plan.dids)).toEqual([[0x12, 0x4002]]);
    expect(pairs(plan.silent)).toEqual([[0x12, 0x5000]]);
  });

  it('a silent ECU still drops everything on it, hypotheses included (P4m-FIX1 X2 is unchanged)', () => {
    const plan = planFinderRun(15, [], [entry(0x29, 0x500c)], [], [entry(0x12, 0x2000)], {
      budget: 4,
      silentEcus: [0x29],
      silentDids: [entry(0x29, 0x500c)],
    });
    expect(pairs(plan.silent)).toEqual([[0x29, 0x500c]]);
    expect(pairs(plan.dids)).toEqual([[0x12, 0x2000]]);
  });
});
