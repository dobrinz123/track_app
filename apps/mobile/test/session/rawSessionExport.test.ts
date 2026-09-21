import { describe, expect, it, vi } from 'vitest';

// The same expo doubles `analysisExport.test.ts` installs -- the real
// modules' Flow-typed sources cannot be parsed by this runner.
const writes: { name: string; contents: string }[] = [];
vi.mock('expo-file-system', () => ({
  Paths: { cache: {} },
  File: class {
    readonly uri: string;
    constructor(_directory: unknown, name: string) {
      this.uri = `file:///cache/${name}`;
      writes.push({ name, contents: '' });
    }
    write(contents: string): void {
      const entry = writes[writes.length - 1];
      if (entry !== undefined) entry.contents = contents;
    }
  },
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: async (_uri: string, _options: unknown) => undefined,
}));
import {
  SessionController,
  SqlSessionRepository,
  cleanRecognitionLap,
  driveLap,
  multiLapSession,
  type LocationSample,
  type SessionCalibrationStatus,
  type SqlDatabase,
} from '@circuit/core';

import { SqlSessionHistoryStore } from '../../src/session/sqlSessionHistoryStore';
import { TelemetryRecorder } from '../../src/persistence/telemetryRecorder';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import {
  RAW_SESSION_EXPORT_KIND,
  RAW_SESSION_EXPORT_SCHEMA_VERSION,
  buildRawSessionSummaryMarkdown,
  loadRawSessionExportDocument,
  rawSessionExportFileName,
  readAllSessionTelemetry,
  readStoredGnssLapNumbers,
  readUnclaimedGnssChunks,
  type RawSessionExportDocument,
} from '../../src/session/rawSessionExport';
import { bundled, TMR_CIRCUIT_ID } from '../support/analysisHarness';
import { FakeClock, FakeLocationProvider, feedSamples } from '../support/coreTestDoubles';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * Ticket P7R E1 (CRITICAL) — END TO END: a session that timed NO lap must be
 * exportable, and the export must actually contain the drive.
 *
 * This is deliberately not a unit test of the document builder. The defect it
 * guards is an INTEGRATION one: P7M M1 made the trace survive, and the export
 * path still needed an analysis, which needed laps. So the test drives a real
 * `SessionController` over a real `SqlSessionRepository` on a real (sql.js)
 * database, records real OBD samples through the real `TelemetryRecorder`,
 * and then exports through the real reader functions the app wires in
 * `composition.ts`. Every link in the chain that failed the owner is
 * executed.
 */

const USER_ID = 'driver-1';

interface Harness {
  db: SqlDatabase;
  repository: SqlSessionRepository;
  controller: SessionController;
  clock: FakeClock;
  provider: FakeLocationProvider;
  recorder: TelemetryRecorder;
  sessionId: () => string;
}

async function harness(circuitId = TMR_CIRCUIT_ID): Promise<Harness> {
  const circuit = bundled(circuitId);
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
    appVersion: 'p7r-raw-export-test',
    algorithmVersion: 1,
    restartProvider: () => undefined,
  });

  let recorder: TelemetryRecorder | null = null;
  const sessionId = (): string => {
    const id = controller.diagnostics().sessionId;
    if (id === null) throw new Error('no session id yet');
    return id;
  };
  // Built lazily, exactly as `composition.ts` does from `onSessionStarted`.
  const lazyRecorder = (): TelemetryRecorder => {
    recorder ??= new TelemetryRecorder(db, sessionId());
    return recorder;
  };

  return {
    db,
    repository,
    controller,
    clock,
    provider,
    get recorder(): TelemetryRecorder {
      return lazyRecorder();
    },
    sessionId,
  };
}

