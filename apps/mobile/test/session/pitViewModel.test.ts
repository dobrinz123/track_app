import { describe, expect, it } from 'vitest';

import { computeSuggestions, type AppliedCueUpdate } from '@circuit/core';

import {
  PIT_FOCUS_CORNER_LIMIT,
  buildPitViewState,
  type PitViewInput,
} from '../../src/session/pitViewModel';
import {
  createStintRunner,
  type StintRunResult,
  type StintSource,
} from '../../src/session/stintCoaching';
import { PIT_SCREEN_STRINGS } from '../../src/ui/screens/trackdayStrings';
import { bundled, driveSession, TMR_CIRCUIT_ID } from '../support/analysisHarness';

/**
 * Ticket P5c-B D3/D5 — the interactive BETWEEN-STINT view (contracts.md R2-2 +
 * R2-3b): the worst corners with badges, a tap into the P5b detail, and the
 * bounded suggestion line under it. With suggestions off it degrades to
 * exactly the observations the analysis screen already shows.
 */

const SESSION_ID = 'pit-session';
const SESSION_DATE = '2026-08-31T09:00:00.000Z';

function stintSource(laps: number): StintSource {
  const circuit = bundled(TMR_CIRCUIT_ID);
  return {
    sessionId: SESSION_ID,
    circuit,
    displayDateUtc: SESSION_DATE,
    recordings: driveSession(circuit, {
      laps,
      channels: 'full',
      cornerSpeedScales: [1, 0.88, 0.96, 1.02].slice(0, laps),
    }).recordings,
  };
}

async function run(laps: number): Promise<StintRunResult> {
  const source = stintSource(laps);
  const runner = createStintRunner({
    loadCompletedLaps: async () => source,
    yieldToUi: async () => undefined,
  });
  return runner.run(SESSION_ID, laps);
}

function input(
  result: StintRunResult,
  options: { enabled: boolean; cueUpdates?: readonly AppliedCueUpdate[] } = { enabled: true },
): PitViewInput {
  const insights = result.status === 'ready' ? result.analysis.insights : null;
  const suggestions =
    insights === null
      ? {
          gate: 'insufficient-clean-laps' as const,
          cleanLapCount: 0,
          cueUpdates: [],
          pitSuggestions: [],
          skipped: [],
        }
      : computeSuggestions({
          enabled: options.enabled,
          envelope: insights.envelope,
          cues: [],
          timeLossMsByCorner: Object.fromEntries(
            insights.corners.map((corner) => [corner.cornerId, corner.timeLoss?.deltaMs ?? null]),
          ),
        });
  return {
    run: result,
    suggestions,
    cueUpdates: options.cueUpdates ?? [],
    language: 'en',
  };
}

