import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import type { SqlBindValue, SqlDatabase } from '@circuit/core/src/persistence-sql';
import { SqlSessionRepository } from '@circuit/core/src/persistence-sql';
import { migrateTelemetrySchema } from './telemetrySchema';
import { migrateDidSweepSchema } from './didSweepSchema';
import { createSqlWriteGate, gateSqlTransactions, type SqlWriteGate } from './sqlWriteGate';

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

// F1/N1: transaction-vs-telemetry mutual exclusion lives in ./sqlWriteGate.ts
// (see its module doc comment for why only WHOLE units are gated, never the
// statements a transaction callback itself issues -- the naive every-call
// FIFO this file previously shipped self-deadlocked every repository
// transaction, N1).

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
 * Also applies `migrateTelemetrySchema` (Telemetry addendum) and
 * `migrateDidSweepSchema` (DID sweep results persistence addendum, P4i) over
 * the SAME connection -- both mobile-owned additive migrations entirely
 * independent of `SqlSessionRepository`'s own (packages/core is out of the
 * ticket that added these calls' write set); see `./telemetrySchema.ts`'s
 * and `./didSweepSchema.ts`'s own doc comments.
 */
export async function openAppDatabase(
  dbName: string,
): Promise<{ db: SqlDatabase; repository: SqlSessionRepository; writeGate: SqlWriteGate }> {
  const raw = await openDatabaseAsync(dbName);
  // F1/N1 fix: the repository's transactions acquire `writeGate` for their
  // whole BEGIN..COMMIT span (`gateSqlTransactions`); `TelemetryRecorder`
  // acquires the SAME gate around each batch INSERT (composition.ts passes
  // `writeGate` to its constructor). Statements inside a transaction callback
  // pass through ungated -- they are the holder's own critical section
  // (wrapping them too is the self-deadlock this replaces, N1).
  const writeGate = createSqlWriteGate();
  const db = gateSqlTransactions(wrapExpoSqliteDatabase(raw), writeGate);
  const repository = await SqlSessionRepository.create(db);
  await migrateTelemetrySchema(db);
  await migrateDidSweepSchema(db);
  return { db, repository, writeGate };
}
