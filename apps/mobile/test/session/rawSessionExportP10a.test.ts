import { describe, expect, it } from 'vitest';
import { TRACE_CHUNK_KEY_STRIDE, type LapRecord, type LocationSample } from '@circuit/core';

import type { StoredSession } from '../../src/session/mockHistory';
import {
  buildRawSessionSummaryMarkdown,
  loadRawSessionExportDocument,
  readAllSessionTelemetry,
  readStoredGnssLapNumbers,
  readUnclaimedGnssChunks,
  type RawSessionExportDeps,
  type RawSessionExportDocument,
  type RawSessionTraceChunk,
} from '../../src/session/rawSessionExport';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * Ticket P10A -- the export half of the P9 reviewer's findings, re-run
 * against the fix.
 *
 * The scenarios are theirs. Their loader script built a session with one
 * fix, handed the SAME fix to both the lap read and the chunk read, and got
 * two fixes out; and it asked for a session whose only stored GNSS row was
 * lap 0 and got an empty document. Both are reproduced below in the same
 * shape, plus the cross-launch ordering their MEDIUM describes.
 */

const SAMPLE: LocationSample = { tMono: 100, lat: 1, lon: 1, source: 'replay' };

function session(laps: LapRecord[] = []): StoredSession {
  return {
    sessionId: 's',
    circuitId: 'c',
    layoutId: 'l',
    displayDateUtc: '2026-09-21',
    laps,
  };
}

function lap(lapNumber: number, tStart: number, tEnd: number): LapRecord {
  return {
    lapNumber,
    tStart,
    tEnd,
    durationMs: tEnd - tStart,
    sectorTimes: [],
    valid: true,
    invalidReasons: [],
    quality: 'good',
  };
}

/** A chunk key as `SessionController.flushRawTrace()` mints it. */
function chunkKey(runBase: number, sequence: number): number {
  return -(runBase * TRACE_CHUNK_KEY_STRIDE + sequence);
}

function chunk(runBase: number, sequence: number, samples: LocationSample[]): RawSessionTraceChunk {
  return { key: chunkKey(runBase, sequence), runBase, sequence, samples };
}

function deps(overrides: Partial<RawSessionExportDeps> & { session: StoredSession }): RawSessionExportDeps {
  return {
    getSession: () => overrides.session,
    loadLapGnss: async () => [],
    loadUnclaimedGnss: async () => [],
    loadTelemetry: async () => [],
    calibrationStatus: () => 'validated',
    ...overrides,
  };
}

function isDocument(
  result: RawSessionExportDocument | 'session-not-found' | 'storage-unavailable',
): RawSessionExportDocument {
  if (typeof result === 'string') throw new Error(`expected a document, got ${result}`);
  return result;
}

describe('P10A H4 -- an unreclaimed fix is exported ONCE, not twice', () => {
  /**
   * REVIEWER REPRODUCTION (rawSessionExport.ts:155): the lap row write
   * succeeds, the chunk reclaim does not, and the checkpoint after them
   * does -- so the same fix sits in the lap row AND in a surviving chunk.
   *   -> uniqueInputFixes: 1, exported: 2
   */
  it('reconciles a fix held by both a lap row and a surviving chunk', async () => {
    const doc = isDocument(
      await loadRawSessionExportDocument(
        deps({
          session: session([lap(1, 0, 200)]),
          loadLapGnss: async () => [SAMPLE],
          loadUnclaimedGnss: async () => [chunk(1, 1, [SAMPLE])],
        }),
        's',
        'now',
      ),
    );

    expect(doc.gnss.totalSampleCount).toBe(1); // WAS: 2
    expect(doc.gnss.lapSampleCount).toBe(1);
    expect(doc.gnss.unclaimedSampleCount).toBe(0);
    expect(doc.gnss.reconciledDuplicateCount).toBe(1);
    expect(doc.notes.some((note) => note.includes('interrupted reclaim'))).toBe(true);
  });

  /**
   * The reviewer's explicit warning: DO NOT deduplicate on `tMono` alone --
   * it is process-relative and resets across launches. Two DIFFERENT fixes
   * that merely share a timestamp are two fixes.
   */
  it('does NOT deduplicate on tMono: a different position at the same tMono survives', async () => {
    const elsewhere: LocationSample = { tMono: 100, lat: 2, lon: 2, source: 'replay' };
    const doc = isDocument(
      await loadRawSessionExportDocument(
        deps({
          session: session([lap(1, 0, 200)]),
          loadLapGnss: async () => [SAMPLE],
          loadUnclaimedGnss: async () => [chunk(1, 1, [elsewhere])],
        }),
        's',
        'now',
      ),
    );

    expect(doc.gnss.totalSampleCount).toBe(2);
    expect(doc.gnss.reconciledDuplicateCount).toBe(0);
  });

  it('a chunk fix OUTSIDE every lap range is never a duplicate, even if identical', async () => {
    // The out-lap belongs to no lap row, which is exactly the data the
    // unclaimed trace exists to keep.
    const outLap: LocationSample = { tMono: 900, lat: 1, lon: 1, source: 'replay' };
    const doc = isDocument(
      await loadRawSessionExportDocument(
        deps({
          session: session([lap(1, 0, 200)]),
          loadLapGnss: async () => [SAMPLE],
          loadUnclaimedGnss: async () => [chunk(1, 1, [outLap])],
        }),
        's',
        'now',
      ),
    );
    expect(doc.gnss.totalSampleCount).toBe(2);
    expect(doc.gnss.reconciledDuplicateCount).toBe(0);
  });

  it('consumes matches one for one -- two genuine captures against one lap copy keeps one', async () => {
    const doc = isDocument(
      await loadRawSessionExportDocument(
        deps({
          session: session([lap(1, 0, 200)]),
          loadLapGnss: async () => [SAMPLE],
          loadUnclaimedGnss: async () => [chunk(1, 1, [SAMPLE, SAMPLE])],
        }),
        's',
        'now',
      ),
    );
    expect(doc.gnss.reconciledDuplicateCount).toBe(1);
    expect(doc.gnss.unclaimedSampleCount).toBe(1);
  });
});

