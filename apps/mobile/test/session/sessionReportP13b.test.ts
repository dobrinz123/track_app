import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SessionController,
  SqlSessionRepository,
  cleanRecognitionLap,
  driveLap,
  type CalibrationAttemptRecord,
  type LapValidityVerdict,
  type SessionCalibrationStatus,
  type SqlDatabase,
} from '@circuit/core';

import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import {
  loadRawSessionExportDocument,
  readAllSessionTelemetry,
  readStoredGnssLapNumbers,
  readUnclaimedGnssChunks,
} from '../../src/session/rawSessionExport';
import {
  buildSessionReportMarkdown,
  loadSessionReportDocument,
  sessionReportFileName,
  type SessionReportDeps,
  type SessionReportDocument,
} from '../../src/session/sessionReport';
import { collectReportExtras, type ToolExtraSpec } from '../../src/session/reportExtras';
import { createLapVerdictStore } from '../../src/session/lapVerdictStore';
import { buildLapVerdictRows, summarizeLapVerdictRows } from '../../src/session/lapVerdictViewModel';
import { buildCalibrationReport } from '../../src/session/calibrationReportViewModel';
import { SqlSessionHistoryStore } from '../../src/session/sqlSessionHistoryStore';
import { bundled, TMR_CIRCUIT_ID } from '../support/analysisHarness';
import { FakeClock, FakeLocationProvider, feedSamples } from '../support/coreTestDoubles';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * Ticket P13B -- the three documents the owner's test protocol turns on, built
 * end to end over a real `SessionController`, a real `SqlSessionRepository` on
 * a real (sql.js) database, and the real lap-verdict store the screens call.
 *
 * The zero-lap case, the mixed valid/invalid case with verdicts recorded, and
 * the CANCELLED calibration. Each one is written to `.foreman/scratch/` as the
 * evidence the ticket asks for, because the claim "the export is complete" is
 * only worth what the actual bytes say.
 *
 * Plus the one property no unit test of the builder can establish: a verdict
 * recorded through the store the SCREEN calls survives the process that
 * recorded it and comes back out of a freshly built export.
 */

const USER_ID = 'driver-1';
/**
 * Where the exported bytes land. Defaults to the OS temp directory so an
 * ordinary `npm test` writes nothing into the repository; point
 * `P13B_EVIDENCE_DIR` somewhere to collect the files for a review.
 */
const EVIDENCE_DIR = process.env.P13B_EVIDENCE_DIR ?? resolve(tmpdir(), 'p13b-exports');

interface Harness {
  db: SqlDatabase;
  repository: SqlSessionRepository;
  controller: SessionController;
  clock: FakeClock;
  provider: FakeLocationProvider;
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
    appVersion: 'p13b-report-test',
    algorithmVersion: 1,
    restartProvider: () => undefined,
    logger: () => undefined,
  });

  return {
    db,
    repository,
    controller,
    clock,
    provider,
    sessionId: () => {
      const id = controller.diagnostics().sessionId;
      if (id === null) throw new Error('no session id yet');
      return id;
    },
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

/** The roll-call `composition.ts` builds, with every state represented. */
function toolSpecs(): ToolExtraSpec[] {
  return [
    {
      source: 'trackdayRecord',
      description: 'What the trackday suggestion stage did in this session.',
      read: () => ({ state: 'empty', detail: 'no cue move and no pit suggestion in this session' }),
    },
    {
      source: 'analysis',
      description: 'The post-session corner analysis for this session.',
      read: () => ({ state: 'empty', detail: 'the analysis has not been run for this session' }),
    },
    {
      source: 'learnedCircuit',
      description: 'The on-device learned geometry this session was driven on.',
      read: () => ({ state: 'empty', detail: 'this session ran on catalog geometry' }),
    },
    {
      source: 'vehicleProfile',
      description: 'The active vehicle profile and its confirmed channel bindings.',
      read: () => ({ state: 'present', data: { profileId: 'supra-b58', bindings: [] } }),
    },
    {
      source: 'signalFinder',
      description: 'The Signal Finder’s own sweep documents.',
      read: () => ({ state: 'unavailable', detail: 'the Signal Finder keeps no per-session record' }),
    },
  ];
}

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
    extras: () => Promise.resolve(collectReportExtras(toolSpecs())),
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

/** Writes the actual exported bytes out, so the ticket's "show the JSON" is met by the JSON. */
function saveEvidence(name: string, doc: SessionReportDocument): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(resolve(EVIDENCE_DIR, `${name}.json`), JSON.stringify(doc, null, 2), 'utf8');
  writeFileSync(resolve(EVIDENCE_DIR, `${name}.md`), buildSessionReportMarkdown(doc), 'utf8');
}

