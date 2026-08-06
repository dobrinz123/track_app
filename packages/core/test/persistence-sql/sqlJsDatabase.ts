import initSqlJs, { type Database } from 'sql.js';
import type { SqlBindValue, SqlDatabase, SqlRunResult } from '../../src/persistence-sql';

// sql.js loads its WASM module once per process; caching the initializer
// avoids re-instantiating the WASM binary for every test file / repository
// instance.
let sqlJsModulePromise: ReturnType<typeof initSqlJs> | null = null;
function loadSqlJs(): ReturnType<typeof initSqlJs> {
  sqlJsModulePromise ??= initSqlJs();
  return sqlJsModulePromise;
}

/** Wraps a live sql.js `Database` handle as a `SqlDatabase`. */
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

/**
 * Creates a `SqlDatabase` over the *same* underlying sql.js `Database`
 * instance passed in, rather than a fresh one -- used by the migration
 * idempotence test to open a second `SqlSessionRepository` against a store
 * that already has data and already-applied DDL.
 */
export function wrapExistingSqlJsDatabase(db: Database): SqlDatabase {
  return wrapSqlJsDatabase(db);
}

export async function createRawSqlJsDatabase(): Promise<Database> {
  const SQL = await loadSqlJs();
  return new SQL.Database();
}
