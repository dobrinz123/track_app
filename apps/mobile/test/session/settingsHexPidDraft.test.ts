import { describe, expect, it } from 'vitest';

/**
 * Telemetry addendum — channel revision (2026-08-11, binding): pins
 * `SettingsScreen.tsx`'s exported `parseHexPidDraft()` validation algorithm.
 * `SettingsScreen.tsx` itself imports `react-native` -- its Flow-typed source
 * breaks vitest's parser under this repo's plain-Node `vitest.config.ts`
 * (same constraint as `settingsPortDraft.test.ts`'s own doc comment), so the
 * component/module cannot be imported here even to reach a single pure named
 * export. This is a byte-for-byte mirror of
 * `apps/mobile/src/ui/screens/SettingsScreen.tsx`'s `parseHexPidDraft()` --
 * keep the two in sync on any future change to either.
 */
function parseHexPidDraft(text: string): string | null {
  if (!/^[0-9A-Fa-f ]*$/.test(text)) return null;
  return text.trim();
}

describe('SettingsScreen trans-oil-PID hex field validation (channel revision)', () => {
  it('accepts a full-string hex value', () => {
    expect(parseHexPidDraft('221E0C')).toBe('221E0C');
    expect(parseHexPidDraft('abcdef')).toBe('abcdef');
    expect(parseHexPidDraft('ABCDEF')).toBe('ABCDEF');
    expect(parseHexPidDraft('0123456789')).toBe('0123456789');
  });

  it('accepts internal spaces (byte-grouping notation), preserved as typed', () => {
    expect(parseHexPidDraft('22 1E 0C')).toBe('22 1E 0C');
  });

  it('trims leading/trailing whitespace on success', () => {
    expect(parseHexPidDraft('  221E0C  ')).toBe('221E0C');
    expect(parseHexPidDraft('  22 1E 0C  ')).toBe('22 1E 0C');
  });

  it('empty or whitespace-only is valid and means "disabled"', () => {
    expect(parseHexPidDraft('')).toBe('');
    expect(parseHexPidDraft('   ')).toBe('');
  });

  it('rejects any non-hex, non-space character anywhere in the string', () => {
    expect(parseHexPidDraft('22-1E')).toBeNull();
    expect(parseHexPidDraft('22G0')).toBeNull();
    expect(parseHexPidDraft('0x221E0C')).toBeNull();
    expect(parseHexPidDraft('221E0C\n')).toBeNull();
    expect(parseHexPidDraft('221E0C;')).toBeNull();
  });
});
