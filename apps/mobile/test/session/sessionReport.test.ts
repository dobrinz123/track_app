import { describe, expect, it } from 'vitest';

import {
  SessionController,
  SqlSessionRepository,
  cleanRecognitionLap,
  driveLap,
  recordLapVerdict,
  type CalibrationAttemptRecord,
  type LapValidityVerdict,
  type SessionCalibrationStatus,
  type SqlDatabase,
} from '@circuit/core';

import { TelemetryRecorder } from '../../src/persistence/telemetryRecorder';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import {
  loadRawSessionExportDocument,
  readAllSessionTelemetry,
  readStoredGnssLapNumbers,
  readUnclaimedGnssChunks,
} from '../../src/session/rawSessionExport';
import {
  SESSION_REPORT_KIND,
  SESSION_REPORT_SCHEMA_VERSION,
  buildSessionReportMarkdown,
  loadSessionReportDocument,
  sessionReportFileName,
  type SessionReportDeps,
  type SessionReportDocument,
} from '../../src/session/sessionReport';
import { SqlSessionHistoryStore } from '../../src/session/sqlSessionHistoryStore';
import { bundled, TMR_CIRCUIT_ID } from '../support/analysisHarness';
import { FakeClock, FakeLocationProvider, feedSamples } from '../support/coreTestDoubles';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * Ticket P12 item C -- ONE COMPLETE REPORT PER SESSION.
 *
 * Driven end to end over a real `SessionController`, a real
 * `SqlSessionRepository` on a real (sql.js) database and the real
 * `TelemetryRecorder`, for the same reason `rawSessionExport.test.ts` is: the
 * defects this document exists to make visible are integration ones, and a
 * unit test of the builder alone would never execute the links that failed the
 * owner.
 */

const USER_ID = 'driver-1';

interface Harness {
  db: SqlDatabase;
  repository: SqlSessionRepository;
  controller: SessionController;
  clock: FakeClock;
  provider: FakeLocationProvider;
  recorder: () => TelemetryRecorder;
  sessionId: () => string;
}

async function harness(): Promise<Harness> {
  const circuit = bundled(TMR_CIRCUIT_ID);
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  await migrateTelemetrySchema(db);

  const clock = new FakeClock(1_000_000);
  const provider = new FakeLocationProvider();
  const controller = new SessionController({
    runtimeProfile: circuit.runtime,
    circuitProfile: circuit.profile,
    locationProvider: provider,
    clock,
    repository,
    userId: USER_ID,
    appVersion: 'p12c-report-test',
    algorithmVersion: 1,
    restartProvider: () => undefined,
    logger: () => undefined,
  });

  const sessionId = (): string => {
    const id = controller.diagnostics().sessionId;
    if (id === null) throw new Error('no session id yet');
    return id;
  };
  let recorder: TelemetryRecorder | null = null;
  return {
    db,
    repository,
    controller,
    clock,
    provider,
    recorder: () => (recorder ??= new TelemetryRecorder(db, sessionId())),
    sessionId,
  };
}

async function historyFor(h: Harness): Promise<SqlSessionHistoryStore> {
  const circuit = bundled(TMR_CIRCUIT_ID);
  const store = new SqlSessionHistoryStore(
    h.repository,
    USER_ID,
    circuit.profile.circuitId,
    circuit.profile.layoutId,
    circuit.profile.layoutVersion,
  );
  await store.refresh();
  return store;
}

/** The deps `composition.ts`'s `buildSessionReport` wires, over the real stores. */
function reportDeps(
  h: Harness,
  history: SqlSessionHistoryStore,
  overrides: Partial<SessionReportDeps> = {},
): SessionReportDeps {
  const circuit = bundled(TMR_CIRCUIT_ID);
  return {
    getSession: (id) => history.getSession(id),
    loadRaw: (id, at) =>
      loadRawSessionExportDocument(
        {
          getSession: (sid) => history.getSession(sid),
          loadLapGnss: (sid, lapNumber) => h.repository.loadTelemetry(sid, lapNumber),
          loadUnclaimedGnss: (sid) => readUnclaimedGnssChunks(h.db, sid),
          listStoredGnssLapNumbers: (sid) => readStoredGnssLapNumbers(h.db, sid),
          loadTelemetry: (sid) => readAllSessionTelemetry(h.db, sid),
          calibrationStatus: (sid): SessionCalibrationStatus =>
            history.getSession(sid)?.calibrationStatus ?? 'unknown',
          unwrittenSampleCount: (sid) => history.getSession(sid)?.unwrittenSampleCount ?? null,
          onReadError: () => undefined,
        },
        id,
        at,
      ),
    calibrationStatus: (id) => history.getSession(id)?.calibrationStatus ?? 'unknown',
    circuit: () => ({
      circuitId: circuit.profile.circuitId,
      displayName: circuit.profile.displayName,
      layoutId: circuit.profile.layoutId,
      layoutVersion: circuit.profile.layoutVersion,
      geometryStatus: circuit.profile.geometryStatus,
      sectorStatus: circuit.profile.sectorStatus,
      direction: circuit.profile.direction,
      totalLengthM: circuit.profile.totalLengthM,
      corridorWidthM: circuit.profile.corridorWidthM,
      profileSchemaVersion: circuit.profile.schemaVersion,
    }),
    listCalibrationAttempts: (id): Promise<readonly CalibrationAttemptRecord[]> =>
      h.repository.listCalibrationAttempts(id),
    listLapVerdicts: (id): Promise<readonly LapValidityVerdict[]> =>
      h.repository.listLapValidityVerdicts(id),
    extras: async () => [],
    onReadError: () => undefined,
    ...overrides,
  };
}

