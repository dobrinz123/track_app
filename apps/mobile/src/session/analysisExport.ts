import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { CoachingChannelId, SessionInsights } from '@circuit/core';

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
 * The share MACHINERY is `signalFinderExport.ts`'s, deliberately: the same
 * expo-file-system v57 class API (`File`/`Paths`, `write()` is SYNCHRONOUS),
 * the same single `expo-sharing` call, and the same never-throws contract (an
 * unavailable share sheet logs and reports `shared: false`).
 *
 * Naming follows the P5b ticket's own literal pattern,
 * `trace-analysis-<circuit>-<date>`, with the SESSION's date rather than the
 * export's: two exports of the same drive are the same report, and the file
 * name is what the user recognises in a chat thread.
 *
 * Nothing in the summary is written by this module about the DRIVING -- every
 * observation line comes from the engine's own localised report, carried here
 * through the screen's view model. What this module owns is the frame: table
 * headers, section captions and the one-page budget.
 */

export const ANALYSIS_EXPORT_SCHEMA_VERSION = 1;
export const ANALYSIS_EXPORT_KIND = 'trace-analysis-report';

export interface AnalysisExportChannelCoverage {
  channel: CoachingChannelId;
  percent: number;
  sampleCount: number;
}

export interface AnalysisExportDocument {
  kind: typeof ANALYSIS_EXPORT_KIND;
  schemaVersion: typeof ANALYSIS_EXPORT_SCHEMA_VERSION;
  generatedAtUtc: string;
  language: AnalysisUiLanguage;
  /** V1 is observations only (contracts.md "Phase 5 REVISION"); no suggestion exists to export. */
  observationsOnly: true;
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
    lapsWithoutTrace: { lapNumber: number; reason: string }[];
    notes: string[];
  };
  /** The engine's own output, whole. */
  insights: SessionInsights;
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
}

interface SummaryStrings {
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

/** `trace-analysis-<circuit>-<yyyy-mm-dd>.<ext>` (the ticket's own exact pattern). */
export function analysisExportFileName(
  doc: AnalysisExportDocument,
  ext: 'json' | 'md',
): string {
  const circuit = doc.session.circuitId.replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase();
  return `${ANALYSIS_EXPORT_KIND.replace(/-report$/, '')}-${circuit}-${doc.session.dateUtc.slice(0, 10)}.${ext}`;
}

export interface AnalysisExportOptions {
  /** ISO-8601 UTC instant the export was produced (injected, never `Date.now()` inside). */
  generatedAtUtc: string;
}

/** Builds the full JSON document from the screen's own ready state. Pure. */
export function buildAnalysisExportDocument(
  state: ReadyState,
  options: AnalysisExportOptions,
): AnalysisExportDocument {
  const { insights, assembled, source, report, view } = state;
  return {
    kind: ANALYSIS_EXPORT_KIND,
    schemaVersion: ANALYSIS_EXPORT_SCHEMA_VERSION,
    generatedAtUtc: options.generatedAtUtc,
    language: view.language,
    observationsOnly: true,
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
      lapsWithoutTrace: assembled.skippedLaps.map((entry) => ({
        lapNumber: entry.lapNumber,
        reason: entry.reason,
      })),
      notes: [...view.notes],
    },
    insights,
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
  for (const corner of doc.insights.corners) {
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
 * disclaimer -- the same text the screen shows, in the same language.
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
 * One tap: writes BOTH files and hands the `.md` to the share sheet (the
 * human-readable half is what the user forwards). The JSON's uri comes back so
 * the screen can offer {@link shareAnalysisJson} as a second button --
 * `expo-sharing` shares exactly one file per call. Never throws.
 */
export async function shareAnalysisExport(doc: AnalysisExportDocument): Promise<AnalysisShareResult> {
  const markdown = buildAnalysisSummaryMarkdown(doc);
  const json = JSON.stringify(doc, null, 2);
  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      console.log(
        `[analysisExport] Sharing unavailable on this platform (e.g. web preview) -- summary ${markdown.length} bytes, JSON ${json.length} bytes`,
      );
      return {
        ok: true,
        shared: false,
        markdownUri: null,
        jsonUri: null,
        markdownLength: markdown.length,
        jsonLength: json.length,
      };
    }
    const markdownFile = new File(Paths.cache, analysisExportFileName(doc, 'md'));
    markdownFile.write(markdown);
    const jsonFile = new File(Paths.cache, analysisExportFileName(doc, 'json'));
    jsonFile.write(json);
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

/** The second button: shares the full JSON on its own. Never throws. */
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
