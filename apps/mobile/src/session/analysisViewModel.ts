import {
  buildReport,
  // Ticket P5d T3: the one predicate that says "this circuit's geometry was
  // learned from a lap, not surveyed".
  isLearnedGeometry,
  type CoachReport,
  type CornerInsight,
  type CornerLapRow,
  type LimitationCode,
  type SessionInsights,
  type SessionState,
} from '@circuit/core';

import {
  assembleSessionAnalysisChunked,
  runSessionAnalysisChunked,
  type AnalysisLapRecording,
  type AnalysisPassYield,
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
  | { status: 'error'; error: string }
  /**
   * Ticket P5-FIX2 W1 (Codex P5-REV finding 12): the run was INVALIDATED by a
   * session-state change while it was under way. It carries no verdict about
   * the session at all -- it is work that was thrown away -- so it is never
   * published as an answer and never memoised; the screen shows the spinner of
   * the fresh run that replaced it (see {@link buildAnalysisScreenState}).
   */
  | { status: 'superseded' };

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
   * Hands the JS thread back between the chunks of the pass -- per lap while
   * projecting, per lap again through the final assembly, and around the engine
   * call (P5-FIX2 W2). Defaults to a macrotask. The phase is passed so a test
   * can tell the projection half from the final pass.
   */
  yieldToUi?: AnalysisPassYield;
}

export interface AnalysisRunner {
  /** Analyses `sessionId`, reusing the cached result when there is one. */
  run: (sessionId: string) => Promise<AnalysisRunResult>;
  /** The cached result for `sessionId`, or `null`. Never starts work. */
  peek: (sessionId: string) => AnalysisRunResult | null;
  /**
   * Ticket P5-FIX2 W1: invalidates every run currently in flight. Superseded
   * work is dropped from the join table (so no later caller can rejoin it),
   * stops at its next chunk boundary, and can neither publish nor cache its
   * result. The cache of FINISHED analyses is untouched -- those are facts
   * about a recording, not about the session lifecycle. Called by the
   * controller on every session-state change, in both directions.
   */
  invalidate: () => void;
  /** Drops the cache (a new session was recorded, laps changed, ...). */
  clear: () => void;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const SESSION_ACTIVE: AnalysisRunResult = { status: 'unavailable', reason: 'session-active' };
const SUPERSEDED: AnalysisRunResult = { status: 'superseded' };

/**
 * Thrown at a chunk boundary to stop a pass that may no longer publish -- the
 * lifecycle epoch moved, or a session started. Carries the result the run must
 * resolve to, so the abort never reads as an analysis failure.
 */
class AnalysisPassAborted extends Error {
  constructor(readonly result: AnalysisRunResult) {
    super('analysis pass aborted');
    this.name = 'AnalysisPassAborted';
  }
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
  /**
   * P5-FIX2 W1: the lifecycle epoch. Every run remembers the epoch it started
   * in; {@link AnalysisRunner.invalidate} bumps it and empties `inFlight`, so a
   * superseded run is unreachable to new callers and stops itself at its next
   * chunk boundary.
   */
  let generation = 0;

