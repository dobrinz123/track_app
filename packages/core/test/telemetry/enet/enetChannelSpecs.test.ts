import { describe, expect, it } from 'vitest';

import {
  ACCEL_PEDAL_FALLBACK_ENET_SPEC,
  DEFAULT_ENET_CHANNEL_SPECS,
  decodeEnetChannelValue,
  ENET_DEFAULT_CHANNEL_RATES_HZ,
  ENET_SPEC_CHANNELS,
  validateEnetChannelSpecs,
  type EnetChannelSpec,
} from '../../../src/telemetry/enet/enetChannelSpecs';

function did(overrides: Partial<EnetChannelSpec> = {}): EnetChannelSpec {
  return {
    channel: 'engineOilC',
    mode: 'did',
    requestHex: '1E1C',
    decode: { byteOffset: 0, byteLength: 1, scale: 1, offset: -40 },
    provenance: 'hand-captured from a bench session',
    ...overrides,
  };
}

describe('DEFAULT_ENET_CHANNEL_SPECS', () => {
  it('covers rpm/speedKph/throttlePct/accelPedalPct/coolantC/engineOilC via obd01, matching pidCodec PIDs', () => {
    const byChannel = new Map(DEFAULT_ENET_CHANNEL_SPECS.map((spec) => [spec.channel, spec]));
    expect(byChannel.get('rpm')).toMatchObject({ mode: 'obd01', requestHex: '0C' });
    expect(byChannel.get('speedKph')).toMatchObject({ mode: 'obd01', requestHex: '0D' });
    expect(byChannel.get('throttlePct')).toMatchObject({ mode: 'obd01', requestHex: '11' });
    // Field revision 2 (2026-08-27, binding — Phase 4h): the accelerator
    // PEDAL is now PID 0x5A (primary source), distinct from throttlePct's
    // own plate (PID 0x11) above; 0x49 is the mobile provider's fallback --
    // see the dedicated describe block below.
    expect(byChannel.get('accelPedalPct')).toMatchObject({ mode: 'obd01', requestHex: '5A' });
    expect(byChannel.get('coolantC')).toMatchObject({ mode: 'obd01', requestHex: '05' });
    expect(byChannel.get('engineOilC')).toMatchObject({ mode: 'obd01', requestHex: '5C' });
    expect(DEFAULT_ENET_CHANNEL_SPECS).toHaveLength(6);
    expect(validateEnetChannelSpecs(DEFAULT_ENET_CHANNEL_SPECS).warnings).toEqual([]);
  });
});

