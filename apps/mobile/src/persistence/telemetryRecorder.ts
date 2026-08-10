import type { SqlBindValue, SqlDatabase, TelemetryChannelId, TelemetrySample } from '@circuit/core';
import { PASSTHROUGH_WRITE_GATE, type SqlWriteGate } from './sqlWriteGate';

const BATCH_SIZE = 25;
const BATCH_INTERVAL_MS = 1_000;

/** Retention cap (binding, M2 lineage, Telemetry addendum): at most 200,000 telemetry rows per session. */
export const TELEMETRY_ROW_CAP = 200_000;

export interface TelemetryRecorderDiagnostics {
  rowsWritten: number;
  capReached: boolean;
}

interface BufferedRow {
  lapNumber: number | null;
  tMonoMs: number;
  channel: TelemetryChannelId;
  value: number;
}

/**
 * Batched SQLite writer for the `telemetry_samples` table (Telemetry
 * addendum's "Recording (mobile, SQLite)" section) -- batched inserts (25
 * samples or 1s, whichever first), flushed on lap crossing and `endSession`.
 *
 * Serializes ITS OWN batch writes with a private `tail` promise chain (so an
 * immediate lap-crossing flush racing the periodic batch boundary can never
 * compute `rowsWritten`/room from a stale pre-write snapshot), plus a
 * `pendingWork` array `flush()` awaits with `Promise.all` so a caller
 * (composition.ts's `endSession()`) can be sure every write kicked off so
 * far has actually landed.
 *
 * F1 fix (WPT3, binding): a flush NEVER opens its own `withTransactionAsync`
 * -- previously it wrapped each batch's inserts in one, which could BEGIN a
 * nested SQLite transaction while `SessionController`'s own lap-persistence
 * transaction (packages/core, out of this ticket's write set -- see
 * `sessionController.ts`'s private `lapPersistenceTail`) was still open on
 * the SAME on-device connection, throwing "cannot start a transaction within
 * a transaction" and breaking lap/PB persistence. Each flush is now exactly
 * ONE parameterized multi-row `INSERT` statement (`writeBatch` below) --
 * already atomic in SQLite without an explicit transaction wrapper, so this
 * recorder issues zero `BEGIN`s ever. The "never interleaves with an open
 * controller transaction" guarantee (N1 fix, LEAD takeover) comes from the
 * shared `SqlWriteGate`: `openAppDatabase()` gates every repository
 * transaction for its whole BEGIN..COMMIT span, and `writeBatch` acquires
 * the SAME gate around its single INSERT -- so the INSERT can never execute
 * inside a controller transaction's open window, and (unlike the removed
 * every-call `serializeSqlDatabase` FIFO, which self-deadlocked every
 * transaction) the transaction callback's own inner statements pass through
 * freely. See sqlWriteGate.ts's module doc comment.
 *
 * Telemetry NEVER gates lap timing (binding): every method here is either
 * synchronous/fire-and-forget (`record`, `flushOnLapCrossing`) or awaited
 * only by composition.ts's own end-of-session hook, never by the timing
 * pipeline itself. `record()` and the periodic/lap-crossing flushes never
 * throw synchronously; a write failure is caught inside the serialized chain
 * (see `writeBatch`) and surfaces only through the promise `flush()`/
 * `endSession()` return.
 */
export class TelemetryRecorder {
  private buffer: BufferedRow[] = [];
  private rowsWritten = 0;
  private capReached = false;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private pendingWork: Promise<void>[] = [];
  private disposed = false;

  constructor(
    private readonly db: SqlDatabase,
    private readonly sessionId: string,
    /** Row cap override -- test-only seam; production callers always use the binding default (`TELEMETRY_ROW_CAP`, 200,000/session). */
    private readonly rowCap: number = TELEMETRY_ROW_CAP,
    /** Shared write gate (N1 fix): production passes `openAppDatabase()`'s gate so batch INSERTs mutually exclude with repository transactions. */
    private readonly writeGate: SqlWriteGate = PASSTHROUGH_WRITE_GATE,
  ) {}

