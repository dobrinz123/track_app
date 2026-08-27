import type { SqlDatabase } from '@circuit/core';

/**
 * DID sweep — results persistence, export & candidate filtering addendum
 * (2026-08-27, binding — Phase 4i): "every sweep run is persisted
 * incrementally (SQLite table `did_sweep_runs` + `did_sweep_responders`: run
 * id, circuit-agnostic, adapter type, target, started/updated, range, last
 * DID, counters; responders: did, length, raw hex, first/last seen, sample
 * count). A run survives app kill and can be resumed from `lastDid` (Resume
 * button) or restarted. Retention: keep the last 5 runs."
 *
 * Mobile-owned additive migration, SAME pattern as `telemetrySchema.ts`
 * (its own doc comment explains why this lives independently of
 * `@circuit/core`'s `SqlSessionRepository.migrate()`): its own
 * `did_sweep_schema_migrations` version row, applied over the SAME
 * `SqlDatabase` connection `openAppDatabase()` already opens.
 * `CREATE TABLE IF NOT EXISTS` keeps this idempotent across repeated app
 * launches.
 *
 * `did_sweep_runs` is circuit-agnostic (no `circuit_id` column) -- a DID
 * sweep characterizes the VEHICLE's ECU, not a specific circuit, so a run
 * persists and resumes regardless of which circuit is currently selected.
 * `nrc_counts_json` is a small JSON blob (`Record<nrcHex, count>`) rather
 * than a separate table -- in practice a handful of distinct NRC values per
 * run, never worth a join.
 */
export const DID_SWEEP_SCHEMA_VERSION = 1;

const DID_SWEEP_DDL = `
CREATE TABLE IF NOT EXISTS did_sweep_schema_migrations (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS did_sweep_runs (
  run_id TEXT PRIMARY KEY,
  adapter_type TEXT NOT NULL,
  target_address INTEGER,
  range_from INTEGER NOT NULL,
  range_to INTEGER NOT NULL,
  last_did INTEGER,
  started_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  visited_count INTEGER NOT NULL DEFAULT 0,
  responder_count INTEGER NOT NULL DEFAULT 0,
  timeout_count INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  nrc_counts_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS did_sweep_responders (
  run_id TEXT NOT NULL,
  did INTEGER NOT NULL,
  length INTEGER NOT NULL,
  raw_hex TEXT NOT NULL,
  rtt_ms REAL,
  first_seen_utc TEXT NOT NULL,
  last_seen_utc TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (run_id, did)
);

CREATE INDEX IF NOT EXISTS idx_did_sweep_responders_run ON did_sweep_responders (run_id);
`;

/** Applies `DID_SWEEP_DDL` and records/bumps the schema version row. Safe to call on every app launch (idempotent), and safe to call more than once against the same `db` within a single launch. */
export async function migrateDidSweepSchema(db: SqlDatabase): Promise<void> {
  await db.execAsync(DID_SWEEP_DDL);

  const rows = await db.getAllAsync<{ version: number }>(
    'SELECT version FROM did_sweep_schema_migrations LIMIT 1',
  );
  const currentVersion = rows[0]?.version ?? 0;
  if (currentVersion === 0) {
    await db.runAsync('INSERT INTO did_sweep_schema_migrations (version) VALUES (?)', [DID_SWEEP_SCHEMA_VERSION]);
  } else if (currentVersion < DID_SWEEP_SCHEMA_VERSION) {
    await db.runAsync('UPDATE did_sweep_schema_migrations SET version = ?', [DID_SWEEP_SCHEMA_VERSION]);
  }
}
