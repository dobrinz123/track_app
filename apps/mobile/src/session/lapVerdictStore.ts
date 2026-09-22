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
 * A write updates the cache BEFORE it awaits storage, so the screen reflects
 * the tap immediately and a storage failure is reported rather than silently
 * reverting under the owner's finger -- he is standing in a paddock, and a
 * button that appears to do nothing is how answers stop being given.
 *
 * NO UI LIVES HERE. `recordVerdict()` is the function a screen calls; building
 * that screen belongs to the next worker.
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

export interface LapVerdictStore {
  /** Can this device store verdicts? Decided by the repository, read on demand so it is correct after bootstrap. */
  support(): LapVerdictSupport;
  /** Loads one session's stored verdicts into the cache. Never throws: a failed read leaves the cache as it was and resolves `false`. */
  refresh(sessionId: string): Promise<boolean>;
  /** The stored rows for one session, from the cache. Laps with no answer are simply absent -- see {@link forSession}. */
  stored(sessionId: string): readonly LapValidityVerdict[];
  /** ONE ENTRY PER LAP: stored answers plus an explicit `'unanswered'` for every lap nobody got to. */
  forSession(
    sessionId: string,
    laps: readonly Pick<LapRecord, 'lapNumber' | 'valid' | 'invalidReasons'>[],
  ): LapValidityVerdict[];
  /** How many laps of this session fall into each bucket. */
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
  const cache = new Map<string, LapValidityVerdict[]>();
  const onError =
    deps.onError ?? ((message: string, error: unknown) => console.warn(`[lapVerdictStore] ${message}`, error));

  function repo(): LocalSessionRepository | null {
    return deps.repository();
  }

  function put(sessionId: string, verdict: LapValidityVerdict): void {
    const rows = [...(cache.get(sessionId) ?? [])].filter((row) => row.lapNumber !== verdict.lapNumber);
    rows.push(verdict);
    rows.sort((a, b) => a.lapNumber - b.lapNumber);
    cache.set(sessionId, rows);
  }

  return {
    support(): LapVerdictSupport {
      const repository = repo();
      return repository?.saveLapValidityVerdict === undefined ? 'unsupported' : 'supported';
    },

    async refresh(sessionId: string): Promise<boolean> {
      const repository = repo();
      if (repository?.listLapValidityVerdicts === undefined) return false;
      try {
        const rows = await repository.listLapValidityVerdicts(sessionId);
        cache.set(sessionId, [...rows].sort((a, b) => a.lapNumber - b.lapNumber));
        return true;
      } catch (error) {
        onError(`could not read lap verdicts for session ${sessionId}`, error);
        return false;
      }
    },

    stored(sessionId: string): readonly LapValidityVerdict[] {
      return cache.get(sessionId) ?? [];
    },

    forSession(sessionId, laps): LapValidityVerdict[] {
      return mergeLapValidityVerdicts(sessionId, laps, cache.get(sessionId) ?? []);
    },

    summary(sessionId, laps): Record<LapVerdictAnswer, number> {
      return summarizeLapVerdicts(mergeLapValidityVerdicts(sessionId, laps, cache.get(sessionId) ?? []));
    },

    async recordVerdict(input): Promise<RecordVerdictOutcome> {
      const repository = repo();
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
      if (repository?.saveLapValidityVerdict === undefined) {
        // Deliberately NOT cached: an answer this device cannot store must
        // not read back afterwards as though it had been, which is exactly
        // the "a false from the side log meant calibrated" mistake P10A H6
        // was written to undo.
        return { state: 'unsupported', verdict: null };
      }
      // Cached first: the owner's tap must show immediately, in a paddock,
      // on a phone whose storage may be slow.
      put(input.sessionId, verdict);
      try {
        await repository.saveLapValidityVerdict(verdict);
        return { state: 'stored', verdict };
      } catch (error) {
        onError(`could not store the lap verdict for session ${input.sessionId} lap ${String(input.lap.lapNumber)}`, error);
        return {
          state: 'failed',
          verdict,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
