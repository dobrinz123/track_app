import type {
  LapRecord,
  LocalSessionRepository,
  LocationSample,
  ReferenceLap,
  SessionCalibrationStatus,
  SessionMachineSnapshot,
  SessionSummary,
} from '../contracts';
import { CheckpointCodec, assertJsonSerializable, validateReferenceLap } from '../persistence';
import type { SqlDatabase } from './sqlDatabase';
import { SQL_ALTERS_V3, SQL_DDL, SQL_DDL_V2, SQL_SCHEMA_VERSION } from './schema';

interface SessionRow {
  sessionId: string;
  userId: string;
  circuitId: string;
  layoutId: string;
  layoutVersion: number;
  startedAtUtc: string;
  calibrationStatus: string | null;
  traceUnwritten: number | null;
  traceFailedWrites: number | null;
}

/**
 * Ticket P10A H6 (binding): an unreadable/absent/unrecognised stored value is
 * `'unknown'`. Never `'validated'` -- a session nobody vouched for must not be
 * able to present itself afterwards as one that was.
 */
function decodeCalibrationStatus(raw: string | null): SessionCalibrationStatus {
  return raw === 'validated' || raw === 'unvalidated' ? raw : 'unknown';
}

interface PayloadRow {
  payload: string;
}

/**
 * SQL-backed `LocalSessionRepository`, written against the minimal
 * `SqlDatabase` interface so it runs unmodified over expo-sqlite in the app
 * and over sql.js in tests (see docs/architecture/contracts.md and
 * packages/core/src/persistence/inMemorySessionRepository.ts, whose semantics
 * this class must match exactly: deep-copy reads, atomic PB replace,
 * structural ReferenceLap validation, last-write-wins telemetry).
 *
 * All rows store their payload as a JSON TEXT column; parsing that JSON on
 * every read is what gives "deep copy" semantics for free -- there is no
 * in-process object shared between a write and a later read.
 */
export class SqlSessionRepository implements LocalSessionRepository {
  private constructor(private readonly db: SqlDatabase) {}

  /**
   * Opens (migrating if necessary) a `SqlSessionRepository` over `db`.
   * Migration is idempotent: calling `create` again against a database that
   * has already been migrated re-applies only `CREATE TABLE IF NOT EXISTS`
   * statements (no-ops) and does not touch existing rows.
   */
  static async create(db: SqlDatabase): Promise<SqlSessionRepository> {
    const repo = new SqlSessionRepository(db);
    await repo.migrate();
    return repo;
  }

  private async migrate(): Promise<void> {
    // WAL is a write-throughput pragma only; correctness never depends on
    // journal mode. sql.js has no VFS/file backing and throws on this
    // pragma -- that failure is expected and ignored. Real SQLite via
    // expo-sqlite applies it (platform-research.md §6).
    try {
      await this.db.execAsync('PRAGMA journal_mode = WAL;');
    } catch {
      // sql.js: WAL unsupported, ignored by design (see comment above).
    }

    await this.db.execAsync(SQL_DDL);
    // v2: the settings key-value table. `CREATE TABLE IF NOT EXISTS` makes
    // this safe to run unconditionally, but the version bump below only
    // fires on databases that actually need it (see the branches beneath).
    await this.db.execAsync(SQL_DDL_V2);
    // v3 (ticket P10A): the durable calibration-provenance and trace-completeness
    // columns on `sessions`. Each ALTER is attempted on its own and its
    // "duplicate column name" failure ignored, which is what makes running
    // this on EVERY open (not only on a version bump) both safe and the
    // stronger guarantee -- see `SQL_ALTERS_V3`'s own doc comment.
    for (const statement of SQL_ALTERS_V3) {
      try {
        await this.db.execAsync(statement);
      } catch {
        // Column already present. The only other way this can fail is a
        // database so broken that every statement below would fail too.
      }
    }

    const versionRows = await this.db.getAllAsync<{ version: number }>(
      'SELECT version FROM schema_migrations LIMIT 1',
    );
    const currentVersion = versionRows[0]?.version ?? 0;
    if (currentVersion === 0) {
      // Fresh database: record the current schema version outright.
      await this.db.runAsync('INSERT INTO schema_migrations (version) VALUES (?)', [SQL_SCHEMA_VERSION]);
    } else if (currentVersion < SQL_SCHEMA_VERSION) {
      // Upgrade path: a database created under an older `SqlSessionRepository`
      // (e.g. v1, no `settings` table) is opened again -- `SQL_DDL_V2` above
      // has already created the missing table; bump the recorded version to
      // match. Existing rows in every other table are untouched.
      await this.db.runAsync('UPDATE schema_migrations SET version = ?', [SQL_SCHEMA_VERSION]);
    }
  }

