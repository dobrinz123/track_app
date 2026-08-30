import { describe, expect, it } from 'vitest';
import {
  brakeSwitchRowLabel,
  formatBrakePctRawDisplay,
  formatBrakeSwitchDisplay,
  shouldShowBrakeBindingRestartHint,
} from '../../src/session/telemetryProvider';

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

/**
 * Ticket P4n-FIX1 Q1 (binding): the monitor's row label says "(coarse)" only
 * for a binding whose decode has neither a persisted `flagBit` nor
 * `activeValueHex` -- see `ResolvedBrakeBinding.coarse`'s own doc comment.
 */
describe('brakeSwitchRowLabel', () => {
  it('appends "(coarse)" when the binding is coarse', () => {
    expect(brakeSwitchRowLabel('Brake switch', true)).toBe('Brake switch (coarse)');
  });

  it('leaves the label untouched when the binding is not coarse', () => {
    expect(brakeSwitchRowLabel('Brake switch', false)).toBe('Brake switch');
  });

  it('leaves the label untouched before any poll plan has been built (undefined)', () => {
    expect(brakeSwitchRowLabel('Brake switch', undefined)).toBe('Brake switch');
  });
});

/**
 * Ticket P4n-FIX1 Q3 (binding, Codex P4n-REV1 LOW): "Stop -> Start to apply"
 * must appear ONLY for a running ENET session whose active poll plan the
 * confirm actually changed -- never for ELM327, never for an identical
 * reconfirmation, never for a channel that was never polled.
 */
describe('shouldShowBrakeBindingRestartHint', () => {
  it('true for ENET with a changed poll plan', () => {
    expect(shouldShowBrakeBindingRestartHint({ adapterType: 'enet', brakeBindingsChangedSincePoll: true })).toBe(true);
  });

  it('false for ELM327, even if brakeBindingsChangedSincePoll were somehow true', () => {
    expect(shouldShowBrakeBindingRestartHint({ adapterType: 'elm327', brakeBindingsChangedSincePoll: true })).toBe(false);
  });

  it('false for ENET when nothing changed (identical reconfirmation, or a non-polled channel)', () => {
    expect(shouldShowBrakeBindingRestartHint({ adapterType: 'enet', brakeBindingsChangedSincePoll: false })).toBe(false);
  });

  it('false for ENET before any poll plan has ever been built (undefined)', () => {
    expect(shouldShowBrakeBindingRestartHint({ adapterType: 'enet', brakeBindingsChangedSincePoll: undefined })).toBe(false);
  });
});
