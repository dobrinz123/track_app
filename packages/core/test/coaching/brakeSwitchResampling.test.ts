import { describe, expect, it } from 'vitest';

import {
  analyzeSession,
  buildDemonstratedEnvelope,
  computeCornerMetrics,
  renderReport,
} from '../../src/coaching';
import type {
  CleanLapMetrics,
  CornerLapSample,
  CornerMetrics,
  SessionLapInput,
} from '../../src/coaching';
import { CORNER_ANALYSIS_VERSION } from '../../src/contracts';

import { SYNTHETIC_CORNER, SYNTHETIC_TOTAL_LENGTH_M, syntheticLap } from './syntheticLap';

/**
 * Ticket P4l-FIX4 N3 (Codex P4l-REV2b finding 7, HIGH).
 *
 * A brake SWITCH is a two-valued channel sampled at whatever rate the ECU
 * answers -- 1-5 Hz over ENET, not the 10-25 Hz of a GNSS trace. Resampling
 * it onto the 1 m analysis grid by LINEAR interpolation invents a ramp
 * between the last released sample and the first pressed one, and
 * `detectBrake`'s 5 % threshold then fires ~5 % into that ramp: at 1 Hz and
 * 40 m/s, up to ~950 ms and ~38 m BEFORE the pedal was first observed
 * pressed. That fabricated onset is not merely imprecise -- it feeds the
 * DEMONSTRATED envelope's latest-brake safety bound, i.e. the app would
 * claim the driver has already braked later than they ever did.
 *
 * The rule: a boolean channel is held (zero-order hold, the value of the last
 * OBSERVED sample), the onset is the first sample at or after the observed
 * edge, and the residual ignorance -- the sampling interval, in metres -- is
 * carried as `brakeOnsetUncertaintyM` so the report can say "+/- X m" and the
 * safety bound can take the pessimistic (earlier-braking) edge.
 */

const OPTIONS = { totalLengthM: SYNTHETIC_TOTAL_LENGTH_M };

/** The analytic lap at 1 Hz with a brake SWITCH: released (0) until 400 m, pressed (100) from there. */
function lapWithSwitchAt1Hz(): CornerLapSample[] {
  return syntheticLap({ sampleRateHz: 1 }).map((sample) => ({
    ...sample,
    channels: { ...(sample.channels ?? {}), brakeSwitch: sample.distanceM >= 400 ? 100 : 0 },
  }));
}

/** The distance of the FIRST sample that reads pressed, and of the last released one before it. */
function observedEdge(samples: readonly CornerLapSample[]): { pressedM: number; releasedM: number } {
  const index = samples.findIndex((sample) => (sample.channels?.brakeSwitch ?? 0) > 0);
  const pressed = samples[index];
  const released = samples[index - 1];
  if (pressed === undefined || released === undefined) throw new Error('fixture has no switch edge');
  return { pressedM: pressed.distanceM, releasedM: released.distanceM };
}

describe('P4l-FIX4 N3: a brake switch is held, never interpolated', () => {
  it('takes the onset at the first PRESSED sample, never earlier', () => {
    const samples = lapWithSwitchAt1Hz();
    const { pressedM } = observedEdge(samples);
    const metric = computeCornerMetrics(samples, [SYNTHETIC_CORNER], OPTIONS)[0];

    expect(metric?.brakeSource).toBe('brakeSwitch');
    const onsetM = SYNTHETIC_CORNER.entryDistanceM - (metric?.brakeStartM ?? 0);
    // Never before the pedal was observed pressed...
    expect(onsetM).toBeGreaterThanOrEqual(pressedM);
    // ...and no later than the grid step that carries it.
    expect(onsetM).toBeLessThanOrEqual(pressedM + 2);
  });

  it('reports the sampling interval as the onset uncertainty', () => {
    const samples = lapWithSwitchAt1Hz();
    const { pressedM, releasedM } = observedEdge(samples);
    const metric = computeCornerMetrics(samples, [SYNTHETIC_CORNER], OPTIONS)[0];

    expect(metric?.brakeOnsetUncertaintyM).not.toBeNull();
    expect(metric?.brakeOnsetUncertaintyM ?? 0).toBeCloseTo(pressedM - releasedM, 3);
    // One second at ~40 m/s -- the honest width of "somewhere in here".
    expect(metric?.brakeOnsetUncertaintyM ?? 0).toBeGreaterThan(30);
  });

  it('does not fabricate an uncertainty for a continuously sampled brake PRESSURE channel', () => {
    const metric = computeCornerMetrics(
      syntheticLap({ channels: 'brake' }),
      [SYNTHETIC_CORNER],
      OPTIONS,
    )[0];
    expect(metric?.brakeSource).toBe('brakePct');
    expect(metric?.brakeOnsetUncertaintyM).toBeNull();
  });

  it('holds the switch: a released sample between two pressed ones does not ramp', () => {
    // A single dropped/late sample must not make the grid read "half pressed"
    // across the hole -- hold keeps it at the last observed value.
    const samples = lapWithSwitchAt1Hz();
    const metric = computeCornerMetrics(samples, [SYNTHETIC_CORNER], OPTIONS)[0];
    expect(metric?.brakeStartM).not.toBeNull();
    expect(Number.isFinite(metric?.brakeStartM ?? Number.NaN)).toBe(true);
  });
});

