import {
  buildReport,
  type CoachReport,
  type CornerInsight,
  type CornerLapRow,
  type LimitationCode,
  type SessionInsights,
  type SessionState,
} from '@circuit/core';

import {
  assembleSessionAnalysisChunked,
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
 * Ticket P5b B3/B5, revised by P5b-FIX1 (Codex P5b-REV1 findings 1, 4, 5, 6 and
 * the user's finding F2, ratified as contracts.md "Phase 5 REVISION 2" R2-2) —
 * every decision `AnalysisScreen.tsx` makes, in a pure module vitest can import
 * (the `.tsx` itself stays a renderer; same split as `telemetryStripViewModel.ts`).
 *
 * Three halves now:
 *
 *  - {@link createAnalysisRunner} — the async, chunked pass from a session id to
 *    `SessionInsights`. It hands the JS thread back BETWEEN LAPS (C5), rechecks
 *    after every await whether a session has started (C1), memoises only
 *    results that are facts about the recording, and turns every dead end (no
 *    session, an incompatible layout, no laps, no GPS trace, a live session, a
 *    failed read) into a NAMED reason rather than an empty screen.
 *  - {@link createAnalysisController} — the screen's subscription: it OBSERVES
 *    the session facade, hides an analysis the moment a session starts, and
 *    re-runs by itself when that session ends, so the driver never has to leave
 *    and re-enter the screen (C1).
 *  - {@link buildAnalysisScreenState} — the pure projection of a finished run
 *    into what the screen draws, in the app's language: an INTERACTIVE corner
 *    list (name + badges) whose rows expand into per-lap numbers, the
 *    demonstrated envelope and the engine's own sentence for that corner (C10).
 *
 * The report text is the ENGINE's (`buildReport`, already localised RO/EN with
 * its numbers in every sentence); this module adds only chrome — badges,
 * column headers, compact chips, and the two notes about the RECORDING that the
 * engine cannot make because they are about what was stored rather than about
 * what was driven. Suggestions stay off: nothing here composes a sentence about
 * what the driver should do.
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
  | 'layout-incompatible'
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
   * Hands the JS thread back between laps of the pass, so the screen keeps
   * painting and responding. Defaults to a macrotask.
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

const SESSION_ACTIVE: AnalysisRunResult = { status: 'unavailable', reason: 'session-active' };

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
    // P5b-FIX1 C1: checked BEFORE the load, again after it, and again after the
    // pass -- a session that starts at any point during the run invalidates the
    // whole result, because analysing over a live session is exactly what the
    // safety rule forbids.
    if (deps.isSessionActive()) return SESSION_ACTIVE;
    let loaded: AnalysisSourceResult;
    try {
      loaded = await deps.loadSession(sessionId);
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
    if (deps.isSessionActive()) return SESSION_ACTIVE;
    if (loaded === null) return { status: 'unavailable', reason: 'session-not-found' };
    if ('unavailable' in loaded) return { status: 'unavailable', reason: loaded.unavailable };
    const source: AnalysisSessionSource = loaded;
    if (source.recordings.length === 0) return { status: 'unavailable', reason: 'no-laps' };

    try {
      const assembled = await assembleSessionAnalysisChunked(
        source.circuit,
        source.recordings,
        {},
        yieldToUi,
      );
      if (deps.isSessionActive()) return SESSION_ACTIVE;
      if (assembled.laps.length === 0) return { status: 'unavailable', reason: 'no-trace' };
      const insights = runSessionAnalysis(assembled);
      if (deps.isSessionActive()) return SESSION_ACTIVE;
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
        // Only a FINISHED analysis is memoised. A transient failure is not ("try
        // again" has to mean it), and neither is any unavailable reason: every
        // one of them -- a live session above all (C1) -- can stop being true
        // while the screen is open.
        if (result.status === 'ready') cache.set(sessionId, result);
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
// The screen's subscription (P5b-FIX1 C1 / C6)
// ---------------------------------------------------------------------------

export interface AnalysisControllerDeps {
  /** The SHARED runner (one per app, from `composition.ts`) -- never a per-screen one. */
  runner: AnalysisRunner;
  sessionId: string;
  /** The facade's session state, live. Returns an unsubscribe function. */
  subscribeSessionState: (listener: (state: SessionState) => void) => () => void;
}

export interface AnalysisController {
  /**
   * The current result, and every later one. `null` means "still running".
   * Calls back immediately with the current value.
   */
  subscribe: (listener: (result: AnalysisRunResult | null) => void) => () => void;
  /** Runs the analysis again (the "try again" button). */
  retry: () => void;
  /** Stops observing. Any in-flight run stays in the shared runner. */
  dispose: () => void;
}

/**
 * Ties one open Analysis screen to the shared runner AND to the live session
 * state (P5b-FIX1 C1):
 *
 *  - a session starting mid-run hides the analysis immediately and the run's
 *    result, whenever it lands, is never published;
 *  - the session ending re-runs by itself, so a driver who opened the screen
 *    during a session does not have to leave and come back;
 *  - leaving the screen (`dispose`) starts nothing new and cancels nothing:
 *    the run belongs to the shared runner, so re-entering JOINS it (C6).
 */
export function createAnalysisController(deps: AnalysisControllerDeps): AnalysisController {
  const listeners = new Set<(result: AnalysisRunResult | null) => void>();
  let current: AnalysisRunResult | null = null;
  let disposed = false;
  /** Bumped whenever a run is superseded, so a late result cannot publish. */
  let generation = 0;
  let sessionActive = false;

  function publish(next: AnalysisRunResult | null): void {
    current = next;
    for (const listener of [...listeners]) listener(next);
  }

  function start(): void {
    if (disposed || sessionActive) return;
    const mine = ++generation;
    publish(deps.runner.peek(deps.sessionId));
    void deps.runner.run(deps.sessionId).then((result) => {
      if (disposed || mine !== generation || sessionActive) return;
      publish(result);
    });
  }

  const unsubscribe = deps.subscribeSessionState((state) => {
    const active = sessionIsActive(state);
    if (active === sessionActive) return;
    sessionActive = active;
    if (active) {
      // Whatever is running belongs to a session that is no longer finished.
      generation += 1;
      publish(SESSION_ACTIVE);
      return;
    }
    start();
  });

  if (!sessionActive && current === null) start();
  else if (sessionActive) publish(SESSION_ACTIVE);

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {
      if (sessionActive) return;
      publish(null);
      start();
    },
    dispose() {
      disposed = true;
      listeners.clear();
      unsubscribe();
    },
  };
}

// ---------------------------------------------------------------------------
// Screen state
// ---------------------------------------------------------------------------

/** One lap's numbers for one corner, already formatted for the detail table. */
export interface AnalysisCornerLapRow {
  lapNumber: number;
  /** The engine's own verdict for the lap this row belongs to. */
  clean: boolean;
  /** Braking point with its uncertainty when the engine reported one ("120 m ±6 m"). */
  brake: string;
  lift: string;
  minSpeed: string;
  exit: string;
  peakDecel: string;
  latG: string;
}

export interface AnalysisCornerDetail {
  cornerId: number;
  heading: string;
  /** Localised column headers for the per-lap table. */
  columns: {
    lap: string;
    brake: string;
    lift: string;
    minSpeed: string;
    exit: string;
    peakDecel: string;
    latG: string;
  };
  perLap: AnalysisCornerLapRow[];
  /** What the driver has DEMONSTRATED on their own clean laps, or `null`. */
  envelopeLine: string | null;
  /** The engine's own observation sentences for this corner. */
  observations: string[];
}

/**
 * A row of the interactive corner LIST (contracts.md R2-2): a name and badges,
 * nothing else. Everything with a number in it lives in {@link detail}, which
 * the screen shows when the row is tapped.
 */
export interface AnalysisCornerRow {
  cornerId: number;
  /** The engine's own localised corner heading ("Corner 4 (left)"). */
  heading: string;
  /** Milliseconds this corner costs the comparison lap, from the engine. */
  timeLossMs: number | null;
  /** The rendered badge for `timeLossMs`, or `null` when there is no comparison. */
  timeLossLabel: string | null;
  /** "consistency 78/100", or `null` when the engine could not score it. */
  consistencyLabel: string | null;
  /** "82,4 km/h → 104,0 km/h", or `null` when neither speed was measured. */
  speedLabel: string | null;
  /** The badges above, in display order, without the nulls. */
  badges: string[];
  /** False when no lap of the session produced ANY measurement for this corner. */
  measured: boolean;
  detail: AnalysisCornerDetail;
}

export interface AnalysisView {
  language: AnalysisUiLanguage;
  title: string;
  subtitle: string;
  header: string;
  disclaimer: string;
  observationsOnly: string;
  /** Compact one-liners about the session itself (laps, clean laps, best lap). */
  summaryChips: string[];
  /** One short chip per distinct engine limitation code -- the prose is in the export. */
  limitationChips: string[];
  /** The engine's own sections. Kept for the EXPORT; the screen shows chips instead. */
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
    case 'layout-incompatible':
      return strings.layoutIncompatible;
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

/** A decimal with the language's own separator (the engine's convention). */
function decimal(value: number, digits: number, language: AnalysisUiLanguage): string {
  const fixed = value.toFixed(digits);
  return language === 'ro' ? fixed.replace('.', ',') : fixed;
}

/** Seconds with the language's own decimal separator (the engine's convention). */
function seconds(ms: number, language: AnalysisUiLanguage): string {
  return `${decimal(Math.abs(ms) / 1_000, 2, language)} s`;
}

function metres(value: number, language: AnalysisUiLanguage): string {
  return `${decimal(value, 0, language)} m`;
}

function kph(value: number, language: AnalysisUiLanguage): string {
  return `${decimal(value, 1, language)} km/h`;
}

function gForce(value: number, language: AnalysisUiLanguage): string {
  return `${decimal(value, 2, language)} g`;
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
 * different statements), which laps LACKED a channel the rest of the session
 * carried (P5b-FIX1 C2), and which laps had no stored trace.
 */
export function recordingNotes(
  assembled: AssembledAnalysis,
  language: AnalysisUiLanguage,
  strings: AnalysisScreenStrings,
): string[] {
  const notes: string[] = [];
  for (const entry of assembled.lowCoverageChannels) {
    const name = strings.channelNames[entry.channel];
    const everywhere = entry.excludedLapNumbers.length >= entry.analysedLapCount;
    notes.push(
      everywhere
        ? strings.channelTooSparse(name, Math.round(entry.fraction * 100))
        : strings.channelMissingOnLaps(name, lapList(entry.excludedLapNumbers, language)),
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

/**
 * Ticket P5b-FIX1 C4 (Codex P5b-REV1 finding 4): a corner counts as measured
 * when the engine produced ANY per-corner observation for it -- lift, exit
 * speed, peak deceleration, throttle-on and lateral G included, not only the
 * three the first cut looked at.
 */
const MEASURED_FIELDS = [
  'sectorMs',
  'minSpeedKph',
  'brakeStartM',
  'liftPointM',
  'exitSpeedKph',
  'peakDecelG',
  'throttleOnM',
  'maxLatG',
  'frictionCircleMaxG',
] as const satisfies readonly (keyof CornerLapRow)[];

function rowIsMeasured(row: CornerLapRow): boolean {
  return MEASURED_FIELDS.some((field) => {
    const value = row[field];
    return typeof value === 'number' && Number.isFinite(value);
  });
}

/** The lap whose numbers the list badge quotes: the engine's own representative one. */
function representativeRow(
  corner: CornerInsight,
  insights: SessionInsights,
): CornerLapRow | undefined {
  return (
    corner.perLap.find((row) => row.lapNumber === insights.comparisonLapNumber) ??
    corner.perLap.find((row) => row.lapNumber === insights.referenceLapNumber) ??
    corner.perLap.find((row) => row.minSpeedKph !== null || row.exitSpeedKph !== null) ??
    corner.perLap[0]
  );
}

/**
 * The demonstrated envelope for one corner, as ONE line of facts about laps the
 * driver has already driven (contracts.md R2-2's "demonstrated-envelope line").
 * Never a target: every number here was measured on a clean lap of this
 * session, and the lap it came from is named.
 */
function envelopeLine(
  corner: CornerInsight,
  language: AnalysisUiLanguage,
  strings: AnalysisScreenStrings,
): string | null {
  const envelope = corner.envelope;
  if (envelope === null || envelope.evidenceLapIds.length === 0) return null;
  const parts: string[] = [];
  if (envelope.latestBrakeStartM !== null && envelope.latestBrakeStartLapNumber !== null) {
    parts.push(
      strings.envelopeLatestBrake(
        metres(envelope.latestBrakeStartM, language),
        envelope.latestBrakeStartLapNumber,
      ),
    );
  }
  if (envelope.highestMinSpeedKph !== null && envelope.highestMinSpeedLapNumber !== null) {
    parts.push(
      strings.envelopeHighestMinSpeed(
        kph(envelope.highestMinSpeedKph, language),
        envelope.highestMinSpeedLapNumber,
      ),
    );
  }
  if (envelope.earliestLiftM !== null && envelope.earliestLiftLapNumber !== null) {
    parts.push(
      strings.envelopeEarliestLift(
        metres(envelope.earliestLiftM, language),
        envelope.earliestLiftLapNumber,
      ),
    );
  }
  if (parts.length === 0) return null;
  return strings.envelopeFromCleanLaps(
    parts.join('; '),
    lapList(envelope.evidenceLapIds, language),
  );
}

function cornerDetail(
  corner: CornerInsight,
  heading: string,
  observations: string[],
  language: AnalysisUiLanguage,
  strings: AnalysisScreenStrings,
): AnalysisCornerDetail {
  const none = strings.noValue;
  const perLap: AnalysisCornerLapRow[] = corner.perLap.map((row) => ({
    lapNumber: row.lapNumber,
    clean: row.clean,
    brake:
      row.brakeStartM === null
        ? none
        : row.brakeOnsetUncertaintyM === null
          ? metres(row.brakeStartM, language)
          : `${metres(row.brakeStartM, language)} ±${metres(row.brakeOnsetUncertaintyM, language)}`,
    lift: row.liftPointM === null ? none : metres(row.liftPointM, language),
    minSpeed: row.minSpeedKph === null ? none : kph(row.minSpeedKph, language),
    exit: row.exitSpeedKph === null ? none : kph(row.exitSpeedKph, language),
    peakDecel: row.peakDecelG === null ? none : gForce(row.peakDecelG, language),
    latG: row.maxLatG === null ? none : gForce(row.maxLatG, language),
  }));
  return {
    cornerId: corner.cornerId,
    heading,
    columns: strings.detailColumns,
    perLap,
    envelopeLine: envelopeLine(corner, language, strings),
    observations,
  };
}

/** One row of the interactive corner list, with its expandable detail. */
function cornerRow(
  corner: CornerInsight,
  report: CoachReport,
  insights: SessionInsights,
  language: AnalysisUiLanguage,
  strings: AnalysisScreenStrings,
): AnalysisCornerRow {
  const section = report.sections.find((entry) => entry.id === `corner-${corner.cornerId}`);
  const heading = section?.heading ?? '';
  const measured = corner.perLap.some(rowIsMeasured);
  const observations = measured
    ? [...(section?.lines ?? [])]
    : [...(section?.lines ?? []), strings.cornerNotMeasured];

  const timeLossMs = corner.timeLoss?.deltaMs ?? null;
  const timeLossLabel =
    timeLossMs === null
      ? null
      : timeLossMs >= 0
        ? strings.timeLossBadge(seconds(timeLossMs, language))
        : strings.timeGainBadge(seconds(timeLossMs, language));

  const score = corner.consistency?.score ?? null;
  const consistencyLabel = score === null ? null : strings.consistencyBadge(score);

  const row = representativeRow(corner, insights);
  const speedLabel =
    row === undefined || (row.minSpeedKph === null && row.exitSpeedKph === null)
      ? null
      : strings.speedBadge(
          row.minSpeedKph === null ? strings.noValue : kph(row.minSpeedKph, language),
          row.exitSpeedKph === null ? strings.noValue : kph(row.exitSpeedKph, language),
        );

  return {
    cornerId: corner.cornerId,
    heading,
    timeLossMs,
    timeLossLabel,
    consistencyLabel,
    speedLabel,
    badges: [timeLossLabel, consistencyLabel, speedLabel].filter(
      (badge): badge is string => badge !== null,
    ),
    measured,
    detail: cornerDetail(corner, heading, observations, language, strings),
  };
}

/** The session's own numbers, as chips rather than a paragraph (R2-2). */
function summaryChips(
  insights: SessionInsights,
  language: AnalysisUiLanguage,
  strings: AnalysisScreenStrings,
): string[] {
  const chips = [strings.lapsChip(insights.lapCount), strings.cleanLapsChip(insights.cleanLapCount)];
  const best = insights.lapTimeConsistency;
  if (best !== null) {
    chips.push(strings.bestLapChip(seconds(best.bestMs, language), best.bestLapNumber));
  }
  return chips;
}

/** One short chip per DISTINCT limitation code; the engine's prose stays in the export. */
function limitationChips(insights: SessionInsights, strings: AnalysisScreenStrings): string[] {
  const seen = new Set<LimitationCode>();
  const chips: string[] = [];
  for (const limitation of insights.limitations) {
    if (seen.has(limitation.code)) continue;
    seen.add(limitation.code);
    chips.push(strings.limitationChips[limitation.code]);
  }
  return chips;
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
  const corners = result.insights.corners.map((corner) =>
    cornerRow(corner, report, result.insights, language, strings),
  );

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
    summaryChips: summaryChips(result.insights, language, strings),
    limitationChips: limitationChips(result.insights, strings),
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
