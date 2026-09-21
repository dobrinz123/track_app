import { describe, expect, it } from 'vitest';
import type { SqlDatabase } from '@circuit/core';
import { SqlSessionRepository } from '@circuit/core/src/persistence-sql';
import { createSqlWriteGate, gateSqlTransactions } from '../../src/persistence/sqlWriteGate';
import { createRawSqlJsDatabase, wrapSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { TelemetryRecorder } from '../../src/persistence/telemetryRecorder';

/**
 * Ticket P10B H5-B -- AN ORDINARY WRITE MUST NOT BE ABLE TO JOIN, AND BE
 * ROLLED BACK BY, SOMEBODY ELSE'S TRANSACTION.
 *
 * REVIEWER REPRODUCTION (sqlWriteGate.ts:52): hold the initial session
 * transaction at `DELETE FROM laps`, feed and flush ten fixes, then fail
 * that transaction. Before rollback: ten reported persisted, nine chunk
 * rows. Afterwards: zero chunk rows, zero history rows, ten STILL reported
 * persisted, zero retained. The ten fixes were gone and every figure said
 * the recording was complete.
 *
 * The cause was that only whole transactions took the gate; `runAsync` and
 * friends passed straight through, so a standalone INSERT issued while a
 * BEGIN was open simply became part of that transaction. The fix is
 * transaction-scoped access: every call through the gated handle takes the
 * gate, and the statements a transaction itself issues go through the `tx`
 * handle it is given -- which is also what keeps that from deadlocking.
 */
describe('P10B H5-B -- standalone writes are serialized against whole transactions', () => {
  it('a chunk write issued while a session transaction is open lands AFTER it, and survives its rollback', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const gate = createSqlWriteGate();
    const db = gateSqlTransactions(wrapSqlJsDatabase(rawDb), gate);
    const repository = await SqlSessionRepository.create(db);
    const sessionId = 'driver-1--gate-rollback';

    // A transaction held open at exactly the reviewer's point (after the
    // session row, at `DELETE FROM laps`) and then failed.
    let releaseHold: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const doomed = db
      .withTransactionAsync(async (tx) => {
        await tx.runAsync(
          `INSERT OR REPLACE INTO sessions
             (sessionId, userId, circuitId, layoutId, layoutVersion, startedAtUtc)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [sessionId, 'driver-1', 'tmr', 'full', 1, '2026-09-22T00:00:00.000Z'],
        );
        await tx.runAsync('DELETE FROM laps WHERE sessionId = ?', [sessionId]);
        await held;
        throw new Error('session transaction failed');
      })
      .catch((error: unknown) => error);

    // Ten fixes flushed as a chunk row WHILE that transaction is open. The
    // write must not begin until the transaction is finished with the
    // connection.
    const chunkWrite = repository.saveTelemetry(
      sessionId,
      -1,
      Array.from({ length: 10 }, (_, index) => ({
        tMono: index * 100,
        lat: 46.7,
        lon: 23.5,
        source: 'replay' as const,
      })),
    );

    // Give the write every chance to slip in early.
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const duringTransaction = await new Promise<number>((resolve) => {
      const rows = rawDb.exec('SELECT COUNT(*) FROM telemetry');
      resolve(Number(rows[0]?.values[0]?.[0] ?? 0));
    });
    // WAS: the row was already there, inside the doomed transaction.
    expect(duringTransaction).toBe(0);

    releaseHold();
    expect(await doomed).toBeInstanceOf(Error);
    await chunkWrite;

    // WAS: zero chunk rows after the rollback. The fixes are now unaffected
    // by a transaction they were never part of.
    const stored = await repository.loadTelemetry(sessionId, -1);
    expect(stored).toHaveLength(10);
    // ...and the rolled-back transaction really did roll back.
    const sessionRows = rawDb.exec('SELECT COUNT(*) FROM sessions');
    expect(Number(sessionRows[0]?.values[0]?.[0] ?? -1)).toBe(0);
  });

  it('a telemetry batch INSERT is serialized the same way, with no gate held by the recorder itself', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const gate = createSqlWriteGate();
    const db = gateSqlTransactions(wrapSqlJsDatabase(rawDb), gate);
    await SqlSessionRepository.create(db);
    await migrateTelemetrySchema(db);

    let releaseHold: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const doomed = db
      .withTransactionAsync(async (tx) => {
        await tx.runAsync('DELETE FROM laps WHERE sessionId = ?', ['s']);
        await held;
        throw new Error('unrelated transaction failed');
      })
      .catch((error: unknown) => error);

    const recorder = new TelemetryRecorder(db, 's');
    recorder.record({ tMonoMs: 1, channel: 'rpm', value: 1000 }, null);
    recorder.flushOnLapCrossing();
    const flush = recorder.flush();

    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(Number(rawDb.exec('SELECT COUNT(*) FROM telemetry_samples')[0]?.values[0]?.[0] ?? -1)).toBe(0);

    releaseHold();
    expect(await doomed).toBeInstanceOf(Error);
    await flush;

    // Survived the unrelated rollback, because it was never inside it.
    expect(Number(rawDb.exec('SELECT COUNT(*) FROM telemetry_samples')[0]?.values[0]?.[0] ?? -1)).toBe(1);
  });

  it('a transaction whose callback uses the transaction-scoped handle completes -- full serialization does not deadlock', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const gate = createSqlWriteGate();
    const inner: SqlDatabase = wrapSqlJsDatabase(rawDb);
    const db = gateSqlTransactions(inner, gate);
    await SqlSessionRepository.create(db);

    // Interleaved with a standalone read and a standalone write, all on the
    // one gated connection: the deadlock the N1 fix was originally reacting
    // to would hang this test.
    const work = db.withTransactionAsync(async (tx) => {
      await tx.runAsync('DELETE FROM laps WHERE sessionId = ?', ['x']);
      await tx.getAllAsync('SELECT COUNT(*) AS n FROM laps');
      await tx.runAsync('DELETE FROM checkpoints WHERE sessionId = ?', ['x']);
    });
    const other = db.getAllAsync<{ n: number }>('SELECT COUNT(*) AS n FROM sessions');
    await expect(Promise.all([work, other])).resolves.toBeDefined();
  });
});
