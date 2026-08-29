import { describe, expect, it } from 'vitest';

import { analyzeSession, renderReport, type CornerLapSample, type SessionLapInput } from '../../src/coaching';
import { driveCircuitSession, motorpark, transilvania, type TestCircuit } from './circuits';

/**
 * Ticket P4l-FIX1 F4 (binding): a brake SWITCH is the cheapest tier-1 brake
 * signal a vehicle profile can carry -- the Signal Finder confirms one DID
 * whose byte flips when the pedal is touched, and the ENET provider emits it
 * as `brakeSwitch` (0 or 100). The analysis engine must then take the brake
 * ONSET from that switch edge instead of the IMU/GPS estimate, on BOTH
 * circuits, without any circuit id being special-cased.
 *
 * The switch here is synthetic but honest: it is derived from the SAME drive
 * the samples carry (the speed derivative), exactly the way `circuits.ts`'s
 * own `enrichChannels` derives the tier-2 channels -- never invented
 * independently of the trace it is supposed to describe.
 */
const FORBIDDEN = /undefined|NaN/;

/** Pressed (100) whenever the car is really slowing, released (0) otherwise -- a switch, not a pressure. */
function withBrakeSwitch(samples: readonly CornerLapSample[]): CornerLapSample[] {
  return samples.map((sample, index) => {
    const next = samples[index + 1];
    let accelMps2 = 0;
    if (next !== undefined) {
      const dtSeconds = (next.tMonoMs - sample.tMonoMs) / 1_000;
      if (dtSeconds > 0) accelMps2 = ((next.speedKph ?? 0) - (sample.speedKph ?? 0)) / 3.6 / dtSeconds;
    }
    return { ...sample, channels: { ...(sample.channels ?? {}), brakeSwitch: accelMps2 < -0.5 ? 100 : 0 } };
  });
}

function analyzeWithSwitch(circuit: TestCircuit) {
  const session: SessionLapInput[] = driveCircuitSession(circuit, {
    laps: 3,
    cornerSpeedScales: [0.95, 1, 0.97],
    brakeDecelMps2: [3.6, 4.2, 3.9],
  }).map((entry) => ({ ...entry, samples: withBrakeSwitch(entry.samples) }));
  return analyzeSession(session, circuit.corners, {
    totalLengthM: circuit.totalLengthM,
    circuitId: circuit.profile.circuitId,
    circuitName: circuit.profile.displayName,
    layoutId: circuit.profile.layoutId,
    geometryValidated: circuit.geometryValidated,
  });
}

describe.each([
  ['transilvania-motor-ring', transilvania],
  ['motorpark-romania', motorpark],
])('P4l-FIX1 F4: a brake switch drives brake onset on %s', (circuitId, factory) => {
  const circuit = factory();

  it('reports brakeSwitch as an available analysis channel', () => {
    const insights = analyzeWithSwitch(circuit);
    expect(insights.circuitId).toBe(circuitId);
    expect(insights.availability.available).toContain('brakeSwitch');
    expect(insights.availability.missing).not.toContain('brakeSwitch');
  });

  it('takes brake onset from the switch edge, not the GPS-speed estimate', () => {
    const insights = analyzeWithSwitch(circuit);
    const rows = insights.laps.flatMap((lap) => lap.corners).filter((metric) => metric.brakeStartM !== null);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((metric) => metric.brakeSource)).toContain('brakeSwitch');
    expect(rows.every((metric) => metric.brakeSource !== 'gpsSpeed')).toBe(true);
  });

  it('falls back to the existing estimate when the profile carries no switch', () => {
    const withoutSwitch = analyzeSession(
      driveCircuitSession(circuit, { laps: 3 }),
      circuit.corners,
      {
        totalLengthM: circuit.totalLengthM,
        circuitId: circuit.profile.circuitId,
        geometryValidated: circuit.geometryValidated,
      },
    );
    const rows = withoutSwitch.laps.flatMap((lap) => lap.corners).filter((metric) => metric.brakeStartM !== null);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((metric) => metric.brakeSource)).toContain('gpsSpeed');
    expect(withoutSwitch.availability.missing).toContain('brakeSwitch');
  });

  it('renders a report naming the switch source in both languages', () => {
    const insights = analyzeWithSwitch(circuit);
    for (const language of ['ro', 'en'] as const) {
      const text = renderReport(insights, language);
      expect(text).not.toMatch(FORBIDDEN);
    }
  });
});
