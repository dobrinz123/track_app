import { describe, expect, it, vi } from 'vitest';
import { assertAllowedRequest, UdsServiceNotAllowed } from '@circuit/core';
import {
  buildDidProbeRequest,
  ENET_CHANNEL_SPECS_JSON_ERROR,
  formatHexByte,
  HEX_BYTE_VALIDATION_ERROR,
  parseHexByteDraft,
  resolveEnetChannelSpecs,
  validateEnetChannelSpecsJson,
} from '../../src/session/enetSettingsValidation';

describe('parseHexByteDraft / formatHexByte (ENET tester/target address fields)', () => {
  it('accepts 1-2 hex digits, case-insensitive, in [0x00, 0xFF]', () => {
    expect(parseHexByteDraft('F4')).toBe(0xf4);
    expect(parseHexByteDraft('f4')).toBe(0xf4);
    expect(parseHexByteDraft('12')).toBe(0x12);
    expect(parseHexByteDraft('0')).toBe(0);
    expect(parseHexByteDraft('00')).toBe(0);
    expect(parseHexByteDraft('FF')).toBe(0xff);
    expect(parseHexByteDraft('0xF1')).toBe(0xf1);
    expect(parseHexByteDraft('0Xf1')).toBe(0xf1);
  });

  it('rejects empty, non-hex, too-long, and out-of-range drafts', () => {
    expect(parseHexByteDraft('')).toBeNull();
    expect(parseHexByteDraft('GG')).toBeNull();
    expect(parseHexByteDraft('123')).toBeNull();
    expect(parseHexByteDraft('1FF')).toBeNull();
    expect(parseHexByteDraft('-1')).toBeNull();
  });

  it('formatHexByte round-trips through parseHexByteDraft as 2-digit uppercase hex', () => {
    expect(formatHexByte(0xf4)).toBe('F4');
    expect(formatHexByte(0x12)).toBe('12');
    expect(formatHexByte(0)).toBe('00');
    expect(parseHexByteDraft(formatHexByte(0xf4))).toBe(0xf4);
  });

  it('HEX_BYTE_VALIDATION_ERROR is the exact string SettingsScreen/DidProbeScreen show inline', () => {
    expect(HEX_BYTE_VALIDATION_ERROR).toBe('Enter a hex byte, 00-FF');
  });
});

describe('validateEnetChannelSpecsJson / resolveEnetChannelSpecs (enetChannelSpecsJson field)', () => {
  it('an empty/whitespace draft is ok, with zero specs (meaning "use built-in defaults")', () => {
    expect(validateEnetChannelSpecsJson('')).toEqual({ ok: true, specs: [], warnings: [], error: null });
    expect(validateEnetChannelSpecsJson('   ')).toEqual({ ok: true, specs: [], warnings: [], error: null });
  });

  it('malformed JSON is rejected with ENET_CHANNEL_SPECS_JSON_ERROR', () => {
    const result = validateEnetChannelSpecsJson('{not json');
    expect(result.ok).toBe(false);
    expect(result.error).toBe(ENET_CHANNEL_SPECS_JSON_ERROR);
    expect(result.specs).toEqual([]);
  });

  it('valid JSON that is not an array is rejected', () => {
    const result = validateEnetChannelSpecsJson('{"channel":"rpm"}');
    expect(result.ok).toBe(false);
    expect(result.error).toBe(ENET_CHANNEL_SPECS_JSON_ERROR);
  });

  it('a valid array with a bad entry keeps the good ones and reports a warning, still ok:true', () => {
    const draft = JSON.stringify([
      { channel: 'rpm', mode: 'obd01', requestHex: '0C', provenance: 'standard PID' },
      { channel: 'latG', mode: 'obd01', requestHex: '0D', provenance: 'bad: device-sensor channel' },
    ]);
    const result = validateEnetChannelSpecsJson(draft);
    expect(result.ok).toBe(true);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]!.channel).toBe('rpm');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('an explicit empty array ("[]") is respected literally by the validator (zero channels, not defaults)', () => {
    const result = validateEnetChannelSpecsJson('[]');
    expect(result.ok).toBe(true);
    expect(result.specs).toEqual([]);
  });

  it('resolveEnetChannelSpecs falls back to DEFAULT_ENET_CHANNEL_SPECS for an empty draft', () => {
    const specs = resolveEnetChannelSpecs('');
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.map((s) => s.channel)).toContain('rpm');
  });

  it('resolveEnetChannelSpecs falls back to defaults (with a console.warn) for malformed JSON', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const specs = resolveEnetChannelSpecs('not json at all');
      expect(specs.map((s) => s.channel)).toContain('rpm');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resolveEnetChannelSpecs respects an explicit empty array literally (zero channels polled)', () => {
    expect(resolveEnetChannelSpecs('[]')).toEqual([]);
  });

  it('resolveEnetChannelSpecs returns a valid custom spec list unchanged', () => {
    const draft = JSON.stringify([
      { channel: 'coolantC', mode: 'obd01', requestHex: '05', provenance: 'standard PID' },
    ]);
    const specs = resolveEnetChannelSpecs(draft);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.channel).toBe('coolantC');
  });
});

