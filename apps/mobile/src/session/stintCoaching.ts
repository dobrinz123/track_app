import {
  cueEvidenceFromInsights,
  suggestionsFromInsights,
  type ActiveCue,
  type AppliedCueUpdate,
  type CueUpdate,
  type CueUpdateContext,
  type CueUpdateRequest,
  type PitSuggestion,
  type SessionInsights,
  type SuggestionResult,
} from '@circuit/core';

import {
  assembleSessionAnalysisChunked,
  createLapProjectionCache,
  runSessionAnalysis,
  type AnalysisLapRecording,
  type AssembledAnalysis,
  type LapProjectionCache,
} from './analysisAssembly';
import type { BundledCircuit } from './circuitCatalog';

/**
 * Ticket P5c-B D2/D3 — the trackday flow inside a RUNNING session
 * (`contracts.md` "Phase 5 REVISION 2" R2-3), hardened by ticket P5c-FIX1
 * (Codex P5c-REV1 findings 1, 5, 6, 8, 11).
 *
 * Three pieces, all pure TypeScript (no expo, no composition singletons, every
 * dependency injected — so vitest imports this module directly and the screens
 * stay thin):
 *
 *  - {@link createStintRunner} — the same engine pass the post-session Analysis
 *    screen runs (`analysisAssembly`), over the laps the CURRENT outing has
 *    completed so far. Read-only over already-recorded laps; the lap in
 *    progress is never included, because a partial lap has no corner metrics
 *    worth comparing. Memoised by (session, completed-lap count), sharing ONE
 *    per-lap projection cache across the outing (E11), and it awaits the
 *    just-completed lap's persistence barrier before reading (E5), so it can
 *    never analyse a lap whose trace has not landed yet.
 *  - {@link createStintCoach} — the two entry points R2-3 defines:
 *    `onLapCompleted` (WHILE DRIVING: no advice, no text — only a bounded cue
 *    move, and only within what a clean lap of this outing demonstrated) and
 *    `openPitView` (IN THE PITS: suggestions are PRESENTED, never applied).
 *  - {@link createSuggestionJournal} — what was moved and what was actually
 *    shown, per session, so the pit view and the final export can both state it.
 *
 * `suggestionsEnabled` gates the whole stage and is read FRESH at every call.
 * With it off, `onLapCompleted` returns before it reads anything at all: no
 * database access, no engine pass, no cue touched — the running session behaves
 * exactly as it did before this ticket existed.
 *
 * **The apply is never immediate (P5c-FIX1 E1).** An analysis pass started at a
 * lap boundary finishes somewhere in the MIDDLE of the next lap — applying
 * there would move a cue under a driver already on the approach to it. So a
 * finished pass only ever QUEUES its bounded updates; the next lap boundary
 * applies them, after re-reading the setting and re-checking that the cue
 * source is still the same session, generation and stint. Toggling suggestions
 * off, restarting the session or pitting in the meantime applies nothing at all.
 */

/** The completed laps of one outing, ready for the engine. */
export interface StintSource {
  sessionId: string;
  circuit: BundledCircuit;
  /** ISO-8601 UTC start of the outing (what the pit view and export quote). */
  displayDateUtc: string;
  /** COMPLETED laps only — the lap in progress is never one of these. */
  recordings: readonly AnalysisLapRecording[];
}

export interface StintAnalysis {
  sessionId: string;
  source: StintSource;
  assembled: AssembledAnalysis;
  insights: SessionInsights;
  /** The completed laps this analysis covers, ascending. */
  lapNumbers: number[];
}

export type StintUnavailableReason = 'no-session' | 'no-laps' | 'no-trace';

export type StintRunResult =
  | { status: 'ready'; analysis: StintAnalysis }
  | { status: 'unavailable'; reason: StintUnavailableReason }
  | { status: 'error'; error: string };

export interface StintRunnerDeps {
  /**
   * Reads the outing's already-recorded laps. `null` when the session is not
   * (yet) stored. Rejections become an `error` result — this module never
   * throws at a running session.
   */
  loadCompletedLaps: (sessionId: string) => Promise<StintSource | null>;
  /**
   * Ticket P5c-FIX1 E5 (Codex P5c-REV1 finding 5): resolves once the laps the
   * facade has already advertised are actually ON DISK. The lap event is
   * emitted before its telemetry write settles, so without this barrier the
   * first pass after a boundary reads the newest lap as "no trace" and then
   * memoises that answer under the full lap count.
   */
  settleLapPersistence?: (sessionId: string) => Promise<void>;
  /** Hands the JS thread back between laps of the pass. Defaults to a macrotask. */
  yieldToUi?: () => Promise<void>;
}