/** The deps `composition.ts`'s `buildRawSessionExport` wires, over the real stores. */
function exportDeps(h: Harness, history: SqlSessionHistoryStore, unvalidated: Set<string>) {
  return {
    getSession: (id: string) => history.getSession(id),
    loadLapGnss: (id: string, lapNumber: number) => h.repository.loadTelemetry(id, lapNumber),
    // Ticket P10A: chunk rows with their run identity, the stored-row
    // enumeration, and the three-valued provenance -- exactly what
    // `composition.ts` now wires.
    loadUnclaimedGnss: (id: string) => readUnclaimedGnssChunks(h.db, id),
    listStoredGnssLapNumbers: (id: string) => readStoredGnssLapNumbers(h.db, id),
    loadTelemetry: (id: string) => readAllSessionTelemetry(h.db, id),
    calibrationStatus: (id: string): SessionCalibrationStatus =>
      unvalidated.has(id) ? 'unvalidated' : (history.getSession(id)?.calibrationStatus ?? 'unknown'),
    unwrittenSampleCount: (id: string) => history.getSession(id)?.unwrittenSampleCount ?? null,
  };
}

async function historyFor(h: Harness, circuitId = TMR_CIRCUIT_ID): Promise<SqlSessionHistoryStore> {
  const circuit = bundled(circuitId);
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

const isDocument = (value: unknown): RawSessionExportDocument => {
  if (typeof value === 'string') throw new Error(`expected a document, got "${value}"`);
  return value as RawSessionExportDocument;
};

describe('P7R E1 -- a zero-lap session exports its drive', () => {
  it('records a session that times no lap at all, and lists it in history', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);

    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 9_001));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();

    // Part of one lap: the timing engine never completes one.
    const drive = driveLap(circuit.profile, { seed: 9_002 });
    const id = h.sessionId();
    feedSamples(h.clock, h.provider, drive.slice(0, Math.floor(drive.length * 0.6)));
    await h.controller.endSession();

    const history = await historyFor(h);
    const listed = history.listSessions();
    // THE PRECONDITION THE TICKET ASKED TO BE CONFIRMED RATHER THAN ASSUMED:
    // `listSessions` has no lap join, so the zero-lap row really is there --
    // which is what makes the history screen a reachable export path.
    expect(listed.map((s) => s.sessionId)).toContain(id);
    expect(history.getSession(id)!.laps).toHaveLength(0);
  });

  it('exports the GNSS samples of a zero-lap session -- the whole point', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);

    await h.controller.start('calibration');
    const calibrationLap = cleanRecognitionLap(circuit.profile, 9_003);
    feedSamples(h.clock, h.provider, calibrationLap);
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();

    const id = h.sessionId();
    // Real OBD/IMU rows, recorded with NO lap number -- which is how every
    // sample of a zero-lap session is tagged, and precisely the rows
    // `telemetryRead.ts`'s per-lap readers exclude.
    h.recorder.record({ channel: 'speedKph', value: 121.5, tMonoMs: 10 }, null);
    h.recorder.record({ channel: 'rpm', value: 5_400, tMonoMs: 20 }, null);
    h.recorder.record({ channel: 'latG', value: -0.82, tMonoMs: 30 }, null);
    await h.recorder.endSession();

    const drive = driveLap(circuit.profile, { seed: 9_004 });
    const fed = drive.slice(0, Math.floor(drive.length * 0.6));
    feedSamples(h.clock, h.provider, fed);
    await h.controller.endSession();

    const history = await historyFor(h);
    const unvalidated = new Set<string>();
    const doc = isDocument(
      await loadRawSessionExportDocument(exportDeps(h, history, unvalidated), id, '2026-09-28T09:15:00.000Z'),
    );

    expect(doc.kind).toBe(RAW_SESSION_EXPORT_KIND);
    expect(doc.schemaVersion).toBe(RAW_SESSION_EXPORT_SCHEMA_VERSION);
    expect(doc.session.sessionId).toBe(id);
    expect(doc.session.lapCount).toBe(0);
    expect(doc.laps).toHaveLength(0);

    // THE ASSERTION THIS FILE EXISTS FOR: the GNSS samples are in the export.
    expect(doc.gnss.lapSampleCount).toBe(0);
    expect(doc.gnss.unclaimedSampleCount).toBeGreaterThan(100);
    expect(doc.gnss.totalSampleCount).toBe(doc.gnss.unclaimedSampleCount);
    const first = doc.gnss.unclaimed[0]!;
    expect(Number.isFinite(first.lat)).toBe(true);
    expect(Number.isFinite(first.lon)).toBe(true);
    expect(Number.isFinite(first.tMono)).toBe(true);
    // They are the samples that were actually driven, not placeholders:
    // EVERY fix fed after arming is in the export, by its own timestamp.
    const exportedTimes = new Set(doc.gnss.unclaimed.map((s) => s.tMono));
    const fedTimes = fed.map((s) => s.tMono);
    expect(fedTimes.length).toBeGreaterThan(40);
    expect(fedTimes.filter((t) => !exportedTimes.has(t))).toEqual([]);
    // In CAPTURE order, so the file reads as a drive.
    //
    // Ticket P10A (MEDIUM, ordering): this used to assert `tMono` ascending,
    // and the export used to deliver that by sorting on `tMono`. Both were
    // wrong, and this very fixture shows why -- `driveLap` restarts its
    // timestamps at 0 after the recognition lap's ~91 s, exactly as a
    // resumed process does, so a `tMono` sort interleaves two separate
    // stretches of driving into one scrambled trace. The right invariant is
    // the order the fixes were CAPTURED in, which is what the chunk keys
    // record and what the export now preserves.
    expect(doc.gnss.unclaimed.map((s) => s.tMono)).toEqual([
      ...calibrationLap.map((s) => s.tMono),
      ...fed.map((s) => s.tMono),
    ]);
    // One run, so one entry: this session was never resumed.
    expect(doc.gnss.runs).toHaveLength(1);
    expect(doc.gnss.runs[0]!.sampleCount).toBe(doc.gnss.unclaimedSampleCount);

    // ... and the telemetry half, including the lap-less rows.
    expect(doc.telemetry.sampleCount).toBe(3);
    expect(doc.telemetry.unlappedSampleCount).toBe(3);
    expect(doc.telemetry.channels).toEqual(['latG', 'rpm', 'speedKph']);

    // It survives the round trip a share actually performs.
    const json = JSON.stringify(doc);
    const parsed = JSON.parse(json) as RawSessionExportDocument;
    expect(parsed.gnss.unclaimed).toHaveLength(doc.gnss.unclaimedSampleCount);
    expect(parsed.gnss.unclaimed[0]).toEqual(first);

    // And it names itself distinctly enough that two attempts in one day do
    // not overwrite each other in the cache.
    expect(rawSessionExportFileName(doc, 'json')).toMatch(/^trace-raw-transilvania-motor-ring-/);
    expect(rawSessionExportFileName(doc, 'json').endsWith('.json')).toBe(true);

    const summary = buildRawSessionSummaryMarkdown(doc);
    expect(summary).toContain('Laps recorded: 0');
    expect(summary).toContain(`${doc.gnss.totalSampleCount}`);
  });

  it('says out loud that no lap was timed, rather than presenting an empty report', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);
    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 9_005));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();
    const id = h.sessionId();
    feedSamples(h.clock, h.provider, driveLap(circuit.profile, { seed: 9_006 }).slice(0, 80));
    await h.controller.endSession();

    const doc = isDocument(
      await loadRawSessionExportDocument(
        exportDeps(h, await historyFor(h), new Set()),
        id,
        '2026-09-28T09:15:00.000Z',
      ),
    );
    expect(doc.notes.some((note) => note.includes('completed no lap'))).toBe(true);
  });

  it('carries the E2 label, so an uncalibrated session is never exported as a normal one', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);
    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 9_007));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();
    const id = h.sessionId();
    feedSamples(h.clock, h.provider, driveLap(circuit.profile, { seed: 9_008 }).slice(0, 80));
    await h.controller.endSession();

    const doc = isDocument(
      await loadRawSessionExportDocument(
        exportDeps(h, await historyFor(h), new Set([id])),
        id,
        '2026-09-28T09:15:00.000Z',
      ),
    );
    expect(doc.session.matchingUnvalidated).toBe(true);
    expect(doc.notes.some((note) => note.includes('REJECTED calibration'))).toBe(true);
    expect(buildRawSessionSummaryMarkdown(doc)).toContain('not validated');
  });
});

