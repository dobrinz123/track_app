import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { MAX_BRAKE_LATER_M, MAX_MIN_SPEED_GAIN_KPH, cueUpdateLine, pitSuggestionLine } from '@circuit/core';
import type {
  AppliedCueUpdate,
  PitSuggestion,
  ChannelAvailability,
  CoachingChannelId,
  ConsistencyComponent,
  Corner,
  CornerInsight,
  CornerLapRow,
  DemonstratedEnvelope,
  LapCheckId,
  LapInsight,
  LapStatus,
  Limitation,
  SessionInsights,
  TimeLossCause,
} from '@circuit/core';

import type { AnalysisScreenState, AnalysisUiLanguage } from './analysisViewModel';

/**
 * Post-session analysis export (ticket P5b B4, binding — contracts.md's
 * "Signal Finder (Phase 4l)" item 8, which is written for 4l AND 5b):
 *
 *   "every result screen (Signal Finder session, post-session corner analysis)
 *    shares with one tap a full JSON plus a <= 1-page human-readable summary
 *    (`.md`, RO/EN), named `trace-<kind>-<date>-<subject>`; the summary is what
 *    the user forwards, the JSON is for tooling."
 *
 * Revised by ticket P5b-FIX1 (Codex P5b-REV1 findings 7-10):
 *
 *  - C7: the JSON is a STANDALONE, versioned document (schema 2) explicitly
 *    mapped from the engine's outputs. V1 re-exported `SessionInsights` whole,
 *    so any change inside `@circuit/core` silently changed the exported shape
 *    AND leaked `corners[].advisorySpeedKph` -- an ADVISORY target -- out of a
 *    document that declares `observationsOnly: true`. Nothing advisory or
 *    suggestion-derived is mapped here; `analysisExportV2.test.ts` pins the
 *    keys so the next core change has to come through this file.
 *  - C8: one tap writes BOTH files (even where the share sheet is unavailable)
 *    and hands the `.md` to the sheet; `expo-sharing` shares exactly one file
 *    per call, so the button says the JSON is written alongside and the second
 *    control shares it -- the same shape `signalFinderExport.ts` ships.
 *  - C9: every dynamic file-name segment goes through one sanitizer, and the
 *    date is normalised to `YYYY-MM-DD` rather than sliced out of whatever the
 *    session metadata happens to hold.
 *
 * The share MACHINERY is `signalFinderExport.ts`'s, deliberately: the same
 * expo-file-system v57 class API (`File`/`Paths`, `write()` is SYNCHRONOUS),
 * the same single `expo-sharing` call, and the same never-throws contract.
 *
 * Schema 3 added the trackday block (P5c-B D4). Schema 4 (ticket P5-FIX2 W3,
 * Codex P5-REV finding 15) adds the STRUCTURED half of the P5c facts that until
 * now existed only inside localized sentences: each lap's R2-1 labels with the
 * measured values they stand on, and the coverage gate's per-lap verdict. The
 * prose stays exactly as it was — this is alongside it, not instead of it.
 *
 * Nothing in the summary is written by this module about the DRIVING -- every
 * observation line comes from the engine's own localised report, carried here
 * through the screen's view model. What this module owns is the frame: table
 * headers, section captions and the one-page budget.
 */

/**
 * The R2-1 lap labels, taken from the engine's own lap record rather than
 * re-declared here (`@circuit/core` does not re-export the union itself, and a
 * copy of it in this file would be a second source of truth for what a label
 * can be).
 */
type LapLabel = LapInsight['labels'][number];

export const ANALYSIS_EXPORT_SCHEMA_VERSION = 4;
export const ANALYSIS_EXPORT_KIND = 'trace-analysis-report';

export interface AnalysisExportChannelCoverage {
  channel: CoachingChannelId;
  percent: number;
  sampleCount: number;
}

/**
 * Ticket P5-FIX2 W3 (Codex P5-REV finding 15): ONE analysed lap's own decoded
 * coverage, and what that lap therefore lost. Schema 3 stated this only inside
 * a localized sentence ("brake was not recorded on laps 2 and 3"), which a tool
 * cannot read back; the structured form is per lap, per channel, with the
 * percentage the gate actually saw.
 */
export interface AnalysisExportLapCoverage {
  lapNumber: number;
  /** Every decoded channel this lap carried, in `ANALYSIS_CHANNELS` order. */
  coverage: AnalysisExportChannelCoverage[];
  /** Channels stripped from THIS lap's inputs by the coverage gate. */
  excluded: CoachingChannelId[];
}

/** One (lap, corner) measurement. Measurements only -- no advisory speed. */
export interface AnalysisExportCornerLap {
  lapNumber: number;
  clean: boolean;
  brakeStartM: number | null;
  brakeSource: CornerLapRow['brakeSource'];
  brakeOnsetUncertaintyM: number | null;
  liftPointM: number | null;
  liftSource: CornerLapRow['liftSource'];
  peakDecelG: number | null;
  minSpeedKph: number | null;
  exitSpeedKph: number | null;
  sectorMs: number | null;
  throttleOnM: number | null;
  maxLatG: number | null;
  frictionCircleMaxG: number | null;
  deltaMs: number | null;
  qualityOk: boolean;
}

