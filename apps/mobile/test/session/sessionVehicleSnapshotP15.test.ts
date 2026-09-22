import { describe, expect, it } from 'vitest';
import { SqlSessionRepository, type SqlDatabase } from '@circuit/core';

import {
  readSessionVehicleSnapshot,
  sessionVehicleSnapshotKey,
  writeSessionVehicleSnapshot,
} from '../../src/persistence/sessionVehicleSnapshot';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * Ticket P15 F2 (Codex P14 round, composition.ts:1757) -- RECOVERY
 * OVERWROTE THE SNAPSHOT IT EXISTS TO PROTECT.
 *
 * `initializeSessionStage()` is called on a normal session start AND by
 * `resumeRecovery()` with the EXISTING session id. Its `INSERT OR REPLACE`
 * then replaced profile A -- the one the session was actually recorded with
 * -- with whatever profile is active now. A crash mid-session followed by a
 * car change is an ordinary Monday, and it reinstated exactly the defect the
 * snapshot was introduced to prevent, on the recovery path.
 *
 * The snapshot is now WRITE-ONCE per session id.
 */
async function database(): Promise<SqlDatabase> {
  const db = await createSqlJsDatabase();
  await SqlSessionRepository.create(db);
  return db;
}

const SESSION = 'local-driver--crashed-mid-session';

describe('P15 F2 -- a session vehicle snapshot is written once and never replaced', () => {
  it('keeps the profile the session was RECORDED with when recovery re-initialises it', async () => {
    const db = await database();

    // The session starts under profile A.
    expect(
      await writeSessionVehicleSnapshot(db, SESSION, {
        profileId: 'toyota-supra-b58',
        bindings: [{ channel: 'brakePressure', ecu: 0x12, did: 0x58b7 }],
        capturedAtUtc: '2026-09-22T09:00:00.000Z',
      }),
    ).toBe(true);

    // It crashes. The owner switches cars. Recovery re-initialises the SAME
    // session id, which snapshots today's profile.
    expect(
      await writeSessionVehicleSnapshot(db, SESSION, {
        profileId: 'generic',
        bindings: [],
        capturedAtUtc: '2026-09-22T10:30:00.000Z',
      }),
    ).toBe(true);

    const snapshot = await readSessionVehicleSnapshot(db, SESSION);
    // BEFORE: `generic`, with no bindings at all -- and the export then
    // reported that the session decoded no OBD channel.
    expect(snapshot!.profileId).toBe('toyota-supra-b58');
    expect(snapshot!.bindings.map((binding) => binding.channel)).toEqual(['brakePressure']);
    expect(snapshot!.capturedAtUtc).toBe('2026-09-22T09:00:00.000Z');

    // Exactly one row, so nothing accumulated in the settings table either.
    const rows = await db.getAllAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      [sessionVehicleSnapshotKey(SESSION)],
    );
    expect(rows).toHaveLength(1);
  });

  it('still writes the first snapshot for a session that has none', async () => {
    const db = await database();
    expect(
      await writeSessionVehicleSnapshot(db, 'fresh-session', {
        profileId: 'toyota-supra-b58',
        bindings: [{ channel: 'accelPedalPct' }],
        capturedAtUtc: '2026-09-22T09:00:00.000Z',
      }),
    ).toBe(true);
    expect((await readSessionVehicleSnapshot(db, 'fresh-session'))!.profileId).toBe(
      'toyota-supra-b58',
    );
  });

  it('keeps each session on its own key -- write-once is per session, not global', async () => {
    const db = await database();
    await writeSessionVehicleSnapshot(db, 'session-a', {
      profileId: 'toyota-supra-b58',
      bindings: [{ channel: 'brakePressure' }],
      capturedAtUtc: '2026-09-22T09:00:00.000Z',
    });
    await writeSessionVehicleSnapshot(db, 'session-b', {
      profileId: 'generic',
      bindings: [],
      capturedAtUtc: '2026-09-22T11:00:00.000Z',
    });

    expect((await readSessionVehicleSnapshot(db, 'session-a'))!.profileId).toBe('toyota-supra-b58');
    expect((await readSessionVehicleSnapshot(db, 'session-b'))!.profileId).toBe('generic');
  });

  it('does NOT replace an existing row that will not decode -- an unreadable snapshot stays unreadable, never today’s profile', async () => {
    const db = await database();
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      sessionVehicleSnapshotKey('session-corrupt'),
      '{not json',
    ]);

    await writeSessionVehicleSnapshot(db, 'session-corrupt', {
      profileId: 'generic',
      bindings: [],
      capturedAtUtc: '2026-09-22T11:00:00.000Z',
    });

    // Still unreadable -> the export reports UNAVAILABLE. Substituting
    // today's profile over a row we cannot read would be a fabrication.
    expect(await readSessionVehicleSnapshot(db, 'session-corrupt')).toBeNull();
    const rows = await db.getAllAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      [sessionVehicleSnapshotKey('session-corrupt')],
    );
    expect(rows[0]?.value).toBe('{not json');
  });

  it('refuses an empty session id and never throws on a broken database', async () => {
    const db = await database();
    expect(
      await writeSessionVehicleSnapshot(db, '', {
        profileId: 'generic',
        bindings: [],
        capturedAtUtc: '2026-09-22T11:00:00.000Z',
      }),
    ).toBe(false);

    const broken: SqlDatabase = {
      ...db,
      runAsync: () => Promise.reject(new Error('database is locked')),
    } as unknown as SqlDatabase;
    expect(
      await writeSessionVehicleSnapshot(broken, 'session-x', {
        profileId: 'generic',
        bindings: [],
        capturedAtUtc: '2026-09-22T11:00:00.000Z',
      }),
    ).toBe(false);
  });
});
