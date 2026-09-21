import { describe, expect, it } from 'vitest';
import type { LapRecord, LocationSample } from '@circuit/core';
import { buildRawSessionExportDocument } from '../../src/session/rawSessionExport';

/**
 * Ticket P10B M8 -- THE RUN COUNTS MUST DESCRIBE THE SAMPLES THAT SHIPPED.
 *
 * REVIEWER REPRODUCTION (rawSessionExport.ts:340): give run 1 one fix that
 * is duplicated in a lap row, and run 2 one distinct fix. The export returns
 * ONE unclaimed fix, but `runs` reports one sample in EACH run -- so a
 * consumer using the counts to split the array (which is their only purpose:
 * `tMono` is not comparable across runs) assigns run 2's fix to run 1.
 */
const LAP: LapRecord = {
  lapNumber: 1,
  tStart: 1_000,
  tEnd: 2_000,
  durationMs: 1_000,
  sectorTimes: [],
  valid: true,
  invalidReasons: [],
  quality: 'good',
};

const DUPLICATED: LocationSample = { tMono: 1_500, lat: 46.7, lon: 23.5, accuracyM: 3, source: 'gnss' };
const DISTINCT: LocationSample = { tMono: 400, lat: 46.8, lon: 23.6, accuracyM: 3, source: 'gnss' };

function documentWithTwoRuns() {
  return buildRawSessionExportDocument({
    generatedAtUtc: '2026-09-22T00:00:00.000Z',
    session: {
      sessionId: 's',
      circuitId: 'tmr',
      layoutId: 'full',
      displayDateUtc: '2026-09-22T00:00:00.000Z',
      laps: [LAP],
    } as never,
    calibrationStatus: 'validated',
    unwrittenSampleCount: 0,
    lapTraces: [{ lapNumber: 1, sampleCount: 1, samples: [DUPLICATED] }],
    unclaimedChunks: [
      { key: -1_000_001, runBase: 100, sequence: 1, samples: [DUPLICATED] },
      { key: -2_000_001, runBase: 200, sequence: 1, samples: [DISTINCT] },
    ],
    telemetry: [],
  });
}

describe('P10B M8 -- exported run counts are computed after reconciliation', () => {
  it('a run whose only fix was a duplicate claims no samples, and the surviving run keeps its own', () => {
    const doc = documentWithTwoRuns();

    // One fix ships: run 1's was a duplicate of the lap row's copy.
    expect(doc.gnss.unclaimed).toHaveLength(1);
    expect(doc.gnss.unclaimed[0]!.tMono).toBe(400);
    expect(doc.gnss.reconciledDuplicateCount).toBe(1);

    // WAS: [{runBase:100, sampleCount:1}, {runBase:200, sampleCount:1}] --
    // two samples described, one sample present, and the one that IS present
    // attributed to the wrong run.
    expect(doc.gnss.runs).toEqual([
      { runBase: 200, chunkCount: 1, sampleCount: 1, startIndex: 0 },
    ]);

    // The counts now add up to the array they describe.
    const described = doc.gnss.runs.reduce((total, run) => total + run.sampleCount, 0);
    expect(described).toBe(doc.gnss.unclaimed.length);
  });

  it('every run block can be sliced out of `unclaimed` by its own boundary', () => {
    const a: LocationSample = { tMono: 10, lat: 1, lon: 1, source: 'replay' };
    const b: LocationSample = { tMono: 20, lat: 1, lon: 2, source: 'replay' };
    const c: LocationSample = { tMono: 5, lat: 2, lon: 1, source: 'replay' };
    const doc = buildRawSessionExportDocument({
      generatedAtUtc: '2026-09-22T00:00:00.000Z',
      session: {
        sessionId: 's',
        circuitId: 'tmr',
        layoutId: 'full',
        displayDateUtc: '2026-09-22T00:00:00.000Z',
        laps: [],
      } as never,
      calibrationStatus: 'validated',
      unwrittenSampleCount: 0,
      lapTraces: [],
      unclaimedChunks: [
        { key: -1_000_001, runBase: 100, sequence: 1, samples: [a] },
        { key: -1_000_002, runBase: 100, sequence: 2, samples: [b] },
        { key: -2_000_001, runBase: 200, sequence: 1, samples: [c] },
      ],
      telemetry: [],
    });

    expect(doc.gnss.runs).toEqual([
      { runBase: 100, chunkCount: 2, sampleCount: 2, startIndex: 0 },
      { runBase: 200, chunkCount: 1, sampleCount: 1, startIndex: 2 },
    ]);
    for (const run of doc.gnss.runs) {
      const slice = doc.gnss.unclaimed.slice(run.startIndex, run.startIndex + run.sampleCount);
      expect(slice).toHaveLength(run.sampleCount);
    }
    expect(doc.gnss.unclaimed.map((s) => s.tMono)).toEqual([10, 20, 5]);
  });
});
