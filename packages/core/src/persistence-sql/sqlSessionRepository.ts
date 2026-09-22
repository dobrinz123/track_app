import type {
  CalibrationAttemptRecord,
  LapRecord,
  LapValidityVerdict,
  LocalSessionRepository,
  LocationSample,
  ReferenceLap,
  SessionCalibrationStatus,
  SessionMachineSnapshot,
  SessionSummary,
  StoredRecordRead,
} from '../contracts';
import {
  CheckpointCodec,
  assertJsonSerializable,
  checkpointGeneration,
  validateReferenceLap,
} from '../persistence';
import type { SqlDatabase } from './sqlDatabase';
import {
  SQL_ALTERS_V3,
  SQL_ALTERS_V4,
  SQL_ALTERS_V6,
  SQL_DDL,
  SQL_DDL_V2,
  SQL_DDL_V5,
  SQL_SCHEMA_VERSION,
} from './schema';

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
  /** Ticket P14 H3: `1` finalised, `0` still recording, NULL unknown (row predates the column). */
  traceFinalized: number | null;
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
 * Ticket P12 items A/B: parses a list of JSON payload rows, SKIPPING any that
 * will not parse rather than failing the whole read. One corrupt row out of a
 * session's worth of answers must not cost the others -- the same trade
 * `readUnclaimedGnssChunks` already makes for the trace, and the same reason:
 * these reads exist to get data OFF the device.
 *
 * Ticket P14 H5 (Codex P13 round) -- BUT IT SAYS SO NOW. The old version
 * returned the survivors and told nobody, so a table of unreadable rows came
 * back as `[]` and every reader above it classified an INACCESSIBLE record as
 * "read, and there genuinely was nothing". The skip is still the right trade;
 * the silence was not. `unreadableCount` is what turns the caller's report
 * section from `empty` into `failed`.
 */
function parsePayloads<T>(rows: readonly PayloadRow[]): StoredRecordRead<T> {
  const records: T[] = [];
  let unreadableCount = 0;
  for (const row of rows) {
    try {
      records.push(JSON.parse(row.payload) as T);
    } catch {
      unreadableCount += 1;
    }
  }
  return { records, unreadableCount };
}

/**
 * Ticket P16 C1 -- A ROW THIS DEVICE CANNOT DECODE, SAID OUT LOUD.
 *
 * The counterpart to {@link parsePayloads} for the reads whose return type is
 * ONE value rather than a list. `loadTelemetry` answers
 * `Promise<LocationSample[]>` and `getReferenceLap` answers
 * `Promise<ReferenceLap | null>`: neither signature has anywhere to put "the
 * row is there and it will not parse", and the two values those signatures DO
 * offer -- `[]` and `null` -- both mean THERE WAS NOTHING. Returning either
 * for a corrupt row is the fabricated-empty bug this whole area exists to
 * remove: a driven lap would export as a lap with no trace, and a stored
 * personal best would read as "no personal best yet" and be overwritten by
 * the next slower lap.
 *
 * So these reads FAIL, and they fail with a named error that says which row,
 * instead of a bare `SyntaxError` from somewhere inside a `.map`. This is a
 * deliberate difference from the list reads: there, skipping costs one row out
 * of many and the count carries the loss; here, the row IS the answer.
 */
export class StoredPayloadUnreadableError extends Error {
  /** Which stored row could not be decoded, e.g. `telemetry(s1, lap 3)`. */
  readonly record: string;
  /** The underlying parse failure, kept so the cause is not lost. */
  readonly cause: unknown;

  constructor(record: string, cause: unknown) {
    super(`Stored payload could not be decoded: ${record}`);
    this.name = 'StoredPayloadUnreadableError';
    this.record = record;
    this.cause = cause;
  }
}

