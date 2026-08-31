import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ticket P5c-FIX1 E13 (contracts.md R2-2): the PIT view's expanded corner is a
 * VISUAL, exactly like the Analysis screen's — the same `detail.visual` marks,
 * drawn by the same shared component. It used to be a five-column numeric
 * table, which is what R2-2 replaced everywhere else.
 *
 * Both screens are renderers, so what they render is asserted on their source
 * (the pattern `analysisCornerVisual.test.ts` established) while everything
 * with a number in it is asserted on the view model in `pitViewModel.test.ts`.
 */
function read(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

const PIT_SCREEN = read('../../src/ui/screens/PitViewScreen.tsx');
const ANALYSIS_SCREEN = read('../../src/ui/screens/AnalysisScreen.tsx');
const COMPONENT = read('../../src/ui/components/CornerVisual.tsx');

describe('P5c-FIX1 E13 — the pit view draws the corner, it does not tabulate it', () => {
  it('renders the corner detail VISUAL', () => {
    expect(PIT_SCREEN).toMatch(/detail\.visual/);
    expect(PIT_SCREEN).toMatch(/<CornerVisual/);
  });

  it('no longer renders the per-lap numeric table', () => {
    expect(PIT_SCREEN).not.toMatch(/detail\.perLap/);
    expect(PIT_SCREEN).not.toMatch(/detailCell/);
  });

  it('draws it with the SAME component the analysis screen uses', () => {
    for (const screen of [PIT_SCREEN, ANALYSIS_SCREEN]) {
      expect(screen).toMatch(/from '\.\.\/components\/CornerVisual'/);
      expect(screen).toMatch(/<CornerVisual/);
    }
    // The marks themselves are positioned from the view model, in one place.
    expect(COMPONENT).toMatch(/mark\.position/);
    expect(COMPONENT).toMatch(/row\.a11yLabel/);
  });

  it('records only what it showed (E8)', () => {
    expect(PIT_SCREEN).toMatch(/recordShown\(/);
    expect(PIT_SCREEN).toMatch(/shownSuggestions/);
  });
});
