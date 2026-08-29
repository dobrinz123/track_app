import type { DidPhaseSample, SqlBindValue, SqlDatabase } from '@circuit/core';

/**
 * DID sweep — results persistence, export & candidate filtering addendum
 * (2026-08-27, binding — Phase 4i). Persistence for one DID sweep run and
 * its responders (`didSweepSchema.ts`'s DDL), with an in-memory fallback for
 * the web preview (same convention as `composition.ts`'s own
 * `IS_WEB_RUNTIME` -> `InMemorySessionRepository` fallback) -- `createDidSweepStore(null)`
 * hands back the in-memory implementation, `createDidSweepStore(db)` the
 * SQL-backed one, both satisfying the SAME `DidSweepStore` interface so the
 * controller/screen never need to know which is live.
 */

export type DidSweepRunStatus = 'running' | 'paused' | 'stopped' | 'complete';

export interface DidSweepRunRecord {
  runId: string;
  adapterType: string;
  targetAddress: number | null;
  rangeFrom: number;
  rangeTo: number;
  lastDid: number | null;
  startedAtUtc: string;
  updatedAtUtc: string;
  status: DidSweepRunStatus;
  visitedCount: number;
  responderCount: number;
  timeoutCount: number;
  unmatchedCount: number;
  errorCount: number;
  /** Keyed by NRC value (as a string -- object keys are always strings; parsed back to numbers by callers that need them as such). */
  nrcCounts: Record<string, number>;
}

export interface DidSweepResponderRecord {
  runId: string;
  did: number;
  length: number;
  /** Uppercase hex, no separators (e.g. `"1AFF"`), decoded back to `Uint8Array` by the caller. */
  rawHex: string;
  rttMs: number | null;
  firstSeenUtc: string;
  lastSeenUtc: string;
  sampleCount: number;
}

/** One responder observation to persist -- the store owns first/last-seen and sample-count bookkeeping (upsert semantics: a repeat `did` within the SAME run updates `lastSeenUtc`/`rawHex`/`rttMs` and increments `sampleCount`, never inserts a duplicate row). */
export interface DidSweepResponderInput {
  did: number;
  raw: Uint8Array;
  rttMs: number;
}

export interface DidSweepRunProgressPatch {
  lastDid?: number | null;
  status?: DidSweepRunStatus;
  visitedCount?: number;
  timeoutCount?: number;
  unmatchedCount?: number;
  errorCount?: number;
  nrcCounts?: Record<string, number>;
}

/**
 * Ticket P4j-FIX1 H3 (binding): one persisted guided/batched/focused
 * observation sample. `observationId` groups every sample of ONE observation
 * run; a LATER observation on the same sweep run gets a NEW `observationId`
 * and APPENDS (the pre-fix in-memory-only `guidedSamples` array was reset by
 * every new observation, destroying the earlier batched series before export).
 */
export interface DidSweepObservationSampleRecord {
  runId: string;
  observationId: string;
  /** 0-based position within `observationId`, preserving arrival order. */
  seq: number;
  did: number;
  phase: string;
  tMs: number;
  /** Uppercase hex, no separators. */
  rawHex: string;
  /** `null` for an observation that never batched its candidates (a focused shortlist, or the legacy single-pass guided run). */
  batchIndex: number | null;
}

/** Ticket P4j-FIX1 H3 (binding): "summaries JSON on the run" -- one blob per observation run (ranked candidates, block candidates, insufficient/inconsistent DIDs), so a kill/reopen Share still reports what the observation concluded. */
export interface DidSweepObservationSummaryRecord {
  runId: string;
  observationId: string;
  createdAtUtc: string;
  summaryJson: string;
}

