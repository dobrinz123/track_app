import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_CHANNELS } from '@circuit/core';

import {
  ANALYSIS_SCREEN_STRINGS,
  resolveAnalysisScreenStrings,
} from '../../src/ui/screens/analysisStrings';

/**
 * Ticket P5b B3 (binding): "in the app language (RO/EN via reportText -- the
 * engine already renders localized text; the screen adds only chrome labels,
 * put THOSE in a strings module RO/EN)".
 *
 * Two invariants, both checked without rendering anything (this repo has no
 * `@testing-library/react-native`), exactly as `signalFinderStrings.test.ts`
 * pins them for the Signal Finder:
 *
 *  1. the RO table has EVERY key the EN table has, at every nesting level, and
 *     the same SHAPE (a function stays a function);
 *  2. `AnalysisScreen.tsx` contains no English prose of its own.
 */

type Shape = Record<string, unknown>;

function assertSameShape(en: Shape, ro: Shape, path: string): void {
  for (const key of Object.keys(en)) {
    const enValue = en[key];
    const roValue = ro[key];
    expect(roValue, `${path}.${key} is missing from the RO table`).toBeDefined();
    expect(typeof roValue, `${path}.${key} has a different shape in RO`).toBe(typeof enValue);
    if (typeof enValue === 'object' && enValue !== null) {
      assertSameShape(enValue as Shape, roValue as Shape, `${path}.${key}`);
    }
  }
  for (const key of Object.keys(ro)) {
    expect(Object.keys(en), `${path}.${key} exists only in RO`).toContain(key);
  }
}

describe('P5b -- the analysis screen string table', () => {
  it('has the same keys in both languages', () => {
    assertSameShape(
      ANALYSIS_SCREEN_STRINGS.en as unknown as Shape,
      ANALYSIS_SCREEN_STRINGS.ro as unknown as Shape,
      'screen',
    );
  });

  it('never repeats an English string in the RO table', () => {
    const en = ANALYSIS_SCREEN_STRINGS.en as unknown as Record<string, unknown>;
    const ro = ANALYSIS_SCREEN_STRINGS.ro as unknown as Record<string, unknown>;
    for (const key of Object.keys(en)) {
      const enValue = en[key];
      if (typeof enValue !== 'string' || enValue.split(' ').length < 3) continue;
      expect(ro[key], `${key} is still English in the RO table`).not.toBe(enValue);
    }
  });

  it('names every analysis channel in both languages', () => {
    for (const channel of ANALYSIS_CHANNELS) {
      expect(ANALYSIS_SCREEN_STRINGS.en.channelNames[channel]).toBeTruthy();
      expect(ANALYSIS_SCREEN_STRINGS.ro.channelNames[channel]).toBeTruthy();
    }
  });

  it('resolves the app language setting, defaulting anything unknown to English', () => {
    expect(resolveAnalysisScreenStrings('ro')).toBe(ANALYSIS_SCREEN_STRINGS.ro);
    expect(resolveAnalysisScreenStrings('en')).toBe(ANALYSIS_SCREEN_STRINGS.en);
    expect(resolveAnalysisScreenStrings(null)).toBe(ANALYSIS_SCREEN_STRINGS.en);
    expect(resolveAnalysisScreenStrings('de')).toBe(ANALYSIS_SCREEN_STRINGS.en);
  });

  it('AnalysisScreen.tsx holds no prose of its own', () => {
    const source = readFileSync(
      resolve(__dirname, '../../src/ui/screens/AnalysisScreen.tsx'),
      'utf8',
    )
      // Comments and imports may be English; what the DRIVER reads may not.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/^import[\s\S]*?from\s*'[^']*';$/gm, '');

    const stringLiterals = source.match(/'[^']{2,}'|"[^"]{2,}"/g) ?? [];
    for (const literal of stringLiterals) {
      const value = literal.slice(1, -1);
      // Style values, ids, route names and accessibility ROLES are single
      // words or hyphen/camel tokens; prose is several spaced words.
      if (!/^[A-Za-z][A-Za-z]*( [a-z]| [A-Z])/.test(value)) continue;
      expect.unreachable(`AnalysisScreen.tsx carries its own prose: ${literal}`);
    }

    const jsxText = source.match(/>\s*[A-Za-z][^<>{}\n]*\s+[A-Za-z][^<>{}\n]*</g) ?? [];
    expect(jsxText, `AnalysisScreen.tsx carries its own JSX prose`).toEqual([]);
  });
});
