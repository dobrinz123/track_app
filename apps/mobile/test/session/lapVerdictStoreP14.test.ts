import { describe, expect, it } from 'vitest';

import type { LapRecord, LapValidityVerdict, LocalSessionRepository } from '@circuit/core';

import { createLapVerdictStore } from '../../src/session/lapVerdictStore';

/**
 * Ticket P14 H1 + MEDIUM (Codex P13 round, lapVerdictStore.ts:152 and :110).
 *
 * H1 -- A REJECTED SAVE READ BACK AS AN ANSWER. The store cached the verdict
 * BEFORE awaiting storage and never took it back out, so `recordVerdict`
 * returned `'failed'` while `stored()` returned `'agreed'`. The screen's error
 * note is transient (the next tap clears it); the false "answered" was not.
 * The owner would finish the session believing he had recorded a verdict he
 * had not, and the export would count it as agreement with the app.
 *
 * MEDIUM -- A REFRESH COULD ERASE A NEWER ANSWER. A refresh that captured no
 * rows could resolve AFTER a successful write and overwrite the cache with its
 * stale, empty result, so the next answer for that lap was stored at revision
 * 1 again and the earlier one stopped existing. Screens allow taps before a
 * refresh completes, so this is not a theoretical interleaving.
 */

const LAP: Pick<LapRecord, 'lapNumber' | 'valid' | 'invalidReasons'> = {
  lapNumber: 1,
  valid: true,
  invalidReasons: [],
};

/** A repository whose verdict write and verdict read can each be steered. */
function fakeRepository(options: {
  onSave?: (verdict: LapValidityVerdict) => Promise<void>;
  onList?: (sessionId: string) => Promise<LapValidityVerdict[]>;
}): LocalSessionRepository {
  const rows = new Map<number, LapValidityVerdict>();
  return {
    saveLapValidityVerdict: async (verdict: LapValidityVerdict) => {
      if (options.onSave !== undefined) {
        await options.onSave(verdict);
        return;
      }
      rows.set(verdict.lapNumber, verdict);
    },
    listLapValidityVerdicts: async (sessionId: string) => {
      if (options.onList !== undefined) return options.onList(sessionId);
      return [...rows.values()].sort((a, b) => a.lapNumber - b.lapNumber);
    },
  } as unknown as LocalSessionRepository;
}

describe('P14 H1 -- a failed write is never readable as a stored answer', () => {
  it('leaves `stored()` empty when the save is rejected, and says the answer is UNSAVED', async () => {
    const repository = fakeRepository({
      onSave: () => Promise.reject(new Error('database is locked')),
    });
    const store = createLapVerdictStore({ repository: () => repository, onError: () => undefined });

    const outcome = await store.recordVerdict({
      sessionId: 's1',
      lap: LAP,
      decision: 'agreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
    });

    expect(outcome.state).toBe('failed');
    // BEFORE: `stored()` returned the verdict and `summary()` counted it as
    // `agreed`. AFTER: the durable cache holds only what storage holds.
    expect(store.stored('s1')).toHaveLength(0);
    expect(store.summary('s1', [LAP])).toEqual({ agreed: 0, disagreed: 0, unanswered: 1 });
    expect(store.forSession('s1', [LAP])[0]!.answer).toBe('unanswered');

    // The answer is NOT thrown away -- it is held, and declared unsaved, so
    // the screen can keep showing it without it counting as recorded.
    const unsaved = store.unsaved('s1');
    expect(unsaved).toHaveLength(1);
    expect(unsaved[0]!.state).toBe('failed');
    expect(unsaved[0]!.verdict.answer).toBe('agreed');
    expect(unsaved[0]!.detail).toContain('database is locked');
  });

  it('answering a SECOND lap does not make the first failure look resolved', async () => {
    let failNext = true;
    const repository = fakeRepository({
      onSave: () => (failNext ? Promise.reject(new Error('disk full')) : Promise.resolve()),
    });
    const store = createLapVerdictStore({ repository: () => repository, onError: () => undefined });

    await store.recordVerdict({ sessionId: 's1', lap: LAP, decision: 'agreed' });
    failNext = false;
    const second = await store.recordVerdict({
      sessionId: 's1',
      lap: { lapNumber: 2, valid: false, invalidReasons: ['PAUSE_GAP'] },
      decision: 'disagreed',
    });

    expect(second.state).toBe('stored');
    // Lap 2 is durable; lap 1 is still outstanding and still says so.
    expect(store.stored('s1').map((row) => row.lapNumber)).toEqual([2]);
    expect(store.unsaved('s1').map((row) => row.verdict.lapNumber)).toEqual([1]);
  });

  it('clears the unsaved entry once the write succeeds', async () => {
    const repository = fakeRepository({});
    const store = createLapVerdictStore({ repository: () => repository, onError: () => undefined });

    const outcome = await store.recordVerdict({ sessionId: 's1', lap: LAP, decision: 'agreed' });
    expect(outcome.state).toBe('stored');
    expect(store.stored('s1')).toHaveLength(1);
    expect(store.unsaved('s1')).toHaveLength(0);
  });
});

