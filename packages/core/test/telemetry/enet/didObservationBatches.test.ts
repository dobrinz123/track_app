import { describe, expect, it } from 'vitest';
import { ASSUMED_GUIDED_REQ_PER_SEC } from '../../../src/telemetry/enet/didObservationPhases';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MIN_SAMPLES_PER_PHASE,
  planObservationBatches,
} from '../../../src/telemetry/enet/didObservationBatches';

function range(count: number, start = 0x4000): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

/**
 * DID sweep — batched guided observation (ticket P4j, binding). Field
 * evidence (`data/field/sweeps/2026-08-29-supra-dme12-0x4000-0x4FFF.json`):
 * 128 short/plausible candidates, ~9 req/s measured over the whole set --
 * the old fixed 17s-per-phase gave each DID only 1-2 samples. Batching into
 * fixed-size groups of 16 and sizing the phase duration from the MEASURED
 * rate is the fix.
 */
describe('planObservationBatches (ticket P4j, binding)', () => {
  it('128 candidates at 9 req/s, default batchSize/minSamplesPerPhase -> 8 batches of 16, each phase sized for >= 5 samples/DID at the measured rate', () => {
    const batches = planObservationBatches(range(128), { measuredReqPerSec: 9 });
    expect(batches).toHaveLength(8);
    expect(batches.every((b) => b.dids.length === 16)).toBe(true);
    expect(batches.every((b) => b.total === 8)).toBe(true);
    expect(batches.map((b) => b.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // ceil(5 * 16 / 9 * 1000) -- every DID in a 16-candidate batch gets >= 5 samples/phase at 9 req/s.
    const expectedPhaseDurationMs = Math.ceil((5 * 16) / 9 * 1_000);
    expect(batches.every((b) => b.phaseDurationMs === expectedPhaseDurationMs)).toBe(true);
    expect(batches.every((b) => b.phaseDurationMs > 6_000)).toBe(true); // well beyond the fixed ~6s floor.
  });

  it('the batches partition the candidates in order -- concatenating every batch\'s dids reproduces the input exactly', () => {
    const candidates = range(128);
    const batches = planObservationBatches(candidates, { measuredReqPerSec: 9 });
    expect(batches.flatMap((b) => b.dids)).toEqual(candidates);
  });

  it('an uneven candidate count leaves a smaller final batch (never dropped, never padded)', () => {
    const batches = planObservationBatches(range(20), { measuredReqPerSec: 9 });
    expect(batches).toHaveLength(2);
    expect(batches[0]?.dids).toHaveLength(16);
    expect(batches[1]?.dids).toHaveLength(4);
    expect(batches[1]?.total).toBe(2);
  });

  it('a custom batchSize/minSamplesPerPhase is honored', () => {
    const batches = planObservationBatches(range(30), { measuredReqPerSec: 9, batchSize: 10, minSamplesPerPhase: 8 });
    expect(batches).toHaveLength(3);
    expect(batches.every((b) => b.dids.length === 10)).toBe(true);
    // ceil(8 * 10 / 9 * 1000) = 8889, comfortably above the fixed ~6s floor -- a genuine assertion on the scaling, not the floor.
    expect(batches[0]?.phaseDurationMs).toBe(Math.ceil((8 * 10) / 9 * 1_000));
    expect(batches[0]?.phaseDurationMs).toBeGreaterThan(6_000);
  });

  it('exposes its own defaults as named constants (batchSize=16, minSamplesPerPhase=5)', () => {
    expect(DEFAULT_BATCH_SIZE).toBe(16);
    expect(DEFAULT_MIN_SAMPLES_PER_PHASE).toBe(5);
  });

  it('a non-finite/non-positive measuredReqPerSec falls back to ASSUMED_GUIDED_REQ_PER_SEC rather than dividing by zero/NaN', () => {
    const viaFallback = planObservationBatches(range(16), { measuredReqPerSec: 0 });
    const viaExplicitAssumed = planObservationBatches(range(16), { measuredReqPerSec: ASSUMED_GUIDED_REQ_PER_SEC });
    expect(viaFallback[0]?.phaseDurationMs).toBe(viaExplicitAssumed[0]?.phaseDurationMs);

    const viaNaN = planObservationBatches(range(16), { measuredReqPerSec: Number.NaN });
    expect(viaNaN[0]?.phaseDurationMs).toBe(viaExplicitAssumed[0]?.phaseDurationMs);
  });

  it('a non-finite/zero batchSize falls back to the default batch size', () => {
    const batches = planObservationBatches(range(32), { measuredReqPerSec: 9, batchSize: 0 });
    expect(batches).toHaveLength(2);
    expect(batches[0]?.dids).toHaveLength(16);
  });

  it('an empty candidate list returns no batches', () => {
    expect(planObservationBatches([], { measuredReqPerSec: 9 })).toEqual([]);
  });

  it('a single candidate still produces exactly one batch, phase duration never below the fixed ~6s floor', () => {
    const batches = planObservationBatches([0x4522], { measuredReqPerSec: 9 });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.dids).toEqual([0x4522]);
    expect(batches[0]?.phaseDurationMs).toBeGreaterThanOrEqual(6_000);
  });
});
