import initSqlJs, { type Database } from 'sql.js';
import type { SqlBindValue, SqlDatabase, SqlRunResult } from '@circuit/core';

/**
 * Local copy of packages/core/test/persistence-sql/sqlJsDatabase.ts's sql.js
 * `SqlDatabase` adapter -- kept local for the same cross-tsconfig reason as
 * `coreTestDoubles.ts` (see its top comment). Reuses the `sql.js` PACKAGE
 * itself via workspace-root hoisting (ticket CONSTRAINTS: "sql.js reuse via
 * workspace root") -- it is core's devDependency, not re-declared here.
 */

let sqlJsModulePromise: ReturnType<typeof initSqlJs> | null = null;
function loadSqlJs(): ReturnType<typeof initSqlJs> {
  sqlJsModulePromise ??= initSqlJs();
  return sqlJsModulePromise;
}

export function wrapSqlJsDatabase(db: Database): SqlDatabase {
  // Ticket P10A: the SAME serialization the real connection has.
  // `openAppDatabase()` wraps its `SqlDatabase` in `gateSqlTransactions(...,
  // createSqlWriteGate())`, so two transactions on the one on-device
  // connection can never overlap. The composition tests hand this double
  // straight to a mocked `openAppDatabase` and so had no gate at all --
  // which stayed invisible only while nothing wrote a transaction
  // concurrently with the repository's. P10A H2's session record (written at
  // recording start, alongside the active-session pointer write) does, and
  // sql.js answers an overlapping BEGIN with "cannot start a transaction
  // within a transaction". Gating here makes the double faithful to
  // production rather than papering over the collision.
  let transactionTail: Promise<unknown> = Promise.resolve();
  return {
    async execAsync(sql: string): Promise<void> {
      db.exec(sql);
    },

    async runAsync(sql: string, params: readonly SqlBindValue[] = []): Promise<SqlRunResult> {
      db.run(sql, params as SqlBindValue[]);
      return { changes: db.getRowsModified() };
    },

    async getAllAsync<T>(sql: string, params: readonly SqlBindValue[] = []): Promise<T[]> {
      const stmt = db.prepare(sql);
      try {
        if (params.length > 0) stmt.bind(params as SqlBindValue[]);
        const rows: T[] = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject() as T);
        }
        return rows;
      } finally {
        stmt.free();
      }
    },

    withTransactionAsync(fn: () => Promise<void>): Promise<void> {
      const run = transactionTail.then(async () => {
        db.run('BEGIN');
        try {
          await fn();
          db.run('COMMIT');
        } catch (err) {
          db.run('ROLLBACK');
          throw err;
        }
      });
      transactionTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/** Creates a brand-new in-memory sql.js-backed `SqlDatabase` for a test. */
export async function createSqlJsDatabase(): Promise<SqlDatabase> {
  const SQL = await loadSqlJs();
  return wrapSqlJsDatabase(new SQL.Database());
}

/** Wraps a `SqlDatabase` over the SAME underlying sql.js `Database` instance passed in, rather than a fresh one -- used to simulate re-opening the app's on-device database across a restart. */
export function wrapExistingSqlJsDatabase(db: Database): SqlDatabase {
  return wrapSqlJsDatabase(db);
}

export async function createRawSqlJsDatabase(): Promise<Database> {
  const SQL = await loadSqlJs();
  return new SQL.Database();
}
