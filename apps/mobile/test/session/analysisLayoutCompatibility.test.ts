import { describe, expect, it } from 'vitest';
import type { LapRecord } from '@circuit/core';

import { createAnalysisSessionLoader } from '../../src/session/analysisSessionLoader';
import { buildAnalysisScreenState } from '../../src/session/analysisViewModel';
import { ANALYSIS_SCREEN_STRINGS } from '../../src/ui/screens/analysisStrings';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P5b-FIX1 C3 (Codex P5b-REV1 finding 3): a stored session is analysed
 * only against the geometry it was RECORDED on. Circuit id, layout id and --
 * when the session stored one -- the layout version all have to match the
 * catalog entry; anything else is a NAMED "layout incompatible" state, never a
 * silent projection of old laps onto today's corners.
 */

function harness(stored: { layoutId: string; layoutVersion?: number }) {
  const { circuit } = allBundledCircuits()[0]!;
  const driven = driveSession(circuit, { laps: 2, channels: 'none' });
  const laps: LapRecord[] = driven.recordings.map((recording) => ({
    lapNumber: recording.lap.lapNumber,
    tStart: 0,
    tEnd: recording.lap.durationMs,
    durationMs: recording.lap.durationMs,
    sectorTimes: [],
    valid: true,
    invalidReasons: [],
    quality: 'good',
  }));

  const loader = createAnalysisSessionLoader({
    getSession: () => ({
      sessionId: 'stored',
      circuitId: circuit.profile.circuitId,
      layoutId: stored.layoutId,
      ...(stored.layoutVersion === undefined ? {} : { layoutVersion: stored.layoutVersion }),
      displayDateUtc: '2026-08-29T09:15:00.000Z',
      laps,
    }),
    getCircuit: (circuitId) => (circuitId === circuit.profile.circuitId ? circuit : null),
    loadLapGnss: async (_sessionId, lapNumber) =>
      driven.recordings.find((r) => r.lap.lapNumber === lapNumber)?.locationSamples.slice() ?? [],
    loadSessionChannels: async () => new Map(),
  });
  return { circuit, loader };
}

describe('P5b-FIX1 C3 -- the loader validates the layout, not just the circuit', () => {
  const catalogCircuit = allBundledCircuits()[0]!.circuit;

  it('accepts the session recorded on the catalog layout and version', async () => {
    const { circuit, loader } = harness({
      layoutId: catalogCircuit.profile.layoutId,
      layoutVersion: catalogCircuit.profile.layoutVersion,
    });
    const source = await loader('stored');
    if (source === null || 'unavailable' in source) throw new Error('expected a session source');
    expect(source.circuit.profile.layoutId).toBe(circuit.profile.layoutId);
  });

  it('refuses a session recorded on a DIFFERENT layout of the same circuit', async () => {
    const { loader } = harness({ layoutId: 'some-other-layout' });
    expect(await loader('stored')).toEqual({ unavailable: 'layout-incompatible' });
  });

  it('refuses a session whose stored layout VERSION is not the catalog one', async () => {
    const { loader } = harness({
      layoutId: catalogCircuit.profile.layoutId,
      layoutVersion: catalogCircuit.profile.layoutVersion + 1,
    });
    expect(await loader('stored')).toEqual({ unavailable: 'layout-incompatible' });
  });

  it('accepts a session that stored no layout version at all (nothing to contradict)', async () => {
    const { loader } = harness({ layoutId: catalogCircuit.profile.layoutId });
    const source = await loader('stored');
    expect(source === null || 'unavailable' in source).toBe(false);
  });

  it('says so on screen, in both languages', () => {
    for (const language of ['en', 'ro'] as const) {
      const state = buildAnalysisScreenState(
        { status: 'unavailable', reason: 'layout-incompatible' },
        language,
      );
      expect(state.status).toBe('unavailable');
      if (state.status !== 'unavailable') return;
      expect(state.message).toBe(ANALYSIS_SCREEN_STRINGS[language].layoutIncompatible);
    }
  });
});
