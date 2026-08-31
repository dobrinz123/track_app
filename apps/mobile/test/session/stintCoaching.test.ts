import { describe, expect, it } from 'vitest';

import type {
  ActiveCue,
  AppliedCueUpdate,
  CueUpdate,
  CueUpdateContext,
  CueUpdateRequest,
} from '@circuit/core';
import { MAX_BRAKE_LATER_M, verifyCueEvidence } from '@circuit/core';

import {
  createStintCoach,
  createStintRunner,
  createSuggestionJournal,
  type StintSource,
} from '../../src/session/stintCoaching';
import {
  bundled,
  driveSession,
  withValidatedGeometry,
  TMR_CIRCUIT_ID,
} from '../support/analysisHarness';

/**
 * Ticket P5c-B D2/D5 — the LIVE trackday path in the app, as revised by ticket
 * P5c-FIX1 (Codex P5c-REV1 findings 1, 5, 8, 11).
 *
 * The one rule everything here defends: with `suggestionsEnabled` off the
 * whole stage is inert (not even a database read happens off the lap
 * boundary), and with it on a cue may still only move to a point a clean lap
 * of the SAME outing demonstrated, once per corner per stint — AT a lap
 * boundary, never in the middle of the lap the driver is on.
 */

const SESSION_ID = 'stint-session';
const SESSION_DATE = '2026-08-31T09:00:00.000Z';

function source(laps: number): StintSource {
  const circuit = withValidatedGeometry(bundled(TMR_CIRCUIT_ID));
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
  settles: number;
  applied: CueUpdate[][];
  requests: CueUpdateRequest[];
  cues: ActiveCue[];
  context: CueUpdateContext;
  enabled: boolean;
  coach: ReturnType<typeof createStintCoach>;
  journal: ReturnType<typeof createSuggestionJournal>;
  runner: ReturnType<typeof createStintRunner>;
}