describe('buildDidProbeRequest (dev DID-probe screen: request building + whitelist refusal)', () => {
  it('mode "did" builds a ReadDataByIdentifier (0x22) request for a valid 4-hex-char DID', () => {
    const result = buildDidProbeRequest('did', '1E0C');
    expect(result.ok).toBe(true);
    expect(result.pdu).toEqual(Uint8Array.from([0x22, 0x1e, 0x0c]));
  });

  it('mode "obd01" builds an OBD mode-01 (0x01) request for a valid 2-hex-char PID', () => {
    const result = buildDidProbeRequest('obd01', '0C');
    expect(result.ok).toBe(true);
    expect(result.pdu).toEqual(Uint8Array.from([0x01, 0x0c]));
  });

  it('ignores internal spacing and is case-insensitive', () => {
    expect(buildDidProbeRequest('did', '1e 0c').pdu).toEqual(Uint8Array.from([0x22, 0x1e, 0x0c]));
    expect(buildDidProbeRequest('obd01', ' 0c ').pdu).toEqual(Uint8Array.from([0x01, 0x0c]));
  });

  it('rejects the wrong hex length for each mode, without sending anything', () => {
    const didTooShort = buildDidProbeRequest('did', '1E');
    expect(didTooShort.ok).toBe(false);
    expect(didTooShort.pdu).toBeNull();
    expect(didTooShort.error).toContain('4 hex characters');

    const pidTooLong = buildDidProbeRequest('obd01', '0C12');
    expect(pidTooLong.ok).toBe(false);
    expect(pidTooLong.error).toContain('2 hex characters');
  });

  it('rejects non-hex input', () => {
    const result = buildDidProbeRequest('did', 'ZZZZ');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Enter hex digits only');
  });

  it('rejects an empty draft', () => {
    expect(buildDidProbeRequest('did', '').ok).toBe(false);
  });

  /**
   * "Nothing outside {0x01, 0x22, 0x3E} can be sent -- the whitelist error is
   * shown, not bypassed" (contracts.md ENET addendum, binding). Both of
   * `buildDidProbeRequest`'s modes only ever construct a whitelisted SID by
   * construction (0x22/0x01), so the gate it re-checks (`assertAllowedRequest`,
   * the SAME core gate `enetSession.ts`'s own `executeDiagnosticRequest`
   * re-checks before every send) is exercised directly here against a
   * manually-built disallowed PDU -- proving the underlying whitelist really
   * does refuse anything else, not just that the picker happens not to offer
   * it.
   */
  it('the underlying whitelist gate (assertAllowedRequest) refuses any SID outside {0x01, 0x22, 0x3E}', () => {
    expect(() => assertAllowedRequest(Uint8Array.from([0x27, 0x01]))).toThrow(UdsServiceNotAllowed);
    expect(() => assertAllowedRequest(Uint8Array.from([0x10, 0x03]))).toThrow(UdsServiceNotAllowed);
    expect(() => assertAllowedRequest(Uint8Array.from([0x01, 0x0c]))).not.toThrow();
    expect(() => assertAllowedRequest(Uint8Array.from([0x22, 0x1e, 0x0c]))).not.toThrow();
    expect(() => assertAllowedRequest(Uint8Array.from([0x3e, 0x80]))).not.toThrow();
  });
});
