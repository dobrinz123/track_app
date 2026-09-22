import { describe, expect, it } from 'vitest';

import type { SqlDatabase } from '@circuit/core';
import { SqlSessionRepository } from '@circuit/core';

import {
  readSessionVehicleSnapshot,
  writeSessionVehicleSnapshot,
} from '../../src/persistence/sessionVehicleSnapshot';
import { createAnalysisRunner } from '../../src/session/analysisViewModel';
import { createSuggestionJournal } from '../../src/session/stintCoaching';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * Ticket P14 H6 + H7 (Codex P13 round, composition.ts:4437 and :4493) -- THE
 * THREE TOOLS THAT REPORTED A CONFIDENT NEGATIVE THEY HAD NOT EARNED.
 *
 * H6a: the suggestion journal is in memory, so after a restart it answers
 *      every session with empty arrays -- which the export read as "the
 *      trackday stage applied no cue move and showed no pit suggestion in this
 *      session", a statement about the drive made by a process that was not
 *      there for it.
 * H6b: only READY analysis results are memoised, so `peek()` returns `null`
 *      for an analysis that ERRORED exactly as it does for one nobody ran --
 *      and the export said "the analysis has not been run".
 * H7:  the report carried the CURRENTLY active vehicle profile's bindings for
 *      a historical session. Record with A, switch to B, export A: the
 *      document described B, and an empty B additionally claimed no OBD
 *      channel had been decoded.
 */

describe('P14 H6a -- an in-memory journal says when it was not there', () => {
  it('reports a session it never recorded as UNOBSERVED, not as one that did nothing', () => {
    const journal = createSuggestionJournal();

    // The restart case: a session id this process has never seen.
    expect(journal.observed('session-from-a-previous-launch')).toBe(false);
    expect(journal.read('session-from-a-previous-launch')).toEqual({
      cueUpdates: [],
      shownPitSuggestions: [],
    });

    // A session THIS process is recording for, which happened to do nothing.
    // That empty read is a fact about the drive and may be reported as one.
    journal.markObserved('session-now');
    expect(journal.observed('session-now')).toBe(true);
    expect(journal.read('session-now')).toEqual({ cueUpdates: [], shownPitSuggestions: [] });
  });

  it('forgets the claim when the whole journal is cleared', () => {
    const journal = createSuggestionJournal();
    journal.markObserved('s1');
    journal.clear();
    expect(journal.observed('s1')).toBe(false);
  });

  it('keeps the claim through the per-session clear a session start does', () => {
    const journal = createSuggestionJournal();
    journal.markObserved('s1');
    // `initializeSessionStage` clears this session's entry and then marks it.
    journal.clear('s1');
    expect(journal.observed('s1')).toBe(true);
  });
});

describe('P14 H6b -- an analysis that FAILED is not an analysis nobody ran', () => {
  function runner(load: () => Promise<never> | Promise<null>) {
    return createAnalysisRunner({
      loadSession: load as never,
      isSessionActive: () => false,
      yieldToUi: () => Promise.resolve(),
    });
  }

  it('reports NEVER before any pass, and FAILED after one threw', async () => {
    const analysis = runner(() => Promise.reject(new Error('trace store unreadable')));

    expect(analysis.outcome('s1')).toEqual({ state: 'never' });
    const result = await analysis.run('s1');
    expect(result.status).toBe('error');
    // `peek` still says nothing -- errors are deliberately not memoised, so
    // "try again" means it. The OUTCOME is what stops the export from
    // reporting this as a session nobody analysed.
    expect(analysis.peek('s1')).toBeNull();
    expect(analysis.outcome('s1').state).toBe('failed');
    expect(analysis.outcome('s1').detail).toContain('trace store unreadable');
  });

  it('reports a NAMED dead end as unavailable, with the reason', async () => {
    const analysis = runner(() => Promise.resolve(null));
    const result = await analysis.run('s1');
    expect(result.status).toBe('unavailable');
    expect(analysis.outcome('s1')).toEqual({ state: 'unavailable', detail: 'session-not-found' });
  });

  it('drops the outcome log with the cache', async () => {
    const analysis = runner(() => Promise.reject(new Error('boom')));
    await analysis.run('s1');
    expect(analysis.outcome('s1').state).toBe('failed');
    analysis.clear();
    expect(analysis.outcome('s1')).toEqual({ state: 'never' });
  });
});

describe('P14 H7 -- the vehicle configuration a session was recorded under', () => {
  async function database(): Promise<SqlDatabase> {
    const db = await createSqlJsDatabase();
    // The `settings` table this lives in comes from the repository migration.
    await SqlSessionRepository.create(db);
    return db;
  }

  it('reads back the profile and bindings that were active at session start', async () => {
    const db = await database();
    await writeSessionVehicleSnapshot(db, 'session-a', {
      profileId: 'supra-b58',
      bindings: [{ channel: 'brakePressure', pid: '0x58B7' }],
      capturedAtUtc: '2026-09-22T09:00:00.000Z',
    });

    // The owner switches to another car. The snapshot does not move.
    await writeSessionVehicleSnapshot(db, 'session-b', {
      profileId: 'generic',
      bindings: [],
      capturedAtUtc: '2026-09-22T11:00:00.000Z',
    });

    const a = await readSessionVehicleSnapshot(db, 'session-a');
    expect(a!.profileId).toBe('supra-b58');
    expect(a!.bindings).toHaveLength(1);
    const b = await readSessionVehicleSnapshot(db, 'session-b');
    expect(b!.profileId).toBe('generic');
    expect(b!.bindings).toHaveLength(0);
  });

  it('answers null -- NOT today’s profile -- for a session with no snapshot', async () => {
    const db = await database();
    await writeSessionVehicleSnapshot(db, 'session-today', {
      profileId: 'supra-b58',
      bindings: [{ channel: 'brakePressure' }],
      capturedAtUtc: '2026-09-22T11:00:00.000Z',
    });

    // A session recorded before snapshots existed. `null` means UNAVAILABLE,
    // and the export must say so rather than lending it the row above.
    expect(await readSessionVehicleSnapshot(db, 'session-from-last-year')).toBeNull();
  });

  it('answers null for a row that will not decode, never an empty binding list', async () => {
    const db = await database();
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'vehicle-profile-snapshot:session-corrupt',
      '{not json',
    ]);
    expect(await readSessionVehicleSnapshot(db, 'session-corrupt')).toBeNull();

    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'vehicle-profile-snapshot:session-wrong-shape',
      JSON.stringify({ profileId: 'supra-b58' }),
    ]);
    expect(await readSessionVehicleSnapshot(db, 'session-wrong-shape')).toBeNull();
  });
});
