import { describe, expect, it } from 'vitest';
import { buildTestLoopCircuit } from '@circuit/core';

import {
  buildAnalysisScreenState,
  createAnalysisRunner,
  type AnalysisSessionSource,
} from '../../src/session/analysisViewModel';
import type { BundledCircuit } from '../../src/session/circuitCatalog';
import { driveSession } from '../support/analysisHarness';
import { rectangleLoopSamples } from '../support/testLoopTraces';

/**
 * Ticket P5d T3 -- the Analysis screen on a TEST-LOOP session: it works
 * unchanged, it names the session a test loop, and it says the geometry is
 * ad-hoc. Nothing about the engine, the corner list or the channels differs;
 * only the two honesty lines are added.
 */

function learnedCircuit(): BundledCircuit {
  const result = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), {
    circuitId: 'learned-analysis',
    displayName: 'Bucla de test',
    createdAtUtc: '2026-08-31T09:00:00.000Z',
  });
  if (!result.ok) throw new Error(`fixture did not learn a loop: ${result.reason}`);
  return { profile: result.profile, runtime: result.runtime, corners: result.corners };
}

function sourceFor(circuit: BundledCircuit): AnalysisSessionSource {
  const session = driveSession(circuit, { laps: 4, channels: 'full' });
  return {
    sessionId: session.sessionId,
    circuit,
    displayDateUtc: '2026-08-31T09:15:00.000Z',
    recordings: session.recordings,
  };
}

async function readyState(source: AnalysisSessionSource, language: 'ro' | 'en') {
  const runner = createAnalysisRunner({
    loadSession: async () => source,
    isSessionActive: () => false,
  });
  const result = await runner.run(source.sessionId);
  return buildAnalysisScreenState(result, language);
}

describe('P5d T3 -- the analysis screen on a learned (test loop) circuit', () => {
  it('runs the ordinary analysis over the learned corners', async () => {
    const circuit = learnedCircuit();
    const state = await readyState(sourceFor(circuit), 'en');

    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.view.corners).toHaveLength(circuit.corners.length);
    expect(state.view.corners[0]!.detail.observations.length).toBeGreaterThan(0);
  });

  it('names it a learned circuit and states the ad-hoc geometry, in both languages', async () => {
    const source = sourceFor(learnedCircuit());
    const en = await readyState(source, 'en');
    const ro = await readyState(source, 'ro');

    expect(en.status).toBe('ready');
    expect(ro.status).toBe('ready');
    if (en.status !== 'ready' || ro.status !== 'ready') return;

    expect(en.view.testLoopBadge).toBe('Learned circuit');
    expect(ro.view.testLoopBadge).toBe('Circuit învățat');
    expect(en.view.testLoopNote).toBeTruthy();
    expect(ro.view.testLoopNote).toBeTruthy();
    expect(ro.view.testLoopNote).not.toBe(en.view.testLoopNote);
  });

  it('says nothing of the sort on a surveyed circuit', async () => {
    const { bundled, TMR_CIRCUIT_ID } = await import('../support/analysisHarness');
    const state = await readyState(sourceFor(bundled(TMR_CIRCUIT_ID)), 'en');

    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.view.testLoopBadge).toBeNull();
    expect(state.view.testLoopNote).toBeNull();
  });
});
