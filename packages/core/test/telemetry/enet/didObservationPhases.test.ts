import { describe, expect, it } from 'vitest';
import {
  ASSUMED_GUIDED_REQ_PER_SEC,
  computeChangingValuePrePassDurationMs,
  computeDidBlockCandidateSummaries,
  computeDidCandidateSummaries,
  computeGuidedPhaseDurationMs,
  DID_OBSERVATION_PHASES,
  MIN_SAMPLES_PER_CANDIDATE_PER_PHASE,
  type DidPhaseSample,
} from '../../../src/telemetry/enet/didObservationPhases';

function sample(did: number, phase: DidPhaseSample['phase'], tMs: number, raw: number[]): DidPhaseSample {
  return { did, phase, tMs, raw: Uint8Array.from(raw) };
}

/**
 * DID sweep — guided candidate observation addendum (2026-08-27, binding —
 * Phase 4i, user clarification): "once the responders are written I can't
 * tell whether they change or not ... the OBSERVATION on the filtered
 * candidates must be a visible, guided, repeated re-read" across
 * baseline/brake/steering/throttle phases.
 */
describe('DID_OBSERVATION_PHASES (binding, P4i guided observation)', () => {
  it('is the fixed 4-phase plan in order: baseline, brake, steering, throttle', () => {
    expect(DID_OBSERVATION_PHASES.map((p) => p.id)).toEqual(['baseline', 'brake', 'steering', 'throttle']);
  });

  it('every phase has a ~6s duration and a non-empty on-screen prompt', () => {
    for (const phase of DID_OBSERVATION_PHASES) {
      expect(phase.durationMs).toBe(6_000);
      expect(phase.prompt.length).toBeGreaterThan(0);
    }
  });
});

