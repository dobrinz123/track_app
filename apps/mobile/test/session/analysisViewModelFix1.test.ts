import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '@circuit/core';

import {
  buildAnalysisScreenState,
  createAnalysisController,
  createAnalysisRunner,
  sessionIsActive,
  type AnalysisRunResult,
  type AnalysisSessionSource,
} from '../../src/session/analysisViewModel';
import { ANALYSIS_SCREEN_STRINGS } from '../../src/ui/screens/analysisStrings';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P5b-FIX1 (Codex P5b-REV1 findings 1/4/5/6 and user finding F2,
 * ratified as contracts.md "Phase 5 REVISION 2" R2-2): the session-active
 * correctness of the runner, the chunked pass, the shared runner, and the
 * INTERACTIVE report (corner rows are name + badges; the numbers and the
 * engine's sentence live in the corner detail).
 *
 * All of it in the view model, as the house rule requires -- the `.tsx` is a
 * renderer with no logic of its own.
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

/** A fake session facade: the screen's only source of "is a session running". */
function fakeFacade(initial: SessionState = 'idle') {
  const listeners = new Set<(state: SessionState) => void>();
  let current = initial;
  return {
    isActive: (): boolean => sessionIsActive(current),
    set(next: SessionState): void {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
    subscribe(cb: (state: SessionState) => void): () => void {
      listeners.add(cb);
      cb(current);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Lets the chunked pass finish: it hands the thread back once per lap. */
async function settle(check: () => boolean, turns = 60): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (check()) return;
    await flush();
  }
}

describe('P5b-FIX1 C1 -- session-active correctness', () => {
  it('never publishes an analysis when a session starts mid-run, and never caches "session-active"', async () => {
    const source = sourceFor(0, { laps: 2 });
    const facade = fakeFacade('idle');
    const gate = deferred<AnalysisSessionSource>();
    const runner = createAnalysisRunner({
      loadSession: () => gate.promise,
      isSessionActive: facade.isActive,
    });

    const run = runner.run(source.sessionId);
    facade.set('timing');
    gate.resolve(source);
    const result = await run;
    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' && result.reason).toBe('session-active');

    // ... and that verdict is NOT memoised: once the session ends, the same
    // runner analyses the same id.
    facade.set('sessionComplete');
    const again = await runner.run(source.sessionId);
    expect(again.status).toBe('ready');
  });

  it('rechecks after the heavy pass, before publishing a ready result', async () => {
    const source = sourceFor(0, { laps: 2 });
    const facade = fakeFacade('idle');
    const runner = createAnalysisRunner({
      loadSession: async () => {
        facade.set('timing');
        return source;
      },
      isSessionActive: facade.isActive,
    });
    const result = await runner.run(source.sessionId);
    expect(result.status === 'unavailable' && result.reason).toBe('session-active');
  });

  it('hides an analysis when a session starts while the screen is open', async () => {
    const source = sourceFor(0, { laps: 2 });
    const facade = fakeFacade('idle');
    const runner = createAnalysisRunner({
      loadSession: async () => source,
      isSessionActive: facade.isActive,
    });
    const controller = createAnalysisController({
      runner,
      sessionId: source.sessionId,
      subscribeSessionState: facade.subscribe,
    });
    const seen: (AnalysisRunResult | null)[] = [];
    controller.subscribe((result) => seen.push(result));
    await settle(() => seen.at(-1)?.status === 'ready');
    expect(seen.at(-1)?.status).toBe('ready');

    facade.set('timing');
    const last = seen.at(-1);
    expect(last?.status).toBe('unavailable');
    expect(last?.status === 'unavailable' && last.reason).toBe('session-active');
    controller.dispose();
  });

  it('makes the analysis available again when the session ends, without re-entering the screen', async () => {
    const source = sourceFor(0, { laps: 2 });
    const facade = fakeFacade('timing');
    const runner = createAnalysisRunner({
      loadSession: async () => source,
      isSessionActive: facade.isActive,
    });
    const controller = createAnalysisController({
      runner,
      sessionId: source.sessionId,
      subscribeSessionState: facade.subscribe,
    });
    const seen: (AnalysisRunResult | null)[] = [];
    controller.subscribe((result) => seen.push(result));
    await flush();
    const blocked = seen.at(-1);
    expect(blocked?.status === 'unavailable' && blocked.reason).toBe('session-active');

    facade.set('sessionComplete');
    await settle(() => seen.at(-1)?.status === 'ready');
    expect(seen.at(-1)?.status).toBe('ready');
    controller.dispose();
  });
});

describe('P5b-FIX1 C4 -- "measured" covers every observable metric', () => {
  it('counts a corner measured when the engine only produced lateral G', async () => {
    const state = await readyState(sourceFor(0), 'en');
    if (state.status !== 'ready') throw new Error('expected a ready state');
    const corner = state.insights.corners[0]!;
    const latGOnly = {
      ...state.insights,
      corners: [
        {
          ...corner,
          perLap: corner.perLap.map((row, index) => ({
            ...row,
            sectorMs: null,
            minSpeedKph: null,
            brakeStartM: null,
            liftPointM: null,
            exitSpeedKph: null,
            peakDecelG: null,
            throttleOnM: null,
            frictionCircleMaxG: null,
            maxLatG: index === 0 ? 1.1 : null,
          })),
        },
      ],
    };
    const built = buildAnalysisScreenState(
      { status: 'ready', source: state.source, assembled: state.assembled, insights: latGOnly },
      'en',
    );
    if (built.status !== 'ready') throw new Error('expected a ready state');
    expect(built.view.corners[0]!.measured).toBe(true);
  });

  it('still reports a corner with no measurement at all', async () => {
    const state = await readyState(sourceFor(0), 'en');
    if (state.status !== 'ready') throw new Error('expected a ready state');
    const corner = state.insights.corners[0]!;
    const nothing = {
      ...state.insights,
      corners: [
        {
          ...corner,
          perLap: corner.perLap.map((row) => ({
            ...row,
            sectorMs: null,
            minSpeedKph: null,
            brakeStartM: null,
            liftPointM: null,
            exitSpeedKph: null,
            peakDecelG: null,
            throttleOnM: null,
            frictionCircleMaxG: null,
            maxLatG: null,
          })),
        },
      ],
    };
    const built = buildAnalysisScreenState(
      { status: 'ready', source: state.source, assembled: state.assembled, insights: nothing },
      'en',
    );
    if (built.status !== 'ready') throw new Error('expected a ready state');
    expect(built.view.corners[0]!.measured).toBe(false);
    expect(built.view.corners[0]!.detail.observations).toContain(
      ANALYSIS_SCREEN_STRINGS.en.cornerNotMeasured,
    );
  });
});

describe('P5b-FIX1 C5 -- the analysis is chunked, so the UI keeps running', () => {
  it('turns the event loop between laps rather than blocking for the whole pass', async () => {
    const { circuit } = allBundledCircuits()[0]!;
    const laps = 6;
    const session = driveSession(circuit, { laps, sampleRateHz: 2, channels: 'pedal' });
    const runner = createAnalysisRunner({
      loadSession: async () => ({
        sessionId: session.sessionId,
        circuit,
        displayDateUtc: '2026-08-29T09:15:00.000Z',
        recordings: session.recordings,
      }),
      isSessionActive: () => false,
    });

    // A macrotask that reschedules itself: it can only advance while the
    // analysis keeps handing the event loop back.
    let ticks = 0;
    let running = true;
    const tick = (): void => {
      ticks += 1;
      if (running) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);

    const result = await runner.run(session.sessionId);
    running = false;
    expect(result.status).toBe('ready');
    expect(ticks).toBeGreaterThanOrEqual(laps);
  }, 60_000);

  it('yields at least once per lap through the injected yield', async () => {
    const source = sourceFor(0, { laps: 4 });
    let yields = 0;
    const runner = createAnalysisRunner({
      loadSession: async () => source,
      isSessionActive: () => false,
      yieldToUi: async () => {
        yields += 1;
      },
    });
    await runner.run(source.sessionId);
    expect(yields).toBeGreaterThanOrEqual(4);
  });
});

describe('P5b-FIX1 C6 -- one shared runner, joined rather than restarted', () => {
  it('re-entering the screen joins the in-flight run of the shared runner', async () => {
    const source = sourceFor(0, { laps: 2 });
    const gate = deferred<AnalysisSessionSource>();
    const loadSession = vi.fn(() => gate.promise);
    const runner = createAnalysisRunner({ loadSession, isSessionActive: () => false });
    const facade = fakeFacade('idle');

    const first = createAnalysisController({
      runner,
      sessionId: source.sessionId,
      subscribeSessionState: facade.subscribe,
    });
    first.subscribe(() => undefined);
    // The driver leaves the screen while the run is still in flight ...
    first.dispose();
    const second = createAnalysisController({
      runner,
      sessionId: source.sessionId,
      subscribeSessionState: facade.subscribe,
    });
    const seen: (AnalysisRunResult | null)[] = [];
    second.subscribe((result) => seen.push(result));
    gate.resolve(source);
    await settle(() => seen.at(-1)?.status === 'ready');

    // ... and re-entering it joined that same run: ONE load, one engine pass.
    expect(loadSession).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)?.status).toBe('ready');
    second.dispose();
  });
});

describe('P5b-FIX1 C10 -- the interactive report (user F2 / contracts R2-2)', () => {
  it('gives every corner row a name and badges only -- no prose', async () => {
    const state = await readyState(sourceFor(0), 'en');
    if (state.status !== 'ready') throw new Error('expected a ready state');
    for (const row of state.view.corners) {
      expect(row.heading.length).toBeGreaterThan(0);
      for (const badge of row.badges) {
        // A badge is a label, not a sentence.
        expect(badge).not.toMatch(/\.$/);
        expect(badge.length).toBeLessThanOrEqual(40);
      }
    }
    expect(state.view.corners.filter((row) => row.badges.length > 0).length).toBeGreaterThan(0);
  });

  it('carries the badges the user asked for: time lost/gained, consistency, v_min -> exit', async () => {
    const state = await readyState(sourceFor(0), 'en');
    if (state.status !== 'ready') throw new Error('expected a ready state');
    const withLoss = state.view.corners.find((row) => row.timeLossLabel !== null);
    expect(withLoss).toBeDefined();
    expect(withLoss!.badges).toContain(withLoss!.timeLossLabel);
    const withSpeed = state.view.corners.find((row) => row.speedLabel !== null);
    expect(withSpeed).toBeDefined();
    expect(withSpeed!.speedLabel).toContain('→');
    for (const row of state.view.corners) {
      const insight = state.insights.corners.find((entry) => entry.cornerId === row.cornerId)!;
      if (insight.consistency?.score == null) {
        expect(row.consistencyLabel).toBeNull();
      } else {
        expect(row.consistencyLabel).toContain(String(insight.consistency.score));
      }
    }
  });

  it('expands a corner into per-lap values, the demonstrated envelope and the engine sentence', async () => {
    for (const language of ['en', 'ro'] as const) {
      const state = await readyState(sourceFor(0), language);
      if (state.status !== 'ready') throw new Error('expected a ready state');
      const row = state.view.corners[0]!;
      const insight = state.insights.corners.find((entry) => entry.cornerId === row.cornerId)!;

      expect(row.detail.perLap.map((lap) => lap.lapNumber)).toEqual(
        insight.perLap.map((lap) => lap.lapNumber),
      );
      const columns = row.detail.columns;
      for (const label of [
        columns.lap,
        columns.brake,
        columns.lift,
        columns.minSpeed,
        columns.exit,
        columns.peakDecel,
        columns.latG,
      ]) {
        expect(label.length).toBeGreaterThan(0);
      }
      for (const lap of row.detail.perLap) {
        expect(lap.brake.length).toBeGreaterThan(0);
        expect(lap.minSpeed.length).toBeGreaterThan(0);
        expect(
          `${lap.brake}${lap.lift}${lap.minSpeed}${lap.exit}${lap.peakDecel}${lap.latG}`,
        ).not.toMatch(/NaN|undefined|null/);
      }
      // The engine's own observation sentences live in the DETAIL, never in the row.
      expect(row.detail.observations.length).toBeGreaterThan(0);
      if (insight.envelope !== null && insight.envelope.evidenceLapIds.length > 0) {
        expect(row.detail.envelopeLine).not.toBeNull();
      }
    }
  });

  it('shows the brake point with its uncertainty when the engine reported one', async () => {
    const state = await readyState(sourceFor(0), 'en');
    if (state.status !== 'ready') throw new Error('expected a ready state');
    const corner = state.insights.corners[0]!;
    const withUncertainty = {
      ...state.insights,
      corners: [
        {
          ...corner,
          perLap: corner.perLap.map((row, index) =>
            index === 0 ? { ...row, brakeStartM: 42, brakeOnsetUncertaintyM: 6 } : row,
          ),
        },
      ],
    };
    const built = buildAnalysisScreenState(
      {
        status: 'ready',
        source: state.source,
        assembled: state.assembled,
        insights: withUncertainty,
      },
      'en',
    );
    if (built.status !== 'ready') throw new Error('expected a ready state');
    expect(built.view.corners[0]!.detail.perLap[0]!.brake).toContain('±');
  });

  it('keeps limitations and recording notes as compact chips, not paragraphs', async () => {
    for (const language of ['en', 'ro'] as const) {
      const state = await readyState(sourceFor(0), language);
      if (state.status !== 'ready') throw new Error('expected a ready state');
      expect(state.view.limitationChips.length).toBe(
        new Set(state.insights.limitations.map((entry) => entry.code)).size,
      );
      for (const chip of [...state.view.limitationChips, ...state.view.summaryChips]) {
        expect(chip.length).toBeLessThanOrEqual(48);
        expect(chip).not.toMatch(/NaN|undefined/);
      }
      expect(state.view.summaryChips.length).toBeGreaterThan(0);
    }
  });
});