const isDocument = (value: unknown): SessionReportDocument => {
  if (typeof value === 'string') throw new Error(`expected a document, got "${value}"`);
  return value as SessionReportDocument;
};

function stateOf(doc: SessionReportDocument, part: string): string {
  return doc.availability.find((entry) => entry.part === part)?.state ?? 'missing-entry';
}

describe('P12 item C -- a zero-lap session still produces a complete report', () => {
  it('carries the drive, the calibration attempt and the honest availability of every part', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);

    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 9_003));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();

    const id = h.sessionId();
    h.recorder().record({ channel: 'speedKph', value: 121.5, tMonoMs: 10 }, null);
    h.recorder().record({ channel: 'yawRateDps', value: -12.5, tMonoMs: 20 }, null);
    await h.recorder().endSession();

    const drive = driveLap(circuit.profile, { seed: 9_004 });
    feedSamples(h.clock, h.provider, drive.slice(0, Math.floor(drive.length * 0.6)));
    await h.controller.endSession();

    const history = await historyFor(h);
    const doc = isDocument(
      await loadSessionReportDocument(reportDeps(h, history), id, '2026-09-28T09:15:00.000Z'),
    );

    expect(doc.kind).toBe(SESSION_REPORT_KIND);
    expect(doc.schemaVersion).toBe(SESSION_REPORT_SCHEMA_VERSION);
    expect(doc.generatedAtUtc).toBe('2026-09-28T09:15:00.000Z');
    expect(doc.session.sessionId).toBe(id);
    expect(doc.session.lapCount).toBe(0);

    // Circuit identity, layout version and geometry status -- item C names all three.
    expect(doc.circuit).not.toBeNull();
    expect(doc.circuit!.layoutVersion).toBe(circuit.profile.layoutVersion);
    expect(doc.circuit!.geometryStatus).toBe(circuit.profile.geometryStatus);

    // The whole drive is here, in the unclaimed chunks a zero-lap session produces.
    expect(doc.raw).not.toBeNull();
    expect(doc.raw!.gnss.unclaimedSampleCount).toBeGreaterThan(100);
    expect(doc.raw!.gnss.lapSampleCount).toBe(0);
    // Every telemetry channel, including yawRateDps.
    expect(doc.raw!.telemetry.channels).toContain('yawRateDps');
    expect(doc.raw!.telemetry.channels).toContain('speedKph');

    // Item B: the calibration attempt of this session, from storage.
    expect(doc.calibrationAttempts).toHaveLength(1);
    expect(doc.calibrationAttempts[0]!.outcome).toBe('accepted');
    expect(doc.calibrationAttempts[0]!.explanation.length).toBeGreaterThan(0);

    // Trace completeness is stated, not inferred.
    expect(doc.recording.unwrittenSampleCount).not.toBeNull();
    expect(doc.recording.traceIncomplete).toBe(false);

    // And every part says what it is.
    expect(stateOf(doc, 'circuit')).toBe('present');
    expect(stateOf(doc, 'calibrationAttempts')).toBe('present');
    expect(stateOf(doc, 'raw')).toBe('present');
    // Read, and genuinely nothing -- NOT the same as unavailable.
    expect(stateOf(doc, 'lapVerdicts')).toBe('empty');
    expect(stateOf(doc, 'laps')).toBe('empty');
    expect(doc.notes.join('\n')).toContain('completed no lap');
  });
});

