import {
  suggestionsFromInsights,
  type ActiveCue,
  type AppliedCueUpdate,
  type CueUpdate,
  type PitSuggestion,
  type SessionInsights,
  type SuggestionResult,
} from '@circuit/core';

import {
  assembleSessionAnalysisChunked,
  runSessionAnalysis,
  type AnalysisLapRecording,
  type AssembledAnalysis,
} from './analysisAssembly';
import type { BundledCircuit } from './circuitCatalog';

/**
 * Ticket P5c-B D2/D3 — the trackday flow inside a RUNNING session
 * (`contracts.md` "Phase 5 REVISION 2" R2-3).
 *
 * Three pieces, all pure TypeScript (no expo, no composition singletons, every
 * dependency injected — so vitest imports this module directly and the screens
 * stay thin):
 *
 *  - {@link createStintRunner} — the same engine pass the post-session Analysis
 *    screen runs (`analysisAssembly`), over the laps the CURRENT outing has
 *    completed so far. Read-only over already-recorded laps; the lap in
 *    progress is never included, because a partial lap has no corner metrics
 *    worth comparing. Memoised by (session, completed-lap count), so opening
 *    the pit view straight after a lap boundary is instant and the running
 *    session is never made to pay for the same pass twice.
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

  async function compute(sessionId: string): Promise<StintRunResult> {
    let source: StintSource | null;
    try {
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
        {},
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

  return {
    run(sessionId, completedLapCount) {
      const key = cacheKey(sessionId, completedLapCount);
      const cached = cache.get(key);
      if (cached !== undefined) return Promise.resolve(cached);
      const running = inFlight.get(key);
      if (running !== undefined) return running;
      const promise = compute(sessionId).then((result) => {
        inFlight.delete(key);
        // Only a finished pass is memoised: an error or an "not stored yet"
        // can stop being true one lap later, and a stale one would freeze the
        // pit view for the rest of the outing.
        if (result.status === 'ready') cache.set(key, result);
        return result;
      });
      inFlight.set(key, promise);
      return promise;
    },
    peek(sessionId, completedLapCount) {
      return cache.get(cacheKey(sessionId, completedLapCount)) ?? null;
    },
    clear() {
      cache.clear();
      inFlight.clear();
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
  recordCueUpdates: (sessionId: string, updates: readonly AppliedCueUpdate[]) => void;
  recordShownSuggestions: (sessionId: string, suggestions: readonly PitSuggestion[]) => void;
  read: (sessionId: string) => SessionSuggestionRecord;
  /** Corners that have already used their ONE change this stint. */
  updatedCornerIds: (sessionId: string) => number[];
  clear: (sessionId?: string) => void;
}

/** Identity of one suggestion for de-duplication: a corner and what it is about. */
function suggestionKey(suggestion: PitSuggestion): string {
  return `${suggestion.cornerId}:${suggestion.kind}`;
}

export function createSuggestionJournal(): SuggestionJournal {
  const records = new Map<string, SessionSuggestionRecord>();

  function entry(sessionId: string): SessionSuggestionRecord {
    const existing = records.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionSuggestionRecord = { cueUpdates: [], shownPitSuggestions: [] };
    records.set(sessionId, created);
    return created;
  }

  return {
    recordCueUpdates(sessionId, updates) {
      if (updates.length === 0) return;
      entry(sessionId).cueUpdates.push(...updates);
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
            cueUpdates: [...record.cueUpdates],
            shownPitSuggestions: [...record.shownPitSuggestions],
          };
    },
    updatedCornerIds(sessionId) {
      return [...new Set((records.get(sessionId)?.cueUpdates ?? []).map((u) => u.cornerId))].sort(
        (a, b) => a - b,
      );
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
  /** The live cue set of the running session, metres before each corner entry. */
  activeCues: () => ActiveCue[];
  /**
   * Hands bounded updates to the cue source (`SessionController.applyCueUpdates`),
   * which re-validates them itself and returns exactly what it applied.
   */
  applyCueUpdates: (updates: readonly CueUpdate[]) => AppliedCueUpdate[];
  onError?: (error: unknown) => void;
}

export type StintOutcomeStatus =
  | 'disabled'
  | 'unavailable'
  | 'error'
  | 'insufficient'
  | 'nothing'
  | 'applied';

export interface StintCueOutcome {
  status: StintOutcomeStatus;
  applied: AppliedCueUpdate[];
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
   * clean lap of this outing already demonstrated.
   */
  onLapCompleted: (sessionId: string, completedLapCount: number) => Promise<StintCueOutcome>;
  /**
   * IN THE PITS (R2-3b). Read-only over the recorded laps: it computes the
   * suggestions, records that they were shown, and applies NOTHING.
   */
  openPitView: (sessionId: string, completedLapCount: number) => Promise<PitOutcome>;
}

export function createStintCoach(deps: StintCoachDeps): StintCoach {
  const report = deps.onError ?? ((error: unknown) => console.warn('[stintCoaching]', error));

  async function analyse(
    sessionId: string,
    completedLapCount: number,
  ): Promise<StintRunResult> {
    const result = await deps.runner.run(sessionId, completedLapCount);
    if (result.status === 'error') report(result.error);
    return result;
  }

  return {
    async onLapCompleted(sessionId, completedLapCount) {
      // The gate comes BEFORE any work at all: with suggestions off, a lap
      // boundary costs exactly one boolean read (ticket P5c-B D5).
      if (!deps.suggestionsEnabled()) {
        return { status: 'disabled', applied: [], suggestions: null, run: null };
      }
      const run = await analyse(sessionId, completedLapCount);
      if (run.status === 'error') {
        return { status: 'error', applied: [], suggestions: null, run };
      }
      if (run.status === 'unavailable') {
        return { status: 'unavailable', applied: [], suggestions: null, run };
      }
      const suggestions = suggestionsFromInsights(run.analysis.insights, deps.activeCues(), {
        enabled: true,
        updatedCornerIds: deps.journal.updatedCornerIds(sessionId),
      });
      if (suggestions.gate !== 'open') {
        return { status: 'insufficient', applied: [], suggestions, run };
      }
      if (suggestions.cueUpdates.length === 0) {
        return { status: 'nothing', applied: [], suggestions, run };
      }
      let applied: AppliedCueUpdate[] = [];
      try {
        applied = deps.applyCueUpdates(suggestions.cueUpdates);
      } catch (error) {
        report(error);
        return { status: 'error', applied: [], suggestions, run };
      }
      deps.journal.recordCueUpdates(sessionId, applied);
      return {
        status: applied.length === 0 ? 'nothing' : 'applied',
        applied,
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
      // Only what the driver is actually shown is remembered, and therefore
      // only that reaches the exported report (D4).
      deps.journal.recordShownSuggestions(sessionId, suggestions.pitSuggestions);
      return { run, suggestions, cueUpdates: deps.journal.read(sessionId).cueUpdates };
    },
  };
}
