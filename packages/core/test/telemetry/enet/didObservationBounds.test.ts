import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH_SIZE,
  MAX_FOCUSED_SHORTLIST_SIZE,
  MAX_MIN_SAMPLES_PER_PHASE,
  planObservationBatches,
} from '../../../src/telemetry/enet/didObservationBatches';
import { orderChangingCandidatesFirst, type DidChangeSamplePair } from '../../../src/telemetry/enet/didCandidates';

/**
 * Ticket P4j-FIX1 M1 (binding, after Codex P4j-REV1 MEDIUM #1): hard bounds --
 * `batchSize <= 16`, `minSamplesPerPhase <= 20`, focused shortlist <= 16.
 * Plus the coordinator's binding pre-pass addendum: the two-sample
 * changing-value pre-pass is ADVISORY ONLY (it may ORDER candidates
 * changed-first, but must never EXCLUDE one from the guided phases -- field
 * evidence: 0x4A1D / 0x4811 / 0x4812 answered the sweep but were dropped by
 * the pre-pass because the user did not press the brake during it).
 */
describe('planObservationBatches — P4j-FIX1 M1 hard bounds (binding)', () => {
  const candidates = Array.from({ length: 128 }, (_, i) => 0x4000 + i);

  it('caps batchSize at 16 (a caller asking for 128 still gets 16-DID batches)', () => {
    expect(MAX_BATCH_SIZE).toBe(16);
    const batches = planObservationBatches(candidates, { batchSize: 128, measuredReqPerSec: 9 });
    expect(batches).toHaveLength(8);
    for (const batch of batches) expect(batch.dids.length).toBeLessThanOrEqual(16);
  });

  it('caps minSamplesPerPhase at 20 (an absurd value can no longer create an effectively infinite phase)', () => {
    expect(MAX_MIN_SAMPLES_PER_PHASE).toBe(20);
    const capped = planObservationBatches(candidates, { minSamplesPerPhase: 100_000, measuredReqPerSec: 9 });
    const atCap = planObservationBatches(candidates, { minSamplesPerPhase: MAX_MIN_SAMPLES_PER_PHASE, measuredReqPerSec: 9 });
    expect(capped[0]?.phaseDurationMs).toBe(atCap[0]?.phaseDurationMs);
  });

  it('exposes the focused-shortlist bound the controller/screen enforce', () => {
    expect(MAX_FOCUSED_SHORTLIST_SIZE).toBe(16);
  });
});

describe('orderChangingCandidatesFirst — pre-pass is ADVISORY (binding, coordinator addendum)', () => {
  const bytes = (values: number[]): Uint8Array => Uint8Array.from(values);

  it('returns EVERY candidate (nothing is ever excluded), with the changed ones first', () => {
    const all = [0x4a1d, 0x4811, 0x4812, 0x4522];
    const pairs: DidChangeSamplePair[] = [
      { did: 0x4a1d, first: bytes([0x00]), second: bytes([0x00]) }, // static during the pre-pass (user did not brake).
      { did: 0x4811, first: bytes([0x00]), second: bytes([0x00]) },
      { did: 0x4522, first: bytes([0x01, 0x29]), second: bytes([0x01, 0x31]) }, // changed.
    ];
    const ordered = orderChangingCandidatesFirst(pairs, all);
    expect([...ordered].sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));
    expect(ordered[0]).toBe(0x4522);
    expect(ordered).toContain(0x4812); // never even sampled by the pre-pass -- still observed.
  });

  it('preserves the original relative order within each group (deterministic)', () => {
    const all = [1, 2, 3, 4];
    const pairs: DidChangeSamplePair[] = [
      { did: 2, first: bytes([0]), second: bytes([1]) },
      { did: 4, first: bytes([0]), second: bytes([1]) },
    ];
    expect(orderChangingCandidatesFirst(pairs, all)).toEqual([2, 4, 1, 3]);
  });
});
