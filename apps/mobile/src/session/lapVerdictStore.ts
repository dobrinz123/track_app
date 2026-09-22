import {
  mergeLapValidityVerdicts,
  recordLapVerdict,
  summarizeLapVerdicts,
  type LapRecord,
  type LapValidityVerdict,
  type LapVerdictAnswer,
  type LapVerdictDecision,
  type LocalSessionRepository,
} from '@circuit/core';

/**
 * Ticket P12 item A (binding) -- THE OWNER'S VERDICT ON THE APP'S VERDICT.
 *
 * `LapRecord.valid` / `invalidReasons` are produced by rules nobody has ever
 * checked on a real circuit. Build 12 exists to check them: the owner drives
 * MotorPark on Monday and says, per lap, whether the app got it right. This
 * store is where that answer is kept.
 *
 * Shaped like `SqlSessionHistoryStore`: the reads are SYNCHRONOUS against an
 * in-memory cache, because the screens that will show these call them during
 * render, and the writes are async and go straight through to the repository.
 *
 * TICKET P14 H1 + MEDIUM (Codex P13 round) -- TWO RULES CHANGED HERE.
 *
 *  1. THE DURABLE CACHE IS UPDATED ONLY AFTER STORAGE SUCCEEDS. The old code
 *     cached the verdict BEFORE awaiting the write and never took it back out,
 *     so a rejected save returned `'failed'` while `stored()` returned
 *     `'agreed'` -- the owner's screen kept showing the answer, the next tap
 *     cleared the error note under it, and the export counted a lap he had not
 *     recorded as agreement with the app. The tap still shows immediately,
 *     but through {@link LapVerdictStore.unsaved}, which is a DIFFERENT
 *     question from "what is recorded" and answered separately.
 *
 *  2. READS AND WRITES FOR ONE SESSION ARE SERIALISED. The old code let a
 *     refresh that started before an answer resolve after it and replace the
 *     cache with its stale result, erasing the answer and restarting the
 *     revision count at 1. Screens allow taps before a refresh completes, so
 *     ordering them is the fix; the per-session chain below is the whole of
 *     it, and it is also what establishes the DURABLE previous revision
 *     before a replacement answer is built.
 *
 * NO UI LIVES HERE. `recordVerdict()` is the function a screen calls.
 */

/** Whether this device can store verdicts at all. `'unsupported'` is never `'none recorded'`. */
export type LapVerdictSupport = 'supported' | 'unsupported';

export interface RecordVerdictOutcome {
  /** `'stored'`, `'failed'` (the write threw -- the answer is in memory only), or `'unsupported'`. */
  state: 'stored' | 'failed' | 'unsupported';
  /** The verdict as recorded, or `null` when the store could not express one. */
  verdict: LapValidityVerdict | null;
  /** Why, when `state` is `'failed'`. */
  detail?: string;
}

/**
 * Ticket P14 H1: an answer the owner gave that STORAGE DOES NOT HOLD.
 *
 * `'pending'` while its write is in flight, `'failed'` once it threw. Neither
 * is an answer for counting purposes -- {@link LapVerdictStore.summary} and
 * the export ignore both -- but neither is thrown away either: the screen
 * keeps drawing it, marked as not saved, so the owner can see what he tapped
 * and that it did not stick.
 */
export interface UnsavedLapVerdict {
  verdict: LapValidityVerdict;
  state: 'pending' | 'failed';
  /** The storage error, for `'failed'`. */
  detail?: string;
}

/**
 * Ticket P14 H5 (store half): what this store actually knows about one
 * session's stored answers.
 *
 *  - `'never'`   -- nobody has read them in this process. `stored()` being
 *                   empty says nothing at all.
 *  - `'ok'`      -- read, complete.
 *  - `'partial'` -- read, but `unreadableCount` rows in storage could not be
 *                   decoded. Those laps are NOT unanswered; they are unreadable.
 *  - `'failed'`  -- the read threw. `stored()` holds whatever it held before.
 */
export interface LapVerdictReadState {
  state: 'never' | 'ok' | 'partial' | 'failed';
  /** Stored rows this device could not decode. `0` unless `state` is `'partial'`. */
  unreadableCount: number;
  /** Why, for `'failed'`. */
  detail?: string;
}

