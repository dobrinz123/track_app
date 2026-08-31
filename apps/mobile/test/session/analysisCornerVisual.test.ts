import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildAnalysisScreenState,
  createAnalysisRunner,
  type AnalysisSessionSource,
} from '../../src/session/analysisViewModel';
import { ANALYSIS_SCREEN_STRINGS } from '../../src/ui/screens/analysisStrings';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P5-FIX2 W4 (Codex P5-REV finding 16, MEDIUM; contracts.md R2-2): the
 * expanded corner card is VISUAL.
 *
 * It had a text table and the engine's complete corner prose — the opposite of
 * what R2-2 asks for. It now carries a compact mark row per lap (where the
 * driver braked and lifted, positioned along the approach to the corner, with
 * v_min and exit as compact figures), and the engine's sentences stay in the
 * EXPORT. All of it is data on the view model, so it is testable here rather
 * than only in a screenshot.
 */

function readSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

function sourceFor(): AnalysisSessionSource {
  const { circuit } = allBundledCircuits()[0]!;
  const session = driveSession(circuit, { laps: 4, channels: 'full' });
  return {
    sessionId: session.sessionId,
    circuit,
    displayDateUtc: '2026-08-29T09:15:00.000Z',
    recordings: session.recordings,
  };
}

async function readyState(language: 'ro' | 'en' = 'en') {
  const source = sourceFor();
  const runner = createAnalysisRunner({
    loadSession: async () => source,
    isSessionActive: () => false,
  });
  const state = buildAnalysisScreenState(await runner.run(source.sessionId), language);
  if (state.status !== 'ready') throw new Error(`expected a ready state, got ${state.status}`);
  return state;
}

