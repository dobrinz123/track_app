import { describe, expect, it } from 'vitest';
import {
  decodeBrakeBindingValue,
  resolveBrakeBindingFromProfile,
  type ResolvedBrakeBinding,
} from '../../src/session/telemetryProvider';
import type { VehicleProfileBinding } from '../../src/persistence/didSweepStore';

/**
 * Ticket P4l S3 / contracts.md "Signal Finder (Phase 4l)" item 5 (binding):
 * "the ENET telemetry provider reads bindings from the profile registry
 * (data, not code)" — `brakePct`/`brakeSwitch` resolve from the binding the
 * Signal Finder confirmed, if there is one. Existing `accelPedalPct`
 * (mode-01 0x5A) stays the default binding, untouched.
 */

function binding(overrides: Partial<VehicleProfileBinding> = {}): VehicleProfileBinding {
  return {
    profileId: 'toyota-supra-b58',
    channel: 'brakeSwitch',
    ecu: 0x29,
    did: 0x500c,
    length: 1,
    decode: 'bit0 (0x04 released -> 0x05 pressed)',
    status: 'field-confirmed',
    evidenceJson: JSON.stringify({ restValueHex: '04', min: 4, max: 5, byteOffset: null }),
    updatedAtUtc: '2026-08-29T18:12:00.000Z',
    ...overrides,
  };
}

describe('resolveBrakeBindingFromProfile', () => {
  it('returns null when the profile carries no brake binding at all', () => {
    expect(resolveBrakeBindingFromProfile([])).toBeNull();
    expect(resolveBrakeBindingFromProfile([binding({ channel: 'accelPedal' })])).toBeNull();
  });

  it('resolves a confirmed brakeSwitch binding into a DID request for its own ECU', () => {
    const resolved = resolveBrakeBindingFromProfile([binding()]);
    expect(resolved).toMatchObject({
      channel: 'brakeSwitch',
      ecu: 0x29,
      requestHex: '500C',
      length: 1,
      decodeKind: 'boolean-0-100',
    });
    expect(resolved!.provenance).toContain('Signal Finder');
  });

  it('prefers a brakePressure binding (a real analog) over a bare switch', () => {
    const resolved = resolveBrakeBindingFromProfile([
      binding(),
      binding({
        channel: 'brakePressure',
        ecu: 0x12,
        did: 0x58b7,
        length: 1,
        decode: 'u8 hPa',
        evidenceJson: JSON.stringify({ restValueHex: '00', min: 0, max: 200, byteOffset: null }),
      }),
    ]);
    expect(resolved).toMatchObject({ channel: 'brakePct', ecu: 0x12, requestHex: '58B7', decodeKind: 'scaled-0-100' });
  });

  it('ignores a binding that never reached field-confirmed', () => {
    expect(resolveBrakeBindingFromProfile([binding({ status: 'hypothesis' })])).toBeNull();
    expect(resolveBrakeBindingFromProfile([binding({ status: 'weak' })])).toBeNull();
  });

  it('survives a corrupt evidence blob rather than throwing', () => {
    const resolved = resolveBrakeBindingFromProfile([binding({ evidenceJson: 'not json{' })]);
    expect(resolved).not.toBeNull();
    expect(resolved!.restValueHex).toBeNull();
  });
});

