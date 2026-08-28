import { describe, expect, it } from 'vitest';

import { channelAvailability, computeCornerMetrics, cornerWindows, forwardDistance } from '../../src/coaching';
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

/** The same corner, moved so that it straddles the start/finish line. */
const WRAP_CORNER: Corner = Object.freeze({
  ...SYNTHETIC_CORNER,
  id: 2,
  entryDistanceM: 970,
  apexDistanceM: 0,
  exitDistanceM: 30,
  lengthM: 60,
});

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

  it('matches an independent grid scan for min speed, its position, entry and exit speed', () => {
    const samples = syntheticLap();
    const metric = metricsFor(samples);
    // The metrics are measured on the 1 m grid, so the independent check
    // interpolates the raw samples at the same distances.
    const at = (distanceM: number, field: 'speedKph' | 'tMonoMs'): number => {
      const index = samples.findIndex((sample) => sample.distanceM >= distanceM);
      const high = samples[index];
      const low = samples[index - 1];
      if (high === undefined) return Number.NaN;
      if (low === undefined) return high[field] ?? Number.NaN;
      const ratio = (distanceM - low.distanceM) / (high.distanceM - low.distanceM);
      return (low[field] ?? 0) + ((high[field] ?? 0) - (low[field] ?? 0)) * ratio;
    };
    let naiveMin = Number.POSITIVE_INFINITY;
    let naiveMinPosition = -1;
    for (let distanceM = 620; distanceM <= 680; distanceM += 1) {
      const speed = at(distanceM, 'speedKph');
      if (speed < naiveMin) {
        naiveMin = speed;
        naiveMinPosition = distanceM;
      }
    }
    expect(metric.minSpeedKph ?? 0).toBeCloseTo(naiveMin, 6);
    expect(metric.minSpeedPositionM ?? 0).toBeCloseTo(naiveMinPosition, 6);
    expect(metric.entrySpeedKph ?? 0).toBeCloseTo(at(620, 'speedKph'), 6);
    expect(metric.exitSpeedKph ?? 0).toBeCloseTo(at(680, 'speedKph'), 6);
    // Power is applied from 660 m, so the car leaves the corner faster than the apex minimum.
    expect(metric.exitSpeedKph ?? 0).toBeGreaterThan(metric.minSpeedKph ?? 0);
  });

  it('reports the in-corner time (sectorMs) as the entry-to-exit elapsed time', () => {
    const samples = syntheticLap();
    const metric = metricsFor(samples);
    const at = (distanceM: number): number => {
      const index = samples.findIndex((sample) => sample.distanceM >= distanceM);
      const high = samples[index];
      const low = samples[index - 1];
      if (high === undefined) return Number.NaN;
      if (low === undefined) return high.tMonoMs;
      const ratio = (distanceM - low.distanceM) / (high.distanceM - low.distanceM);
      return low.tMonoMs + (high.tMonoMs - low.tMonoMs) * ratio;
    };
    // Entry-to-exit, taken AT 620 m and 680 m rather than at the first and last
    // raw sample that happened to fall inside the corner.
    expect(metric.sectorMs ?? 0).toBeCloseTo(at(680) - at(620), 1);
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
    // Two different estimators of the same event: they must agree to a few
    // metres, not bit-for-bit.
    expect(Math.abs((withImu.brakeStartM ?? 0) - (gpsOnly.brakeStartM ?? 0))).toBeLessThan(4);
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

  it('JOINS a corner that wraps the start/finish line instead of truncating it (H3)', () => {
    const metrics = computeCornerMetrics(syntheticLap(), [WRAP_CORNER, SYNTHETIC_CORNER], OPTIONS);
    expect(metrics.map((metric) => metric.cornerId)).toEqual([1, 2]);
    const wrapped = metrics[1];
    expect(wrapped?.cornerId).toBe(2);
    // The end-of-array run (970-999 m) and the start-of-array run (0-30 m) are
    // the two halves of ONE pass through the window: the corner is measured
    // over both, so nothing is truncated.
    expect(wrapped?.quality.flags).not.toContain('CORNER_TRUNCATED');
    expect(wrapped?.quality.flags).not.toContain('NO_CORNER_COVERAGE');
    // 60 m of corner: ~30 m at 28.6 m/s before the line, ~30 m at 40 m/s after.
    expect(wrapped?.sectorMs ?? 0).toBeGreaterThan(1_600);
    expect(wrapped?.sectorMs ?? 0).toBeLessThan(1_950);
    // Both halves are measured, so the minimum is the pre-line speed, not the
    // 144 km/h of the post-line half alone.
    expect(wrapped?.minSpeedKph ?? 0).toBeGreaterThan(90);
    expect(wrapped?.minSpeedKph ?? 0).toBeLessThan(110);
    expect(wrapped?.exitSpeedKph ?? 0).toBeGreaterThan(140);
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

describe('computeCornerMetrics: the 1 m analysis grid (H1)', () => {
  const ENTRY_M = SYNTHETIC_CORNER.entryDistanceM;

  it('resolves the braking point on the 1 m grid, not on the 40 m raw-sample lattice', () => {
    const samples = syntheticLap({ sampleRateHz: 1 });
    // At 1 Hz and 40 m/s the raw samples through the braking zone are >20 m apart.
    const braking = samples.filter((sample) => sample.distanceM > 380 && sample.distanceM < 620);
    const spacings = braking
      .slice(1)
      .map((sample, index) => sample.distanceM - (braking[index]?.distanceM ?? 0));
    expect(Math.min(...spacings)).toBeGreaterThan(20);

    const metric = metricsFor(samples);
    expect(metric.brakeStartM).not.toBeNull();
    const onsetM = ENTRY_M - (metric.brakeStartM ?? 0);
    // Grid-resolved: the reported onset sits on a 1 m grid point, so its
    // resolution is 1 m -- not the position of whichever raw sample happened
    // to be recorded (437.6 m on this drive).
    expect(Math.abs(onsetM - Math.round(onsetM))).toBeLessThan(0.01);
    expect(Math.abs(onsetM - 437.6)).toBeGreaterThan(0.1);
  });

  it('takes the corner time between the real entry and exit distances at 1 Hz', () => {
    const metric = metricsFor(syntheticLap({ sampleRateHz: 1 }));
    // Only three raw samples land inside the 60 m corner, so a raw-sample
    // sector time reports ~2.0 s; on the grid the true entry-to-exit time is
    // ~2.88 s (interpolated at exactly 620 m and 680 m).
    expect(metric.sectorMs ?? 0).toBeGreaterThan(2_700);
    expect(metric.sectorMs ?? 0).toBeLessThan(3_050);
  });

  it('reads the exit speed AT the exit distance rather than at the last raw sample', () => {
    const metric = metricsFor(syntheticLap({ sampleRateHz: 1 }));
    // Raw: the last in-corner sample sits at 666 m and still reads 73.4 km/h.
    // Grid: 680 m is already 14 m into the power-down, ~77.9 km/h.
    expect(metric.exitSpeedKph ?? 0).toBeGreaterThan(76);
    expect(metric.exitSpeedKph ?? 0).toBeLessThan(80);
  });

  it('agrees between 10 Hz and 1 Hz on the min-speed position to within 2 m', () => {
    const fast = metricsFor(syntheticLap({ sampleRateHz: 10 }));
    const slow = metricsFor(syntheticLap({ sampleRateHz: 1 }));
    expect(slow.minSpeedPositionM).not.toBeNull();
    expect(Math.abs((slow.minSpeedPositionM ?? 0) - (fast.minSpeedPositionM ?? 0))).toBeLessThan(2);
  });
});

describe('cornerWindows: L_b / L_e derived from the corner speed drop (H4)', () => {
  const L = SYNTHETIC_TOTAL_LENGTH_M;

  it('opens a long approach for a big speed drop after a long straight', () => {
    const windows = cornerWindows(SYNTHETIC_CORNER, [SYNTHETIC_CORNER], OPTIONS);
    const approachM = forwardDistance(windows.approachStartM, windows.entryM, L);
    expect(approachM).toBeGreaterThanOrEqual(360);
  });

  it('keeps the approach short for a kink that barely slows the car', () => {
    const previous: Corner = {
      ...SYNTHETIC_CORNER,
      id: 1,
      entryDistanceM: 240,
      apexDistanceM: 270,
      exitDistanceM: 300,
      advisorySpeedKph: 100,
    };
    const kink: Corner = {
      ...SYNTHETIC_CORNER,
      id: 2,
      entryDistanceM: 500,
      apexDistanceM: 520,
      exitDistanceM: 540,
      advisorySpeedKph: 190,
      severity: 1,
    };
    const windows = cornerWindows(kink, [previous, kink], OPTIONS);
    const approachM = forwardDistance(windows.approachStartM, windows.entryM, L);
    expect(approachM).toBeLessThan(120);
    expect(approachM).toBeGreaterThan(0);
  });

  it('observes a brake onset 360 m before the corner', () => {
    const samples = syntheticLap({
      accelAt: (distanceM) => {
        if (distanceM < 260) return 0;
        if (distanceM < 600) return -2;
        if (distanceM < 660) return 0;
        if (distanceM < 760) return 2;
        return 0;
      },
    });
    const metric = metricsFor(samples);
    expect(metric.brakeStartM ?? 0).toBeGreaterThan(350);
    expect(metric.brakeStartM ?? 0).toBeLessThan(372);
  });
});

describe('computeCornerMetrics: tier-1 throttle-on and full throttle (H8)', () => {
  it('never reports throttle-on before the minimum speed', () => {
    // The driver is already at 30 % pedal at the apex but the car keeps
    // slowing for another 20 m: throttle-on belongs AFTER the minimum speed.
    const samples = syntheticLap({
      channels: 'pedal',
      pedalAt: (distanceM) => (distanceM < 360 ? 90 : distanceM < 640 ? 0 : 30),
      accelAt: (distanceM) => {
        if (distanceM < 360) return 0;
        if (distanceM < 400) return -0.8;
        if (distanceM < 600) return -3;
        // The car is still slowing 20 m past the apex.
        if (distanceM < 670) return -0.5;
        if (distanceM < 780) return 2;
        return 0;
      },
    });
    const metric = metricsFor(samples);
    expect(metric.throttleOnSource).toBe('accelPedalPct');
    expect(metric.minSpeedVsApexM).not.toBeNull();
    expect(metric.throttleOnM).not.toBeNull();
    expect(metric.throttleOnM ?? -999).toBeGreaterThanOrEqual(metric.minSpeedVsApexM ?? 0);
    expect(metric.throttleOnM ?? -999).toBeGreaterThan(15);
  });

  it('falls back to longG when an available pedal channel never triggers', () => {
    const metric = metricsFor(syntheticLap({ channels: 'all', pedalAt: () => 5 }));
    expect(metric.throttleOnSource).toBe('accelOnset');
    expect(metric.throttleOnM).not.toBeNull();
  });

  it('reports the full-throttle fraction of the exit zone from the pedal channel', () => {
    const metric = metricsFor(syntheticLap({ channels: 'pedal' }));
    expect(metric.fullThrottleFraction).not.toBeNull();
    expect(metric.fullThrottleFraction ?? -1).toBeGreaterThan(0);
    expect(metric.fullThrottleFraction ?? 2).toBeLessThan(1);
    const later = metricsFor(
      syntheticLap({
        channels: 'pedal',
        pedalAt: (d) => (d < 360 ? 90 : d < 660 ? 0 : Math.min(90, (d - 660) * 0.3)),
      }),
    );
    expect(later.fullThrottleFraction ?? 1).toBeLessThan(metric.fullThrottleFraction ?? 0);
  });
});

describe('computeCornerMetrics: tier-2 channels', () => {
  it('prefers the brake channel and reports its source', () => {
    const metric = metricsFor(syntheticLap({ channels: 'brake' }));
    expect(metric.brakeSource).toBe('brakePct');
    expect(metric.brakeStartM ?? 0).toBeGreaterThan(205);
    expect(metric.brakeStartM ?? 0).toBeLessThan(235);
  });

  it('reports the turn-in point, steering smoothness and correction count', () => {
    const metric = metricsFor(syntheticLap({ channels: 'steering' }));
    expect(metric.turnInSource).toBe('steeringDeg');
    expect(metric.turnInM).not.toBeNull();
    // Turn-in starts ~610 m, i.e. ~10 m BEFORE the 620 m entry.
    expect(metric.turnInM ?? 0).toBeGreaterThan(0);
    expect(metric.turnInM ?? 0).toBeLessThan(20);
    expect(metric.steeringSmoothness ?? -1).toBeGreaterThan(0);
    expect(metric.steeringCorrections).not.toBeNull();
    expect(metric.steeringCorrections ?? -1).toBeGreaterThanOrEqual(0);
  });

  it('never counts the virtual start/finish join as full-throttle distance (M8)', () => {
    // Exit zone [apex 960, exit + 40 = 30]: 40 grid metres of the lap's END at
    // full throttle and 31 of its START off it. The join between them is not a
    // metre of track: 39 real full-throttle metres out of 69, never 40 of 70.
    const corner: Corner = {
      ...SYNTHETIC_CORNER,
      id: 3,
      entryDistanceM: 930,
      apexDistanceM: 960,
      exitDistanceM: 990,
      lengthM: 60,
    };
    const samples = syntheticLap().map((sample) => ({
      ...sample,
      channels: { accelPedalPct: sample.distanceM >= 900 ? 100 : 0 },
    }));
    const result = computeCornerMetrics(samples, [corner], { ...OPTIONS, exitWindowM: 40 });
    expect(result[0]?.fullThrottleFraction ?? 0).toBeCloseTo(39 / 69, 4);
  });

  it('never derives a steering rate across the virtual start/finish join (M8)', () => {
    // The corner wraps the line, so its window is the END of the series joined
    // to its START. Those two runs are ~28 s apart: -20 deg at 999 m followed by
    // +20 deg at 0 m is not a 40 deg/m steering movement, and not a correction.
    // One continuous degree per metre through each half of the window, so every
    // real derivative is -1 deg/m and every real correction count is 0.
    const steeringAt = (distanceM: number): number => {
      if (distanceM >= 940) return -(distanceM - 940);
      if (distanceM <= 60) return 60 - distanceM;
      return 0;
    };
    const samples = syntheticLap().map((sample) => ({
      ...sample,
      channels: { steeringDeg: steeringAt(sample.distanceM) },
    }));
    const metric = metricsFor(samples, [WRAP_CORNER]);
    expect(metric.quality.flags).not.toContain('NO_CORNER_COVERAGE');
    expect(metric.steeringSmoothness).not.toBeNull();
    // Each half ramps by 1 deg per metre; the seam contributes nothing.
    expect(metric.steeringSmoothness ?? 0).toBeCloseTo(1, 2);
    expect(metric.steeringCorrections).toBe(0);
  });

  it('falls back to the gyro yaw rate for turn-in when there is no steering channel', () => {
    const metric = metricsFor(syntheticLap({ channels: 'yaw' }));
    expect(metric.turnInSource).toBe('yawRateDps');
    expect(metric.turnInM).not.toBeNull();
  });

  it('reports the friction-circle magnitude as hypot(latG, longG)', () => {
    const samples = syntheticLap({ channels: 'imu' });
    const metric = metricsFor(samples);
    const inCorner = samples.filter(
      (sample) => sample.distanceM >= 620 && sample.distanceM <= 680,
    );
    const naive = Math.max(
      ...inCorner.map((sample) =>
        Math.hypot(sample.channels?.latG ?? 0, sample.channels?.longG ?? 0),
      ),
    );
    expect(metric.frictionCircleMaxG).not.toBeNull();
    expect(metric.frictionCircleMaxG ?? 0).toBeGreaterThanOrEqual(metric.maxLatG ?? 0);
    expect(metric.frictionCircleMaxG ?? 0).toBeCloseTo(naive, 2);
  });
});

describe('computeCornerMetrics: robustness gaps', () => {
  it('does not call a longG bias braking when the GPS speed is not dropping (M3)', () => {
    // A phone tilted in the cradle reports a steady -0.3 g with no speed change.
    const samples = syntheticLap({ accelAt: () => 0 }).map((sample) => ({
      ...sample,
      channels: { longG: -0.3 },
    }));
    const metric = metricsFor(samples);
    expect(metric.brakeStartM).toBeNull();
  });

  it('does not confirm an IMU brake when the speed evidence is missing (M3)', () => {
    // A tilted phone reads -0.3 g over the last 30 m of the approach window.
    // The fixes carry no Doppler speed, and the derived speed runs out at the
    // last raw sample, so the cross-check has nothing to confirm the brake with.
    const samples: CornerLapSample[] = [];
    for (let distanceM = 200; distanceM <= 620; distanceM += 20) {
      samples.push({
        tMonoMs: (distanceM - 200) * 25,
        distanceM,
        accuracyM: 4,
        lateralM: 0,
        channels: { longG: distanceM >= 600 ? -0.3 : 0 },
      });
    }
    const metric = metricsFor(samples);
    expect(metric.brakeSource).not.toBe('longG');
    expect(metric.brakeStartM).toBeNull();
  });

  it('needs a real 300 ms of sustained deceleration, not two adjacent samples (M3)', () => {
    // Two threshold-crossing samples 10 ms apart at the very end of the window.
    const samples: CornerLapSample[] = [];
    for (let index = 0; index <= 60; index += 1) {
      samples.push({
        tMonoMs: index * 200,
        distanceM: 240 + index * 6,
        speedKph: 144,
        channels: { longG: 0 },
      });
    }
    const tail = samples[samples.length - 1];
    if (tail !== undefined) {
      samples.push({ ...tail, tMonoMs: tail.tMonoMs + 5, channels: { longG: -0.4 } });
      samples.push({ ...tail, tMonoMs: tail.tMonoMs + 15, channels: { longG: -0.4 } });
    }
    const metric = metricsFor(samples);
    expect(metric.brakeStartM).toBeNull();
  });

  it('survives a zero-speed interval without inventing NaN or Infinity', () => {
    const moving = syntheticLap();
    const pivot = moving.findIndex((sample) => sample.distanceM > 300);
    const source = moving[pivot];
    const stopped: CornerLapSample[] = [];
    if (source !== undefined) {
      for (let index = 1; index <= 20; index += 1) {
        stopped.push({ ...source, tMonoMs: source.tMonoMs + index * 100, speedKph: 0 });
      }
    }
    const shifted = moving
      .slice(pivot + 1)
      .map((sample) => ({ ...sample, tMonoMs: sample.tMonoMs + 2_000 }));
    const metric = metricsFor([...moving.slice(0, pivot + 1), ...stopped, ...shifted]);
    for (const value of [
      metric.brakeStartM,
      metric.minSpeedKph,
      metric.sectorMs,
      metric.exitSpeedKph,
    ]) {
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
    expect(metric.minSpeedKph ?? 1).toBeGreaterThan(0);
  });

  it('stays finite and deterministic when timestamps are not monotonic', () => {
    const samples = syntheticLap().map((sample, index) =>
      index === 55 ? { ...sample, tMonoMs: sample.tMonoMs - 5_000 } : sample,
    );
    const first = computeCornerMetrics(samples, [SYNTHETIC_CORNER], OPTIONS);
    const second = computeCornerMetrics(samples, [SYNTHETIC_CORNER], OPTIONS);
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
    expect(JSON.stringify(first)).not.toMatch(/NaN|Infinity/);
  });

  it('does not duplicate a 1.5-2.0 s gap as a corner flag (documented deviation)', () => {
    const samples = syntheticLap().filter(
      (sample) => !(sample.distanceM > 470 && sample.distanceM < 520),
    );
    const metric = metricsFor(samples);
    expect(metric.quality.maxSampleGapMs ?? 0).toBeGreaterThan(1_500);
    expect(metric.quality.maxSampleGapMs ?? 0).toBeLessThan(2_000);
    expect(metric.quality.flags).not.toContain('SAMPLE_GAP');
  });
});