export interface AnalysisExportCornerEnvelope {
  cornerId: number;
  latestBrakeStartM: number | null;
  latestBrakeStartLapNumber: number | null;
  earliestBrakeStartM: number | null;
  earliestBrakeStartLapNumber: number | null;
  medianBrakeStartM: number | null;
  earliestLiftM: number | null;
  earliestLiftLapNumber: number | null;
  latestLiftM: number | null;
  latestLiftLapNumber: number | null;
  medianLiftM: number | null;
  highestMinSpeedKph: number | null;
  highestMinSpeedLapNumber: number | null;
  lowestMinSpeedKph: number | null;
  lowestMinSpeedLapNumber: number | null;
  medianMinSpeedKph: number | null;
  highestExitSpeedKph: number | null;
  highestExitSpeedLapNumber: number | null;
  maxDecelG: number | null;
  maxLatG: number | null;
  evidenceLapIds: number[];
}

export interface AnalysisExportConsistency {
  cornerId: number;
  lapCount: number;
  brakeSpreadM: number | null;
  minSpeedSpreadKph: number | null;
  sectorSpreadMs: number | null;
  score: number | null;
  basis: ConsistencyComponent[];
  comparable: boolean;
}

export interface AnalysisExportTimeLoss {
  cornerId: number;
  referenceLapNumber: number;
  comparisonLapNumber: number;
  deltaMs: number | null;
  sectorLossMs: number | null;
  bestSectorMs: number | null;
  bestSectorLapNumber: number | null;
  comparisonSectorMs: number | null;
  causes: TimeLossCause[];
}

export interface AnalysisExportCorner {
  cornerId: number;
  entryDistanceM: number;
  apexDistanceM: number;
  exitDistanceM: number;
  direction: Corner['direction'];
  severity: Corner['severity'];
  cleanLapCount: number;
  bestSectorMs: number | null;
  bestSectorLapNumber: number | null;
  medianSectorMs: number | null;
  worstSectorMs: number | null;
  worstSectorLapNumber: number | null;
  perLap: AnalysisExportCornerLap[];
  envelope: AnalysisExportCornerEnvelope | null;
  consistency: AnalysisExportConsistency | null;
  timeLoss: AnalysisExportTimeLoss | null;
}

export interface AnalysisExportLap {
  lapNumber: number;
  durationMs: number;
  valid: boolean;
  status: LapStatus;
  clean: boolean;
  reason: LapInsight['reason'];
  reasons: LapInsight['reasons'];
  detail: string;
  unavailableChecks: LapCheckId[];
  coverageFraction: number;
  /**
   * Ticket P5-FIX2 W3: the R2-1 labels this lap carries — HEAVY_BRAKING,
   * ABS_SUSPECTED, SLIDE_ROTATION. Informative signatures of normal circuit
   * driving, NEVER a reason to exclude a lap: `status` and `reasons` above stay
   * untouched by them, which is exactly what a reader of this file has to be
   * able to check for itself.
   */
  labels: LapLabel[];
  /** Peak |longitudinal g| over the lap — the value HEAVY_BRAKING stands on. */
  peakDecelG: number | null;
  /** Worst yaw-rate excess over the track-implied yaw, deg/s — SLIDE_ROTATION's. */
  yawExcessDps: number | null;
  /** Whether a brake-release-reapply oscillation was seen — ABS_SUSPECTED's. */
  absOscillationDetected: boolean;
}

export interface AnalysisExportSectorLoss {
  sectorIndex: number;
  referenceLapNumber: number;
  referenceMs: number;
  comparisonLapNumber: number;
  comparisonMs: number;
  lostMs: number;
}

export interface AnalysisExportLapTimeConsistency {
  lapCount: number;
  bestMs: number;
  bestLapNumber: number;
  medianMs: number;
  worstMs: number;
  worstLapNumber: number;
  spreadMs: number;
  score: number;
}

/** The engine's findings, in the EXPORT's own shape (never the engine's type). */
export interface AnalysisExportAnalysis {
  laps: AnalysisExportLap[];
  corners: AnalysisExportCorner[];
  timeLossRanking: AnalysisExportTimeLoss[];
  consistencyRanking: AnalysisExportConsistency[];
  sectorTimeLoss: AnalysisExportSectorLoss[];
  lapTimeConsistency: AnalysisExportLapTimeConsistency | null;
  envelope: {
    analysisVersion: number;
    cleanLapCount: number;
    cleanLapIds: number[];
    corners: AnalysisExportCornerEnvelope[];
  };
  availability: ChannelAvailability;
  limitations: Limitation[];
}

