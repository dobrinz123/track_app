import { describe, expect, it } from 'vitest';

import { analyzeSession, buildReport, renderReport } from '../../src/coaching';
import { CORNER_ANALYSIS_VERSION } from '../../src/contracts';

import { driveCircuitSession, motorpark, transilvania, type TestCircuit } from './circuits';

/**
 * The BOTH-CIRCUITS acceptance proof for the Phase 5 analysis engine: the same
 * pure pipeline, keyed only on catalog corners and channel availability, run
 * over Transilvania Motor Ring (field-validated geometry) and MotorPark
 * (OSM geometry, field-unvalidated). No circuit id is special-cased anywhere in
 * `packages/core/src/coaching`.
 */

const FORBIDDEN = /undefined|NaN/;

function analyze(circuit: TestCircuit, laps = 4) {
  const session = driveCircuitSession(circuit, {
    laps,
    cornerSpeedScales: [0.95, 1, 0.97, 0.93],
    brakeDecelMps2: [3.6, 4.2, 3.9, 3.4],
  });
  const insights = analyzeSession(session, circuit.corners, {
    totalLengthM: circuit.totalLengthM,
    circuitId: circuit.profile.circuitId,
    circuitName: circuit.profile.displayName,
    layoutId: circuit.profile.layoutId,
    geometryValidated: circuit.geometryValidated,
  });
  return { session, insights };
}

