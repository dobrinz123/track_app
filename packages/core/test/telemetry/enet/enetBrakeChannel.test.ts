import { describe, expect, it } from 'vitest';
import {
  decodeEnetChannelValue,
  ENET_DEFAULT_CHANNEL_RATES_HZ,
  ENET_SPEC_CHANNELS,
  validateEnetChannelSpecs,
  type EnetChannelSpec,
} from '../../../src/telemetry/enet/enetChannelSpecs';
import type { TelemetryChannelId } from '../../../src/telemetry/contracts';

/**
 * Ticket P4l-FIX1 F1 (binding): `brakeSwitch`/`brakePct` are real
 * `TelemetryChannelId` members, so a Signal-Finder-confirmed brake binding
 * can become a REAL ENET poll entry (its own DID, at its own ECU address)
 * whose response is decoded by the binding's own decoder -- the boolean
 * "anything off the rest byte reads 100" rule is not expressible as the
 * scale/offset `decode` a plain `did` spec carries, hence `decodeValue`.
 */
describe('P4l-FIX1 F1: brake channels are first-class ENET telemetry channels', () => {
  it('brakeSwitch and brakePct are ENET-eligible spec channels', () => {
    expect(ENET_SPEC_CHANNELS.has('brakeSwitch')).toBe(true);
    expect(ENET_SPEC_CHANNELS.has('brakePct')).toBe(true);
  });

  it('both brake channels have their own poll rate (never the 1 Hz unknown-channel fallback)', () => {
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ.brakeSwitch).toBe(5);
    expect(ENET_DEFAULT_CHANNEL_RATES_HZ.brakePct).toBe(5);
  });

  it('a did spec is valid with a decodeValue function and no scale/offset decode block', () => {
    const spec: EnetChannelSpec = {
      channel: 'brakeSwitch',
      mode: 'did',
      requestHex: '500C',
      targetAddress: 0x29,
      decodeValue: (bytes) => (bytes[0] === 0x04 ? 0 : 100),
      provenance: 'Signal Finder field-confirmed binding (test)',
    };
    const result = validateEnetChannelSpecs([spec]);
    expect(result.warnings).toEqual([]);
    expect(result.valid).toEqual([spec]);
  });

  it('a did spec with NEITHER decode nor decodeValue is still rejected', () => {
    const result = validateEnetChannelSpecs([
      { channel: 'brakeSwitch', mode: 'did', requestHex: '500C', provenance: 'x' },
    ]);
    expect(result.valid).toEqual([]);
    expect(result.warnings[0]).toContain('missing a decode definition');
  });

  it('decodeEnetChannelValue prefers decodeValue over the scale/offset block', () => {
    const spec: EnetChannelSpec = {
      channel: 'brakeSwitch',
      mode: 'did',
      requestHex: '500C',
      decode: { byteOffset: 0, byteLength: 1, scale: 1, offset: 0 },
      decodeValue: (bytes) => (bytes[0] === 0x04 ? 0 : 100),
      provenance: 'x',
    };
    expect(decodeEnetChannelValue(spec, Uint8Array.from([0x04]))).toBe(0);
    expect(decodeEnetChannelValue(spec, Uint8Array.from([0x05]))).toBe(100);
  });

  it('a decodeValue that cannot decide (null) throws rather than fabricating a reading', () => {
    const spec: EnetChannelSpec = {
      channel: 'brakeSwitch',
      mode: 'did',
      requestHex: '500C',
      decodeValue: () => null,
      provenance: 'x',
    };
    expect(() => decodeEnetChannelValue(spec, Uint8Array.from([0x05]))).toThrow(/could not decode/i);
  });

  it('the brake channels are not device-sensor channels (they stay pollable)', () => {
    const channels: readonly TelemetryChannelId[] = ['brakeSwitch', 'brakePct'];
    for (const channel of channels) expect(ENET_SPEC_CHANNELS.has(channel)).toBe(true);
  });
});