export interface DidSweepStore {
  /** Inserts a fresh run row. `runId` must not already exist (callers generate a fresh one per `start()`). */
  createRun(run: Omit<DidSweepRunRecord, 'responderCount'>): Promise<void>;
  /** Applies a partial progress update (`updatedAtUtc` is always bumped to `nowUtc`). No-op if `runId` doesn't exist. */
  updateRunProgress(runId: string, patch: DidSweepRunProgressPatch, nowUtc: string): Promise<void>;
  /** Upserts a batch of responder observations for `runId` (see `DidSweepResponderInput`'s doc). Also updates the run's own `responderCount` to the resulting distinct-DID count for this run. */
  upsertResponders(runId: string, responders: readonly DidSweepResponderInput[], nowUtc: string): Promise<void>;
  /**
   * F1 fix (P4i-FIX1, binding, after Codex P4hrev2c): "responders + progress
   * written in ONE transaction" -- upserts `responders` (if any) AND applies
   * `patch` to the run row TOGETHER, atomically (SQL-backed: one
   * `withTransactionAsync` BEGIN..COMMIT span; in-memory: no `await` between
   * the two mutations, so nothing else can ever observe a half-applied
   * state). A real process kill mid-flush can therefore never persist
   * responders without the matching progress checkpoint (or vice versa).
   * No-op (writes nothing) if `runId` doesn't exist.
   */
  flushRunProgress(
    runId: string,
    responders: readonly DidSweepResponderInput[],
    patch: DidSweepRunProgressPatch,
    nowUtc: string,
  ): Promise<void>;
  /** Every persisted run, most-recently-updated first. */
  listRuns(): Promise<DidSweepRunRecord[]>;
  getRun(runId: string): Promise<DidSweepRunRecord | null>;
  getResponders(runId: string): Promise<DidSweepResponderRecord[]>;
  deleteRun(runId: string): Promise<void>;
  /** Deletes every run beyond the `keep` most-recently-updated ones (and their responders/observation rows) -- addendum: "Retention: keep the last 5 runs." */
  enforceRetention(keep: number): Promise<void>;
  /**
   * Ticket P4j-FIX1 H3 (binding): APPENDS `samples` to `runId`'s
   * `observationId` group, preserving arrival order. Never resets anything
   * already stored (a later observation passes a new `observationId`). No-op
   * (writes nothing) if `runId` doesn't exist, so a queued write racing
   * retention can never orphan rows.
   */
  appendObservationSamples(runId: string, observationId: string, samples: readonly DidPhaseSample[]): Promise<void>;
  /** Every persisted observation sample for `runId`, ordered by observation then arrival order. */
  getObservationSamples(runId: string): Promise<DidSweepObservationSampleRecord[]>;
  /** Upserts ONE observation's summary blob (re-saving the same `observationId` replaces it). No-op if `runId` doesn't exist. */
  saveObservationSummary(runId: string, observationId: string, summaryJson: string, nowUtc: string): Promise<void>;
  /** Every persisted observation summary for `runId`, oldest first. */
  getObservationSummaries(runId: string): Promise<DidSweepObservationSummaryRecord[]>;
}

/**
 * F6 fix (P4i-FIX1, binding, after Codex P4hrev2c): "Resume picks the most
 * recent RESUMABLE run (status paused/stopped/interrupted with lastDid <
 * rangeEnd), not the most recent run." `runs` is expected most-recently-
 * updated first (== `listRuns()`'s own contract) -- returns the first entry
 * that is NOT `'complete'` and still has room left to sweep (`lastDid` either
 * unset, or short of `rangeTo`); `null` if none qualifies. A run that reached
 * `'complete'` (even if it happens to be the most RECENTLY updated one) is
 * never offered as "Resume" -- the field scenario this fixes: the latest run
 * completed naturally while an EARLIER run was killed mid-sweep; only that
 * earlier one is genuinely resumable.
 */