function metric(overrides: Partial<CornerMetrics> & { cornerId: number }): CornerMetrics {
  return {
    analysisVersion: CORNER_ANALYSIS_VERSION,
    liftPointM: null,
    liftSource: null,
    brakeStartM: 200,
    brakeSource: 'brakeSwitch',
    brakeOnsetUncertaintyM: null,
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

describe('P4l-FIX4 N3: the demonstrated latest-brake bound takes the pessimistic edge', () => {
  it('pushes the latest demonstrated braking point EARLIER by its own onset uncertainty', () => {
    const laps: CleanLapMetrics[] = [
      { lapNumber: 1, corners: [metric({ cornerId: 1, brakeStartM: 250, brakeOnsetUncertaintyM: null })] },
      { lapNumber: 2, corners: [metric({ cornerId: 1, brakeStartM: 170, brakeOnsetUncertaintyM: 38 })] },
    ];
    const corner = buildDemonstratedEnvelope(laps).corners[0];
    // The lap-2 onset is only known to within 38 m, and the true brake point
    // can only be EARLIER than the first pressed sample -- so the bound the
    // safety check leans on is 170 + 38, never the raw 170.
    expect(corner?.latestBrakeStartM).toBe(208);
    expect(corner?.latestBrakeStartLapNumber).toBe(2);
    // The measured extremes themselves are untouched.
    expect(corner?.earliestBrakeStartM).toBe(250);
    expect(corner?.medianBrakeStartM).toBe(170);
  });

  it('lets a precisely measured lap own the bound when the sparse lap can no longer claim it', () => {
    const laps: CleanLapMetrics[] = [
      { lapNumber: 1, corners: [metric({ cornerId: 1, brakeStartM: 200, brakeSource: 'brakePct', brakeOnsetUncertaintyM: null })] },
      { lapNumber: 2, corners: [metric({ cornerId: 1, brakeStartM: 170, brakeOnsetUncertaintyM: 38 })] },
    ];
    const corner = buildDemonstratedEnvelope(laps).corners[0];
    // 170 +/- 38 could be anywhere up to 208 m before the entry, so it is NOT
    // evidence of braking later than the 200 m lap 1 actually measured.
    expect(corner?.latestBrakeStartM).toBe(200);
    expect(corner?.latestBrakeStartLapNumber).toBe(1);
  });

  it('leaves a bound with no uncertainty exactly where it was', () => {
    const laps: CleanLapMetrics[] = [
      { lapNumber: 1, corners: [metric({ cornerId: 1, brakeStartM: 200, brakeSource: 'gpsSpeed', brakeOnsetUncertaintyM: null })] },
      { lapNumber: 2, corners: [metric({ cornerId: 1, brakeStartM: 170, brakeSource: 'gpsSpeed', brakeOnsetUncertaintyM: null })] },
    ];
    expect(buildDemonstratedEnvelope(laps).corners[0]?.latestBrakeStartM).toBe(170);
  });
});

describe('P4l-FIX4 N3: the report states the onset uncertainty', () => {
  function switchSession(): SessionLapInput[] {
    let clock = 0;
    return [1, 2, 3].map((lapNumber) => {
      const samples = syntheticLap({ sampleRateHz: 1, tStartMs: clock }).map((sample) => ({
        ...sample,
        channels: { ...(sample.channels ?? {}), brakeSwitch: sample.distanceM >= 400 ? 100 : 0 },
      }));
      const first = samples[0];
      const last = samples[samples.length - 1];
      clock = (last?.tMonoMs ?? 0) + 1_000;
      return {
        lap: {
          lapNumber,
          durationMs: (last?.tMonoMs ?? 0) - (first?.tMonoMs ?? 0),
          valid: true,
          invalidReasons: [],
          quality: 'good' as const,
        },
        samples,
      };
    });
  }

  it('renders the brake point with a +/- band when the onset came from a sparse switch', () => {
    const insights = analyzeSession(switchSession(), [SYNTHETIC_CORNER], {
      totalLengthM: SYNTHETIC_TOTAL_LENGTH_M,
      circuitId: 'synthetic-oval',
      circuitName: 'Synthetic Oval',
    });
    const row = insights.corners[0]?.perLap[0];
    expect(row?.brakeSource).toBe('brakeSwitch');
    expect(row?.brakeOnsetUncertaintyM).not.toBeNull();

    for (const language of ['en', 'ro'] as const) {
      const text = renderReport(insights, language);
      expect(text).toMatch(/±\s?\d+ m/);
      expect(text).not.toMatch(/undefined|NaN/);
    }
  });
});