describe('pit view — the interactive corner list (D3)', () => {
  it('shows at most the top corners by time lost, worst first, each with badges', async () => {
    const state = buildPitViewState(input(await run(4)));
    if (state.status !== 'ready') throw new Error(`expected ready, got ${state.status}`);
    expect(state.view.corners.length).toBeGreaterThan(0);
    expect(state.view.corners.length).toBeLessThanOrEqual(PIT_FOCUS_CORNER_LIMIT);
    const losses = state.view.corners.map((corner) => corner.timeLossMs ?? Number.NEGATIVE_INFINITY);
    expect([...losses].sort((a, b) => b - a)).toEqual(losses);
    for (const corner of state.view.corners) {
      expect(corner.heading.length).toBeGreaterThan(0);
      expect(corner.badges.length).toBeGreaterThan(0);
    }
  });

  it('keeps the P5b per-corner detail behind the tap (numbers, not prose)', async () => {
    const state = buildPitViewState(input(await run(4)));
    if (state.status !== 'ready') throw new Error('expected ready');
    const corner = state.view.corners[0];
    expect(corner?.detail.perLap.length).toBeGreaterThan(0);
    expect(corner?.detail.columns.brake.length).toBeGreaterThan(0);
  });

  it('renders a bounded suggestion line per corner, each citing the lap that proved it', async () => {
    const state = buildPitViewState(input(await run(4)));
    if (state.status !== 'ready') throw new Error('expected ready');
    const lines = state.view.corners.flatMap((corner) => corner.suggestions);
    expect(state.view.suggestionCount).toBe(
      state.view.corners.reduce((total, corner) => total + corner.suggestions.length, 0),
    );
    for (const line of lines) {
      expect(line).toMatch(/lap \d+/);
      expect(line).not.toContain('undefined');
      expect(line).not.toContain('NaN');
    }
  });

  it('shows a corner whose cue was updated, with the before/after change (D5)', async () => {
    const result = await run(4);
    if (result.status !== 'ready') throw new Error('expected ready');
    const cornerId = result.analysis.insights.corners[0]?.cornerId ?? 1;
    const update: AppliedCueUpdate = {
      cornerId,
      point: 'brake',
      fromM: 200,
      toM: 192,
      movedLaterM: 8,
      demonstratedM: 190,
      evidenceLapNumber: 2,
      cleanLapCount: 3,
      appliedAtMono: 1_000,
      appliedAfterLapNumber: 3,
    };
    const state = buildPitViewState(input(result, { enabled: true, cueUpdates: [update] }));
    if (state.status !== 'ready') throw new Error('expected ready');
    expect(state.view.cueUpdateLines).toHaveLength(1);
    expect(state.view.cueUpdateLines[0]).toContain('200 m');
    expect(state.view.cueUpdateLines[0]).toContain('192 m');
    const row = state.view.corners.find((corner) => corner.cornerId === cornerId);
    // The corner may not be in the top-N focus list; when it is, it carries the change.
    if (row !== undefined) expect(row.cueUpdates).toHaveLength(1);
  });
});

describe('pit view — honesty (D5)', () => {
  it('with suggestions OFF shows observations and NOT ONE suggestion line', async () => {
    const state = buildPitViewState(input(await run(4), { enabled: false }));
    if (state.status !== 'ready') throw new Error('expected ready');
    expect(state.view.corners.length).toBeGreaterThan(0);
    expect(state.view.suggestionCount).toBe(0);
    expect(state.view.corners.every((corner) => corner.suggestions.length === 0)).toBe(true);
    expect(state.view.statusLine).toBe(PIT_SCREEN_STRINGS.en.suggestionsOff);
  });

  it('with fewer than two clean laps says why instead of suggesting anything', async () => {
    const state = buildPitViewState(input(await run(1)));
    if (state.status !== 'ready') throw new Error('expected ready');
    expect(state.view.suggestionCount).toBe(0);
    expect(state.view.statusLine).toBe(PIT_SCREEN_STRINGS.en.insufficientCleanLaps);
  });

  it('names an unavailable stint rather than showing an empty screen', () => {
    const state = buildPitViewState({
      run: { status: 'unavailable', reason: 'no-laps' },
      suggestions: {
        gate: 'insufficient-clean-laps',
        cleanLapCount: 0,
        cueUpdates: [],
        pitSuggestions: [],
        skipped: [],
      },
      cueUpdates: [],
      language: 'en',
    });
    expect(state.status).toBe('unavailable');
    if (state.status !== 'unavailable') throw new Error('expected unavailable');
    expect(state.message).toBe(PIT_SCREEN_STRINGS.en.noLaps);
  });
});

describe('pit view — RO/EN', () => {
  it('renders Romanian end to end with no English leakage in the chrome', async () => {
    const state = buildPitViewState({ ...input(await run(4)), language: 'ro' });
    if (state.status !== 'ready') throw new Error('expected ready');
    expect(state.view.focusHeading).toBe(PIT_SCREEN_STRINGS.ro.focusHeading);
    for (const line of state.view.corners.flatMap((corner) => corner.suggestions)) {
      expect(line).toMatch(/turul \d+/);
    }
  });

  it('the Romanian string table carries every key the English one does', () => {
    expect(Object.keys(PIT_SCREEN_STRINGS.ro).sort()).toEqual(
      Object.keys(PIT_SCREEN_STRINGS.en).sort(),
    );
    for (const [key, value] of Object.entries(PIT_SCREEN_STRINGS.ro)) {
      const english = (PIT_SCREEN_STRINGS.en as unknown as Record<string, unknown>)[key];
      expect(typeof value).toBe(typeof english);
      if (typeof value === 'string') expect(value.length).toBeGreaterThan(0);
    }
  });
});