function rig(options: { laps: number; enabled: boolean; loadFails?: boolean }): Rig {
  const stint = source(options.laps);
  const cornerIds = stint.circuit.corners.map((corner) => corner.id);
  const state: Rig = {
    loads: 0,
    settles: 0,
    applied: [],
    requests: [],
    cues: earlyCues(cornerIds),
    context: {
      sessionId: SESSION_ID,
      generation: 1,
      stintIndex: 0,
      completedLapCount: options.laps,
    },
    enabled: options.enabled,
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
    settleLapPersistence: async () => {
      state.settles += 1;
    },
    yieldToUi: async () => undefined,
  });
  state.coach = createStintCoach({
    runner: state.runner,
    journal: state.journal,
    suggestionsEnabled: () => state.enabled,
    cueContext: () => state.context,
    activeCues: () => state.cues,
    applyCueUpdates: (updates, request) => {
      state.applied.push([...updates]);
      state.requests.push(request);
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

/** One lap boundary: the facade's count grows, then the coach is told. */
async function boundary(state: Rig, completedLapCount: number) {
  state.context = { ...state.context, completedLapCount };
  return state.coach.onLapCompleted(SESSION_ID, completedLapCount);
}

describe('stint coaching — the suggestionsEnabled gate (D5)', () => {
  it('does NOTHING at a lap boundary when suggestions are off: no read, no cue touched', async () => {
    const state = rig({ laps: 4, enabled: false });
    const outcome = await boundary(state, 4);
    expect(outcome.status).toBe('disabled');
    expect(outcome.applied).toEqual([]);
    expect(outcome.run).toBeNull();
    expect(state.loads).toBe(0);
    expect(state.settles).toBe(0);
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

describe('stint coaching — the live cue path (D2, applied at a boundary per E1)', () => {
  it('queues at the boundary it was computed for, and applies at the NEXT one', async () => {
    const state = rig({ laps: 4, enabled: true });
    const first = await boundary(state, 4);
    expect(first.status).toBe('queued');
    expect(first.applied).toEqual([]);
    expect(first.queued.length).toBeGreaterThan(0);
    // Nothing has reached the cue source yet -- the driver is mid-lap.
    expect(state.applied).toEqual([]);

    const second = await boundary(state, 5);
    expect(second.status).toBe('applied');
    expect(second.applied.length).toBeGreaterThan(0);
    expect(state.applied).toHaveLength(1);
  });

  it('moves cues only within the demonstrated envelope and the safety bound', async () => {
    const state = rig({ laps: 4, enabled: true });
    await boundary(state, 4);
    const outcome = await boundary(state, 5);
    expect(outcome.applied.length).toBeGreaterThan(0);
    for (const update of outcome.applied) {
      expect(update.movedLaterM).toBeGreaterThan(0);
      expect(update.movedLaterM).toBeLessThanOrEqual(MAX_BRAKE_LATER_M);
      expect(update.toM).toBeGreaterThanOrEqual(update.demonstratedM);
      expect(update.point).toBe('brake');
    }
  });

  it('hands the cue source SEALED evidence bound to the live context (E2)', async () => {
    const state = rig({ laps: 4, enabled: true });
    await boundary(state, 4);
    await boundary(state, 5);
    const request = state.requests[0];
    expect(request).toBeDefined();
    expect(verifyCueEvidence(request!.evidence)).toBe(true);
    expect(request!.evidence.sessionId).toBe(SESSION_ID);
    expect(request!.evidence.generation).toBe(state.context.generation);
    expect(request!.evidence.stintIndex).toBe(state.context.stintIndex);
    expect(request!.context.sessionId).toBe(SESSION_ID);
    // Every applied update cites a bound that IS in the sealed evidence.
    for (const update of state.applied[0] ?? []) {
      expect(
        request!.evidence.entries.some(
          (entry) => entry.cornerId === update.cornerId && entry.point === 'brake',
        ),
      ).toBe(true);
    }
  });

  it('makes at most ONE change per corner per stint across successive lap boundaries', async () => {
    const state = rig({ laps: 4, enabled: true });
    await boundary(state, 4);
    const first = await boundary(state, 5);
    const second = await boundary(state, 6);
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

  it('re-arms the allowance in the NEXT stint (E10) — the journal is stint-scoped', async () => {
    const state = rig({ laps: 4, enabled: true });
    await boundary(state, 4);
    const applied = (await boundary(state, 5)).applied;
    expect(applied.length).toBeGreaterThan(0);
    const movedCorner = applied[0]!.cornerId;
    expect(state.journal.updatedCornerIds(SESSION_ID, 0)).toContain(movedCorner);
    // A pit exit: the cue source starts the next stint.
    expect(state.journal.updatedCornerIds(SESSION_ID, 1)).toEqual([]);
  });

  it('suggests nothing at all with fewer than two clean laps in the outing', async () => {
    const state = rig({ laps: 1, enabled: true });
    const outcome = await boundary(state, 1);
    expect(outcome.status).toBe('insufficient');
    expect(outcome.applied).toEqual([]);
    expect(state.applied).toEqual([]);
  });

  it('turns a failed read into an error outcome, never a throw and never a cue change', async () => {
    const state = rig({ laps: 4, enabled: true, loadFails: true });
    const outcome = await boundary(state, 4);
    expect(outcome.status).toBe('error');
    expect(state.applied).toEqual([]);
  });
});

describe('stint analysis runner', () => {
  it('awaits the lap persistence barrier before reading (E5)', async () => {
    const order: string[] = [];
    const runner = createStintRunner({
      loadCompletedLaps: async () => {
        order.push('load');
        return source(3);
      },
      settleLapPersistence: async () => {
        order.push('settle');
      },
      yieldToUi: async () => undefined,
    });
    await runner.run(SESSION_ID, 3);
    expect(order).toEqual(['settle', 'load']);
  });

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

  it('projects each lap ONCE across the whole outing (E11)', async () => {
    const circuit = withValidatedGeometry(bundled(TMR_CIRCUIT_ID));
    const driven = driveSession(circuit, { laps: 5, channels: 'full' });
    let visibleLaps = 3;
    const runner = createStintRunner({
      loadCompletedLaps: async () => ({
        sessionId: SESSION_ID,
        circuit,
        displayDateUtc: SESSION_DATE,
        recordings: driven.recordings.slice(0, visibleLaps),
      }),
      yieldToUi: async () => undefined,
    });

    await runner.run(SESSION_ID, 3);
    expect(runner.projectionCount()).toBe(3);
    visibleLaps = 4;
    await runner.run(SESSION_ID, 4);
    // Only the lap that just completed is projected; the other three are cached.
    expect(runner.projectionCount()).toBe(4);
    visibleLaps = 5;
    await runner.run(SESSION_ID, 5);
    expect(runner.projectionCount()).toBe(5);
  });

  it('reports a session with no stored laps as unavailable rather than empty', async () => {
    const runner = createStintRunner({
      loadCompletedLaps: async () => null,
      yieldToUi: async () => undefined,
    });
    const result = await runner.run(SESSION_ID, 0);
    expect(result).toEqual({ status: 'unavailable', reason: 'no-session' });
  });

  it('does NOT memoise a pass that could not read one of the advertised laps (E5)', async () => {
    const circuit = withValidatedGeometry(bundled(TMR_CIRCUIT_ID));
    const driven = driveSession(circuit, { laps: 3, channels: 'full' });
    let traceLanded = false;
    let loads = 0;
    const runner = createStintRunner({
      loadCompletedLaps: async () => {
        loads += 1;
        const recordings = driven.recordings.map((recording, index) =>
          index === driven.recordings.length - 1 && !traceLanded
            ? { ...recording, locationSamples: [] }
            : recording,
        );
        return { sessionId: SESSION_ID, circuit, displayDateUtc: SESSION_DATE, recordings };
      },
      yieldToUi: async () => undefined,
    });

    const incomplete = await runner.run(SESSION_ID, 3);
    if (incomplete.status !== 'ready') throw new Error('expected a ready result');
    expect(incomplete.analysis.assembled.skippedLaps).toHaveLength(1);
    expect(runner.peek(SESSION_ID, 3)).toBeNull();

    traceLanded = true;
    const complete = await runner.run(SESSION_ID, 3);
    expect(loads).toBe(2);
    if (complete.status !== 'ready') throw new Error('expected a ready result');
    expect(complete.analysis.assembled.skippedLaps).toEqual([]);
    expect(runner.peek(SESSION_ID, 3)).not.toBeNull();
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
    journal.recordCueUpdates('a', [update], 0);
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
    expect(journal.updatedCornerIds('a', 0)).toEqual([3]);
    // The SAME corner is available again in the next stint (E10).
    expect(journal.updatedCornerIds('a', 1)).toEqual([]);
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
    // E8: opening the view journals NOTHING by itself -- only what the built
    // view reported as shown is recorded, by the screen.
    expect(state.journal.read(SESSION_ID).shownPitSuggestions).toEqual([]);
    state.coach.recordShown(SESSION_ID, pit.suggestions.pitSuggestions.slice(0, 1));
    expect(state.journal.read(SESSION_ID).shownPitSuggestions).toHaveLength(1);
  });

  it('reuses the cached pass for the pit view opened after a lap-boundary update', async () => {
    const state = rig({ laps: 4, enabled: true });
    await boundary(state, 4);
    const readsAfterBoundary = state.loads;
    await state.coach.openPitView(SESSION_ID, 4);
    expect(state.loads).toBe(readsAfterBoundary);
  });
});
