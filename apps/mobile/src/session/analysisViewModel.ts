import {
  buildReport,
  type CoachReport,
  type SessionInsights,
  type SessionState,
} from '@circuit/core';

import {
  assembleSessionAnalysis,
  runSessionAnalysis,
  type AnalysisLapRecording,
  type AssembledAnalysis,
} from './analysisAssembly';
import type { BundledCircuit } from './circuitCatalog';
import {
  resolveAnalysisScreenStrings,
  type AnalysisScreenStrings,
  type AnalysisUiLanguage,
} from '../ui/screens/analysisStrings';

/** Re-exported so the export module has one import for the analysis language. */
export type { AnalysisUiLanguage };

/**
 * Ticket P5b B3/B5 — every decision `AnalysisScreen.tsx` makes, in a pure
 * module vitest can import (the `.tsx` itself stays a renderer; same split as
 * `telemetryStripViewModel.ts`).
 *
 * Two halves:
 *
 *  - {@link createAnalysisRunner} — the async, memoised pass from a session id
 *    to `SessionInsights`. It yields to the UI before the engine's synchronous
 *    work so the spinner actually paints (B5), caches per session id so
 *    re-entering the screen is free, and turns every dead end (no session, no
 *    laps, no GPS trace, a live session, a failed read) into a NAMED reason
 *    rather than an empty screen.
 *  - {@link buildAnalysisScreenState} — the pure projection of that result into
 *    what the screen draws, in the app's language.
 *
 * The report text is the ENGINE's (`buildReport`, already localised RO/EN with
 * its numbers in every sentence); this module adds only chrome — the section
 * frame, the per-corner time-loss badge, and the two notes about the RECORDING
 * that the engine cannot make because they are about what was stored rather
 * than about what was driven. Suggestions stay off: nothing here composes a
 * sentence about what the driver should do.
 */

/**
 * The session-machine states in which NO session is running, so an analysis may
 * run (ticket P5b B1: "No analysis during an active session"; contracts.md's
 * safety rule 4: "post-session only"). The same three states `composition.ts`
 * already treats as "not mid-session" for circuit selection.
 */
export const ANALYSIS_ALLOWED_SESSION_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'idle',
  'sessionComplete',
  'error',
]);

/** True while a session is running -- everything except the three states above. */
export function sessionIsActive(state: SessionState): boolean {
  return !ANALYSIS_ALLOWED_SESSION_STATES.has(state);
}

/** Everything one finished session needs before it can be analysed. */
export interface AnalysisSessionSource {
  sessionId: string;
  /** The catalog entry for the circuit the session was recorded on. */
  circuit: BundledCircuit;
  /** ISO-8601 UTC start of the session (what the history list shows). */
  displayDateUtc: string;
  recordings: readonly AnalysisLapRecording[];
}

export type AnalysisUnavailableReason =
  | 'session-not-found'
  | 'circuit-not-in-catalog'
  | 'no-laps'
  | 'no-trace'
  | 'session-active';

export type AnalysisRunResult =
  | {
      status: 'ready';
      source: AnalysisSessionSource;
      assembled: AssembledAnalysis;
      insights: SessionInsights;
    }
  | { status: 'unavailable'; reason: AnalysisUnavailableReason }
  | { status: 'error'; error: string };

/**
 * What a loader may answer: the session, `null` when it is not stored at all,
 * or a NAMED reason (an unknown circuit is a different fact from a missing
 * session, and the screen says which).
 */
export type AnalysisSourceResult =
  | AnalysisSessionSource
  | { unavailable: AnalysisUnavailableReason }
  | null;

export interface AnalysisRunnerDeps {
  /**
   * Resolves a stored session into its analysable parts, `null` when the
   * session is not stored, or `{ unavailable }` for a named dead end.
   * Rejections become an `error` result -- this module never throws at its
   * caller.
   */
  loadSession: (sessionId: string) => Promise<AnalysisSourceResult>;
  /** True while a session is running: no analysis happens during one (B1). */
  isSessionActive: () => boolean;
  /**
   * Hands the JS thread back before the engine's synchronous pass, so the
   * spinner the screen just set is actually painted. Defaults to a macrotask.
   */
  yieldToUi?: () => Promise<void>;
}

