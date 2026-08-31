import { describe, expect, it } from 'vitest';

import type { ActiveCue, AppliedCueUpdate, CueUpdate } from '@circuit/core';
import { MAX_BRAKE_LATER_M } from '@circuit/core';

import {
  createStintCoach,
  createStintRunner,
  createSuggestionJournal,
  type StintSource,
} from '../../src/session/stintCoaching';
import { bundled, driveSession, TMR_CIRCUIT_ID } from '../support/analysisHarness';

/**
 * Ticket P5c-B D2/D5 — the LIVE trackday path in the app.
 *
 * The one rule everything here defends: with `suggestionsEnabled` off the
 * whole stage is inert (not even a database read happens off the lap
 * boundary), and with it on a cue may still only move to a point a clean lap
 * of the SAME outing demonstrated, once per corner per stint.
 */

const SESSION_ID = 'stint-session';
const SESSION_DATE = '2026-08-31T09:00:00.000Z';

function source(laps: number): StintSource {
  const circuit = bundled(TMR_CIRCUIT_ID);
  const driven = driveSession(circuit, { laps, channels: 'full' });
  return {
    sessionId: SESSION_ID,
    circuit,
    displayDateUtc: SESSION_DATE,
    recordings: driven.recordings,
  };
}

/** A deliberately EARLY cue for every corner, so any demonstrated point is later. */
function earlyCues(cornerIds: readonly number[]): ActiveCue[] {
  return cornerIds.map((cornerId) => ({ cornerId, brakeStartM: 400, liftPointM: null }));
}

interface Rig {
  loads: number;
  applied: CueUpdate[][];
  cues: ActiveCue[];
  coach: ReturnType<typeof createStintCoach>;
  journal: ReturnType<typeof createSuggestionJournal>;
  runner: ReturnType<typeof createStintRunner>;
}

function rig(options: { laps: number; enabled: boolean; loadFails?: boolean }): Rig {
  const stint = source(options.laps);
  const cornerIds = stint.circuit.corners.map((corner) => corner.id);
  const state: Rig = {
    loads: 0,
    applied: [],
    cues: earlyCues(cornerIds),
    coach: undefined as unknown as Rig['coach'],
    journal: createSuggestionJournal(),
    runner: undefined as unknown as Rig['runner'],
  };
  state.runner = createStintRunner({
    loadCompletedLaps: async () => {
      state.loads += 1;
      if (options.loadFails === true) throw new Error('sqlite is busy');
      return stint;
    },
    yieldToUi: async () => undefined,
  });
  state.coach = createStintCoach({
    runner: state.runner,
    journal: state.journal,
    suggestionsEnabled: () => options.enabled,
    activeCues: () => state.cues,
    applyCueUpdates: (updates) => {
      state.applied.push([...updates]);
      // Stands in for `SessionController.applyCueUpdates`: applies what it is
      // given, and moves the local cue set so the next lap boundary sees it.
      const out: AppliedCueUpdate[] = updates.map((update) => ({
        ...update,
        appliedAtMono: 1_000,
        appliedAfterLapNumber: options.laps,
      }));
      state.cues = state.cues.map((cue) => {
        const update = out.find((entry) => entry.cornerId === cue.cornerId);
        return update === undefined ? cue : { ...cue, brakeStartM: update.toM };
      });
      return out;
    },
    onError: () => undefined,
  });
  return state;
}

describe('stint coaching — the suggestionsEnabled gate (D5)', () => {
  it('does NOTHING at a lap boundary when suggestions are off: no read, no cue touched', async () => {
    const state = rig({ laps: 4, enabled: false });
    const outcome = await state.coach.onLapCompleted(SESSION_ID, 4);
    expect(outcome.status).toBe('disabled');
    expect(outcome.applied).toEqual([]);
    expect(outcome.run).toBeNull();
    expect(state.loads).toBe(0);
    expect(state.applied).toEqual([]);
    expect(state.journal.read(SESSION_ID).cueUpdates).toEqual([]);
  });

  it('shows observations but no suggestions in the pit view when suggestions are off', async () => {
    const state = rig({ laps: 4, enabled: false });
    const pit = await state.coach.openPitView(SESSION_ID, 4);
    expect(pit.run.status).toBe('ready');
    expect(pit.suggestions.gate).toBe('disabled');
    expect(pit.suggestions.pitSuggestions).toEqual([]);
    expect(state.journal.read(SESSION_ID).shownPitSuggestions).toEqual([]);
  });
});

