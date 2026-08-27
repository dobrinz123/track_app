import { describe, expect, it } from 'vitest';
import type { SqlDatabase } from '@circuit/core';
import { createRawSqlJsDatabase, createSqlJsDatabase, wrapExistingSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateDidSweepSchema, DID_SWEEP_SCHEMA_VERSION } from '../../src/persistence/didSweepSchema';
import {
  createInMemoryDidSweepStore,
  createSqlDidSweepStore,
  createDidSweepStore,
  hexToBytes,
  type DidSweepRunRecord,
  type DidSweepStore,
} from '../../src/persistence/didSweepStore';

/**
 * DID sweep — results persistence, export & candidate filtering addendum
 * (2026-08-27, binding — Phase 4i): "every sweep run is persisted
 * incrementally ... A run survives app kill and can be resumed from
 * `lastDid` ... Retention: keep the last 5 runs." Tested against BOTH
 * backing implementations (SQL-via-sql.js, and in-memory) with the exact
 * SAME assertions where the two are supposed to behave identically -- proves
 * `createDidSweepStore`'s ternary picks a genuinely interchangeable
 * implementation.
 */
async function migratedDb(): Promise<SqlDatabase> {
  const db = await createSqlJsDatabase();
  await migrateDidSweepSchema(db);
  return db;
}

function freshRun(overrides: Partial<Omit<DidSweepRunRecord, 'responderCount'>> = {}): Omit<DidSweepRunRecord, 'responderCount'> {
  return {
    runId: 'run-1',
    adapterType: 'enet',
    targetAddress: 0x12,
    rangeFrom: 0,
    rangeTo: 0xffff,
    lastDid: null,
    startedAtUtc: '2026-08-27T18:00:00.000Z',
    updatedAtUtc: '2026-08-27T18:00:00.000Z',
    status: 'running',
    visitedCount: 0,
    timeoutCount: 0,
    unmatchedCount: 0,
    errorCount: 0,
    nrcCounts: {},
    ...overrides,
  };
}

describe('didSweepSchema migration', () => {
  it('creates did_sweep_runs/did_sweep_responders idempotently and records DID_SWEEP_SCHEMA_VERSION', async () => {
    const db = await createSqlJsDatabase();
    await migrateDidSweepSchema(db);
    await migrateDidSweepSchema(db); // re-running must not throw or duplicate the version row.

    const versionRows = await db.getAllAsync<{ version: number }>('SELECT version FROM did_sweep_schema_migrations');
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]!.version).toBe(DID_SWEEP_SCHEMA_VERSION);
  });
});

