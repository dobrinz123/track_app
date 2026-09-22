import { describe, expect, it } from 'vitest';

import type {
  CalibrationAttemptRecord,
  LapRecord,
  LocationSample,
  SessionCalibrationStatus,
} from '@circuit/core';

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
 * Ticket P15 F1 (Codex P14 round, sessionReport.ts:374) -- THE PROSE
 * CONTRADICTED THE FLAGS.
 *
 * P14 made `availability` four-valued so a failure can never read as `empty`.
 * The flags came out right and the SENTENCES did not: a section marked
 * `failed` still produced "were never judged by the owner" and "No
 * calibration attempt was recorded", and a calibration conclusion that failed
 * to persist still had its provisional row described as "never concluded".
 *
 * The owner reads the markdown summary first, so the half of the document a
 * human reads told him the opposite of the half a machine reads -- exactly
 * where it is most likely to mislead.
 *
 * EVERY note, verdict label and summary sentence is now derived from the
 * section's AVAILABILITY, not from the emptiness of its collection. Both
 * directions are asserted here: a `failed` section must never read as
 * nothing, and a genuinely `empty` one must still read as nothing.
 */

const SESSION_ID = 'driver-1--p15';

function lap(lapNumber: number): LapRecord {
  return {
    lapNumber,
    tStart: 0,
    tEnd: 91_000,
    durationMs: 91_000,
    sectorTimes: [],
    valid: true,
    invalidReasons: [],
    quality: 'clean',
  } as unknown as LapRecord;
}

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

function attempt(overrides: Partial<CalibrationAttemptRecord> = {}): CalibrationAttemptRecord {
  return {
    attemptId: 'attempt-1',
    sessionId: SESSION_ID,
    circuitId: 'tmr',
    layoutId: 'tmr-full',
    startedAtUtc: '2026-09-22T09:00:00.000Z',
    outcome: 'accepted',
    concluded: true,
    coverageFraction: 0.987,
    durationMs: 90_000,
    samplesFed: 91,
    explanation: ['Calibration was ACCEPTED.'],
    ...overrides,
  } as unknown as CalibrationAttemptRecord;
}

// ---------------------------------------------------------------------------
// F1, direction 1: a FAILED section must never read as nothing.
// ---------------------------------------------------------------------------

