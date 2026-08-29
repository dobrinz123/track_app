import { describe, expect, it } from 'vitest';
import {
  computeDidBlockCandidateSummaries,
  computeDidCandidateSummaries,
  type DidPhaseSample,
} from '../../../src/telemetry/enet/didObservationPhases';

/**
 * Ticket P4j-FIX1 H2 (binding, after Codex P4j-REV1 HIGH #2): the change rule
 * must catch booleans and stable level shifts, must NOT flag baseline-level
 * jitter, and must NEVER fall back to naive distinctness when a phase is
 * under-sampled -- it reports `insufficient` instead.
 *
 * The numeric fixtures below are the REAL field shapes from
 * `data/field/sweeps/2026-08-29-supra-dme12-0x4000-0x4FFF.json` (DID 0x4522
 * read 297 -> 305 -> 295, i.e. 0x0129 / 0x0131 / 0x0127 -- ordinary idle
 * jitter that the pre-fix naive rule flagged as a brake candidate).
 */

function sample(did: number, phase: DidPhaseSample['phase'], tMs: number, raw: number[]): DidPhaseSample {
  return { did, phase, tMs, raw: Uint8Array.from(raw) };
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function repeat(
  did: number,
  phase: DidPhaseSample['phase'],
  values: readonly number[],
  raw: (v: number) => number[],
): DidPhaseSample[] {
  return values.map((v, index) => sample(did, phase, index * 100, raw(v)));
}

const MARGIN = { useMarginRule: true, minSamplesPerPhase: 5 } as const;

describe('computeDidCandidateSummaries — P4j-FIX1 H2 change rule (binding)', () => {
  it('a STABLE 0 -> 1 switch is "changed" (the pre-fix range rule saw range 0 in both phases and missed it)', () => {
    const samples = [
      ...repeat(0x4a1d, 'baseline', [0, 0, 0, 0, 0], (v) => [v]),
      ...repeat(0x4a1d, 'brake', [1, 1, 1, 1, 1], (v) => [v]),
      ...repeat(0x4a1d, 'steering', [0, 0, 0, 0, 0], (v) => [v]),
      ...repeat(0x4a1d, 'throttle', [0, 0, 0, 0, 0], (v) => [v]),
    ];
    const [summary] = computeDidCandidateSummaries(samples, MARGIN);
    expect(summary?.phaseEvidence.brake).toBe('changed');
    expect(summary?.rank).toBe('brakeCandidate');
  });

  it('a TOGGLING 0/1 signal is "changed" (raw range 1 is below the 3-raw-unit floor the pre-fix rule demanded)', () => {
    const samples = [
      ...repeat(0x4a1e, 'baseline', [0, 0, 0, 0, 0], (v) => [v]),
      ...repeat(0x4a1e, 'brake', [0, 1, 0, 1, 0], (v) => [v]),
      ...repeat(0x4a1e, 'steering', [0, 0, 0, 0, 0], (v) => [v]),
      ...repeat(0x4a1e, 'throttle', [0, 0, 0, 0, 0], (v) => [v]),
    ];
    const [summary] = computeDidCandidateSummaries(samples, MARGIN);
    expect(summary?.phaseEvidence.brake).toBe('changed');
    expect(summary?.rank).toBe('brakeCandidate');
  });

  it('baseline JITTER never disqualifies a real level shift (baseline spread is the noise floor, never a distinct-count veto)', () => {
    const samples = [
      ...repeat(0x4811, 'baseline', [100, 101, 100, 102, 101], (v) => u16(v)),
      ...repeat(0x4811, 'throttle', [150, 151, 150, 152, 151], (v) => u16(v)),
      ...repeat(0x4811, 'brake', [100, 101, 100, 102, 101], (v) => u16(v)),
      ...repeat(0x4811, 'steering', [100, 101, 100, 102, 101], (v) => u16(v)),
    ];
    const [summary] = computeDidCandidateSummaries(samples, MARGIN);
    expect(summary?.phaseEvidence.baseline).not.toBe('changed');
    expect(summary?.phaseEvidence.throttle).toBe('changed');
    expect(summary?.rank).toBe('throttleCandidate');
  });

  it('FIELD SHAPE 0x4522 (297 -> 305 -> 295 idle noise) does NOT rank as changed even with a full sample budget', () => {
    const samples = [
      ...repeat(0x4522, 'baseline', [297, 305, 295, 299, 301], (v) => u16(v)),
      ...repeat(0x4522, 'brake', [297, 305, 295, 300, 298], (v) => u16(v)),
      ...repeat(0x4522, 'steering', [296, 304, 297, 299, 302], (v) => u16(v)),
      ...repeat(0x4522, 'throttle', [298, 303, 296, 300, 299], (v) => u16(v)),
    ];
    const [summary] = computeDidCandidateSummaries(samples, MARGIN);
    expect(summary?.phaseEvidence.brake).toBe('unchanged');
    expect(summary?.rank).toBe('static');
  });

  it('FIELD SHAPE 0x4522 under-sampled (1 baseline / 2 brake samples, exactly as the field export recorded) reports `insufficient` — never a naive-distinctness "changed"', () => {
    const samples = [
      sample(0x4522, 'baseline', 8030, u16(297)),
      sample(0x4522, 'brake', 4221, u16(305)),
      sample(0x4522, 'brake', 16782, u16(295)),
      sample(0x4522, 'throttle', 12346, u16(0)),
    ];
    const [summary] = computeDidCandidateSummaries(samples, MARGIN);
    expect(summary?.phaseEvidence.baseline).toBe('insufficient');
    expect(summary?.phaseEvidence.brake).toBe('insufficient');
    expect(summary?.changedInPhase.brake).toBe(false);
    // Ticket P4j-FIX2 V1 (binding, after Codex P4j-REV2 HIGH #1 PARTIAL):
    // `insufficient` in ANY phase now excludes the WHOLE DID from ranking --
    // never `static` (which used to read as "measured, and found unchanging").
    expect(summary?.rank).toBe('insufficient');
  });

  it('3-byte and 4-byte values decode numerically (u24/u32) instead of falling back to byte distinctness', () => {
    const three = [
      ...repeat(0x4536, 'baseline', [0, 0, 0, 0, 0], (v) => [0x00, 0x00, v]),
      ...repeat(0x4536, 'brake', [200, 201, 200, 202, 201], (v) => [0x00, 0x00, v]),
    ];
    const [threeSummary] = computeDidCandidateSummaries(three, MARGIN);
    expect(threeSummary?.phaseEvidence.brake).toBe('changed');

    const four = [
      ...repeat(0x4537, 'baseline', [10, 11, 10, 12, 11], (v) => [0x00, 0x00, 0x00, v]),
      ...repeat(0x4537, 'brake', [10, 11, 10, 12, 11], (v) => [0x00, 0x00, 0x00, v]),
    ];
    const [fourSummary] = computeDidCandidateSummaries(four, MARGIN);
    expect(fourSummary?.phaseEvidence.brake).toBe('unchanged');
  });

  it('5-8 byte values are compared BYTE-WISE (a level shift at any single offset is a change)', () => {
    const flat = (b5: number): number[] => [0, 0, 0, 0, 0, b5];
    const samples = [
      ...repeat(0x4520, 'baseline', [0, 0, 0, 0, 0], (v) => flat(v)),
      ...repeat(0x4520, 'steering', [90, 91, 90, 92, 91], (v) => flat(v)),
      ...repeat(0x4520, 'brake', [0, 0, 0, 0, 0], (v) => flat(v)),
      ...repeat(0x4520, 'throttle', [0, 0, 0, 0, 0], (v) => flat(v)),
    ];
    const [summary] = computeDidCandidateSummaries(samples, MARGIN);
    expect(summary?.phaseEvidence.steering).toBe('changed');
    expect(summary?.rank).toBe('steeringCandidate');
  });

  it('a DID whose samples disagree on LENGTH is marked inconsistent and never ranked as a candidate (M3)', () => {
    const samples = [
      ...repeat(0x4659, 'baseline', [1, 2, 3, 4, 5], (v) => [v]),
      ...repeat(0x4659, 'brake', [200, 201, 202, 203, 204], (v) => [0x00, v]),
    ];
    const [summary] = computeDidCandidateSummaries(samples, MARGIN);
    expect(summary?.lengthConsistent).toBe(false);
    expect(summary?.phaseEvidence.brake).toBe('insufficient');
    // Ticket P4j-FIX2 V1 (binding): a length-inconsistent DID has NO usable
    // evidence in any phase (baseline itself is `insufficient` too) -- ranked
    // `insufficient`, never `static`.
    expect(summary?.rank).toBe('insufficient');
  });

  it('legacy callers (no `useMarginRule`) keep the pre-ticket naive distinctness AND never see `insufficient`', () => {
    const samples = [
      sample(0x1111, 'baseline', 0, [0x01]),
      sample(0x1111, 'brake', 0, [0x01]),
      sample(0x1111, 'brake', 10, [0x02]),
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.changedInPhase.brake).toBe(true);
    expect(Object.values(summary?.phaseEvidence ?? {})).not.toContain('insufficient');
  });
});

describe('computeDidBlockCandidateSummaries — P4j-FIX1 H2 (binding): the same rule for block offsets', () => {
  function blk(len: number, offset: number, value: number): number[] {
    const out = new Array<number>(len).fill(0);
    out[offset] = value;
    return out;
  }

  it('a 0 -> 1 switch at ONE offset is a changed offset (the pre-fix per-offset range rule missed it)', () => {
    const samples: DidPhaseSample[] = [];
    for (let i = 0; i < 5; i += 1) samples.push(sample(0x40b6, 'baseline', i * 10, blk(10, 4, 0)));
    for (let i = 0; i < 5; i += 1) samples.push(sample(0x40b6, 'brake', i * 10, blk(10, 4, 1)));
    const [summary] = computeDidBlockCandidateSummaries(samples, { minSamplesPerPhase: 5 });
    expect(summary?.changedOffsetsByPhase.brake).toEqual([4]);
    expect(summary?.phaseEvidence.brake).toBe('changed');
  });

  it('an under-sampled phase reports `insufficient`, not "unchanged"', () => {
    const samples: DidPhaseSample[] = [
      sample(0x40b7, 'baseline', 0, blk(10, 4, 0)),
      sample(0x40b7, 'brake', 0, blk(10, 4, 1)),
    ];
    const [summary] = computeDidBlockCandidateSummaries(samples, { minSamplesPerPhase: 5 });
    expect(summary?.phaseEvidence.brake).toBe('insufficient');
    expect(summary?.changedOffsetsByPhase.brake).toEqual([]);
  });
});