describe('computeDidCandidateSummaries (binding, P4i guided observation)', () => {
  it('a brake candidate: static at baseline, changed ONLY during brake -> ranked "brakeCandidate" (F5 fix: labelled by the phase, not a merged guess)', () => {
    const samples: DidPhaseSample[] = [
      sample(0x2010, 'baseline', 0, [0x00]),
      sample(0x2010, 'baseline', 1_000, [0x00]),
      sample(0x2010, 'brake', 0, [0x00]),
      sample(0x2010, 'brake', 1_000, [0xff]),
      sample(0x2010, 'brake', 2_000, [0x00]),
      sample(0x2010, 'steering', 0, [0x00]),
      sample(0x2010, 'steering', 1_000, [0x00]),
      sample(0x2010, 'throttle', 0, [0x00]),
      sample(0x2010, 'throttle', 1_000, [0x00]),
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary).toMatchObject({
      did: 0x2010,
      rank: 'brakeCandidate',
      changedInPhase: { baseline: false, brake: true, steering: false, throttle: false },
    });
  });

  it('a steering candidate: static at baseline, changed ONLY during steering -> ranked "steeringCandidate"', () => {
    const samples: DidPhaseSample[] = [
      sample(0x2020, 'baseline', 0, [0x80, 0x00]),
      sample(0x2020, 'brake', 0, [0x80, 0x00]),
      sample(0x2020, 'steering', 0, [0x80, 0x00]),
      sample(0x2020, 'steering', 500, [0x40, 0x00]),
      sample(0x2020, 'steering', 1_000, [0xc0, 0x00]),
      sample(0x2020, 'throttle', 0, [0x80, 0x00]),
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.rank).toBe('steeringCandidate');
    expect(summary?.changedInPhase).toEqual({ baseline: false, brake: false, steering: true, throttle: false });
  });

  it('a throttle candidate: static at baseline, changed ONLY during throttle -> ranked "throttleCandidate" (F5 fix: previously mislabelled "BRAKE/STEERING?")', () => {
    const samples: DidPhaseSample[] = [
      sample(0x2030, 'baseline', 0, [0x00]),
      sample(0x2030, 'brake', 0, [0x00]),
      sample(0x2030, 'steering', 0, [0x00]),
      sample(0x2030, 'throttle', 0, [0x00]),
      sample(0x2030, 'throttle', 500, [0xff]),
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.rank).toBe('throttleCandidate');
    expect(summary?.changedInPhase).toEqual({ baseline: false, brake: false, steering: false, throttle: true });
  });

  it('a DID that changed in TWO active phases (brake AND throttle) is ranked "changedInSeveral", not a single-phase candidate', () => {
    const samples: DidPhaseSample[] = [
      sample(0x3000, 'baseline', 0, [0x00]),
      sample(0x3000, 'brake', 0, [0x00]),
      sample(0x3000, 'brake', 500, [0xff]),
      sample(0x3000, 'steering', 0, [0x00]),
      sample(0x3000, 'throttle', 0, [0x00]),
      sample(0x3000, 'throttle', 500, [0x22]),
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.rank).toBe('changedInSeveral');
  });

  it('a DID that already changed at baseline (never a clean control) is NEVER a single-phase candidate even if it also changed in exactly one active phase', () => {
    const samples: DidPhaseSample[] = [
      sample(0x3100, 'baseline', 0, [0x00]),
      sample(0x3100, 'baseline', 500, [0x01]), // already varies at rest -- e.g. sensor noise, not a clean brake/steering signal.
      sample(0x3100, 'brake', 0, [0x00]),
      sample(0x3100, 'brake', 500, [0xff]),
      sample(0x3100, 'steering', 0, [0x00]),
      sample(0x3100, 'throttle', 0, [0x00]),
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.changedInPhase.baseline).toBe(true);
    expect(summary?.rank).toBe('static');
  });

  it('a DID static in EVERY phase is ranked "static" (collapsed by the UI)', () => {
    const samples: DidPhaseSample[] = [
      sample(0x1000, 'baseline', 0, [0x59]),
      sample(0x1000, 'brake', 0, [0x59]),
      sample(0x1000, 'steering', 0, [0x59]),
      sample(0x1000, 'throttle', 0, [0x59]),
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.rank).toBe('static');
    expect(Object.values(summary!.changedInPhase).every((c) => c === false)).toBe(true);
  });

  it('sorts single-phase candidates first (any of brake/steering/throttle), then changedInSeveral, then static -- ties broken by ascending DID', () => {
    const staticDid = [sample(0x9000, 'baseline', 0, [0x01]), sample(0x9000, 'brake', 0, [0x01])];
    const severalDid = [
      sample(0x5000, 'baseline', 0, [0x00]),
      sample(0x5000, 'brake', 0, [0x00]),
      sample(0x5000, 'brake', 100, [0x01]),
      sample(0x5000, 'steering', 0, [0x00]),
      sample(0x5000, 'steering', 100, [0x02]),
    ];
    const candidateA = [sample(0x2020, 'baseline', 0, [0x00]), sample(0x2020, 'brake', 0, [0x00]), sample(0x2020, 'brake', 100, [0x01])];
    const candidateB = [sample(0x2010, 'baseline', 0, [0x00]), sample(0x2010, 'brake', 0, [0x00]), sample(0x2010, 'brake', 100, [0x01])];
    const summaries = computeDidCandidateSummaries([...staticDid, ...severalDid, ...candidateA, ...candidateB]);
    expect(summaries.map((s) => s.did)).toEqual([0x2010, 0x2020, 0x5000, 0x9000]);
    expect(summaries.map((s) => s.rank)).toEqual([
      'brakeCandidate',
      'brakeCandidate',
      'changedInSeveral',
      'static',
    ]);
  });

  it('decodes min/max as an 8-bit uint for 1-byte responses', () => {
    const samples: DidPhaseSample[] = [
      sample(0x1002, 'baseline', 0, [10]),
      sample(0x1002, 'brake', 0, [200]),
      sample(0x1002, 'brake', 100, [50]),
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.min).toBe(10);
    expect(summary?.max).toBe(200);
  });

  it('decodes min/max as a 16-bit big-endian uint for 2-byte responses', () => {
    const samples: DidPhaseSample[] = [
      sample(0x1003, 'baseline', 0, [0x01, 0x00]), // 256.
      sample(0x1003, 'brake', 0, [0x02, 0x00]), // 512.
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.min).toBe(256);
    expect(summary?.max).toBe(512);
  });

  it('min/max stay null when no sample is exactly 1 or 2 bytes', () => {
    const samples: DidPhaseSample[] = [sample(0x1004, 'baseline', 0, [1, 2, 3])];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.min).toBeNull();
    expect(summary?.max).toBeNull();
  });

  it('lastRawHex is the MOST RECENT sample in input order, across every phase', () => {
    const samples: DidPhaseSample[] = [
      sample(0x1005, 'baseline', 0, [0x11]),
      sample(0x1005, 'brake', 0, [0x22]),
      sample(0x1005, 'throttle', 0, [0x33]),
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.lastRawHex).toBe('33');
  });

  it('distinctValueCount counts unique raw values across ALL phases combined', () => {
    const samples: DidPhaseSample[] = [
      sample(0x1006, 'baseline', 0, [0x01]),
      sample(0x1006, 'brake', 0, [0x01]), // same value as baseline -- not a new distinct value.
      sample(0x1006, 'steering', 0, [0x02]),
      sample(0x1006, 'throttle', 0, [0x03]),
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.distinctValueCount).toBe(3);
    expect(summary?.sampleCount).toBe(4);
  });

  it('a phase with zero samples for a DID reports changedInPhase[that phase] as false, not throwing', () => {
    const samples: DidPhaseSample[] = [sample(0x1007, 'baseline', 0, [0x01])]; // brake/steering/throttle never sampled this DID.
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.changedInPhase).toEqual({ baseline: false, brake: false, steering: false, throttle: false });
  });

  it('multiple DIDs are grouped independently', () => {
    const samples: DidPhaseSample[] = [
      sample(0x1000, 'baseline', 0, [0x00]),
      sample(0x2000, 'baseline', 0, [0x00]),
      sample(0x1000, 'brake', 0, [0x00]),
      sample(0x1000, 'brake', 100, [0xff]),
      sample(0x2000, 'brake', 0, [0x00]),
      sample(0x2000, 'brake', 100, [0x00]),
    ];
    const summaries = computeDidCandidateSummaries(samples);
    expect(summaries).toHaveLength(2);
    expect(summaries.find((s) => s.did === 0x1000)?.rank).toBe('brakeCandidate');
    expect(summaries.find((s) => s.did === 0x2000)?.rank).toBe('static');
  });

  it('an empty sample log returns an empty summary list', () => {
    expect(computeDidCandidateSummaries([])).toEqual([]);
  });
});

