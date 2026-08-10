import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import type { SqlBindValue, SqlDatabase } from '@circuit/core/src/persistence-sql';
import { SqlSessionRepository } from '@circuit/core/src/persistence-sql';
import { migrateTelemetrySchema } from './telemetrySchema';

// Thin adapter from expo-sqlite's `SQLiteDatabase` to the `SqlDatabase`
// interface `SqlSessionRepository` (packages/core/src/persistence-sql) is
// written against. No SQL logic lives here -- this file only translates one
// async API shape into another, confirmed 1:1 against
// node_modules/expo-sqlite/build/SQLiteDatabase.d.ts:
//   - execAsync(sql)                    -> db.execAsync(sql)
//   - runAsync(sql, params) -> {changes} -> db.runAsync(sql, params) (also returns
//     lastInsertRowId, which SqlRunResult does not need and structurally ignores)
//   - getAllAsync<T>(sql, params)       -> db.getAllAsync<T>(sql, params)
//   - withTransactionAsync(fn)          -> db.withTransactionAsync(fn)
export function wrapExpoSqliteDatabase(db: SQLiteDatabase): SqlDatabase {
  return {
    execAsync: (sql: string) => db.execAsync(sql),
    runAsync: (sql: string, params: readonly SqlBindValue[] = []) => db.runAsync(sql, params as SqlBindValue[]),
    getAllAsync: <T>(sql: string, params: readonly SqlBindValue[] = []) => db.getAllAsync<T>(sql, params as SqlBindValue[]),
    withTransactionAsync: (fn: () => Promise<void>) => db.withTransactionAsync(fn),
  };
}

/**
 * F1 fix (WPT3, binding Telemetry addendum): wraps a `SqlDatabase` so every
 * call -- `execAsync`/`runAsync`/`getAllAsync`/`withTransactionAsync` -- is
 * queued onto ONE shared promise tail and runs strictly one at a time, in
 * call order, never overlapping. `openAppDatabase()` below applies this to
 * the single on-device connection BEFORE handing it to
 * `SqlSessionRepository.create()` -- so the SAME queue serializes the
 * production controller's own lap-persistence transactions (`SessionController`'s
 * private `lapPersistenceTail`, packages/core, reaching this connection
 * through `repository.saveSession()`/`saveCheckpoint()` etc.) against
 * `TelemetryRecorder`'s batch inserts (composition.ts hands `TelemetryRecorder`
 * this SAME wrapped `db`, returned from `openAppDatabase()`). `SessionController`'s
 * own tail field is private and packages/core is out of this ticket's write
 * set -- serializing at the one shared surface both sides actually go
 * through (the single on-device SQLite connection) is what makes the binding
 * "a telemetry write can never interleave with an open controller
 * transaction" guarantee hold, without needing to touch or expose that
 * private field.
 */
export function serializeSqlDatabase(inner: SqlDatabase): SqlDatabase {
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

/**
 * Opens (creating and migrating if necessary) the on-device SQLite database
 * and returns a ready-to-use `SqlSessionRepository` over it.
 *
 * `dbName` is passed straight through to expo-sqlite's `openDatabaseAsync`
 * (e.g. `"circuit-timer.db"`); WAL mode is attempted by
 * `SqlSessionRepository`'s migration step and applies here on real SQLite
 * (platform-research.md §6).
 */
export async function createSqliteSessionRepository(dbName: string): Promise<SqlSessionRepository> {
  const db = await openDatabaseAsync(dbName);
  return SqlSessionRepository.create(wrapExpoSqliteDatabase(db));
}

/**
 * Opens the on-device SQLite database once and returns BOTH the migrated
 * `SqlSessionRepository` and the raw `SqlDatabase` handle it was built from,
 * so a second store (`SqlSettingsStore`, the v2 `settings` key-value table)
 * can share the exact same connection instead of opening `dbName` twice.
 * `SqlSessionRepository.create` is what actually runs the migration
 * (including the v2 `settings` table) -- this must be awaited before the raw
 * `db` handle is used for anything settings-related.
 *
 * Also applies `migrateTelemetrySchema` (Telemetry addendum) over the SAME
 * connection -- a mobile-owned additive migration entirely independent of
 * `SqlSessionRepository`'s own (packages/core is out of the ticket that added
 * this call's write set); see `./telemetrySchema.ts`'s doc comment.
 */
export async function openAppDatabase(
  dbName: string,
): Promise<{ db: SqlDatabase; repository: SqlSessionRepository }> {
  const raw = await openDatabaseAsync(dbName);
  // F1 fix (WPT3): `serializeSqlDatabase()` wraps the connection BEFORE
  // `SqlSessionRepository.create()` so the repository's own transactions and
  // (later, composition.ts's) `TelemetryRecorder` inserts share ONE queue --
  // see that function's doc comment.
  const db = serializeSqlDatabase(wrapExpoSqliteDatabase(raw));
  const repository = await SqlSessionRepository.create(db);
  await migrateTelemetrySchema(db);
  return { db, repository };
}
