import { describe, expect, it } from 'vitest';
import { formatBrakePctRawDisplay, formatBrakeSwitchDisplay } from '../../src/session/telemetryProvider';

/**
 * Ticket P4n N2 (binding): the Telemetry monitor must show "Brake switch"
 * as ON/OFF (never the raw 100/0), and "Brake pressure" with its raw value
 * in small text ("raw 37 / 64"). Pinned here as pure functions, independent
 * of the screen's own React rendering.
 */

describe('formatBrakeSwitchDisplay', () => {
  it('reads 100 as ON and 0 as OFF', () => {
    expect(formatBrakeSwitchDisplay(100)).toBe('ON');
    expect(formatBrakeSwitchDisplay(0)).toBe('OFF');
  });

  it('reads no sample yet as the monitor s own dash placeholder', () => {
    expect(formatBrakeSwitchDisplay(undefined)).toBe('—');
  });
});

describe('formatBrakePctRawDisplay', () => {
  it('shows the raw value alongside the observed max, e.g. "raw 37 / 64"', () => {
    expect(formatBrakePctRawDisplay({ raw: 37, observedMax: 64 })).toBe('raw 37 / 64');
  });

  it('shows just the raw value when there is no observed max to compare it against', () => {
    expect(formatBrakePctRawDisplay({ raw: 12, observedMax: null })).toBe('raw 12');
  });

  it('shows nothing before a raw sample has been captured', () => {
    expect(formatBrakePctRawDisplay(undefined)).toBeNull();
  });
});
