import { describe, expect, it } from 'vitest';

import type { LocationSample, SessionCalibrationStatus } from '@circuit/core';

import type { StoredSession } from '../../src/session/mockHistory';
import {
  loadRawSessionExportDocument,
  type RawSessionExportDeps,
  type RawSessionTraceChunk,
} from '../../src/session/rawSessionExport';
import {
  buildSessionReportMarkdown,
  loadSessionReportDocument,
  type SessionReportDeps,
  type SessionReportDocument,
} from '../../src/session/sessionReport';

/**
 * Ticket P14 H2 + H3 (Codex P13 round, sessionReport.ts:613 and :659).
 *
 * H2 -- A READ THAT THREW REPORTED AS PRESENT-AND-EMPTY. The raw loader caught
 * every component read's failure, logged it, and returned empty arrays, so a
 * zero-lap session whose GNSS and OBD reads BOTH threw produced a document the
 * report marked `raw: present` -- with neither failure anywhere in
 * `availability`. A reader had no way to tell "the car reported nothing" from
 * "we could not read what the car reported".
 *
 * H3 -- AN INTERRUPTED SESSION REPORTED AS COMPLETE. `unwrittenSampleCount: 0`
 * on the stored row was read as proof that no captured fix went unwritten. It
 * is nothing of the kind while the session is still recording: a captured fix
 * can be sitting in the buffer, and a crash there loses it. The document said
 * "Recording: complete (no captured fix went unwritten)" about a truncated
 * drive.
 */

const SESSION_ID = 'driver-1--p14';

function storedSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId: SESSION_ID,
    circuitId: 'tmr',
    layoutId: 'tmr-full',
    displayDateUtc: '2026-09-22T09:00:00.000Z',
    laps: [],
    calibrationStatus: 'validated',
    ...overrides,
  } as StoredSession;
}

function rawDeps(overrides: Partial<RawSessionExportDeps> = {}): RawSessionExportDeps {
  return {
    getSession: () => storedSession(),
    loadLapGnss: (): Promise<LocationSample[]> => Promise.resolve([]),
    loadUnclaimedGnss: (): Promise<readonly RawSessionTraceChunk[]> => Promise.resolve([]),
    loadTelemetry: () => Promise.resolve([]),
    calibrationStatus: (): SessionCalibrationStatus => 'validated',
    onReadError: () => undefined,
    ...overrides,
  };
}

function reportDeps(overrides: Partial<SessionReportDeps> = {}): SessionReportDeps {
  return {
    getSession: () => storedSession(),
    loadRaw: (id, at) => loadRawSessionExportDocument(rawDeps(), id, at),
    calibrationStatus: (): SessionCalibrationStatus => 'validated',
    circuit: () => null,
    onReadError: () => undefined,
    ...overrides,
  };
}

const isDocument = (value: unknown): SessionReportDocument => {
  if (typeof value === 'string') throw new Error(`expected a document, got "${value}"`);
  return value as SessionReportDocument;
};

function entry(doc: SessionReportDocument, part: string): { state: string; detail?: string } {
  return doc.availability.find((row) => row.part === part) ?? { state: 'missing-entry' };
}

