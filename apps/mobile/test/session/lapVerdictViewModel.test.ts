import { describe, expect, it } from 'vitest';
import type { LapRecord, LapValidityVerdict } from '@circuit/core';

import {
  allLapsAnswered,
  buildLapVerdictRows,
  summarizeLapVerdictRows,
  verdictControlEnabled,
  verdictTapChangedRows,
  verdictTapFeedback,
} from '../../src/session/lapVerdictViewModel';

/**
 * Ticket P13B item 1 -- the verdict control's decisions, tested where they
 * live. This repo has no React Native render harness and is not getting one,
 * so the value of these tests is exactly proportional to how little is left in
 * the JSX: everything below is a judgement the screens would otherwise have
 * been making inline and unverified.
 */

function lap(lapNumber: number, valid: boolean, reasons: string[] = []): LapRecord {
  return {
    lapNumber,
    tStart: lapNumber * 1_000,
    tEnd: lapNumber * 1_000 + 90_000,
    durationMs: 90_000 + lapNumber,
    sectorTimes: [],
    valid,
    invalidReasons: reasons,
    quality: valid ? 'good' : 'degraded',
  };
}

function verdict(overrides: Partial<LapValidityVerdict>): LapValidityVerdict {
  return {
    sessionId: 's1',
    lapNumber: 1,
    appValid: true,
    appInvalidReasons: [],
    answer: 'agreed',
    answeredAtUtc: '2026-09-22T10:00:00.000Z',
    answerRevision: 1,
    ...overrides,
  };
}

describe('P13B item 1 -- lap verdict rows', () => {
  it('gives EVERY lap a row, valid and invalid alike, with the app verdict on it', () => {
    const rows = buildLapVerdictRows([lap(1, true), lap(2, false, ['PIT_TRANSIT'])], []);
    expect(rows.map((r) => r.lapNumber)).toEqual([1, 2]);
    expect(rows[0].appValid).toBe(true);
    expect(rows[0].appInvalidReasons).toEqual([]);
    expect(rows[1].appValid).toBe(false);
    expect(rows[1].appInvalidReasons).toEqual(['PIT_TRANSIT']);
  });

  it('marks a lap nobody answered as unanswered, visibly distinct from an answered one', () => {
    const rows = buildLapVerdictRows(
      [lap(1, true), lap(2, true)],
      [verdict({ lapNumber: 1, answer: 'disagreed' })],
    );
    expect(rows[0].answered).toBe(true);
    expect(rows[0].answer).toBe('disagreed');
    expect(rows[1].answered).toBe(false);
    expect(rows[1].answer).toBe('unanswered');
    expect(rows[1].answerRevision).toBe(0);
  });

  it('sorts by lap number regardless of the order the laps arrive in', () => {
    const rows = buildLapVerdictRows([lap(3, true), lap(1, true), lap(2, true)], []);
    expect(rows.map((r) => r.lapNumber)).toEqual([1, 2, 3]);
  });

  it('flags an answer given against a DIFFERENT app verdict than the one shown now', () => {
    // He agreed while the app called lap 1 invalid; the app now calls it
    // valid. That stored answer is not an answer to the question on screen.
    const rows = buildLapVerdictRows(
      [lap(1, true)],
      [verdict({ lapNumber: 1, appValid: false, answer: 'agreed' })],
    );
    expect(rows[0].stale).toBe(true);
  });

  it('does not flag an answer that still matches the app verdict', () => {
    const rows = buildLapVerdictRows(
      [lap(1, true)],
      [verdict({ lapNumber: 1, appValid: true, answer: 'agreed' })],
    );
    expect(rows[0].stale).toBe(false);
  });

  it('drops a verdict whose lap the session no longer lists -- the screen cannot offer a button for it', () => {
    const rows = buildLapVerdictRows([lap(1, true)], [verdict({ lapNumber: 9 })]);
    expect(rows.map((r) => r.lapNumber)).toEqual([1]);
  });

  it('carries the note through when there is one', () => {
    const rows = buildLapVerdictRows([lap(1, true)], [verdict({ lapNumber: 1, note: 'spun at T3' })]);
    expect(rows[0].note).toBe('spun at T3');
  });
});

describe('P13B item 1 -- the summary the owner works against', () => {
  it('counts the rows drawn, so the figure always matches the list under it', () => {
    const rows = buildLapVerdictRows(
      [lap(1, true), lap(2, false, ['SHORT_LAP']), lap(3, true)],
      [verdict({ lapNumber: 1, answer: 'agreed' }), verdict({ lapNumber: 2, answer: 'disagreed' })],
    );
    expect(summarizeLapVerdictRows(rows)).toEqual({ agreed: 1, disagreed: 1, unanswered: 1 });
    expect(allLapsAnswered(rows)).toBe(false);
  });

  it('is complete only when every lap has an answer, and never for a session with no laps', () => {
    const rows = buildLapVerdictRows(
      [lap(1, true)],
      [verdict({ lapNumber: 1, answer: 'agreed' })],
    );
    expect(allLapsAnswered(rows)).toBe(true);
    expect(allLapsAnswered([])).toBe(false);
  });
});

describe('P13B item 1 -- a tap that did not persist never looks like one that did', () => {
  it("reports a stored write, and only a stored write, as ok", () => {
    expect(verdictTapFeedback({ state: 'stored', verdict: verdict({}) })).toEqual({
      tone: 'ok',
      key: 'saved',
    });
  });

  it('reports a FAILED write as an error, carrying the store’s own reason', () => {
    expect(
      verdictTapFeedback({ state: 'failed', verdict: verdict({}), detail: 'disk full' }),
    ).toEqual({ tone: 'error', key: 'saveFailed', detail: 'disk full' });
  });

  it('reports an UNSUPPORTED device as an error, not as a quiet no-op', () => {
    expect(verdictTapFeedback({ state: 'unsupported', verdict: null })).toEqual({
      tone: 'error',
      key: 'saveUnsupported',
    });
  });

  it('refreshes the rows for stored and failed (both reach the cache) but not for unsupported', () => {
    expect(verdictTapChangedRows({ state: 'stored', verdict: verdict({}) })).toBe(true);
    expect(verdictTapChangedRows({ state: 'failed', verdict: verdict({}) })).toBe(true);
    expect(verdictTapChangedRows({ state: 'unsupported', verdict: null })).toBe(false);
  });

  it('offers the buttons only where an answer can be kept', () => {
    expect(verdictControlEnabled('supported')).toBe(true);
    expect(verdictControlEnabled('unsupported')).toBe(false);
  });
});