describe('P14 MEDIUM -- a refresh cannot erase an answer written while it was in flight', () => {
  it('keeps the newer answer and does not restart the revision count', async () => {
    let releaseRead: (() => void) | null = null;
    const stored = new Map<number, LapValidityVerdict>();
    const repository = fakeRepository({
      onSave: async (verdict) => {
        stored.set(verdict.lapNumber, verdict);
      },
      onList: async () => {
        // The read that captured NOTHING -- it started before the answer
        // existed and resolves after it was written.
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        return [];
      },
    });
    const store = createLapVerdictStore({ repository: () => repository, onError: () => undefined });

    const refreshing = store.refresh('s1');
    // The tap the screen allows WHILE the refresh is still in flight. It is
    // not awaited here on purpose: this is the interleaving the reviewer
    // reproduced, with the write issued before the read has resolved.
    const writing = store.recordVerdict({
      sessionId: 's1',
      lap: LAP,
      decision: 'agreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
    });
    // Let the queued read actually start before releasing it.
    while (releaseRead === null) await new Promise((resolve) => setTimeout(resolve, 0));
    (releaseRead as () => void)();
    await refreshing;
    const first = await writing;
    expect(first.state).toBe('stored');
    expect(first.verdict!.answerRevision).toBe(1);

    // BEFORE: the stale empty read replaced the cache and the answer was gone.
    expect(store.stored('s1')).toHaveLength(1);
    expect(store.stored('s1')[0]!.answer).toBe('agreed');

    // BEFORE: this second answer was stored at revision 1 again, so a changed
    // mind was indistinguishable from a first answer.
    const second = await store.recordVerdict({
      sessionId: 's1',
      lap: LAP,
      decision: 'disagreed',
      answeredAtUtc: '2026-09-22T10:05:00.000Z',
    });
    expect(second.verdict!.answerRevision).toBe(2);
    expect(stored.get(1)!.answerRevision).toBe(2);
  });

  it('establishes the durable previous revision before replacing an answer', async () => {
    // A store that has never refreshed: the durable row exists, this process
    // has simply not read it yet. A replacement must still count from it.
    const existing: LapValidityVerdict = {
      sessionId: 's1',
      lapNumber: 1,
      appValid: true,
      appInvalidReasons: [],
      answer: 'agreed',
      answeredAtUtc: '2026-09-22T09:00:00.000Z',
      answerRevision: 3,
    };
    const saved: LapValidityVerdict[] = [];
    const repository = fakeRepository({
      onSave: async (verdict) => {
        saved.push(verdict);
      },
      onList: async () => [existing],
    });
    const store = createLapVerdictStore({ repository: () => repository, onError: () => undefined });

    const outcome = await store.recordVerdict({
      sessionId: 's1',
      lap: LAP,
      decision: 'disagreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
    });

    expect(outcome.state).toBe('stored');
    // Revision 4, not 1: the durable answer was established first.
    expect(saved[0]!.answerRevision).toBe(4);
  });
});

describe('P14 H5 (store half) -- an unreadable row is not an unanswered lap', () => {
  it('reports the read as PARTIAL when the repository could not decode some rows', async () => {
    const repository = {
      saveLapValidityVerdict: async () => undefined,
      listLapValidityVerdicts: async () => [],
      listLapValidityVerdictsWithDiagnostics: async () => ({ records: [], unreadableCount: 2 }),
    } as unknown as LocalSessionRepository;
    const store = createLapVerdictStore({ repository: () => repository, onError: () => undefined });

    expect(await store.refresh('s1')).toBe(true);
    const state = store.readState('s1');
    expect(state.state).toBe('partial');
    expect(state.unreadableCount).toBe(2);
  });

  it('reports a clean read as OK and a never-read session as NEVER', async () => {
    const repository = fakeRepository({});
    const store = createLapVerdictStore({ repository: () => repository, onError: () => undefined });

    expect(store.readState('s1').state).toBe('never');
    await store.refresh('s1');
    expect(store.readState('s1')).toEqual({ state: 'ok', unreadableCount: 0 });
  });

  it('reports a THROWN read as failed, never as an empty session', async () => {
    const repository = fakeRepository({ onList: () => Promise.reject(new Error('io error')) });
    const store = createLapVerdictStore({ repository: () => repository, onError: () => undefined });

    expect(await store.refresh('s1')).toBe(false);
    expect(store.readState('s1').state).toBe('failed');
    expect(store.readState('s1').detail).toContain('io error');
  });
});
