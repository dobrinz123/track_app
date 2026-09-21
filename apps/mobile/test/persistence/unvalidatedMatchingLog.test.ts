import { describe, expect, it } from 'vitest';
import { SqlSessionRepository, type SqlDatabase } from '@circuit/core';

import {
  SqlSettingsStore,
  UNVALIDATED_MATCHING_LOG_LIMIT,
  clearUnvalidatedMatchingSessionIds,
  markSessionMatchingUnvalidated,
  readUnvalidatedMatchingSessionIds,
} from '../../src/persistence/sqlSettingsStore';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * Ticket P7R E2 — the DURABLE half of the honesty flag.
 *
 * The escape hatch is only honest if the label outlives the drive: "which of
 * my sessions were run on matching the gate rejected?" has to be answerable
 * days later, from the history list and from an exported file, not only for
 * the few minutes the controller that set it is alive.
 *
 * Every function here is best-effort by design — this log sits on the path to
 * a driver GOING OUT and to their data coming OFF the phone, and neither may
 * ever be blocked by a settings-table write. So the failure modes are as much
 * the subject of these tests as the happy path.
 */

async function freshDb(): Promise<SqlDatabase> {
  const db = await createSqlJsDatabase();
  await SqlSessionRepository.create(db);
  return db;
}

describe('P7R E2 -- the unvalidated-matching log', () => {
  it('starts empty and records a session id durably', async () => {
    const db = await freshDb();
    expect(await readUnvalidatedMatchingSessionIds(db)).toEqual([]);

    expect(await markSessionMatchingUnvalidated(db, 'session-a')).toBe(true);
    expect(await readUnvalidatedMatchingSessionIds(db)).toEqual(['session-a']);

    // Durable: a fresh read of the same database sees it (this is what a
    // later app launch does).
    expect(await readUnvalidatedMatchingSessionIds(db)).toEqual(['session-a']);
  });

  it('is idempotent -- a second mark of the same session does not duplicate it', async () => {
    const db = await freshDb();
    await markSessionMatchingUnvalidated(db, 'session-a');
    await markSessionMatchingUnvalidated(db, 'session-a');
    await markSessionMatchingUnvalidated(db, 'session-b');
    expect(await readUnvalidatedMatchingSessionIds(db)).toEqual(['session-a', 'session-b']);
  });

  it('is bounded: the oldest ids fall off rather than the row growing without limit', async () => {
    const db = await freshDb();
    for (let i = 0; i < UNVALIDATED_MATCHING_LOG_LIMIT + 5; i += 1) {
      await markSessionMatchingUnvalidated(db, `session-${i}`);
    }
    const ids = await readUnvalidatedMatchingSessionIds(db);
    expect(ids).toHaveLength(UNVALIDATED_MATCHING_LOG_LIMIT);
    // Newest kept, oldest dropped.
    expect(ids[ids.length - 1]).toBe(`session-${UNVALIDATED_MATCHING_LOG_LIMIT + 4}`);
    expect(ids).not.toContain('session-0');
  });

  it('shares the settings table without disturbing the preferences row', async () => {
    const db = await freshDb();
    const store = await SqlSettingsStore.create(db);
    store.update({ units: 'mph', imuFusionEnabled: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await markSessionMatchingUnvalidated(db, 'session-a');

    const reopened = await SqlSettingsStore.create(db);
    expect(reopened.getSettings().units).toBe('mph');
    expect(reopened.getSettings().imuFusionEnabled).toBe(true);
    expect(await readUnvalidatedMatchingSessionIds(db)).toEqual(['session-a']);
  });

  it('a corrupt row reads as "nothing recorded" rather than throwing', async () => {
    const db = await freshDb();
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'unvalidated-matching-sessions',
      'not json at all',
    ]);
    // Losing a label must never be able to lose the data: this read sits on
    // the path to exporting a session.
    expect(await readUnvalidatedMatchingSessionIds(db)).toEqual([]);
    // ... and a later mark repairs the row instead of compounding the damage.
    expect(await markSessionMatchingUnvalidated(db, 'session-a')).toBe(true);
    expect(await readUnvalidatedMatchingSessionIds(db)).toEqual(['session-a']);
  });

  it('a row of the wrong SHAPE is ignored entry by entry, not trusted wholesale', async () => {
    const db = await freshDb();
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'unvalidated-matching-sessions',
      JSON.stringify(['ok-1', 42, null, '', { sessionId: 'nope' }, 'ok-2']),
    ]);
    expect(await readUnvalidatedMatchingSessionIds(db)).toEqual(['ok-1', 'ok-2']);
  });

  it('never throws when the database itself fails -- it reports instead', async () => {
    const broken: SqlDatabase = {
      execAsync: async () => undefined,
      runAsync: async () => {
        throw new Error('disk is gone');
      },
      getAllAsync: async () => {
        throw new Error('disk is gone');
      },
      withTransactionAsync: async (fn: (tx: SqlDatabase) => Promise<void>) => fn(broken),
    };
    await expect(readUnvalidatedMatchingSessionIds(broken)).resolves.toEqual([]);
    await expect(markSessionMatchingUnvalidated(broken, 'session-a')).resolves.toBe(false);
    await expect(clearUnvalidatedMatchingSessionIds(broken)).resolves.toBe(false);
  });

  it('refuses an empty session id rather than recording a meaningless label', async () => {
    const db = await freshDb();
    expect(await markSessionMatchingUnvalidated(db, '')).toBe(false);
    expect(await readUnvalidatedMatchingSessionIds(db)).toEqual([]);
  });

  it('is cleared by delete-all -- these are facts about sessions that no longer exist', async () => {
    const db = await freshDb();
    await markSessionMatchingUnvalidated(db, 'session-a');
    await markSessionMatchingUnvalidated(db, 'session-b');
    expect(await clearUnvalidatedMatchingSessionIds(db)).toBe(true);
    expect(await readUnvalidatedMatchingSessionIds(db)).toEqual([]);
  });
});
