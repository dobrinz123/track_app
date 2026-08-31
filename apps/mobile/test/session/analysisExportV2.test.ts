import { describe, expect, it, vi } from 'vitest';

// The same expo doubles `analysisExport.test.ts` installs -- the real modules'
// Flow-typed sources cannot be parsed by this runner.
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
  ANALYSIS_EXPORT_SCHEMA_VERSION,
  analysisExportFileName,
  buildAnalysisExportDocument,
  buildAnalysisSummaryMarkdown,
  shareAnalysisExport,
} from '../../src/session/analysisExport';
import { buildAnalysisScreenState, createAnalysisRunner } from '../../src/session/analysisViewModel';
import { ANALYSIS_SCREEN_STRINGS } from '../../src/ui/screens/analysisStrings';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P5b-FIX1 C7/C8/C9 (Codex P5b-REV1 findings 7, 8, 9, 10):
 *
 *  - the export is a STANDALONE, versioned DTO explicitly mapped from the
 *    engine outputs, so a change inside `@circuit/core` cannot silently change
 *    the exported shape (this test pins that shape);
 *  - advisory / suggestion-derived fields are OMITTED in V1 (observations only);
 *  - one tap writes both files, the second control shares the JSON;
 *  - every dynamic filename segment goes through one sanitizer.
 */

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

describe('P5b-FIX1 C7 -- a standalone, versioned export DTO', () => {
  it('is the current schema version (4 as of P5-FIX2) and pins its own key shape', async () => {
    const state = await readyState(0, 'en');
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });

    expect(ANALYSIS_EXPORT_SCHEMA_VERSION).toBe(4);
    expect(doc.schemaVersion).toBe(4);
    expect(Object.keys(doc).sort()).toEqual(
      [
        'analysis',
        'generatedAtUtc',
        'kind',
        'language',
        'observationsOnly',
        'recording',
        'report',
        'schemaVersion',
        'session',
      ].sort(),
    );
    // The engine type is no longer re-exported wholesale.
    expect('insights' in doc).toBe(false);

    expect(Object.keys(doc.analysis).sort()).toEqual(
      [
        'availability',
        'consistencyRanking',
        'corners',
        'envelope',
        'lapTimeConsistency',
        'laps',
        'limitations',
        'sectorTimeLoss',
        'timeLossRanking',
      ].sort(),
    );
    expect(Object.keys(doc.analysis.corners[0]!).sort()).toEqual(
      [
        'apexDistanceM',
        'bestSectorLapNumber',
        'bestSectorMs',
        'cleanLapCount',
        'consistency',
        'cornerId',
        'direction',
        'entryDistanceM',
        'envelope',
        'exitDistanceM',
        'medianSectorMs',
        'perLap',
        'severity',
        'timeLoss',
        'worstSectorLapNumber',
        'worstSectorMs',
      ].sort(),
    );
    expect(Object.keys(doc.analysis.corners[0]!.perLap[0]!).sort()).toEqual(
      [
        'brakeOnsetUncertaintyM',
        'brakeSource',
        'brakeStartM',
        'clean',
        'deltaMs',
        'exitSpeedKph',
        'frictionCircleMaxG',
        'lapNumber',
        'liftPointM',
        'liftSource',
        'maxLatG',
        'minSpeedKph',
        'peakDecelG',
        'qualityOk',
        'sectorMs',
        'throttleOnM',
      ].sort(),
    );
  });

  it('omits every advisory / suggestion-derived field (V1 is observations only)', async () => {
    const state = await readyState(0, 'en');
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });
    const json = JSON.stringify(doc);
    expect(doc.observationsOnly).toBe(true);
    expect(json).not.toMatch(/advisorySpeedKph/);
    expect(json).not.toMatch(/suggest/i);
    expect(json).not.toMatch(/undefined/);
    for (const corner of doc.analysis.corners) {
      expect('advisorySpeedKph' in corner).toBe(false);
    }
  });

  it('maps the engine values through faithfully, corner for corner', async () => {
    const state = await readyState(0, 'en');
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });
    expect(doc.analysis.corners).toHaveLength(state.insights.corners.length);
    for (const [index, corner] of doc.analysis.corners.entries()) {
      const source = state.insights.corners[index]!;
      expect(corner.cornerId).toBe(source.cornerId);
      expect(corner.bestSectorMs).toBe(source.bestSectorMs);
      expect(corner.perLap).toHaveLength(source.perLap.length);
      expect(corner.perLap[0]!.minSpeedKph).toBe(source.perLap[0]!.minSpeedKph);
    }
    expect(doc.analysis.limitations).toEqual(state.insights.limitations);
    expect(doc.analysis.laps.map((lap) => lap.lapNumber)).toEqual(
      state.insights.laps.map((lap) => lap.lapNumber),
    );
    // The one-page summary still renders from the DTO alone.
    expect(buildAnalysisSummaryMarkdown(doc)).toContain(state.view.header);
  });
});

describe('P5b-FIX1 C8 -- one tap hands over both files', () => {
  it('writes the summary AND the JSON in a single action, and shares the summary', async () => {
    writes.length = 0;
    shareAsync.mockClear();
    isAvailableAsync.mockResolvedValue(true);
    const state = await readyState(0, 'en');
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });

    const result = await shareAnalysisExport(doc);
    expect(result.ok).toBe(true);
    expect(result.shared).toBe(true);
    expect(result.markdownUri).toContain('.md');
    expect(result.jsonUri).toContain('.json');
    expect(writes).toHaveLength(2);
    expect(shareAsync).toHaveBeenCalledTimes(1);
  });

  it('still writes both files where the share sheet is unavailable', async () => {
    writes.length = 0;
    isAvailableAsync.mockResolvedValue(false);
    const state = await readyState(0, 'en');
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });

    const result = await shareAnalysisExport(doc);
    expect(result.ok).toBe(true);
    expect(result.shared).toBe(false);
    expect(writes.map((entry) => entry.name.split('.').pop())).toEqual(['md', 'json']);
    expect(writes.every((entry) => entry.contents.length > 0)).toBe(true);
    expect(result.jsonUri).toContain('.json');
    isAvailableAsync.mockResolvedValue(true);
  });

  it('says on the button itself that the JSON is written alongside, in both languages', () => {
    for (const language of ['en', 'ro'] as const) {
      const strings = ANALYSIS_SCREEN_STRINGS[language];
      expect(strings.share.toLowerCase()).toContain('json');
      // ... and the second control that shares it stays.
      expect(strings.shareJson.toLowerCase()).toContain('json');
      expect(strings.shareDone.toLowerCase()).toContain('json');
    }
  });
});

describe('P5b-FIX1 C9 -- one filename sanitizer for every dynamic segment', () => {
  it('normalises the date and sanitises the circuit id', async () => {
    const state = await readyState(0, 'en');
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });
    const malformed = {
      ...doc,
      session: { ...doc.session, circuitId: '../../etc/pass wd', dateUtc: '2026/08/29 09:15' },
    };
    for (const ext of ['md', 'json'] as const) {
      const name = analysisExportFileName(malformed, ext);
      expect(name).not.toMatch(/[/\\:*?"<>| ]/);
      expect(name).toBe(`trace-analysis-etc-pass-wd-2026-08-29.${ext}`);
    }

    const undated = { ...doc, session: { ...doc.session, dateUtc: 'not a date' } };
    expect(analysisExportFileName(undated, 'json')).toMatch(/^trace-analysis-[a-z0-9-]+\.json$/);
  });
});
