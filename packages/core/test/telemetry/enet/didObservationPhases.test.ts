import { describe, expect, it } from 'vitest';
import {
  computeDidCandidateSummaries,
  DID_OBSERVATION_PHASES,
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
  it('a brake candidate: static at baseline, changed ONLY during brake -> ranked "brakeOrSteeringCandidate"', () => {
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
      rank: 'brakeOrSteeringCandidate',
      changedInPhase: { baseline: false, brake: true, steering: false, throttle: false },
    });
  });

  it('a steering candidate: static at baseline, changed ONLY during steering -> ranked "brakeOrSteeringCandidate"', () => {
    const samples: DidPhaseSample[] = [
      sample(0x2020, 'baseline', 0, [0x80, 0x00]),
      sample(0x2020, 'brake', 0, [0x80, 0x00]),
      sample(0x2020, 'steering', 0, [0x80, 0x00]),
      sample(0x2020, 'steering', 500, [0x40, 0x00]),
      sample(0x2020, 'steering', 1_000, [0xc0, 0x00]),
      sample(0x2020, 'throttle', 0, [0x80, 0x00]),
    ];
    const [summary] = computeDidCandidateSummaries(samples);
    expect(summary?.rank).toBe('brakeOrSteeringCandidate');
    expect(summary?.changedInPhase).toEqual({ baseline: false, brake: false, steering: true, throttle: false });
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

  it('a DID that already changed at baseline (never a clean control) is NEVER "brakeOrSteeringCandidate" even if it also changed in exactly one active phase', () => {
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
    expect(summary?.rank).not.toBe('brakeOrSteeringCandidate');
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

  it('sorts brakeOrSteeringCandidate first, then changedInSeveral, then static -- ties broken by ascending DID', () => {
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
      'brakeOrSteeringCandidate',
      'brakeOrSteeringCandidate',
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
    expect(summaries.find((s) => s.did === 0x1000)?.rank).toBe('brakeOrSteeringCandidate');
    expect(summaries.find((s) => s.did === 0x2000)?.rank).toBe('static');
  });

  it('an empty sample log returns an empty summary list', () => {
    expect(computeDidCandidateSummaries([])).toEqual([]);
  });
});
