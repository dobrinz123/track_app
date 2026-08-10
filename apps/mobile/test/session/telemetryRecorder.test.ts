import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase, TelemetrySample } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { TelemetryRecorder } from '../../src/persistence/telemetryRecorder';

interface TelemetryRow {
  session_id: string;
  lap_number: number | null;
  t_mono_ms: number;
  channel: string;
  value: number;
}

async function migratedDb(): Promise<SqlDatabase> {
  const db = await createSqlJsDatabase();
  await migrateTelemetrySchema(db);
  return db;
}

function sample(channel: TelemetrySample['channel'], value: number, tMonoMs: number): TelemetrySample {
  return { channel, value, tMonoMs };
}

async function rowsFor(db: SqlDatabase, sessionId: string): Promise<TelemetryRow[]> {
  return db.getAllAsync<TelemetryRow>('SELECT * FROM telemetry_samples WHERE session_id = ? ORDER BY t_mono_ms', [
    sessionId,
  ]);
}

describe('telemetrySchema migration', () => {
  it('creates telemetry_samples idempotently and records TELEMETRY_SCHEMA_VERSION', async () => {
    const db = await createSqlJsDatabase();
    await migrateTelemetrySchema(db);
    await migrateTelemetrySchema(db); // re-running must not throw or duplicate the version row.

    const versionRows = await db.getAllAsync<{ version: number }>('SELECT version FROM telemetry_schema_migrations');
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]!.version).toBe(1);

    // Table genuinely usable -- an insert + read round-trips.
    await db.runAsync('INSERT INTO telemetry_samples (session_id, lap_number, t_mono_ms, channel, value) VALUES (?, ?, ?, ?, ?)', [
      's1',
      null,
      100,
      'rpm',
      850,
    ]);
    const rows = await rowsFor(db, 's1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lap_number).toBeNull();
  });
});

describe('TelemetryRecorder batching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes immediately once 25 samples have been buffered (count boundary), without waiting for the 1s timer', async () => {
    const db = await migratedDb();
    const recorder = new TelemetryRecorder(db, 'sess-batch-count');

    for (let i = 0; i < 24; i += 1) recorder.record(sample('rpm', 1000 + i, i), null);
    await recorder.flush();
    expect((await rowsFor(db, 'sess-batch-count')).length).toBe(0); // still under the 25-sample boundary.

    recorder.record(sample('rpm', 1024, 24), null); // the 25th sample crosses the boundary.
    await recorder.flush();
    const rows = await rowsFor(db, 'sess-batch-count');
    expect(rows).toHaveLength(25);
    expect(recorder.diagnostics().rowsWritten).toBe(25);
  });

  it('flushes on the 1s timer boundary even when fewer than 25 samples are buffered', async () => {
    const db = await migratedDb();
    const recorder = new TelemetryRecorder(db, 'sess-batch-time');

    recorder.record(sample('speedKph', 42, 1), null);
    recorder.record(sample('speedKph', 43, 2), null);
    expect((await rowsFor(db, 'sess-batch-time')).length).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await recorder.flush();

    const rows = await rowsFor(db, 'sess-batch-time');
    expect(rows).toHaveLength(2);
  });

  it('tags buffered rows with the caller-supplied lap number, including null before the first lap', async () => {
    const db = await migratedDb();
    const recorder = new TelemetryRecorder(db, 'sess-lap-tag');

    recorder.record(sample('rpm', 900, 1), null);
    recorder.record(sample('rpm', 950, 2), 1);
    recorder.flushOnLapCrossing();
    await recorder.flush();

    const rows = await rowsFor(db, 'sess-lap-tag');
    expect(rows.map((r) => r.lap_number)).toEqual([null, 1]);
  });
});

describe('TelemetryRecorder flush-on-endSession', () => {
  it('endSession() flushes any buffered rows and awaits the write', async () => {
    const db = await migratedDb();
    const recorder = new TelemetryRecorder(db, 'sess-end');

    recorder.record(sample('coolantC', 88, 10), 1);
    recorder.record(sample('coolantC', 89, 11), 1);
    expect((await rowsFor(db, 'sess-end')).length).toBe(0);

    await recorder.endSession();

    const rows = await rowsFor(db, 'sess-end');
    expect(rows).toHaveLength(2);
    expect(recorder.diagnostics().rowsWritten).toBe(2);
  });

  it('dispose() after endSession() drops any late record() call as a no-op', async () => {
    const db = await migratedDb();
    const recorder = new TelemetryRecorder(db, 'sess-dispose');
    recorder.record(sample('rpm', 1, 1), null);
    await recorder.endSession();
    recorder.dispose();

    recorder.record(sample('rpm', 2, 2), null);
    await recorder.flush();
    expect((await rowsFor(db, 'sess-dispose')).length).toBe(1);
  });
});

describe('TelemetryRecorder 200k row cap', () => {
  it('stops inserting once the row cap is reached and sets diagnostics().capReached', async () => {
    const db = await migratedDb();
    // Test-only small cap (constructor's third param) -- proves the SAME
    // enforcement logic the binding 200,000/session default uses, without a
    // unit test writing 200k real rows through sql.js.
    const smallCap = 30;
    const recorder = new TelemetryRecorder(db, 'sess-cap', smallCap);

    for (let i = 0; i < 50; i += 1) recorder.record(sample('rpm', i, i), null);
    await recorder.flush();

    const rows = await rowsFor(db, 'sess-cap');
    expect(rows).toHaveLength(smallCap);
    expect(recorder.diagnostics()).toEqual({ rowsWritten: smallCap, capReached: true });

    // Further record() calls are a silent no-op -- no crash, nothing evicted.
    recorder.record(sample('rpm', 999, 999), null);
    await recorder.flush();
    expect((await rowsFor(db, 'sess-cap')).length).toBe(smallCap);
  });

  it('never crashes and never evicts already-written rows when the cap lands mid-batch', async () => {
    const db = await migratedDb();
    const recorder = new TelemetryRecorder(db, 'sess-cap-mid', 25); // exactly one batch's worth

    for (let i = 0; i < 25; i += 1) recorder.record(sample('rpm', i, i), null); // fills the cap exactly, one batch.
    for (let i = 0; i < 25; i += 1) recorder.record(sample('rpm', 100 + i, 100 + i), null); // a second full batch, entirely over cap.
    await recorder.flush();

    const rows = await rowsFor(db, 'sess-cap-mid');
    expect(rows).toHaveLength(25);
    expect(recorder.diagnostics().capReached).toBe(true);
  });
});
