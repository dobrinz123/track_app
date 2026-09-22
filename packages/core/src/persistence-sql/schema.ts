// Schema version for this adapter's own DDL. Independent of
// `CHECKPOINT_SCHEMA_VERSION` (the wire envelope written into the checkpoints
// table's payload column via `CheckpointCodec`) -- this number tracks the
// *table* shapes, the other tracks the *checkpoint JSON* shape.
//
// v2 (WP14 integration): adds the `settings` key-value table so app-side
// settings persist through the same on-device SQLite database instead of an
// in-memory stand-in. `SqlSessionRepository.migrate()` applies `SQL_DDL_V2`
// and bumps an existing v1 database's `schema_migrations` row in place --
// see that method for the actual upgrade path.
//
// v3 (ticket P10A H3/H6): the `sessions` table gains three nullable columns
// carrying facts ABOUT a session that must survive a process death -- how its
// matching was calibrated (`calibrationStatus`, see
// `SessionCalibrationStatus`) and whether its raw GNSS trace is complete
// (`traceUnwritten`/`traceFailedWrites`). They live here, on the session row
// itself, rather than in a side log: the old settings-row log evicted old
// entries, treated a read error as "nothing recorded", and its write was not
// required to succeed -- three independent ways for a session run past a
// REJECTED calibration to present itself afterwards as an ordinary one.
// Nullable throughout, so a row written by an older build reads back as
// "unknown" rather than as "validated".
// v4 (ticket P11C): the `checkpoints` table gains a nullable `lapCount`
// column -- the checkpoint's GENERATION (see `checkpointGeneration`),
// denormalised out of the JSON payload so SQLite itself can compare it.
// `SessionController` retries a lap commit that failed, carrying the
// checkpoint it captured at the time, and a retry landing after a newer lap
// committed must NOT drag the stored checkpoint back to its own older laps.
// The comparison has to be atomic with the write, and with the count in a
// column it is ONE statement (`saveLapCommit`'s conditional UPSERT) rather
// than a SELECT and an INSERT sharing a transaction -- no second round trip
// inside the transaction, and nothing to interleave with.
// Nullable, so a row written by an older build reads back as "generation
// unknown" (treated as -1, i.e. superseded by anything) instead of blocking
// every future write; the first write through this code fills it in.
// v5 (ticket P12 items A/B): two new tables, both of them data BUILD 12 EXISTS
// TO COLLECT rather than data the app needs to run.
//   - `lap_verdicts` -- the owner's answer to "was the app's valid/invalid
//     verdict on this lap right?", keyed `(sessionId, lapNumber)`. It carries
//     the app's own verdict as it stood when the question was asked, so the
//     answer stays meaningful after a rules change.
//   - `calibration_attempts` -- one row per Learn lap, whatever happened to
//     it: accepted, rejected, stalled, or cancelled by the driver. Keyed by
//     `attemptId` so the provisional row written while the lap is running is
//     REPLACED by its concluded successor instead of accumulating.
// Both tables are additive; nothing existing reads or writes them, so a
// database that predates them upgrades by having them created.
//
// v6 (ticket P14 H3): `sessions.traceFinalized` -- whether the recording of
// that session was ever FINISHED, as opposed to left running by a crash. The
// trace counters alone cannot say: `traceUnwritten = 0` on an interrupted
// session is the last figure written before the interruption, not a verdict
// on the whole recording, and reading it as one is how an export came to say
// "complete (no captured fix went unwritten)" about a truncated drive.
// Nullable, so an older row reads back as UNKNOWN rather than as finalised.
export const SQL_SCHEMA_VERSION = 6;

// Multi-statement DDL, applied via `SqlDatabase.execAsync`. Every statement is
// `IF NOT EXISTS` so re-running it against an already-migrated database is a
// no-op (see the "migration idempotence" test in
// test/persistence-sql/sqlSessionRepository.contract.test.ts, which opens the
// same underlying store twice and asserts both that no error is thrown and
// that previously-written data survives untouched).
export const SQL_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sessionId TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  circuitId TEXT NOT NULL,
  layoutId TEXT NOT NULL,
  layoutVersion INTEGER NOT NULL,
  startedAtUtc TEXT NOT NULL,
  calibrationStatus TEXT,
  traceUnwritten INTEGER,
  traceFailedWrites INTEGER,
  traceFinalized INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_circuit ON sessions (userId, circuitId);

