import { describe, expect, it } from 'vitest';

import { buildDemonstratedEnvelope, ENVELOPE_APPROACH_EXCLUDING_FLAGS } from '../../src/coaching';
import type { CleanLapMetrics, CornerMetrics } from '../../src/coaching';
import { CORNER_ANALYSIS_VERSION } from '../../src/contracts';

function metric(overrides: Partial<CornerMetrics> & { cornerId: number }): CornerMetrics {
  return {
    analysisVersion: CORNER_ANALYSIS_VERSION,
    liftPointM: 260,
    liftSource: 'decelOnset',
    brakeStartM: 200,
    brakeSource: 'gpsSpeed',
    peakDecelG: 0.9,
    minSpeedKph: 70,
    minSpeedPositionM: 640,
    entrySpeedKph: 120,
    exitSpeedKph: 90,
    maxLatG: 1.1,
    maxLatGSource: 'imu',
    sectorMs: 3_000,
    sampleCount: 30,
    quality: { ok: true, flags: [], worstAccuracyM: 4, maxSampleGapMs: 250 },
    minSpeedVsApexM: 5,
    throttleOnM: 12,
    throttleOnSource: 'accelPedalPct',
    fullThrottleFraction: 0.4,
    frictionCircleMaxG: 1.2,
    turnInM: 20,
    turnInSource: null,
    steeringSmoothness: null,
    steeringCorrections: null,
    ...overrides,
  };
}

function lap(lapNumber: number, corners: CornerMetrics[]): CleanLapMetrics {
  return { lapNumber, corners };
}

describe('buildDemonstratedEnvelope', () => {
  const laps: CleanLapMetrics[] = [
    lap(1, [metric({ cornerId: 1, brakeStartM: 200, liftPointM: 280, minSpeedKph: 70 })]),
    lap(2, [metric({ cornerId: 1, brakeStartM: 170, liftPointM: 250, minSpeedKph: 76 })]),
    lap(3, [metric({ cornerId: 1, brakeStartM: 185, liftPointM: 265, minSpeedKph: 73 })]),
  ];

  it('takes the LATEST demonstrated braking point (the smallest distance before the corner)', () => {
    const envelope = buildDemonstratedEnvelope(laps);
    const corner = envelope.corners[0];
    expect(corner?.latestBrakeStartM).toBe(170);
    expect(corner?.latestBrakeStartLapNumber).toBe(2);
    expect(corner?.earliestBrakeStartM).toBe(200);
  });

  it('takes the HIGHEST demonstrated minimum corner speed with its lap id', () => {
    const corner = buildDemonstratedEnvelope(laps).corners[0];
    expect(corner?.highestMinSpeedKph).toBe(76);
    expect(corner?.highestMinSpeedLapNumber).toBe(2);
  });

  it('takes the EARLIEST demonstrated lift (largest distance before the corner) and the latest one', () => {
    const corner = buildDemonstratedEnvelope(laps).corners[0];
    expect(corner?.earliestLiftM).toBe(280);
    expect(corner?.earliestLiftLapNumber).toBe(1);
    expect(corner?.latestLiftM).toBe(250);
  });

  it('records the driver’s own evidence lap ids and the lower median baseline', () => {
    const envelope = buildDemonstratedEnvelope(laps);
    const corner = envelope.corners[0];
    expect(envelope.cleanLapIds).toEqual([1, 2, 3]);
    expect(envelope.cleanLapCount).toBe(3);
    expect(corner?.evidenceLapIds).toEqual([1, 2, 3]);
    expect(corner?.medianBrakeStartM).toBe(185);
    expect(corner?.medianMinSpeedKph).toBe(73);
    expect(corner?.medianLiftM).toBe(265);
  });

  it('EXCLUDES approach metrics whose quality flags make them unsafe as a bound', () => {
    expect(ENVELOPE_APPROACH_EXCLUDING_FLAGS).toContain('APPROACH_TRUNCATED');
    const withTruncated = [
      ...laps,
      lap(4, [
        metric({
          cornerId: 1,
          brakeStartM: 20,
          quality: {
            ok: false,
            flags: ['APPROACH_TRUNCATED'],
            worstAccuracyM: 4,
            maxSampleGapMs: 250,
          },
        }),
      ]),
    ];
    const corner = buildDemonstratedEnvelope(withTruncated).corners[0];
    // 20 m would be a wildly permissive "latest braking point"; it must not count.
    expect(corner?.latestBrakeStartM).toBe(170);
    expect(corner?.evidenceLapIds).toEqual([1, 2, 3]);
  });

  it('excludes in-corner metrics measured over a truncated or GNSS-poor window', () => {
    const polluted = [
      lap(1, [metric({ cornerId: 1, minSpeedKph: 70 })]),
      lap(
        2,
        [
          metric({
            cornerId: 1,
            minSpeedKph: 300,
            quality: {
              ok: false,
              flags: ['GNSS_ACCURACY_POOR'],
              worstAccuracyM: 90,
              maxSampleGapMs: 250,
            },
          }),
        ],
      ),
    ];
    expect(buildDemonstratedEnvelope(polluted).corners[0]?.highestMinSpeedKph).toBe(70);
  });

  it('returns null bounds (never a fabricated one) for a corner with no usable evidence', () => {
    const corner = buildDemonstratedEnvelope([
      lap(1, [metric({ cornerId: 9, brakeStartM: null, liftPointM: null, minSpeedKph: null })]),
    ]).corners[0];
    expect(corner?.cornerId).toBe(9);
    expect(corner?.latestBrakeStartM).toBeNull();
    expect(corner?.highestMinSpeedKph).toBeNull();
    expect(corner?.earliestLiftM).toBeNull();
    expect(corner?.evidenceLapIds).toEqual([]);
  });

  it('orders corners by id and is deterministic regardless of input lap order', () => {
    const shuffled = [laps[2], laps[0], laps[1]].filter(
      (entry): entry is CleanLapMetrics => entry !== undefined,
    );
    expect(JSON.stringify(buildDemonstratedEnvelope(shuffled))).toEqual(
      JSON.stringify(buildDemonstratedEnvelope(laps)),
    );
  });

  it('refuses duplicate lap numbers and mixed corner-analysis versions', () => {
    expect(() => buildDemonstratedEnvelope([lap(1, []), lap(1, [])])).toThrow(RangeError);
    expect(() =>
      buildDemonstratedEnvelope([
        lap(1, [metric({ cornerId: 1 })]),
        lap(2, [metric({ cornerId: 1, analysisVersion: CORNER_ANALYSIS_VERSION + 1 })]),
      ]),
    ).toThrow(RangeError);
  });

  it('is empty, not throwing, when there are no clean laps at all', () => {
    const envelope = buildDemonstratedEnvelope([]);
    expect(envelope.corners).toEqual([]);
    expect(envelope.cleanLapCount).toBe(0);
    expect(envelope.analysisVersion).toBe(CORNER_ANALYSIS_VERSION);
  });
});