describe.each([
  ['transilvania-motor-ring', transilvania],
  ['motorpark-romania', motorpark],
])('deterministic analysis on %s', (circuitId, factory) => {
  const circuit = factory();

  it('analyses every catalog corner of a four-lap session', () => {
    const { insights } = analyze(circuit);
    expect(circuit.corners.length).toBeGreaterThan(5);
    expect(insights.circuitId).toBe(circuitId);
    expect(insights.analysisVersion).toBe(CORNER_ANALYSIS_VERSION);
    expect(insights.corners.map((corner) => corner.cornerId)).toEqual(
      [...circuit.corners].map((corner) => corner.id).sort((a, b) => a - b),
    );
    expect(insights.lapCount).toBe(4);
    expect(insights.cleanLapCount).toBe(4);
    expect(insights.laps.every((lap) => lap.clean)).toBe(true);
  });

  it('measures tier-0 (GPS only) braking points and corner speeds for most corners', () => {
    const { insights } = analyze(circuit);
    const withBrake = insights.corners.filter((corner) =>
      corner.perLap.every((row) => row.brakeStartM !== null),
    );
    const withSpeed = insights.corners.filter((corner) =>
      corner.perLap.every((row) => row.minSpeedKph !== null && row.exitSpeedKph !== null),
    );
    expect(withSpeed).toHaveLength(insights.corners.length);
    expect(withBrake.length / insights.corners.length).toBeGreaterThan(0.6);
    for (const corner of withBrake) {
      for (const row of corner.perLap) {
        expect(row.brakeSource).toBe('gpsSpeed');
        expect(row.brakeStartM ?? -1).toBeGreaterThan(0);
        expect(row.peakDecelG ?? 0).toBeGreaterThan(0.05);
      }
    }
  });

  it('builds the demonstrated envelope from the clean laps only, with evidence', () => {
    const { insights } = analyze(circuit);
    expect(insights.envelope.cleanLapIds).toEqual([1, 2, 3, 4]);
    const measured = insights.corners.filter((corner) => corner.envelope !== null);
    expect(measured.length).toBe(insights.corners.length);
    for (const corner of measured) {
      const envelope = corner.envelope;
      if (envelope === null || envelope.latestBrakeStartM === null) continue;
      expect(envelope.earliestBrakeStartM ?? 0).toBeGreaterThanOrEqual(envelope.latestBrakeStartM);
      expect(envelope.evidenceLapIds.length).toBeGreaterThan(0);
      const rows = corner.perLap.filter((row) => row.brakeStartM !== null);
      // Nothing outside what the driver actually demonstrated.
      expect(envelope.latestBrakeStartM).toBe(Math.min(...rows.map((row) => row.brakeStartM ?? 0)));
    }
  });

  it('ranks time loss against the driver’s own best clean lap', () => {
    const { insights } = analyze(circuit);
    expect(insights.referenceLapNumber).not.toBeNull();
    expect(insights.timeLossRanking.length).toBeGreaterThan(0);
    const deltas = insights.timeLossRanking.map((finding) => finding.deltaMs ?? 0);
    expect([...deltas].sort((a, b) => b - a)).toEqual(deltas);
    for (const finding of insights.timeLossRanking) {
      expect(finding.referenceLapNumber).toBe(insights.referenceLapNumber);
      expect(finding.medianLapNumber).toBe(insights.medianCleanLapNumber);
      if (finding.sectorLossMs !== null) expect(finding.sectorLossMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('scores consistency per corner between 0 and 100', () => {
    const { insights } = analyze(circuit);
    expect(insights.consistencyRanking.length).toBeGreaterThan(0);
    for (const finding of insights.consistencyRanking) {
      expect(finding.score ?? -1).toBeGreaterThanOrEqual(0);
      expect(finding.score ?? 101).toBeLessThanOrEqual(100);
      expect(finding.lapCount).toBeGreaterThanOrEqual(2);
    }
    const scores = insights.consistencyRanking.map((finding) => finding.score ?? 0);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
  });

  it('renders both languages with no missing number anywhere', () => {
    const { insights } = analyze(circuit);
    for (const language of ['ro', 'en'] as const) {
      const report = buildReport(insights, language);
      expect(report.text).not.toMatch(FORBIDDEN);
      expect(report.text).toContain(circuit.profile.displayName);
      expect(report.sections.length).toBeGreaterThan(insights.corners.length);
      for (const section of report.sections) {
        for (const line of section.lines) {
          expect(line).not.toMatch(FORBIDDEN);
          expect(line.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('is byte-identical when the same session is analysed twice', () => {
    const first = analyze(circuit);
    const second = analyze(circuit);
    expect(JSON.stringify(second.insights)).toEqual(JSON.stringify(first.insights));
    expect(renderReport(second.insights, 'ro')).toEqual(renderReport(first.insights, 'ro'));
  });

  it('degrades to facts when only one lap was driven', () => {
    const { insights } = analyze(circuit, 1);
    expect(insights.cleanLapCount).toBe(1);
    expect(insights.timeLossRanking).toEqual([]);
    expect(insights.limitations.map((entry) => entry.code)).toContain('FEW_CLEAN_LAPS');
    expect(renderReport(insights, 'ro')).not.toMatch(FORBIDDEN);
  });
});

describe('geometry honesty per circuit', () => {
  it('flags MotorPark geometry as unvalidated and Transilvania as validated', () => {
    const mp = analyze(motorpark(), 2).insights;
    const tmr = analyze(transilvania(), 2).insights;
    expect(mp.limitations.map((entry) => entry.code)).toContain('GEOMETRY_UNVALIDATED');
    expect(tmr.limitations.map((entry) => entry.code)).not.toContain('GEOMETRY_UNVALIDATED');
    expect(renderReport(mp, 'ro')).toContain('nu este validată pe teren');
    expect(renderReport(tmr, 'ro')).not.toContain('nu este validată pe teren');
  });

  it('reports the same missing OBD channels on both circuits (car-agnostic tier 0)', () => {
    const mp = analyze(motorpark(), 2).insights;
    const tmr = analyze(transilvania(), 2).insights;
    expect(mp.availability.available).toEqual(['speedKph']);
    expect(tmr.availability.available).toEqual(mp.availability.available);
    expect(mp.availability.missing).toEqual(tmr.availability.missing);
  });
});