describe('P7R E1 -- a session WITH laps is not regressed', () => {
  it('exports each lap trace as well as whatever the laps did not claim', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);

    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 9_009));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();
    const id = h.sessionId();
    feedSamples(h.clock, h.provider, multiLapSession(circuit.profile, 3, 9_010));
    await h.controller.endSession();

    const history = await historyFor(h);
    const stored = history.getSession(id)!;
    expect(stored.laps.length).toBeGreaterThan(0);

    const doc = isDocument(
      await loadRawSessionExportDocument(
        exportDeps(h, history, new Set()),
        id,
        '2026-09-28T09:15:00.000Z',
      ),
    );

    expect(doc.session.lapCount).toBe(stored.laps.length);
    expect(doc.laps.map((l) => l.lapNumber)).toEqual(stored.laps.map((l) => l.lapNumber));
    expect(doc.gnss.laps.map((l) => l.lapNumber)).toEqual(stored.laps.map((l) => l.lapNumber));
    expect(doc.gnss.lapSampleCount).toBeGreaterThan(0);
    expect(doc.session.matchingUnvalidated).toBe(false);

    // Each lap's exported trace is EXACTLY what the repository holds for it --
    // the same rows the analysis reads, untouched by this new path.
    for (const lap of doc.gnss.laps) {
      const stored = await h.repository.loadTelemetry(id, lap.lapNumber);
      expect(lap.samples).toEqual(stored);
    }

    // P7M's reclaim means a lap's samples are in the lap row, not in the
    // chunks -- so the two halves do not double-count the drive.
    const lapTimes = new Set<number>(
      doc.gnss.laps.flatMap((lap) => lap.samples.map((s: LocationSample) => s.tMono)),
    );
    const overlap = doc.gnss.unclaimed.filter((s) => lapTimes.has(s.tMono));
    expect(overlap).toHaveLength(0);
  });
});