export interface LapVerdictStore {
  /** Can this device store verdicts? Decided by the repository, read on demand so it is correct after bootstrap. */
  support(): LapVerdictSupport;
  /** Loads one session's stored verdicts into the cache. Never throws: a failed read leaves the cache as it was and resolves `false`. */
  refresh(sessionId: string): Promise<boolean>;
  /** The DURABLE rows for one session, from the cache -- what storage holds, never what a screen hoped it would. */
  stored(sessionId: string): readonly LapValidityVerdict[];
  /** Ticket P14 H1: answers given but NOT on disk -- in flight, or failed. Never counted as answers. */
  unsaved(sessionId: string): readonly UnsavedLapVerdict[];
  /** Ticket P14 H5: what this store knows about the stored answers -- and, crucially, what it does not. */
  readState(sessionId: string): LapVerdictReadState;
  /** ONE ENTRY PER LAP: stored answers plus an explicit `'unanswered'` for every lap nobody got to. */
  forSession(
    sessionId: string,
    laps: readonly Pick<LapRecord, 'lapNumber' | 'valid' | 'invalidReasons'>[],
  ): LapValidityVerdict[];
  /** How many laps of this session fall into each bucket. Counts DURABLE answers only. */
  summary(
    sessionId: string,
    laps: readonly Pick<LapRecord, 'lapNumber' | 'valid' | 'invalidReasons'>[],
  ): Record<LapVerdictAnswer, number>;
  /** Records the owner's answer for one lap. The screen's one call. */
  recordVerdict(input: {
    sessionId: string;
    lap: Pick<LapRecord, 'lapNumber' | 'valid' | 'invalidReasons'>;
    decision: LapVerdictDecision;
    note?: string;
    /** Injected so tests are deterministic; defaults to now. */
    answeredAtUtc?: string;
  }): Promise<RecordVerdictOutcome>;
}

export interface LapVerdictStoreDeps {
  /**
   * Read on demand rather than captured, so a store built before bootstrap
   * (composition constructs its singletons eagerly) still reaches the real
   * repository once there is one.
   */
  repository: () => LocalSessionRepository | null;
  /** Where a failed write is reported. Defaults to `console.warn`. */
  onError?: (message: string, error: unknown) => void;
}

