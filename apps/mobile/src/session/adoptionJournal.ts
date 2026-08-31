import type { SqlDatabase } from '@circuit/core';

/**
 * Ticket P5d-FIX3 F10 / P5d-FIX4 G1 -- the Test Loop adoption journal.
 *
 * Keeping a learned track touches durable state in several steps (a circuit
 * row, the selected circuit, a started session). A process killed in the
 * middle of that leaves a half-adopted state, and the next launch has to be
 * able to tell what landed and either finish the job or undo it.
 *
 * The journal is one additive `settings` row -- the same table the
 * active-session pointer lives in -- written BEFORE the first side effect and
 * advanced per completed step. Two rules make it safe when more than one
 * launch is alive at once (P5d-FIX4 G1):
 *
 *   * REPAIR IS A CLAIM. `claimAdoptionJournal` is a compare-and-swap on the
 *     journal's own UUID: exactly one launch wins it, and a launch that lost
 *     does nothing at all.
 *   * NOBODY CLEARS SOMEONE ELSE'S JOURNAL. `clearClaimedJournal` is a
 *     compare-and-delete against the exact row the caller claimed, so a slow
 *     launch can never wipe a journal a newer one has since written.
 *
 * The journal is cleared only after a repair fully succeeded; a failed repair
 * leaves it in place with its attempt counted, and after
 * {@link MAX_ADOPTION_REPAIR_ATTEMPTS} the app stops retrying and says so.
 */

export const ADOPTION_JOURNAL_KEY = 'testLoopAdoption';
/** After this many failed repairs the journal is abandoned, with a notice -- never retried forever. */
export const MAX_ADOPTION_REPAIR_ATTEMPTS = 3;

export type AdoptionStage =
  | 'staged'
  | 'stored'
  | 'selected'
  | 'session-started'
  | 'recording'
  | 'out-lap';

export interface AdoptionJournal {
  /** Identity of THIS adoption -- what a claim and a clear are checked against. */
  id: string;
  circuitId: string;
  stage: AdoptionStage;
  sessionId?: string;
  /** How many launches have tried to repair it. */
  attempts: number;
  /** The launch that currently owns the repair. */
  claimedBy?: string;
}

export interface ClaimedAdoptionJournal {
  journal: AdoptionJournal;
  /** The exact row value this claim wrote -- the compare half of the compare-and-delete. */
  serialized: string;
  /** True when the attempt budget is spent: the caller abandons the journal instead of repairing. */
  exhausted: boolean;
}

/** A fresh journal/launch identity. Uses the platform UUID where there is one. */
export function newJournalId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const hex = (length: number): string =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

function parse(raw: string): AdoptionJournal | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const journal = parsed as Partial<AdoptionJournal>;
    if (typeof journal.circuitId !== 'string' || typeof journal.stage !== 'string') return null;
    return {
      id: typeof journal.id === 'string' ? journal.id : newJournalId(),
      circuitId: journal.circuitId,
      stage: journal.stage,
      attempts: typeof journal.attempts === 'number' ? journal.attempts : 0,
      ...(typeof journal.sessionId === 'string' ? { sessionId: journal.sessionId } : {}),
      ...(typeof journal.claimedBy === 'string' ? { claimedBy: journal.claimedBy } : {}),
    };
  } catch {
    return null;
  }
}

/** Writes (or overwrites) the journal for the adoption in progress, returning the row it wrote. */
export async function writeAdoptionJournal(
  db: SqlDatabase,
  journal: AdoptionJournal,
): Promise<ClaimedAdoptionJournal> {
  const serialized = JSON.stringify(journal);
  await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
    ADOPTION_JOURNAL_KEY,
    serialized,
  ]);
  // P5d-FIX5 H1: the caller keeps the EXACT row it wrote, so it can later
  // clear that row and only that row (compare-and-delete) instead of deleting
  // whatever journal happens to occupy the key by then.
  return { journal, serialized, exhausted: false };
}

