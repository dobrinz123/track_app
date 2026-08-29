import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// `signalFinderExport.ts` imports the real expo modules, whose Flow-typed
// sources this runner cannot parse -- the same doubles `signalFinderExport.test.ts`
// installs, reduced to what merely IMPORTING the module needs.
vi.mock('expo-file-system', () => ({ Paths: { cache: {} }, File: class {} }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => false, shareAsync: async () => undefined }));

import {
  SIGNAL_FINDER_SCREEN_STRINGS,
  resolveSignalFinderScreenStrings,
} from '../../src/ui/screens/signalFinderStrings';
import { SIGNAL_FINDER_SUMMARY_STRINGS } from '../../src/session/signalFinderExport';

/**
 * Ticket P4m-FIX1 X8 (Codex P4m-REV1 finding 9, MEDIUM): "Romanian mode still
 * renders English evidence, statuses, target labels, engine text, banners,
 * next-step instructions, sharing controls and accessibility labels; the RO
 * export also uses English truncation markers and target notes."
 *
 * Two invariants, both checked without rendering anything (this repo has no
 * `@testing-library/react-native`):
 *
 *  1. the RO table has EVERY key the EN table has, at every nesting level, and
 *     the same SHAPE (a function stays a function);
 *  2. `SignalFinderScreen.tsx` contains no English prose of its own — no
 *     multi-word string literal, and no multi-word JSX text node. Whatever the
 *     driver reads comes from a string table or from the target catalog's
 *     per-language data.
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

describe('P4m-FIX1 X8 -- RO/EN completeness', () => {
  it('the screen table has the same keys in both languages', () => {
    assertSameShape(
      SIGNAL_FINDER_SCREEN_STRINGS.en as unknown as Shape,
      SIGNAL_FINDER_SCREEN_STRINGS.ro as unknown as Shape,
      'screen',
    );
  });

  it('the shared-summary table has the same keys in both languages', () => {
    assertSameShape(
      SIGNAL_FINDER_SUMMARY_STRINGS.en as unknown as Shape,
      SIGNAL_FINDER_SUMMARY_STRINGS.ro as unknown as Shape,
      'summary',
    );
  });

  it('every RO string actually differs from its EN counterpart (nothing left untranslated by copy-paste)', () => {
    const en = SIGNAL_FINDER_SCREEN_STRINGS.en as unknown as Record<string, unknown>;
    const ro = SIGNAL_FINDER_SCREEN_STRINGS.ro as unknown as Record<string, unknown>;
    const identical: string[] = [];
    for (const key of Object.keys(en)) {
      const enValue = en[key];
      const roValue = ro[key];
      if (typeof enValue === 'string' && enValue === roValue && enValue.trim().length > 0) identical.push(key);
    }
    // 'Signal Finder' is the tool's own NAME -- the one string that is the same
    // in both languages on purpose.
    expect(identical).toEqual(['screenTitle']);
  });

  it('resolves RO only for the ro setting, English for everything else', () => {
    expect(resolveSignalFinderScreenStrings('ro')).toBe(SIGNAL_FINDER_SCREEN_STRINGS.ro);
    expect(resolveSignalFinderScreenStrings('en')).toBe(SIGNAL_FINDER_SCREEN_STRINGS.en);
    expect(resolveSignalFinderScreenStrings(null)).toBe(SIGNAL_FINDER_SCREEN_STRINGS.en);
  });
});

describe('P4m-FIX1 X8 -- no English left in the screen', () => {
  const source = readFileSync(resolve(__dirname, '../../src/ui/screens/SignalFinderScreen.tsx'), 'utf8');
  // Everything outside a comment: prose inside a line or block comment is
  // documentation, not something the driver ever reads.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  it('has no multi-word string literal (a banner, a label or an a11y string written in place)', () => {
    const literals = [...code.matchAll(/'([^'\\\n]{2,})'|"([^"\\\n]{2,})"/g)].map((m) => m[1] ?? m[2] ?? '');
    const prose = literals.filter((literal) => /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(literal));
    expect(prose).toEqual([]);
  });

  it('has no multi-word JSX text node', () => {
    const textNodes = [...code.matchAll(new RegExp(String.raw`>([^<>{}\n]+)<`, 'g'))].map((m) => (m[1] ?? '').trim());
    // Prose = plain words and spaces on ONE line. (A TypeScript generic's
    // `>...<` also matches the scan; it always carries punctuation, so this
    // shape test keeps the check to what a driver could actually read.)
    const prose = textNodes.filter((text) => /^[A-Za-z][A-Za-z ]{3,}$/.test(text) && /\s/.test(text));
    expect(prose).toEqual([]);
  });

  it('reads its target names from the catalog resolver, never from `target.label`', () => {
    expect(code).toContain('resolveSignalTargetLabel(target, settings.language)');
    expect(code).not.toMatch(/\{target\.label\}/);
  });
});