describe('validateEnetChannelSpecs', () => {
  it('rejects latG/longG channels with a warning', () => {
    const result = validateEnetChannelSpecs([{ channel: 'latG', mode: 'obd01', requestHex: '00', provenance: 'x' }]);
    expect(result.valid).toEqual([]);
    expect(result.warnings[0]).toContain('latG');
    expect(result.warnings[0]).toContain('device-sensor channel');
  });

  /**
   * P4e-FIX3 H1(a) fix (binding, Codex P4e-REV3): a channel string outside
   * `ENET_SPEC_CHANNELS` (a typo, or a channel this app has no decoder for at
   * all) must be rejected too -- BEFORE this fix, a `did` spec naming e.g.
   * `"bogus"` was validated purely on `requestHex`/`decode`/`provenance`
   * shape and became a real poll entry/sample channel. `as EnetChannelSpec`
   * below is the test's own cast to feed a runtime-only-invalid channel
   * through a typed call, mirroring how an untrusted JSON value would arrive
   * in practice (the mobile layer's own structural guard is tested
   * separately, `enetSettingsValidation.test.ts`).
   */
  it('rejects a channel name outside ENET_SPEC_CHANNELS (unknown/typo channel) with a warning', () => {
    const result = validateEnetChannelSpecs([
      {
        channel: 'bogus' as unknown as EnetChannelSpec['channel'],
        mode: 'did',
        requestHex: 'F190',
        decode: { byteOffset: 0, byteLength: 1, scale: 1, offset: 0 },
        provenance: 'x',
      },
    ]);
    expect(result.valid).toEqual([]);
    expect(result.warnings[0]).toContain('bogus');
    expect(result.warnings[0]).toContain('not a recognized ENET/OBD telemetry channel');
  });

  it('ENET_SPEC_CHANNELS is every TelemetryChannelId except the device-sensor latG/longG', () => {
    expect(ENET_SPEC_CHANNELS.has('latG')).toBe(false);
    expect(ENET_SPEC_CHANNELS.has('longG')).toBe(false);
    for (const channel of [
      'rpm',
      'speedKph',
      'throttlePct',
      'accelPedalPct',
      'coolantC',
      'intakeC',
      'engineLoadPct',
      'engineOilC',
      'transOilC',
    ] as const) {
      expect(ENET_SPEC_CHANNELS.has(channel)).toBe(true);
    }
  });

  it('rejects malformed hex requestHex', () => {
    const result = validateEnetChannelSpecs([{ channel: 'rpm', mode: 'obd01', requestHex: 'ZZ', provenance: 'x' }]);
    expect(result.valid).toEqual([]);
    expect(result.warnings[0]).toContain('not valid hex');
  });

  it('rejects an obd01 requestHex of the wrong length', () => {
    const result = validateEnetChannelSpecs([{ channel: 'rpm', mode: 'obd01', requestHex: '0C11', provenance: 'x' }]);
    expect(result.valid).toEqual([]);
    expect(result.warnings[0]).toContain('exactly 2 hex characters');
  });

  it('rejects a did spec missing a decode definition', () => {
    const spec = did();
    delete (spec as { decode?: unknown }).decode;
    const result = validateEnetChannelSpecs([spec]);
    expect(result.valid).toEqual([]);
    expect(result.warnings[0]).toContain('missing a decode definition');
  });

  it('rejects a did spec missing provenance', () => {
    const result = validateEnetChannelSpecs([did({ provenance: '   ' })]);
    expect(result.valid).toEqual([]);
    expect(result.warnings[0]).toContain('missing provenance');
  });

  it('rejects a did requestHex of the wrong length', () => {
    const result = validateEnetChannelSpecs([did({ requestHex: '1E' })]);
    expect(result.valid).toEqual([]);
    expect(result.warnings[0]).toContain('exactly 4 hex characters');
  });

  it('keeps the LAST spec for a duplicated channel, with a warning', () => {
    const first: EnetChannelSpec = { channel: 'rpm', mode: 'obd01', requestHex: '0C', provenance: 'a' };
    const second: EnetChannelSpec = { channel: 'rpm', mode: 'obd01', requestHex: '0C', provenance: 'b' };
    const result = validateEnetChannelSpecs([first, second]);
    expect(result.valid).toEqual([second]);
    expect(result.warnings.some((w) => w.includes('Duplicate') && w.includes('rpm'))).toBe(true);
  });

  it('accepts a well-formed did spec unchanged', () => {
    const spec = did();
    const result = validateEnetChannelSpecs([spec]);
    expect(result.valid).toEqual([spec]);
    expect(result.warnings).toEqual([]);
  });

  it('rejects an obd01 spec whose requestHex is the WRONG PID for its channel (review: speedKph with 0C)', () => {
    const result = validateEnetChannelSpecs([
      { channel: 'speedKph', mode: 'obd01', requestHex: '0C', provenance: 'x' },
    ]);
    expect(result.valid).toEqual([]);
    expect(result.warnings[0]).toContain('speedKph');
    expect(result.warnings[0]).toMatch(/PID|mode-01/);
  });

  it('rejects an obd01 spec for a channel with no mode-01 decoder at all (review: transOilC)', () => {
    const result = validateEnetChannelSpecs([
      { channel: 'transOilC', mode: 'obd01', requestHex: '21', provenance: 'x' },
    ]);
    expect(result.valid).toEqual([]);
    expect(result.warnings[0]).toContain('transOilC');
    expect(result.warnings[0]).toContain('no mode-01 decoder');
  });

  it('accepts every DEFAULT_ENET_CHANNEL_SPECS entry against the channel<->PID consistency check', () => {
    // Guards against the consistency check itself being wrong in a way that
    // would reject the built-in defaults.
    expect(validateEnetChannelSpecs(DEFAULT_ENET_CHANNEL_SPECS).valid).toHaveLength(6);
  });

  /**
   * Field revision 2 (2026-08-27, binding — Phase 4h, P4h ticket item 3):
   * `accelPedalPct` now has TWO valid source PIDs -- the consistency check
   * must accept EITHER, since the mobile provider swaps `ACCEL_PEDAL_FALLBACK_ENET_SPEC`
   * (0x49) in for the primary 0x5A default when the DME NRCs 0x5A.
   */
  it('accepts ACCEL_PEDAL_FALLBACK_ENET_SPEC (0x49) as a valid accelPedalPct spec, same as the 0x5A default', () => {
    const result = validateEnetChannelSpecs([ACCEL_PEDAL_FALLBACK_ENET_SPEC]);
    expect(result.valid).toEqual([ACCEL_PEDAL_FALLBACK_ENET_SPEC]);
    expect(result.warnings).toEqual([]);
  });

  it('ACCEL_PEDAL_FALLBACK_ENET_SPEC decodes identically to the primary spec (same formula, different PID byte)', () => {
    const primary = DEFAULT_ENET_CHANNEL_SPECS.find((spec) => spec.channel === 'accelPedalPct')!;
    expect(primary.requestHex).toBe('5A');
    expect(ACCEL_PEDAL_FALLBACK_ENET_SPEC.requestHex).toBe('49');
    const bytes = Uint8Array.from([0x80]);
    expect(decodeEnetChannelValue(ACCEL_PEDAL_FALLBACK_ENET_SPEC, bytes)).toBeCloseTo(
      decodeEnetChannelValue(primary, bytes),
      8,
    );
  });

  it('rejects a did spec with a non-integer or negative byteOffset', () => {
    expect(validateEnetChannelSpecs([did({ decode: { byteOffset: 0.5, byteLength: 1, scale: 1, offset: 0 } })]).valid).toEqual([]);
    expect(validateEnetChannelSpecs([did({ decode: { byteOffset: -1, byteLength: 1, scale: 1, offset: 0 } })]).valid).toEqual([]);
  });

  it('rejects a did spec with byteLength outside {1,2} at runtime (bypassing the TS type)', () => {
    const spec = did({ decode: { byteOffset: 0, byteLength: 3 as 1 | 2, scale: 1, offset: 0 } });
    expect(validateEnetChannelSpecs([spec]).valid).toEqual([]);
  });

  it('rejects a did spec with a non-finite scale or offset', () => {
    expect(validateEnetChannelSpecs([did({ decode: { byteOffset: 0, byteLength: 1, scale: Number.NaN, offset: 0 } })]).valid).toEqual([]);
    expect(validateEnetChannelSpecs([did({ decode: { byteOffset: 0, byteLength: 1, scale: Number.POSITIVE_INFINITY, offset: 0 } })]).valid).toEqual([]);
    expect(validateEnetChannelSpecs([did({ decode: { byteOffset: 0, byteLength: 1, scale: 1, offset: Number.NaN } })]).valid).toEqual([]);
  });
});

