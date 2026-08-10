/**
 * N1 fix (WPT3 re-verify, LEAD takeover): mutual exclusion for MULTI-STATEMENT
 * database work on the single on-device SQLite connection.
 *
 * The predecessor design (`serializeSqlDatabase`, removed) queued EVERY call
 * -- including the statements a transaction callback itself issues -- onto one
 * FIFO tail. `withTransactionAsync` then occupied the queue while its callback
 * awaited `runAsync`, which was queued BEHIND it: a guaranteed self-deadlock
 * for every repository transaction (session save, PB replacement, delete-all).
 *
 * The gate is therefore held only around WHOLE units that must not interleave:
 *   - each repository transaction (BEGIN..COMMIT spans awaits, so a concurrent
 *     writer on the same connection would land inside it) -- wrapped by
 *     `gateSqlTransactions` below;
 *   - each telemetry batch INSERT (`TelemetryRecorder.writeBatch`).
 * Statements issued INSIDE a gated unit go straight to the connection --
 * they belong to the holder's critical section, so there is no reentrancy
 * and no deadlock. Plain single statements outside any gated unit are atomic
 * on their own and safe to interleave between units.
 */
import type { SqlDatabase } from '@circuit/core/src/persistence-sql';

export interface SqlWriteGate {
  /** Runs `op` with the gate held; queued FIFO behind any current holder. Never swallows `op`'s rejection. */
  exclusive<T>(op: () => Promise<T>): Promise<T>;
}

export function createSqlWriteGate(): SqlWriteGate {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    exclusive<T>(op: () => Promise<T>): Promise<T> {
      const result = tail.then(op, op);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

/** No-op gate for tests / in-memory paths that have no shared connection to protect. */
export const PASSTHROUGH_WRITE_GATE: SqlWriteGate = { exclusive: (op) => op() };

/**
 * Wraps a `SqlDatabase` so `withTransactionAsync` acquires `gate` for the
 * transaction's whole duration. All other methods pass through untouched --
 * see the module doc comment for why wrapping them would deadlock.
 */
export function gateSqlTransactions(inner: SqlDatabase, gate: SqlWriteGate): SqlDatabase {
  return {
    execAsync: (sql) => inner.execAsync(sql),
    runAsync: (sql, params) => inner.runAsync(sql, params),
    getAllAsync: (sql, params) => inner.getAllAsync(sql, params),
    withTransactionAsync: (fn) => gate.exclusive(() => inner.withTransactionAsync(fn)),
  };
}