/**
 * F2 fix (P4i-FIX1, binding, after Codex P4hrev2c): "if the [candidate] set is
 * larger than ~rate×phaseSeconds, raise the phase length automatically (show
 * it) so every candidate is sampled ≥ 2× per phase." Test: "300 candidates at
 * 15 req/s → phase length grows" (the ticket's own literal scenario).
 */
describe('computeGuidedPhaseDurationMs (binding, P4i-FIX1 F2)', () => {
  it('300 candidates at 15 req/s -> the phase length grows to guarantee >= 2 samples/candidate (40s, well beyond the 6s base)', () => {
    const durationMs = computeGuidedPhaseDurationMs(300, 6_000, 15);
    expect(durationMs).toBe(40_000); // ceil(2 * 300 / 15 * 1000).
    expect(durationMs).toBeGreaterThan(6_000);
  });

  it('uses the field-measured ASSUMED_GUIDED_REQ_PER_SEC and MIN_SAMPLES_PER_CANDIDATE_PER_PHASE as its own defaults', () => {
    expect(ASSUMED_GUIDED_REQ_PER_SEC).toBeGreaterThan(0);
    expect(MIN_SAMPLES_PER_CANDIDATE_PER_PHASE).toBe(2);
    expect(computeGuidedPhaseDurationMs(300, 6_000)).toBe(
      Math.ceil((MIN_SAMPLES_PER_CANDIDATE_PER_PHASE * 300) / ASSUMED_GUIDED_REQ_PER_SEC * 1_000),
    );
  });

  it('a small candidate set never shrinks below the fixed base duration', () => {
    expect(computeGuidedPhaseDurationMs(5, 6_000, 15)).toBe(6_000);
    expect(computeGuidedPhaseDurationMs(0, 6_000, 15)).toBe(6_000);
  });

  it('a minSamplesPerCandidate of 1 (the two-sample pre-pass\' own single-round sizing) needs half the duration of the default 2', () => {
    expect(computeGuidedPhaseDurationMs(300, 2_000, 15, 1)).toBe(20_000); // ceil(1 * 300 / 15 * 1000).
  });

  it('a non-finite/non-positive rate falls back to the base duration rather than dividing by zero/NaN', () => {
    expect(computeGuidedPhaseDurationMs(300, 6_000, 0)).toBe(6_000);
    expect(computeGuidedPhaseDurationMs(300, 6_000, Number.NaN)).toBe(6_000);
    expect(computeGuidedPhaseDurationMs(300, 6_000, -5)).toBe(6_000);
  });
});

