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

    async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
      db.run('BEGIN');
      try {
        await fn();
        db.run('COMMIT');
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }
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
