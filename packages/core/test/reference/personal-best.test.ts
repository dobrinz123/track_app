import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { LapRecord, ReferenceLap } from '../../src/contracts';
import { shouldReplacePb, type PersonalBestCandidate } from '../../src/reference';

function reference(durationMs = 90_000, overrides: Partial<ReferenceLap> = {}): ReferenceLap {
  return {
    circuitId: 'circuit-1',
    layoutId: 'layout-1',
    layoutVersion: 1,
    userId: 'driver-1',
    durationMs,
    sectorTimes: [{ sectorIndex: 0, durationMs, quality: 'good' }],
    recordedAtUtc: '2026-08-01T12:00:00.000Z',
    sessionId: 'session-1',
    lapNumber: 1,
    distanceGridM: [0, 1_000],
    elapsedMsAtGrid: [0, durationMs],
    gnssQualitySummary: { level: 'good', reasons: [] },
    appVersion: '1.2.3',
    algorithmVersion: 2,
    profileSchemaVersion: 1,
    ...overrides,
  };
}

function lap(durationMs = 90_000, overrides: Partial<LapRecord> = {}): LapRecord {
  return {
    lapNumber: 1,
    tStart: 0,
    tEnd: durationMs,
    durationMs,
    sectorTimes: [{ sectorIndex: 0, durationMs, quality: 'good' }],
    valid: true,
    invalidReasons: [],
    quality: 'good',
    ...overrides,
  };
}

function candidate(
  durationMs = 90_000,
  overrides: Partial<PersonalBestCandidate> = {},
): PersonalBestCandidate {
  return {
    reference: reference(durationMs),
    lap: lap(durationMs),
    fullTelemetry: true,
    ...overrides,
  };
}

describe('shouldReplacePb', () => {
  it('accepts a valid full-telemetry first PB and a strictly faster same-layout PB', () => {
    expect(shouldReplacePb(null, candidate())).toBe(true);
    expect(shouldReplacePb(reference(90_000), candidate(89_999))).toBe(true);
  });

  it.each([
    ['circuitId', { circuitId: 'other-circuit' }],
    ['layoutId', { layoutId: 'other-layout' }],
    ['layoutVersion', { layoutVersion: 2 }],
  ] as const)('rejects a mismatched %s', (_field, referenceOverride) => {
    expect(
      shouldReplacePb(
        reference(100_000),
        candidate(90_000, { reference: reference(90_000, referenceOverride) }),
      ),
    ).toBe(false);
  });

  it('rejects an invalid source lap', () => {
    expect(
      shouldReplacePb(null, candidate(90_000, { lap: lap(90_000, { valid: false }) })),
    ).toBe(false);
  });

  it.each(['unreliable', 'invalid'] as const)('rejects %s source quality', (quality) => {
    expect(
      shouldReplacePb(null, candidate(90_000, { lap: lap(90_000, { quality }) })),
    ).toBe(false);
  });

  it('rejects pit transit even if the source is marked valid', () => {
    expect(
      shouldReplacePb(
        null,
        candidate(90_000, { lap: lap(90_000, { invalidReasons: ['PIT_TRANSIT'] }) }),
      ),
    ).toBe(false);
  });

  it.each([
    [[]],
    [[
      { sectorIndex: 1, durationMs: 45_000, quality: 'good' as const },
      { sectorIndex: 0, durationMs: 45_000, quality: 'good' as const },
    ]],
    [[{ sectorIndex: 0, durationMs: 80_000, quality: 'good' as const }]],
  ])('rejects incomplete or unordered sectors', (sectorTimes) => {
    expect(
      shouldReplacePb(null, candidate(90_000, { lap: lap(90_000, { sectorTimes }) })),
    ).toBe(false);
  });

  it.each([90_000, 91_000])('rejects a non-faster duration of %i ms', (durationMs) => {
    expect(shouldReplacePb(reference(90_000), candidate(durationMs))).toBe(false);
  });

  it('rejects absent or structurally incomplete full telemetry', () => {
    expect(shouldReplacePb(null, candidate(90_000, { fullTelemetry: false }))).toBe(false);
    expect(
      shouldReplacePb(
        null,
        candidate(90_000, {
          reference: reference(90_000, { elapsedMsAtGrid: [0] }),
        }),
      ),
    ).toBe(false);
  });

  it('rejects missing mandatory provenance', () => {
    expect(
      shouldReplacePb(
        null,
        candidate(90_000, { reference: reference(90_000, { sessionId: '' }) }),
      ),
    ).toBe(false);
  });

  it('keeps accepted PB durations monotonically non-increasing for any candidate sequence', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 60_000, max: 180_000 }), {
          minLength: 1,
          maxLength: 100,
        }),
        (durations) => {
          let current: ReferenceLap | null = null;
          const accepted: number[] = [];
          for (const durationMs of durations) {
            const next = candidate(durationMs);
            if (shouldReplacePb(current, next)) {
              current = next.reference;
              accepted.push(durationMs);
            }
          }
          for (let index = 1; index < accepted.length; index += 1) {
            expect(accepted[index]).toBeLessThan(accepted[index - 1] ?? Number.POSITIVE_INFINITY);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