describe('P5-FIX2 W4 -- the corner detail is a visual, in the view model', () => {
  it('gives every measured corner a mark row per lap', async () => {
    const state = await readyState();
    const measured = state.view.corners.filter((corner) => corner.measured);
    expect(measured.length).toBeGreaterThan(0);
    for (const corner of measured) {
      const visual = corner.detail.visual;
      expect(visual).not.toBeNull();
      expect(visual!.rows.map((row) => row.lapNumber)).toEqual(
        corner.detail.perLap.map((row) => row.lapNumber),
      );
      expect(visual!.axisStartM).toBeGreaterThan(0);
      for (const row of visual!.rows) {
        for (const mark of row.marks) {
          expect(mark.position).toBeGreaterThanOrEqual(0);
          expect(mark.position).toBeLessThanOrEqual(1);
          expect(mark.label).not.toMatch(/NaN|undefined|null/);
          if (mark.uncertainty !== null) {
            expect(mark.uncertainty).toBeGreaterThanOrEqual(0);
            expect(mark.uncertainty).toBeLessThanOrEqual(1);
          }
        }
        for (const bar of [row.minSpeedBar, row.exitBar]) {
          if (bar === null) continue;
          expect(bar).toBeGreaterThanOrEqual(0);
          expect(bar).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('positions the marks relative to the corner: further out is further left', async () => {
    const state = await readyState();
    const corner = state.insights.corners[0]!;
    const synthetic = {
      ...state.insights,
      corners: [
        {
          ...corner,
          perLap: corner.perLap.map((row, index) =>
            index === 0
              ? { ...row, brakeStartM: 100, liftPointM: 150, brakeOnsetUncertaintyM: 10 }
              : { ...row, brakeStartM: 50, liftPointM: 60, brakeOnsetUncertaintyM: null },
          ),
        },
      ],
    };
    const built = buildAnalysisScreenState(
      { status: 'ready', source: state.source, assembled: state.assembled, insights: synthetic },
      'en',
    );
    if (built.status !== 'ready') throw new Error('expected a ready state');
    const visual = built.view.corners[0]!.detail.visual!;
    // The axis spans the earliest point any lap produced, up to the entry.
    expect(visual.axisStartM).toBeGreaterThanOrEqual(150);

    const first = visual.rows[0]!;
    const brake = first.marks.find((mark) => mark.kind === 'brake')!;
    const lift = first.marks.find((mark) => mark.kind === 'lift')!;
    // 150 m before the entry is FURTHER from it than 100 m: the lift sits left
    // of the brake, and both sit left of the entry (position 1).
    expect(lift.position).toBeLessThan(brake.position);
    expect(brake.position).toBeLessThan(1);
    expect(brake.uncertainty).toBeGreaterThan(0);
    // A later brake point on lap 1 than on lap 2 shows as a mark further right.
    const second = visual.rows[1]!;
    const laterBrake = second.marks.find((mark) => mark.kind === 'brake')!;
    expect(laterBrake.position).toBeGreaterThan(brake.position);
  });

  it('states v_min and exit as compact figures, in the language of the screen', async () => {
    for (const language of ['en', 'ro'] as const) {
      const state = await readyState(language);
      const corner = state.view.corners.find(
        (row) => row.detail.visual?.rows.some((mark) => mark.minSpeed !== null) === true,
      );
      expect(corner).toBeDefined();
      const visual = corner!.detail.visual!;
      const row = visual.rows.find((entry) => entry.minSpeed !== null)!;
      // A compact figure: the number only, the unit says itself once in the caption.
      expect(row.minSpeed).toMatch(language === 'ro' ? /^\d+,\d$/ : /^\d+\.\d$/);
      expect(visual.speedCaption.toLowerCase()).toContain('km/h');
      expect(visual.brakeLabel.length).toBeGreaterThan(0);
      expect(visual.liftLabel.length).toBeGreaterThan(0);
      expect(visual.axisEntryLabel.length).toBeGreaterThan(0);
      expect(visual.axisStartLabel).toContain('m');
      // Every mark row is announced as one line to a screen reader.
      expect(row.a11yLabel).toContain(String(row.lapNumber));
    }
  });

  it('is null for a corner the engine measured nothing in', async () => {
    const state = await readyState();
    const corner = state.insights.corners[0]!;
    const blank = {
      ...state.insights,
      corners: [
        {
          ...corner,
          perLap: corner.perLap.map((row) => ({
            ...row,
            brakeStartM: null,
            liftPointM: null,
            brakeOnsetUncertaintyM: null,
            minSpeedKph: null,
            exitSpeedKph: null,
          })),
        },
      ],
    };
    const built = buildAnalysisScreenState(
      { status: 'ready', source: state.source, assembled: state.assembled, insights: blank },
      'en',
    );
    if (built.status !== 'ready') throw new Error('expected a ready state');
    expect(built.view.corners[0]!.detail.visual).toBeNull();
  });

  it('keeps the RO and EN visual chrome in step', () => {
    for (const language of ['en', 'ro'] as const) {
      const strings = ANALYSIS_SCREEN_STRINGS[language];
      expect(strings.markBrake.length).toBeGreaterThan(0);
      expect(strings.markLift.length).toBeGreaterThan(0);
      expect(strings.markAxisEntry.length).toBeGreaterThan(0);
      expect(strings.markAxisStart('120 m')).toContain('120 m');
      expect(strings.markSpeedCaption.toLowerCase()).toContain('km/h');
      expect(strings.markRowA11y(3, 'x')).toContain('3');
    }
    expect(ANALYSIS_SCREEN_STRINGS.ro.markBrake).not.toBe(ANALYSIS_SCREEN_STRINGS.en.markBrake);
  });
});

describe('P5-FIX2 W4 -- the screen draws marks and no engine prose (R2-2)', () => {
  const source = readSource('../../src/ui/screens/AnalysisScreen.tsx');

  it('renders the mark row from the view model', () => {
    expect(source).toMatch(/detail\.visual/);
    expect(source).toMatch(/mark\.position/);
  });

  it('no longer renders the engine sentences in the expanded card', () => {
    expect(source).not.toMatch(/detail\.observations/);
  });

  it('keeps the observations on the view model, for the export', async () => {
    const state = await readyState();
    expect(state.view.corners[0]!.detail.observations.length).toBeGreaterThan(0);
  });
});