describe('P12 items A+C -- every lap carries the owner\'s verdict, answered or not', () => {
  it('shows agreed, disagreed and unanswered as three different things', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);

    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 9_011));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();
    const id = h.sessionId();
    feedSamples(
      h.clock,
      h.provider,
      driveLap(circuit.profile, { seed: 9_012, lapCount: 3, sampleRateHz: 5 }),
    );
    await h.controller.endSession();

    const history = await historyFor(h);
    const laps = history.getSession(id)!.laps;
    expect(laps.length).toBeGreaterThanOrEqual(2);

    // The owner answers two of them and leaves the rest.
    await h.repository.saveLapValidityVerdict(
      recordLapVerdict({
        sessionId: id,
        lap: laps[0]!,
        decision: 'agreed',
        answeredAtUtc: '2026-09-28T09:10:00.000Z',
      }),
    );
    await h.repository.saveLapValidityVerdict(
      recordLapVerdict({
        sessionId: id,
        lap: laps[1]!,
        decision: 'disagreed',
        answeredAtUtc: '2026-09-28T09:11:00.000Z',
        note: 'I never went through the pits',
      }),
    );

    const doc = isDocument(
      await loadSessionReportDocument(reportDeps(h, history), id, '2026-09-28T09:15:00.000Z'),
    );

    expect(doc.laps).toHaveLength(laps.length);
    expect(doc.laps[0]!.verdict.answer).toBe('agreed');
    expect(doc.laps[0]!.verdict.answeredAtUtc).toBe('2026-09-28T09:10:00.000Z');
    expect(doc.laps[1]!.verdict.answer).toBe('disagreed');
    expect(doc.laps[1]!.verdict.note).toBe('I never went through the pits');
    // The app's own verdict is snapshotted beside the owner's.
    expect(doc.laps[0]!.verdict.appValid).toBe(laps[0]!.valid);
    expect(doc.laps[0]!.verdict.appInvalidReasons).toEqual(laps[0]!.invalidReasons);

    const unanswered = doc.laps.filter((entry) => entry.verdict.answer === 'unanswered');
    expect(unanswered.length).toBe(laps.length - 2);
    for (const entry of unanswered) {
      expect(entry.verdict.answeredAtUtc).toBeNull();
      expect(entry.verdict.answerRevision).toBe(0);
    }

    expect(doc.verdictSummary.agreed).toBe(1);
    expect(doc.verdictSummary.disagreed).toBe(1);
    expect(doc.verdictSummary.unanswered).toBe(laps.length - 2);
    if (doc.verdictSummary.unanswered > 0) {
      expect(doc.notes.join('\n')).toContain('never judged by the owner');
    }

    // The markdown companion states the same figures.
    const markdown = buildSessionReportMarkdown(doc);
    expect(markdown).toContain('Owner verdicts: 1 agreed, 1 disagreed');
    expect(markdown).toContain('owner: disagreed');
    expect(sessionReportFileName(doc, 'json')).toMatch(/^trace-report-/);
    expect(sessionReportFileName(doc, 'md')).toMatch(/\.md$/);
  });
});

describe('P12 item C -- "unavailable" is never presented as "none"', () => {
  it('a device that cannot read verdicts says so, and does not report the laps as unanswered-by-the-owner', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);
    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 9_021));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();
    const id = h.sessionId();
    feedSamples(h.clock, h.provider, driveLap(circuit.profile, { seed: 9_022, lapCount: 2, sampleRateHz: 5 }));
    await h.controller.endSession();
    const history = await historyFor(h);

    const deps = reportDeps(h, history);
    // The store cannot answer at all -- the dep is ABSENT, not empty.
    delete deps.listLapVerdicts;
    delete deps.listCalibrationAttempts;
    const doc = isDocument(await loadSessionReportDocument(deps, id, '2026-09-28T09:15:00.000Z'));

    expect(stateOf(doc, 'lapVerdicts')).toBe('unavailable');
    expect(stateOf(doc, 'calibrationAttempts')).toBe('unavailable');
    expect(doc.notes.join('\n')).toContain('could NOT be read on this device');
    // The markdown must not quietly read as "no attempts were made".
    expect(buildSessionReportMarkdown(doc)).toContain('Not readable on this device');
  });

  it('a read that THROWS is reported as failed, with its reason, and the rest of the report still ships', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);
    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 9_031));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();
    const id = h.sessionId();
    feedSamples(h.clock, h.provider, driveLap(circuit.profile, { seed: 9_032, sampleRateHz: 5 }));
    await h.controller.endSession();
    const history = await historyFor(h);

    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps(h, history, {
          listLapVerdicts: () => Promise.reject(new Error('database is locked')),
        }),
        id,
        '2026-09-28T09:15:00.000Z',
      ),
    );

    expect(stateOf(doc, 'lapVerdicts')).toBe('failed');
    expect(doc.availability.find((entry) => entry.part === 'lapVerdicts')?.detail).toContain(
      'database is locked',
    );
    expect(doc.notes.join('\n')).toContain('database is locked');
    // Everything else survived.
    expect(doc.raw).not.toBeNull();
    expect(stateOf(doc, 'calibrationAttempts')).toBe('present');
  });

  it('a session that is not on the device comes back as a NAMED reason', async () => {
    const h = await harness();
    const history = await historyFor(h);
    const result = await loadSessionReportDocument(
      reportDeps(h, history),
      'never-driven',
      '2026-09-28T09:15:00.000Z',
    );
    expect(result).toBe('session-not-found');
  });
});