/**
 * R6 (P4i-FIX2, binding, after Codex P4hrev3 NEW MEDIUM "the new pre-pass
 * countdown is materially wrong"): "real phase duration (2 rounds + gap,
 * scaled by candidate count)."
 */
describe('computeChangingValuePrePassDurationMs (binding, P4i-FIX2 R6)', () => {
  it('a single candidate: one round stays at its 2s base, doubled, plus the 2s gap -- 6s total (never the old frozen 2000ms)', () => {
    expect(computeChangingValuePrePassDurationMs(1, 2_000, 2_000, 15)).toBe(6_000);
  });

  it('300 candidates at 15 req/s: each round grows to 20s (minSamplesPerCandidate 1) -- total 42s', () => {
    // computeGuidedPhaseDurationMs(300, 2000, 15, 1) = ceil(300/15*1000) = 20000.
    expect(computeChangingValuePrePassDurationMs(300, 2_000, 2_000, 15)).toBe(42_000);
  });

  it('defaults to ASSUMED_GUIDED_REQ_PER_SEC when no rate is given', () => {
    expect(computeChangingValuePrePassDurationMs(300, 2_000, 2_000)).toBe(
      computeChangingValuePrePassDurationMs(300, 2_000, 2_000, ASSUMED_GUIDED_REQ_PER_SEC),
    );
  });

  it('a zero-candidate set still returns twice the (unscaled) base round plus the gap', () => {
    expect(computeChangingValuePrePassDurationMs(0, 2_000, 2_000, 15)).toBe(6_000);
  });
});

/**
 * Ticket P4j (binding): "ranking per DID uses >= 5 samples (a change counts
 * only if the value range in an active phase exceeds the baseline range by a
 * margin, e.g. > 2x baseline spread or > 3 raw units)". Field evidence: with
 * batching, every candidate now gets >= 5 samples/phase (see
 * `didObservationBatches.test.ts`) -- these tests use the ticket's own
 * literal 0x4522 noise example to prove the margin rule filters it while
 * still ranking a genuine brake signal.
 */