describe('P14 H2 -- a raw component read that threw appears in availability', () => {
  it('records the GNSS and OBD failures instead of reporting an empty, present record', async () => {
    const deps = reportDeps({
      loadRaw: (id, at) =>
        loadRawSessionExportDocument(
          rawDeps({
            loadUnclaimedGnss: () => Promise.reject(new Error('gnss chunk table is locked')),
            loadTelemetry: () => Promise.reject(new Error('telemetry table is corrupt')),
          }),
          id,
          at,
        ),
    });

    const doc = isDocument(await loadSessionReportDocument(deps, SESSION_ID, '2026-09-22T12:00:00.000Z'));

    // BEFORE: `raw: present`, and not one word about either failure.
    expect(entry(doc, 'raw').state).toBe('failed');
    expect(entry(doc, 'raw:gnss:unclaimed').state).toBe('failed');
    expect(entry(doc, 'raw:gnss:unclaimed').detail).toContain('gnss chunk table is locked');
    expect(entry(doc, 'raw:telemetry').state).toBe('failed');
    expect(entry(doc, 'raw:telemetry').detail).toContain('telemetry table is corrupt');

    // The document still carries what it DID read -- the claim is not removed,
    // only qualified.
    expect(doc.raw).not.toBeNull();
    expect(doc.raw!.readFailures.map((failure) => failure.part).sort()).toEqual([
      'gnss:unclaimed',
      'telemetry',
    ]);

    const markdown = buildSessionReportMarkdown(doc);
    expect(markdown).toContain('raw:telemetry: failed');
    expect(doc.notes.join('\n')).toContain('gnss chunk table is locked');
  });

  it('still reports a genuinely empty raw record as present, with no failures', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(reportDeps(), SESSION_ID, '2026-09-22T12:00:00.000Z'),
    );

    expect(entry(doc, 'raw').state).toBe('present');
    expect(doc.raw!.readFailures).toEqual([]);
    expect(doc.availability.some((row) => row.part.startsWith('raw:'))).toBe(false);
  });
});

describe('P14 H3 -- recording completeness is UNKNOWN for a session that never finished', () => {
  it('does not call an interrupted zero-unwritten session complete', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({
          getSession: () =>
            storedSession({ unwrittenSampleCount: 0, failedWriteCount: 0, recordingFinalized: false }),
        }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    expect(doc.recording.recordingFinalized).toBe(false);
    expect(doc.recording.completeness).toBe('unknown');
    expect(doc.recording.traceIncomplete).toBe(false);
    // BEFORE: "Recording: complete (no captured fix went unwritten)".
    const markdown = buildSessionReportMarkdown(doc);
    expect(markdown).not.toContain('complete (no captured fix went unwritten)');
    expect(markdown).toContain('Recording completeness: **unknown**');
    expect(doc.notes.join('\n')).toContain('never finalised');
  });

  it('calls a finalised zero-unwritten session complete, because it is', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({
          getSession: () =>
            storedSession({ unwrittenSampleCount: 0, failedWriteCount: 0, recordingFinalized: true }),
        }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    expect(doc.recording.completeness).toBe('complete');
    expect(buildSessionReportMarkdown(doc)).toContain('complete (no captured fix went unwritten)');
  });

  it('still calls a known-short trace INCOMPLETE, finalised or not', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({
          getSession: () =>
            storedSession({ unwrittenSampleCount: 7, failedWriteCount: 2, recordingFinalized: true }),
        }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    expect(doc.recording.completeness).toBe('incomplete');
    expect(doc.recording.traceIncomplete).toBe(true);
    expect(buildSessionReportMarkdown(doc)).toContain('INCOMPLETE');
  });

  it('is UNKNOWN for a session recorded before any of this was tracked', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(reportDeps(), SESSION_ID, '2026-09-22T12:00:00.000Z'),
    );

    expect(doc.recording.completeness).toBe('unknown');
    expect(doc.recording.recordingFinalized).toBeNull();
  });
});

describe('P14 H5 (report half) -- an unreadable section reads FAILED, never empty', () => {
  it('marks lapVerdicts failed when the store reports rows it could not decode', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({
          listLapVerdicts: () => Promise.resolve([]),
          readFailures: () =>
            Promise.resolve([
              { part: 'lapVerdicts', detail: '2 stored verdict row(s) could not be decoded' },
            ]),
        }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    expect(entry(doc, 'lapVerdicts').state).toBe('failed');
    expect(entry(doc, 'lapVerdicts').detail).toContain('could not be decoded');
    expect(doc.notes.join('\n')).toContain('lapVerdicts');
  });

  it('leaves a genuinely empty section EMPTY when nothing failed', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({ listLapVerdicts: () => Promise.resolve([]) }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    expect(entry(doc, 'lapVerdicts').state).toBe('empty');
  });
});
