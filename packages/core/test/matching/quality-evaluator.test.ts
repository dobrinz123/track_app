import { describe, expect, it } from 'vitest';

import type { LocationSample } from '../../src/contracts';
import { TelemetryQualityEvaluator } from '../../src/matching';

function sample(overrides: Partial<LocationSample> = {}): LocationSample {
  return { tMono: 1_000, lat: 45, lon: 25, accuracyM: 5, source: 'replay', ...overrides };
}

describe('TelemetryQualityEvaluator', () => {
  const evaluator = new TelemetryQualityEvaluator();

  it.each([
    [{ lat: undefined }, 'MISSING_COORDINATES'],
    [{ lat: Number.NaN }, 'NON_FINITE_COORDINATES'],
    [{ accuracyM: 51 }, 'ACCURACY_ABOVE_50M'],
  ] as const)('marks invalid coordinate and accuracy input %o', (overrides, reason) => {
    const result = evaluator.assess(sample(overrides as Partial<LocationSample>));
    expect(result.level).toBe('invalid');
    expect(result.reasons).toContain(reason);
  });

  it('marks duplicate and decreasing monotonic timestamps invalid with every applicable reason', () => {
    const duplicate = evaluator.assess(sample({ tMono: 1_000 }), sample({ tMono: 1_000 }));
    expect(duplicate.level).toBe('invalid');
    expect(duplicate.reasons).toEqual(
      expect.arrayContaining(['DUPLICATE_TIMESTAMP', 'NON_INCREASING_TIMESTAMP']),
    );

    const decreasing = evaluator.assess(sample({ tMono: 999 }), sample({ tMono: 1_000 }));
    expect(decreasing.level).toBe('invalid');
    expect(decreasing.reasons).toContain('NON_INCREASING_TIMESTAMP');
  });

  it('rejects an implied speed above 120 m/s as an impossible jump', () => {
    const result = evaluator.assess(sample({ tMono: 2_000, lat: 45.002 }), sample());
    expect(result.level).toBe('invalid');
    expect(result.reasons).toContain('IMPOSSIBLE_JUMP');
  });

  it.each([
    [sample({ accuracyM: 26 }), undefined, 'ACCURACY_ABOVE_25M'],
    [sample({ tMono: 5_001 }), sample(), 'SAMPLE_GAP_ABOVE_3000MS'],
    [sample({ tMono: 2_000, lat: 45.0008 }), sample(), 'IMPLIED_SPEED_ABOVE_85MPS'],
  ] as const)('marks unreliable input', (current, previous, reason) => {
    const result = evaluator.assess(current, previous);
    expect(result.level).toBe('unreliable');
    expect(result.reasons).toContain(reason);
  });

  it.each([
    [sample({ accuracyM: 13 }), undefined, 'ACCURACY_ABOVE_12M'],
    [sample({ tMono: 2_501 }), sample(), 'SAMPLE_GAP_ABOVE_1500MS'],
  ] as const)('marks degraded input', (current, previous, reason) => {
    const result = evaluator.assess(current, previous);
    expect(result.level).toBe('degraded');
    expect(result.reasons).toContain(reason);
  });

  it('returns good at the thresholds and supports configurable thresholds', () => {
    expect(evaluator.assess(sample({ accuracyM: 12 }), sample({ tMono: 0 }))).toEqual({
      level: 'good',
      reasons: [],
    });
    const strict = new TelemetryQualityEvaluator({ degradedAccuracyM: 4 });
    expect(strict.assess(sample()).level).toBe('degraded');
  });
});
