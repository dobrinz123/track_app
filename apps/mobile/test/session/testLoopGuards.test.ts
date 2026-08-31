import { describe, expect, it } from 'vitest';
import {
  buildDemonstratedEnvelope,
  buildTestLoopCircuit,
  computeSuggestions,
  isLearnedGeometry,
  type LapRecord,
  type TestLoopCircuit,
} from '@circuit/core';

import { assembleSessionAnalysis } from '../../src/session/analysisAssembly';
import { learnedCoachingEnabled } from '../../src/session/testLoopGuards';
import { rectangleLoopSamples } from '../support/testLoopTraces';

/**
 * Ticket P5d T5 -- the guards, pinned where they actually live.
 *
 * A learned loop is timed and analysed like any circuit, and advised on like
 * NO circuit: `geometryStatus: 'ad-hoc'` fails the geometry gate by
 * construction, and live cues (and therefore voice, which only ever speaks a
 * cue) are switched off for the whole session.
 */

function learn(): TestLoopCircuit {
  const result = buildTestLoopCircuit(rectangleLoopSamples(), {
    circuitId: 'learned-guards',
    displayName: 'Test loop',
    createdAtUtc: '2026-08-31T09:00:00.000Z',
  });
  if (!result.ok) throw new Error(`fixture did not learn a loop: ${result.reason}`);
  return result;
}

function lap(lapNumber: number): LapRecord {
  return {
    lapNumber,
    tStart: lapNumber * 60_000,
    tEnd: (lapNumber + 1) * 60_000,
    durationMs: 60_000,
    sectorTimes: [],
    valid: true,
    invalidReasons: [],
    quality: 'good',
  };
}

describe('Test Loop guards (P5d T5)', () => {
  it('an ad-hoc circuit fails the analysis geometry gate BY CONSTRUCTION', () => {
    const circuit = learn();
    expect(isLearnedGeometry(circuit.profile)).toBe(true);

    const assembled = assembleSessionAnalysis(
      { profile: circuit.profile, runtime: circuit.runtime, corners: circuit.corners },
      [
        {
          lap: lap(1),
          locationSamples: rectangleLoopSamples(),
          telemetry: [],
        },
      ],
    );

    expect(assembled.context.geometryValidated).toBe(false);
  });

  it('the suggestion stage stays inert on unvalidated geometry, and says why', () => {
    const envelope = buildDemonstratedEnvelope([]);
    const result = computeSuggestions({
      enabled: true,
      envelope,
      cues: [],
      geometryValidated: false,
    });

    expect(result.gate).toBe('geometry-unvalidated');
    expect(result.cueUpdates).toEqual([]);
    expect(result.pitSuggestions).toEqual([]);
  });

  it('live cues (and so voice) are OFF on a learned circuit even when coaching is on', () => {
    const circuit = learn();
    expect(learnedCoachingEnabled(true, circuit.profile)).toBe(false);
    expect(learnedCoachingEnabled(false, circuit.profile)).toBe(false);
    // ...and untouched for a surveyed circuit.
    expect(learnedCoachingEnabled(true, { geometryStatus: 'official' })).toBe(true);
    expect(learnedCoachingEnabled(false, { geometryStatus: 'official' })).toBe(false);
  });
});