CREATE TABLE IF NOT EXISTS laps (
  sessionId TEXT NOT NULL,
  lapNumber INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (sessionId, lapNumber)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  sessionId TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  lapCount INTEGER
);

CREATE TABLE IF NOT EXISTS telemetry (
  sessionId TEXT NOT NULL,
  lapNumber INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (sessionId, lapNumber)
);

CREATE TABLE IF NOT EXISTS reference_laps (
  userId TEXT NOT NULL,
  circuitId TEXT NOT NULL,
  layoutId TEXT NOT NULL,
  layoutVersion INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (userId, circuitId, layoutId, layoutVersion)
);
`;

// v2 addition: a simple app-settings key-value table. Not part of the
// `LocalSessionRepository` contract (contracts.ts is out of this ticket's
// write set) -- apps/mobile owns a small store on top of this table (see
// apps/mobile/src/persistence/sqlSettingsStore.ts) built against the same
// `SqlDatabase` a `SqlSessionRepository` was created from. `IF NOT EXISTS`
// keeps this idempotent the same way `SQL_DDL` is.
export const SQL_DDL_V2 = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * v3 additions for a `sessions` table that already exists (ticket P10A).
 * `CREATE TABLE IF NOT EXISTS` above cannot add a column to a table it did
 * not create, and SQLite has no `ADD COLUMN IF NOT EXISTS`, so each statement
 * is applied on its own and an "duplicate column name" failure is expected
 * and ignored -- the same idempotence `SQL_DDL`'s `IF NOT EXISTS` gives every
 * other statement here. Applied unconditionally on open for exactly that
 * reason: a database whose `schema_migrations` row was bumped by a build that
 * then crashed before the ALTER must still end up with the columns.
 */
export const SQL_ALTERS_V3: readonly string[] = [
  'ALTER TABLE sessions ADD COLUMN calibrationStatus TEXT',
  'ALTER TABLE sessions ADD COLUMN traceUnwritten INTEGER',
  'ALTER TABLE sessions ADD COLUMN traceFailedWrites INTEGER',
];

/**
 * v4 addition for a `checkpoints` table that already exists (ticket P11C) --
 * same mechanism and same idempotence as {@link SQL_ALTERS_V3}: applied on
 * every open, each failure ("duplicate column name") expected and ignored,
 * so a database whose `schema_migrations` row was bumped by a build that
 * then crashed before the ALTER still ends up with the column.
 */
export const SQL_ALTERS_V4: readonly string[] = ['ALTER TABLE checkpoints ADD COLUMN lapCount INTEGER'];

/**
 * v6 addition (ticket P14 H3) -- `sessions.traceFinalized`, on exactly the
 * same mechanism and idempotence as {@link SQL_ALTERS_V3}.
 *
 * NULL for every row written before this existed, which reads back as UNKNOWN
 * rather than as finalised: a session whose recording nobody can vouch for
 * must not be able to present itself afterwards as one that finished cleanly.
 * That is the same failure direction `calibrationStatus` chose in P10A H6.
 */
export const SQL_ALTERS_V6: readonly string[] = ['ALTER TABLE sessions ADD COLUMN traceFinalized INTEGER'];

/**
 * v5 additions (ticket P12 items A/B). Whole TABLES, not columns, so plain
 * `CREATE TABLE IF NOT EXISTS` is all the idempotence they need -- applied on
 * every open exactly like `SQL_DDL`, for the same reason `SQL_ALTERS_V3` is:
 * a database whose `schema_migrations` row was bumped by a build that then
 * crashed must still end up with the tables.
 *
 * Both payloads are stored as one JSON TEXT column beside their key columns.
 * The keys are duplicated out of the JSON (`sessionId`, `lapNumber`,
 * `attemptId`, `startedAtUtc`) purely so SQLite can index and order on them;
 * the JSON remains the authority on the record's contents, which keeps a
 * future field addition from needing another migration.
 */
export const SQL_DDL_V5 = `
CREATE TABLE IF NOT EXISTS lap_verdicts (
  sessionId TEXT NOT NULL,
  lapNumber INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (sessionId, lapNumber)
);

CREATE TABLE IF NOT EXISTS calibration_attempts (
  attemptId TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  startedAtUtc TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calibration_attempts_session ON calibration_attempts (sessionId, startedAtUtc);
`;