/** Parses one stored payload, or throws {@link StoredPayloadUnreadableError} naming it. */
function parseOnePayload<T>(payload: string, record: string): T {
  try {
    return JSON.parse(payload) as T;
  } catch (cause) {
    throw new StoredPayloadUnreadableError(record, cause);
  }
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
    // v5 (ticket P12 items A/B): the lap-verdict and calibration-attempt
    // tables. Both are `CREATE TABLE IF NOT EXISTS`, so like `SQL_DDL_V2`
    // above this is safe to run on every open.
    await this.db.execAsync(SQL_DDL_V5);
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
    // v4 (ticket P11C): `checkpoints.lapCount`, on the same terms.
    for (const statement of SQL_ALTERS_V4) {
      try {
        await this.db.execAsync(statement);
      } catch {
        // Column already present -- see SQL_ALTERS_V3's loop above.
      }
    }
    // v6 (ticket P14 H3): `sessions.traceFinalized`, on the same terms.
    for (const statement of SQL_ALTERS_V6) {
      try {
        await this.db.execAsync(statement);
      } catch {
        // Column already present -- see SQL_ALTERS_V3's loop above.
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

  /**
   * The AUTHORITATIVE checkpoint write: it always replaces. Its callers
   * (`SessionController.checkpointNow()`, the terminal `endSession()`
   * checkpoint, the recording-start record, the host's own adoption write)
   * all pass the session's LIVE lap list, which is by construction at least
   * as new as anything a retry could be carrying, and a test or a recovery
   * tool must be able to put a checkpoint back deliberately.
   *
   * Ticket P11C: it keeps `lapCount` -- the checkpoint's generation -- in
   * step with the payload, because that column is what
   * {@link saveLapCommit}'s conditional write compares against.
   */
  async saveCheckpoint(sessionId: string, snapshot: SessionMachineSnapshot, laps: LapRecord[]): Promise<void> {
    // CheckpointCodec.serialize() runs assertJsonSerializable internally and
    // throws before any DB IO on a non-serializable snapshot/laps value.
    const payload = CheckpointCodec.serialize({ snapshot, laps });
    await this.db.runAsync('INSERT OR REPLACE INTO checkpoints (sessionId, payload, lapCount) VALUES (?, ?, ?)', [
      sessionId,
      payload,
      checkpointGeneration(laps),
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
   *
   * Ticket P11C -- AND THE CHECKPOINT ONLY EVER MOVES FORWARD.
   *
   * P10B's own retry machinery then produced the opposite failure. The P11
   * reviewer failed lap 1's commit only; lap 2 committed, leaving the
   * checkpoint at laps [1,2]; the retained lap-1 commit retried 2 s later
   * and REPLACED it with the snapshot it had captured when it first failed,
   * laps [1]. A restart then re-made the already-completed lap 2 as a
   * zero-duration RECOVERY lap, with its 927 fixes still on disk and
   * nothing pointing at them.
   *
   * So the checkpoint half of this transaction is a compare-and-set, and it
   * is ONE STATEMENT: a conditional UPSERT whose `WHERE` clause SQLite
   * evaluates against the stored row as part of the same write. Not a
   * `SELECT` followed by an `INSERT` -- not even two statements sharing this
   * transaction. Two statements would put a second await point inside the
   * BEGIN..COMMIT span, and any write that interleaves there (on a
   * connection without the app's write gate) lands between the read and the
   * write that trusted it. One statement has no such gap.
   *
   * The comparison is on `checkpoints.lapCount`, the generation column
   * (schema v4); `COALESCE(..., -1)` is the legacy row written before that
   * column existed -- generation unknown, so superseded, which is also what
   * lets a database damaged by the pre-P10B interruption be repaired.
   *
   * The telemetry entries are written unconditionally either way: a stale
   * retry still has fixes to persist, and persisting them is the whole
   * point of retrying it.
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
      await tx.runAsync(
        `INSERT INTO checkpoints (sessionId, payload, lapCount) VALUES (?, ?, ?)
           ON CONFLICT(sessionId) DO UPDATE SET payload = excluded.payload, lapCount = excluded.lapCount
           WHERE excluded.lapCount > COALESCE(checkpoints.lapCount, -1)`,
        [sessionId, payload, checkpointGeneration(checkpoint.laps)],
      );
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
            calibrationStatus, traceUnwritten, traceFailedWrites, traceFinalized)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          // Ticket P14 H3: an absent flag stays NULL (= UNKNOWN) rather than
          // being written as 0/1 on the caller's behalf. Only a caller that
          // actually knows the recording finished may claim it did.
          s.trace?.recordingFinalized === undefined ? null : s.trace.recordingFinalized ? 1 : 0,
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

  /**
   * Ticket P16 C1 -- ONE CORRUPT LAP ROW COSTS THAT ROW, NOT THE LIST.
   *
   * This used to do `lapRows.map((r) => JSON.parse(r.payload))` unguarded,
   * INSIDE the loop over every session. A single unparseable lap payload, in
   * any one session, therefore threw out of the loop and rejected the WHOLE
   * call: no history, so no session to open, so no export -- the "came home
   * with nothing" failure, through a door nobody had checked.
   *
   * `parsePayloads` (P12/P14) already makes the right trade for the verdict
   * and calibration tables; this is the same trade, with the same obligation
   * attached. The survivors are returned, and {@link SessionSummary.unreadableLapCount}
   * states how many rows this device could not decode -- because a session
   * quietly returning four laps instead of five is the SAME lie in a smaller
   * font.
   */
  async listSessions(userId: string, circuitId: string): Promise<SessionSummary[]> {
    const sessionRows = await this.db.getAllAsync<SessionRow>(
      `SELECT sessionId, userId, circuitId, layoutId, layoutVersion, startedAtUtc,
              calibrationStatus, traceUnwritten, traceFailedWrites, traceFinalized
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
      const laps = parsePayloads<LapRecord>(lapRows);
      results.push({
        sessionId: row.sessionId,
        userId: row.userId,
        circuitId: row.circuitId,
        layoutId: row.layoutId,
        layoutVersion: row.layoutVersion,
        startedAtUtc: row.startedAtUtc,
        laps: laps.records,
        // Absent, never `0`, when everything read cleanly -- so a summary
        // round-tripped through save/list is unchanged in the healthy case.
        ...(laps.unreadableCount === 0 ? {} : { unreadableLapCount: laps.unreadableCount }),
        calibrationStatus: decodeCalibrationStatus(row.calibrationStatus ?? null),
        ...(row.traceUnwritten === null && row.traceFailedWrites === null && row.traceFinalized === null
          ? {}
          : {
              trace: {
                unwrittenSampleCount: row.traceUnwritten ?? 0,
                failedWriteCount: row.traceFailedWrites ?? 0,
                // Ticket P14 H3: NULL stays ABSENT, never `false`, so a row
                // written before this column existed reads as UNKNOWN rather
                // than as "we know it was interrupted".
                ...(row.traceFinalized === null ? {} : { recordingFinalized: row.traceFinalized === 1 }),
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
    // Ticket P16 C1: a row that exists and will not parse REJECTS. `[]` would
    // say "this lap has no trace", which is a claim about the drive rather
    // than about the storage -- see {@link StoredPayloadUnreadableError}.
    // `SessionController`'s reclaim already handles a `loadTelemetry`
    // rejection explicitly (`noteReclaimFailure`) rather than treating the
    // chunk as empty.
    return row ? parseOnePayload<LocationSample[]>(row.payload, `telemetry(${sessionId}, lap ${lapNumber})`) : [];
  }

  /**
   * Ticket P12 item A. `INSERT OR REPLACE` keyed `(sessionId, lapNumber)` --
   * the same last-write-wins semantics `saveTelemetry` has, which is what a
   * re-answer needs: the row carries its own `answerRevision`, so replacing it
   * loses nothing the document is entitled to show.
   */
  async saveLapValidityVerdict(verdict: LapValidityVerdict): Promise<void> {
    assertJsonSerializable(verdict, `lapVerdict(${verdict.sessionId}, lap ${verdict.lapNumber})`);
    await this.db.runAsync(
      'INSERT OR REPLACE INTO lap_verdicts (sessionId, lapNumber, payload) VALUES (?, ?, ?)',
      [verdict.sessionId, verdict.lapNumber, JSON.stringify(verdict)],
    );
  }

  /**
   * A row whose payload will not parse is SKIPPED, not fatal -- one unreadable
   * verdict must not cost the rest of the session's answers, the same trade
   * the chunk reader makes for the trace.
   */
  async listLapValidityVerdicts(sessionId: string): Promise<LapValidityVerdict[]> {
    return (await this.listLapValidityVerdictsWithDiagnostics(sessionId)).records;
  }

  /**
   * Ticket P14 H5: the same rows, plus how many of them this device could not
   * decode. A caller that sees `unreadableCount > 0` must report the section
   * as FAILED -- an unreadable answer is not an unanswered lap.
   */
  async listLapValidityVerdictsWithDiagnostics(
    sessionId: string,
  ): Promise<StoredRecordRead<LapValidityVerdict>> {
    const rows = await this.db.getAllAsync<PayloadRow>(
      'SELECT payload FROM lap_verdicts WHERE sessionId = ? ORDER BY lapNumber ASC',
      [sessionId],
    );
    return parsePayloads<LapValidityVerdict>(rows);
  }

  /** Ticket P12 item B. Keyed by `attemptId`, so the concluded row replaces the provisional one written while the Learn lap ran. */
  async saveCalibrationAttempt(record: CalibrationAttemptRecord): Promise<void> {
    assertJsonSerializable(record, `calibrationAttempt(${record.attemptId})`);
    await this.db.runAsync(
      'INSERT OR REPLACE INTO calibration_attempts (attemptId, sessionId, startedAtUtc, payload) VALUES (?, ?, ?, ?)',
      [record.attemptId, record.sessionId, record.startedAtUtc, JSON.stringify(record)],
    );
  }

  async listCalibrationAttempts(sessionId: string): Promise<CalibrationAttemptRecord[]> {
    return (await this.listCalibrationAttemptsWithDiagnostics(sessionId)).records;
  }

  /** Ticket P14 H5: as above, plus the count of attempt rows that would not decode. */
  async listCalibrationAttemptsWithDiagnostics(
    sessionId: string,
  ): Promise<StoredRecordRead<CalibrationAttemptRecord>> {
    const rows = await this.db.getAllAsync<PayloadRow>(
      'SELECT payload FROM calibration_attempts WHERE sessionId = ? ORDER BY startedAtUtc ASC, attemptId ASC',
      [sessionId],
    );
    return parsePayloads<CalibrationAttemptRecord>(rows);
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
    // Ticket P16 C1: `null` means "no personal best for this layout yet", and
    // `SessionController` promotes a lap over a `null` reference. A corrupt PB
    // row read as `null` would therefore let the next SLOWER lap replace a
    // personal best that is still sitting on the device. It rejects instead.
    return row
      ? parseOnePayload<ReferenceLap>(
          row.payload,
          `referenceLap(${userId}/${circuitId}/${layoutId}/${layoutVersion})`,
        )
      : null;
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
      // Ticket P12 items A/B: the owner's lap verdicts and the calibration
      // attempts of those sessions are this user's data too. A delete-all that
      // left them behind would keep a record of a drive he asked to be erased.
      await tx.runAsync(
        'DELETE FROM lap_verdicts WHERE sessionId IN (SELECT sessionId FROM sessions WHERE userId = ?)',
        [userId],
      );
      await tx.runAsync(
        'DELETE FROM calibration_attempts WHERE sessionId IN (SELECT sessionId FROM sessions WHERE userId = ?)',
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
      // Ticket P12 items A/B: the same orphan sweep, for the same reason -- a
      // session whose row never reached `sessions` (still active, or killed
      // before the save) can still have a calibration attempt recorded
      // against it, because the attempt is written before the first lap.
      await tx.runAsync('DELETE FROM lap_verdicts WHERE substr(sessionId, 1, length(?)) = ?', [
        sessionIdPrefix,
        sessionIdPrefix,
      ]);
      await tx.runAsync('DELETE FROM calibration_attempts WHERE substr(sessionId, 1, length(?)) = ?', [
        sessionIdPrefix,
        sessionIdPrefix,
      ]);
    });
  }
}
