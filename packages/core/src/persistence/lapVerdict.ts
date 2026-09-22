import type { LapRecord, LapValidityVerdict, LapVerdictAnswer } from '../contracts';

/**
 * Ticket P12 item A -- THE PURE RULES BEHIND THE OWNER'S LAP VERDICTS.
 *
 * `LocalSessionRepository` stores the rows; this module decides what a row
 * should contain and how a session's laps and its stored rows combine into the
 * per-lap picture every screen and every export reads. Kept apart from the
 * repositories so both of them, and the report builder, share ONE definition
 * of "unanswered" rather than three.
 */

/** An answer the owner can give. `'unanswered'` is never given -- it is the absence of one. */
export type LapVerdictDecision = 'agreed' | 'disagreed';

export interface RecordLapVerdictInput {
  sessionId: string;
  /** The lap being judged -- the app's verdict is snapshotted from it, never re-read later. */
  lap: Pick<LapRecord, 'lapNumber' | 'valid' | 'invalidReasons'>;
  /** Did the owner agree with the app's verdict on this lap? */
  decision: LapVerdictDecision;
  /** ISO-8601 UTC, injected. Nothing here reads a clock. */
  answeredAtUtc: string;
  /** Anything the owner typed. An empty/whitespace-only string is treated as no note. */
  note?: string;
  /** The row already stored for this lap, when there is one -- its revision is what gets bumped. */
  previous?: LapValidityVerdict | null;
}

/**
 * The row to store for one answer.
 *
 * A re-answer does not replace history silently: `answerRevision` counts the
 * answers this lap has had, so an export shows "answered twice" rather than
 * presenting the second answer as if it had always been the first. The app's
 * own verdict is re-snapshotted on every answer, because what the owner just
 * agreed or disagreed WITH is the verdict as it stands now.
 */
export function recordLapVerdict(input: RecordLapVerdictInput): LapValidityVerdict {
  const previousRevision = input.previous?.answerRevision ?? 0;
  const note = input.note?.trim();
  return {
    sessionId: input.sessionId,
    lapNumber: input.lap.lapNumber,
    appValid: input.lap.valid,
    appInvalidReasons: [...input.lap.invalidReasons],
    answer: input.decision,
    answeredAtUtc: input.answeredAtUtc,
    // Monotonic: a stored row that somehow carries a higher revision than the
    // count we are about to write is never rolled back.
    answerRevision: Math.max(previousRevision + 1, 1),
    ...(note === undefined || note.length === 0 ? {} : { note }),
  };
}

/** The verdict row a lap NOBODY has answered is represented by. Never stored -- synthesized on read. */
export function unansweredLapVerdict(
  sessionId: string,
  lap: Pick<LapRecord, 'lapNumber' | 'valid' | 'invalidReasons'>,
): LapValidityVerdict {
  return {
    sessionId,
    lapNumber: lap.lapNumber,
    appValid: lap.valid,
    appInvalidReasons: [...lap.invalidReasons],
    answer: 'unanswered',
    answeredAtUtc: null,
    answerRevision: 0,
  };
}

/**
 * ONE ENTRY PER LAP -- the shape every reader wants and none of them should
 * have to assemble.
 *
 * Stored rows win for the laps they name; every other lap of the session gets
 * a synthesized `'unanswered'` entry carrying the app's current verdict. That
 * is what keeps "he never got to this lap" visible as a fact instead of as a
 * missing array element, which a consumer would be free to read as agreement.
 *
 * A stored row for a lap the session no longer has (a lap list rewritten by a
 * later save) is kept and flagged by its own `lapNumber` being absent from
 * `laps` -- dropping it would delete a real answer the owner gave.
 */
export function mergeLapValidityVerdicts(
  sessionId: string,
  laps: readonly Pick<LapRecord, 'lapNumber' | 'valid' | 'invalidReasons'>[],
  stored: readonly LapValidityVerdict[],
): LapValidityVerdict[] {
  const byLap = new Map<number, LapValidityVerdict>();
  for (const row of stored) {
    if (row.sessionId !== sessionId) continue;
    byLap.set(row.lapNumber, row);
  }
  const merged: LapValidityVerdict[] = [];
  const seen = new Set<number>();
  for (const lap of laps) {
    if (seen.has(lap.lapNumber)) continue;
    seen.add(lap.lapNumber);
    merged.push(byLap.get(lap.lapNumber) ?? unansweredLapVerdict(sessionId, lap));
  }
  for (const [lapNumber, row] of byLap) {
    if (!seen.has(lapNumber)) merged.push(row);
  }
  return merged.sort((a, b) => a.lapNumber - b.lapNumber);
}

/** How many laps fall into each answer bucket. The one-line honesty check on a session's verdict coverage. */
export function summarizeLapVerdicts(
  verdicts: readonly LapValidityVerdict[],
): Record<LapVerdictAnswer, number> {
  const counts: Record<LapVerdictAnswer, number> = { agreed: 0, disagreed: 0, unanswered: 0 };
  for (const verdict of verdicts) counts[verdict.answer] += 1;
  return counts;
}
