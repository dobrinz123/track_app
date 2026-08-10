import type { SqlDatabase } from '@circuit/core';
import { TELEMETRY_SCHEMA_VERSION } from '@circuit/core';

/**
 * Mobile-owned additive migration for the vehicle-telemetry recording table
 * (Telemetry addendum, docs/architecture/contracts.md's "Recording (mobile,
 * SQLite)" section). Deliberately independent of `@circuit/core`'s
 * `SqlSessionRepository.migrate()` / `SQL_DDL`/`SQL_DDL_V2`
 * (packages/core/src/persistence-sql -- out of this ticket's write set): its
 * own `telemetry_schema_migrations` version row, applied over the SAME
 * `SqlDatabase` connection `openAppDatabase()` already opens for the session
 * repository/settings store. `CREATE TABLE IF NOT EXISTS` keeps this
 * idempotent across repeated app launches, mirroring
 * `packages/core/src/persistence-sql/schema.ts`'s own DDL discipline exactly.
 *
 * `lap_number` is NULLABLE (samples recorded before the first lap starts, or
 * whenever the current lap isn't known) -- see the addendum's binding table
 * shape: `telemetry_samples(session_id, lap_number NULLABLE, t_mono_ms,
 * channel, value)`. This is a DIFFERENT table from `@circuit/core`'s existing
 * `telemetry` table (GNSS `LocationSample` history, `LocalSessionRepository
 * .saveTelemetry`) -- vehicle OBD channels are a separate concern with a
 * separate binding schema.
 */
const TELEMETRY_SAMPLES_DDL = `
CREATE TABLE IF NOT EXISTS telemetry_schema_migrations (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_samples (
  session_id TEXT NOT NULL,
  lap_number INTEGER,
  t_mono_ms REAL NOT NULL,
  channel TEXT NOT NULL,
  value REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_samples_session ON telemetry_samples (session_id);
`;

/** Applies `TELEMETRY_SAMPLES_DDL` and records/bumps the schema version row. Safe to call on every app launch (idempotent), and safe to call more than once against the same `db` within a single launch. */
export async function migrateTelemetrySchema(db: SqlDatabase): Promise<void> {
  await db.execAsync(TELEMETRY_SAMPLES_DDL);

  const rows = await db.getAllAsync<{ version: number }>(
    'SELECT version FROM telemetry_schema_migrations LIMIT 1',
  );
  const currentVersion = rows[0]?.version ?? 0;
  if (currentVersion === 0) {
    await db.runAsync('INSERT INTO telemetry_schema_migrations (version) VALUES (?)', [TELEMETRY_SCHEMA_VERSION]);
  } else if (currentVersion < TELEMETRY_SCHEMA_VERSION) {
    await db.runAsync('UPDATE telemetry_schema_migrations SET version = ?', [TELEMETRY_SCHEMA_VERSION]);
  }
}