describe('computeDidCandidateSummaries -- margin-based ranking (ticket P4j, binding, opt-in via useMarginRule)', () => {
  it('useMarginRule defaults to false -- naive distinctness, byte-identical to the pre-ticket behaviour, when omitted', () => {
    const samples: DidPhaseSample[] = [
      sample(0x2010, 'baseline', 0, [0x00]),
      sample(0x2010, 'brake', 0, [0x00]),
      sample(0x2010, 'brake', 1_000, [0x01]), // a tiny 1-unit wobble -- naive rule still flags it "changed".
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.changedInPhase.brake).toBe(true);
    expect(summary?.rank).toBe('brakeCandidate');
  });

  it('0x4522-shaped noise (297 -> 305 -> 295 during brake, similar spread at baseline): the margin rule filters it -- NOT a candidate', () => {
    const samples: DidPhaseSample[] = [
      // baseline: 5 samples, range 10 (298..308) -- ordinary sensor jitter at rest.
      sample(0x4522, 'baseline', 0, [0x01, 0x2a]), // 298
      sample(0x4522, 'baseline', 100, [0x01, 0x30]), // 304
      sample(0x4522, 'baseline', 200, [0x01, 0x2c]), // 300
      sample(0x4522, 'baseline', 300, [0x01, 0x34]), // 308
      sample(0x4522, 'baseline', 400, [0x01, 0x2e]), // 302
      // brake: 5 samples, range 10 (295..305) -- the ticket's own literal example, no wider than baseline's own jitter.
      sample(0x4522, 'brake', 0, [0x01, 0x29]), // 297
      sample(0x4522, 'brake', 100, [0x01, 0x31]), // 305
      sample(0x4522, 'brake', 200, [0x01, 0x27]), // 295
      sample(0x4522, 'brake', 300, [0x01, 0x2c]), // 300
      sample(0x4522, 'brake', 400, [0x01, 0x2e]), // 302
    ];
    const [summary] = computeDidCandidateSummaries(samples, { useMarginRule: true, minSamplesPerPhase: 5 });
    expect(summary?.changedInPhase.brake).toBe(false);
    expect(summary?.rank).toBe('static');
  });

  it('a genuine brake signal (baseline dead still, brake swings well past the margin): ranked "brakeCandidate"', () => {
    const samples: DidPhaseSample[] = [
      sample(0x4600, 'baseline', 0, [10]),
      sample(0x4600, 'baseline', 100, [10]),
      sample(0x4600, 'baseline', 200, [10]),
      sample(0x4600, 'baseline', 300, [10]),
      sample(0x4600, 'baseline', 400, [10]),
      sample(0x4600, 'brake', 0, [10]),
      sample(0x4600, 'brake', 100, [200]),
      sample(0x4600, 'brake', 200, [50]),
      sample(0x4600, 'brake', 300, [180]),
      sample(0x4600, 'brake', 400, [20]),
    ];
    const [summary] = computeDidCandidateSummaries(samples, { useMarginRule: true, minSamplesPerPhase: 5 });
    expect(summary?.changedInPhase.brake).toBe(true);
    expect(summary?.rank).toBe('brakeCandidate');
  });

  // SUPERSEDED by ticket P4j-FIX1 H2 (binding, after Codex P4j-REV1 HIGH #2):
  // the naive-distinctness fallback below `minSamplesPerPhase` is exactly what
  // re-flagged ordinary idle jitter as a candidate (field: 0x4522, one
  // baseline and two brake samples reading 297 / 305 / 295). Under-sampling is
  // now reported as `insufficient` and never ranked.
  it('below minSamplesPerPhase, the phase reports `insufficient` -- NEVER a naive-distinctness fallback', () => {
    const samples: DidPhaseSample[] = [
      sample(0x4700, 'baseline', 0, [100]),
      sample(0x4700, 'brake', 0, [100]),
      sample(0x4700, 'brake', 100, [101]), // only 2 samples -- below minSamplesPerPhase: 5.
    ];
    const [summary] = computeDidCandidateSummaries(samples, { useMarginRule: true, minSamplesPerPhase: 5 });
    expect(summary?.phaseEvidence.brake).toBe('insufficient');
    expect(summary?.changedInPhase.brake).toBe(false);
    expect(summary?.rank).toBe('static');
  });

  it('a phase that does not decode cleanly (mixed lengths) falls back to naive distinctness rather than reporting "unchanged"', () => {
    const samples: DidPhaseSample[] = [
      sample(0x4800, 'baseline', 0, [1, 2, 3]),
      sample(0x4800, 'baseline', 100, [1, 2, 3]),
      sample(0x4800, 'brake', 0, [1, 2, 3]),
      sample(0x4800, 'brake', 100, [9, 9, 9]),
    ];
    const [summary] = computeDidCandidateSummaries(samples, { useMarginRule: true, minSamplesPerPhase: 1 });
    expect(summary?.changedInPhase.brake).toBe(true); // naive fallback: the 3-byte hex actually differs.
    expect(summary?.rank).toBe('brakeCandidate');
  });

  it('the marginRawUnits floor still catches a real signal even when the baseline is perfectly still (range 0)', () => {
    const samples: DidPhaseSample[] = [
      sample(0x4900, 'baseline', 0, [50]),
      sample(0x4900, 'baseline', 100, [50]),
      sample(0x4900, 'baseline', 200, [50]),
      sample(0x4900, 'baseline', 300, [50]),
      sample(0x4900, 'baseline', 400, [50]),
      sample(0x4900, 'brake', 0, [50]),
      sample(0x4900, 'brake', 100, [50]),
      sample(0x4900, 'brake', 200, [50]),
      sample(0x4900, 'brake', 300, [50]),
      sample(0x4900, 'brake', 400, [55]), // range 5 -- exceeds the default marginRawUnits (3) even though 2x baseline range (0) is 0.
    ];
    const [summary] = computeDidCandidateSummaries(samples, { useMarginRule: true, minSamplesPerPhase: 5 });
    expect(summary?.changedInPhase.brake).toBe(true);
    expect(summary?.rank).toBe('brakeCandidate');
  });
});

