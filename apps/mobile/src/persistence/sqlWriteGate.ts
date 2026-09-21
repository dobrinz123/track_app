/**
 * N1 fix (WPT3 re-verify, LEAD takeover), extended by ticket P10B H5-B:
 * mutual exclusion for database work on the single on-device SQLite
 * connection.
 *
 * The predecessor design (`serializeSqlDatabase`, removed) queued EVERY call
 * -- including the statements a transaction callback itself issues -- onto one
 * FIFO tail. `withTransactionAsync` then occupied the queue while its callback
 * awaited `runAsync`, which was queued BEHIND it: a guaranteed self-deadlock
 * for every repository transaction (session save, PB replacement, delete-all).
 * The reaction to that was to gate ONLY whole transactions and let every
 * standalone statement through ungated -- which is the defect ticket P10B
 * H5-B is about.
 *
 * WHAT WENT WRONG WITH "STANDALONE STATEMENTS ARE ATOMIC ON THEIR OWN".
 * They are, in isolation. But SQLite has no statement-level isolation from an
 * ALREADY OPEN transaction on the SAME connection: a `runAsync` issued while
 * some other unit sits between BEGIN and COMMIT simply becomes part of that
 * transaction, and is undone with it. The P10B reviewer reproduced it: hold
 * the initial session transaction at `DELETE FROM laps`, flush ten trace
 * fixes (nine chunk rows written and reported persisted), then fail the
 * session transaction -- rollback took every one of those chunk rows with it,
 * while the recorder still reported ten fixes persisted and zero unwritten.
 *
 * THE FIX IS TRANSACTION-SCOPED ACCESS, not "gate less". Every call made
 * through the wrapper -- standalone statements included -- now acquires the
 * gate, so nothing can execute inside another unit's open transaction. The
 * statements a transaction ITSELF issues no longer come through the wrapper
 * at all: `withTransactionAsync` hands its callback a `tx` handle bound
 * straight to the connection (see {@link SqlDatabase.withTransactionAsync}),
 * so the holder's own critical section never queues behind itself. That is
 * what makes full serialization deadlock-free where the original attempt was
 * not.
 *
 * Callers must therefore never reach for the outer handle inside a
 * transaction callback, and never wrap a statement issued through the gated
 * handle in `gate.exclusive(...)` of their own -- both re-enter the gate and
 * deadlock. Multi-statement atomicity is expressed with
 * `withTransactionAsync`, which is the only thing that ever needed it.
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
 * Ticket P10B H5-B: wraps a `SqlDatabase` so EVERY unit of work -- a whole
 * transaction, or one standalone statement -- acquires `gate` for its whole
 * duration. A standalone write can therefore no longer execute inside (and be
 * rolled back by) an unrelated transaction.
 *
 * The statements a transaction issues do not pass through here: they go
 * through the `tx` handle `inner.withTransactionAsync` supplies, straight to
 * the connection the gate is already held for. See the module doc comment.
 */
export function gateSqlTransactions(inner: SqlDatabase, gate: SqlWriteGate): SqlDatabase {
  return {
    execAsync: (sql) => gate.exclusive(() => inner.execAsync(sql)),
    runAsync: (sql, params) => gate.exclusive(() => inner.runAsync(sql, params)),
    getAllAsync: (sql, params) => gate.exclusive(() => inner.getAllAsync(sql, params)),
    withTransactionAsync: (fn) => gate.exclusive(() => inner.withTransactionAsync(fn)),
  };
}