/** The journal as stored, or `null` when there is none (or it is unreadable). */
export async function readAdoptionJournal(db: SqlDatabase): Promise<AdoptionJournal | null> {
  const rows = await db.getAllAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ? LIMIT 1',
    [ADOPTION_JOURNAL_KEY],
  );
  const raw = rows[0]?.value;
  return raw === undefined ? null : parse(raw);
}

/**
 * Claims the journal for `launchId` -- a compare-and-swap against the exact row
 * that was read, so exactly one concurrent launch wins it. Returns `null` when
 * there is nothing to repair or another launch got there first.
 */
export async function claimAdoptionJournal(
  db: SqlDatabase,
  launchId: string,
): Promise<ClaimedAdoptionJournal | null> {
  const rows = await db.getAllAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ? LIMIT 1',
    [ADOPTION_JOURNAL_KEY],
  );
  const raw = rows[0]?.value;
  if (raw === undefined) return null;
  const journal = parse(raw);
  if (journal === null) return null;

  const claimed: AdoptionJournal = {
    ...journal,
    attempts: journal.attempts + 1,
    claimedBy: launchId,
  };
  const serialized = JSON.stringify(claimed);
  const result = await db.runAsync(
    'UPDATE settings SET value = ? WHERE key = ? AND value = ?',
    [serialized, ADOPTION_JOURNAL_KEY, raw],
  );
  if (result.changes === 0) return null;
  return { journal: claimed, serialized, exhausted: claimed.attempts > MAX_ADOPTION_REPAIR_ATTEMPTS };
}

/**
 * Clears the journal this caller claimed -- and ONLY that one. Returns `false`
 * when the row has changed since (a newer adoption is in progress), leaving it
 * untouched.
 */
export async function clearClaimedJournal(
  db: SqlDatabase,
  claimed: ClaimedAdoptionJournal,
): Promise<boolean> {
  const result = await db.runAsync('DELETE FROM settings WHERE key = ? AND value = ?', [
    ADOPTION_JOURNAL_KEY,
    claimed.serialized,
  ]);
  return result.changes > 0;
}

/**
 * P5d-FIX4 G3: removes an orphan session outright -- its row, its laps, its
 * checkpoint and both kinds of telemetry -- in ONE transaction.
 *
* The previous rollback marked the checkpoint `sessionComplete`, which left a
 * session in the database that nobody ever drove: invisible on the selected
 * circuit's history, but real, and countable by anything that looks at the
 * table. A session whose geometry never landed is not a session.
 *
 * P5d-FIX5 M2: the active-session POINTER rows go in the same transaction --
 * they are part of the same fact ("this session exists"), and clearing them
 * separately afterwards left a window in which the pointer named a session
 * that had already been deleted. They are cleared only when the pointer
 * actually names THIS session; a pointer to some other session is untouched.
 */
export const ACTIVE_SESSION_SETTINGS_KEYS = [
  'activeSessionId',
  'activeSessionCircuitId',
  'activeSessionStartedAtUtc',
] as const;

export async function deleteOrphanSession(db: SqlDatabase, sessionId: string): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM telemetry WHERE sessionId = ?', [sessionId]);
    await db.runAsync('DELETE FROM laps WHERE sessionId = ?', [sessionId]);
    await db.runAsync('DELETE FROM checkpoints WHERE sessionId = ?', [sessionId]);
    await db.runAsync('DELETE FROM sessions WHERE sessionId = ?', [sessionId]);
    await db.runAsync('DELETE FROM telemetry_samples WHERE session_id = ?', [sessionId]);

    const pointer = await db.getAllAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ? LIMIT 1',
      [ACTIVE_SESSION_SETTINGS_KEYS[0]],
    );
    if (pointer[0]?.value === sessionId) {
      for (const key of ACTIVE_SESSION_SETTINGS_KEYS) {
        await db.runAsync('DELETE FROM settings WHERE key = ?', [key]);
      }
    }
  });
}
