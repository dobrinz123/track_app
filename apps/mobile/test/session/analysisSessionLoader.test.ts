import { describe, expect, it, vi } from 'vitest';
import type { LocationSample, TelemetrySample } from '@circuit/core';

import { createAnalysisSessionLoader } from '../../src/session/analysisSessionLoader';
import { createAnalysisRunner } from '../../src/session/analysisViewModel';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P5b B2 — the read path: a stored session id becomes the analysis
 * engine's input out of the SAME rows the rest of the app reads (the history
 * store's lap records, `LocalSessionRepository.loadTelemetry`'s GNSS samples,
 * and `telemetry_samples`' decoded channels). Injected dependencies, so this is
 * testable without expo-sqlite or the composition singletons.
 */

function harness(options: { withChannels?: boolean; unknownCircuit?: boolean } = {}) {
  const { circuit } = allBundledCircuits()[0]!;
  const driven = driveSession(circuit, { laps: 3, channels: options.withChannels ? 'full' : 'none' });
  const gnss = new Map<number, LocationSample[]>();
  const channels = new Map<number, TelemetrySample[]>();
  for (const recording of driven.recordings) {
    gnss.set(recording.lap.lapNumber, [...recording.locationSamples]);
    channels.set(recording.lap.lapNumber, [...recording.telemetry]);
  }

  const loadLapGnss = vi.fn(async (_sessionId: string, lapNumber: number) => gnss.get(lapNumber) ?? []);
  const loadSessionChannels = vi.fn(async () => channels);

  const loader = createAnalysisSessionLoader({
    getSession: (sessionId) =>
      sessionId === 'stored'
        ? {
            sessionId: 'stored',
            circuitId: options.unknownCircuit ? 'no-such-circuit' : circuit.profile.circuitId,
            layoutId: circuit.profile.layoutId,
            displayDateUtc: '2026-08-29T09:15:00.000Z',
            laps: driven.recordings.map((recording) => ({
              lapNumber: recording.lap.lapNumber,
              tStart: 0,
              tEnd: recording.lap.durationMs,
              durationMs: recording.lap.durationMs,
              sectorTimes: [{ sectorIndex: 0, durationMs: recording.lap.durationMs, quality: 'good' as const }],
              valid: recording.lap.valid,
              invalidReasons: [...recording.lap.invalidReasons],
              quality: recording.lap.quality as 'good',
            })),
          }
        : null,
    getCircuit: (circuitId) => (circuitId === circuit.profile.circuitId ? circuit : null),
    loadLapGnss,
    loadSessionChannels,
  });

  return { circuit, loader, loadLapGnss, loadSessionChannels, driven };
}

describe('P5b -- loading a stored session for analysis', () => {
  it('assembles one recording per stored lap, with its GNSS trace and channels', async () => {
    const { loader, circuit, loadLapGnss, loadSessionChannels } = harness({ withChannels: true });
    const source = await loader('stored');

    expect(source).not.toBeNull();
    if (source === null || 'unavailable' in source) throw new Error('expected a session source');
    expect(source.sessionId).toBe('stored');
    expect(source.circuit.profile.circuitId).toBe(circuit.profile.circuitId);
    expect(source.displayDateUtc).toBe('2026-08-29T09:15:00.000Z');
    expect(source.recordings).toHaveLength(3);
    expect(source.recordings[0]!.locationSamples.length).toBeGreaterThan(10);
    expect(source.recordings[0]!.telemetry.length).toBeGreaterThan(10);
    expect(source.recordings[0]!.sectorTimes).toEqual([
      { sectorIndex: 0, durationMs: source.recordings[0]!.lap.durationMs },
    ]);
    // One channel read for the whole session, one GNSS read per lap.
    expect(loadSessionChannels).toHaveBeenCalledTimes(1);
    expect(loadLapGnss).toHaveBeenCalledTimes(3);
  });

  it('reports a circuit that is not in the catalog rather than guessing one', async () => {
    const { loader } = harness({ unknownCircuit: true });
    const source = await loader('stored');
    expect(source).toEqual({ unavailable: 'circuit-not-in-catalog' });
  });

  it('reports a session that is not stored', async () => {
    const { loader } = harness();
    expect(await loader('gone')).toBeNull();
  });

  it('degrades to no channels when the telemetry read fails, keeping the GPS analysis', async () => {
    const { circuit, driven } = harness();
    const loader = createAnalysisSessionLoader({
      getSession: () => ({
        sessionId: 'stored',
        circuitId: circuit.profile.circuitId,
        layoutId: circuit.profile.layoutId,
        displayDateUtc: '2026-08-29T09:15:00.000Z',
        laps: driven.recordings.map((recording) => ({
          lapNumber: recording.lap.lapNumber,
          tStart: 0,
          tEnd: recording.lap.durationMs,
          durationMs: recording.lap.durationMs,
          sectorTimes: [],
          valid: true,
          invalidReasons: [],
          quality: 'good' as const,
        })),
      }),
      getCircuit: () => circuit,
      loadLapGnss: async (_sessionId, lapNumber) =>
        driven.recordings.find((r) => r.lap.lapNumber === lapNumber)?.locationSamples.slice() ?? [],
      loadSessionChannels: async () => {
        throw new Error('sqlite read failed');
      },
    });

    const source = await loader('stored');
    if (source === null || 'unavailable' in source) throw new Error('expected a session source');
    expect(source.recordings.every((recording) => recording.telemetry.length === 0)).toBe(true);

    // ... and the analysis still runs on the GPS trace alone.
    const result = await createAnalysisRunner({
      loadSession: async () => source,
      isSessionActive: () => false,
    }).run('stored');
    expect(result.status).toBe('ready');
  });
});