/** One cue move that was APPLIED during the session (ticket P5c-B D4). */
export interface AnalysisExportCueUpdate {
  cornerId: number;
  point: 'brake' | 'lift';
  /** Where the cue was, metres before the corner entry. */
  fromM: number;
  /** Where it moved to — never past `demonstratedM`. */
  toM: number;
  movedLaterM: number;
  /** The latest point a clean lap of THIS session demonstrated. */
  demonstratedM: number;
  /** The clean lap that demonstrated it. */
  evidenceLapNumber: number;
  /** The lap that had completed when the cue moved. */
  appliedAfterLapNumber: number;
  /** The rendered sentence, in the driver's language. */
  text: string;
}

/** One pit suggestion that was actually SHOWN to the driver (ticket P5c-B D4). */
export interface AnalysisExportPitSuggestion {
  cornerId: number;
  kind: 'brakeLater' | 'liftLater' | 'carryMoreMinSpeed';
  unit: 'm' | 'kph';
  typicalValue: number;
  demonstratedValue: number;
  targetValue: number;
  deltaValue: number;
  evidenceLapNumber: number;
  timeLossMs: number | null;
  /** Always `true`: only what the driver was shown is ever exported. */
  shown: true;
  text: string;
}

/**
 * The trackday record (contracts.md R2-3c). Present ONLY when the driver opted
 * in AND something was actually shown or applied — otherwise the document is
 * observations-only exactly as before. Everything in it is bounded by the
 * driver's own demonstrated envelope; `bounds` states the caps in the document
 * so a reader never has to trust the app for them.
 */
export interface AnalysisExportTrackday {
  bounds: {
    maxBrakeLaterM: number;
    maxMinSpeedGainKph: number;
    maxChangesPerCornerPerStint: 1;
  };
  cueUpdates: AnalysisExportCueUpdate[];
  pitSuggestions: AnalysisExportPitSuggestion[];
}

export interface AnalysisExportDocument {
  kind: typeof ANALYSIS_EXPORT_KIND;
  schemaVersion: typeof ANALYSIS_EXPORT_SCHEMA_VERSION;
  generatedAtUtc: string;
  language: AnalysisUiLanguage;
  /**
   * True when nothing advisory is in this document — the default, and the only
   * possibility while `suggestionsEnabled` is off. False exactly when
   * {@link trackday} is present (contracts.md R2-3c).
   */
  observationsOnly: boolean;
  session: {
    sessionId: string;
    dateUtc: string;
    circuitId: string;
    circuitName: string | null;
    layoutId: string | null;
    totalLengthM: number;
    geometryValidated: boolean;
    analysisVersion: number;
    lapCount: number;
    cleanLapCount: number;
    referenceLapNumber: number | null;
    comparisonLapNumber: number | null;
  };
  /** What the RECORDING itself could support -- the honesty half of the export. */
  recording: {
    sampleCount: number;
    usedChannels: CoachingChannelId[];
    coverage: AnalysisExportChannelCoverage[];
    tooSparseChannels: AnalysisExportChannelCoverage[];
    /** Ticket P5-FIX2 W3: the coverage gate's own verdict, analysed lap by lap. */
    perLapCoverage: AnalysisExportLapCoverage[];
    lapsWithoutTrace: { lapNumber: number; reason: string }[];
    notes: string[];
  };
  /** The engine's findings, explicitly mapped. */
  analysis: AnalysisExportAnalysis;
  /** The rendered report, in the language the driver was reading. */
  report: {
    title: string;
    subtitle: string;
    /** The standing V1 promise, in the driver's language: facts, never instruction. */
    observationsOnlyNote: string;
    disclaimer: string;
    sections: { id: string; heading: string; lines: string[] }[];
    text: string;
  };
  /** Ticket P5c-B D4. Omitted entirely when nothing was suggested or applied. */
  trackday?: AnalysisExportTrackday;
}

interface SummaryStrings {
  /** Ticket P5c-B D4 — the two trackday captions. */
  suggestions: string;
  cueUpdates: string;
  observations: string;
  recordedOn: string;
  cornerTableHeader: string;
  cornerTableSeparator: string;
  limitations: string;
  notes: string;
  more: (count: number) => string;
  truncated: string;
  generated: string;
  none: string;
}

const EN: SummaryStrings = {
  suggestions: 'Suggestions (from your own clean laps)',
  cueUpdates: 'Cues that moved during the session',
  observations: 'Observations',
  recordedOn: 'Session',
  cornerTableHeader: '| Corner | Time lost | Best through | Min speed | Exit |',
  cornerTableSeparator: '|---|---|---|---|---|',
  limitations: 'What this data cannot tell you',
  notes: 'About this recording',
  more: (count) => `_(+${count} more corners in the JSON)_`,
  truncated: '_(truncated — the full report is in the JSON)_',
  generated: 'Generated',
  none: '—',
};

const RO: SummaryStrings = {
  suggestions: 'Sugestii (din propriile tale tururi curate)',
  cueUpdates: 'Repere mutate în timpul sesiunii',
  observations: 'Observații',
  recordedOn: 'Sesiune',
  cornerTableHeader: '| Viraj | Timp pierdut | Cel mai bun | Viteză minimă | Ieșire |',
  cornerTableSeparator: '|---|---|---|---|---|',
  limitations: 'Ce nu putem spune din aceste date',
  notes: 'Despre această înregistrare',
  more: (count) => `_(+${count} viraje în plus, în JSON)_`,
  truncated: '_(scurtat — raportul complet este în JSON)_',
  generated: 'Generat',
  none: '—',
};

