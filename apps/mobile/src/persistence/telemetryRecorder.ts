import type { SqlDatabase, TelemetryChannelId, TelemetrySample } from '@circuit/core';

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
 * Mirrors -- WITHOUT importing or modifying -- `SessionController`'s own
 * `lapPersistenceTail` discipline (packages/core/src/controller/sessionController.ts,
 * out of this ticket's write set): a single serialized promise chain so an
 * immediate lap-crossing flush racing the periodic batch boundary can never
 * open two overlapping writes on the same connection, plus a `pendingWork`
 * array `flush()` awaits with `Promise.all` so a caller (composition.ts's
 * `endSession()`) can be sure every write kicked off so far has actually
 * landed.
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

  private async writeBatch(batch: readonly BufferedRow[]): Promise<void> {
    const room = this.rowCap - this.rowsWritten;
    if (room <= 0) {
      this.capReached = true;
      return;
    }
    const toWrite = batch.length > room ? batch.slice(0, room) : batch;
    await this.db.withTransactionAsync(async () => {
      for (const row of toWrite) {
        await this.db.runAsync(
          'INSERT INTO telemetry_samples (session_id, lap_number, t_mono_ms, channel, value) VALUES (?, ?, ?, ?, ?)',
          [this.sessionId, row.lapNumber, row.tMonoMs, row.channel, row.value],
        );
      }
    });
    this.rowsWritten += toWrite.length;
    if (toWrite.length < batch.length) this.capReached = true;
  }
}