describe('P7R E1 -- the export refuses to fail quietly', () => {
  it('names a missing session instead of writing an empty file', async () => {
    const h = await harness();
    const result = await loadRawSessionExportDocument(
      exportDeps(h, await historyFor(h), new Set()),
      'no-such-session',
      '2026-09-28T09:15:00.000Z',
    );
    expect(result).toBe('session-not-found');
  });

  it('still exports the GNSS trace when the telemetry read fails', async () => {
    const h = await harness();
    const circuit = bundled(TMR_CIRCUIT_ID);
    await h.controller.start('calibration');
    feedSamples(h.clock, h.provider, cleanRecognitionLap(circuit.profile, 9_011));
    h.controller.acceptCalibration();
    await h.controller.flush();
    h.controller.arm();
    const id = h.sessionId();
    feedSamples(h.clock, h.provider, driveLap(circuit.profile, { seed: 9_012 }).slice(0, 80));
    await h.controller.endSession();

    const errors: unknown[] = [];
    const doc = isDocument(
      await loadRawSessionExportDocument(
        {
          ...exportDeps(h, await historyFor(h), new Set()),
          loadTelemetry: () => Promise.reject(new Error('telemetry table is gone')),
          onReadError: (error) => errors.push(error),
        },
        id,
        '2026-09-28T09:15:00.000Z',
      ),
    );
    // A secondary read failing must never cost the drive.
    expect(errors).toHaveLength(1);
    expect(doc.gnss.unclaimedSampleCount).toBeGreaterThan(0);
    expect(doc.telemetry.sampleCount).toBe(0);
    expect(doc.notes.some((note) => note.includes('No OBD'))).toBe(true);
  });
});
