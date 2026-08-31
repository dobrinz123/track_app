import { describe, expect, it, vi } from 'vitest';

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

import type { ActiveCue } from '@circuit/core';

import { buildAnalysisExportDocument } from '../../src/session/analysisExport';
import { buildAnalysisScreenState, createAnalysisRunner } from '../../src/session/analysisViewModel';
import { buildPitViewState } from '../../src/session/pitViewModel';
import { DEFAULT_SETTINGS } from '../../src/session/settingsStore';
import {
  createStintCoach,
  createStintRunner,
  createSuggestionJournal,
} from '../../src/session/stintCoaching';
import { bundled, driveSession, TMR_CIRCUIT_ID } from '../support/analysisHarness';

/**
 * Ticket P5c-B D5, the binding one: with `suggestionsEnabled` OFF — the
 * shipped default — the trackday stage is INVISIBLE. Not "produces empty
 * lists": it does not read the recording at a lap boundary, does not call the
 * cue source, contributes nothing to the export, and leaves the post-session
 * report observations-only exactly as P5b shipped it.
 *
 * This is a snapshot rather than a list of assertions on purpose: the whole
 * point is that NOTHING about the off state may drift, so any future change
 * has to come through this file and be looked at.
 */

const SESSION_ID = 'off-session';
const GENERATED_AT = '2026-08-31T18:00:00.000Z';
const SESSION_DATE = '2026-08-31T09:15:00.000Z';

const CUES: ActiveCue[] = [{ cornerId: 1, brakeStartM: 400, liftPointM: 400 }];

async function offStateSummary() {
  const circuit = bundled(TMR_CIRCUIT_ID);
  const driven = driveSession(circuit, { laps: 4, channels: 'full' });
  const source = {
    sessionId: SESSION_ID,
    circuit,
    displayDateUtc: SESSION_DATE,
    recordings: driven.recordings,
  };

  let reads = 0;
  let cueApplyCalls = 0;
  const runner = createStintRunner({
    loadCompletedLaps: async () => {
      reads += 1;
      return source;
    },
    yieldToUi: async () => undefined,
  });
  const journal = createSuggestionJournal();
  const coach = createStintCoach({
    runner,
    journal,
    suggestionsEnabled: () => DEFAULT_SETTINGS.suggestionsEnabled,
    cueContext: () => ({
      sessionId: SESSION_ID,
      generation: 1,
      stintIndex: 0,
      completedLapCount: 4,
    }),
    activeCues: () => CUES,
    applyCueUpdates: (updates) => {
      cueApplyCalls += 1;
      return updates.map((update) => ({
        ...update,
        appliedAtMono: 0,
        appliedAfterLapNumber: 0,
      }));
    },
    onError: () => undefined,
  });

  const lapBoundary = await coach.onLapCompleted(SESSION_ID, 4);
  const readsAfterLapBoundary = reads;
  const pit = await coach.openPitView(SESSION_ID, 4);
  const pitState = buildPitViewState({
    run: pit.run,
    suggestions: pit.suggestions,
    cueUpdates: pit.cueUpdates,
    language: 'en',
  });

  const analysisRunner = createAnalysisRunner({
    loadSession: async () => source,
    isSessionActive: () => false,
  });
  const reportState = buildAnalysisScreenState(await analysisRunner.run(SESSION_ID), 'en');
  if (reportState.status !== 'ready') throw new Error('expected a ready analysis');
  const record = journal.read(SESSION_ID);
  const doc = buildAnalysisExportDocument(reportState, {
    generatedAtUtc: GENERATED_AT,
    trackday: {
      enabled: DEFAULT_SETTINGS.suggestionsEnabled,
      cueUpdates: record.cueUpdates,
      pitSuggestions: record.shownPitSuggestions,
    },
  });

  return {
    settingDefault: DEFAULT_SETTINGS.suggestionsEnabled,
    lapBoundaryStatus: lapBoundary.status,
    lapBoundaryApplied: lapBoundary.applied.length,
    readsAfterLapBoundary,
    cueApplyCalls,
    journalCueUpdates: record.cueUpdates.length,
    journalShownSuggestions: record.shownPitSuggestions.length,
    pitGate: pit.suggestions.gate,
    pitSuggestionCount: pitState.status === 'ready' ? pitState.view.suggestionCount : -1,
    pitStatusLine: pitState.status === 'ready' ? pitState.view.statusLine : '',
    exportObservationsOnly: doc.observationsOnly,
    exportHasTrackday: doc.trackday !== undefined,
    exportMentionsSuggestions: /suggest/i.test(JSON.stringify(doc)),
    exportTopLevelKeys: Object.keys(doc).sort(),
  };
}

describe('suggestionsEnabled OFF — zero behaviour change (D5)', () => {
  it('pins the whole off state', async () => {
    expect(await offStateSummary()).toMatchInlineSnapshot(`
      {
        "cueApplyCalls": 0,
        "exportHasTrackday": false,
        "exportMentionsSuggestions": false,
        "exportObservationsOnly": true,
        "exportTopLevelKeys": [
          "analysis",
          "generatedAtUtc",
          "kind",
          "language",
          "observationsOnly",
          "recording",
          "report",
          "schemaVersion",
          "session",
        ],
        "journalCueUpdates": 0,
        "journalShownSuggestions": 0,
        "lapBoundaryApplied": 0,
        "lapBoundaryStatus": "disabled",
        "pitGate": "disabled",
        "pitStatusLine": "Suggestions are off — this is what you did, not what to do. Turn them on under Settings › Coaching.",
        "pitSuggestionCount": 0,
        "readsAfterLapBoundary": 0,
        "settingDefault": false,
      }
    `);
  });
});
