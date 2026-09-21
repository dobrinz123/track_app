import { describe, expect, it } from 'vitest';
import { SqlSessionRepository } from '../../src/persistence-sql';
import type { SqlBindValue, SqlDatabase } from '../../src/persistence-sql';
import { runRepositoryContractTests } from '../persistence/contractSuite';
import { makeLocationSample, makeReferenceLap, makeSessionSummary, makeSnapshot, makeLapRecord } from '../persistence/fixtures';
import { createRawSqlJsDatabase, createSqlJsDatabase, wrapSqlJsDatabase } from './sqlJsDatabase';

// The full shared contract, run against SqlSessionRepository over a fresh
// sql.js database per test (via the beforeEach inside
// runRepositoryContractTests). This is the "same semantic guarantees as the
// in-memory reference implementation, proven by a shared contract test
// suite" requirement.
runRepositoryContractTests('SqlSessionRepository(sql.js)', async () => SqlSessionRepository.create(await createSqlJsDatabase()));

/**
 * Decorates a `SqlDatabase` so that `runAsync` throws for the first SQL
 * statement matching `shouldFail`, then behaves normally afterwards. Used to
 * simulate a failure occurring *inside* an already-open transaction (as
 * opposed to a validation error that never reaches the database at all).
 */
function withInjectedRunFailure(db: SqlDatabase, shouldFail: (sql: string) => boolean, message: string): SqlDatabase {
  let armed = true;
  // P10B H5-B: a transaction's statements now run through the
  // transaction-scoped handle the callback is given, so the injection has to
  // decorate THAT handle too -- otherwise a mid-transaction failure can no
  // longer be simulated at all. Both decorations share `armed`, so it is
  // still exactly ONE injected failure.
  const decorate = (inner: SqlDatabase): SqlDatabase => ({
    execAsync: (sql) => inner.execAsync(sql),
    runAsync: async (sql: string, params?: readonly SqlBindValue[]) => {
      if (armed && shouldFail(sql)) {
        armed = false;
        throw new Error(message);
      }
      return inner.runAsync(sql, params);
    },
    getAllAsync: (sql, params) => inner.getAllAsync(sql, params),
    withTransactionAsync: (fn) => inner.withTransactionAsync((tx) => fn(decorate(tx))),
  });
  return decorate(db);
}