  /** Buffers one sample tagged with the caller's currently-known lap number (`null` before the first lap starts). No-op once disposed or once the 200k row cap has been reached. */
  record(sample: TelemetrySample, lapNumber: number | null): void {
    if (this.disposed || this.capReached) return;
    this.buffer.push({ lapNumber, tMonoMs: sample.tMonoMs, channel: sample.channel, value: sample.value });
    if (this.buffer.length >= BATCH_SIZE) {
      this.flushBuffer();
      return;
    }
    if (this.batchTimer === null) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        this.flushBuffer();
      }, BATCH_INTERVAL_MS);
    }
  }

  /** Flushes the current buffer immediately (lap crossing) -- queued onto the same serialized tail as the periodic batch boundary, never awaited by the caller (telemetry must never gate lap timing). */
  flushOnLapCrossing(): void {
    this.flushBuffer();
  }

  /** Flushes any buffered rows and awaits every write kicked off so far. Composition.ts's `endSession` hook. */
  async endSession(): Promise<void> {
    this.flushBuffer();
    await this.flush();
  }

  /** Awaits every in-flight write (mirrors `SessionController.flush()`'s own contract/doc comment). */
  async flush(): Promise<void> {
    const pending = this.pendingWork;
    this.pendingWork = [];
    await Promise.all(pending);
  }

  diagnostics(): TelemetryRecorderDiagnostics {
    return { rowsWritten: this.rowsWritten, capReached: this.capReached };
  }

  /** Cancels any pending batch timer and drops the buffer without writing -- composition.ts calls this once `endSession()` has settled, so a stray late `record()` after teardown is a guaranteed no-op. */
  dispose(): void {
    this.disposed = true;
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.buffer = [];
  }

  private flushBuffer(): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const persistence = this.tail.then(() => this.writeBatch(batch));
    // Keep later batches moving even if one write fails; `persistence` itself
    // is still tracked in `pendingWork` so the original rejection reaches
    // `flush()`'s caller.
    this.tail = persistence.catch(() => undefined);
    this.pendingWork.push(persistence);
  }

  /**
   * F1 fix: ONE parameterized multi-row `INSERT` for the whole batch -- no
   * `withTransactionAsync`, no per-row `runAsync` loop (never more than one
   * statement per flush, so this recorder issues zero `BEGIN`s). A single
   * multi-row `INSERT` is already atomic in SQLite.
   *
   * F5 fix: `capReached` is set whenever `rowsWritten` has reached `rowCap`
   * AFTER this write, not only when this specific batch was truncated --
   * previously a batch that landed EXACTLY on the cap (common: the binding
   * cap and `BATCH_SIZE` are both round numbers) left `capReached` false
   * until some LATER batch happened to see zero room, so diagnostics briefly
   * under-reported and `record()` kept buffering (and dropping at the next
   * flush) instead of rejecting up front.
   */
  private async writeBatch(batch: readonly BufferedRow[]): Promise<void> {
    const room = this.rowCap - this.rowsWritten;
    if (room <= 0) {
      this.capReached = true;
      return;
    }
    const toWrite = batch.length > room ? batch.slice(0, room) : batch;
    const placeholders = toWrite.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const params: SqlBindValue[] = [];
    for (const row of toWrite) {
      params.push(this.sessionId, row.lapNumber, row.tMonoMs, row.channel, row.value);
    }
    await this.writeGate.exclusive(() =>
      this.db.runAsync(
        `INSERT INTO telemetry_samples (session_id, lap_number, t_mono_ms, channel, value) VALUES ${placeholders}`,
        params,
      ),
    );
    this.rowsWritten += toWrite.length;
    if (this.rowsWritten >= this.rowCap) this.capReached = true;
  }
}