/** Both tables, exported so a test can pin that RO carries every label EN does. */
export const ANALYSIS_SUMMARY_STRINGS: Readonly<Record<AnalysisUiLanguage, SummaryStrings>> = {
  en: EN,
  ro: RO,
};

/**
 * The <= 1-page budget, hard-enforced regardless of how many corners a circuit
 * has or how long the engine's sentences are (the same backstop
 * `signalFinderExport.ts` grew for exactly this reason).
 */
export const ANALYSIS_SUMMARY_MAX_LINES = 60;
export const ANALYSIS_SUMMARY_MAX_CHARS = 4_096;

/** How many overview / limitation lines the one-pager carries before deferring to the JSON. */
const OVERVIEW_LINE_LIMIT = 6;
const LIMITATION_LINE_LIMIT = 5;

type ReadyState = Extract<AnalysisScreenState, { status: 'ready' }>;

function percent(fraction: number): number {
  return Math.round(fraction * 100);
}

// ---------------------------------------------------------------------------
// File naming (P5b-FIX1 C9): ONE sanitizer, every dynamic segment through it.
// ---------------------------------------------------------------------------

/** What an unusable date segment becomes -- never a path separator, never empty. */
export const ANALYSIS_EXPORT_UNDATED = 'undated';

/** Lower-case, `[a-z0-9-]` only, no leading/trailing or repeated separators. */
function sanitizeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * `YYYY-MM-DD` from whatever the session metadata holds (an ISO instant, a
 * slash-separated day, ...), or {@link ANALYSIS_EXPORT_UNDATED} when the value
 * is not a calendar day at all. A malformed date must never reach a path.
 */
function normalizeDate(value: string): string {
  const day = value.trim().slice(0, 10).replace(/[^0-9]/g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ANALYSIS_EXPORT_UNDATED;
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12 || date < 1 || date > 31 || year < 1_000) {
    return ANALYSIS_EXPORT_UNDATED;
  }
  return day;
}

/** `trace-analysis-<circuit>-<yyyy-mm-dd>.<ext>` (the ticket's own exact pattern). */
export function analysisExportFileName(doc: AnalysisExportDocument, ext: 'json' | 'md'): string {
  const prefix = sanitizeSegment(ANALYSIS_EXPORT_KIND.replace(/-report$/, ''));
  const circuit = sanitizeSegment(doc.session.circuitId);
  const date = sanitizeSegment(normalizeDate(doc.session.dateUtc));
  return [prefix, circuit, date].filter((segment) => segment.length > 0).join('-') + `.${ext}`;
}

export interface AnalysisExportOptions {
  /** ISO-8601 UTC instant the export was produced (injected, never `Date.now()` inside). */
  generatedAtUtc: string;
  /**
   * Ticket P5c-B D4: what the trackday stage actually did during this session —
   * the cue moves applied and the pit suggestions the driver was SHOWN. Omit
   * (or pass two empty lists) and the document stays observations-only.
   */
  trackday?: {
    cueUpdates: readonly AppliedCueUpdate[];
    pitSuggestions: readonly PitSuggestion[];
  };
}

/** Maps the trackday record into this document's own shape. `null` when empty. */
function mapTrackday(
  record: AnalysisExportOptions['trackday'],
  language: AnalysisUiLanguage,
): AnalysisExportTrackday | null {
  if (record === undefined) return null;
  if (record.cueUpdates.length === 0 && record.pitSuggestions.length === 0) return null;
  return {
    bounds: {
      maxBrakeLaterM: MAX_BRAKE_LATER_M,
      maxMinSpeedGainKph: MAX_MIN_SPEED_GAIN_KPH,
      maxChangesPerCornerPerStint: 1,
    },
    cueUpdates: record.cueUpdates.map((update) => ({
      cornerId: update.cornerId,
      point: update.point,
      fromM: update.fromM,
      toM: update.toM,
      movedLaterM: update.movedLaterM,
      demonstratedM: update.demonstratedM,
      evidenceLapNumber: update.evidenceLapNumber,
      appliedAfterLapNumber: update.appliedAfterLapNumber,
      text: cueUpdateLine(update, language),
    })),
    pitSuggestions: record.pitSuggestions.map((suggestion) => ({
      cornerId: suggestion.cornerId,
      kind: suggestion.kind,
      unit: suggestion.unit,
      typicalValue: suggestion.typicalValue,
      demonstratedValue: suggestion.demonstratedValue,
      targetValue: suggestion.targetValue,
      deltaValue: suggestion.deltaValue,
      evidenceLapNumber: suggestion.evidenceLapNumber,
      timeLossMs: suggestion.timeLossMs,
      shown: true,
      text: pitSuggestionLine(suggestion, language),
    })),
  };
}