describe.each([
  ['SQL-backed (sql.js)', async () => createSqlDidSweepStore(await migratedDb())],
  ['in-memory (web preview fallback)', async () => createInMemoryDidSweepStore()],
] as const)('DidSweepStore: %s', (_label, makeStore) => {
  it('createRun then getRun round-trips every field', async () => {
    const store: DidSweepStore = await makeStore();
    await store.createRun(freshRun());
    const run = await store.getRun('run-1');
    expect(run).toEqual({ ...freshRun(), responderCount: 0 });
  });

  it('getRun returns null for an unknown runId', async () => {
    const store: DidSweepStore = await makeStore();
    expect(await store.getRun('nope')).toBeNull();
  });

  it('updateRunProgress applies a partial patch and bumps updatedAtUtc', async () => {
    const store: DidSweepStore = await makeStore();
    await store.createRun(freshRun());
    await store.updateRunProgress('run-1', { lastDid: 0x1002, visitedCount: 5, status: 'paused' }, '2026-08-27T18:05:00.000Z');
    const run = await store.getRun('run-1');
    expect(run?.lastDid).toBe(0x1002);
    expect(run?.visitedCount).toBe(5);
    expect(run?.status).toBe('paused');
    expect(run?.updatedAtUtc).toBe('2026-08-27T18:05:00.000Z');
    expect(run?.errorCount).toBe(0); // untouched fields stay as they were.
  });

  it('updateRunProgress persists nrcCounts as a structured object, round-tripping through JSON', async () => {
    const store: DidSweepStore = await makeStore();
    await store.createRun(freshRun());
    await store.updateRunProgress('run-1', { nrcCounts: { '17': 3, '49': 1 } }, '2026-08-27T18:05:00.000Z');
    const run = await store.getRun('run-1');
    expect(run?.nrcCounts).toEqual({ '17': 3, '49': 1 });
  });

  it('upsertResponders inserts a new responder and updates the run\'s own responderCount', async () => {
    const store: DidSweepStore = await makeStore();
    await store.createRun(freshRun());
    await store.upsertResponders(
      'run-1',
      [{ did: 0x1002, raw: Uint8Array.from([0x1a, 0x2b]), rttMs: 22 }],
      '2026-08-27T18:00:05.000Z',
    );
    const responders = await store.getResponders('run-1');
    expect(responders).toHaveLength(1);
    expect(responders[0]).toMatchObject({
      runId: 'run-1',
      did: 0x1002,
      length: 2,
      rawHex: '1A2B',
      rttMs: 22,
      firstSeenUtc: '2026-08-27T18:00:05.000Z',
      lastSeenUtc: '2026-08-27T18:00:05.000Z',
      sampleCount: 1,
    });
    expect((await store.getRun('run-1'))?.responderCount).toBe(1);
  });

  it('upsertResponders on a REPEAT did within the same run updates lastSeenUtc/rawHex and increments sampleCount -- never a duplicate row', async () => {
    const store: DidSweepStore = await makeStore();
    await store.createRun(freshRun());
    await store.upsertResponders('run-1', [{ did: 0x1002, raw: Uint8Array.from([0x10]), rttMs: 20 }], '2026-08-27T18:00:05.000Z');
    await store.upsertResponders('run-1', [{ did: 0x1002, raw: Uint8Array.from([0x99]), rttMs: 25 }], '2026-08-27T18:00:10.000Z');

    const responders = await store.getResponders('run-1');
    expect(responders).toHaveLength(1); // no duplicate row.
    expect(responders[0]).toMatchObject({
      rawHex: '99',
      rttMs: 25,
      firstSeenUtc: '2026-08-27T18:00:05.000Z', // unchanged.
      lastSeenUtc: '2026-08-27T18:00:10.000Z',
      sampleCount: 2,
    });
    expect((await store.getRun('run-1'))?.responderCount).toBe(1);
  });

  it('hexToBytes round-trips a persisted rawHex back to the original bytes', async () => {
    const store: DidSweepStore = await makeStore();
    await store.createRun(freshRun());
    const original = Uint8Array.from([0x00, 0x1a, 0xff, 0x59]);
    await store.upsertResponders('run-1', [{ did: 0x1002, raw: original, rttMs: 20 }], '2026-08-27T18:00:05.000Z');
    const [responder] = await store.getResponders('run-1');
    expect(hexToBytes(responder!.rawHex)).toEqual(original);
  });

  it('listRuns returns every run, most-recently-updated first', async () => {
    const store: DidSweepStore = await makeStore();
    await store.createRun(freshRun({ runId: 'run-a', updatedAtUtc: '2026-08-27T18:00:00.000Z' }));
    await store.createRun(freshRun({ runId: 'run-b', updatedAtUtc: '2026-08-27T19:00:00.000Z' }));
    await store.createRun(freshRun({ runId: 'run-c', updatedAtUtc: '2026-08-27T17:00:00.000Z' }));
    const runs = await store.listRuns();
    expect(runs.map((r) => r.runId)).toEqual(['run-b', 'run-a', 'run-c']);
  });

  it('deleteRun removes the run AND its responders', async () => {
    const store: DidSweepStore = await makeStore();
    await store.createRun(freshRun());
    await store.upsertResponders('run-1', [{ did: 0x1002, raw: Uint8Array.from([0x10]), rttMs: 20 }], '2026-08-27T18:00:05.000Z');
    await store.deleteRun('run-1');
    expect(await store.getRun('run-1')).toBeNull();
    expect(await store.getResponders('run-1')).toEqual([]);
  });

  it('enforceRetention(5) keeps only the 5 most-recently-updated runs, deleting the rest (and their responders)', async () => {
    const store: DidSweepStore = await makeStore();
    for (let i = 0; i < 7; i += 1) {
      const runId = `run-${i}`;
      await store.createRun(freshRun({ runId, updatedAtUtc: `2026-08-27T${String(10 + i).padStart(2, '0')}:00:00.000Z` }));
      await store.upsertResponders(runId, [{ did: 0x1000 + i, raw: Uint8Array.from([i]), rttMs: 10 }], `2026-08-27T${String(10 + i).padStart(2, '0')}:00:00.000Z`);
    }
    await store.enforceRetention(5);
    const remaining = await store.listRuns();
    expect(remaining).toHaveLength(5);
    // The 2 OLDEST (run-0, run-1) are the ones dropped.
    expect(remaining.map((r) => r.runId).sort()).toEqual(['run-2', 'run-3', 'run-4', 'run-5', 'run-6'].sort());
    expect(await store.getResponders('run-0')).toEqual([]); // responders dropped too.
  });
});

describe('DidSweepStore: resume across a simulated app restart (SQL-backed only)', () => {
  it('a run persisted before "app kill" is fully readable after re-opening the SAME underlying database', async () => {
    const raw = await createRawSqlJsDatabase();
    const db1 = wrapExistingSqlJsDatabase(raw);
    await migrateDidSweepSchema(db1);
    const store1 = createSqlDidSweepStore(db1);
    await store1.createRun(freshRun({ lastDid: null, status: 'running' }));
    await store1.upsertResponders('run-1', [{ did: 0x1002, raw: Uint8Array.from([0x1a]), rttMs: 15 }], '2026-08-27T18:00:05.000Z');
    await store1.updateRunProgress('run-1', { lastDid: 0x1002, visitedCount: 3, status: 'stopped' }, '2026-08-27T18:00:06.000Z');

    // "App kill" -- a FRESH SqlDatabase wrapper over the SAME underlying
    // sql.js Database instance, exactly like `openAppDatabase()` re-opening
    // the on-device file on the next launch.
    const db2 = wrapExistingSqlJsDatabase(raw);
    const store2 = createSqlDidSweepStore(db2);
    const resumedRun = await store2.getRun('run-1');
    const resumedResponders = await store2.getResponders('run-1');

    expect(resumedRun).toMatchObject({ lastDid: 0x1002, visitedCount: 3, status: 'stopped' });
    expect(resumedResponders).toHaveLength(1);
    expect(resumedResponders[0]!.did).toBe(0x1002);
  });
});

describe('createDidSweepStore (factory)', () => {
  it('db === null -> the in-memory fallback (web preview)', async () => {
    const store = createDidSweepStore(null);
    await store.createRun(freshRun());
    expect(await store.getRun('run-1')).not.toBeNull();
  });

  it('a real db -> the SQL-backed implementation', async () => {
    const db = await migratedDb();
    const store = createDidSweepStore(db);
    await store.createRun(freshRun());
    const rows = await db.getAllAsync('SELECT * FROM did_sweep_runs WHERE run_id = ?', ['run-1']);
    expect(rows).toHaveLength(1); // genuinely wrote to the SQL table, not an in-memory shadow.
  });
});
