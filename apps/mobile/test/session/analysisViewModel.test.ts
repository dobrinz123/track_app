import { describe, expect, it, vi } from 'vitest';

import {
  buildAnalysisScreenState,
  createAnalysisRunner,
  sessionIsActive,
  type AnalysisSessionSource,
} from '../../src/session/analysisViewModel';
import { ANALYSIS_SCREEN_STRINGS } from '../../src/ui/screens/analysisStrings';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P5b B3 (screen content) and B5 (performance / memoisation). The
 * SCREEN's logic lives here, in a pure module vitest can import -- the `.tsx`
 * stays thin (house rule, same split as `telemetryStripViewModel`).
 *
 * The binding product rules under test: observations only (no advice), RO/EN
 * from the engine's own `reportText` with chrome labels from the strings
 * module, honest limitations, both circuits.
 */

function sourceFor(
  circuitIndex: number,
  options: Parameters<typeof driveSession>[1] = {},
): AnalysisSessionSource {
  const { circuit } = allBundledCircuits()[circuitIndex]!;
  const session = driveSession(circuit, { laps: 4, channels: 'full', ...options });
  return {
    sessionId: session.sessionId,
    circuit,
    displayDateUtc: '2026-08-29T09:15:00.000Z',
    recordings: session.recordings,
  };
}

function readyState(source: AnalysisSessionSource, language: 'ro' | 'en') {
  const runner = createAnalysisRunner({
    loadSession: async () => source,
    isSessionActive: () => false,
  });
  return runner.run(source.sessionId).then((result) => buildAnalysisScreenState(result, language));
}

describe('P5b B3 -- the analysis screen state', () => {
  for (const [index, { circuitId }] of allBundledCircuits().entries()) {
    describe(circuitId, () => {
      it('renders the engine report per corner, in the app language', async () => {
        const source = sourceFor(index);
        const en = await readyState(source, 'en');
        const ro = await readyState(source, 'ro');

        expect(en.status).toBe('ready');
        expect(ro.status).toBe('ready');
        if (en.status !== 'ready' || ro.status !== 'ready') return;

        expect(en.view.corners).toHaveLength(source.circuit.corners.length);
        expect(en.view.corners.map((row) => row.cornerId)).toEqual(
          [...source.circuit.corners].map((corner) => corner.id).sort((a, b) => a - b),
        );
        expect(en.view.corners[0]!.heading).toMatch(/^Corner 1 \((left|right)\)$/);
        expect(ro.view.corners[0]!.heading).toMatch(/^Virajul 1 \((stânga|dreapta)\)$/);
        for (const row of en.view.corners) expect(row.lines.length).toBeGreaterThan(0);
        expect(en.view.title).not.toBe(ro.view.title);
      });

      it('shows the session overview and every limitation the engine reported', async () => {
        const state = await readyState(sourceFor(index), 'en');
        expect(state.status).toBe('ready');
        if (state.status !== 'ready') return;

        expect(state.view.overview.length).toBeGreaterThan(0);
        expect(state.view.limitations.length).toBe(state.insights.limitations.length);
        for (const line of state.view.limitations) expect(line.length).toBeGreaterThan(0);
        expect(state.view.subtitle).toContain(state.insights.circuitName ?? '');
      });

      it('is observations only -- it never tells the driver what to do', async () => {
        for (const language of ['en', 'ro'] as const) {
          const state = await readyState(sourceFor(index), language);
          if (state.status !== 'ready') throw new Error('expected a ready state');
          const prose = [
            ...state.view.overview,
            ...state.view.limitations,
            ...state.view.timeLoss,
            ...state.view.consistency,
            ...state.view.corners.flatMap((row) => row.lines),
          ].join('\n');
          expect(prose).not.toMatch(
            /brake later|lift later|carry more speed|you should|try to|frânează|ridică piciorul mai|ar trebui|încearcă să/i,
          );
          expect(prose).not.toMatch(/NaN|undefined/);
        }
      });
    });
  }

  it('states the time loss per corner from the engine, never its own arithmetic', async () => {
    const state = await readyState(sourceFor(0), 'en');
    if (state.status !== 'ready') throw new Error('expected a ready state');
    for (const row of state.view.corners) {
      const insight = state.insights.corners.find((entry) => entry.cornerId === row.cornerId);
      expect(row.timeLossMs).toBe(insight?.timeLoss?.deltaMs ?? null);
    }
  });

  it('notes a channel that covered too little of the session, with its percentage', async () => {
    const { circuit } = allBundledCircuits()[0]!;
    const session = driveSession(circuit, { laps: 3, channels: 'full' });
    for (const recording of session.recordings) {
      let kept = 0;
      recording.telemetry = recording.telemetry.filter((entry) => {
        if (entry.channel !== 'rpm') return true;
        kept += 1;
        return kept <= 2;
      });
    }
    const state = await readyState(
      {
        sessionId: session.sessionId,
        circuit,
        displayDateUtc: '2026-08-29T09:15:00.000Z',
        recordings: session.recordings,
      },
      'en',
    );
    if (state.status !== 'ready') throw new Error('expected a ready state');
    const note = state.view.notes.find((line) => line.includes(ANALYSIS_SCREEN_STRINGS.en.channelNames.rpm));
    expect(note).toBeDefined();
    expect(note).toMatch(/\d+ %/);
  });

  it('treats every mid-session state as active, and only the three terminal ones as not', () => {
    for (const state of [
      'preflight',
      'awaitingCalibration',
      'calibrating',
      'calibrationReview',
      'armed',
      'outLap',
      'timing',
      'inPit',
      'paused',
    ] as const) {
      expect(sessionIsActive(state), state).toBe(true);
    }
    for (const state of ['idle', 'sessionComplete', 'error'] as const) {
      expect(sessionIsActive(state), state).toBe(false);
    }
  });

  it('refuses to analyse a live session, and says why', async () => {
    const source = sourceFor(0);
    const runner = createAnalysisRunner({
      loadSession: async () => source,
      isSessionActive: () => true,
    });
    const result = await runner.run(source.sessionId);
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('session-active');

    const state = buildAnalysisScreenState(result, 'ro');
    expect(state.status).toBe('unavailable');
    if (state.status !== 'unavailable') return;
    expect(state.message).toBe(ANALYSIS_SCREEN_STRINGS.ro.duringSession);
  });

  it('reports every other honest dead end instead of an empty screen', async () => {
    const missing = await createAnalysisRunner({
      loadSession: async () => null,
      isSessionActive: () => false,
    }).run('nope');
    expect(missing.status === 'unavailable' && missing.reason).toBe('session-not-found');

    const { circuit } = allBundledCircuits()[0]!;
    const noLaps = await createAnalysisRunner({
      loadSession: async () => ({
        sessionId: 's',
        circuit,
        displayDateUtc: '2026-08-29T09:15:00.000Z',
        recordings: [],
      }),
      isSessionActive: () => false,
    }).run('s');
    expect(noLaps.status === 'unavailable' && noLaps.reason).toBe('no-laps');

    const driven = driveSession(circuit, { laps: 2 });
    for (const recording of driven.recordings) recording.locationSamples = [];
    const noTrace = await createAnalysisRunner({
      loadSession: async () => ({
        sessionId: 's',
        circuit,
        displayDateUtc: '2026-08-29T09:15:00.000Z',
        recordings: driven.recordings,
      }),
      isSessionActive: () => false,
    }).run('s');
    expect(noTrace.status === 'unavailable' && noTrace.reason).toBe('no-trace');
  });

  it('surfaces a thrown load as an error state, never a crash', async () => {
    const runner = createAnalysisRunner({
      loadSession: async () => {
        throw new Error('sqlite is gone');
      },
      isSessionActive: () => false,
    });
    const result = await runner.run('s');
    expect(result.status).toBe('error');
    const state = buildAnalysisScreenState(result, 'en');
    expect(state.status).toBe('error');
    if (state.status !== 'error') return;
    expect(state.message).toBe(ANALYSIS_SCREEN_STRINGS.en.failed);
  });
});