describe('P15 F1 -- a failed section never reads as "nothing was there"', () => {
  it('does not say laps "were never judged" when the verdict rows could not be decoded', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({
          getSession: () => storedSession({ laps: [lap(1)] }),
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

    const markdown = buildSessionReportMarkdown(doc);
    const prose = `${doc.notes.join('\n')}\n${markdown}`;

    // BEFORE: "1 of 1 lap(s) were never judged by the owner."
    expect(prose).not.toContain('were never judged by the owner');
    // It still SAYS what it knows -- it just says the right thing.
    expect(doc.notes.join('\n')).toContain('could NOT be read');
    expect(markdown).toContain('owner: NOT READABLE');
    expect(markdown).not.toMatch(/^- Owner verdicts: 0 agreed, 0 disagreed, 1 unanswered$/m);
    expect(markdown).toContain('not readable');
  });

  it('does not say "No calibration attempt was recorded" when the attempt rows failed to read', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({
          listCalibrationAttempts: () => Promise.resolve([]),
          readFailures: () =>
            Promise.resolve([
              { part: 'calibrationAttempts', detail: '1 stored attempt row could not be decoded' },
            ]),
        }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    const prose = `${doc.notes.join('\n')}\n${buildSessionReportMarkdown(doc)}`;

    // BEFORE: "No calibration attempt was recorded for this session."
    expect(prose).not.toContain('No calibration attempt was recorded');
    expect(doc.notes.join('\n')).toContain('could NOT be read');
    expect(buildSessionReportMarkdown(doc)).toContain('Not readable on this device');
  });

  it('describes a provisional row as unconfirmed, not as "never concluded", when its conclusion failed to persist', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({
          listCalibrationAttempts: () => Promise.resolve([attempt({ concluded: false })]),
          readFailures: () =>
            Promise.resolve([
              {
                part: 'calibrationAttempts',
                detail:
                  '1 calibration record(s) for this session could NOT be written to storage. The stored rows are earlier, PROVISIONAL ones.',
              },
            ]),
        }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    const markdown = buildSessionReportMarkdown(doc);
    const prose = `${doc.notes.join('\n')}\n${markdown}`;

    // BEFORE: "1 calibration attempt(s) never concluded: the Learn lap was
    // still running when the app stopped." -- said about an attempt that DID
    // conclude and whose conclusion did not reach storage.
    expect(prose).not.toContain('never concluded');
    expect(markdown).toContain('PROVISIONAL');
    expect(doc.notes.join('\n')).toContain('provisional');
  });

  it('does not print a confident zero for GNSS or telemetry when the raw reads threw', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({
          loadRaw: (id, at) =>
            loadRawSessionExportDocument(
              rawDeps({
                loadUnclaimedGnss: () => Promise.reject(new Error('gnss chunk table is locked')),
                loadTelemetry: () => Promise.reject(new Error('telemetry table is corrupt')),
              }),
              id,
              at,
            ),
        }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    const markdown = buildSessionReportMarkdown(doc);
    // BEFORE: "- GNSS fixes: 0 (0 in laps, 0 unclaimed)" / "- Telemetry samples: 0"
    // stated flat, next to an availability block saying both reads failed.
    expect(markdown).not.toMatch(/^- GNSS fixes: 0 \(0 in laps, 0 unclaimed\)$/m);
    expect(markdown).not.toMatch(/^- Telemetry samples: 0$/m);
    // The counts survive -- what is added is that they are a floor.
    expect(markdown).toContain('GNSS fixes: 0');
    expect(markdown).toContain('could not be read');
  });

  it('says the tool roll-call failed rather than "no tool output was enumerated"', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({ extras: () => Promise.reject(new Error('extras collector threw')) }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    const markdown = buildSessionReportMarkdown(doc);
    expect(markdown).not.toContain('No tool output was enumerated');
    expect(markdown).toContain('could not be read');
  });

  it('separates a circuit that could not be READ from one that could not be identified', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({
          circuit: () => {
            throw new Error('circuit catalog is unreadable');
          },
        }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    const markdown = buildSessionReportMarkdown(doc);
    expect(markdown).not.toContain('the device could not identify this circuit');
    expect(markdown).toContain('could not be read');
  });

  it('says the verdicts are unreadable ON THIS DEVICE when the store cannot be asked at all', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({ getSession: () => storedSession({ laps: [lap(1)] }) }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    const markdown = buildSessionReportMarkdown(doc);
    expect(doc.availability.find((row) => row.part === 'lapVerdicts')?.state).toBe('unavailable');
    expect(`${doc.notes.join('\n')}\n${markdown}`).not.toContain('were never judged by the owner');
    expect(markdown).toContain('not readable');
  });
});

// ---------------------------------------------------------------------------
// F1, direction 2: a genuinely EMPTY section must still read as nothing.
// ---------------------------------------------------------------------------

describe('P15 F1 -- a genuinely empty section still reads as nothing was recorded', () => {
  it('still says no calibration attempt was recorded when the read succeeded and found none', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({ listCalibrationAttempts: () => Promise.resolve([]) }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    expect(doc.availability.find((row) => row.part === 'calibrationAttempts')?.state).toBe('empty');
    expect(doc.notes.join('\n')).toContain('No calibration attempt was recorded');
    expect(buildSessionReportMarkdown(doc)).toContain('- None recorded.');
  });

  it('still says laps were never judged when the verdict read succeeded and found none', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({
          getSession: () => storedSession({ laps: [lap(1)] }),
          listLapVerdicts: () => Promise.resolve([]),
        }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    expect(doc.availability.find((row) => row.part === 'lapVerdicts')?.state).toBe('empty');
    expect(doc.notes.join('\n')).toContain('were never judged by the owner');
    const markdown = buildSessionReportMarkdown(doc);
    expect(markdown).toContain('owner: not answered');
    expect(markdown).toContain('- Owner verdicts: 0 agreed, 0 disagreed, 1 unanswered');
  });

  it('still says no lap was completed for a healthy zero-lap session', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({ listLapVerdicts: () => Promise.resolve([]) }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    expect(doc.availability.find((row) => row.part === 'laps')?.state).toBe('empty');
    expect(buildSessionReportMarkdown(doc)).toContain('- No lap was completed.');
  });

  it('still says "never concluded" for an attempt that genuinely never concluded', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({
          listCalibrationAttempts: () => Promise.resolve([attempt({ concluded: false })]),
        }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    expect(doc.availability.find((row) => row.part === 'calibrationAttempts')?.state).toBe('present');
    expect(doc.notes.join('\n')).toContain('never concluded');
    expect(buildSessionReportMarkdown(doc)).toContain('(never concluded)');
  });

  it('still prints flat GNSS and telemetry counts when every raw read succeeded', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(reportDeps(), SESSION_ID, '2026-09-22T12:00:00.000Z'),
    );

    const markdown = buildSessionReportMarkdown(doc);
    expect(markdown).toMatch(/^- GNSS fixes: 0 \(0 in laps, 0 unclaimed\)$/m);
    expect(markdown).toMatch(/^- Telemetry samples: 0$/m);
  });

  it('still says "None" for a tool roll-call that was read and was empty', async () => {
    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({ extras: () => Promise.resolve([]) }),
        SESSION_ID,
        '2026-09-22T12:00:00.000Z',
      ),
    );

    expect(doc.availability.find((row) => row.part === 'extras')?.state).toBe('empty');
    expect(buildSessionReportMarkdown(doc)).toContain('No tool output was enumerated');
  });
});