describe('P13B item 4 -- every tool has a row, whatever it had to say', () => {
  it('names each tool in `availability`, distinguishing empty from unavailable', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);
    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 13_001));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();
    const id = h.sessionId();
    feedSamples(h.clock, h.provider, driveLap(circuit.profile, { seed: 13_002, sampleRateHz: 5 }));
    await h.controller.endSession();

    const history = await historyFor(h);
    const doc = isDocument(
      await loadSessionReportDocument(reportDeps(h, history), id, '2026-09-22T12:00:00.000Z'),
    );

    for (const source of ['trackdayRecord', 'analysis', 'learnedCircuit', 'vehicleProfile', 'signalFinder']) {
      expect(
        doc.extras.some((extra) => extra.source === source),
        `${source} is missing from extras`,
      ).toBe(true);
      expect(stateOf(doc, `extras:${source}`), `${source} has no availability row`).not.toBe(
        'missing-entry',
      );
    }
    expect(stateOf(doc, 'extras:analysis')).toBe('empty');
    expect(stateOf(doc, 'extras:signalFinder')).toBe('unavailable');
    expect(stateOf(doc, 'extras:vehicleProfile')).toBe('present');

    // The markdown names them too -- a reader must not have to parse JSON to
    // find out that a tool had nothing.
    const markdown = buildSessionReportMarkdown(doc);
    expect(markdown).toContain('## Other tools');
    expect(markdown).toContain('signalFinder: unavailable');
    expect(markdown).toContain('analysis: empty');
  });
});

