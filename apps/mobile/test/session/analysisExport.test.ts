import { describe, expect, it, vi } from 'vitest';

// `analysisExport.ts` writes files and opens the OS share sheet through the
// real expo modules, whose Flow-typed sources this runner cannot parse -- the
// same doubles `signalFinderExport.test.ts` installs.
const writes: { name: string; contents: string }[] = [];
vi.mock('expo-file-system', () => ({
  Paths: { cache: {} },
  File: class {
    readonly uri: string;
    constructor(_directory: unknown, name: string) {
      this.uri = `file:///cache/${name}`;
      writes.push({ name, contents: '' });
    }
    write(contents: string): void {
      const entry = writes[writes.length - 1];
      if (entry !== undefined) entry.contents = contents;
    }
  },
}));
const shareAsync = vi.fn(async (_uri: string, _options: unknown) => undefined);
const isAvailableAsync = vi.fn(async () => true);
vi.mock('expo-sharing', () => ({
  isAvailableAsync: () => isAvailableAsync(),
  shareAsync: (uri: string, options: unknown) => shareAsync(uri, options),
}));

import {
  ANALYSIS_EXPORT_KIND,
  ANALYSIS_EXPORT_SCHEMA_VERSION,
  ANALYSIS_SUMMARY_MAX_CHARS,
  ANALYSIS_SUMMARY_MAX_LINES,
  ANALYSIS_SUMMARY_STRINGS,
  analysisExportFileName,
  buildAnalysisExportDocument,
  buildAnalysisSummaryMarkdown,
  shareAnalysisExport,
  shareAnalysisJson,
} from '../../src/session/analysisExport';
import { buildAnalysisScreenState, createAnalysisRunner } from '../../src/session/analysisViewModel';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

const GENERATED_AT = '2026-08-30T21:04:00.000Z';
const SESSION_DATE = '2026-08-29T09:15:00.000Z';

async function readyState(circuitIndex: number, language: 'ro' | 'en') {
  const { circuit } = allBundledCircuits()[circuitIndex]!;
  const session = driveSession(circuit, { laps: 4, channels: 'full' });
  const runner = createAnalysisRunner({
    loadSession: async () => ({
      sessionId: session.sessionId,
      circuit,
      displayDateUtc: SESSION_DATE,
      recordings: session.recordings,
    }),
    isSessionActive: () => false,
  });
  const state = buildAnalysisScreenState(await runner.run(session.sessionId), language);
  if (state.status !== 'ready') throw new Error(`expected a ready state, got ${state.status}`);
  return state;
}