export function selectResumableRun(runs: readonly DidSweepRunRecord[]): DidSweepRunRecord | null {
  for (const run of runs) {
    if (run.status === 'complete') continue;
    if (run.lastDid !== null && run.lastDid >= run.rangeTo) continue; // nothing left to sweep even though never marked complete.
    return run;
  }
  return null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const compact = hex.replace(/\s+/g, '');
  const out = new Uint8Array(compact.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// In-memory implementation (web preview fallback)
// ---------------------------------------------------------------------------

interface MemoryRun extends DidSweepRunRecord {
  responders: Map<number, DidSweepResponderRecord>;
  /** P4j-FIX1 H3 (binding): appended to, never replaced -- one flat list in arrival order across every `observationId`. */
  observationSamples: DidSweepObservationSampleRecord[];
  /** P4j-FIX1 H3 (binding): keyed by `observationId` (insertion-ordered = oldest first). */
  observationSummaries: Map<string, DidSweepObservationSummaryRecord>;
}

/** Shared by `updateRunProgress` and `flushRunProgress` -- mutates `run` in place, synchronously (no `await`s), so both callers apply a patch the identical way. */
function applyProgressPatchToMemoryRun(run: MemoryRun, patch: DidSweepRunProgressPatch): void {
  if (patch.lastDid !== undefined) run.lastDid = patch.lastDid;
  if (patch.status !== undefined) run.status = patch.status;
  if (patch.visitedCount !== undefined) run.visitedCount = patch.visitedCount;
  if (patch.timeoutCount !== undefined) run.timeoutCount = patch.timeoutCount;
  if (patch.unmatchedCount !== undefined) run.unmatchedCount = patch.unmatchedCount;
  if (patch.errorCount !== undefined) run.errorCount = patch.errorCount;
  if (patch.nrcCounts !== undefined) run.nrcCounts = { ...patch.nrcCounts };
}

/** Shared by `upsertResponders` and `flushRunProgress` -- mutates `run` in place, synchronously. */
function upsertRespondersIntoMemoryRun(run: MemoryRun, responders: readonly DidSweepResponderInput[], nowUtc: string): void {
  for (const input of responders) {
    const existing = run.responders.get(input.did);
    if (existing === undefined) {
      run.responders.set(input.did, {
        runId: run.runId,
        did: input.did,
        length: input.raw.length,
        rawHex: bytesToHex(input.raw),
        rttMs: input.rttMs,
        firstSeenUtc: nowUtc,
        lastSeenUtc: nowUtc,
        sampleCount: 1,
      });
    } else {
      existing.length = input.raw.length;
      existing.rawHex = bytesToHex(input.raw);
      existing.rttMs = input.rttMs;
      existing.lastSeenUtc = nowUtc;
      existing.sampleCount += 1;
    }
  }
  run.responderCount = run.responders.size;
}

/** Web-preview / test fallback: no persistence across reloads, but satisfies the SAME `DidSweepStore` contract as the SQL-backed implementation (mirrors `InMemorySessionRepository`'s own role for the session repository). */
export function createInMemoryDidSweepStore(): DidSweepStore {
  const runs = new Map<string, MemoryRun>();

  function toRecord(run: MemoryRun): DidSweepRunRecord {
    const { responders: _responders, observationSamples: _samples, observationSummaries: _summaries, ...record } = run;
    return { ...record, nrcCounts: { ...record.nrcCounts } };
  }

  return {
    async createRun(run): Promise<void> {
      runs.set(run.runId, {
        ...run,
        nrcCounts: { ...run.nrcCounts },
        responderCount: 0,
        responders: new Map(),
        observationSamples: [],
        observationSummaries: new Map(),
      });
    },

    async updateRunProgress(runId, patch, nowUtc): Promise<void> {
      const run = runs.get(runId);
      if (run === undefined) return;
      applyProgressPatchToMemoryRun(run, patch);
      run.updatedAtUtc = nowUtc;
    },

    async upsertResponders(runId, responders, nowUtc): Promise<void> {
      const run = runs.get(runId);
      if (run === undefined) return;
      upsertRespondersIntoMemoryRun(run, responders, nowUtc);
      run.updatedAtUtc = nowUtc;
    },

    // F1 fix (binding): no `await` anywhere between the two mutations below --
    // synchronously atomic (nothing else can observe an in-between state).
    async flushRunProgress(runId, responders, patch, nowUtc): Promise<void> {
      const run = runs.get(runId);
      if (run === undefined) return;
      if (responders.length > 0) upsertRespondersIntoMemoryRun(run, responders, nowUtc);
      applyProgressPatchToMemoryRun(run, patch);
      run.updatedAtUtc = nowUtc;
    },

    async listRuns(): Promise<DidSweepRunRecord[]> {
      return [...runs.values()].map(toRecord).sort((a, b) => (a.updatedAtUtc < b.updatedAtUtc ? 1 : -1));
    },

    async getRun(runId): Promise<DidSweepRunRecord | null> {
      const run = runs.get(runId);
      return run === undefined ? null : toRecord(run);
    },

    async getResponders(runId): Promise<DidSweepResponderRecord[]> {
      const run = runs.get(runId);
      if (run === undefined) return [];
      return [...run.responders.values()].sort((a, b) => a.did - b.did);
    },

    async deleteRun(runId): Promise<void> {
      runs.delete(runId);
    },

    async enforceRetention(keep): Promise<void> {
      const ordered = [...runs.values()].sort((a, b) => (a.updatedAtUtc < b.updatedAtUtc ? 1 : -1));
      for (const run of ordered.slice(Math.max(0, keep))) runs.delete(run.runId);
    },

    // P4j-FIX1 H3 (binding): observation samples/summaries live on the run
    // record itself, so `deleteRun`/`enforceRetention` drop them with it (no
    // separate cleanup, no orphan rows).
    async appendObservationSamples(runId, observationId, samples): Promise<void> {
      const run = runs.get(runId);
      if (run === undefined) return;
      let seq = run.observationSamples.filter((s) => s.observationId === observationId).length;
      for (const sample of samples) {
        run.observationSamples.push({
          runId,
          observationId,
          seq,
          did: sample.did,
          phase: sample.phase,
          tMs: sample.tMs,
          rawHex: bytesToHex(sample.raw),
          batchIndex: sample.batchIndex ?? null,
        });
        seq += 1;
      }
    },

    async getObservationSamples(runId): Promise<DidSweepObservationSampleRecord[]> {
      return (runs.get(runId)?.observationSamples ?? []).map((s) => ({ ...s }));
    },

    async saveObservationSummary(runId, observationId, summaryJson, nowUtc): Promise<void> {
      const run = runs.get(runId);
      if (run === undefined) return;
      run.observationSummaries.set(observationId, { runId, observationId, createdAtUtc: nowUtc, summaryJson });
    },

    async getObservationSummaries(runId): Promise<DidSweepObservationSummaryRecord[]> {
      return [...(runs.get(runId)?.observationSummaries.values() ?? [])].map((s) => ({ ...s }));
    },
  };
}

// ---------------------------------------------------------------------------
// SQL-backed implementation
// ---------------------------------------------------------------------------

interface RunRow {
  run_id: string;
  adapter_type: string;
  target_address: number | null;
  range_from: number;
  range_to: number;
  last_did: number | null;
  started_at_utc: string;
  updated_at_utc: string;
  status: string;
  visited_count: number;
  responder_count: number;
  timeout_count: number;
  unmatched_count: number;
  error_count: number;
  nrc_counts_json: string;
}

function parseNrcCounts(json: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, number>;
  } catch {
    // Corrupt/legacy row -- fall back to empty rather than throw.
  }
  return {};
}

function rowToRun(row: RunRow): DidSweepRunRecord {
  return {
    runId: row.run_id,
    adapterType: row.adapter_type,
    targetAddress: row.target_address,
    rangeFrom: row.range_from,
    rangeTo: row.range_to,
    lastDid: row.last_did,
    startedAtUtc: row.started_at_utc,
    updatedAtUtc: row.updated_at_utc,
    status: row.status as DidSweepRunStatus,
    visitedCount: row.visited_count,
    responderCount: row.responder_count,
    timeoutCount: row.timeout_count,
    unmatchedCount: row.unmatched_count,
    errorCount: row.error_count,
    nrcCounts: parseNrcCounts(row.nrc_counts_json),
  };
}

interface ResponderRow {
  run_id: string;
  did: number;
  length: number;
  raw_hex: string;
  rtt_ms: number | null;
  first_seen_utc: string;
  last_seen_utc: string;
  sample_count: number;
}

function rowToResponder(row: ResponderRow): DidSweepResponderRecord {
  return {
    runId: row.run_id,
    did: row.did,
    length: row.length,
    rawHex: row.raw_hex,
    rttMs: row.rtt_ms,
    firstSeenUtc: row.first_seen_utc,
    lastSeenUtc: row.last_seen_utc,
    sampleCount: row.sample_count,
  };
}

/** Shared by `updateRunProgress` and `flushRunProgress` -- builds the `SET` clause fragments/params for a progress patch (everything except `run_id`, appended by the caller). */
function buildProgressPatchSql(patch: DidSweepRunProgressPatch, nowUtc: string): { sets: string[]; params: SqlBindValue[] } {
  const sets: string[] = ['updated_at_utc = ?'];
  const params: SqlBindValue[] = [nowUtc];
  if (patch.lastDid !== undefined) {
    sets.push('last_did = ?');
    params.push(patch.lastDid);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.visitedCount !== undefined) {
    sets.push('visited_count = ?');
    params.push(patch.visitedCount);
  }
  if (patch.timeoutCount !== undefined) {
    sets.push('timeout_count = ?');
    params.push(patch.timeoutCount);
  }
  if (patch.unmatchedCount !== undefined) {
    sets.push('unmatched_count = ?');
    params.push(patch.unmatchedCount);
  }
  if (patch.errorCount !== undefined) {
    sets.push('error_count = ?');
    params.push(patch.errorCount);
  }
  if (patch.nrcCounts !== undefined) {
    sets.push('nrc_counts_json = ?');
    params.push(JSON.stringify(patch.nrcCounts));
  }
  return { sets, params };
}

/** Shared by `upsertResponders` and `flushRunProgress` -- issues the upsert statements only (never touches `did_sweep_runs` itself; the caller recomputes/persists `responder_count` separately, possibly inside the SAME transaction). */
async function upsertRespondersSql(
  db: SqlDatabase,
  runId: string,
  responders: readonly DidSweepResponderInput[],
  nowUtc: string,
): Promise<void> {
  for (const input of responders) {
    const rawHex = bytesToHex(input.raw);
    await db.runAsync(
      `INSERT INTO did_sweep_responders (run_id, did, length, raw_hex, rtt_ms, first_seen_utc, last_seen_utc, sample_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(run_id, did) DO UPDATE SET
         length = excluded.length,
         raw_hex = excluded.raw_hex,
         rtt_ms = excluded.rtt_ms,
         last_seen_utc = excluded.last_seen_utc,
         sample_count = sample_count + 1`,
      [runId, input.did, input.raw.length, rawHex, input.rttMs, nowUtc, nowUtc],
    );
  }
}

interface ObservationSampleRow {
  run_id: string;
  observation_id: string;
  seq: number;
  did: number;
  phase: string;
  t_ms: number;
  raw_hex: string;
  batch_index: number | null;
}

interface ObservationSummaryRow {
  run_id: string;
  observation_id: string;
  created_at_utc: string;
  summary_json: string;
}

/** P4j-FIX1 H3 (binding): ONE place that knows every table a run owns, so `deleteRun` and `enforceRetention` can never drift apart and leave observation rows behind. */
async function deleteRunRowsSql(db: SqlDatabase, runId: string): Promise<void> {
  await db.runAsync('DELETE FROM did_sweep_observation_samples WHERE run_id = ?', [runId]);
  await db.runAsync('DELETE FROM did_sweep_observation_summaries WHERE run_id = ?', [runId]);
  await db.runAsync('DELETE FROM did_sweep_responders WHERE run_id = ?', [runId]);
  await db.runAsync('DELETE FROM did_sweep_runs WHERE run_id = ?', [runId]);
}

async function countRespondersSql(db: SqlDatabase, runId: string): Promise<number> {
  const countRows = await db.getAllAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM did_sweep_responders WHERE run_id = ?',
    [runId],
  );
  return countRows[0]?.n ?? 0;
}

