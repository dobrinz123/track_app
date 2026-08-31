import { describe, expect, it } from 'vitest';

import type {
  ActiveCue,
  AppliedCueUpdate,
  CueUpdate,
  CueUpdateContext,
  CueUpdateRequest,
} from '@circuit/core';

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
  MOTORPARK_CIRCUIT_ID,
  TMR_CIRCUIT_ID,
} from '../support/analysisHarness';

/**
 * Ticket P5c-FIX1 E1 + E4 + E12 (Codex P5c-REV1 findings 1, 4, 12) — the
 * apply-time re-checks, at the layer that decides WHEN a bounded update is
 * handed to the cue source, and the honesty gate on both bundled circuits.
 *
 * The three races finding 1 named, each with its own test:
 *
 *  1. the driver turns suggestions OFF while the pass is running,
 *  2. the session is restarted (or the controller rebuilt) while it is running,
 *  3. the pass simply finishes mid-lap.
 *
 * In all three, nothing may move. The third is the one the shipped code got
 * wrong in the ordinary case: a pass started at a boundary finishes seconds
 * later, with the driver already on the approach to a corner.
 */

const SESSION_ID = 'safety-session';
const SESSION_DATE = '2026-08-31T10:00:00.000Z';

interface Rig {
  applied: CueUpdate[][];
  requests: CueUpdateRequest[];
  cues: ActiveCue[];
  context: CueUpdateContext | null;
  enabled: boolean;
  coach: ReturnType<typeof createStintCoach>;
  journal: ReturnType<typeof createSuggestionJournal>;
  /** Runs before the analysis pass resolves — the "while it was running" hook. */
  duringPass: () => void;
}

