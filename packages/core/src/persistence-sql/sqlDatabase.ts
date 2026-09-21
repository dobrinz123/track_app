// Minimal async SQL database interface that `SqlSessionRepository` is written
// against. It is deliberately shaped to be trivially satisfiable by
// expo-sqlite's `SQLiteDatabase` (see apps/mobile/src/persistence/expoSqlDatabase.ts)
// and by a sql.js-backed adapter used in tests (see
// packages/core/test/persistence-sql/sqlJsDatabase.ts) -- no platform imports
// live in packages/core.
//
// Verified against expo-sqlite@~57 (apps/mobile devDependency,
// node_modules/expo-sqlite/build/SQLiteDatabase.d.ts) and against
// .foreman/scratch/platform-research.md §6 (expo-sqlite):
//   - execAsync(source: string): Promise<void>                                    -- matches verbatim.
//   - runAsync(source: string, params: SQLiteBindParams): Promise<SQLiteRunResult> -- SQLiteRunResult has
//     { lastInsertRowId, changes }; we only need `changes`, a subset, so it is structurally assignable.
//   - getAllAsync<T>(source: string, params: SQLiteBindParams): Promise<T[]>       -- matches verbatim.
//   - withTransactionAsync(task: () => Promise<void>): Promise<void>               -- present on
//     expo-sqlite's SQLiteDatabase (not called out in platform-research.md, which only documents
//     execAsync/runAsync/getAllAsync/getFirstAsync/getEachAsync/PRAGMA journal_mode=WAL; the
//     transaction helper is an additional real API surface confirmed directly against the installed
//     expo-sqlite type declarations). Adaptation note: expo-sqlite's overloads also accept variadic
//     bind params (`runAsync(source, ...params)`); we only ever call the array-params overload, and
//     an optional `params` array is a narrower, contravariantly-compatible parameter type, so the real
//     expo-sqlite method satisfies this interface without any wrapping beyond a plain object literal.
export type SqlBindValue = string | number | null;

export interface SqlRunResult {
  changes: number;
}

export interface SqlDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: readonly SqlBindValue[]): Promise<SqlRunResult>;
  getAllAsync<T>(sql: string, params?: readonly SqlBindValue[]): Promise<T[]>;
  /**
   * Ticket P10B H5-B -- TRANSACTION-SCOPED ACCESS.
   *
   * The callback is handed a `tx` handle and MUST issue every statement of
   * the transaction through it, never through the outer `SqlDatabase` it
   * closed over. On a shared single connection the outer handle may be
   * serialized (see apps/mobile/src/persistence/sqlWriteGate.ts): a statement
   * sent through it from inside an open transaction would queue behind the
   * transaction that is waiting for it (deadlock), while a statement sent
   * through it from OUTSIDE would silently enrol in whatever transaction
   * happens to be open and be rolled back with it -- the P10B reviewer
   * reproduced exactly that, losing ten flushed fixes to an unrelated
   * `saveSession` rollback.
   *
   * `tx` is the ungated connection; the gate is held for the whole
   * BEGIN..COMMIT span by the wrapper, so no other unit can interleave.
   */
  withTransactionAsync(fn: (tx: SqlDatabase) => Promise<void>): Promise<void>;
}
