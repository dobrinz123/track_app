import { describe, expect, it, vi } from 'vitest';

// The same expo doubles the other export tests install -- the real modules'
// Flow-typed sources cannot be parsed by this runner.
vi.mock('expo-file-system', () => ({
  Paths: { cache: {} },
  File: class {
    readonly uri: string;
    constructor(_directory: unknown, name: string) {
      this.uri = `file:///cache/${name}`;
    }
    write(_contents: string): void {}
  },
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: async () => undefined,
}));

import {
  ANALYSIS_EXPORT_SCHEMA_VERSION,
  buildAnalysisExportDocument,
} from '../../src/session/analysisExport';
import { buildAnalysisScreenState, createAnalysisRunner } from '../../src/session/analysisViewModel';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P5-FIX2 W3 (Codex P5-REV finding 15, MEDIUM): the export DTO carries
 * the P5c STRUCTURED facts, not only the localized prose.
 *
 * Schema 3 stated the R2-1 lap labels (HEAVY_BRAKING / ABS_SUSPECTED /
 * SLIDE_ROTATION) and the per-lap channel exclusions only inside sentences, so
 * a tool reading the JSON could not tell WHICH lap carried which label, on what
 * measured value, or which channel was dropped from which lap. Schema 4 adds
 * both, with their numbers, alongside the prose that stays.
 */

const GENERATED_AT = '2026-08-30T21:04:00.000Z';
const SESSION_DATE = '2026-08-29T09:15:00.000Z';

async function readyState(language: 'ro' | 'en' = 'en') {
  const { circuit } = allBundledCircuits()[0]!;
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

describe('P5-FIX2 W3 -- export schema 4 pins the structured facts', () => {
  it('is schema 4 and pins the per-lap key shape', async () => {
    const state = await readyState();
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });

    expect(ANALYSIS_EXPORT_SCHEMA_VERSION).toBe(4);
    expect(doc.schemaVersion).toBe(4);
    expect(Object.keys(doc.analysis.laps[0]!).sort()).toEqual(
      [
        'absOscillationDetected',
        'clean',
        'coverageFraction',
        'detail',
        'durationMs',
        'labels',
        'lapNumber',
        'peakDecelG',
        'reason',
        'reasons',
        'status',
        'unavailableChecks',
        'valid',
        'yawExcessDps',
      ].sort(),
    );
    expect(Object.keys(doc.recording).sort()).toEqual(
      [
        'coverage',
        'lapsWithoutTrace',
        'notes',
        'perLapCoverage',
        'sampleCount',
        'tooSparseChannels',
        'usedChannels',
      ].sort(),
    );
    expect(Object.keys(doc.recording.perLapCoverage[0]!).sort()).toEqual(
      ['coverage', 'excluded', 'lapNumber'].sort(),
    );
  });

  it('carries every lap label with the measured value it stands on', async () => {
    const state = await readyState();
    const labelled = {
      ...state.insights,
      laps: state.insights.laps.map((lap, index) =>
        index === 0
          ? {
              ...lap,
              labels: ['HEAVY_BRAKING' as const, 'ABS_SUSPECTED' as const],
              peakDecelG: 1.42,
              yawExcessDps: 12.5,
              absOscillationDetected: true,
            }
          : lap,
      ),
    };
    const doc = buildAnalysisExportDocument(
      { ...state, insights: labelled },
      { generatedAtUtc: GENERATED_AT },
    );

    const first = doc.analysis.laps[0]!;
    expect(first.labels).toEqual(['HEAVY_BRAKING', 'ABS_SUSPECTED']);
    expect(first.peakDecelG).toBe(1.42);
    expect(first.yawExcessDps).toBe(12.5);
    expect(first.absOscillationDetected).toBe(true);
    // Every lap is mapped from the engine's own values, never invented.
    for (const [index, lap] of doc.analysis.laps.entries()) {
      const source = labelled.laps[index]!;
      expect(lap.labels).toEqual(source.labels);
      expect(lap.peakDecelG).toBe(source.peakDecelG);
      expect(lap.yawExcessDps).toBe(source.yawExcessDps);
      expect(lap.absOscillationDetected).toBe(source.absOscillationDetected);
    }
    // A label is NOT an exclusion (R2-1): the labelled lap keeps its status.
    expect(first.status).toBe(labelled.laps[0]!.status);
  });

  it('states per-lap channel coverage and exclusions, not only the prose', async () => {
    const state = await readyState();
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });

    expect(doc.recording.perLapCoverage.map((entry) => entry.lapNumber)).toEqual(
      state.assembled.perLapCoverage.map((entry) => entry.lapNumber),
    );
    for (const [index, entry] of doc.recording.perLapCoverage.entries()) {
      const source = state.assembled.perLapCoverage[index]!;
      expect(entry.excluded).toEqual(source.excluded);
      expect(entry.coverage.map((row) => row.channel)).toEqual(
        source.coverage.map((row) => row.channel),
      );
      for (const [position, row] of entry.coverage.entries()) {
        expect(row.percent).toBe(Math.round(source.coverage[position]!.fraction * 100));
        expect(row.sampleCount).toBe(source.coverage[position]!.sampleCount);
      }
    }
    expect(doc.recording.perLapCoverage.length).toBeGreaterThan(0);
  });

  it('stays observations-only and language-independent in its structured half', async () => {
    const ro = await readyState('ro');
    const en = await readyState('en');
    const roDoc = buildAnalysisExportDocument(ro, { generatedAtUtc: GENERATED_AT });
    const enDoc = buildAnalysisExportDocument(en, { generatedAtUtc: GENERATED_AT });

    expect(roDoc.observationsOnly).toBe(true);
    expect(JSON.stringify(roDoc.analysis.laps.map((lap) => lap.labels))).toBe(
      JSON.stringify(enDoc.analysis.laps.map((lap) => lap.labels)),
    );
    expect(roDoc.recording.perLapCoverage).toEqual(enDoc.recording.perLapCoverage);
    const json = JSON.stringify(roDoc);
    expect(json).not.toMatch(/advisorySpeedKph/);
    expect(json).not.toMatch(/undefined/);
  });
});