describe('P13B -- the three documents the protocol turns on', () => {
  it('CASE 1: a session with ZERO laps still exports the whole drive', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);

    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 13_101));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();
    const id = h.sessionId();
    // Driven, but never across the line: no lap is ever timed.
    const drive = driveLap(circuit.profile, { seed: 13_102 });
    feedSamples(h.clock, h.provider, drive.slice(0, Math.floor(drive.length * 0.6)));
    await h.controller.endSession();

    const history = await historyFor(h);
    const doc = isDocument(
      await loadSessionReportDocument(reportDeps(h, history), id, '2026-09-22T12:00:00.000Z'),
    );
    saveEvidence('case1-zero-lap', doc);

    expect(doc.session.lapCount).toBe(0);
    expect(doc.laps).toHaveLength(0);
    expect(doc.verdictSummary).toEqual({ agreed: 0, disagreed: 0, unanswered: 0 });
    // The drive is NOT lost: it is in the unclaimed chunks.
    expect(doc.raw!.gnss.unclaimedSampleCount).toBeGreaterThan(100);
    expect(stateOf(doc, 'laps')).toBe('empty');
    expect(stateOf(doc, 'lapVerdicts')).toBe('empty');
    expect(doc.notes.join('\n')).toContain('completed no lap');
    // And the one-tap file name is well formed for a zero-lap session too.
    expect(sessionReportFileName(doc, 'json')).toMatch(/^trace-report-.+\.json$/);
  });

  it('CASE 2: valid AND invalid laps, with verdicts recorded through the store the screen calls', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);

    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 13_201));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();
    const id = h.sessionId();
    // A pause long enough to break a lap: lap 1 is clean, the lap the pause
    // lands in is marked PAUSE_GAP. This is the case the whole build exists
    // for -- a verdict on a VALID lap and a verdict on an INVALID one.
    const samples = driveLap(circuit.profile, { seed: 13_202, lapCount: 3, sampleRateHz: 5 });
    const split = Math.floor(samples.length * 0.45);
    feedSamples(h.clock, h.provider, samples.slice(0, split));
    h.controller.pause();
    h.clock.advance(45_000);
    h.controller.resume();
    feedSamples(h.clock, h.provider, samples.slice(split));
    await h.controller.endSession();

    const history = await historyFor(h);
    const laps = history.getSession(id)!.laps;
    expect(laps.length).toBeGreaterThanOrEqual(2);
    const validLap = laps.find((lap) => lap.valid);
    const invalidLap = laps.find((lap) => !lap.valid);
    expect(validLap, 'the fixture produced no VALID lap').toBeDefined();
    expect(invalidLap, 'the fixture produced no INVALID lap').toBeDefined();
    expect(invalidLap!.invalidReasons.length).toBeGreaterThan(0);

    // The REAL store the screens use, not a direct repository write.
    const store = createLapVerdictStore({ repository: () => h.repository, onError: () => undefined });
    expect(store.support()).toBe('supported');
    // He agrees with the app on the lap it called valid...
    const first = await store.recordVerdict({
      sessionId: id,
      lap: validLap!,
      decision: 'agreed',
      answeredAtUtc: '2026-09-22T11:58:00.000Z',
    });
    // ...and disagrees with it on the lap it called invalid.
    const second = await store.recordVerdict({
      sessionId: id,
      lap: invalidLap!,
      decision: 'disagreed',
      answeredAtUtc: '2026-09-22T11:59:00.000Z',
      note: 'I never went through the pits',
    });
    expect(first.state).toBe('stored');
    expect(second.state).toBe('stored');

    const doc = isDocument(
      await loadSessionReportDocument(reportDeps(h, history), id, '2026-09-22T12:00:00.000Z'),
    );
    saveEvidence('case2-laps-and-verdicts', doc);

    expect(doc.laps).toHaveLength(laps.length);
    const agreedEntry = doc.laps.find((entry) => entry.lap.lapNumber === validLap!.lapNumber)!;
    const disagreedEntry = doc.laps.find((entry) => entry.lap.lapNumber === invalidLap!.lapNumber)!;
    expect(agreedEntry.verdict.answer).toBe('agreed');
    expect(agreedEntry.verdict.appValid).toBe(true);
    expect(disagreedEntry.verdict.answer).toBe('disagreed');
    expect(disagreedEntry.verdict.appValid).toBe(false);
    // The app's reasons are snapshotted with the answer, so the row still says
    // what he was disagreeing WITH after a rules change.
    expect(disagreedEntry.verdict.appInvalidReasons).toEqual(invalidLap!.invalidReasons);
    expect(disagreedEntry.verdict.note).toBe('I never went through the pits');
    expect(doc.verdictSummary.agreed).toBe(1);
    expect(doc.verdictSummary.disagreed).toBe(1);
    expect(doc.verdictSummary.unanswered).toBe(laps.length - 2);
    // Both kinds of lap are in the document.
    expect(doc.laps.some((entry) => entry.lap.valid)).toBe(true);
    expect(doc.laps.some((entry) => !entry.lap.valid)).toBe(true);

    // The screen's own row model agrees with the document, from the same data.
    const rows = buildLapVerdictRows(laps, store.forSession(id, laps));
    expect(summarizeLapVerdictRows(rows)).toEqual(doc.verdictSummary);
  });

  it('CASE 3: a CANCELLED calibration is exported as a failed attempt, with its reasons', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);

    await h.controller.start('calibration');
    const recognition = cleanRecognitionLap(circuit.profile, 13_301);
    // Half a Learn lap, then the driver gives up on it.
    feedSamples(h.clock, h.provider, recognition.slice(0, Math.floor(recognition.length * 0.5)));
    const id = h.sessionId();
    h.controller.rejectCalibration();
    await h.controller.flush();

    const live = h.controller.calibrationAttemptRecord();
    expect(live).not.toBeNull();
    expect(live!.outcome).toBe('cancelled');
    // The screens' report model calls it a failure, not a "you stopped".
    const report = buildCalibrationReport(live!);
    expect(report.failure).toBe(true);
    expect(report.explanation.join(' ')).toContain('CANCELLED');

    await h.controller.endSession();
    const history = await historyFor(h);
    const doc = isDocument(
      await loadSessionReportDocument(reportDeps(h, history), id, '2026-09-22T12:00:00.000Z'),
    );
    saveEvidence('case3-cancelled-calibration', doc);

    expect(doc.calibrationAttempts.length).toBeGreaterThanOrEqual(1);
    const cancelled = doc.calibrationAttempts.find((a) => a.outcome === 'cancelled');
    expect(cancelled, 'the cancelled attempt is not in the export').toBeDefined();
    expect(cancelled!.explanation.join(' ')).toContain('CANCELLED');
    expect(cancelled!.thresholds.minCoverageFraction).toBeGreaterThan(0);
    expect(stateOf(doc, 'calibrationAttempts')).toBe('present');
    expect(buildSessionReportMarkdown(doc)).toContain('CANCELLED');
  });
});

