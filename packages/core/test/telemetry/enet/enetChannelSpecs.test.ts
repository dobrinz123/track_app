import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENET_CHANNEL_SPECS,
  decodeEnetChannelValue,
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
  it('covers rpm/speedKph/throttlePct/coolantC/engineOilC via obd01, matching pidCodec PIDs', () => {
    const byChannel = new Map(DEFAULT_ENET_CHANNEL_SPECS.map((spec) => [spec.channel, spec]));
    expect(byChannel.get('rpm')).toMatchObject({ mode: 'obd01', requestHex: '0C' });
    expect(byChannel.get('speedKph')).toMatchObject({ mode: 'obd01', requestHex: '0D' });
    expect(byChannel.get('throttlePct')).toMatchObject({ mode: 'obd01', requestHex: '11' });
    expect(byChannel.get('coolantC')).toMatchObject({ mode: 'obd01', requestHex: '05' });
    expect(byChannel.get('engineOilC')).toMatchObject({ mode: 'obd01', requestHex: '5C' });
    expect(DEFAULT_ENET_CHANNEL_SPECS).toHaveLength(5);
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
    expect(validateEnetChannelSpecs(DEFAULT_ENET_CHANNEL_SPECS).valid).toHaveLength(5);
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