  async saveCheckpoint(sessionId: string, snapshot: SessionMachineSnapshot, laps: LapRecord[]): Promise<void> {
    // CheckpointCodec.serialize() runs assertJsonSerializable internally and
    // throws before any DB IO on a non-serializable snapshot/laps value.
    const payload = CheckpointCodec.serialize({ snapshot, laps });
    await this.db.runAsync('INSERT OR REPLACE INTO checkpoints (sessionId, payload) VALUES (?, ?)', [
      sessionId,
      payload,
    ]);
  }

  /**
   * Ticket P10B H4-B -- LAP TELEMETRY, RECLAIM AND THE RECOVERY CHECKPOINT
   * COMMIT TOGETHER.
   *
   * `saveTelemetryBatch` (P10A H4) already made the lap row and the reclaim
   * of the chunks it claims atomic. The checkpoint stayed OUTSIDE that
   * transaction, and the P10B reviewer reproduced what that costs: interrupt
   * after the batch commits but before the checkpoint lands, and storage
   * holds lap 1's 93 fixes with the chunk copies already reclaimed while the
   * checkpoint still says "no laps". The resumed run then allocates lap
   * number 1 again and REPLACES that row -- 93 fixes gone, with no copy left
   * anywhere.
   *
   * Committing the checkpoint in the same transaction makes that state
   * unreachable: either the lap exists in both places, or in neither (in
   * which case the fixes are still in their chunk rows, untouched).
   */
  async saveLapCommit(
    sessionId: string,
    entries: readonly { lapNumber: number; samples: LocationSample[] }[],
    checkpoint: { snapshot: SessionMachineSnapshot; laps: LapRecord[] },
  ): Promise<void> {
    for (const entry of entries) {
      assertJsonSerializable(entry.samples, `telemetry(${sessionId}, lap ${entry.lapNumber})`);
    }
    // Serialized (and validated) BEFORE the transaction opens, exactly like
    // `saveCheckpoint`: a non-serializable snapshot must not be able to abort
    // a transaction half-way, it must never open one.
    const payload = CheckpointCodec.serialize({ snapshot: checkpoint.snapshot, laps: checkpoint.laps });
    await this.db.withTransactionAsync(async (tx) => {
      for (const entry of entries) {
        await tx.runAsync(
          'INSERT OR REPLACE INTO telemetry (sessionId, lapNumber, payload) VALUES (?, ?, ?)',
          [sessionId, entry.lapNumber, JSON.stringify(entry.samples)],
        );
      }
      await tx.runAsync('INSERT OR REPLACE INTO checkpoints (sessionId, payload) VALUES (?, ?)', [
        sessionId,
        payload,
      ]);
    });
  }

  async loadCheckpoint(sessionId: string): Promise<{ snapshot: SessionMachineSnapshot; laps: LapRecord[] } | null> {
    const rows = await this.db.getAllAsync<PayloadRow>('SELECT payload FROM checkpoints WHERE sessionId = ?', [
      sessionId,
    ]);
    const row = rows[0];
    if (!row) return null;
    // CheckpointCodec.deserialize never throws; a corrupt/legacy row reads
    // back as null rather than as garbage, same guarantee the codec's own
    // tests already establish (checkpointCodec.test.ts).
    return CheckpointCodec.deserialize(row.payload);
  }

