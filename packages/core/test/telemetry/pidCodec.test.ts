import { describe, expect, it } from 'vitest';

import {
  channelForMode01Request,
  decodeMode01Response,
  DEFAULT_ACCEL_PEDAL_PID_SOURCE,
  encodeMode01Request,
  isMode01TelemetryChannel,
  type Mode01TelemetryChannelId,
} from '../../src/telemetry';

describe('mode-01 PID codec', () => {
  // P4h-FIX1 H4 (after Codex P4h-REV1 HIGH, `pidCodec.ts:40-58,88-93`):
  // `accelPedalPct`'s PID source is NO LONGER process-global mutable state --
  // it is an explicit, optional PARAMETER (default 0x5A, the primary source),
  // so nothing this file does can leak into another test file's run.
  const requests: Array<[Mode01TelemetryChannelId, string]> = [
    ['rpm', '010C'],
    ['speedKph', '010D'],
    ['throttlePct', '0111'],
    // Field revision 2 (binding): 0x5A ("Relative accelerator pedal
    // position") is now the PRIMARY source -- see the dedicated
    // "accelPedalPct PID fallback" describe block below for 0x49 coverage.
    ['accelPedalPct', '015A'],
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
    // Field revision 2 (binding): PID 0x5A "Relative accelerator pedal
    // position" is now the PRIMARY source -- SAME decode formula as 0x49
    // (100/255·A), so the ticket's own vector still holds: A=0x80 (128) ->
    // 128*100/255 ≈ 50.196..., i.e. 50.2% to 1 decimal place.
    ['accelPedalPct', '41 5A 00', 0],
    ['accelPedalPct', '41 5A FF', 100],
    ['accelPedalPct', '41 5A 80', 50.196078431372548],
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

  it('P4g field revision: accelPedalPct (PID 0x5A, default source) decodes A=0x80 to 50.2% (1dp) -- distinct from throttlePct\'s own PID 0x11', () => {
    expect(decodeMode01Response('accelPedalPct', '41 5A 80')).toBeCloseTo(50.2, 1);
    expect(encodeMode01Request('accelPedalPct')).toBe('015A'); // NOT '0111' (throttlePct's PID) -- the two channels must never share a request.
  });

  it.each(['transOilC', 'latG', 'longG'] as const)(
    'rejects non-standard channel %s at the runtime boundary',
    (channel) => {
      expect(() =>
        encodeMode01Request(channel as unknown as Parameters<typeof encodeMode01Request>[0]),
      ).toThrow('No standard mode 01 PID');
    },
  );

  /**
   * P4h-FIX1 H4 (after Codex P4h-REV1 HIGH: "accelerator PID selection is
   * process-global mutable state, and live ELM sessions re-read it while
   * decoding ... provider/session A was constructed for 0x5A; provider B or a
   * test switches the global to 0x49; A continues sending 0x5A but rejects
   * every valid response").
   *
   * The source is now a per-call PARAMETER: the caller (a session, frozen at
   * construction) decides, and two callers can disagree simultaneously with
   * no shared state between them. Both PIDs must always resolve via
   * `channelForMode01Request`/`isMode01TelemetryChannel` regardless of which
   * one a given caller uses, since `enetChannelSpecs.ts`'s validator needs to
   * accept either.
   */
  describe('accelPedalPct PID source is a parameter, never global state (P4h-FIX1 H4)', () => {
    it('defaults to 0x5A when no source is passed', () => {
      expect(DEFAULT_ACCEL_PEDAL_PID_SOURCE).toBe('5A');
      expect(encodeMode01Request('accelPedalPct')).toBe('015A');
      expect(decodeMode01Response('accelPedalPct', '41 5A 80')).toBeCloseTo(50.2, 1);
    });

    it('the source parameter switches BOTH the encoded request and the decoder\'s expected PID literal', () => {
      expect(encodeMode01Request('accelPedalPct', '49')).toBe('0149');
      expect(decodeMode01Response('accelPedalPct', '41 49 80', '49')).toBeCloseTo(50.2, 1);
      // A decoder built for 0x49 must not accept a 0x5A frame, and vice versa.
      expect(() => decodeMode01Response('accelPedalPct', '41 5A 80', '49')).toThrow('Missing mode 01 PID');
      expect(() => decodeMode01Response('accelPedalPct', '41 49 80', '5A')).toThrow('Missing mode 01 PID');
    });

    it('two callers with DIFFERENT sources never disturb each other (interleaved, no global to race on)', () => {
      // Interleaved exactly as two live provider generations would be.
      expect(encodeMode01Request('accelPedalPct', '5A')).toBe('015A');
      expect(encodeMode01Request('accelPedalPct', '49')).toBe('0149');
      expect(decodeMode01Response('accelPedalPct', '41 5A 40', '5A')).toBeCloseTo(25.1, 1);
      expect(decodeMode01Response('accelPedalPct', '41 49 40', '49')).toBeCloseTo(25.1, 1);
      // ...and the default is STILL 0x5A afterward: nothing was mutated.
      expect(encodeMode01Request('accelPedalPct')).toBe('015A');
    });

    it('the source parameter is ignored for every other channel (its PID comes from the table)', () => {
      expect(encodeMode01Request('rpm', '49')).toBe('010C');
      expect(decodeMode01Response('rpm', '41 0C 1A F8', '49')).toBe(1_726);
    });

    it('channelForMode01Request recognizes BOTH 0x49 and 0x5A as accelPedalPct', () => {
      expect(channelForMode01Request('0149')).toBe('accelPedalPct');
      expect(channelForMode01Request('015A')).toBe('accelPedalPct');
    });

    it('isMode01TelemetryChannel(accelPedalPct) is true', () => {
      expect(isMode01TelemetryChannel('accelPedalPct')).toBe(true);
    });
  });
});
