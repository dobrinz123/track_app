import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  TEST_LOOP_STRINGS,
  resolveTestLoopStrings,
} from '../../src/ui/screens/testLoopStrings';

/**
 * Ticket P5d T2 -- the Test Loop screens hold no prose of their own, and RO is
 * never half of EN. Same two invariants (and the same technique, no renderer)
 * as `analysisStrings.test.ts`.
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

describe('P5d -- the Test Loop string table', () => {
  it('has the same keys in both languages', () => {
    assertSameShape(
      TEST_LOOP_STRINGS.en as unknown as Shape,
      TEST_LOOP_STRINGS.ro as unknown as Shape,
      'testLoop',
    );
  });

  it('never leaves an English sentence in the RO table', () => {
    const en = TEST_LOOP_STRINGS.en as unknown as Record<string, unknown>;
    const ro = TEST_LOOP_STRINGS.ro as unknown as Record<string, unknown>;
    for (const key of Object.keys(en)) {
      const enValue = en[key];
      if (typeof enValue !== 'string' || enValue.split(' ').length < 3) continue;
      expect(ro[key], `${key} is still English in the RO table`).not.toBe(enValue);
    }
    for (const reason of Object.keys(TEST_LOOP_STRINGS.en.failure)) {
      const key = reason as keyof typeof TEST_LOOP_STRINGS.en.failure;
      expect(TEST_LOOP_STRINGS.ro.failure[key]).not.toBe(TEST_LOOP_STRINGS.en.failure[key]);
      expect(TEST_LOOP_STRINGS.ro.failure[key].length).toBeGreaterThan(10);
    }
  });

  it('is framed around learning a REAL circuit, not a street test (P5d-FIX6)', () => {
    // The user taps "New circuit" to learn a racetrack the app does not ship.
    // Nothing they read may present that as a street-testing feature.
    expect(TEST_LOOP_STRINGS.en.screenTitle).toBe('New circuit');
    expect(TEST_LOOP_STRINGS.ro.screenTitle).toBe('Circuit nou');
    expect(TEST_LOOP_STRINGS.en.historyLabel).toBe('Learned circuit');
    expect(TEST_LOOP_STRINGS.ro.historyLabel).toBe('Circuit învățat');
    for (const language of ['en', 'ro'] as const) {
      const strings = TEST_LOOP_STRINGS[language];
      const surface = [
        strings.screenTitle,
        strings.entryTitle,
        strings.entrySubtitle,
        strings.intro,
        strings.howItWorks,
        strings.historyLabel,
        strings.learnedHint,
      ].join(' ');
      expect(surface.toLowerCase()).not.toContain('test loop');
      expect(surface.toLowerCase()).not.toContain('buclă de test');
      // ...and the circuit IS what the intro is about.
      expect(strings.intro.toLowerCase()).toMatch(/circuit/);
      // The street case survives as an explicitly scoped, legal-only note.
      expect(strings.streetNote.length).toBeGreaterThan(30);
      expect(strings.streetNote.toUpperCase()).toMatch(/LEGAL/);
    }
  });

  it('says the safety line and the honesty line in both languages', () => {
    for (const language of ['en', 'ro'] as const) {
      const strings = TEST_LOOP_STRINGS[language];
      expect(strings.intro.length).toBeGreaterThan(40);
      expect(strings.cuesOff.length).toBeGreaterThan(20);
      expect(strings.adHocNote.length).toBeGreaterThan(20);
      expect(strings.learnedLabel.length).toBeGreaterThan(5);
    }
    expect(TEST_LOOP_STRINGS.ro.learnedLabel).toBe('învățat (geometrie ad-hoc)');
    expect(TEST_LOOP_STRINGS.en.learnedLabel).toBe('learned (ad-hoc geometry)');
  });

  it('resolves the app language setting, defaulting anything unknown to English', () => {
    expect(resolveTestLoopStrings('ro')).toBe(TEST_LOOP_STRINGS.ro);
    expect(resolveTestLoopStrings('en')).toBe(TEST_LOOP_STRINGS.en);
    expect(resolveTestLoopStrings(null)).toBe(TEST_LOOP_STRINGS.en);
    expect(resolveTestLoopStrings('de')).toBe(TEST_LOOP_STRINGS.en);
  });

  it('TestLoopScreen.tsx holds no prose of its own', () => {
    const source = readFileSync(
      resolve(__dirname, '../../src/ui/screens/TestLoopScreen.tsx'),
      'utf8',
    )
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n');
    // Any run of three or more English-looking words inside a JSX text node
    // would be prose the string table does not own.
    const jsxText = [...source.matchAll(/>\s*([A-Za-z][A-Za-z ,.'’-]{12,})\s*</g)].map(
      (match) => match[1],
    );
    expect(jsxText).toEqual([]);
  });
});