// ---------------------------------------------------------------------------
// The mapping (P5b-FIX1 C7): engine output -> this document's OWN shape.
// ---------------------------------------------------------------------------

function mapCornerLap(row: CornerLapRow): AnalysisExportCornerLap {
  return {
    lapNumber: row.lapNumber,
    clean: row.clean,
    brakeStartM: row.brakeStartM,
    brakeSource: row.brakeSource,
    brakeOnsetUncertaintyM: row.brakeOnsetUncertaintyM,
    liftPointM: row.liftPointM,
    liftSource: row.liftSource,
    peakDecelG: row.peakDecelG,
    minSpeedKph: row.minSpeedKph,
    exitSpeedKph: row.exitSpeedKph,
    sectorMs: row.sectorMs,
    throttleOnM: row.throttleOnM,
    maxLatG: row.maxLatG,
    frictionCircleMaxG: row.frictionCircleMaxG,
    deltaMs: row.deltaMs,
    qualityOk: row.qualityOk,
  };
}

function mapCornerEnvelope(
  envelope: DemonstratedEnvelope['corners'][number],
): AnalysisExportCornerEnvelope {
  return {
    cornerId: envelope.cornerId,
    latestBrakeStartM: envelope.latestBrakeStartM,
    latestBrakeStartLapNumber: envelope.latestBrakeStartLapNumber,
    earliestBrakeStartM: envelope.earliestBrakeStartM,
    earliestBrakeStartLapNumber: envelope.earliestBrakeStartLapNumber,
    medianBrakeStartM: envelope.medianBrakeStartM,
    earliestLiftM: envelope.earliestLiftM,
    earliestLiftLapNumber: envelope.earliestLiftLapNumber,
    latestLiftM: envelope.latestLiftM,
    latestLiftLapNumber: envelope.latestLiftLapNumber,
    medianLiftM: envelope.medianLiftM,
    highestMinSpeedKph: envelope.highestMinSpeedKph,
    highestMinSpeedLapNumber: envelope.highestMinSpeedLapNumber,
    lowestMinSpeedKph: envelope.lowestMinSpeedKph,
    lowestMinSpeedLapNumber: envelope.lowestMinSpeedLapNumber,
    medianMinSpeedKph: envelope.medianMinSpeedKph,
    highestExitSpeedKph: envelope.highestExitSpeedKph,
    highestExitSpeedLapNumber: envelope.highestExitSpeedLapNumber,
    maxDecelG: envelope.maxDecelG,
    maxLatG: envelope.maxLatG,
    evidenceLapIds: [...envelope.evidenceLapIds],
  };
}

function mapConsistency(
  finding: NonNullable<CornerInsight['consistency']>,
): AnalysisExportConsistency {
  return {
    cornerId: finding.cornerId,
    lapCount: finding.lapCount,
    brakeSpreadM: finding.brakeSpreadM,
    minSpeedSpreadKph: finding.minSpeedSpreadKph,
    sectorSpreadMs: finding.sectorSpreadMs,
    score: finding.score,
    basis: [...finding.basis],
    comparable: finding.comparable,
  };
}

function mapTimeLoss(finding: NonNullable<CornerInsight['timeLoss']>): AnalysisExportTimeLoss {
  return {
    cornerId: finding.cornerId,
    referenceLapNumber: finding.referenceLapNumber,
    comparisonLapNumber: finding.comparisonLapNumber,
    deltaMs: finding.deltaMs,
    sectorLossMs: finding.sectorLossMs,
    bestSectorMs: finding.bestSectorMs,
    bestSectorLapNumber: finding.bestSectorLapNumber,
    comparisonSectorMs: finding.comparisonSectorMs,
    causes: [...finding.causes],
  };
}

/**
 * One corner. `advisorySpeedKph` is deliberately NOT mapped: it is the
 * suggestion-shaped field of the engine's corner model, and a document that
 * says `observationsOnly: true` must not carry a target speed (C7).
 */
function mapCorner(corner: CornerInsight): AnalysisExportCorner {
  return {
    cornerId: corner.cornerId,
    entryDistanceM: corner.entryDistanceM,
    apexDistanceM: corner.apexDistanceM,
    exitDistanceM: corner.exitDistanceM,
    direction: corner.direction,
    severity: corner.severity,
    cleanLapCount: corner.cleanLapCount,
    bestSectorMs: corner.bestSectorMs,
    bestSectorLapNumber: corner.bestSectorLapNumber,
    medianSectorMs: corner.medianSectorMs,
    worstSectorMs: corner.worstSectorMs,
    worstSectorLapNumber: corner.worstSectorLapNumber,
    perLap: corner.perLap.map(mapCornerLap),
    envelope: corner.envelope === null ? null : mapCornerEnvelope(corner.envelope),
    consistency: corner.consistency === null ? null : mapConsistency(corner.consistency),
    timeLoss: corner.timeLoss === null ? null : mapTimeLoss(corner.timeLoss),
  };
}