describe('decodeEnetChannelValue', () => {
  it('reuses pidCodec obd01 decode formulas (rpm: (256A+B)/4)', () => {
    const spec: EnetChannelSpec = { channel: 'rpm', mode: 'obd01', requestHex: '0C', provenance: 'x' };
    expect(decodeEnetChannelValue(spec, Uint8Array.from([0x1a, 0xf8]))).toBe(1_726);
  });

  it('reuses pidCodec obd01 decode formulas (coolantC: A-40)', () => {
    const spec: EnetChannelSpec = { channel: 'coolantC', mode: 'obd01', requestHex: '05', provenance: 'x' };
    expect(decodeEnetChannelValue(spec, Uint8Array.from([0x00]))).toBe(-40);
  });

  it('decodes a did spec via byteOffset/byteLength/scale/offset', () => {
    const spec = did({ decode: { byteOffset: 0, byteLength: 1, scale: 1, offset: -40 } });
    expect(decodeEnetChannelValue(spec, Uint8Array.from([0x4b]))).toBe(35); // 0x4B = 75; 75-40=35
  });

  it('decodes a signed 2-byte did value', () => {
    const spec = did({ decode: { byteOffset: 0, byteLength: 2, signed: true, scale: 1, offset: 0 } });
    // 0xFFF6 as a signed 16-bit integer is -10.
    expect(decodeEnetChannelValue(spec, Uint8Array.from([0xff, 0xf6]))).toBe(-10);
  });

  it('decodes a did value at a non-zero byteOffset with scale applied', () => {
    const spec = did({ decode: { byteOffset: 2, byteLength: 1, scale: 0.5, offset: 0 } });
    expect(decodeEnetChannelValue(spec, Uint8Array.from([0x00, 0x00, 20]))).toBe(10);
  });

  it('throws when byteOffset/byteLength runs past the payload', () => {
    const spec = did({ decode: { byteOffset: 5, byteLength: 1, scale: 1, offset: 0 } });
    expect(() => decodeEnetChannelValue(spec, Uint8Array.from([0x00]))).toThrow();
  });

  it('produces a non-finite value when scale/offset overflow -- caller (enetSession) is responsible for dropping it, not this function', () => {
    // decodeEnetChannelValue itself is a pure arithmetic formula; M2's "must
    // be finite else dropped + decodeErrors counter" guard lives in
    // enetSession.ts's pollChannel (see enetSession.test.ts). This test just
    // pins the raw arithmetic so that guard has something real to catch.
    const spec = did({ decode: { byteOffset: 0, byteLength: 2, scale: Number.MAX_VALUE, offset: 0 } });
    const value = decodeEnetChannelValue(spec, Uint8Array.from([0xff, 0xff]));
    expect(Number.isFinite(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P4e-FIX2-core: poll-plan rate table (contracts.md "poll plan, probe &
// robustness amendment") -- so the mobile layer can build an ENET poll plan
// from RESOLVED channel specs instead of reusing the fixed ELM plan.
// ---------------------------------------------------------------------------
describe('ENET_DEFAULT_CHANNEL_RATES_HZ', () => {
  it('has the binding rate for every named channel group', () => {
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ.rpm).toBe(5);
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ.speedKph).toBe(5);
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ.throttlePct).toBe(5);
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ.accelPedalPct).toBe(5); // field revision (2026-08-27, binding).
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ.coolantC).toBe(0.2);
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ.engineOilC).toBe(0.5);
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ.transOilC).toBe(0.5);
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ.intakeC).toBe(1);
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ.engineLoadPct).toBe(1);
  });

  it('omits latG/longG (never valid ENET/OBD request targets) and every entry is a positive, finite number', () => {
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ).not.toHaveProperty('latG');
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ).not.toHaveProperty('longG');
    for (const hz of Object.values(ENET_DEFAULT_CHANNEL_RATES_HZ)) {
      expect(Number.isFinite(hz)).toBe(true);
      expect(hz as number).toBeGreaterThan(0);
    }
  });

  it("every DEFAULT_ENET_CHANNEL_SPECS channel has a named rate (no silent fallback needed for the built-ins)", () => {
    for (const spec of DEFAULT_ENET_CHANNEL_SPECS) {
      expect(ENET_DEFAULT_CHANNEL_RATES_HZ[spec.channel]).toBeDefined();
    }
  });
});