describe('P13B item 1 -- a verdict survives a restart', () => {
  it('comes back out of a freshly built store, and out of a freshly built export', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);

    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 13_401));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();
    const id = h.sessionId();
    feedSamples(
      h.clock,
      h.provider,
      driveLap(circuit.profile, { seed: 13_402, lapCount: 2, sampleRateHz: 5 }),
    );
    await h.controller.endSession();

    const history = await historyFor(h);
    const laps = history.getSession(id)!.laps;
    const before = createLapVerdictStore({
      repository: () => h.repository,
      onError: () => undefined,
    });
    await before.recordVerdict({
      sessionId: id,
      lap: laps[0]!,
      decision: 'disagreed',
      answeredAtUtc: '2026-09-22T11:55:00.000Z',
      note: 'the app called this one wrong',
    });

    // The restart: a brand new store and a brand new history store over the
    // same database, holding no cache of their own.
    const afterRepository = await SqlSessionRepository.create(h.db);
    const afterHistory = new SqlSessionHistoryStore(
      afterRepository,
      USER_ID,
      circuit.profile.circuitId,
      circuit.profile.layoutId,
      circuit.profile.layoutVersion,
    );
    await afterHistory.refresh();
    const after = createLapVerdictStore({
      repository: () => afterRepository,
      onError: () => undefined,
    });
    // Nothing is in the fresh cache until it is read -- which is exactly why
    // the screens call `refreshLapVerdicts` before rendering.
    expect(after.stored(id)).toHaveLength(0);
    expect(await after.refresh(id)).toBe(true);

    const restored = after.stored(id);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.answer).toBe('disagreed');
    expect(restored[0]!.answeredAtUtc).toBe('2026-09-22T11:55:00.000Z');
    expect(restored[0]!.note).toBe('the app called this one wrong');

    const rows = buildLapVerdictRows(afterHistory.getSession(id)!.laps, after.forSession(id, laps));
    expect(rows[0]!.answered).toBe(true);
    expect(rows[0]!.answer).toBe('disagreed');

    const doc = isDocument(
      await loadSessionReportDocument(
        reportDeps({ ...h, repository: afterRepository }, afterHistory),
        id,
        '2026-09-22T12:00:00.000Z',
      ),
    );
    saveEvidence('case4-verdict-after-restart', doc);
    expect(doc.laps[0]!.verdict.answer).toBe('disagreed');
    expect(doc.laps[0]!.verdict.note).toBe('the app called this one wrong');
    expect(doc.verdictSummary.disagreed).toBe(1);
  });
});
