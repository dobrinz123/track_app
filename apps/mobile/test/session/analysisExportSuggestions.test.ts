import { describe, expect, it, vi } from 'vitest';

// The same expo doubles the other export tests install.
vi.mock('expo-file-system', () => ({
  Paths: { cache: {} },
  File: class {
    readonly uri = 'file:///cache/x';
    write(): void {}
  },
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: async () => undefined,
}));

import {
  MAX_BRAKE_LATER_M,
  MAX_MIN_SPEED_GAIN_KPH,
  type AppliedCueUpdate,
  type PitSuggestion,
} from '@circuit/core';

import {
  ANALYSIS_EXPORT_SCHEMA_VERSION,
  buildAnalysisExportDocument,
  buildAnalysisSummaryMarkdown,
} from '../../src/session/analysisExport';
import { buildAnalysisScreenState, createAnalysisRunner } from '../../src/session/analysisViewModel';
import { bundled, driveSession, TMR_CIRCUIT_ID } from '../support/analysisHarness';

/**
 * Ticket P5c-B D4/D5 — the final export carries the trackday record: the pit
 * suggestions that were actually SHOWN (marked as suggestions, never as
 * observations) and the cue updates applied during the session with their
 * before/after and the lap that demonstrated each one.
 *
 * With the stage off — the default — the document is exactly what it was
 * before this ticket, minus nothing and plus nothing.
 */

const GENERATED_AT = '2026-08-31T18:00:00.000Z';
const SESSION_DATE = '2026-08-31T09:15:00.000Z';

const CUE_UPDATE: AppliedCueUpdate = {
  cornerId: 4,
  point: 'brake',
  fromM: 210,
  toM: 202,
  movedLaterM: 8,
  demonstratedM: 200,
  evidenceLapNumber: 2,
  cleanLapCount: 3,
  appliedAtMono: 12_345,
  appliedAfterLapNumber: 3,
};

const SUGGESTION: PitSuggestion = {
  cornerId: 4,
  kind: 'brakeLater',
  unit: 'm',
  typicalValue: 214,
  demonstratedValue: 200,
  targetValue: 204,
  deltaValue: 10,
  evidenceLapNumber: 2,
  cleanLapCount: 3,
  timeLossMs: 380,
};

async function readyState(language: 'ro' | 'en') {
  const circuit = bundled(TMR_CIRCUIT_ID);
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
  if (state.status !== 'ready') throw new Error(`expected ready, got ${state.status}`);
  return state;
}

describe('analysis export — the trackday record (D4)', () => {
  it('is schemaVersion 3 and omits the trackday block entirely when nothing was suggested', async () => {
    const state = await readyState('en');
    const doc = buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT });
    expect(ANALYSIS_EXPORT_SCHEMA_VERSION).toBe(3);
    expect(doc.schemaVersion).toBe(3);
    expect(doc.trackday).toBeUndefined();
    expect(doc.observationsOnly).toBe(true);
    expect(JSON.stringify(doc)).not.toMatch(/suggest/i);
  });

  it('carries the shown suggestions and the applied cue updates, marked as suggestions', async () => {
    const state = await readyState('en');
    const doc = buildAnalysisExportDocument(state, {
      generatedAtUtc: GENERATED_AT,
      trackday: { cueUpdates: [CUE_UPDATE], pitSuggestions: [SUGGESTION] },
    });
    expect(doc.observationsOnly).toBe(false);
    expect(doc.trackday?.bounds).toEqual({
      maxBrakeLaterM: MAX_BRAKE_LATER_M,
      maxMinSpeedGainKph: MAX_MIN_SPEED_GAIN_KPH,
      maxChangesPerCornerPerStint: 1,
    });
    const update = doc.trackday?.cueUpdates[0];
    expect(update).toMatchObject({
      cornerId: 4,
      point: 'brake',
      fromM: 210,
      toM: 202,
      demonstratedM: 200,
      evidenceLapNumber: 2,
      appliedAfterLapNumber: 3,
    });
    expect(update?.text.length).toBeGreaterThan(0);
    const suggestion = doc.trackday?.pitSuggestions[0];
    expect(suggestion).toMatchObject({
      cornerId: 4,
      kind: 'brakeLater',
      unit: 'm',
      demonstratedValue: 200,
      targetValue: 204,
      evidenceLapNumber: 2,
      shown: true,
    });
    expect(suggestion?.text).toContain('lap 2');
    expect(JSON.stringify(doc)).not.toMatch(/undefined/);
  });

  it('never exports a target beyond the demonstrated envelope', async () => {
    const state = await readyState('en');
    const doc = buildAnalysisExportDocument(state, {
      generatedAtUtc: GENERATED_AT,
      trackday: { cueUpdates: [CUE_UPDATE], pitSuggestions: [SUGGESTION] },
    });
    for (const update of doc.trackday?.cueUpdates ?? []) {
      expect(update.toM).toBeGreaterThanOrEqual(update.demonstratedM);
      expect(update.fromM - update.toM).toBeLessThanOrEqual(MAX_BRAKE_LATER_M);
    }
    for (const suggestion of doc.trackday?.pitSuggestions ?? []) {
      if (suggestion.unit === 'm') {
        expect(suggestion.targetValue).toBeGreaterThanOrEqual(suggestion.demonstratedValue);
      } else {
        expect(suggestion.targetValue).toBeLessThanOrEqual(suggestion.demonstratedValue);
      }
    }
  });

  it('adds a suggestions section to the one-page summary, in the report language', async () => {
    const state = await readyState('ro');
    const doc = buildAnalysisExportDocument(state, {
      generatedAtUtc: GENERATED_AT,
      trackday: { cueUpdates: [CUE_UPDATE], pitSuggestions: [SUGGESTION] },
    });
    const markdown = buildAnalysisSummaryMarkdown(doc);
    expect(markdown).toContain('Sugestii');
    expect(markdown).toContain('turul 2');
    expect(markdown).not.toContain('undefined');
  });

  it('leaves the summary untouched when nothing was suggested', async () => {
    const state = await readyState('en');
    const withoutTrackday = buildAnalysisSummaryMarkdown(
      buildAnalysisExportDocument(state, { generatedAtUtc: GENERATED_AT }),
    );
    expect(withoutTrackday).not.toMatch(/suggest/i);
  });
});
