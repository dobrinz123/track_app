import { describe, expect, it, vi } from 'vitest';
import {
  ENET_CHANNEL_SPECS_JSON_ERROR,
  formatHexByte,
  HEX_BYTE_VALIDATION_ERROR,
  parseHexByteDraft,
  repairPersistedEnetSettings,
  resolveEnetChannelSpecs,
  validateEnetChannelSpecsJson,
} from '../../src/session/enetSettingsValidation';
import { DEFAULT_SETTINGS } from '../../src/session/settingsStore';

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

  /**
   * P4e-FIX2 HIGH fix (binding, Codex P4e-REV2 Part B): structurally invalid
   * array MEMBERS -- `[null]`, `[{}]`, `[1]` -- must never reach
   * `@circuit/core`'s `validateEnetChannelSpecs` (which would dereference
   * `spec.requestHex.replace(...)` on `undefined` and throw a raw
   * `TypeError`). Each is caught here and reported as an error string
   * instead -- and because EVERY member of a non-empty array failed
   * structurally, the draft as a whole is `ok: false` (a malformed draft, not
   * a deliberate "zero channels" choice -- that's reserved for a literal
   * `"[]"`, covered separately above).
   */
  it('never throws for structurally invalid array members: [null], [{}], [1] -- reported as ok:false, not a crash', () => {
    expect(() => validateEnetChannelSpecsJson('[null]')).not.toThrow();
    expect(() => validateEnetChannelSpecsJson('[{}]')).not.toThrow();
    expect(() => validateEnetChannelSpecsJson('[1]')).not.toThrow();

    for (const draft of ['[null]', '[{}]', '[1]']) {
      const result = validateEnetChannelSpecsJson(draft);
      expect(result.ok).toBe(false);
      expect(result.specs).toEqual([]);
      expect(result.error).toBe(ENET_CHANNEL_SPECS_JSON_ERROR);
    }
  });

  it('rejects a well-typed-looking entry with a wrong-typed field (requestHex as a number, decode.byteLength invalid) -- both members structurally bad, so ok:false', () => {
    const draft = JSON.stringify([
      { channel: 'rpm', mode: 'obd01', requestHex: 12, provenance: 'wrong type' },
      {
        channel: 'coolantC',
        mode: 'did',
        requestHex: 'F1A0',
        decode: { byteOffset: 0, byteLength: 3, scale: 1, offset: -40 },
        provenance: 'bad byteLength',
      },
    ]);
    const result = validateEnetChannelSpecsJson(draft);
    expect(result.ok).toBe(false);
    expect(result.specs).toEqual([]);
    expect(result.error).toBe(ENET_CHANNEL_SPECS_JSON_ERROR);
  });

  it('a mix of one structurally-valid and several structurally-invalid members keeps only the valid one', () => {
    const draft = JSON.stringify([null, {}, 1, { channel: 'rpm', mode: 'obd01', requestHex: '0C', provenance: 'ok' }]);
    const result = validateEnetChannelSpecsJson(draft);
    expect(result.ok).toBe(true);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]!.channel).toBe('rpm');
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
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

  /**
   * H1 fix, applied to the two call sites the review named directly:
   * `SettingsScreen`'s blur handler (`commitEnetChannelSpecsDraft` calls
   * `validateEnetChannelSpecsJson`, exercised above) and `TelemetryScreen`'s
   * render (`enetChannelsFor` calls `resolveEnetChannelSpecs` directly, on
   * every render) -- neither may ever throw for `[null]`/`[{}]`/`[1]`.
   */
  it('resolveEnetChannelSpecs (the exact function TelemetryScreen calls during render) never throws for structurally invalid members, falling back to defaults', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const draft of ['[null]', '[{}]', '[1]', '[null, {}, 1]']) {
        let specs: ReturnType<typeof resolveEnetChannelSpecs> = [];
        expect(() => {
          specs = resolveEnetChannelSpecs(draft);
        }).not.toThrow();
        expect(specs.length).toBeGreaterThan(0); // falls back to the built-in defaults, not an empty list.
      }
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

describe('repairPersistedEnetSettings (P4e-FIX2 L1, binding: settings hydration repair)', () => {
  it("the review's exact persisted object: enetPort/enetTesterAddress out of range are repaired, valid adapterType kept", () => {
    const persisted = { ...DEFAULT_SETTINGS, adapterType: 'enet' as const, enetPort: 70_000, enetTesterAddress: -1 };
    const repaired = repairPersistedEnetSettings(persisted);
    expect(repaired.adapterType).toBe('enet');
    expect(repaired.enetPort).toBe(DEFAULT_SETTINGS.enetPort);
    expect(repaired.enetTesterAddress).toBe(DEFAULT_SETTINGS.enetTesterAddress);
    // Untouched valid fields survive.
    expect(repaired.enetTargetAddress).toBe(DEFAULT_SETTINGS.enetTargetAddress);
  });

  it('adapterType outside the enum resets to elm327', () => {
    const persisted = { ...DEFAULT_SETTINGS, adapterType: 'bogus' as never };
    expect(repairPersistedEnetSettings(persisted).adapterType).toBe('elm327');
  });

  it('enetPort of 0, negative, non-integer, or > 65535 resets to the default port', () => {
    for (const badPort of [0, -1, 1.5, 65_536, 'not a number' as never]) {
      const persisted = { ...DEFAULT_SETTINGS, enetPort: badPort };
      expect(repairPersistedEnetSettings(persisted).enetPort).toBe(DEFAULT_SETTINGS.enetPort);
    }
  });

  it('enetTesterAddress/enetTargetAddress outside [0, 255] reset to their defaults', () => {
    for (const badByte of [-1, 256, 1.5, 'F4' as never]) {
      const persisted = { ...DEFAULT_SETTINGS, enetTesterAddress: badByte, enetTargetAddress: badByte };
      const repaired = repairPersistedEnetSettings(persisted);
      expect(repaired.enetTesterAddress).toBe(DEFAULT_SETTINGS.enetTesterAddress);
      expect(repaired.enetTargetAddress).toBe(DEFAULT_SETTINGS.enetTargetAddress);
    }
  });

  it('enetChannelSpecsJson that is unparsable JSON resets to "" ', () => {
    const persisted = { ...DEFAULT_SETTINGS, enetChannelSpecsJson: '{not json' };
    expect(repairPersistedEnetSettings(persisted).enetChannelSpecsJson).toBe('');
  });

  it('enetChannelSpecsJson that is not a string resets to "" ', () => {
    const persisted = { ...DEFAULT_SETTINGS, enetChannelSpecsJson: 42 as never };
    expect(repairPersistedEnetSettings(persisted).enetChannelSpecsJson).toBe('');
  });

  it('a valid enetChannelSpecsJson string is left untouched (even with per-entry warnings, e.g. a device-sensor channel)', () => {
    const draft = JSON.stringify([{ channel: 'rpm', mode: 'obd01', requestHex: '0C', provenance: 'ok' }]);
    const persisted = { ...DEFAULT_SETTINGS, enetChannelSpecsJson: draft };
    expect(repairPersistedEnetSettings(persisted).enetChannelSpecsJson).toBe(draft);
  });

  it('every valid field is left exactly as hydrated (a no-op on already-valid settings)', () => {
    const persisted = {
      ...DEFAULT_SETTINGS,
      adapterType: 'enet' as const,
      enetHost: '192.168.4.20',
      enetPort: 6_802,
      enetTesterAddress: 0xf1,
      enetTargetAddress: 0x10,
    };
    expect(repairPersistedEnetSettings(persisted)).toEqual(persisted);
  });
});