describe('P5b B5 -- performance and memoisation', () => {
  it('memoises per session id and reloads for a different one', async () => {
    const first = sourceFor(0);
    const second = { ...sourceFor(1), sessionId: 'other-session' };
    const loadSession = vi.fn(async (sessionId: string) =>
      sessionId === first.sessionId ? first : second,
    );
    const runner = createAnalysisRunner({ loadSession, isSessionActive: () => false });

    const a = await runner.run(first.sessionId);
    const b = await runner.run(first.sessionId);
    expect(loadSession).toHaveBeenCalledTimes(1);
    expect(a.status).toBe('ready');
    if (a.status !== 'ready' || b.status !== 'ready') throw new Error('expected two ready results');
    // The SAME object: the engine ran once, not twice.
    expect(b.insights).toBe(a.insights);

    await runner.run('other-session');
    expect(loadSession).toHaveBeenCalledTimes(2);

    runner.clear();
    await runner.run(first.sessionId);
    expect(loadSession).toHaveBeenCalledTimes(3);
  });

  it('yields to the UI before the synchronous engine pass, so the spinner paints', async () => {
    const source = sourceFor(0, { laps: 2 });
    const yields: number[] = [];
    const runner = createAnalysisRunner({
      loadSession: async () => source,
      isSessionActive: () => false,
      yieldToUi: async () => {
        yields.push(Date.now());
      },
    });
    await runner.run(source.sessionId);
    expect(yields.length).toBeGreaterThanOrEqual(1);
  });

  it('analyses a 20-lap, 1 Hz session without blocking for minutes', async () => {
    const { circuit } = allBundledCircuits()[0]!;
    const session = driveSession(circuit, { laps: 20, sampleRateHz: 1, channels: 'pedal' });
    const runner = createAnalysisRunner({
      loadSession: async () => ({
        sessionId: session.sessionId,
        circuit,
        displayDateUtc: '2026-08-29T09:15:00.000Z',
        recordings: session.recordings,
      }),
      isSessionActive: () => false,
    });
    const startedAt = Date.now();
    const result = await runner.run(session.sessionId);
    const elapsedMs = Date.now() - startedAt;
    expect(result.status).toBe('ready');
    expect(elapsedMs).toBeLessThan(20_000);

    const cachedAt = Date.now();
    await runner.run(session.sessionId);
    expect(Date.now() - cachedAt).toBeLessThan(200);
  }, 60_000);
});