describe('P10A MEDIUM -- lap 0 and orphaned positive rows are exported', () => {
  /**
   * REVIEWER REPRODUCTION (rawSessionExport.ts:416): a learned-circuit
   * session stores its learning trace at lap 0 with no completed-lap record
   * and no negative chunks.
   *   -> lapKeysRead: [], exported: 0
   */
  it('reads a stored lap-0 row that no lap record names', async () => {
    const read: number[] = [];
    const doc = isDocument(
      await loadRawSessionExportDocument(
        deps({
          session: session(),
          loadLapGnss: async (_id, lapNumber) => {
            read.push(lapNumber);
            return [SAMPLE];
          },
          listStoredGnssLapNumbers: async () => [0],
        }),
        's',
        'now',
      ),
    );

    expect(read).toEqual([0]); // WAS: []
    expect(doc.gnss.totalSampleCount).toBe(1); // WAS: 0
    expect(doc.gnss.laps[0]).toMatchObject({ lapNumber: 0, orphan: true });
    expect(doc.notes.some((note) => note.includes('no matching lap record'))).toBe(true);
  });

  it('an emptied (reclaimed) orphan row is not reported as a lap', async () => {
    const doc = isDocument(
      await loadRawSessionExportDocument(
        deps({
          session: session(),
          loadLapGnss: async () => [],
          listStoredGnssLapNumbers: async () => [0, 3],
        }),
        's',
        'now',
      ),
    );
    expect(doc.gnss.laps).toEqual([]);
  });
});

