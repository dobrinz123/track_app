import type { SqlBindValue, SqlDatabase } from '@circuit/core';

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

export interface DidSweepStore {
  /** Inserts a fresh run row. `runId` must not already exist (callers generate a fresh one per `start()`). */
  createRun(run: Omit<DidSweepRunRecord, 'responderCount'>): Promise<void>;
  /** Applies a partial progress update (`updatedAtUtc` is always bumped to `nowUtc`). No-op if `runId` doesn't exist. */
  updateRunProgress(runId: string, patch: DidSweepRunProgressPatch, nowUtc: string): Promise<void>;
  /** Upserts a batch of responder observations for `runId` (see `DidSweepResponderInput`'s doc). Also updates the run's own `responderCount` to the resulting distinct-DID count for this run. */
  upsertResponders(runId: string, responders: readonly DidSweepResponderInput[], nowUtc: string): Promise<void>;
  /** Every persisted run, most-recently-updated first. */
  listRuns(): Promise<DidSweepRunRecord[]>;
  getRun(runId: string): Promise<DidSweepRunRecord | null>;
  getResponders(runId: string): Promise<DidSweepResponderRecord[]>;
  deleteRun(runId: string): Promise<void>;
  /** Deletes every run beyond the `keep` most-recently-updated ones (and their responders) -- addendum: "Retention: keep the last 5 runs." */
  enforceRetention(keep: number): Promise<void>;
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
}

/** Web-preview / test fallback: no persistence across reloads, but satisfies the SAME `DidSweepStore` contract as the SQL-backed implementation (mirrors `InMemorySessionRepository`'s own role for the session repository). */
export function createInMemoryDidSweepStore(): DidSweepStore {
  const runs = new Map<string, MemoryRun>();

  function toRecord(run: MemoryRun): DidSweepRunRecord {
    const { responders: _responders, ...record } = run;
    return { ...record, nrcCounts: { ...record.nrcCounts } };
  }

  return {
    async createRun(run): Promise<void> {
      runs.set(run.runId, { ...run, nrcCounts: { ...run.nrcCounts }, responderCount: 0, responders: new Map() });
    },

    async updateRunProgress(runId, patch, nowUtc): Promise<void> {
      const run = runs.get(runId);
      if (run === undefined) return;
      if (patch.lastDid !== undefined) run.lastDid = patch.lastDid;
      if (patch.status !== undefined) run.status = patch.status;
      if (patch.visitedCount !== undefined) run.visitedCount = patch.visitedCount;
      if (patch.timeoutCount !== undefined) run.timeoutCount = patch.timeoutCount;
      if (patch.unmatchedCount !== undefined) run.unmatchedCount = patch.unmatchedCount;
      if (patch.errorCount !== undefined) run.errorCount = patch.errorCount;
      if (patch.nrcCounts !== undefined) run.nrcCounts = { ...patch.nrcCounts };
      run.updatedAtUtc = nowUtc;
    },

    async upsertResponders(runId, responders, nowUtc): Promise<void> {
      const run = runs.get(runId);
      if (run === undefined) return;
      for (const input of responders) {
        const existing = run.responders.get(input.did);
        if (existing === undefined) {
          run.responders.set(input.did, {
            runId,
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
      params.push(runId);
      await db.runAsync(`UPDATE did_sweep_runs SET ${sets.join(', ')} WHERE run_id = ?`, params);
    },

    async upsertResponders(runId, responders, nowUtc): Promise<void> {
      if (responders.length === 0) return;
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
      const countRows = await db.getAllAsync<{ n: number }>(
        'SELECT COUNT(*) AS n FROM did_sweep_responders WHERE run_id = ?',
        [runId],
      );
      const responderCount = countRows[0]?.n ?? 0;
      await db.runAsync('UPDATE did_sweep_runs SET responder_count = ?, updated_at_utc = ? WHERE run_id = ?', [
        responderCount,
        nowUtc,
        runId,
      ]);
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
      await db.runAsync('DELETE FROM did_sweep_responders WHERE run_id = ?', [runId]);
      await db.runAsync('DELETE FROM did_sweep_runs WHERE run_id = ?', [runId]);
    },

    async enforceRetention(keep): Promise<void> {
      const rows = await db.getAllAsync<{ run_id: string }>(
        'SELECT run_id FROM did_sweep_runs ORDER BY updated_at_utc DESC LIMIT -1 OFFSET ?',
        [Math.max(0, keep)],
      );
      for (const row of rows) {
        await db.runAsync('DELETE FROM did_sweep_responders WHERE run_id = ?', [row.run_id]);
        await db.runAsync('DELETE FROM did_sweep_runs WHERE run_id = ?', [row.run_id]);
      }
    },
  };
}

/** Picks the SQL-backed store when `db` is available, else the in-memory fallback (web preview) -- same `db !== null` ternary convention `composition.ts` already uses for the session repository/settings store. */
export function createDidSweepStore(db: SqlDatabase | null): DidSweepStore {
  return db === null ? createInMemoryDidSweepStore() : createSqlDidSweepStore(db);
}