describe('P5b B4 -- the exported analysis report', () => {
  it('names both files trace-analysis-<circuit>-<date>', async () => {
    const state = await readyState(0, 'en');
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });
    expect(analysisExportFileName(doc, 'json')).toBe(
      `trace-analysis-${doc.session.circuitId}-2026-08-29.json`,
    );
    expect(analysisExportFileName(doc, 'md')).toBe(
      `trace-analysis-${doc.session.circuitId}-2026-08-29.md`,
    );
  });

  it('is schemaVersion 1 of trace-analysis-report and carries the engine outputs', async () => {
    const state = await readyState(0, 'en');
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });

    expect(doc.kind).toBe(ANALYSIS_EXPORT_KIND);
    expect(ANALYSIS_EXPORT_KIND).toBe('trace-analysis-report');
    expect(doc.schemaVersion).toBe(ANALYSIS_EXPORT_SCHEMA_VERSION);
    expect(ANALYSIS_EXPORT_SCHEMA_VERSION).toBe(1);
    expect(doc.observationsOnly).toBe(true);
    expect(doc.generatedAtUtc).toBe(GENERATED_AT);

    expect(doc.session.circuitId).toBe(state.insights.circuitId);
    expect(doc.session.lapCount).toBe(state.insights.lapCount);
    expect(doc.session.cleanLapCount).toBe(state.insights.cleanLapCount);
    expect(doc.session.geometryValidated).toBe(state.insights.geometryValidated);

    // The whole engine output, not a lossy re-shaping of it.
    expect(doc.insights.corners).toHaveLength(state.insights.corners.length);
    expect(doc.insights.limitations).toEqual(state.insights.limitations);
    expect(doc.insights.availability).toEqual(state.insights.availability);
    expect(doc.insights.envelope).toEqual(state.insights.envelope);
    expect(doc.insights.timeLossRanking).toEqual(state.insights.timeLossRanking);

    // ... and what the recording itself could and could not support.
    expect(doc.recording.usedChannels).toEqual(state.assembled.usedChannels);
    expect(doc.recording.sampleCount).toBe(state.assembled.sampleCount);

    // Serialisable as it stands (this is what the share writes).
    expect(() => JSON.stringify(doc)).not.toThrow();
    expect(JSON.stringify(doc)).not.toMatch(/undefined/);
  });

  it('writes a <= 1-page summary carrying the same text the screen shows', async () => {
    for (const language of ['en', 'ro'] as const) {
      const state = await readyState(0, language);
      const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });
      const markdown = buildAnalysisSummaryMarkdown(doc);
      const lines = markdown.split('\n');

      expect(lines.length).toBeLessThanOrEqual(ANALYSIS_SUMMARY_MAX_LINES);
      expect(markdown.length).toBeLessThanOrEqual(ANALYSIS_SUMMARY_MAX_CHARS);

      // Session header + the engine's own overview text + limitations + a
      // per-corner table + the disclaimer.
      expect(markdown).toContain(state.view.header);
      expect(markdown).toContain(state.view.overview[0]!);
      expect(markdown).toContain(ANALYSIS_SUMMARY_STRINGS[language].cornerTableHeader);
      expect(markdown).toContain(state.view.disclaimer);
      expect(markdown).toContain(state.view.observationsOnly);
      for (const limitation of state.view.limitations.slice(0, 3)) {
        expect(markdown).toContain(limitation);
      }
      expect(markdown).not.toMatch(/NaN|undefined/);
    }
  });

  it('keeps the summary inside one page even with every corner of a long circuit', async () => {
    for (const [index] of allBundledCircuits().entries()) {
      const state = await readyState(index, 'ro');
      const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });
      const markdown = buildAnalysisSummaryMarkdown(doc);
      expect(markdown.split('\n').length).toBeLessThanOrEqual(ANALYSIS_SUMMARY_MAX_LINES);
      expect(markdown.length).toBeLessThanOrEqual(ANALYSIS_SUMMARY_MAX_CHARS);
    }
  });

  it('RO carries every summary label EN does', () => {
    const en = ANALYSIS_SUMMARY_STRINGS.en as unknown as Record<string, unknown>;
    const ro = ANALYSIS_SUMMARY_STRINGS.ro as unknown as Record<string, unknown>;
    expect(Object.keys(ro).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) expect(typeof ro[key]).toBe(typeof en[key]);
  });

  it('one tap writes both files and shares the summary; never throws', async () => {
    writes.length = 0;
    shareAsync.mockClear();
    isAvailableAsync.mockResolvedValue(true);
    const state = await readyState(0, 'en');
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });

    const result = await shareAnalysisExport(doc);
    expect(result.ok).toBe(true);
    expect(result.shared).toBe(true);
    expect(writes.map((entry) => entry.name)).toEqual([
      `trace-analysis-${doc.session.circuitId}-2026-08-29.md`,
      `trace-analysis-${doc.session.circuitId}-2026-08-29.json`,
    ]);
    expect(result.markdownUri).toContain('.md');
    expect(result.jsonUri).toContain('.json');
    expect(shareAsync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writes[1]!.contents).kind).toBe(ANALYSIS_EXPORT_KIND);
  });

  it('degrades honestly where sharing is unavailable, and when it throws', async () => {
    const state = await readyState(0, 'en');
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });

    isAvailableAsync.mockResolvedValue(false);
    const unavailable = await shareAnalysisExport(doc);
    expect(unavailable.ok).toBe(true);
    expect(unavailable.shared).toBe(false);
    expect(unavailable.markdownLength).toBeGreaterThan(0);

    isAvailableAsync.mockResolvedValue(true);
    shareAsync.mockRejectedValueOnce(new Error('share sheet exploded'));
    const failed = await shareAnalysisJson(doc);
    expect(failed.ok).toBe(false);
    expect(failed.shared).toBe(false);
    expect(failed.error).toContain('share sheet exploded');
    isAvailableAsync.mockResolvedValue(true);
  });
});