/** Real, on-device SQLite implementation over `didSweepSchema.ts`'s tables -- same connection `openAppDatabase()` opens for everything else. */
export function createSqlDidSweepStore(db: SqlDatabase): DidSweepStore {
  return {
    async createRun(run): Promise<void> {
      await db.runAsync(
        `INSERT INTO did_sweep_runs
          (run_id, adapter_type, target_address, range_from, range_to, last_did, started_at_utc, updated_at_utc, status, visited_count, timeout_count, unmatched_count, error_count, nrc_counts_json, responder_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          run.runId,
          run.adapterType,
          run.targetAddress,
          run.rangeFrom,
          run.rangeTo,
          run.lastDid,
          run.startedAtUtc,
          run.updatedAtUtc,
          run.status,
          run.visitedCount,
          run.timeoutCount,
          run.unmatchedCount,
          run.errorCount,
          JSON.stringify(run.nrcCounts),
        ],
      );
    },

    async updateRunProgress(runId, patch, nowUtc): Promise<void> {
      const { sets, params } = buildProgressPatchSql(patch, nowUtc);
      params.push(runId);
      await db.runAsync(`UPDATE did_sweep_runs SET ${sets.join(', ')} WHERE run_id = ?`, params);
    },

    async upsertResponders(runId, responders, nowUtc): Promise<void> {
      if (responders.length === 0) return;
      await upsertRespondersSql(db, runId, responders, nowUtc);
      const responderCount = await countRespondersSql(db, runId);
      await db.runAsync('UPDATE did_sweep_runs SET responder_count = ?, updated_at_utc = ? WHERE run_id = ?', [
        responderCount,
        nowUtc,
        runId,
      ]);
    },

    // F1 fix (P4i-FIX1, binding, after Codex P4hrev2c): responders AND the
    // progress patch (including the recomputed `responder_count`) are all
    // written inside ONE `withTransactionAsync` BEGIN..COMMIT span -- a real
    // process kill mid-flush can only ever see the run's PRE-flush state or
    // its fully-updated post-flush state, never a partial checkpoint.
    //
    // R4 fix (P4i-FIX2, binding, after Codex P4hrev3 NEW MEDIUM "the new
    // transactional API can create orphan responder rows"): this table has no
    // FK (see `didSweepSchema.ts`'s own doc comment on why `did_sweep_runs`/
    // `did_sweep_responders` stay independent `CREATE TABLE IF NOT EXISTS`
    // statements) -- an EXPLICIT existence check, inside the SAME transaction,
    // stands in for one: retention (`enforceRetention`) can delete a run row
    // while an earlier flush for that exact `runId` is still queued behind a
    // slow write (`didSweepController.ts`'s serialized `persistenceTail`);
    // when that queued flush finally runs, it must be a complete no-op
    // (never insert orphan responder rows for a run that no longer exists),
    // preserving both "no-op if runId doesn't exist" and the five-run
    // retention promise.
    async flushRunProgress(runId, responders, patch, nowUtc): Promise<void> {
      await db.withTransactionAsync(async () => {
        const existing = await db.getAllAsync<{ run_id: string }>('SELECT run_id FROM did_sweep_runs WHERE run_id = ? LIMIT 1', [runId]);
        if (existing.length === 0) return; // the run is gone -- writing responders now would orphan them.
        if (responders.length > 0) await upsertRespondersSql(db, runId, responders, nowUtc);
        const { sets, params } = buildProgressPatchSql(patch, nowUtc);
        if (responders.length > 0) {
          const responderCount = await countRespondersSql(db, runId);
          sets.push('responder_count = ?');
          params.push(responderCount);
        }
        params.push(runId);
        await db.runAsync(`UPDATE did_sweep_runs SET ${sets.join(', ')} WHERE run_id = ?`, params);
      });
    },

    async listRuns(): Promise<DidSweepRunRecord[]> {
      const rows = await db.getAllAsync<RunRow>('SELECT * FROM did_sweep_runs ORDER BY updated_at_utc DESC');
      return rows.map(rowToRun);
    },

    async getRun(runId): Promise<DidSweepRunRecord | null> {
      const rows = await db.getAllAsync<RunRow>('SELECT * FROM did_sweep_runs WHERE run_id = ? LIMIT 1', [runId]);
      const row = rows[0];
      return row === undefined ? null : rowToRun(row);
    },

    async getResponders(runId): Promise<DidSweepResponderRecord[]> {
      const rows = await db.getAllAsync<ResponderRow>(
        'SELECT * FROM did_sweep_responders WHERE run_id = ? ORDER BY did ASC',
        [runId],
      );
      return rows.map(rowToResponder);
    },

    async deleteRun(runId): Promise<void> {
      await deleteRunRowsSql(db, runId);
    },

    async enforceRetention(keep): Promise<void> {
      const rows = await db.getAllAsync<{ run_id: string }>(
        'SELECT run_id FROM did_sweep_runs ORDER BY updated_at_utc DESC LIMIT -1 OFFSET ?',
        [Math.max(0, keep)],
      );
      for (const row of rows) await deleteRunRowsSql(db, row.run_id);
    },

    // P4j-FIX1 H3 (binding). The existence check mirrors `flushRunProgress`'s
    // own (see its doc): these tables carry no FK either, and a write queued
    // behind a slow one can land after retention already deleted the run --
    // it must then be a complete no-op, never an orphan row.
    async appendObservationSamples(runId, observationId, samples): Promise<void> {
      if (samples.length === 0) return;
      await db.withTransactionAsync(async () => {
        const existing = await db.getAllAsync<{ run_id: string }>('SELECT run_id FROM did_sweep_runs WHERE run_id = ? LIMIT 1', [runId]);
        if (existing.length === 0) return;
        const seqRows = await db.getAllAsync<{ n: number }>(
          'SELECT COUNT(*) AS n FROM did_sweep_observation_samples WHERE run_id = ? AND observation_id = ?',
          [runId, observationId],
        );
        let seq = seqRows[0]?.n ?? 0;
        for (const sample of samples) {
          await db.runAsync(
            `INSERT OR REPLACE INTO did_sweep_observation_samples (run_id, observation_id, seq, did, phase, t_ms, raw_hex, batch_index)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [runId, observationId, seq, sample.did, sample.phase, sample.tMs, bytesToHex(sample.raw), sample.batchIndex ?? null],
          );
          seq += 1;
        }
      });
    },

    async getObservationSamples(runId): Promise<DidSweepObservationSampleRecord[]> {
      const rows = await db.getAllAsync<ObservationSampleRow>(
        'SELECT * FROM did_sweep_observation_samples WHERE run_id = ? ORDER BY observation_id ASC, seq ASC',
        [runId],
      );
      return rows.map((row) => ({
        runId: row.run_id,
        observationId: row.observation_id,
        seq: row.seq,
        did: row.did,
        phase: row.phase,
        tMs: row.t_ms,
        rawHex: row.raw_hex,
        batchIndex: row.batch_index ?? null,
      }));
    },

    async saveObservationSummary(runId, observationId, summaryJson, nowUtc): Promise<void> {
      await db.withTransactionAsync(async () => {
        const existing = await db.getAllAsync<{ run_id: string }>('SELECT run_id FROM did_sweep_runs WHERE run_id = ? LIMIT 1', [runId]);
        if (existing.length === 0) return;
        await db.runAsync(
          `INSERT INTO did_sweep_observation_summaries (run_id, observation_id, created_at_utc, summary_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(run_id, observation_id) DO UPDATE SET created_at_utc = excluded.created_at_utc, summary_json = excluded.summary_json`,
          [runId, observationId, nowUtc, summaryJson],
        );
      });
    },

    async getObservationSummaries(runId): Promise<DidSweepObservationSummaryRecord[]> {
      const rows = await db.getAllAsync<ObservationSummaryRow>(
        'SELECT * FROM did_sweep_observation_summaries WHERE run_id = ? ORDER BY created_at_utc ASC, observation_id ASC',
        [runId],
      );
      return rows.map((row) => ({
        runId: row.run_id,
        observationId: row.observation_id,
        createdAtUtc: row.created_at_utc,
        summaryJson: row.summary_json,
      }));
    },
  };
}

/** Picks the SQL-backed store when `db` is available, else the in-memory fallback (web preview) -- same `db !== null` ternary convention `composition.ts` already uses for the session repository/settings store. */
export function createDidSweepStore(db: SqlDatabase | null): DidSweepStore {
  return db === null ? createInMemoryDidSweepStore() : createSqlDidSweepStore(db);
}
