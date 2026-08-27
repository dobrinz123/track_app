import { describe, expect, it } from 'vitest';

import { channelAvailability, computeCornerMetrics } from '../../src/coaching';
import type { CornerLapSample } from '../../src/coaching';
import { CORNER_ANALYSIS_VERSION, type Corner } from '../../src/contracts';

import {
  SYNTHETIC_CORNER,
  SYNTHETIC_PEAK_DECEL_G,
  SYNTHETIC_TOTAL_LENGTH_M,
  syntheticLap,
} from './syntheticLap';

const OPTIONS = { totalLengthM: SYNTHETIC_TOTAL_LENGTH_M };

function metricsFor(samples: CornerLapSample[], corners: Corner[] = [SYNTHETIC_CORNER]) {
  const result = computeCornerMetrics(samples, corners, OPTIONS);
  const first = result[0];
  if (first === undefined) throw new Error('expected at least one corner metric');
  return first;
}

describe('computeCornerMetrics: GPS-only (tier 0) analytic lap', () => {
  it('finds the braking start 220 m before the corner reference from the GPS speed derivative alone', () => {
    const metric = metricsFor(syntheticLap());
    expect(metric.cornerId).toBe(1);
    expect(metric.analysisVersion).toBe(CORNER_ANALYSIS_VERSION);
    expect(metric.brakeSource).toBe('gpsSpeed');
    expect(metric.brakeStartM).not.toBeNull();
    expect(metric.brakeStartM ?? 0).toBeGreaterThan(212);
    expect(metric.brakeStartM ?? 0).toBeLessThan(228);
  });

  it('reports the lift point from the decel onset (no pedal channel) EARLIER than the braking point', () => {
    const metric = metricsFor(syntheticLap());
    expect(metric.liftSource).toBe('decelOnset');
    expect(metric.liftPointM ?? 0).toBeGreaterThan(252);
    expect(metric.liftPointM ?? 0).toBeLessThan(268);
    expect(metric.liftPointM ?? 0).toBeGreaterThan(metric.brakeStartM ?? 0);
  });

  it('reports the analytic peak deceleration (3 m/s^2 = 0.306 g) as a positive magnitude', () => {
    const metric = metricsFor(syntheticLap());
    expect(metric.peakDecelG ?? 0).toBeGreaterThan(SYNTHETIC_PEAK_DECEL_G - 0.02);
    expect(metric.peakDecelG ?? 0).toBeLessThan(SYNTHETIC_PEAK_DECEL_G + 0.02);
  });

  it('matches a naive independent scan for min speed, its position, entry and exit speed', () => {
    const samples = syntheticLap();
    const metric = metricsFor(samples);
    const inCorner = samples.filter(
      (sample) => sample.distanceM >= 620 && sample.distanceM <= 680,
    );
    const speeds = inCorner.map((sample) => sample.speedKph ?? Number.POSITIVE_INFINITY);
    const naiveMin = Math.min(...speeds);
    const naiveMinIndex = speeds.indexOf(naiveMin);
    expect(metric.minSpeedKph ?? 0).toBeCloseTo(naiveMin, 6);
    expect(metric.minSpeedPositionM ?? 0).toBeCloseTo(
      inCorner[naiveMinIndex]?.distanceM ?? -1,
      6,
    );
    expect(metric.entrySpeedKph ?? 0).toBeCloseTo(inCorner[0]?.speedKph ?? -1, 6);
    expect(metric.exitSpeedKph ?? 0).toBeCloseTo(
      inCorner[inCorner.length - 1]?.speedKph ?? -1,
      6,
    );
    // Power is applied from 660 m, so the car leaves the corner faster than the apex minimum.
    expect(metric.exitSpeedKph ?? 0).toBeGreaterThan(metric.minSpeedKph ?? 0);
  });

  it('reports the in-corner time (sectorMs) as the entry-to-exit elapsed time', () => {
    const samples = syntheticLap();
    const metric = metricsFor(samples);
    const inCorner = samples.filter(
      (sample) => sample.distanceM >= 620 && sample.distanceM <= 680,
    );
    const expected =
      (inCorner[inCorner.length - 1]?.tMonoMs ?? 0) - (inCorner[0]?.tMonoMs ?? 0);
    expect(metric.sectorMs).toBeCloseTo(expected, 6);
    expect(metric.sectorMs ?? 0).toBeGreaterThan(2_000);
  });

  it('leaves latG null with no IMU channel instead of inventing one', () => {
    const metric = metricsFor(syntheticLap());
    expect(metric.maxLatG).toBeNull();
    expect(metric.maxLatGSource).toBeNull();
  });

  it('is deterministic: the same samples produce a byte-identical result', () => {
    const first = computeCornerMetrics(syntheticLap(), [SYNTHETIC_CORNER], OPTIONS);
    const second = computeCornerMetrics(syntheticLap(), [SYNTHETIC_CORNER], OPTIONS);
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });
});