describe('stint coaching — the live cue path (D2)', () => {
  it('moves cues only within the demonstrated envelope and the safety bound', async () => {
    const state = rig({ laps: 4, enabled: true });
    const outcome = await state.coach.onLapCompleted(SESSION_ID, 4);
    expect(outcome.status).toBe('applied');
    expect(outcome.applied.length).toBeGreaterThan(0);
    for (const update of outcome.applied) {
      expect(update.movedLaterM).toBeGreaterThan(0);
      expect(update.movedLaterM).toBeLessThanOrEqual(MAX_BRAKE_LATER_M);
      expect(update.toM).toBeGreaterThanOrEqual(update.demonstratedM);
      expect(update.point).toBe('brake');
    }
  });

  it('makes at most ONE change per corner per stint across successive lap boundaries', async () => {
    const state = rig({ laps: 4, enabled: true });
    const first = await state.coach.onLapCompleted(SESSION_ID, 4);
    const second = await state.coach.onLapCompleted(SESSION_ID, 5);
    const firstCorners = new Set(first.applied.map((update) => update.cornerId));
    for (const update of second.applied) {
      expect(firstCorners.has(update.cornerId)).toBe(false);
    }
    const journal = state.journal.read(SESSION_ID).cueUpdates;
    const perCorner = new Map<number, number>();
    for (const update of journal) {
      perCorner.set(update.cornerId, (perCorner.get(update.cornerId) ?? 0) + 1);
    }
    for (const count of perCorner.values()) expect(count).toBe(1);
  });

  it('suggests nothing at all with fewer than two clean laps in the outing', async () => {
    const state = rig({ laps: 1, enabled: true });
    const outcome = await state.coach.onLapCompleted(SESSION_ID, 1);
    expect(outcome.status).toBe('insufficient');
    expect(outcome.applied).toEqual([]);
    expect(state.applied).toEqual([]);
  });

  it('turns a failed read into an error outcome, never a throw and never a cue change', async () => {
    const state = rig({ laps: 4, enabled: true, loadFails: true });
    const outcome = await state.coach.onLapCompleted(SESSION_ID, 4);
    expect(outcome.status).toBe('error');
    expect(state.applied).toEqual([]);
  });
});

describe('stint analysis runner', () => {
  it('analyses only the laps completed so far and caches by that count', async () => {
    const state = rig({ laps: 4, enabled: true });
    const first = await state.runner.run(SESSION_ID, 4);
    const second = await state.runner.run(SESSION_ID, 4);
    expect(state.loads).toBe(1);
    expect(second).toBe(first);
    if (first.status !== 'ready') throw new Error('expected a ready stint analysis');
    expect(first.analysis.lapNumbers).toEqual([1, 2, 3, 4]);
    expect(first.analysis.insights.lapCount).toBe(4);
  });

  it('re-runs when another lap has completed', async () => {
    const state = rig({ laps: 4, enabled: true });
    await state.runner.run(SESSION_ID, 3);
    await state.runner.run(SESSION_ID, 4);
    expect(state.loads).toBe(2);
    expect(state.runner.peek(SESSION_ID, 3)?.status).toBe('ready');
  });

  it('reports a session with no stored laps as unavailable rather than empty', async () => {
    const runner = createStintRunner({
      loadCompletedLaps: async () => null,
      yieldToUi: async () => undefined,
    });
    const result = await runner.run(SESSION_ID, 0);
    expect(result).toEqual({ status: 'unavailable', reason: 'no-session' });
  });
});

describe('suggestion journal', () => {
  it('remembers the cue updates applied and the suggestions actually shown, per session', () => {
    const journal = createSuggestionJournal();
    const update: AppliedCueUpdate = {
      cornerId: 3,
      point: 'brake',
      fromM: 200,
      toM: 192,
      movedLaterM: 8,
      demonstratedM: 190,
      evidenceLapNumber: 2,
      cleanLapCount: 3,
      appliedAtMono: 5,
      appliedAfterLapNumber: 3,
    };
    journal.recordCueUpdates('a', [update]);
    journal.recordShownSuggestions('a', [
      {
        cornerId: 3,
        kind: 'brakeLater',
        unit: 'm',
        typicalValue: 200,
        demonstratedValue: 190,
        targetValue: 190,
        deltaValue: 10,
        evidenceLapNumber: 2,
        cleanLapCount: 3,
        timeLossMs: 300,
      },
    ]);
    expect(journal.updatedCornerIds('a')).toEqual([3]);
    expect(journal.read('a').shownPitSuggestions).toHaveLength(1);
    expect(journal.read('b').cueUpdates).toEqual([]);
    // Showing the same suggestion twice records it once.
    journal.recordShownSuggestions('a', journal.read('a').shownPitSuggestions);
    expect(journal.read('a').shownPitSuggestions).toHaveLength(1);
  });
});

describe('stint coaching — never disturbs the running session', () => {
  it('the pit view PRESENTS suggestions and applies none of them (R2-3b)', async () => {
    const state = rig({ laps: 4, enabled: true });
    const pit = await state.coach.openPitView(SESSION_ID, 4);
    expect(pit.suggestions.gate).toBe('open');
    expect(pit.suggestions.pitSuggestions.length).toBeGreaterThan(0);
    // Not one call into the cue source, and nothing recorded as applied.
    expect(state.applied).toEqual([]);
    expect(state.journal.read(SESSION_ID).cueUpdates).toEqual([]);
    // What WAS shown is remembered, so the export can carry exactly that.
    expect(state.journal.read(SESSION_ID).shownPitSuggestions).toEqual(
      pit.suggestions.pitSuggestions,
    );
  });

  it('reuses the cached pass for the pit view opened after a lap-boundary update', async () => {
    const state = rig({ laps: 4, enabled: true });
    await state.coach.onLapCompleted(SESSION_ID, 4);
    const readsAfterBoundary = state.loads;
    await state.coach.openPitView(SESSION_ID, 4);
    expect(state.loads).toBe(readsAfterBoundary);
  });
});