function rig(options: { circuitId: string; laps: number; validated: boolean }): Rig {
  const catalogCircuit = bundled(options.circuitId);
  const circuit = options.validated ? withValidatedGeometry(catalogCircuit) : catalogCircuit;
  const driven = driveSession(circuit, { laps: options.laps, channels: 'full' });
  const stint: StintSource = {
    sessionId: SESSION_ID,
    circuit,
    displayDateUtc: SESSION_DATE,
    recordings: driven.recordings,
  };
  const state: Rig = {
    applied: [],
    requests: [],
    cues: circuit.corners.map((corner) => ({
      cornerId: corner.id,
      brakeStartM: 400,
      liftPointM: null,
    })),
    context: { sessionId: SESSION_ID, generation: 1, stintIndex: 0, completedLapCount: options.laps },
    enabled: true,
    coach: undefined as unknown as Rig['coach'],
    journal: createSuggestionJournal(),
    duringPass: () => undefined,
  };
  const runner = createStintRunner({
    loadCompletedLaps: async () => {
      // Everything the driver/app could do WHILE the pass runs happens here.
      state.duringPass();
      return stint;
    },
    yieldToUi: async () => undefined,
  });
  state.coach = createStintCoach({
    runner,
    journal: state.journal,
    suggestionsEnabled: () => state.enabled,
    cueContext: () => state.context,
    activeCues: () => state.cues,
    applyCueUpdates: (updates, request) => {
      state.applied.push([...updates]);
      state.requests.push(request);
      const out: AppliedCueUpdate[] = updates.map((update) => ({
        ...update,
        appliedAtMono: 0,
        appliedAfterLapNumber: 0,
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

function tmr(laps = 4): Rig {
  return rig({ circuitId: TMR_CIRCUIT_ID, laps, validated: true });
}

async function boundary(state: Rig, completedLapCount: number) {
  if (state.context !== null) state.context = { ...state.context, completedLapCount };
  return state.coach.onLapCompleted(SESSION_ID, completedLapCount);
}

describe('E1 — nothing is applied in the middle of a lap', () => {
  it('a pass that finishes mid-lap applies NOTHING until the next boundary', async () => {
    const state = tmr();
    const first = await boundary(state, 4);
    expect(first.status).toBe('queued');
    expect(state.applied).toEqual([]);
    // The cue set is untouched while the driver is on the lap.
    expect(state.cues.every((cue) => cue.brakeStartM === 400)).toBe(true);
    expect(state.coach.pendingUpdates().length).toBeGreaterThan(0);

    await boundary(state, 5);
    expect(state.applied).toHaveLength(1);
  });

  it('never applies the same queued batch twice', async () => {
    const state = tmr();
    await boundary(state, 4);
    await boundary(state, 5);
    const afterFirstApply = state.applied.length;
    const queuedNow = state.coach.pendingUpdates();
    await boundary(state, 6);
    expect(state.applied.length).toBe(afterFirstApply + (queuedNow.length > 0 ? 1 : 0));
  });
});

describe('E1 — the setting is re-read at APPLY time', () => {
  it('turning suggestions off during the pass applies nothing at the next boundary', async () => {
    const state = tmr();
    const first = await boundary(state, 4);
    expect(first.status).toBe('queued');
    // The driver flips the switch between the two boundaries.
    state.enabled = false;
    const second = await boundary(state, 5);
    expect(second.status).toBe('disabled');
    expect(state.applied).toEqual([]);
    expect(state.journal.read(SESSION_ID).cueUpdates).toEqual([]);
  });

  it('turning suggestions off DURING the pass queues nothing at all', async () => {
    const state = tmr();
    state.duringPass = () => {
      state.enabled = false;
    };
    const outcome = await boundary(state, 4);
    expect(outcome.status).toBe('superseded');
    expect(state.coach.pendingUpdates()).toEqual([]);
    expect(state.applied).toEqual([]);
  });
});

describe('E1 — the session and the controller are re-checked at APPLY time', () => {
  it('a session restarted during the pass queues nothing (new generation)', async () => {
    const state = tmr();
    state.duringPass = () => {
      state.context = {
        sessionId: 'a-different-outing',
        generation: 2,
        stintIndex: 0,
        completedLapCount: 0,
      };
    };
    const outcome = await boundary(state, 4);
    expect(outcome.status).toBe('superseded');
    expect(state.coach.pendingUpdates()).toEqual([]);
    expect(state.applied).toEqual([]);
  });

  it('a controller rebuilt between the two boundaries applies nothing', async () => {
    const state = tmr();
    expect((await boundary(state, 4)).status).toBe('queued');
    // A rebuild: same outing id, new controller generation.
    state.context = { ...state.context!, generation: 9 };
    const second = await boundary(state, 5);
    expect(second.applied).toEqual([]);
    expect(state.applied).toEqual([]);
  });

  it('a pit exit between the two boundaries applies nothing (stint moved on)', async () => {
    const state = tmr();
    expect((await boundary(state, 4)).status).toBe('queued');
    state.context = { ...state.context!, stintIndex: 1 };
    const second = await boundary(state, 5);
    expect(second.applied).toEqual([]);
    expect(state.applied).toEqual([]);
  });

  it('no live cue source at the boundary applies nothing', async () => {
    const state = tmr();
    expect((await boundary(state, 4)).status).toBe('queued');
    state.context = null;
    const second = await state.coach.onLapCompleted(SESSION_ID, 5);
    expect(second.applied).toEqual([]);
    expect(state.applied).toEqual([]);
  });
});

/**
 * Ticket P5c-FIX1 E12: the same safety path on the OTHER bundled circuit, and
 * the honesty gate as it stands on the SHIPPED catalog.
 */
describe('E12 — MotorPark, and the shipped catalog', () => {
  it('MotorPark: a lap boundary suggests nothing and moves nothing', async () => {
    const state = rig({ circuitId: MOTORPARK_CIRCUIT_ID, laps: 4, validated: false });
    const first = await boundary(state, 4);
    expect(first.status).toBe('insufficient');
    expect(first.suggestions?.gate).toBe('geometry-unvalidated');
    expect(first.queued).toEqual([]);
    const second = await boundary(state, 5);
    expect(second.applied).toEqual([]);
    expect(state.applied).toEqual([]);
  });

  it('MotorPark: the pit view is observations only', async () => {
    const state = rig({ circuitId: MOTORPARK_CIRCUIT_ID, laps: 4, validated: false });
    const pit = await state.coach.openPitView(SESSION_ID, 4);
    expect(pit.run.status).toBe('ready');
    expect(pit.suggestions.gate).toBe('geometry-unvalidated');
    expect(pit.suggestions.pitSuggestions).toEqual([]);
  });

  it('MotorPark: corner ids come from the catalog, and every one of them is analysed', async () => {
    const state = rig({ circuitId: MOTORPARK_CIRCUIT_ID, laps: 4, validated: false });
    const pit = await state.coach.openPitView(SESSION_ID, 4);
    if (pit.run.status !== 'ready') throw new Error('expected a ready analysis');
    const catalogIds = bundled(MOTORPARK_CIRCUIT_ID)
      .corners.map((corner) => corner.id)
      .sort((a, b) => a - b);
    expect(pit.run.analysis.insights.corners.map((corner) => corner.cornerId)).toEqual(catalogIds);
  });

  it.each([TMR_CIRCUIT_ID, MOTORPARK_CIRCUIT_ID])(
    'the shipped catalog entry for %s is not field-validated, so the stage suggests nothing',
    async (circuitId) => {
      // Both bundled assets are `community-derived` today. The gate is the
      // contract's (safety rule 5), and this test exists so that flipping an
      // asset to `official` is a deliberate, visible decision rather than a
      // silent one.
      expect(bundled(circuitId).profile.geometryStatus).not.toBe('official');
      const state = rig({ circuitId, laps: 4, validated: false });
      const outcome = await boundary(state, 4);
      expect(outcome.suggestions?.gate).toBe('geometry-unvalidated');
      expect(outcome.queued).toEqual([]);
    },
  );
});
