import { describe, expect, it } from 'vitest';

/**
 * F11 fix (WPT3, LOW): pins `SettingsScreen.tsx`'s exported `parsePortDraft()`
 * validation algorithm. `SettingsScreen.tsx` itself imports `react-native`
 * (`Pressable`/`ScrollView`/`TextInput`/etc.) -- its Flow-typed source breaks
 * vitest's parser under this repo's plain-Node `vitest.config.ts`
 * (`environment: 'node'`, no RN test renderer; see `composition.ts`'s own
 * `IS_WEB_RUNTIME` doc comment and `composition.recovery.test.ts`'s doc
 * comment for the SAME constraint applied to composition.ts's own private
 * helpers), so the component/module cannot be imported here even to reach a
 * single pure named export. This is a byte-for-byte mirror of
 * `apps/mobile/src/ui/screens/SettingsScreen.tsx`'s `parsePortDraft()` --
 * keep the two in sync on any future change to either.
 */
function parsePortDraft(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) return null;
  return parsed;
}

describe('SettingsScreen port field validation (F11 fix)', () => {
  it('accepts a full-string integer in [1, 65535]', () => {
    expect(parsePortDraft('35000')).toBe(35_000);
    expect(parsePortDraft('1')).toBe(1);
    expect(parsePortDraft('65535')).toBe(65_535);
  });

  it('rejects partial-numeric garbage instead of silently truncating it (the pre-fix bug: parseInt("123abc", 10) === 123)', () => {
    expect(parsePortDraft('123abc')).toBeNull();
    expect(parsePortDraft('abc123')).toBeNull();
    expect(parsePortDraft('12 34')).toBeNull();
    expect(parsePortDraft('1.5')).toBeNull();
  });

  it('rejects empty, zero, negative, and out-of-range values', () => {
    expect(parsePortDraft('')).toBeNull();
    expect(parsePortDraft('0')).toBeNull();
    expect(parsePortDraft('-1')).toBeNull();
    expect(parsePortDraft('65536')).toBeNull();
    expect(parsePortDraft('999999')).toBeNull();
  });
});