describe('decodeBrakeBindingValue', () => {
  const brakeSwitch = resolveBrakeBindingFromProfile([binding()]) as ResolvedBrakeBinding;

  it('a boolean channel reads 0 at rest and 100 when it leaves the rest level', () => {
    expect(decodeBrakeBindingValue(brakeSwitch, Uint8Array.from([0x04]))).toBe(0);
    expect(decodeBrakeBindingValue(brakeSwitch, Uint8Array.from([0x05]))).toBe(100);
  });

  it('an analog channel scales its observed range onto 0..100 and clamps outside it', () => {
    const pressure = resolveBrakeBindingFromProfile([
      binding({
        channel: 'brakePressure',
        did: 0x58b7,
        evidenceJson: JSON.stringify({ restValueHex: '00', min: 0, max: 200, byteOffset: null }),
      }),
    ]) as ResolvedBrakeBinding;
    expect(decodeBrakeBindingValue(pressure, Uint8Array.from([0x00]))).toBe(0);
    expect(decodeBrakeBindingValue(pressure, Uint8Array.from([100]))).toBe(50);
    expect(decodeBrakeBindingValue(pressure, Uint8Array.from([0xff]))).toBe(100);
  });

  it('reads the confirmed BYTE OFFSET of a block response', () => {
    const block = resolveBrakeBindingFromProfile([
      binding({
        did: 0x4000,
        length: 12,
        evidenceJson: JSON.stringify({ restValueHex: '000000000000000000000000', min: null, max: null, byteOffset: 3 }),
      }),
    ]) as ResolvedBrakeBinding;
    expect(block.byteOffset).toBe(3);
    expect(decodeBrakeBindingValue(block, Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(0);
    expect(decodeBrakeBindingValue(block, Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(100);
  });

  it('returns null for a response too short for the binding s own offset', () => {
    expect(decodeBrakeBindingValue(brakeSwitch, new Uint8Array())).toBeNull();
  });

  /**
   * Ticket P4l-FIX1 H4 (binding, Codex review finding): the decoder used to
   * read exactly ONE byte, so a 2-byte binding whose value changes only in
   * the LOW byte -- the 0x29/0x500B series from field test 4, 0x0002 at rest
   * and 0x0006 pressed -- read byte 0 (0x00) in both states and never
   * changed. A 1-4 byte response is now decoded as the SAME unsigned
   * big-endian scalar the Signal Finder's own scoring compares, and the
   * boolean rule compares that WHOLE value against the rest value.
   */
  describe('H4: multi-byte bindings decode as one big-endian scalar', () => {
    const twoByteSwitch = resolveBrakeBindingFromProfile([
      binding({
        did: 0x500b,
        length: 2,
        evidenceJson: JSON.stringify({ restValueHex: '0002', min: 2, max: 6, byteOffset: null }),
      }),
    ]) as ResolvedBrakeBinding;

    it('0x500B: 0002 (rest) reads 0 and 0006 (pressed) reads 100', () => {
      expect(decodeBrakeBindingValue(twoByteSwitch, Uint8Array.from([0x00, 0x02]))).toBe(0);
      expect(decodeBrakeBindingValue(twoByteSwitch, Uint8Array.from([0x00, 0x06]))).toBe(100);
    });

    it('a change in the HIGH byte alone is still a change', () => {
      expect(decodeBrakeBindingValue(twoByteSwitch, Uint8Array.from([0x01, 0x02]))).toBe(100);
    });

    it('a multi-byte analog scales the full value, not one byte, against the observed range', () => {
      const pressure = resolveBrakeBindingFromProfile([
        binding({
          channel: 'brakePressure',
          did: 0x500b,
          length: 2,
          evidenceJson: JSON.stringify({ restValueHex: '0000', min: 0, max: 1_000, byteOffset: null }),
        }),
      ]) as ResolvedBrakeBinding;
      expect(decodeBrakeBindingValue(pressure, Uint8Array.from([0x00, 0x00]))).toBe(0);
      expect(decodeBrakeBindingValue(pressure, Uint8Array.from([0x01, 0xf4]))).toBe(50); // 500 of 0..1000
      expect(decodeBrakeBindingValue(pressure, Uint8Array.from([0x03, 0xe8]))).toBe(100); // 1000
    });

    it('a response WIDER than 4 bytes still reads the confirmed byte offset (block bindings unchanged)', () => {
      const block = resolveBrakeBindingFromProfile([
        binding({
          did: 0x4000,
          length: 12,
          evidenceJson: JSON.stringify({
            restValueHex: '000000000000000000000000',
            min: null,
            max: null,
            byteOffset: 3,
          }),
        }),
      ]) as ResolvedBrakeBinding;
      expect(decodeBrakeBindingValue(block, Uint8Array.from([9, 9, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(0);
      expect(decodeBrakeBindingValue(block, Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(100);
    });

    it('an unreadable rest value never fabricates a reading', () => {
      const broken = resolveBrakeBindingFromProfile([
        binding({ evidenceJson: JSON.stringify({ restValueHex: 'zz', min: null, max: null, byteOffset: null }) }),
      ]) as ResolvedBrakeBinding;
      expect(decodeBrakeBindingValue(broken, Uint8Array.from([0x05]))).toBeNull();
    });
  });
});
