import { describe, expect, it } from 'vitest';

import {
  assembleSessionAnalysis,
  assembleSessionAnalysisChunked,
  runSessionAnalysis,
  runSessionAnalysisChunked,
  type AnalysisPassPhase,
} from '../../src/session/analysisAssembly';
import { createAnalysisRunner } from '../../src/session/analysisViewModel';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P5-FIX2 W2 (Codex P5-REV finding 14, MEDIUM): the FINAL pass is
 * chunked too.
 *
 * Projecting the laps was already handed back per lap, but everything after it
 * -- the per-lap coverage gate, the per-lap channel stripping and the engine
 * call -- ran as one synchronous block, so a long session still froze the
 * screen after the spinner started. The pass now yields per lap through the
 * final assembly as well, and around the engine call, and every yield is
 * labelled with its phase so this test can tell the two halves apart.
 */

const LAPS = 8;

function drivenSession(laps = LAPS) {
  const { circuit } = allBundledCircuits()[0]!;
  const session = driveSession(circuit, { laps, sampleRateHz: 5, channels: 'full' });
  return { circuit, session };
}

describe('P5-FIX2 W2 -- the final pass hands the thread back too', () => {
  it('yields per lap through the final assembly, after the projection half', async () => {
    const { circuit, session } = drivenSession();
    const phases: AnalysisPassPhase[] = [];
    await assembleSessionAnalysisChunked(circuit, session.recordings, {}, async (phase) => {
      phases.push(phase);
    });

    expect(phases.filter((phase) => phase === 'project')).toHaveLength(LAPS);
    // The gate and the stripping are per lap, so each of them yields per lap.
    expect(phases.filter((phase) => phase === 'coverage').length).toBeGreaterThanOrEqual(LAPS);
    expect(phases.filter((phase) => phase === 'strip').length).toBeGreaterThanOrEqual(LAPS);
    // ... and they happen AFTER the projection, which is what "the final pass
    // is chunked too" means.
    expect(phases.lastIndexOf('project')).toBeLessThan(phases.indexOf('coverage'));
  });

  it('brackets the engine call with its own yields', async () => {
    const { circuit, session } = drivenSession(4);
    const assembled = assembleSessionAnalysis(circuit, session.recordings);
    const phases: AnalysisPassPhase[] = [];
    const insights = await runSessionAnalysisChunked(assembled, async (phase) => {
      phases.push(phase);
    });
    expect(phases).toEqual(['analyze', 'analyze']);
    // The engine stays the engine: same pure result as the synchronous call.
    expect(insights).toEqual(runSessionAnalysis(assembled));
  });

  it('assembles exactly what the synchronous path assembles', async () => {
    const { circuit, session } = drivenSession(4);
    const chunked = await assembleSessionAnalysisChunked(circuit, session.recordings);
    expect(chunked).toEqual(assembleSessionAnalysis(circuit, session.recordings));
  });

  it('turns the event loop DURING the final pass on a large synthetic session', async () => {
    const { circuit, session } = drivenSession(12);
    // A macrotask that reschedules itself: it can only advance while the pass
    // keeps handing the event loop back.
    let ticks = 0;
    let running = true;
    const tick = (): void => {
      ticks += 1;
      if (running) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);

    let ticksWhenFinalPassStarted: number | null = null;
    let finalPassYields = 0;
    const runner = createAnalysisRunner({
      loadSession: async () => ({
        sessionId: session.sessionId,
        circuit,
        displayDateUtc: '2026-08-29T09:15:00.000Z',
        recordings: session.recordings,
      }),
      isSessionActive: () => false,
      yieldToUi: async (phase) => {
        if (phase !== 'project') {
          if (ticksWhenFinalPassStarted === null) ticksWhenFinalPassStarted = ticks;
          finalPassYields += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });

    const result = await runner.run(session.sessionId);
    running = false;
    expect(result.status).toBe('ready');
    expect(finalPassYields).toBeGreaterThanOrEqual(12);
    expect(ticksWhenFinalPassStarted).not.toBeNull();
    // The timer kept firing while the final pass ran -- it was not one block.
    expect(ticks).toBeGreaterThan((ticksWhenFinalPassStarted ?? 0) + 5);
  }, 120_000);
});
