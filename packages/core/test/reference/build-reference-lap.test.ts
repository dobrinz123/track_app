import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { LapRecord } from '../../src/contracts';
import { makeTestProfile } from '../../src/profile';
import { buildReferenceLap, type BuildReferenceLapInput } from '../../src/reference';

const profile = makeTestProfile();

function lap(overrides: Partial<LapRecord> = {}): LapRecord {
  return {
    lapNumber: 3,
    tStart: 10_000,
    tEnd: 100_000,
    durationMs: 90_000,
    sectorTimes: [
      { sectorIndex: 0, durationMs: 30_000, quality: 'good' },
      { sectorIndex: 1, durationMs: 30_000, quality: 'good' },
      { sectorIndex: 2, durationMs: 30_000, quality: 'good' },
    ],
    valid: true,
    invalidReasons: [],
    quality: 'good',
    ...overrides,
  };
}

function input(
  overrides: Partial<BuildReferenceLapInput> = {},
): BuildReferenceLapInput {
  return {
    profile,
    lap: lap(),
    telemetry: [
      { tMono: 10_000, distanceM: 0, quality: { level: 'good', reasons: [] } },
      {
        tMono: 52_000,
        distanceM: profile.totalLengthM * 0.5,
        quality: { level: 'degraded', reasons: ['ACCURACY_ELEVATED'] },
      },
      {
        tMono: 100_000,
        distanceM: profile.totalLengthM,
        quality: { level: 'good', reasons: [] },
      },
    ],
    userId: 'driver-1',
    recordedAtUtc: '2026-08-01T12:00:00.000Z',
    sessionId: 'session-1',
    appVersion: '1.2.3',
    algorithmVersion: 2,
    ...overrides,
  } as BuildReferenceLapInput;
}

describe('buildReferenceLap', () => {
  it('builds a stable grid including zero and the exact track length', () => {
    const result = buildReferenceLap(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.reference.distanceGridM[0]).toBe(0);
    expect(result.reference.distanceGridM[result.reference.distanceGridM.length - 1]).toBe(
      profile.totalLengthM,
    );
    expect(result.reference.elapsedMsAtGrid[0]).toBe(0);
    expect(
      result.reference.elapsedMsAtGrid[result.reference.elapsedMsAtGrid.length - 1],
    ).toBe(90_000);
    expect(result.reference.distanceGridM[1]).toBe(10);
    expect(result.reference.gnssQualitySummary).toEqual({
      level: 'degraded',
      reasons: ['ACCURACY_ELEVATED'],
    });
  });

  it('linearly interpolates sparse irregular telemetry and clamps small progress regressions', () => {
    const total = profile.totalLengthM;
    const result = buildReferenceLap(
      input({
        gridStepM: total / 4,
        telemetry: [
          { tMono: 10_000, unwrappedProgressM: total * 2, quality: 'good' },
          { tMono: 28_000, unwrappedProgressM: total * 2.25, quality: 'good' },
          { tMono: 55_000, unwrappedProgressM: total * 2.49, quality: 'good' },
          { tMono: 56_000, unwrappedProgressM: total * 2.485, quality: 'good' },
          { tMono: 78_000, unwrappedProgressM: total * 2.75, quality: 'good' },
          { tMono: 100_000, unwrappedProgressM: total * 3, quality: 'good' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reference.elapsedMsAtGrid[0]).toBe(0);
    expect(result.reference.elapsedMsAtGrid[1]).toBeCloseTo(18_000, 8);
    expect(result.reference.elapsedMsAtGrid[2]).toBeCloseTo(46_846.153846, 5);
    expect(result.reference.elapsedMsAtGrid[3]).toBeCloseTo(68_000, 8);
    expect(result.reference.elapsedMsAtGrid[4]).toBe(90_000);
  });

  it('rejects invalid laps and telemetry covering less than 95 percent of the grid', () => {
    expect(buildReferenceLap(input({ lap: lap({ valid: false }) }))).toMatchObject({
      ok: false,
      error: 'INVALID_SOURCE_LAP',
    });
    expect(
      buildReferenceLap(
        input({
          telemetry: [
            { tMono: 20_000, distanceM: profile.totalLengthM * 0.1, quality: 'good' },
            { tMono: 90_000, distanceM: profile.totalLengthM * 0.9, quality: 'good' },
          ],
        }),
      ),
    ).toMatchObject({ ok: false, error: 'INSUFFICIENT_COVERAGE' });
  });

  it('always emits non-decreasing elapsed values despite random small regressions', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -8, max: 8 }), { minLength: 5, maxLength: 100 }),
        (jitter) => {
          const total = profile.totalLengthM;
          const interior = jitter.map((offset, index) => ({
            tMono: 10_000 + ((index + 1) / (jitter.length + 1)) * 90_000,
            distanceM: ((index + 1) / (jitter.length + 1)) * total + offset,
            quality: 'good' as const,
          }));
          const result = buildReferenceLap(
            input({
              telemetry: [
                { tMono: 10_000, distanceM: 0, quality: 'good' },
                ...interior,
                { tMono: 100_000, distanceM: total, quality: 'good' },
              ],
            }),
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          for (let index = 1; index < result.reference.elapsedMsAtGrid.length; index += 1) {
            expect(result.reference.elapsedMsAtGrid[index]).toBeGreaterThanOrEqual(
              result.reference.elapsedMsAtGrid[index - 1] ?? 0,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