function mapLap(lap: LapInsight): AnalysisExportLap {
  return {
    lapNumber: lap.lapNumber,
    durationMs: lap.durationMs,
    valid: lap.valid,
    status: lap.status,
    clean: lap.clean,
    reason: lap.reason,
    reasons: [...lap.reasons],
    detail: lap.detail,
    unavailableChecks: [...lap.unavailableChecks],
    coverageFraction: lap.coverageFraction,
    labels: [...lap.labels],
    peakDecelG: lap.peakDecelG,
    yawExcessDps: lap.yawExcessDps,
    absOscillationDetected: lap.absOscillationDetected,
  };
}

function mapAnalysis(insights: SessionInsights): AnalysisExportAnalysis {
  return {
    laps: insights.laps.map(mapLap),
    corners: insights.corners.map(mapCorner),
    timeLossRanking: insights.timeLossRanking.map(mapTimeLoss),
    consistencyRanking: insights.consistencyRanking.map(mapConsistency),
    sectorTimeLoss: insights.sectorTimeLoss.map((entry) => ({
      sectorIndex: entry.sectorIndex,
      referenceLapNumber: entry.referenceLapNumber,
      referenceMs: entry.referenceMs,
      comparisonLapNumber: entry.comparisonLapNumber,
      comparisonMs: entry.comparisonMs,
      lostMs: entry.lostMs,
    })),
    lapTimeConsistency:
      insights.lapTimeConsistency === null
        ? null
        : {
            lapCount: insights.lapTimeConsistency.lapCount,
            bestMs: insights.lapTimeConsistency.bestMs,
            bestLapNumber: insights.lapTimeConsistency.bestLapNumber,
            medianMs: insights.lapTimeConsistency.medianMs,
            worstMs: insights.lapTimeConsistency.worstMs,
            worstLapNumber: insights.lapTimeConsistency.worstLapNumber,
            spreadMs: insights.lapTimeConsistency.spreadMs,
            score: insights.lapTimeConsistency.score,
          },
    envelope: {
      analysisVersion: insights.envelope.analysisVersion,
      cleanLapCount: insights.envelope.cleanLapCount,
      cleanLapIds: [...insights.envelope.cleanLapIds],
      corners: insights.envelope.corners.map(mapCornerEnvelope),
    },
    availability: {
      available: [...insights.availability.available],
      unsupported: [...insights.availability.unsupported],
      missing: [...insights.availability.missing],
    },
    limitations: insights.limitations.map((limitation) => ({
      code: limitation.code,
      ...(limitation.count === undefined ? {} : { count: limitation.count }),
      ...(limitation.channels === undefined ? {} : { channels: [...limitation.channels] }),
      ...(limitation.lapNumbers === undefined ? {} : { lapNumbers: [...limitation.lapNumbers] }),
      ...(limitation.cornerIds === undefined ? {} : { cornerIds: [...limitation.cornerIds] }),
      ...(limitation.checks === undefined ? {} : { checks: [...limitation.checks] }),
      ...(limitation.coveragePercent === undefined
        ? {}
        : { coveragePercent: limitation.coveragePercent }),
      ...(limitation.driftMs === undefined ? {} : { driftMs: limitation.driftMs }),
    })),
  };
}

/** Builds the full JSON document from the screen's own ready state. Pure. */
export function buildAnalysisExportDocument(
  state: ReadyState,
  options: AnalysisExportOptions,
): AnalysisExportDocument {
  const { insights, assembled, source, report, view } = state;
  const trackday = mapTrackday(options.trackday, view.language);
  return {
    kind: ANALYSIS_EXPORT_KIND,
    schemaVersion: ANALYSIS_EXPORT_SCHEMA_VERSION,
    generatedAtUtc: options.generatedAtUtc,
    language: view.language,
    observationsOnly: trackday === null,
    session: {
      sessionId: source.sessionId,
      dateUtc: source.displayDateUtc,
      circuitId: insights.circuitId,
      circuitName: insights.circuitName,
      layoutId: insights.layoutId,
      totalLengthM: insights.totalLengthM,
      geometryValidated: insights.geometryValidated,
      analysisVersion: insights.analysisVersion,
      lapCount: insights.lapCount,
      cleanLapCount: insights.cleanLapCount,
      referenceLapNumber: insights.referenceLapNumber,
      comparisonLapNumber: insights.comparisonLapNumber,
    },
    recording: {
      sampleCount: assembled.sampleCount,
      usedChannels: [...assembled.usedChannels],
      coverage: assembled.coverage.map((entry) => ({
        channel: entry.channel,
        percent: percent(entry.fraction),
        sampleCount: entry.sampleCount,
      })),
      tooSparseChannels: assembled.lowCoverageChannels.map((entry) => ({
        channel: entry.channel,
        percent: percent(entry.fraction),
        sampleCount: entry.sampleCount,
      })),
      perLapCoverage: assembled.perLapCoverage.map((entry) => ({
        lapNumber: entry.lapNumber,
        coverage: entry.coverage.map((row) => ({
          channel: row.channel,
          percent: percent(row.fraction),
          sampleCount: row.sampleCount,
        })),
        excluded: [...entry.excluded],
      })),
      lapsWithoutTrace: assembled.skippedLaps.map((entry) => ({
        lapNumber: entry.lapNumber,
        reason: entry.reason,
      })),
      notes: [...view.notes],
    },
    analysis: mapAnalysis(insights),
    report: {
      title: report.title,
      subtitle: report.subtitle,
      observationsOnlyNote: view.observationsOnly,
      disclaimer: report.disclaimer,
      sections: report.sections.map((section) => ({
        id: section.id,
        heading: section.heading,
        lines: [...section.lines],
      })),
      text: report.text,
    },
    ...(trackday === null ? {} : { trackday }),
  };
}

