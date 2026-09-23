import { describe, expect, it } from 'vitest';
import {
  buildDemonstratedEnvelope,
  buildTestLoopCircuit,
  computeSuggestions,
  geometryProvenanceOf,
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
  const result = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), {
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
          locationSamples: rectangleLoopSamples({ laps: 2 }),
          telemetry: [],
        },
      ],
    );

    expect(assembled.context.geometryValidated).toBe(false);
  });

  /**
   * P17 renamed what this proves. The stage is not inert because geometry is
   * unvalidated -- a learned circuit now carries self-referential advice. It is
   * inert because this caller stated NOTHING about where the line came from,
   * and silence has never been a licence (P16 C2).
   */
  it('the suggestion stage stays inert when nothing is STATED about the geometry', () => {
    const envelope = buildDemonstratedEnvelope([]);
    const result = computeSuggestions({
      enabled: true,
      envelope,
      cues: [],
      geometryValidated: false,
    });

    expect(result.gate).toBe('geometry-unvalidated');
    expect(result.scope).toBe('closed');
    expect(result.cueUpdates).toEqual([]);
    expect(result.pitSuggestions).toEqual([]);
  });

  /**
   * P17: a learned circuit stated as such reaches the self-referential tier --
   * and still moves no live cue. The assembly is what states it, so this goes
   * through `geometryProvenanceOf` rather than a literal.
   */
  it('a learned circuit reaches the self-referential tier and still moves no cue', () => {
    const circuit = learn();
    expect(geometryProvenanceOf(circuit.profile.geometryStatus)).toBe('learned');
    const result = computeSuggestions({
      enabled: true,
      envelope: buildDemonstratedEnvelope([]),
      cues: [],
      geometryValidated: false,
      geometry: geometryProvenanceOf(circuit.profile.geometryStatus),
    });
    // The geometry no longer shuts the gate -- the EVIDENCE gate does, because
    // this envelope holds no clean laps. That is the whole change: a learned
    // circuit now fails for want of laps, not for want of a survey.
    expect(result.gate).toBe('insufficient-clean-laps');
    expect(result.cueUpdates).toEqual([]);
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
