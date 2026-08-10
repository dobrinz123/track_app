import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlBindValue, SqlDatabase, SqlRunResult, TelemetrySample } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { TelemetryRecorder } from '../../src/persistence/telemetryRecorder';

/**
 * Byte-for-byte mirror of `apps/mobile/src/persistence/expoSqlDatabase.ts`'s
 * `serializeSqlDatabase()` (F1 fix) -- that module's OWN top-level `import
 * ... from 'expo-sqlite'` breaks vitest's parser the same way importing
 * `react-native` directly does (confirmed: `composition.ts`'s own
 * `IS_WEB_RUNTIME` doc comment; every composition test mocks
 * `../../src/persistence/expoSqlDatabase` entirely rather than importing it
 * for real), so it cannot be imported here even to reach this one pure,
 * expo-independent helper. Keep the two in sync on any future change to
 * either.
 */
function serializeSqlDatabase(inner: SqlDatabase): SqlDatabase {
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = tail.then(op, op);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  return {
    execAsync: (sql: string) => enqueue(() => inner.execAsync(sql)),
    runAsync: (sql: string, params?: readonly SqlBindValue[]) => enqueue(() => inner.runAsync(sql, params)),
    getAllAsync: <T>(sql: string, params?: readonly SqlBindValue[]) => enqueue(() => inner.getAllAsync<T>(sql, params)),
    withTransactionAsync: (fn: () => Promise<void>) => enqueue(() => inner.withTransactionAsync(fn)),
  };
}

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

  it('F5 fix: capReached flips true immediately once a SINGLE batch lands EXACTLY on the cap (not only once a LATER batch sees zero room), and further samples are dropped up front, never buffered', async () => {
    const db = await migratedDb();
    const recorder = new TelemetryRecorder(db, 'sess-cap-exact', 25); // rowCap === BATCH_SIZE, so one flush lands exactly on the cap.

    for (let i = 0; i < 25; i += 1) recorder.record(sample('rpm', i, i), null); // exactly fills the cap in ONE batch.
    await recorder.flush();

    // Pre-fix, this stayed `false` here -- only a SUBSEQUENT batch seeing
    // zero room flipped it, so diagnostics briefly under-reported and a
    // caller landing exactly on 200,000 would see `capReached: false`.
    expect(recorder.diagnostics()).toEqual({ rowsWritten: 25, capReached: true });

    // A further record() is dropped by `record()`'s own guard up front
    // (never buffered at all -- not merely discarded once flushed).
    recorder.record(sample('rpm', 999, 999), null);
    await recorder.flush();
    expect((await rowsFor(db, 'sess-cap-exact')).length).toBe(25);
  });
});

describe('TelemetryRecorder never opens its own transaction (F1 fix)', () => {
  it('issues zero BEGINs, and (over a `serializeSqlDatabase`-wrapped connection, matching production wiring) its insert never lands between another caller\'s BEGIN and COMMIT on the SAME connection', async () => {
    const log: string[] = [];
    let openTransactionDepth = 0;
    let sawInsertDuringOpenTransaction = false;

    // A hand-rolled fake DB (not sql.js) that records BEGIN/COMMIT/insert
    // ordering directly -- exactly what this ticket's binding design calls
    // for, and lets this test assert "zero BEGINs from the recorder" without
    // relying on a real engine's own nested-transaction error message.
    const fakeInner: SqlDatabase = {
      execAsync: async () => {},
      runAsync: async (sql: string): Promise<SqlRunResult> => {
        if (sql.startsWith('INSERT INTO telemetry_samples')) {
          if (openTransactionDepth > 0) sawInsertDuringOpenTransaction = true;
          log.push('telemetry-insert');
        } else {
          log.push(`run:${sql}`);
        }
        return { changes: 1 };
      },
      getAllAsync: async () => [],
      withTransactionAsync: async (fn: () => Promise<void>): Promise<void> => {
        log.push('BEGIN');
        openTransactionDepth += 1;
        try {
          await fn();
        } finally {
          openTransactionDepth -= 1;
          log.push('COMMIT');
        }
      },
    };
    // Production wiring (`expoSqlDatabase.ts`'s `openAppDatabase()`): the
    // SAME wrapped connection is handed to BOTH the controller's own
    // repository (its transactions) and `TelemetryRecorder` (see
    // `telemetryRecorder.ts`'s own doc comment) -- reproduced here.
    const db = serializeSqlDatabase(fakeInner);

    // Simulates the controller's own lap-persistence transaction, held open
    // for a tick, WHILE a telemetry flush is queued concurrently -- exactly
    // the race the binding "a telemetry write can never interleave with an
    // open controller transaction" guards against.
    const controllerTx = db.withTransactionAsync(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      log.push('controller-write');
    });

    const recorder = new TelemetryRecorder(db, 'sess-tx-race');
    recorder.record(sample('rpm', 1, 1), null);
    recorder.flushOnLapCrossing();

    await Promise.all([controllerTx, recorder.flush()]);

    expect(sawInsertDuringOpenTransaction).toBe(false);
    expect(log.filter((entry) => entry === 'BEGIN')).toHaveLength(1); // ONLY the controller's -- the recorder issued zero.
    expect(log).toEqual(['BEGIN', 'controller-write', 'COMMIT', 'telemetry-insert']);
  });
});
