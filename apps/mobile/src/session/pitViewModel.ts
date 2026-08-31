import {
  cueUpdateLine,
  pitSuggestionLine,
  type AppliedCueUpdate,
  type PitSuggestion,
  type SuggestionResult,
} from '@circuit/core';

import {
  buildAnalysisScreenState,
  type AnalysisCornerRow,
  type AnalysisUiLanguage,
} from './analysisViewModel';
import type { StintAnalysis, StintRunResult, StintUnavailableReason } from './stintCoaching';
import { resolvePitScreenStrings, type PitScreenStrings } from '../ui/screens/trackdayStrings';

/**
 * Ticket P5c-B D3 — the BETWEEN-STINT view (contracts.md R2-3b, R2-2).
 *
 * The driver is in the pits with the engine running and about thirty seconds of
 * attention: this is the screen that has to say *where the seconds went* and
 * *what to try*, with as little reading as possible. So it reuses the P5b
 * analysis projection wholesale — same badges, same tap-to-expand per-lap
 * numbers, same engine sentences — and adds exactly two things on top:
 *
 *  1. it keeps only the {@link PIT_FOCUS_CORNER_LIMIT} corners costing the most
 *     time, worst first;
 *  2. under each of those it puts the bounded suggestion lines for that corner,
 *     and the cue moves this outing has already made there.
 *
 * Pure and read-only. It never touches the running session and it never
 * composes a sentence of its own: every suggestion line comes from
 * `@circuit/core`'s `pitSuggestionLine`, which can only render a suggestion the
 * bounded engine actually produced.
 */

/** How many corners the pit view puts in front of the driver. */
export const PIT_FOCUS_CORNER_LIMIT = 3;

export interface PitViewInput {
  run: StintRunResult;
  suggestions: SuggestionResult;
  /** Cue moves applied this outing (from the suggestion journal). */
  cueUpdates: readonly AppliedCueUpdate[];
  language: AnalysisUiLanguage;
}

/** One focus corner: the P5b row, plus this outing's advice for it. */
export interface PitCornerRow extends AnalysisCornerRow {
  /** Bounded suggestion sentences for this corner, in the engine's own words. */
  suggestions: string[];
  /** Cue moves already applied here, with before/after and the proving lap. */
  cueUpdates: string[];
}

export interface PitView {
  language: AnalysisUiLanguage;
  title: string;
  header: string;
  /** Compact chips: laps so far, clean laps. */
  summaryChips: string[];
  focusHeading: string;
  /** Exactly ONE honest line about the suggestion stage's state. */
  statusLine: string;
  corners: PitCornerRow[];
  /** How many suggestion lines the driver is being shown in total. */
  suggestionCount: number;
  cueUpdatesHeading: string;
  cueUpdateLines: string[];
  noCueUpdates: string;
  /** Screen-made notes about the RECORDING (never about the driving). */
  notes: string[];
  disclaimer: string;
}

export type PitViewState =
  | {
      status: 'ready';
      view: PitView;
      analysis: StintAnalysis;
      suggestions: SuggestionResult;
      /**
       * Ticket P5c-FIX1 E8 (Codex P5c-REV1 finding 8): the suggestion objects
       * this view actually PUTS ON SCREEN — the focus corners' ones, and only
       * those. The journal (and therefore the exported report) records exactly
       * this list, never every suggestion the engine generated.
       */
      shownSuggestions: PitSuggestion[];
    }
  | { status: 'unavailable'; reason: StintUnavailableReason; message: string }
  | { status: 'error'; message: string };

function unavailableMessage(
  reason: StintUnavailableReason,
  strings: PitScreenStrings,
): string {
  switch (reason) {
    case 'no-session':
      return strings.noSession;
    case 'no-laps':
      return strings.noLaps;
    case 'no-trace':
      return strings.noTrace;
  }
}

/**
 * The honest one-liner under the heading. Exactly one of four states, and none
 * of them is silence: "off", "not enough evidence yet", "nothing to say", or
 * how many bounded suggestions are on screen.
 */
