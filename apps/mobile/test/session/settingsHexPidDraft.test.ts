import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PID_VALIDATION_ERROR,
  isAllowedCustomPidRequest,
  validateCustomPidHex,
} from '../../src/session/customPidValidation';

/**
 * F1 HIGH fix (channel revision, binding): pins `customPidValidation.ts`'s
 * `validateCustomPidHex` -- the SHARED L1 (`SettingsScreen.tsx`'s
 * `parseHexPidDraft`, a thin wrapper around this) + L2
 * (`telemetryProvider.ts`'s `buildCustomPids`) validator, imported directly
 * from production (no copied regex -- the review's own HIGH finding was that
 * the previous version of this test mirrored a PERMISSIVE hex-only regex
 * that had no read-service whitelist at all, so a value like `04` passed
 * both the test and production validation and was forwarded as a live OBD
 * request). `customPidValidation.ts` is a pure module (no react-native
 * import), unlike `SettingsScreen.tsx` itself, which still can't be imported
 * here (its `react-native` import breaks vitest's parser -- see
 * `settingsPortDraft.test.ts`'s own doc comment for that constraint).
 */
describe('customPidValidation.validateCustomPidHex (F1 HIGH fix, channel revision, binding)', () => {
  it('empty or whitespace-only is valid and means "disabled"', () => {
    expect(validateCustomPidHex('')).toEqual({ ok: true, value: '', error: null });
    expect(validateCustomPidHex('   ')).toEqual({ ok: true, value: '', error: null });
  });

  it('rejects any non-hex, non-space character anywhere in the string', () => {
    expect(validateCustomPidHex('22-1E')).toEqual({
      ok: false,
      value: '22-1E',
      error: CUSTOM_PID_VALIDATION_ERROR,
    });
    expect(validateCustomPidHex('0x221E1C')).toEqual({
      ok: false,
      value: '0x221E1C',
      error: CUSTOM_PID_VALIDATION_ERROR,
    });
    expect(validateCustomPidHex('221E1C\n').ok).toBe(false);
    expect(validateCustomPidHex('221E1C;').ok).toBe(false);
  });

  it('accepts internal spaces (byte-grouping notation) and trims outer whitespace', () => {
    expect(validateCustomPidHex('  22 1E 1C  ')).toEqual({ ok: true, value: '22 1E 1C', error: null });
  });

  /**
   * The exact table the ticket pins: '04', '0101', '015C' rejected (wrong
   * service byte -- '015C' specifically is the F3 mode-01 collision case,
   * since standard PID 0x5C already decodes correctly as `engineOilC`);
   * '221E1C' and '21AB' accepted (service 22/21, even length >= 4); '221E0'
   * rejected for an odd compact hex length. `latG`/`longG` are channel-level
   * rejections, not hex-string ones -- pinned at L3 in
   * `packages/core/test/telemetry/elm327Session.test.ts` instead, since this
   * validator only ever sees the raw hex draft, never a channel id.
   */
  it.each([
    ['04', false],
    ['0101', false],
    ['015C', false],
    ['221E1C', true],
    ['21AB', true],
    ['221E0', false],
  ] as const)('validateCustomPidHex(%s) -> ok=%s', (input, expectedOk) => {
    const result = validateCustomPidHex(input);
    expect(result.ok).toBe(expectedOk);
    if (!expectedOk) expect(result.error).toBe(CUSTOM_PID_VALIDATION_ERROR);
  });

  it('rejects a service byte outside 21/22 even when otherwise well-formed hex (destructive-command whitelist)', () => {
    for (const badService of ['01', '04', '08', '2F', '3E']) {
      const request = `${badService}1E1C`;
      const result = validateCustomPidHex(request);
      expect(result.ok, `expected service ${badService} to be rejected`).toBe(false);
      expect(result.error).toBe(CUSTOM_PID_VALIDATION_ERROR);
    }
  });

  it('rejects a compact hex length under 4 characters even with an allowed service byte', () => {
    expect(validateCustomPidHex('21').ok).toBe(false);
    expect(validateCustomPidHex('22').ok).toBe(false);
  });

  it('is case-insensitive on the service byte', () => {
    expect(validateCustomPidHex('21ab')).toEqual({ ok: true, value: '21ab', error: null });
    expect(validateCustomPidHex('221e1c')).toEqual({ ok: true, value: '221e1c', error: null });
  });
});

describe('customPidValidation.isAllowedCustomPidRequest (L2 reuse, binding)', () => {
  it('mirrors validateCustomPidHex\'s allow/reject decisions for an already-trimmed value', () => {
    expect(isAllowedCustomPidRequest('221E1C')).toBe(true);
    expect(isAllowedCustomPidRequest('21AB')).toBe(true);
    expect(isAllowedCustomPidRequest('015C')).toBe(false);
    expect(isAllowedCustomPidRequest('04')).toBe(false);
    expect(isAllowedCustomPidRequest('221E0')).toBe(false);
  });

  it('rejects empty input (unlike validateCustomPidHex, which treats empty as "disabled")', () => {
    expect(isAllowedCustomPidRequest('')).toBe(false);
  });
});
