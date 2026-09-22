import type { LapRecord, LapValidityVerdict, LapVerdictAnswer } from '@circuit/core';

import type { RecordVerdictOutcome, UnsavedLapVerdict } from './lapVerdictStore';

/**
 * Ticket P13B item 1 (binding) -- EVERY DECISION THE VERDICT CONTROL MAKES,
 * as pure functions.
 *
 * This repo has no React Native render harness and is not getting one, so the
 * JSX that draws the control is kept to markup and every judgement it depends
 * on lives here, where vitest can execute it:
 *
 *  - which row is answered and which is still outstanding (the owner has to
 *    see, at a glance in a paddock, what he has not done yet);
 *  - whether a stored answer still refers to the verdict the app gives NOW;
 *  - whether the two buttons may be offered at all on this device;
 *  - what a tap is reported as -- and specifically that a tap which did NOT
 *    reach storage is never reported like one that did. That is the whole
 *    value of `RecordVerdictOutcome` having three states instead of a boolean,
 *    and a screen that collapses them is a screen that tells the owner his
 *    answer was kept when it was not.
 *
 * No language lives here either: the strings are `lapVerdictStrings.ts`'s.
 */

/** One lap's row in the verdict list. */
export interface LapVerdictRowModel {
  lapNumber: number;
  durationMs: number;
  /** The app's CURRENT call on this lap. */
  appValid: boolean;
  /** The app's CURRENT reasons, empty for a valid lap. */
  appInvalidReasons: string[];
  /** `'agreed'` = the app was right, `'disagreed'` = the app was wrong, `'unanswered'` = he has not got to it. */
  answer: LapVerdictAnswer;
  /** Convenience for the "looks visibly different" rule. */
  answered: boolean;
  /** 0 before any answer; 2 or more once he has changed his mind. */
  answerRevision: number;
  /** When he answered, or `null`. */
  answeredAtUtc: string | null;
  /**
   * TRUE when the answer was given against a DIFFERENT app verdict than the
   * one shown now (the stored row snapshots `appValid` at answer time). An
   * answer to a question that has since changed is not an answer to this
   * question, and the row says so rather than presenting it as current.
   */
  stale: boolean;
  note?: string;
  /**
   * Ticket P14 H1 (Codex P13 round): an answer the owner gave for this lap
   * that STORAGE DOES NOT HOLD -- its write is in flight, or it failed.
   *
   * It is deliberately NOT folded into `answer`/`answered`: those describe
   * what is recorded, and the old store's habit of caching before the write
   * resolved is precisely how a failed save came to read back as an answer.
   * The row carries it separately so the screen can keep showing what he
   * tapped, marked as not saved, for as long as it is not saved -- rather than
   * on a note under the buttons that the next tap wipes away.
   */
  unsavedAnswer?: { answer: LapVerdictAnswer; state: 'pending' | 'failed'; detail?: string };
}

/**
 * Joins the session's laps to the merged verdict list.
 *
 * `getLapVerdicts()` already returns ONE ENTRY PER LAP with an explicit
 * `'unanswered'`, so this is a join and not a merge -- but a verdict whose lap
 * the session no longer lists is dropped here rather than drawn as a row with
 * no lap behind it. The export keeps it (see `sessionReport.ts`); the screen
 * cannot offer a button for a lap that is not on it.
 */
export function buildLapVerdictRows(
  laps: readonly LapRecord[],
  verdicts: readonly LapValidityVerdict[],
  /** Ticket P14 H1: answers not on disk, from `LapVerdictStore.unsaved()`. Omitted means none. */
  unsaved: readonly UnsavedLapVerdict[] = [],
): LapVerdictRowModel[] {
  const byLap = new Map(verdicts.map((verdict) => [verdict.lapNumber, verdict]));
  const unsavedByLap = new Map(unsaved.map((entry) => [entry.verdict.lapNumber, entry]));
  return [...laps]
    .sort((a, b) => a.lapNumber - b.lapNumber)
    .map((lap) => {
      const verdict = byLap.get(lap.lapNumber);
      const answer: LapVerdictAnswer = verdict?.answer ?? 'unanswered';
      const answered = answer !== 'unanswered';
      return {
        lapNumber: lap.lapNumber,
        durationMs: lap.durationMs,
        appValid: lap.valid,
        appInvalidReasons: [...lap.invalidReasons],
        answer,
        answered,
        answerRevision: verdict?.answerRevision ?? 0,
        answeredAtUtc: verdict?.answeredAtUtc ?? null,
        stale: answered && verdict !== undefined && verdict.appValid !== lap.valid,
        ...(verdict?.note === undefined ? {} : { note: verdict.note }),
        ...(unsavedByLap.has(lap.lapNumber)
          ? {
              unsavedAnswer: {
                answer: unsavedByLap.get(lap.lapNumber)!.verdict.answer,
                state: unsavedByLap.get(lap.lapNumber)!.state,
                ...(unsavedByLap.get(lap.lapNumber)!.detail === undefined
                  ? {}
                  : { detail: unsavedByLap.get(lap.lapNumber)!.detail }),
              },
            }
          : {}),
      };
    });
}

/** How many rows fall into each bucket. Counts the ROWS drawn, so it always matches the list under it. */
export function summarizeLapVerdictRows(
  rows: readonly LapVerdictRowModel[],
): Record<LapVerdictAnswer, number> {
  const counts: Record<LapVerdictAnswer, number> = { agreed: 0, disagreed: 0, unanswered: 0 };
  for (const row of rows) counts[row.answer] += 1;
  return counts;
}

/** True once every lap has an answer -- the state the owner is working towards. */
export function allLapsAnswered(rows: readonly LapVerdictRowModel[]): boolean {
  return rows.length > 0 && rows.every((row) => row.answered);
}

/**
 * The tap's outcome, as the screen must present it.
 *
 * `tone` is the honesty field. `'ok'` is reserved for `'stored'` -- an answer
 * that is on disk. A write that threw leaves the answer in memory only and a
 * device that cannot store answers never took it at all; both are `'error'`,
 * both are loud, and NEITHER is allowed to read as saved.
 */
export interface VerdictTapFeedback {
  tone: 'ok' | 'error';
  /** Which string of `LapVerdictStrings` the screen renders. */
  key: 'saved' | 'saveFailed' | 'saveUnsupported';
  /** The store's own message for a failure, when it gave one. Logged/appended, never swallowed. */
  detail?: string;
}

export function verdictTapFeedback(outcome: RecordVerdictOutcome): VerdictTapFeedback {
  switch (outcome.state) {
    case 'stored':
      return { tone: 'ok', key: 'saved' };
    case 'unsupported':
      return { tone: 'error', key: 'saveUnsupported' };
    case 'failed':
      return {
        tone: 'error',
        key: 'saveFailed',
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      };
  }
}

/**
 * Should the optimistic row update be applied?
 *
 * Ticket P14 H1 RE-READ THIS. It is still `'stored'` and `'failed'`, but they
 * now change DIFFERENT parts of the row: `'stored'` changes the answer,
 * `'failed'` changes only `unsavedAnswer`. `'unsupported'` records nothing
 * anywhere, and a row that flipped anyway would be the screen inventing an
 * answer the device cannot hold.
 */
export function verdictTapChangedRows(outcome: RecordVerdictOutcome): boolean {
  return outcome.state !== 'unsupported';
}

/** The buttons are offered only where an answer can actually be kept. */
export function verdictControlEnabled(support: 'supported' | 'unsupported'): boolean {
  return support === 'supported';
}
