import { describe, expect, it } from 'vitest';

import { SQL_DDL, SQL_SCHEMA_VERSION, SqlSessionRepository } from '../../src/persistence-sql';
import { createRawSqlJsDatabase, wrapExistingSqlJsDatabase } from '../persistence-sql/sqlJsDatabase';

/**
 * Exercises the v2 (WP14) migration path for real (MUST DO #4): a database
 * created under the OLD v1 DDL only (no `settings` table, `schema_migrations`
 * row at version 1) is reopened through `SqlSessionRepository.create`, which
 * must add the `settings` table and bump the recorded schema version to 2
 * WITHOUT touching any pre-existing row in any other table.
 */
describe('persistence-sql v2 settings migration', () => {
  it('upgrades a v1-only database in place, preserving existing data', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const v1Db = wrapExistingSqlJsDatabase(rawDb);

    // Simulate a pre-WP14 database: only the original v1 DDL, version row = 1.
    await v1Db.execAsync(SQL_DDL);
    await v1Db.runAsync('INSERT INTO schema_migrations (version) VALUES (?)', [1]);
    await v1Db.runAsync(
      `INSERT INTO sessions (sessionId, userId, circuitId, layoutId, layoutVersion, startedAtUtc)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['pre-existing-session', 'driver-1', 'transilvania-motor-ring', 'main', 1, '2026-08-01T00:00:00.000Z'],
    );

    // No `settings` table yet -- selecting from it must fail on the raw v1 database.
    await expect(v1Db.getAllAsync('SELECT * FROM settings')).rejects.toBeTruthy();

    // Reopen through the real repository constructor -- this is the actual
    // upgrade path a real app hits when it opens an existing on-device DB
    // after updating.
    const upgraded = await SqlSessionRepository.create(v1Db);

    const versionRows = await v1Db.getAllAsync<{ version: number }>('SELECT version FROM schema_migrations');
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]?.version).toBe(SQL_SCHEMA_VERSION);
    expect(SQL_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);

    // The settings table now exists and is usable.
    await v1Db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', ['units', 'kmh']);
    const settingsRows = await v1Db.getAllAsync<{ key: string; value: string }>(
      'SELECT key, value FROM settings WHERE key = ?',
      ['units'],
    );
    expect(settingsRows).toEqual([{ key: 'units', value: 'kmh' }]);

    // Pre-existing data survived the upgrade untouched.
    const sessions = await upgraded.listSessions('driver-1', 'transilvania-motor-ring');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('pre-existing-session');
  });

  it('a fresh database is created directly at the current schema version with the settings table present', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const db = wrapExistingSqlJsDatabase(rawDb);
    await SqlSessionRepository.create(db);

    const versionRows = await db.getAllAsync<{ version: number }>('SELECT version FROM schema_migrations');
    expect(versionRows[0]?.version).toBe(SQL_SCHEMA_VERSION);

    await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', ['deltaDeadbandMs', '100']);
    const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      'deltaDeadbandMs',
    ]);
    expect(rows[0]?.value).toBe('100');
  });

  it('re-opening an already-migrated database is idempotent', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const db = wrapExistingSqlJsDatabase(rawDb);
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', ['units', 'mph']);

    await SqlSessionRepository.create(db);

    const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['units']);
    expect(rows[0]?.value).toBe('mph');
    const versionRows = await db.getAllAsync<{ version: number }>('SELECT version FROM schema_migrations');
    expect(versionRows).toHaveLength(1);
  });
});
