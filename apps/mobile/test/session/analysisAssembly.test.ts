import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_CHANNELS } from '@circuit/core';

import {
  ANALYSIS_MIN_CHANNEL_COVERAGE,
  assembleSessionAnalysis,
  channelCoverage,
  runSessionAnalysis,
} from '../../src/session/analysisAssembly';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P5b B2 — data assembly. The screen builds the deterministic engine's
 * inputs out of what the app ACTUALLY stored (lap rows + GNSS samples + decoded
 * OBD channels) and nothing else: the corners come from the circuit catalog,
 * the channel set from the recording, and every verdict (clean / unverified /
 * anomalous, availability, limitations) from `analyzeSession` itself.
 *
 * Both bundled circuits are driven by the SAME parameterised body -- nothing
 * in the assembly may key off a circuit id or a car.
 */
describe('P5b B2 -- assembling the analysis input from a stored session', () => {
  for (const { circuitId, circuit } of allBundledCircuits()) {
    describe(circuitId, () => {
      it('projects every stored lap onto the catalog centreline, monotone from S/F', () => {
        const session = driveSession(circuit, { laps: 3 });
        const assembled = assembleSessionAnalysis(circuit, session.recordings);

        expect(assembled.laps).toHaveLength(3);
        for (const lap of assembled.laps) {
          expect(lap.samples.length).toBeGreaterThan(20);
          for (const sample of lap.samples) {
            expect(Number.isFinite(sample.distanceM)).toBe(true);
            expect(sample.distanceM).toBeGreaterThanOrEqual(0);
            expect(sample.distanceM).toBeLessThan(circuit.profile.totalLengthM);
          }
        }
      });

      it('takes corners and geometry status from the catalog, never from a constant', () => {
        const session = driveSession(circuit, { laps: 2 });
        const assembled = assembleSessionAnalysis(circuit, session.recordings);

        expect(assembled.corners).toEqual(circuit.corners);
        expect(assembled.context.circuitId).toBe(circuit.profile.circuitId);
        expect(assembled.context.circuitName).toBe(circuit.profile.displayName);
        expect(assembled.context.layoutId).toBe(circuit.profile.layoutId);
        expect(assembled.context.totalLengthM).toBeCloseTo(circuit.profile.totalLengthM, 0);
        // Derived from the profile's own `geometryStatus`, so a circuit that is
        // one day field-validated flips this without a code change.
        expect(assembled.context.geometryValidated).toBe(circuit.profile.geometryStatus === 'official');
      });

      it('M15 (Codex P5c-REV2 finding 15): an in-place mutation attempt on the bundled profile does not open the gate', () => {
        expect(circuit.profile.geometryStatus).not.toBe('official');
        expect(() => {
          // The type does not mark this field readonly; the catalog's own
          // freeze (M15, `circuitCatalog.ts`) -- not this assembly function
          // -- is what turns the assignment into a runtime throw.
          circuit.profile.geometryStatus = 'official';
        }).toThrow(TypeError);

        const session = driveSession(circuit, { laps: 2 });
        const assembled = assembleSessionAnalysis(circuit, session.recordings);
        expect(assembled.context.geometryValidated).toBe(false);
      });

      it('reports the channels the recording carries, and only those', () => {
        const pedalOnly = assembleSessionAnalysis(
          circuit,
          driveSession(circuit, { laps: 2, channels: 'pedal' }).recordings,
        );
        expect(pedalOnly.usedChannels).toContain('accelPedalPct');
        expect(pedalOnly.usedChannels).not.toContain('brakeSwitch');
        expect(pedalOnly.usedChannels).not.toContain('rpm');

        const full = assembleSessionAnalysis(
          circuit,
          driveSession(circuit, { laps: 2, channels: 'full' }).recordings,
        );
        expect(full.usedChannels).toContain('accelPedalPct');
        expect(full.usedChannels).toContain('brakeSwitch');
        expect(full.usedChannels).toContain('rpm');
      });

      it('hands the engine the verdicts: analyzeSession decides status and availability', () => {
        const session = driveSession(circuit, { laps: 4, channels: 'full' });
        const assembled = assembleSessionAnalysis(circuit, session.recordings);
        const insights = runSessionAnalysis(assembled);

        expect(insights.observationsOnly).toBe(true);
        expect(insights.lapCount).toBe(4);
        expect(insights.corners).toHaveLength(circuit.corners.length);
        for (const lap of insights.laps) {
          expect(['clean', 'unverified', 'anomalous']).toContain(lap.status);
        }
        expect(insights.availability.available).toContain('accelPedalPct');
        // Never declared unsupported: a recording cannot prove the car lacks a
        // channel, only that this session did not carry one.
        expect(insights.availability.unsupported).toEqual([]);
      });
    });
  }

  it('drops a channel that covers too little of the session, and says how little', () => {
    const { circuit } = allBundledCircuits()[0]!;
    const session = driveSession(circuit, { laps: 2, channels: 'full' });
    // Keep only the first few brake-switch rows: present, but nowhere near
    // enough of the session to be evidence about it.
    for (const recording of session.recordings) {
      let kept = 0;
      recording.telemetry = recording.telemetry.filter((entry) => {
        if (entry.channel !== 'brakeSwitch') return true;
        kept += 1;
        return kept <= 2;
      });
    }
    const assembled = assembleSessionAnalysis(circuit, session.recordings);

    expect(assembled.usedChannels).not.toContain('brakeSwitch');
    const dropped = assembled.lowCoverageChannels.find((entry) => entry.channel === 'brakeSwitch');
    expect(dropped).toBeDefined();
    expect(dropped!.fraction).toBeGreaterThan(0);
    expect(dropped!.fraction).toBeLessThan(ANALYSIS_MIN_CHANNEL_COVERAGE);
    // ... and it never reaches the engine as a usable channel.
    expect(runSessionAnalysis(assembled).availability.available).not.toContain('brakeSwitch');
  });

  it('channelCoverage counts a channel over the samples that could carry it', () => {
    const { circuit } = allBundledCircuits()[0]!;
    const assembled = assembleSessionAnalysis(
      circuit,
      driveSession(circuit, { laps: 1, channels: 'pedal' }).recordings,
    );
    const coverage = channelCoverage(assembled.laps.flatMap((lap) => [...lap.samples]));
    const pedal = coverage.find((entry) => entry.channel === 'accelPedalPct');
    expect(pedal).toBeDefined();
    expect(pedal!.fraction).toBeGreaterThan(0.9);
    for (const entry of coverage) {
      expect(ANALYSIS_CHANNELS).toContain(entry.channel);
      expect(entry.fraction).toBeGreaterThan(0);
    }
  });

  it('a session with no stored GPS produces no laps rather than an invented analysis', () => {
    const { circuit } = allBundledCircuits()[0]!;
    const session = driveSession(circuit, { laps: 2 });
    for (const recording of session.recordings) recording.locationSamples = [];
    const assembled = assembleSessionAnalysis(circuit, session.recordings);

    expect(assembled.laps).toHaveLength(0);
    expect(assembled.skippedLaps.map((entry) => entry.lapNumber)).toEqual([1, 2]);
    expect(assembled.skippedLaps.every((entry) => entry.reason === 'no-samples')).toBe(true);
  });

  it('carries no circuit or vehicle constants in its CODE', () => {
    // Comments may name the circuits they were written for; code may not.
    const code = readFileSync(resolve(__dirname, '../../src/session/analysisAssembly.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/transilvania|motorpark|supra|b58/i);
  });
});
