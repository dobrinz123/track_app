import type { SqlDatabase } from '@circuit/core';

/**
 * Ticket P5d T4/T6 -- the table a LEARNED circuit lives in (Test Loop mode,
 * `docs/architecture/contracts.md` "Test Loop mode (Phase 5d)").
 *
 * Mobile-owned and additive, exactly like `telemetrySchema.ts`: its own
 * `learned_circuit_schema_migrations` version row, applied over the SAME
 * `SqlDatabase` connection `openAppDatabase()` already opens for the session
 * repository, and `CREATE TABLE IF NOT EXISTS` throughout so relaunching the
 * app is a no-op. `packages/core`'s own `SQL_DDL` is untouched.
 *
 * `payload` is the core `encodeLearnedCircuit` envelope (profile + corners),
 * so reading a row back goes through the same validation a bundled circuit
 * asset does. The columns beside it (`display_name`, `length_m`,
 * `corner_count`) are DERIVED copies for list rendering -- the payload stays
 * the single source of truth, and a row is only ever written whole.
 *
 * `saved` is the difference between the two things a learned loop can be:
 *   0 -- a test loop kept ONLY so its own session can still be analysed and
 *        replayed after a restart (ticket T4);
 *   1 -- a circuit the driver named and saved, listed alongside the bundled
 *        circuits and reusable for future sessions (ticket T6).
 */
const LEARNED_CIRCUITS_DDL = `
CREATE TABLE IF NOT EXISTS learned_circuit_schema_migrations (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS learned_circuits (
  circuit_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  length_m REAL NOT NULL,
  corner_count INTEGER NOT NULL,
  created_at_utc TEXT NOT NULL,
  saved INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_learned_circuits_saved ON learned_circuits (saved);
`;

export const LEARNED_CIRCUIT_SCHEMA_VERSION = 1;

/** Applies the learned-circuit DDL and records its version. Idempotent across launches. */
export async function migrateLearnedCircuitSchema(db: SqlDatabase): Promise<void> {
  await db.execAsync(LEARNED_CIRCUITS_DDL);

  const rows = await db.getAllAsync<{ version: number }>(
    'SELECT version FROM learned_circuit_schema_migrations LIMIT 1',
  );
  const currentVersion = rows[0]?.version ?? 0;
  if (currentVersion === 0) {
    await db.runAsync('INSERT INTO learned_circuit_schema_migrations (version) VALUES (?)', [
      LEARNED_CIRCUIT_SCHEMA_VERSION,
    ]);
  } else if (currentVersion < LEARNED_CIRCUIT_SCHEMA_VERSION) {
    await db.runAsync('UPDATE learned_circuit_schema_migrations SET version = ?', [
      LEARNED_CIRCUIT_SCHEMA_VERSION,
    ]);
  }
}