describe('P10A MEDIUM -- cross-launch ordering uses run identity, never tMono', () => {
  /**
   * REVIEWER REPRODUCTION: an earlier run holds `tMono=100000`; the resumed
   * run holds `tMono=1000`. Sorting on `tMono` puts the RESUMED sample
   * first, i.e. the drive is told backwards.
   */
  it('keeps the earlier run first even though its timestamps are larger', async () => {
    const earlier: LocationSample = { tMono: 100_000, lat: 1, lon: 1, source: 'replay' };
    const resumed: LocationSample = { tMono: 1_000, lat: 2, lon: 2, source: 'replay' };
    const doc = isDocument(
      await loadRawSessionExportDocument(
        deps({
          session: session(),
          // Deliberately handed over out of order, to prove the document
          // orders on the decoded key rather than on arrival.
          loadUnclaimedGnss: async () => [chunk(700, 1, [resumed]), chunk(500, 1, [earlier])],
        }),
        's',
        'now',
      ),
    );

    expect(doc.gnss.unclaimed.map((s) => s.tMono)).toEqual([100_000, 1_000]);
    // P10B M8: `startIndex` states where each run's block begins in
    // `unclaimed`, and the counts are those of the EXPORTED samples.
    expect(doc.gnss.runs).toEqual([
      { runBase: 500, chunkCount: 1, sampleCount: 1, startIndex: 0 },
      { runBase: 700, chunkCount: 1, sampleCount: 1, startIndex: 1 },
    ]);
    expect(doc.notes.some((note) => note.includes('2 app runs'))).toBe(true);
  });

  it('orders chunks within one run by sequence, not by arrival', async () => {
    const a: LocationSample = { tMono: 10, lat: 1, lon: 1, source: 'replay' };
    const b: LocationSample = { tMono: 20, lat: 1, lon: 2, source: 'replay' };
    const c: LocationSample = { tMono: 30, lat: 1, lon: 3, source: 'replay' };
    const doc = isDocument(
      await loadRawSessionExportDocument(
        deps({
          session: session(),
          loadUnclaimedGnss: async () => [chunk(9, 3, [c]), chunk(9, 1, [a]), chunk(9, 2, [b])],
        }),
        's',
        'now',
      ),
    );
    expect(doc.gnss.unclaimed.map((s) => s.tMono)).toEqual([10, 20, 30]);
    expect(doc.gnss.runs).toHaveLength(1);
  });

  it('the SQL reader decodes and orders the real stored keys', async () => {
    const db = await createSqlJsDatabase();
    await db.execAsync(
      'CREATE TABLE telemetry (sessionId TEXT NOT NULL, lapNumber INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (sessionId, lapNumber));',
    );
    // Inserted newest-run-first, so a reader that trusted insertion order
    // would get it wrong.
    for (const [runBase, sequence, tMono] of [
      [700, 2, 2_000],
      [700, 1, 1_000],
      [500, 2, 200_000],
      [500, 1, 100_000],
    ] as const) {
      await db.runAsync('INSERT INTO telemetry (sessionId, lapNumber, payload) VALUES (?, ?, ?)', [
        's',
        chunkKey(runBase, sequence),
        JSON.stringify([{ tMono, lat: 1, lon: 1, source: 'replay' }]),
      ]);
    }
    // An emptied (reclaimed) row contributes nothing and is not a chunk.
    await db.runAsync('INSERT INTO telemetry (sessionId, lapNumber, payload) VALUES (?, ?, ?)', [
      's',
      chunkKey(500, 3),
      '[]',
    ]);
    // A lap row, which this reader must never pick up.
    await db.runAsync('INSERT INTO telemetry (sessionId, lapNumber, payload) VALUES (?, ?, ?)', [
      's',
      1,
      JSON.stringify([{ tMono: 5, lat: 1, lon: 1, source: 'replay' }]),
    ]);
    // And a lap-0 learn trace, which `readStoredGnssLapNumbers` must find.
    await db.runAsync('INSERT INTO telemetry (sessionId, lapNumber, payload) VALUES (?, ?, ?)', [
      's',
      0,
      JSON.stringify([{ tMono: 1, lat: 1, lon: 1, source: 'replay' }]),
    ]);

    const chunks = await readUnclaimedGnssChunks(db, 's');
    expect(chunks.map((c) => [c.runBase, c.sequence])).toEqual([
      [500, 1],
      [500, 2],
      [700, 1],
      [700, 2],
    ]);
    expect(chunks.flatMap((c) => c.samples.map((s) => s.tMono))).toEqual([
      100_000, 200_000, 1_000, 2_000,
    ]);
    expect(await readStoredGnssLapNumbers(db, 's')).toEqual([0, 1]);
  });

  it('sensor rows come back in storage order, not timestamp order', async () => {
    const db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
    // The pre-crash run, then the resumed run whose tMono restarts at 0.
    for (const tMono of [100_000, 100_500, 0, 500]) {
      await db.runAsync(
        'INSERT INTO telemetry_samples (session_id, lap_number, t_mono_ms, channel, value) VALUES (?, ?, ?, ?, ?)',
        ['s', null, tMono, 'speedKph', 100],
      );
    }
    const rows = await readAllSessionTelemetry(db, 's');
    expect(rows.map((r) => r.tMonoMs)).toEqual([100_000, 100_500, 0, 500]);

    const doc = isDocument(
      await loadRawSessionExportDocument(
        deps({ session: session(), loadTelemetry: async () => rows }),
        's',
        'now',
      ),
    );
    // The document preserves it: a `t_mono_ms` sort here would interleave
    // the resumed run's first half-second into the middle of the drive.
    expect(doc.telemetry.samples.map((r) => r.tMonoMs)).toEqual([100_000, 100_500, 0, 500]);
  });
});

describe('P10A H6/H7 -- an unknown provenance is never exported as a calibrated one', () => {
  it('states UNKNOWN in the document and in the forwarded summary', async () => {
    const doc = isDocument(
      await loadRawSessionExportDocument(
        deps({ session: session(), calibrationStatus: () => 'unknown' }),
        's',
        'now',
      ),
    );

    expect(doc.session.calibrationStatus).toBe('unknown');
    // The boolean cannot say "unknown"; it must not say "calibrated" either.
    expect(doc.session.matchingUnvalidated).toBe(false);
    expect(doc.notes.some((note) => note.includes('Calibration status UNKNOWN'))).toBe(true);
    expect(buildRawSessionSummaryMarkdown(doc)).toMatch(/Calibration: \*\*unknown\*\*/);
  });

  it('a validated session says so explicitly rather than by silence', async () => {
    const doc = isDocument(
      await loadRawSessionExportDocument(
        deps({ session: session(), calibrationStatus: () => 'validated' }),
        's',
        'now',
      ),
    );
    expect(buildRawSessionSummaryMarkdown(doc)).toContain('- Calibration: validated');
  });

  it('an incomplete recording is stated in the document and the summary', async () => {
    const doc = isDocument(
      await loadRawSessionExportDocument(
        deps({
          session: session(),
          loadUnclaimedGnss: async () => [chunk(1, 1, [SAMPLE])],
          unwrittenSampleCount: () => 4,
        }),
        's',
        'now',
      ),
    );
    expect(doc.session.traceIncomplete).toBe(true);
    expect(doc.session.unwrittenSampleCount).toBe(4);
    expect(doc.notes.some((note) => note.includes('INCOMPLETE RECORDING'))).toBe(true);
    expect(buildRawSessionSummaryMarkdown(doc)).toMatch(/Recording: \*\*INCOMPLETE\*\*/);
  });
});