describe('computeCornerMetrics: channel enrichment', () => {
  it('prefers the accelerator PEDAL channel for the lift point and labels the source', () => {
    const metric = metricsFor(syntheticLap({ channels: 'pedal' }));
    expect(metric.liftSource).toBe('accelPedalPct');
    expect(metric.liftPointM ?? 0).toBeGreaterThan(252);
    expect(metric.liftPointM ?? 0).toBeLessThan(268);
  });

  it('falls back to the throttle PLATE channel when no pedal channel is present', () => {
    const metric = metricsFor(syntheticLap({ channels: 'throttlePlate' }));
    expect(metric.liftSource).toBe('throttlePct');
    expect(metric.liftPointM ?? 0).toBeGreaterThan(252);
    expect(metric.liftPointM ?? 0).toBeLessThan(268);
  });

  it('uses IMU longG for braking when present and agrees with the GPS-only answer', () => {
    const gpsOnly = metricsFor(syntheticLap());
    const withImu = metricsFor(syntheticLap({ channels: 'imu' }));
    expect(withImu.brakeSource).toBe('longG');
    expect(withImu.brakeStartM ?? 0).toBeCloseTo(gpsOnly.brakeStartM ?? 0, 3);
  });

  it('reports max lateral G from the IMU channel (v^2/R at the apex ~ 0.41 g)', () => {
    const metric = metricsFor(syntheticLap({ channels: 'imu' }));
    expect(metric.maxLatGSource).toBe('imu');
    expect(metric.maxLatG ?? 0).toBeGreaterThan(0.38);
    expect(metric.maxLatG ?? 0).toBeLessThan(0.46);
  });

  it('honours unsupportedChannels: a declared-unsupported latG is never read', () => {
    const metric = computeCornerMetrics(
      syntheticLap({ channels: 'all' }),
      [SYNTHETIC_CORNER],
      { ...OPTIONS, unsupportedChannels: ['latG', 'accelPedalPct'] },
    )[0];
    expect(metric?.maxLatG).toBeNull();
    expect(metric?.liftSource).toBe('decelOnset');
  });

  it('channelAvailability reports available / unsupported / missing analysis channels', () => {
    const availability = channelAvailability(syntheticLap({ channels: 'all' }), ['throttlePct']);
    expect(availability.available).toContain('latG');
    expect(availability.available).toContain('longG');
    expect(availability.available).toContain('accelPedalPct');
    expect(availability.unsupported).toEqual(['throttlePct']);
    expect(availability.available).not.toContain('throttlePct');
    expect(availability.missing).not.toContain('latG');
  });
});

describe('computeCornerMetrics: quality flags and honesty', () => {
  it('flags poor GNSS accuracy in the corner window', () => {
    const metric = metricsFor(syntheticLap({ accuracyM: 40 }));
    expect(metric.quality.ok).toBe(false);
    expect(metric.quality.flags).toContain('GNSS_ACCURACY_POOR');
    expect(metric.quality.worstAccuracyM ?? 0).toBeGreaterThanOrEqual(40);
  });

  it('flags a sample gap inside the analysis window', () => {
    const samples = syntheticLap();
    const gapped = samples.filter(
      (sample) => !(sample.distanceM > 450 && sample.distanceM < 560),
    );
    const metric = metricsFor(gapped);
    expect(metric.quality.flags).toContain('SAMPLE_GAP');
    expect(metric.quality.maxSampleGapMs ?? 0).toBeGreaterThan(2_500);
  });

  it('flags a truncated approach when the lap starts inside the approach window', () => {
    const samples = syntheticLap().filter((sample) => sample.distanceM > 500);
    const metric = metricsFor(samples);
    expect(metric.quality.flags).toContain('APPROACH_TRUNCATED');
  });

  it('flags no corner coverage and returns nulls when the corner was never sampled', () => {
    const samples = syntheticLap().filter((sample) => sample.distanceM < 600);
    const metric = metricsFor(samples);
    expect(metric.quality.flags).toContain('NO_CORNER_COVERAGE');
    expect(metric.minSpeedKph).toBeNull();
    expect(metric.sectorMs).toBeNull();
  });

  it('handles a corner that wraps the start/finish line without inventing a window', () => {
    const wrapCorner: Corner = {
      ...SYNTHETIC_CORNER,
      id: 2,
      entryDistanceM: 970,
      apexDistanceM: 0,
      exitDistanceM: 30,
      lengthM: 60,
    };
    const metrics = computeCornerMetrics(syntheticLap(), [wrapCorner, SYNTHETIC_CORNER], OPTIONS);
    expect(metrics.map((metric) => metric.cornerId)).toEqual([1, 2]);
    const wrapped = metrics[1];
    expect(wrapped?.cornerId).toBe(2);
    expect(wrapped?.quality.flags).toContain('CORNER_TRUNCATED');
  });

  it('rejects a non-positive totalLengthM and non-finite sample distances', () => {
    expect(() => computeCornerMetrics([], [SYNTHETIC_CORNER], { totalLengthM: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      computeCornerMetrics(
        [{ tMonoMs: 0, distanceM: Number.NaN, speedKph: 10 }],
        [SYNTHETIC_CORNER],
        OPTIONS,
      ),
    ).toThrow(RangeError);
  });

  it('returns one all-null metric per corner (never throws) for an empty lap', () => {
    const metrics = computeCornerMetrics([], [SYNTHETIC_CORNER], OPTIONS);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.brakeStartM).toBeNull();
    expect(metrics[0]?.quality.flags).toContain('NO_CORNER_COVERAGE');
    expect(metrics[0]?.quality.flags).toContain('NO_APPROACH_COVERAGE');
  });
});