  async saveSession(s: SessionSummary): Promise<void> {
    assertJsonSerializable(s.laps, `session(${s.sessionId}).laps`);
    await this.db.withTransactionAsync(async (tx) => {
      await tx.runAsync(
        `INSERT OR REPLACE INTO sessions
           (sessionId, userId, circuitId, layoutId, layoutVersion, startedAtUtc,
            calibrationStatus, traceUnwritten, traceFailedWrites)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          s.sessionId,
          s.userId,
          s.circuitId,
          s.layoutId,
          s.layoutVersion,
          s.startedAtUtc,
          // Ticket P10A H6: an absent status is stored AS `'unknown'` rather
          // than as NULL, so the row states the fact rather than leaving the
          // reader to infer it.
          s.calibrationStatus ?? 'unknown',
          s.trace?.unwrittenSampleCount ?? null,
          s.trace?.failedWriteCount ?? null,
        ],
      );
      // Full replace of this session's laps: matches saveSession's
      // "last write wins for this sessionId" semantics.
      await tx.runAsync('DELETE FROM laps WHERE sessionId = ?', [s.sessionId]);
      for (const lap of s.laps) {
        await tx.runAsync('INSERT INTO laps (sessionId, lapNumber, payload) VALUES (?, ?, ?)', [
          s.sessionId,
          lap.lapNumber,
          JSON.stringify(lap),
        ]);
      }
    });
  }

  async listSessions(userId: string, circuitId: string): Promise<SessionSummary[]> {
    const sessionRows = await this.db.getAllAsync<SessionRow>(
      `SELECT sessionId, userId, circuitId, layoutId, layoutVersion, startedAtUtc,
              calibrationStatus, traceUnwritten, traceFailedWrites
       FROM sessions
       WHERE userId = ? AND circuitId = ?
       ORDER BY startedAtUtc DESC`,
      [userId, circuitId],
    );

    const results: SessionSummary[] = [];
    for (const row of sessionRows) {
      const lapRows = await this.db.getAllAsync<PayloadRow>(
        'SELECT payload FROM laps WHERE sessionId = ? ORDER BY lapNumber ASC',
        [row.sessionId],
      );
      results.push({
        sessionId: row.sessionId,
        userId: row.userId,
        circuitId: row.circuitId,
        layoutId: row.layoutId,
        layoutVersion: row.layoutVersion,
        startedAtUtc: row.startedAtUtc,
        laps: lapRows.map((r) => JSON.parse(r.payload) as LapRecord),
        calibrationStatus: decodeCalibrationStatus(row.calibrationStatus ?? null),
        ...(row.traceUnwritten === null && row.traceFailedWrites === null
          ? {}
          : {
              trace: {
                unwrittenSampleCount: row.traceUnwritten ?? 0,
                failedWriteCount: row.traceFailedWrites ?? 0,
              },
            }),
      });
    }
    return results;
  }

  async saveTelemetry(sessionId: string, lapNumber: number, samples: LocationSample[]): Promise<void> {
    assertJsonSerializable(samples, `telemetry(${sessionId}, lap ${lapNumber})`);
    // A second write for the same (sessionId, lapNumber) REPLACES rather than
    // appends -- same "atomic replace" semantics as the in-memory Map.set().
    await this.db.runAsync('INSERT OR REPLACE INTO telemetry (sessionId, lapNumber, payload) VALUES (?, ?, ?)', [
      sessionId,
      lapNumber,
      JSON.stringify(samples),
    ]);
  }

  /**
   * Ticket P10A H4: every entry in ONE `withTransactionAsync` -- the lap row
   * and the reclaimed chunk rewrites commit together or not at all, so the
   * same fixes can never be left owned by two rows at once.
   */
  async saveTelemetryBatch(
    sessionId: string,
    entries: readonly { lapNumber: number; samples: LocationSample[] }[],
  ): Promise<void> {
    for (const entry of entries) {
      assertJsonSerializable(entry.samples, `telemetry(${sessionId}, lap ${entry.lapNumber})`);
    }
    if (entries.length === 0) return;
    await this.db.withTransactionAsync(async (tx) => {
      for (const entry of entries) {
        await tx.runAsync(
          'INSERT OR REPLACE INTO telemetry (sessionId, lapNumber, payload) VALUES (?, ?, ?)',
          [sessionId, entry.lapNumber, JSON.stringify(entry.samples)],
        );
      }
    });
  }

  async loadTelemetry(sessionId: string, lapNumber: number): Promise<LocationSample[]> {
    const rows = await this.db.getAllAsync<PayloadRow>(
      'SELECT payload FROM telemetry WHERE sessionId = ? AND lapNumber = ?',
      [sessionId, lapNumber],
    );
    const row = rows[0];
    return row ? (JSON.parse(row.payload) as LocationSample[]) : [];
  }

  async getReferenceLap(
    userId: string,
    circuitId: string,
    layoutId: string,
    layoutVersion: number,
  ): Promise<ReferenceLap | null> {
    const rows = await this.db.getAllAsync<PayloadRow>(
      'SELECT payload FROM reference_laps WHERE userId = ? AND circuitId = ? AND layoutId = ? AND layoutVersion = ?',
      [userId, circuitId, layoutId, layoutVersion],
    );
    const row = rows[0];
    return row ? (JSON.parse(row.payload) as ReferenceLap) : null;
  }

  async putReferenceLap(ref: ReferenceLap): Promise<void> {
    // Validate BEFORE touching the store, exactly like
    // InMemorySessionRepository: a failed validation must never begin a
    // transaction, so a previously-stored reference lap for this key is left
    // completely untouched.
    validateReferenceLap(ref);
    assertJsonSerializable(ref, `referenceLap(${ref.userId}/${ref.circuitId}/${ref.layoutId}/${ref.layoutVersion})`);
    const payload = JSON.stringify(ref);

    // Atomic replace: DELETE+INSERT wrapped in one transaction, per the
    // ticket's explicit instruction (rather than a single INSERT OR REPLACE)
    // so the atomicity is real and testable -- if the INSERT half fails for
    // any reason, the whole transaction rolls back and the prior row (if any)
    // is restored by SQLite, never left half-deleted.
    await this.db.withTransactionAsync(async (tx) => {
      await tx.runAsync(
        'DELETE FROM reference_laps WHERE userId = ? AND circuitId = ? AND layoutId = ? AND layoutVersion = ?',
        [ref.userId, ref.circuitId, ref.layoutId, ref.layoutVersion],
      );
      await tx.runAsync(
        'INSERT INTO reference_laps (userId, circuitId, layoutId, layoutVersion, payload) VALUES (?, ?, ?, ?, ?)',
        [ref.userId, ref.circuitId, ref.layoutId, ref.layoutVersion, payload],
      );
    });
  }

  async deleteUserData(userId: string): Promise<void> {
    // The app mints sessionIds as `${userId}--<random>` (WP11a concern): a
    // session that has a checkpoint and/or telemetry but was never saved via
    // saveSession (still active, or the app crashed before saving) has no row
    // in `sessions`, so the sessions-join deletes below can never reach it.
    // The prefix sweep at the end is what covers that case.
    const sessionIdPrefix = `${userId}--`;

    await this.db.withTransactionAsync(async (tx) => {
      await tx.runAsync('DELETE FROM laps WHERE sessionId IN (SELECT sessionId FROM sessions WHERE userId = ?)', [
        userId,
      ]);
      await tx.runAsync(
        'DELETE FROM checkpoints WHERE sessionId IN (SELECT sessionId FROM sessions WHERE userId = ?)',
        [userId],
      );
      await tx.runAsync(
        'DELETE FROM telemetry WHERE sessionId IN (SELECT sessionId FROM sessions WHERE userId = ?)',
        [userId],
      );
      await tx.runAsync('DELETE FROM sessions WHERE userId = ?', [userId]);
      await tx.runAsync('DELETE FROM reference_laps WHERE userId = ?', [userId]);

      // Orphan sweep by sessionId prefix (see comment above). `substr(x, 1, N)
      // = prefix` with N = length(prefix) is a plain-equality prefix match
      // that needs no LIKE-wildcard escaping of userId.
      await tx.runAsync('DELETE FROM checkpoints WHERE substr(sessionId, 1, length(?)) = ?', [
        sessionIdPrefix,
        sessionIdPrefix,
      ]);
      await tx.runAsync('DELETE FROM telemetry WHERE substr(sessionId, 1, length(?)) = ?', [
        sessionIdPrefix,
        sessionIdPrefix,
      ]);
    });
  }
}