export interface AnalysisRunner {
  /** Analyses `sessionId`, reusing the cached result when there is one. */
  run: (sessionId: string) => Promise<AnalysisRunResult>;
  /** The cached result for `sessionId`, or `null`. Never starts work. */
  peek: (sessionId: string) => AnalysisRunResult | null;
  /** Drops the cache (a new session was recorded, laps changed, ...). */
  clear: () => void;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A memoised analysis runner. The cache holds the LANGUAGE-INDEPENDENT result
 * (`SessionInsights`), so switching RO/EN re-renders text without re-running
 * the engine, and an in-flight run is shared rather than started twice.
 */
export function createAnalysisRunner(deps: AnalysisRunnerDeps): AnalysisRunner {
  const cache = new Map<string, AnalysisRunResult>();
  const inFlight = new Map<string, Promise<AnalysisRunResult>>();
  const yieldToUi = deps.yieldToUi ?? defaultYield;

  async function compute(sessionId: string): Promise<AnalysisRunResult> {
    if (deps.isSessionActive()) return { status: 'unavailable', reason: 'session-active' };
    let loaded: AnalysisSourceResult;
    try {
      loaded = await deps.loadSession(sessionId);
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
    if (loaded === null) return { status: 'unavailable', reason: 'session-not-found' };
    if ('unavailable' in loaded) return { status: 'unavailable', reason: loaded.unavailable };
    const source: AnalysisSessionSource = loaded;
    if (source.recordings.length === 0) return { status: 'unavailable', reason: 'no-laps' };

    // The heavy pass is synchronous inside the engine; yielding here is what
    // keeps the screen's own spinner from being queued behind it.
    await yieldToUi();
    try {
      const assembled = assembleSessionAnalysis(source.circuit, source.recordings);
      if (assembled.laps.length === 0) return { status: 'unavailable', reason: 'no-trace' };
      const insights = runSessionAnalysis(assembled);
      return { status: 'ready', source, assembled, insights };
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    run(sessionId) {
      const cached = cache.get(sessionId);
      if (cached !== undefined) return Promise.resolve(cached);
      const running = inFlight.get(sessionId);
      if (running !== undefined) return running;
      const promise = compute(sessionId).then((result) => {
        inFlight.delete(sessionId);
        // A transient failure is not memoised: "try again" has to mean it.
        if (result.status !== 'error') cache.set(sessionId, result);
        return result;
      });
      inFlight.set(sessionId, promise);
      return promise;
    },
    peek(sessionId) {
      return cache.get(sessionId) ?? null;
    },
    clear() {
      cache.clear();
      inFlight.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Screen state
// ---------------------------------------------------------------------------

export interface AnalysisCornerRow {
  cornerId: number;
  /** The engine's own localised corner heading ("Corner 4 (left)"). */
  heading: string;
  /** The engine's own localised observation lines for this corner. */
  lines: string[];
  /** Milliseconds this corner costs the comparison lap, from the engine. */
  timeLossMs: number | null;
  /** The rendered badge for `timeLossMs`, or `null` when there is no comparison. */
  timeLossLabel: string | null;
  /** False when no lap of the session produced a measurement for this corner. */
  measured: boolean;
}

export interface AnalysisView {
  language: AnalysisUiLanguage;
  title: string;
  subtitle: string;
  header: string;
  disclaimer: string;
  observationsOnly: string;
  overview: string[];
  limitations: string[];
  timeLoss: string[];
  consistency: string[];
  sectors: string[];
  corners: AnalysisCornerRow[];
  /** Screen-made notes about the RECORDING (never about the driving). */
  notes: string[];
}

export type AnalysisScreenState =
  | { status: 'loading' }
  | {
      status: 'ready';
      view: AnalysisView;
      report: CoachReport;
      insights: SessionInsights;
      assembled: AssembledAnalysis;
      source: AnalysisSessionSource;
    }
  | { status: 'unavailable'; reason: AnalysisUnavailableReason; message: string }
  | { status: 'error'; message: string };

function unavailableMessage(
  reason: AnalysisUnavailableReason,
  strings: AnalysisScreenStrings,
): string {
  switch (reason) {
    case 'session-not-found':
      return strings.sessionNotFound;
    case 'circuit-not-in-catalog':
      return strings.circuitNotInCatalog;
    case 'no-laps':
      return strings.noLaps;
    case 'no-trace':
      return strings.noTrace;
    case 'session-active':
      return strings.duringSession;
  }
}

function sectionLines(report: CoachReport, id: string): string[] {
  return report.sections.find((section) => section.id === id)?.lines ?? [];
}

/** Seconds with the language's own decimal separator (the engine's convention). */
function seconds(ms: number, language: AnalysisUiLanguage): string {
  const fixed = (Math.abs(ms) / 1_000).toFixed(2);
  return `${language === 'ro' ? fixed.replace('.', ',') : fixed} s`;
}

function lapList(laps: readonly number[], language: AnalysisUiLanguage): string {
  const values = [...laps].sort((a, b) => a - b).map(String);
  if (values.length <= 1) return values[0] ?? '';
  const last = values[values.length - 1] ?? '';
  const head = values.slice(0, -1).join(', ');
  return language === 'ro' ? `${head} și ${last}` : `${head} and ${last}`;
}

/** Formats the ISO session date as a plain calendar day (no locale database needed). */
export function analysisSessionDate(displayDateUtc: string): string {
  return displayDateUtc.slice(0, 10);
}

/**
 * The screen's own notes about the recording: which decoded channels were too
 * sparse to use (with the percentage, so "we had none" and "we had 4 %" stay
 * different statements) and which laps had no stored trace.
 */
export function recordingNotes(
  assembled: AssembledAnalysis,
  language: AnalysisUiLanguage,
  strings: AnalysisScreenStrings,
): string[] {
  const notes: string[] = [];
  for (const entry of assembled.lowCoverageChannels) {
    notes.push(
      strings.channelTooSparse(
        strings.channelNames[entry.channel],
        Math.round(entry.fraction * 100),
      ),
    );
  }
  if (assembled.skippedLaps.length > 0) {
    notes.push(
      strings.lapsWithoutTrace(
        lapList(
          assembled.skippedLaps.map((entry) => entry.lapNumber),
          language,
        ),
      ),
    );
  }
  return notes;
}

/** Turns a finished run into everything the screen draws. Pure. */
export function buildAnalysisScreenState(
  result: AnalysisRunResult,
  language: AnalysisUiLanguage,
): AnalysisScreenState {
  const strings = resolveAnalysisScreenStrings(language);
  if (result.status === 'error') return { status: 'error', message: strings.failed };
  if (result.status === 'unavailable') {
    return {
      status: 'unavailable',
      reason: result.reason,
      message: unavailableMessage(result.reason, strings),
    };
  }

  const report = buildReport(result.insights, language);
  const corners: AnalysisCornerRow[] = result.insights.corners.map((corner) => {
    const timeLossMs = corner.timeLoss?.deltaMs ?? null;
    const measured = corner.perLap.some(
      (row) => row.sectorMs !== null || row.minSpeedKph !== null || row.brakeStartM !== null,
    );
    const lines = sectionLines(report, `corner-${corner.cornerId}`);
    return {
      cornerId: corner.cornerId,
      heading:
        report.sections.find((section) => section.id === `corner-${corner.cornerId}`)?.heading ?? '',
      lines: measured ? lines : [...lines, strings.cornerNotMeasured],
      timeLossMs,
      timeLossLabel:
        timeLossMs === null
          ? null
          : timeLossMs >= 0
            ? strings.timeLossBadge(seconds(timeLossMs, language))
            : strings.timeGainBadge(seconds(timeLossMs, language)),
      measured,
    };
  });

  const view: AnalysisView = {
    language,
    title: report.title,
    subtitle: report.subtitle,
    header: strings.sessionHeader(
      result.insights.circuitName ?? result.insights.circuitId,
      analysisSessionDate(result.source.displayDateUtc),
    ),
    disclaimer: report.disclaimer,
    observationsOnly: strings.observationsOnly,
    overview: sectionLines(report, 'overview'),
    limitations: sectionLines(report, 'limitations'),
    timeLoss: sectionLines(report, 'time-loss'),
    consistency: sectionLines(report, 'consistency'),
    sectors: sectionLines(report, 'sectors'),
    corners,
    notes: recordingNotes(result.assembled, language, strings),
  };

  return {
    status: 'ready',
    view,
    report,
    insights: result.insights,
    assembled: result.assembled,
    source: result.source,
  };
}
