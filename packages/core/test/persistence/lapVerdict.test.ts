import { describe, expect, it } from 'vitest';

import type { LapRecord } from '../../src/contracts';
import {
  mergeLapValidityVerdicts,
  recordLapVerdict,
  summarizeLapVerdicts,
  unansweredLapVerdict,
} from '../../src/persistence';

import { makeLapRecord, makeLapVerdict } from './fixtures';

/**
 * Ticket P12 item A -- the rules behind "did the app get this lap right?".
 *
 * The one thing this data must never do is let an UNANSWERED lap be read as
 * agreement: the whole point of build 12 is to find out whether the app's
 * invalid-lap rules are any good, and a lap nobody judged is evidence of
 * nothing.
 */

const laps: LapRecord[] = [
  makeLapRecord({ lapNumber: 1, valid: true, invalidReasons: [] }),
  makeLapRecord({ lapNumber: 2, valid: false, invalidReasons: ['PIT_TRANSIT'] }),
  makeLapRecord({ lapNumber: 3, valid: false, invalidReasons: ['PIT_AMBIGUOUS', 'SHORT_LAP'] }),
];

describe('recordLapVerdict', () => {
  it('snapshots the app verdict it is an answer to', () => {
    const verdict = recordLapVerdict({
      sessionId: 's1',
      lap: laps[1]!,
      decision: 'disagreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
    });
    expect(verdict).toEqual({
      sessionId: 's1',
      lapNumber: 2,
      appValid: false,
      appInvalidReasons: ['PIT_TRANSIT'],
      answer: 'disagreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
      answerRevision: 1,
    });
  });

  it('keeps the reasons array from aliasing the lap record', () => {
    const lap = makeLapRecord({ lapNumber: 4, valid: false, invalidReasons: ['LOW_QUALITY'] });
    const verdict = recordLapVerdict({
      sessionId: 's1',
      lap,
      decision: 'agreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
    });
    lap.invalidReasons.push('MUTATED');
    expect(verdict.appInvalidReasons).toEqual(['LOW_QUALITY']);
  });

  it('bumps the revision on a re-answer, so a changed mind is traceable', () => {
    const first = recordLapVerdict({
      sessionId: 's1',
      lap: laps[0]!,
      decision: 'agreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
    });
    const second = recordLapVerdict({
      sessionId: 's1',
      lap: laps[0]!,
      decision: 'disagreed',
      answeredAtUtc: '2026-09-22T10:05:00.000Z',
      previous: first,
    });
    expect(first.answerRevision).toBe(1);
    expect(second.answerRevision).toBe(2);
    expect(second.answer).toBe('disagreed');
    expect(second.answeredAtUtc).toBe('2026-09-22T10:05:00.000Z');
  });

  it('keeps a note when there is one, and omits the field when there is not', () => {
    const withNote = recordLapVerdict({
      sessionId: 's1',
      lap: laps[0]!,
      decision: 'agreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
      note: '  traffic on the back straight  ',
    });
    expect(withNote.note).toBe('traffic on the back straight');

    const blank = recordLapVerdict({
      sessionId: 's1',
      lap: laps[0]!,
      decision: 'agreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
      note: '   ',
    });
    expect('note' in blank).toBe(false);
  });
});

describe('unansweredLapVerdict', () => {
  it('is distinguishable from every answer', () => {
    const verdict = unansweredLapVerdict('s1', laps[2]!);
    expect(verdict.answer).toBe('unanswered');
    expect(verdict.answeredAtUtc).toBeNull();
    expect(verdict.answerRevision).toBe(0);
    expect(verdict.appInvalidReasons).toEqual(['PIT_AMBIGUOUS', 'SHORT_LAP']);
  });
});

describe('mergeLapValidityVerdicts', () => {
  it('gives every lap an entry -- answered ones stored, the rest explicitly unanswered', () => {
    const stored = [makeLapVerdict({ sessionId: 's1', lapNumber: 2, answer: 'disagreed' })];
    const merged = mergeLapValidityVerdicts('s1', laps, stored);
    expect(merged.map((v) => [v.lapNumber, v.answer])).toEqual([
      [1, 'unanswered'],
      [2, 'disagreed'],
      [3, 'unanswered'],
    ]);
  });

  it('ignores rows belonging to another session', () => {
    const stored = [makeLapVerdict({ sessionId: 'other', lapNumber: 1, answer: 'agreed' })];
    const merged = mergeLapValidityVerdicts('s1', laps, stored);
    expect(merged[0]!.answer).toBe('unanswered');
  });

  it('keeps an answer for a lap the session no longer lists -- never deletes a real answer', () => {
    const stored = [makeLapVerdict({ sessionId: 's1', lapNumber: 9, answer: 'agreed' })];
    const merged = mergeLapValidityVerdicts('s1', laps, stored);
    expect(merged.map((v) => v.lapNumber)).toEqual([1, 2, 3, 9]);
  });

  it('is empty for a session that completed no lap and was never answered', () => {
    expect(mergeLapValidityVerdicts('s1', [], [])).toEqual([]);
  });
});

describe('summarizeLapVerdicts', () => {
  it('counts all three buckets, including the laps nobody got to', () => {
    const merged = mergeLapValidityVerdicts('s1', laps, [
      makeLapVerdict({ sessionId: 's1', lapNumber: 1, answer: 'agreed' }),
      makeLapVerdict({ sessionId: 's1', lapNumber: 2, answer: 'disagreed' }),
    ]);
    expect(summarizeLapVerdicts(merged)).toEqual({ agreed: 1, disagreed: 1, unanswered: 1 });
  });
});