export function createLapVerdictStore(deps: LapVerdictStoreDeps): LapVerdictStore {
  /** DURABLE rows only: everything here is known to be on disk. */
  const cache = new Map<string, LapValidityVerdict[]>();
  /** Ticket P14 H1: answers that are not (yet, or ever) on disk, by session and lap. */
  const unsavedRows = new Map<string, Map<number, UnsavedLapVerdict>>();
  const readStates = new Map<string, LapVerdictReadState>();
  /**
   * Ticket P14 MEDIUM: one chain per session. Every refresh and every write
   * for a session runs in the order it was requested, which is what makes a
   * stale read incapable of overwriting a newer answer and what lets a
   * replacement answer see the durable previous one.
   */
  const chains = new Map<string, Promise<void>>();
  const onError =
    deps.onError ?? ((message: string, error: unknown) => console.warn(`[lapVerdictStore] ${message}`, error));

  function repo(): LocalSessionRepository | null {
    return deps.repository();
  }

  /** Runs `work` after everything already queued for this session. Never rejects the chain. */
  function enqueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const result = previous.then(work);
    chains.set(
      sessionId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  function putDurable(sessionId: string, verdict: LapValidityVerdict): void {
    const rows = [...(cache.get(sessionId) ?? [])].filter((row) => row.lapNumber !== verdict.lapNumber);
    rows.push(verdict);
    rows.sort((a, b) => a.lapNumber - b.lapNumber);
    cache.set(sessionId, rows);
  }

  function putUnsaved(sessionId: string, entry: UnsavedLapVerdict): void {
    const rows = unsavedRows.get(sessionId) ?? new Map<number, UnsavedLapVerdict>();
    rows.set(entry.verdict.lapNumber, entry);
    unsavedRows.set(sessionId, rows);
  }

  function clearUnsaved(sessionId: string, lapNumber: number): void {
    const rows = unsavedRows.get(sessionId);
    if (rows === undefined) return;
    rows.delete(lapNumber);
    if (rows.size === 0) unsavedRows.delete(sessionId);
  }

  return {
    support(): LapVerdictSupport {
      const repository = repo();
      return repository?.saveLapValidityVerdict === undefined ? 'unsupported' : 'supported';
    },

    async refresh(sessionId: string): Promise<boolean> {
      const repository = repo();
      if (repository?.listLapValidityVerdicts === undefined) return false;
      // Ticket P14 MEDIUM: queued behind any write already in flight, so its
      // result can never be older than the cache it replaces.
      return enqueue(sessionId, async () => {
        try {
          // Ticket P14 H5: the diagnostic read where the repository offers
          // one -- so a table of unreadable rows is reported as PARTIAL
          // rather than as a session nobody answered.
          const diagnostics = repository.listLapValidityVerdictsWithDiagnostics;
          const read =
            diagnostics === undefined
              ? { records: await repository.listLapValidityVerdicts!(sessionId), unreadableCount: 0 }
              : await diagnostics.call(repository, sessionId);
          cache.set(sessionId, [...read.records].sort((a, b) => a.lapNumber - b.lapNumber));
          readStates.set(sessionId, {
            state: read.unreadableCount > 0 ? 'partial' : 'ok',
            unreadableCount: read.unreadableCount,
            ...(read.unreadableCount > 0
              ? {
                  detail: `${String(read.unreadableCount)} stored verdict row(s) could not be decoded on this device`,
                }
              : {}),
          });
          return true;
        } catch (error) {
          onError(`could not read lap verdicts for session ${sessionId}`, error);
          // The cache is left EXACTLY as it was: a failed read is not evidence
          // that the answers are gone.
          readStates.set(sessionId, {
            state: 'failed',
            unreadableCount: 0,
            detail: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      });
    },

    stored(sessionId: string): readonly LapValidityVerdict[] {
      return cache.get(sessionId) ?? [];
    },

    unsaved(sessionId: string): readonly UnsavedLapVerdict[] {
      return [...(unsavedRows.get(sessionId)?.values() ?? [])].sort(
        (a, b) => a.verdict.lapNumber - b.verdict.lapNumber,
      );
    },

    readState(sessionId: string): LapVerdictReadState {
      return readStates.get(sessionId) ?? { state: 'never', unreadableCount: 0 };
    },

    forSession(sessionId, laps): LapValidityVerdict[] {
      return mergeLapValidityVerdicts(sessionId, laps, cache.get(sessionId) ?? []);
    },

    summary(sessionId, laps): Record<LapVerdictAnswer, number> {
      return summarizeLapVerdicts(mergeLapValidityVerdicts(sessionId, laps, cache.get(sessionId) ?? []));
    },

    recordVerdict(input): Promise<RecordVerdictOutcome> {
      const repository = repo();
      if (repository?.saveLapValidityVerdict === undefined) {
        // Deliberately NOT cached anywhere: an answer this device cannot store
        // must not read back afterwards as though it had been, which is
        // exactly the "a false from the side log meant calibrated" mistake
        // P10A H6 was written to undo.
        return Promise.resolve({ state: 'unsupported', verdict: null });
      }
      // Ticket P14 MEDIUM: behind the session's chain, so a refresh started
      // earlier has finished and the durable previous revision below is the
      // real one.
      return enqueue(input.sessionId, async () => {
        const durable = repository.listLapValidityVerdicts;
        // Ticket P14 MEDIUM ("establish the durable previous revision before
        // replacing an answer"): where nothing has been read yet, read now.
        // A revision that restarts at 1 turns a changed mind into a first
        // answer, which is a claim about the owner nobody made.
        if (!cache.has(input.sessionId) && durable !== undefined) {
          try {
            const rows = await durable.call(repository, input.sessionId);
            cache.set(input.sessionId, [...rows].sort((a, b) => a.lapNumber - b.lapNumber));
            readStates.set(input.sessionId, { state: 'ok', unreadableCount: 0 });
          } catch (error) {
            // Recorded, not fatal: the answer is still worth writing. The
            // revision it carries may be lower than the durable one, and
            // `readState` says the store could not check.
            onError(`could not establish the stored verdict for session ${input.sessionId}`, error);
            readStates.set(input.sessionId, {
              state: 'failed',
              unreadableCount: 0,
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const previous = (cache.get(input.sessionId) ?? []).find(
          (row) => row.lapNumber === input.lap.lapNumber,
        );
        const verdict = recordLapVerdict({
          sessionId: input.sessionId,
          lap: input.lap,
          decision: input.decision,
          answeredAtUtc: input.answeredAtUtc ?? new Date().toISOString(),
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(previous === undefined ? {} : { previous }),
        });
        // Shown immediately -- but as an UNSAVED answer, which is what it is
        // until the write resolves.
        putUnsaved(input.sessionId, { verdict, state: 'pending' });
        try {
          await repository.saveLapValidityVerdict!(verdict);
          // ONLY NOW. The durable cache is a statement about storage.
          putDurable(input.sessionId, verdict);
          clearUnsaved(input.sessionId, input.lap.lapNumber);
          return { state: 'stored', verdict } satisfies RecordVerdictOutcome;
        } catch (error) {
          onError(
            `could not store the lap verdict for session ${input.sessionId} lap ${String(input.lap.lapNumber)}`,
            error,
          );
          const detail = error instanceof Error ? error.message : String(error);
          putUnsaved(input.sessionId, { verdict, state: 'failed', detail });
          return { state: 'failed', verdict, detail } satisfies RecordVerdictOutcome;
        }
      });
    },
  };
}
