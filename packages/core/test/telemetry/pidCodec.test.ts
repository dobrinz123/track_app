import { describe, expect, it } from 'vitest';

import {
  decodeMode01Response,
  encodeMode01Request,
  type Mode01TelemetryChannelId,
} from '../../src/telemetry';

describe('mode-01 PID codec', () => {
  const requests: Array<[Mode01TelemetryChannelId, string]> = [
    ['rpm', '010C'],
    ['speedKph', '010D'],
    ['throttlePct', '0111'],
    ['accelPedalPct', '0149'],
    ['coolantC', '0105'],
    ['intakeC', '010F'],
    ['engineLoadPct', '0104'],
    ['engineOilC', '015C'],
  ];

  it.each(requests)('encodes %s as %s', (channel, expected) => {
    expect(encodeMode01Request(channel)).toBe(expected);
  });

  const boundaries: Array<[Mode01TelemetryChannelId, string, number]> = [
    ['rpm', '41 0C 00 00', 0],
    ['rpm', '41 0C FF FF', 16_383.75],
    ['speedKph', '41 0D 00', 0],
    ['speedKph', '41 0D FF', 255],
    ['throttlePct', '41 11 00', 0],
    ['throttlePct', '41 11 FF', 100],
    // Field revision (2026-08-27, binding): PID 0x49 "Accelerator pedal
    // position D" -- the ticket's own vector: A=0x80 (128) -> 128*100/255 ≈
    // 50.196..., i.e. 50.2% to 1 decimal place.
    ['accelPedalPct', '41 49 00', 0],
    ['accelPedalPct', '41 49 FF', 100],
    ['accelPedalPct', '41 49 80', 50.196078431372548],
    ['coolantC', '41 05 00', -40],
    ['coolantC', '41 05 FF', 215],
    ['intakeC', '41 0F 00', -40],
    ['intakeC', '41 0F FF', 215],
    ['engineLoadPct', '41 04 00', 0],
    ['engineLoadPct', '41 04 FF', 100],
    // Hand-computed A-40 boundaries: 0x00 - 40 = -40; 0xFF - 40 = 215.
    ['engineOilC', '41 5C 00', -40],
    ['engineOilC', '41 5C FF', 215],
  ];

  it.each(boundaries)('decodes %s boundary response %s', (channel, response, expected) => {
    expect(decodeMode01Response(channel, response)).toBeCloseTo(expected, 8);
  });

  it('ignores echo, whitespace, garbage, and unrelated frames', () => {
    const response = '\u0001junk\r010C\r7E9 03 41 0D 2A\r7E8 04 41\t0C\n1A F8\r';
    expect(decodeMode01Response('rpm', response)).toBe(1_726);
  });

  it('accepts compact hex', () => {
    expect(decodeMode01Response('rpm', '010C\r410C1AF8')).toBe(1_726);
  });

  it('P4g field revision: accelPedalPct (PID 0x49) decodes A=0x80 to 50.2% (1dp) -- distinct from throttlePct\'s own PID 0x11', () => {
    expect(decodeMode01Response('accelPedalPct', '41 49 80')).toBeCloseTo(50.2, 1);
    expect(encodeMode01Request('accelPedalPct')).toBe('0149'); // NOT '0111' (throttlePct's PID) -- the two channels must never share a request.
  });

  it.each(['transOilC', 'latG', 'longG'] as const)(
    'rejects non-standard channel %s at the runtime boundary',
    (channel) => {
      expect(() =>
        encodeMode01Request(channel as unknown as Parameters<typeof encodeMode01Request>[0]),
      ).toThrow('No standard mode 01 PID');
    },
  );
});