function seconds(ms: number, language: AnalysisUiLanguage): string {
  const fixed = (ms / 1_000).toFixed(2);
  return `${language === 'ro' ? fixed.replace('.', ',') : fixed} s`;
}

function kph(value: number, language: AnalysisUiLanguage): string {
  const fixed = value.toFixed(1);
  return `${language === 'ro' ? fixed.replace('.', ',') : fixed} km/h`;
}

/**
 * One row per corner: what the ticket asks the screen to show (time loss, min
 * and exit speed) in the compact form a chat message can carry. Every number
 * is the engine's; a corner the engine could not measure prints the "no data"
 * dash rather than a zero.
 */
function cornerRows(doc: AnalysisExportDocument, s: SummaryStrings): string[] {
  const language = doc.language;
  const rows: string[] = [];
  for (const corner of doc.analysis.corners) {
    const reference =
      corner.perLap.find((row) => row.lapNumber === doc.session.comparisonLapNumber) ??
      corner.perLap.find((row) => row.lapNumber === doc.session.referenceLapNumber) ??
      corner.perLap[0];
    const loss = corner.timeLoss?.deltaMs ?? null;
    rows.push(
      `| ${corner.cornerId} | ${loss === null ? s.none : seconds(loss, language)} | ${
        corner.bestSectorMs === null ? s.none : seconds(corner.bestSectorMs, language)
      } | ${
        reference?.minSpeedKph == null ? s.none : kph(reference.minSpeedKph, language)
      } | ${reference?.exitSpeedKph == null ? s.none : kph(reference.exitSpeedKph, language)} |`,
    );
  }
  return rows;
}

/**
 * Hard backstop under every per-section cap: even if each section stayed
 * inside its own limit, many small sections together could still overflow one
 * page. Truncates whole trailing LINES (never mid-line) and appends one marker.
 */
function enforceBudget(lines: readonly string[], s: SummaryStrings): string {
  let kept = [...lines];
  let text = kept.join('\n');
  if (text.length <= ANALYSIS_SUMMARY_MAX_CHARS && kept.length <= ANALYSIS_SUMMARY_MAX_LINES) {
    return text;
  }
  if (kept.length > ANALYSIS_SUMMARY_MAX_LINES - 1) kept = kept.slice(0, ANALYSIS_SUMMARY_MAX_LINES - 1);
  text = kept.join('\n');
  while (text.length > ANALYSIS_SUMMARY_MAX_CHARS - s.truncated.length - 2 && kept.length > 1) {
    kept = kept.slice(0, kept.length - 1);
    text = kept.join('\n');
  }
  return `${text}\n${s.truncated}`;
}

/**
 * The <= 1-page summary: the session header, the engine's own overview, its
 * limitations, one table row per corner, the recording notes and the standing
 * disclaimer -- the same text the screen shows, in the same language. This is
 * where the engine's FULL prose lives (contracts.md R2-2: the screen itself
 * stays interactive and compact).
 */