function statusLine(
  suggestions: SuggestionResult,
  shown: number,
  strings: PitScreenStrings,
): string {
  if (suggestions.gate === 'disabled') return strings.suggestionsOff;
  if (suggestions.gate === 'insufficient-clean-laps') return strings.insufficientCleanLaps;
  if (shown === 0) return strings.nothingToSuggest;
  return strings.suggestionsShown(shown);
}

/** Worst first; a corner with no measured loss ranks last, then by id. */
function byTimeLost(left: AnalysisCornerRow, right: AnalysisCornerRow): number {
  const a = left.timeLossMs;
  const b = right.timeLossMs;
  if (a === null && b === null) return left.cornerId - right.cornerId;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a || left.cornerId - right.cornerId;
}

export function buildPitViewState(input: PitViewInput): PitViewState {
  const strings = resolvePitScreenStrings(input.language);
  if (input.run.status === 'error') return { status: 'error', message: strings.failed };
  if (input.run.status === 'unavailable') {
    return {
      status: 'unavailable',
      reason: input.run.reason,
      message: unavailableMessage(input.run.reason, strings),
    };
  }

  const analysis = input.run.analysis;
  // The SAME projection the post-session Analysis screen uses -- badges,
  // per-lap detail table and engine observations all come from there, so the
  // two screens can never drift into saying different things about one corner.
  const analysisState = buildAnalysisScreenState(
    {
      status: 'ready',
      source: {
        sessionId: analysis.sessionId,
        circuit: analysis.source.circuit,
        displayDateUtc: analysis.source.displayDateUtc,
        recordings: analysis.source.recordings,
      },
      assembled: analysis.assembled,
      insights: analysis.insights,
    },
    input.language,
  );
  if (analysisState.status !== 'ready') return { status: 'error', message: strings.failed };

  const suggestionsByCorner = new Map<number, PitSuggestion[]>();
  for (const suggestion of input.suggestions.pitSuggestions) {
    const list = suggestionsByCorner.get(suggestion.cornerId) ?? [];
    list.push(suggestion);
    suggestionsByCorner.set(suggestion.cornerId, list);
  }
  const updatesByCorner = new Map<number, AppliedCueUpdate[]>();
  for (const update of input.cueUpdates) {
    const list = updatesByCorner.get(update.cornerId) ?? [];
    list.push(update);
    updatesByCorner.set(update.cornerId, list);
  }

  const shownSuggestions: PitSuggestion[] = [];
  const corners: PitCornerRow[] = [...analysisState.view.corners]
    .filter((corner) => corner.measured)
    .sort(byTimeLost)
    .slice(0, PIT_FOCUS_CORNER_LIMIT)
    .map((corner) => {
      const forCorner = suggestionsByCorner.get(corner.cornerId) ?? [];
      // E8: rendered here, and therefore shown -- the export claims no more.
      shownSuggestions.push(...forCorner);
      return {
        ...corner,
        suggestions: forCorner.map((suggestion) => pitSuggestionLine(suggestion, input.language)),
        cueUpdates: (updatesByCorner.get(corner.cornerId) ?? []).map((update) =>
          cueUpdateLine(update, input.language),
        ),
      };
    });

  const suggestionCount = corners.reduce((total, corner) => total + corner.suggestions.length, 0);
  const circuitName = analysis.insights.circuitName ?? analysis.insights.circuitId;

  return {
    status: 'ready',
    analysis,
    suggestions: input.suggestions,
    shownSuggestions,
    view: {
      language: input.language,
      title: strings.screenTitle,
      header: strings.header(circuitName, analysis.lapNumbers.length),
      summaryChips: [
        strings.lapsChip(analysis.insights.lapCount),
        strings.cleanLapsChip(analysis.insights.cleanLapCount),
      ],
      focusHeading: strings.focusHeading,
      statusLine: statusLine(input.suggestions, suggestionCount, strings),
      corners,
      suggestionCount,
      cueUpdatesHeading: strings.cueUpdatesHeading,
      cueUpdateLines: input.cueUpdates.map((update) => cueUpdateLine(update, input.language)),
      noCueUpdates: strings.noCueUpdates,
      notes: analysisState.view.notes,
      disclaimer: strings.disclaimer,
    },
  };
}