export interface StintRunner {
  /**
   * Analyses the outing's completed laps. `completedLapCount` is the caller's
   * cheap, live count (the facade's own lap list) — it keys the cache, so a
   * repeated call between two lap boundaries costs nothing.
   */
  run: (sessionId: string, completedLapCount: number) => Promise<StintRunResult>;
  /** The cached result, or `null`. Never starts work. */
  peek: (sessionId: string, completedLapCount: number) => StintRunResult | null;
  /** How many laps this runner has PROJECTED in total (ticket P5c-FIX1 E11). */
  projectionCount: () => number;
  clear: () => void;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function cacheKey(sessionId: string, completedLapCount: number): string {
  return `${sessionId}|${completedLapCount}`;
}

export function createStintRunner(deps: StintRunnerDeps): StintRunner {
  const cache = new Map<string, StintRunResult>();
  const inFlight = new Map<string, Promise<StintRunResult>>();
  const yieldToUi = deps.yieldToUi ?? defaultYield;
  /**
   * ONE projection cache per outing (E11). A lap's projection never changes
   * once its trace is written, so a boundary pass projects only the lap that
   * just completed; the cache is dropped whenever the outing changes.
   */
  let projectionCache: LapProjectionCache = createLapProjectionCache();
  let projectionSessionId: string | null = null;

  function cacheFor(sessionId: string): LapProjectionCache {
    if (projectionSessionId !== sessionId) {
      projectionCache = createLapProjectionCache();
      projectionSessionId = sessionId;
    }
    return projectionCache;
  }

  async function compute(sessionId: string): Promise<StintRunResult> {
    let source: StintSource | null;
    try {
      // E5: the persistence barrier FIRST -- reading before it settles is what
      // produced an analysis of a lap with no trace.
      await deps.settleLapPersistence?.(sessionId);
      source = await deps.loadCompletedLaps(sessionId);
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
    if (source === null) return { status: 'unavailable', reason: 'no-session' };
    if (source.recordings.length === 0) return { status: 'unavailable', reason: 'no-laps' };
    try {
      const assembled = await assembleSessionAnalysisChunked(
        source.circuit,
        source.recordings,
        { projectionCache: cacheFor(sessionId) },
        yieldToUi,
      );
      if (assembled.laps.length === 0) return { status: 'unavailable', reason: 'no-trace' };
      const insights = runSessionAnalysis(assembled);
      return {
        status: 'ready',
        analysis: {
          sessionId,
          source,
          assembled,
          insights,
          lapNumbers: assembled.laps.map((lap) => lap.lap.lapNumber).sort((a, b) => a - b),
        },
      };
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** E5: a pass that could not read every advertised lap is not memoised. */
  function memoisable(result: StintRunResult): boolean {
    return result.status === 'ready' && result.analysis.assembled.skippedLaps.length === 0;
  }

  return {
    run(sessionId, completedLapCount) {
      const key = cacheKey(sessionId, completedLapCount);
      const cached = cache.get(key);
      if (cached !== undefined) return Promise.resolve(cached);
      const running = inFlight.get(key);
      if (running !== undefined) return running;
      const promise = compute(sessionId).then((result) => {
        inFlight.delete(key);
        // Only a COMPLETE finished pass is memoised: an error, an "not stored
        // yet", or a pass that could not read one of the laps the session
        // advertises can stop being true one lap later, and a stale one would
        // freeze the pit view for the rest of the outing.
        if (memoisable(result)) cache.set(key, result);
        return result;
      });
      inFlight.set(key, promise);
      return promise;
    },
    peek(sessionId, completedLapCount) {
      return cache.get(cacheKey(sessionId, completedLapCount)) ?? null;
    },
    projectionCount() {
      return projectionCache.projections;
    },
    clear() {
      cache.clear();
      inFlight.clear();
      projectionCache = createLapProjectionCache();
      projectionSessionId = null;
    },
  };
}

// ---------------------------------------------------------------------------
// The journal: what moved, and what the driver was actually shown
// ---------------------------------------------------------------------------

export interface SessionSuggestionRecord {
  /** Cue moves applied this session, oldest first. */
  cueUpdates: AppliedCueUpdate[];
  /** Pit suggestions the driver was actually SHOWN (D4 exports exactly these). */
  shownPitSuggestions: PitSuggestion[];
}

export interface SuggestionJournal {
  /** Records what the cue source applied, in the stint it was applied in. */
  recordCueUpdates: (
    sessionId: string,
    updates: readonly AppliedCueUpdate[],
    stintIndex: number,
  ) => void;
  recordShownSuggestions: (sessionId: string, suggestions: readonly PitSuggestion[]) => void;
  read: (sessionId: string) => SessionSuggestionRecord;
  /**
   * Corners that have already used their ONE change in `stintIndex` — the
   * stint, not the outing (ticket P5c-FIX1 E10). A pit exit starts the next
   * stint and therefore re-arms the allowance, while every cue stays where the
   * driver's own evidence put it.
   */
  updatedCornerIds: (sessionId: string, stintIndex: number) => number[];
  clear: (sessionId?: string) => void;
}

/** Identity of one suggestion for de-duplication: a corner and what it is about. */
function suggestionKey(suggestion: PitSuggestion): string {
  return `${suggestion.cornerId}:${suggestion.kind}`;
}

interface JournalEntry {
  cueUpdates: { update: AppliedCueUpdate; stintIndex: number }[];
  shownPitSuggestions: PitSuggestion[];
}

export function createSuggestionJournal(): SuggestionJournal {
  const records = new Map<string, JournalEntry>();

  function entry(sessionId: string): JournalEntry {
    const existing = records.get(sessionId);
    if (existing !== undefined) return existing;
    const created: JournalEntry = { cueUpdates: [], shownPitSuggestions: [] };
    records.set(sessionId, created);
    return created;
  }

  return {
    recordCueUpdates(sessionId, updates, stintIndex) {
      if (updates.length === 0) return;
      const record = entry(sessionId);
      for (const update of updates) record.cueUpdates.push({ update, stintIndex });
    },
    recordShownSuggestions(sessionId, suggestions) {
      if (suggestions.length === 0) return;
      const record = entry(sessionId);
      const seen = new Set(record.shownPitSuggestions.map(suggestionKey));
      for (const suggestion of suggestions) {
        const key = suggestionKey(suggestion);
        if (seen.has(key)) continue;
        seen.add(key);
        record.shownPitSuggestions.push(suggestion);
      }
    },
    read(sessionId) {
      const record = records.get(sessionId);
      return record === undefined
        ? { cueUpdates: [], shownPitSuggestions: [] }
        : {
            cueUpdates: record.cueUpdates.map((held) => held.update),
            shownPitSuggestions: [...record.shownPitSuggestions],
          };
    },
    updatedCornerIds(sessionId, stintIndex) {
      const held = records.get(sessionId)?.cueUpdates ?? [];
      return [
        ...new Set(
          held.filter((row) => row.stintIndex === stintIndex).map((row) => row.update.cornerId),
        ),
      ].sort((a, b) => a - b);
    },
    clear(sessionId) {
      if (sessionId === undefined) records.clear();
      else records.delete(sessionId);
    },
  };
}

// ---------------------------------------------------------------------------
// The coach
// ---------------------------------------------------------------------------

export interface StintCoachDeps {
  runner: StintRunner;
  journal: SuggestionJournal;
  /** The app's `suggestionsEnabled` setting, read FRESH at every call. */
  suggestionsEnabled: () => boolean;
  /**
   * The live cue source's identity — session, generation, stint, completed
   * laps (`SessionController.cueContext`). `null` when nothing is live. Read
   * before a pass starts AND again before anything is applied (E1).
   */
  cueContext: () => CueUpdateContext | null;
  /** The live cue set of the running session, metres before each corner entry. */
  activeCues: () => ActiveCue[];
  /**
   * Hands bounded updates to the cue source (`SessionController.applyCueUpdates`),
   * together with the context and the sealed evidence they were computed from.
   * The cue source re-validates all of it and returns exactly what it applied.
   */
  applyCueUpdates: (
    updates: readonly CueUpdate[],
    request: CueUpdateRequest,
  ) => AppliedCueUpdate[];
  onError?: (error: unknown) => void;
}

export type StintOutcomeStatus =
  | 'disabled'
  | 'unavailable'
  | 'error'
  | 'insufficient'
  | 'nothing'
  /** Bounded updates were computed and are waiting for the NEXT lap boundary. */
  | 'queued'
  /** The session/generation/stint moved on while the pass ran — nothing was kept. */
  | 'superseded'
  | 'applied';

export interface StintCueOutcome {
  status: StintOutcomeStatus;
  /** What was applied AT THIS BOUNDARY (computed at the previous one). */
  applied: AppliedCueUpdate[];
  /** What this pass queued for the NEXT boundary. */
  queued: CueUpdate[];
  suggestions: SuggestionResult | null;
  run: StintRunResult | null;
}

export interface PitOutcome {
  run: StintRunResult;
  suggestions: SuggestionResult;
  /** Cue moves already applied this outing, for the pit view's own section. */
  cueUpdates: AppliedCueUpdate[];
}

export interface StintCoach {
  /**
   * WHILE DRIVING (R2-3a). Called at a lap boundary, off the sample hot path.
   * Never throws, never blocks the session, and never moves a cue past what a
   * clean lap of this outing already demonstrated. Applies what the PREVIOUS
   * boundary queued (E1) and queues what this pass produces.
   */
  onLapCompleted: (sessionId: string, completedLapCount: number) => Promise<StintCueOutcome>;
  /**
   * IN THE PITS (R2-3b). Read-only over the recorded laps: it computes the
   * suggestions and applies NOTHING. What was actually SHOWN is recorded by the
   * screen through {@link recordShown} once the view has been built (E8).
   */
  openPitView: (sessionId: string, completedLapCount: number) => Promise<PitOutcome>;
  /**
   * Ticket P5c-FIX1 E8: records the suggestions a completed pit view actually
   * PUT ON SCREEN — the only ones the exported report may claim were shown.
   */
  recordShown: (sessionId: string, shown: readonly PitSuggestion[]) => void;
  /** What is waiting for the next lap boundary, for tests and diagnostics. */
  pendingUpdates: () => CueUpdate[];
}

// ---------------------------------------------------------------------------
// Boundary scheduling (ticket P5c-FIX1 E6)
// ---------------------------------------------------------------------------

export interface BoundaryScheduler {
  /** Tell the scheduler a lap has completed. Never throws, never blocks. */
  onBoundary: (completedLapCount: number) => void;
  /** True while a pass is running. */
  busy: () => boolean;
  /** The boundary waiting for the current pass to settle, or `null`. */
  pendingBoundary: () => number | null;
  /** Forgets any retained boundary (a session ended). */
  reset: () => void;
}

/**
 * Ticket P5c-FIX1 E6 (Codex P5c-REV1 finding 6): one pass at a time, but never
 * a DROPPED boundary.
 *
 * A lap completing while a pass is in flight used to be swallowed: the caller
 * advanced its "last handled" counter and then returned early, so that boundary
 * never ran and — after ticket P5c-FIX1 E1 — the cue moves queued by the
 * previous pass would have had no boundary to land at. The latest such
 * boundary is now RETAINED, and exactly ONE follow-up pass runs after the
 * current one settles: coalesced, so a slow pass cannot build a backlog.
 */
export function createBoundaryScheduler(deps: {
  run: (completedLapCount: number) => Promise<unknown>;
  onError?: (error: unknown) => void;
}): BoundaryScheduler {
  let inFlight = false;
  let pendingCount: number | null = null;

  function start(completedLapCount: number): void {
    inFlight = true;
    void Promise.resolve()
      .then(() => deps.run(completedLapCount))
      .catch((error: unknown) => deps.onError?.(error))
      .finally(() => {
        inFlight = false;
        const missed = pendingCount;
        pendingCount = null;
        if (missed !== null && missed > completedLapCount) start(missed);
      });
  }

  return {
    onBoundary(completedLapCount) {
      if (inFlight) {
        pendingCount = completedLapCount;
        return;
      }
      start(completedLapCount);
    },
    busy: () => inFlight,
    pendingBoundary: () => pendingCount,
    reset() {
      pendingCount = null;
    },
  };
}

/** One finished pass's bounded output, waiting for a lap boundary to apply it. */
interface PendingApply {
  sessionId: string;
  request: CueUpdateRequest;
  updates: CueUpdate[];
  /** Completed laps when the pass was computed — the boundary it belongs to. */
  computedAtLapCount: number;
}

function sameContext(left: CueUpdateContext, right: CueUpdateContext): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.generation === right.generation &&
    left.stintIndex === right.stintIndex
  );
}

export function createStintCoach(deps: StintCoachDeps): StintCoach {
  const report = deps.onError ?? ((error: unknown) => console.warn('[stintCoaching]', error));
  let pending: PendingApply | null = null;

  async function analyse(
    sessionId: string,
    completedLapCount: number,
  ): Promise<StintRunResult> {
    const result = await deps.runner.run(sessionId, completedLapCount);
    if (result.status === 'error') report(result.error);
    return result;
  }

  /**
   * The APPLY half (E1). Runs only at a lap boundary, and only after every
   * precondition has been re-read at this instant: the setting, the live cue
   * source's identity, and that a lap really has completed since the pass was
   * computed (so a fast pass cannot land mid-lap).
   */
  function applyPending(sessionId: string, completedLapCount: number): AppliedCueUpdate[] {
    const queued = pending;
    if (queued === null) return [];
    pending = null;
    if (queued.sessionId !== sessionId) return [];
    if (completedLapCount <= queued.computedAtLapCount) {
      // Not a later boundary yet -- keep waiting rather than applying mid-lap.
      pending = queued;
      return [];
    }
    if (!deps.suggestionsEnabled()) return [];
    const live = deps.cueContext();
    if (live === null || live.sessionId === null) return [];
    if (!sameContext(live, queued.request.context)) return [];
    try {
      const applied = deps.applyCueUpdates(queued.updates, queued.request);
      deps.journal.recordCueUpdates(sessionId, applied, live.stintIndex);
      return applied;
    } catch (error) {
      report(error);
      return [];
    }
  }

  return {
    async onLapCompleted(sessionId, completedLapCount) {
      // The gate comes BEFORE any work at all: with suggestions off, a lap
      // boundary costs exactly one boolean read (ticket P5c-B D5).
      if (!deps.suggestionsEnabled()) {
        pending = null;
        return { status: 'disabled', applied: [], queued: [], suggestions: null, run: null };
      }
      // What the PREVIOUS boundary queued lands here, at a boundary, or not at all.
      const applied = applyPending(sessionId, completedLapCount);

      const startedAt = deps.cueContext();
      const run = await analyse(sessionId, completedLapCount);
      if (run.status === 'error') {
        return { status: 'error', applied, queued: [], suggestions: null, run };
      }
      if (run.status === 'unavailable') {
        return { status: 'unavailable', applied, queued: [], suggestions: null, run };
      }
      // Re-read EVERYTHING the pass depended on: the setting may have been
      // turned off, and the cue source may be a different session, generation
      // or stint by now (E1).
      const now = deps.cueContext();
      if (
        !deps.suggestionsEnabled() ||
        startedAt === null ||
        now === null ||
        now.sessionId !== sessionId ||
        !sameContext(startedAt, now)
      ) {
        pending = null;
        return { status: 'superseded', applied, queued: [], suggestions: null, run };
      }

      const suggestions = suggestionsFromInsights(run.analysis.insights, deps.activeCues(), {
        enabled: true,
        updatedCornerIds: deps.journal.updatedCornerIds(sessionId, now.stintIndex),
      });
      if (suggestions.gate !== 'open') {
        return { status: 'insufficient', applied, queued: [], suggestions, run };
      }
      if (suggestions.cueUpdates.length === 0) {
        return {
          status: applied.length > 0 ? 'applied' : 'nothing',
          applied,
          queued: [],
          suggestions,
          run,
        };
      }
      pending = {
        sessionId,
        computedAtLapCount: completedLapCount,
        updates: [...suggestions.cueUpdates],
        request: {
          context: now,
          evidence: cueEvidenceFromInsights(run.analysis.insights, {
            sessionId,
            generation: now.generation,
            stintIndex: now.stintIndex,
          }),
        },
      };
      return {
        status: applied.length > 0 ? 'applied' : 'queued',
        applied,
        queued: [...suggestions.cueUpdates],
        suggestions,
        run,
      };
    },

    async openPitView(sessionId, completedLapCount) {
      const run = await analyse(sessionId, completedLapCount);
      const enabled = deps.suggestionsEnabled();
      const suggestions: SuggestionResult =
        run.status === 'ready'
          ? suggestionsFromInsights(run.analysis.insights, deps.activeCues(), { enabled })
          : {
              gate: enabled ? 'insufficient-clean-laps' : 'disabled',
              cleanLapCount: 0,
              cueUpdates: [],
              pitSuggestions: [],
              skipped: [],
            };
      // NOTHING is journalled here (E8): the pit view keeps only its focus
      // corners, and a load the screen abandoned shows nothing at all. What was
      // really put on screen comes back through `recordShown`.
      return { run, suggestions, cueUpdates: deps.journal.read(sessionId).cueUpdates };
    },

    recordShown(sessionId, shown) {
      deps.journal.recordShownSuggestions(sessionId, shown);
    },

    pendingUpdates() {
      return pending === null ? [] : [...pending.updates];
    },
  };
}
