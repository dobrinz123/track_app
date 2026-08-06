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
export const SQL_SCHEMA_VERSION = 2;

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
  startedAtUtc TEXT NOT NULL
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
  payload TEXT NOT NULL
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
