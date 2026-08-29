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
 * Ticket P4j-FIX1 H3 (binding, after Codex P4j-REV1 HIGH #3, "Batched
 * samples, summaries, and `batchIndex` are memory-only and do not survive
 * restart"): schema v2 adds `did_sweep_observation_samples` (every guided /
 * batched / focused phase sample, keyed by `run_id` + `observation_id`, so a
 * LATER observation on the same run APPENDS rather than resetting) and
 * `did_sweep_observation_summaries` (one JSON summary blob per observation:
 * ranked candidates, block candidates, insufficient/inconsistent DIDs). Both
 * are plain `CREATE TABLE IF NOT EXISTS` additions -- no column was added to
 * an existing table, so an app upgrading from v1 needs no `ALTER TABLE` and
 * no data migration; the version row simply moves 1 -> 2.
 *
 * `did_sweep_runs` is circuit-agnostic (no `circuit_id` column) -- a DID
 * sweep characterizes the VEHICLE's ECU, not a specific circuit, so a run
 * persists and resumes regardless of which circuit is currently selected.
 * `nrc_counts_json` is a small JSON blob (`Record<nrcHex, count>`) rather
 * than a separate table -- in practice a handful of distinct NRC values per
 * run, never worth a join.
 *
 * Ticket P4l (binding, contracts.md "Signal Finder (Phase 4l)" item 5):
 * schema v3 adds `vehicle_profile_bindings` -- what "Confirm as <target>"
 * writes when the Signal Finder proves a channel (`ecu`, `did`, `length`,
 * `decode` guess, `status`, evidence summary, timestamp), keyed by
 * (`profile_id`, `channel`) so re-confirming a channel REPLACES rather than
 * accumulates. Another plain `CREATE TABLE IF NOT EXISTS` addition -- no
 * column was added to an existing table, so an app upgrading from v1/v2
 * needs no `ALTER TABLE` and no data migration; the version row simply moves
 * to 3. It is deliberately NOT keyed by `run_id`: a binding outlives the
 * sweep run that discovered it (and survives the five-run retention).
 */
export const DID_SWEEP_SCHEMA_VERSION = 3;

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

CREATE TABLE IF NOT EXISTS did_sweep_observation_samples (
  run_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  did INTEGER NOT NULL,
  phase TEXT NOT NULL,
  t_ms REAL NOT NULL,
  raw_hex TEXT NOT NULL,
  batch_index INTEGER,
  PRIMARY KEY (run_id, observation_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_did_sweep_observation_samples_run ON did_sweep_observation_samples (run_id);

CREATE TABLE IF NOT EXISTS did_sweep_observation_summaries (
  run_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY (run_id, observation_id)
);

CREATE INDEX IF NOT EXISTS idx_did_sweep_observation_summaries_run ON did_sweep_observation_summaries (run_id);

CREATE TABLE IF NOT EXISTS vehicle_profile_bindings (
  profile_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  ecu INTEGER NOT NULL,
  did INTEGER NOT NULL,
  length INTEGER,
  decode TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY (profile_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_profile_bindings_profile ON vehicle_profile_bindings (profile_id);
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