export function buildAnalysisSummaryMarkdown(doc: AnalysisExportDocument): string {
  const s = ANALYSIS_SUMMARY_STRINGS[doc.language];
  const overview = doc.report.sections.find((section) => section.id === 'overview');
  const limitations = doc.report.sections.find((section) => section.id === 'limitations');
  const header = `${doc.session.circuitName ?? doc.session.circuitId} · ${doc.session.dateUtc.slice(0, 10)}`;

  const lines: string[] = [];
  lines.push(`# ${doc.report.title}`);
  lines.push(`**${s.recordedOn}:** ${header}`);
  lines.push(`_${doc.report.subtitle}_`);
  lines.push(`**${doc.report.observationsOnlyNote}**`);
  lines.push('');

  if (overview !== undefined && overview.lines.length > 0) {
    lines.push(`## ${overview.heading}`);
    for (const line of overview.lines.slice(0, OVERVIEW_LINE_LIMIT)) lines.push(`- ${line}`);
    lines.push('');
  }

  const rows = cornerRows(doc, s);
  if (rows.length > 0) {
    lines.push(`## ${s.observations}`);
    lines.push(s.cornerTableHeader);
    lines.push(s.cornerTableSeparator);
    const shown = rows.slice(0, 20);
    lines.push(...shown);
    if (rows.length > shown.length) lines.push(s.more(rows.length - shown.length));
    lines.push('');
  }

  // Ticket P5c-B D4: the suggestions the driver was SHOWN, and the cues that
  // moved, sit directly under the observations they came from -- so the
  // one-pager reads as "here is what happened, and here is what was suggested
  // inside it", never as advice on its own.
  const trackday = doc.trackday;
  if (trackday !== undefined && trackday.pitSuggestions.length > 0) {
    lines.push(`## ${s.suggestions}`);
    for (const suggestion of trackday.pitSuggestions) lines.push(`- ${suggestion.text}`);
    lines.push('');
  }
  if (trackday !== undefined && trackday.cueUpdates.length > 0) {
    lines.push(`## ${s.cueUpdates}`);
    for (const update of trackday.cueUpdates) lines.push(`- ${update.text}`);
    lines.push('');
  }

  if (limitations !== undefined && limitations.lines.length > 0) {
    lines.push(`## ${limitations.heading}`);
    for (const line of limitations.lines.slice(0, LIMITATION_LINE_LIMIT)) lines.push(`- ${line}`);
    lines.push('');
  }

  if (doc.recording.notes.length > 0) {
    lines.push(`## ${s.notes}`);
    for (const note of doc.recording.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push(`_${doc.report.disclaimer}_`);
  lines.push(`_${s.generated}: ${doc.generatedAtUtc} · ${doc.kind} v${doc.schemaVersion}_`);
  return enforceBudget(lines, s);
}

// ---------------------------------------------------------------------------
// Share (the same never-throws contract as `signalFinderExport.ts`'s own).
// ---------------------------------------------------------------------------

export interface AnalysisShareResult {
  /** True whenever the export succeeded in a user-facing sense — the unavailable-platform fallback included. */
  ok: boolean;
  /** True only when the OS share sheet was genuinely invoked. */
  shared: boolean;
  markdownUri: string | null;
  jsonUri: string | null;
  markdownLength: number;
  jsonLength: number;
  error?: string;
}

/**
 * One tap: writes BOTH files -- whether or not a share sheet exists on this
 * platform (P5b-FIX1 C8) -- and hands the `.md` to the sheet, because the
 * human-readable half is what the user forwards. `expo-sharing` shares exactly
 * one file per call, so the JSON's uri comes back for {@link shareAnalysisJson},
 * the second control, and the button label says the JSON was written alongside.
 * Never throws.
 */
export async function shareAnalysisExport(doc: AnalysisExportDocument): Promise<AnalysisShareResult> {
  const markdown = buildAnalysisSummaryMarkdown(doc);
  const json = JSON.stringify(doc, null, 2);
  try {
    const markdownFile = new File(Paths.cache, analysisExportFileName(doc, 'md'));
    markdownFile.write(markdown);
    const jsonFile = new File(Paths.cache, analysisExportFileName(doc, 'json'));
    jsonFile.write(json);

    const available = await Sharing.isAvailableAsync();
    if (!available) {
      console.log(
        `[analysisExport] Sharing unavailable on this platform (e.g. web preview) -- summary ${markdown.length} bytes, JSON ${json.length} bytes, both written to the cache`,
      );
      return {
        ok: true,
        shared: false,
        markdownUri: markdownFile.uri,
        jsonUri: jsonFile.uri,
        markdownLength: markdown.length,
        jsonLength: json.length,
      };
    }
    await Sharing.shareAsync(markdownFile.uri, {
      mimeType: 'text/markdown',
      dialogTitle: doc.report.title,
    });
    return {
      ok: true,
      shared: true,
      markdownUri: markdownFile.uri,
      jsonUri: jsonFile.uri,
      markdownLength: markdown.length,
      jsonLength: json.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[analysisExport] export failed (falling back) -- summary is ${markdown.length} bytes: ${message}`);
    return {
      ok: false,
      shared: false,
      markdownUri: null,
      jsonUri: null,
      markdownLength: markdown.length,
      jsonLength: json.length,
      error: message,
    };
  }
}

/** The second control: shares the full JSON on its own. Never throws. */
export async function shareAnalysisJson(doc: AnalysisExportDocument): Promise<AnalysisShareResult> {
  const json = JSON.stringify(doc, null, 2);
  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      console.log(`[analysisExport] Sharing unavailable on this platform -- JSON is ${json.length} bytes`);
      return { ok: true, shared: false, markdownUri: null, jsonUri: null, markdownLength: 0, jsonLength: json.length };
    }
    const file = new File(Paths.cache, analysisExportFileName(doc, 'json'));
    file.write(json);
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      dialogTitle: doc.report.title,
    });
    return { ok: true, shared: true, markdownUri: null, jsonUri: file.uri, markdownLength: 0, jsonLength: json.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[analysisExport] JSON export failed (falling back) -- JSON is ${json.length} bytes: ${message}`);
    return {
      ok: false,
      shared: false,
      markdownUri: null,
      jsonUri: null,
      markdownLength: 0,
      jsonLength: json.length,
      error: message,
    };
  }
}