describe('SqlSessionRepository - SQL-specific guarantees', () => {
  it('migration is idempotent: opening the same underlying store twice does not throw and preserves data', async () => {
    const rawDb = await createRawSqlJsDatabase();

    const repo1 = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const ref = makeReferenceLap({ durationMs: 77_000 });
    await repo1.putReferenceLap(ref);

    // "Reopen" against the same underlying store: a fresh SqlDatabase wrapper
    // over the same sql.js Database, simulating the app restarting and
    // re-running migrations against an already-migrated file.
    await expect(SqlSessionRepository.create(wrapSqlJsDatabase(rawDb))).resolves.toBeInstanceOf(SqlSessionRepository);
    const repo2 = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));

    // Data survives the re-migration untouched.
    const loaded = await repo2.getReferenceLap(ref.userId, ref.circuitId, ref.layoutId, ref.layoutVersion);
    expect(loaded).toEqual(ref);

    // The migration bookkeeping row itself was not duplicated by re-running
    // the idempotent DDL / seed insert three times (repo1 + two repo2 opens).
    const rows = await wrapSqlJsDatabase(rawDb).getAllAsync<{ c: number }>(
      'SELECT COUNT(*) as c FROM schema_migrations',
    );
    expect(rows[0]?.c).toBe(1);
  });

  /**
   * Ticket P10A H3/H6: the on-device database the owner already has was
   * created under schema v2, whose `sessions` table has none of the new
   * columns. `CREATE TABLE IF NOT EXISTS` cannot add them, so the upgrade
   * rests on `SQL_ALTERS_V3` -- and a failed upgrade would not be a missing
   * feature, it would be every read of `sessions` throwing on a phone with
   * a track day's data on it.
   */
  it('upgrades a pre-P10A (v2-shaped) sessions table in place, keeping its rows and reading them as unknown provenance', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const db = wrapSqlJsDatabase(rawDb);

    // Exactly the v2 DDL for this table: no calibrationStatus, no trace columns.
    await db.execAsync(`
      CREATE TABLE schema_migrations (version INTEGER NOT NULL);
      CREATE TABLE sessions (
        sessionId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        circuitId TEXT NOT NULL,
        layoutId TEXT NOT NULL,
        layoutVersion INTEGER NOT NULL,
        startedAtUtc TEXT NOT NULL
      );
    `);
    await db.runAsync('INSERT INTO schema_migrations (version) VALUES (?)', [2]);
    await db.runAsync(
      'INSERT INTO sessions (sessionId, userId, circuitId, layoutId, layoutVersion, startedAtUtc) VALUES (?, ?, ?, ?, ?, ?)',
      ['legacy-1', 'driver-1', 'tmr', 'main', 1, '2026-09-01T09:00:00.000Z'],
    );

    const repo = await SqlSessionRepository.create(db);

    const listed = await repo.listSessions('driver-1', 'tmr');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.sessionId).toBe('legacy-1');
    // Ticket P10A H6 (binding): a row that predates the column says UNKNOWN.
    // Reading it as `'validated'` would be the app vouching for a session
    // nobody ever vouched for.
    expect(listed[0]?.calibrationStatus).toBe('unknown');
    expect(listed[0]?.trace).toBeUndefined();

    // The upgraded table takes the new facts from here on.
    await repo.saveSession(
      makeSessionSummary({
        sessionId: 'new-1',
        userId: 'driver-1',
        circuitId: 'tmr',
        layoutId: 'main',
        layoutVersion: 1,
        laps: [],
        calibrationStatus: 'unvalidated',
        trace: { unwrittenSampleCount: 3, failedWriteCount: 2 },
      }),
    );
    const after = await repo.listSessions('driver-1', 'tmr');
    const stored = after.find((session) => session.sessionId === 'new-1');
    expect(stored?.calibrationStatus).toBe('unvalidated');
    expect(stored?.trace).toEqual({ unwrittenSampleCount: 3, failedWriteCount: 2 });

    // And re-opening (the very next app launch) re-runs the ALTERs harmlessly.
    await expect(SqlSessionRepository.create(wrapSqlJsDatabase(rawDb))).resolves.toBeInstanceOf(
      SqlSessionRepository,
    );
  });

  it('putReferenceLap is transactionally atomic: a failure injected between the DELETE and the INSERT leaves the previous PB intact', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const cleanDb = wrapSqlJsDatabase(rawDb);
    const repo = await SqlSessionRepository.create(cleanDb);

    const good = makeReferenceLap({ durationMs: 90_000 });
    await repo.putReferenceLap(good);

    // A second, structurally-VALID candidate for the same composite key --
    // validateReferenceLap passes, so the failure below can only be reached
    // by actually starting the transaction (DELETE succeeds, then the
    // injected failure fires on the INSERT).
    const replacement = makeReferenceLap({ durationMs: 60_000 });
    const failingDb = withInjectedRunFailure(
      wrapSqlJsDatabase(rawDb),
      (sql) => sql.includes('INSERT INTO reference_laps'),
      'injected mid-transaction failure',
    );
    const repoWithFailure = await SqlSessionRepository.create(failingDb);

    await expect(repoWithFailure.putReferenceLap(replacement)).rejects.toThrow('injected mid-transaction failure');

    // The DELETE half of the transaction must have been rolled back along
    // with the failed INSERT: the original PB is still there, unchanged.
    const stillThere = await repo.getReferenceLap(good.userId, good.circuitId, good.layoutId, good.layoutVersion);
    expect(stillThere).toEqual(good);
  });

  it('deleteUserData sweeps orphan checkpoints/telemetry for sessionIds minted as `${userId}--<random>` that were never saved via saveSession', async () => {
    // SQL-only strengthening beyond InMemorySessionRepository (WP11a
    // concern): a checkpoint/telemetry row can exist for an active or
    // crashed session that has no corresponding `sessions` row yet, so a
    // sessions-join delete alone cannot reach it -- this is why
    // SqlSessionRepository additionally sweeps by sessionId prefix.
    const repo = await SqlSessionRepository.create(await createSqlJsDatabase());

    const orphanSessionId = 'user-1--abcdef123456';
    await repo.saveCheckpoint(orphanSessionId, makeSnapshot(), [makeLapRecord()]);
    await repo.saveTelemetry(orphanSessionId, 1, [makeLocationSample()]);

    // A different user ("user-10") whose id merely shares the string prefix
    // "user-1" (without the "--" separator) must NOT be swept when deleting
    // "user-1": the prefix match is on `${userId}--`, not a raw substring.
    const lookalikeSessionId = 'user-10--abcdef123456';
    await repo.saveSession(makeSessionSummary({ sessionId: lookalikeSessionId, userId: 'user-10', circuitId: 'circuit-a' }));
    await repo.saveCheckpoint(lookalikeSessionId, makeSnapshot(), [makeLapRecord()]);
    await repo.saveTelemetry(lookalikeSessionId, 1, [makeLocationSample()]);

    await repo.deleteUserData('user-1');

    expect(await repo.loadCheckpoint(orphanSessionId)).toBeNull();
    expect(await repo.loadTelemetry(orphanSessionId, 1)).toEqual([]);

    expect(await repo.loadCheckpoint(lookalikeSessionId)).not.toBeNull();
    expect(await repo.loadTelemetry(lookalikeSessionId, 1)).toHaveLength(1);
  });
});