/**
 * Ticket P4j (binding): "Mid-size blocks (9-32 bytes) join the candidate pool
 * with per-byte-offset diffing: a block is 'changed in phase' if any byte
 * offset changes beyond baseline; the export lists changed offsets."
 */
describe('computeDidBlockCandidateSummaries (ticket P4j, binding: mid-size block per-byte-offset diffing)', () => {
  function blockSample(did: number, phase: DidPhaseSample['phase'], tMs: number, raw: number[]): DidPhaseSample {
    return { did, phase, tMs, raw: Uint8Array.from(raw) };
  }

  function block(fill: number, len = 10): number[] {
    return new Array(len).fill(fill);
  }

  it('0x40B5-shaped: a 10-byte block, static everywhere except offsets 4-5 during brake -> ranked "brakeCandidate", changed offsets listed', () => {
    const baseline1 = block(0x00);
    const baseline2 = block(0x00);
    const brake1 = [...block(0x00)];
    brake1[4] = 0x10;
    brake1[5] = 0x20;
    const brake2 = [...block(0x00)];
    brake2[4] = 0x50;
    brake2[5] = 0x60;
    const samples: DidPhaseSample[] = [
      blockSample(0x40b5, 'baseline', 0, baseline1),
      blockSample(0x40b5, 'baseline', 100, baseline2),
      blockSample(0x40b5, 'brake', 0, brake1),
      blockSample(0x40b5, 'brake', 100, brake2),
      blockSample(0x40b5, 'steering', 0, block(0x00)),
      blockSample(0x40b5, 'steering', 100, block(0x00)),
      blockSample(0x40b5, 'throttle', 0, block(0x00)),
      blockSample(0x40b5, 'throttle', 100, block(0x00)),
    ];
    const [summary] = computeDidBlockCandidateSummaries(samples);
    expect(summary).toMatchObject({ did: 0x40b5, length: 10, rank: 'brakeCandidate' });
    expect(summary?.changedOffsetsByPhase.brake).toEqual([4, 5]);
    expect(summary?.changedOffsetsByPhase.steering).toEqual([]);
    expect(summary?.changedOffsetsByPhase.throttle).toEqual([]);
    expect(summary?.changedOffsetsByPhase.baseline).toEqual([]);
  });

  it('a block that changes in two active phases is ranked "changedInSeveral"', () => {
    const brakeChanged = [...block(0x00)];
    brakeChanged[2] = 0xff;
    const throttleChanged = [...block(0x00)];
    throttleChanged[7] = 0xff;
    const samples: DidPhaseSample[] = [
      blockSample(0x40c0, 'baseline', 0, block(0x00)),
      blockSample(0x40c0, 'brake', 0, block(0x00)),
      blockSample(0x40c0, 'brake', 100, brakeChanged),
      blockSample(0x40c0, 'steering', 0, block(0x00)),
      blockSample(0x40c0, 'throttle', 0, block(0x00)),
      blockSample(0x40c0, 'throttle', 100, throttleChanged),
    ];
    const [summary] = computeDidBlockCandidateSummaries(samples);
    expect(summary?.rank).toBe('changedInSeveral');
  });

  it('a block static in every phase (or only jittering within the baseline margin) is ranked "static"', () => {
    const samples: DidPhaseSample[] = [
      blockSample(0x40d0, 'baseline', 0, block(0x59)),
      blockSample(0x40d0, 'brake', 0, block(0x59)),
      blockSample(0x40d0, 'steering', 0, block(0x59)),
      blockSample(0x40d0, 'throttle', 0, block(0x59)),
    ];
    const [summary] = computeDidBlockCandidateSummaries(samples);
    expect(summary?.rank).toBe('static');
    expect(Object.values(summary!.changedOffsetsByPhase).every((offsets) => offsets.length === 0)).toBe(true);
  });

  it('a DID outside the 9-32 byte window (e.g. a 6-byte numeric candidate, or a 200-byte blob) is EXCLUDED entirely', () => {
    const shortSamples: DidPhaseSample[] = [
      blockSample(0x1002, 'baseline', 0, [0, 1, 2, 3, 4, 5]),
      blockSample(0x1002, 'brake', 0, [9, 1, 2, 3, 4, 5]),
    ];
    expect(computeDidBlockCandidateSummaries(shortSamples)).toEqual([]);

    const bigBlob = new Array(200).fill(0);
    const bigSamples: DidPhaseSample[] = [
      blockSample(0x4097, 'baseline', 0, bigBlob),
      blockSample(0x4097, 'brake', 0, bigBlob),
    ];
    expect(computeDidBlockCandidateSummaries(bigSamples)).toEqual([]);
  });

  it('a DID whose samples disagree on length is excluded entirely (no consistent per-offset comparison is possible)', () => {
    const samples: DidPhaseSample[] = [
      blockSample(0x4200, 'baseline', 0, block(0x00, 10)),
      blockSample(0x4200, 'brake', 0, block(0x00, 12)), // different length -- offsets would be meaningless.
    ];
    expect(computeDidBlockCandidateSummaries(samples)).toEqual([]);
  });

  it('below minSamplesPerPhase, a phase reports no changed offsets at all (not enough evidence)', () => {
    const brakeChanged = [...block(0x00)];
    brakeChanged[3] = 0xff;
    const samples: DidPhaseSample[] = [
      blockSample(0x4300, 'baseline', 0, block(0x00)),
      blockSample(0x4300, 'brake', 0, block(0x00)),
      blockSample(0x4300, 'brake', 100, brakeChanged),
    ];
    const [summary] = computeDidBlockCandidateSummaries(samples, { minSamplesPerPhase: 5 });
    expect(summary?.changedOffsetsByPhase.brake).toEqual([]);
    expect(summary?.rank).toBe('static');
  });

  it('an empty sample log returns an empty list', () => {
    expect(computeDidBlockCandidateSummaries([])).toEqual([]);
  });

  it('sorts single-phase candidates first, then changedInSeveral, then static -- ties broken by ascending DID', () => {
    const changed = [...block(0x00)];
    changed[0] = 0xff;
    const staticDid: DidPhaseSample[] = [blockSample(0x4b00, 'baseline', 0, block(0x00)), blockSample(0x4b00, 'brake', 0, block(0x00))];
    const brakeDidA: DidPhaseSample[] = [
      blockSample(0x4a20, 'baseline', 0, block(0x00)),
      blockSample(0x4a20, 'brake', 0, block(0x00)),
      blockSample(0x4a20, 'brake', 100, changed),
    ];
    const brakeDidB: DidPhaseSample[] = [
      blockSample(0x4a10, 'baseline', 0, block(0x00)),
      blockSample(0x4a10, 'brake', 0, block(0x00)),
      blockSample(0x4a10, 'brake', 100, changed),
    ];
    const summaries = computeDidBlockCandidateSummaries([...staticDid, ...brakeDidA, ...brakeDidB]);
    expect(summaries.map((s) => s.did)).toEqual([0x4a10, 0x4a20, 0x4b00]);
    expect(summaries.map((s) => s.rank)).toEqual(['brakeCandidate', 'brakeCandidate', 'static']);
  });
});