  async function compute(sessionId: string, mine: number): Promise<AnalysisRunResult> {
    /** The one reason a pass may not continue, or `null` when it may. */
    const stopReason = (): AnalysisRunResult | null => {
      if (mine !== generation) return SUPERSEDED;
      // P5b-FIX1 C1: analysing over a live session is what the safety rule
      // forbids, so a session that starts at ANY point voids the whole run.
      if (deps.isSessionActive()) return SESSION_ACTIVE;
      return null;
    };
    /**
     * The yield the whole pass hands the UI back through -- and, per Codex
     * P5-REV finding 1, the place the epoch is rechecked. A state change during
     * a twenty-lap projection now stops the pass at the very next chunk instead
     * of after the last lap.
     */
    const guardedYield: AnalysisPassYield = async (phase) => {
      await yieldToUi(phase);
      const stop = stopReason();
      if (stop !== null) throw new AnalysisPassAborted(stop);
    };

    const beforeLoad = stopReason();
    if (beforeLoad !== null) return beforeLoad;
    let loaded: AnalysisSourceResult;
    try {
      loaded = await deps.loadSession(sessionId);
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
    const afterLoad = stopReason();
    if (afterLoad !== null) return afterLoad;
    if (loaded === null) return { status: 'unavailable', reason: 'session-not-found' };
    if ('unavailable' in loaded) return { status: 'unavailable', reason: loaded.unavailable };
    const source: AnalysisSessionSource = loaded;
    if (source.recordings.length === 0) return { status: 'unavailable', reason: 'no-laps' };

    try {
      const assembled = await assembleSessionAnalysisChunked(
        source.circuit,
        source.recordings,
        {},
        guardedYield,
      );
      const afterAssembly = stopReason();
      if (afterAssembly !== null) return afterAssembly;
      if (assembled.laps.length === 0) return { status: 'unavailable', reason: 'no-trace' };
      const insights = await runSessionAnalysisChunked(assembled, guardedYield);
      const afterEngine = stopReason();
      if (afterEngine !== null) return afterEngine;
      return { status: 'ready', source, assembled, insights };
    } catch (error) {
      if (error instanceof AnalysisPassAborted) return error.result;
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    run(sessionId) {
      const cached = cache.get(sessionId);
      if (cached !== undefined) return Promise.resolve(cached);
      // Only runs of the CURRENT epoch are ever in this map (invalidate empties
      // it), so joining one can never rejoin superseded work (W1).
      const running = inFlight.get(sessionId);
      if (running !== undefined) return running;
      const mine = generation;
      const promise: Promise<AnalysisRunResult> = compute(sessionId, mine).then((result) => {
        if (inFlight.get(sessionId) === promise) inFlight.delete(sessionId);
        // Superseded work is thrown away here too: a run that finished after
        // its epoch closed says nothing about the session it was asked about.
        if (mine !== generation) return SUPERSEDED;
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
    invalidate() {
      generation += 1;
      inFlight.clear();
    },
    clear() {
      cache.clear();
      // A run started against the dropped cache must not repopulate it.
      generation += 1;
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
      // Someone else's state change invalidated our run (the runner is shared).
      // A superseded run is not an answer, so this screen starts a fresh one
      // rather than showing work that was thrown away (W1).
      if (result.status === 'superseded') {
        start();
        return;
      }
      publish(result);
    });
  }

  const unsubscribe = deps.subscribeSessionState((state) => {
    const active = sessionIsActive(state);
    if (active === sessionActive) return;
    sessionActive = active;
    // P5-FIX2 W1: EVERY crossing invalidates the shared runner's in-flight
    // work, in both directions. A run that spanned a session -- start and end
    // alike -- is work about a phone that was doing something else; the next
    // eligible view must start fresh rather than rejoin it.
    generation += 1;
    deps.runner.invalidate();
    if (active) {
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

/**
 * One mark on a lap's approach line (ticket P5-FIX2 W4, contracts.md R2-2).
 * The engine measures a braking or lift point as METRES BEFORE the corner
 * entry; this is that measurement placed on a 0..1 axis so the screen can draw
 * it without doing any arithmetic of its own.
 */
export interface AnalysisCornerMark {
  kind: 'brake' | 'lift';
  /** 0 = the earliest point any lap of this corner produced, 1 = the corner entry. */
  position: number;
  /** The measurement itself, in the language's own format ("120 m"). */
  label: string;
  /**
   * Half-width of the brake-onset uncertainty on the SAME axis, or `null`. A
   * held channel can only place the onset at one of its own samples, and the
   * card says so instead of drawing a precision that was never measured.
   */
  uncertainty: number | null;
}

/** One lap's line in the compact visual: where it braked and lifted, and its speeds. */
export interface AnalysisCornerMarkRow {
  lapNumber: number;
  clean: boolean;
  marks: AnalysisCornerMark[];
  /** Minimum speed as a bare figure ("82,4"); the caption carries the unit. */
  minSpeed: string | null;
  exit: string | null;
  /** 0..1 within this corner's own measured range, for a compact bar. `null` unmeasured. */
  minSpeedBar: number | null;
  exitBar: number | null;
  /** The whole row as one spoken line, for a screen reader. */
  a11yLabel: string;
}

/**
 * The corner's compact visual: an approach axis running from the earliest point
 * any lap produced (left) to the corner entry (right), one marked line per lap.
 * `null` when no lap of the session measured a braking point, a lift point or a
 * speed here -- there is nothing to draw and the card says so in words instead.
 */
export interface AnalysisCornerVisual {
  /** How far before the corner entry the axis starts, metres. */
  axisStartM: number;
  /** The two ends of the axis, localised ("180 m before" ... "entry"). */
  axisStartLabel: string;
  axisEntryLabel: string;
  brakeLabel: string;
  liftLabel: string;
  /** Says the speed unit once for the whole block. */
  speedCaption: string;
  rows: AnalysisCornerMarkRow[];
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
  /**
   * Ticket P5-FIX2 W4: the same per-lap facts as a compact VISUAL. `null` when
   * nothing about this corner was measured.
   */
  visual: AnalysisCornerVisual | null;
  /** What the driver has DEMONSTRATED on their own clean laps, or `null`. */
  envelopeLine: string | null;
  /**
   * The engine's own observation sentences for this corner. Carried for the
   * EXPORT and for tests; the app itself no longer renders them (R2-2 asks the
   * card to be visual, and the full sentences live in the shared report).
   */
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
  /**
   * Ticket P5d T3: set only when this session was driven on a LEARNED (test
   * loop) circuit -- the badge that names it, and the note that says the
   * geometry is ad-hoc. `null` on every surveyed circuit, so the screen is
   * literally unchanged for them.
   */
  testLoopBadge: string | null;
  testLoopNote: string | null;
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

/** Keeps a computed axis position inside the drawn line. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Finite numbers only -- `null` and NaN are "not measured", never zero. */
function measuredNumbers(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null && Number.isFinite(value));
}

/**
 * Where a measurement sits on the approach axis. The engine reports braking and
 * lift points as METRES BEFORE the corner entry, so a bigger number is further
 * from the corner: position 0 is the axis start, position 1 is the entry.
 */
function axisPosition(metresBeforeEntry: number, axisStartM: number): number {
  if (axisStartM <= 0) return 1;
  return clamp01(1 - metresBeforeEntry / axisStartM);
}

/** 0..1 within the corner's own measured range; a single measured value fills the bar. */
function bar(value: number | null, values: readonly number[]): number | null {
  if (value === null || !Number.isFinite(value) || values.length === 0) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  return high > low ? clamp01((value - low) / (high - low)) : 1;
}

/**
 * Ticket P5-FIX2 W4 (Codex P5-REV finding 16, contracts.md R2-2): the corner's
 * per-lap facts as MARKS rather than sentences.
 *
 * Every number here is the engine's own measurement, re-expressed as a position
 * on one axis so the card can be read at a glance: the axis spans from the
 * earliest braking/lift point any lap of this corner produced to the corner
 * entry itself, and each lap gets one line with its brake mark, its lift mark
 * and its two speed figures. Nothing is inferred, nothing is suggested, and a
 * lap that measured nothing simply has no marks.
 */
function cornerVisual(
  corner: CornerInsight,
  language: AnalysisUiLanguage,
  strings: AnalysisScreenStrings,
): AnalysisCornerVisual | null {
  const distances = measuredNumbers(
    corner.perLap.flatMap((row) => [row.brakeStartM, row.liftPointM]),
  );
  const minSpeeds = measuredNumbers(corner.perLap.map((row) => row.minSpeedKph));
  const exits = measuredNumbers(corner.perLap.map((row) => row.exitSpeedKph));
  if (distances.length === 0 && minSpeeds.length === 0 && exits.length === 0) return null;

  // A tidy axis end just past the furthest measurement, so the earliest mark is
  // not glued to the edge. Never zero: a corner braked at the entry itself
  // still needs an axis to sit on.
  const furthestM = distances.length === 0 ? 0 : Math.max(...distances);
  const axisStartM = Math.max(10, Math.ceil((furthestM * 1.1) / 10) * 10);

  const rows: AnalysisCornerMarkRow[] = corner.perLap.map((row) => {
    const marks: AnalysisCornerMark[] = [];
    if (row.liftPointM !== null && Number.isFinite(row.liftPointM)) {
      marks.push({
        kind: 'lift',
        position: axisPosition(row.liftPointM, axisStartM),
        label: metres(row.liftPointM, language),
        uncertainty: null,
      });
    }
    if (row.brakeStartM !== null && Number.isFinite(row.brakeStartM)) {
      marks.push({
        kind: 'brake',
        position: axisPosition(row.brakeStartM, axisStartM),
        label: metres(row.brakeStartM, language),
        uncertainty:
          row.brakeOnsetUncertaintyM === null || axisStartM <= 0
            ? null
            : clamp01(row.brakeOnsetUncertaintyM / axisStartM),
      });
    }
    const minSpeed = row.minSpeedKph === null ? null : decimal(row.minSpeedKph, 1, language);
    const exit = row.exitSpeedKph === null ? null : decimal(row.exitSpeedKph, 1, language);
    const spoken = [
      ...marks.map(
        (mark) =>
          `${mark.kind === 'brake' ? strings.markBrake : strings.markLift} ${mark.label}`,
      ),
      ...(minSpeed === null ? [] : [`${strings.detailColumns.minSpeed} ${kph(row.minSpeedKph!, language)}`]),
      ...(exit === null ? [] : [`${strings.detailColumns.exit} ${kph(row.exitSpeedKph!, language)}`]),
    ].join(', ');
    return {
      lapNumber: row.lapNumber,
      clean: row.clean,
      marks,
      minSpeed,
      exit,
      minSpeedBar: bar(row.minSpeedKph, minSpeeds),
      exitBar: bar(row.exitSpeedKph, exits),
      a11yLabel: strings.markRowA11y(row.lapNumber, spoken === '' ? strings.noValue : spoken),
    };
  });

  return {
    axisStartM,
    axisStartLabel: strings.markAxisStart(metres(axisStartM, language)),
    axisEntryLabel: strings.markAxisEntry,
    brakeLabel: strings.markBrake,
    liftLabel: strings.markLift,
    speedCaption: strings.markSpeedCaption,
    rows,
  };
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
    visual: cornerVisual(corner, language, strings),
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
  // P5-FIX2 W1: a run the session lifecycle invalidated carries no verdict. The
  // screen waits for the fresh pass that replaced it -- never a stale report,
  // never an error the driver did not cause.
  if (result.status === 'superseded') return { status: 'loading' };
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
    testLoopBadge: isLearnedGeometry(result.source.circuit.profile) ? strings.testLoopBadge : null,
    testLoopNote: isLearnedGeometry(result.source.circuit.profile)
      ? strings.testLoopGeometryNote
      : null,
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
