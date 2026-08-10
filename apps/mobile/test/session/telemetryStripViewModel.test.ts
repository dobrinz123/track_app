import { describe, expect, it } from 'vitest';
import {
  TELEMETRY_STRIP_COOLANT_AMBER_C,
  TELEMETRY_STRIP_COOLANT_RED_C,
  isTelemetryStripVisible,
  telemetryStripCoolantTint,
} from '../../src/session/telemetryProvider';

/**
 * Dashboard telemetry strip view-model logic (Telemetry addendum — P4b
 * amendment, binding): "visible ONLY while telemetryEnabled AND the provider
 * state is 'polling'... coolant tinted amber >= 98 C, red >= 105 C." Kept as
 * plain functions in `session/telemetryProvider.ts` (no react-native import)
 * specifically so this file can test them directly, without any component
 * rendering -- `TelemetryStrip.tsx` itself stays thin/untested (house rule).
 */
describe('isTelemetryStripVisible (Telemetry addendum — P4b amendment, binding)', () => {
  it('visible only when telemetryEnabled AND providerState is polling', () => {
    expect(isTelemetryStripVisible(true, 'polling')).toBe(true);
  });

  it('hidden when telemetry is disabled, even while polling', () => {
    expect(isTelemetryStripVisible(false, 'polling')).toBe(false);
  });

  it.each(['idle', 'connecting', 'initializing', 'stopped', 'failed'] as const)(
    'hidden while telemetryEnabled but providerState is %s (not polling)',
    (state) => {
      expect(isTelemetryStripVisible(true, state)).toBe(false);
    },
  );
});

describe('telemetryStripCoolantTint (Telemetry addendum — P4b amendment, binding: amber >= 98 C, red >= 105 C)', () => {
  it('exposes the binding thresholds as named constants', () => {
    expect(TELEMETRY_STRIP_COOLANT_AMBER_C).toBe(98);
    expect(TELEMETRY_STRIP_COOLANT_RED_C).toBe(105);
  });

  it('no sample yet (null) reads as normal, not an alarm color', () => {
    expect(telemetryStripCoolantTint(null)).toBe('normal');
  });

  it('below the amber boundary is normal', () => {
    expect(telemetryStripCoolantTint(97)).toBe('normal');
  });

  it('exactly at the amber boundary (98) tints amber', () => {
    expect(telemetryStripCoolantTint(98)).toBe('amber');
  });

  it('just below the red boundary (104) stays amber', () => {
    expect(telemetryStripCoolantTint(104)).toBe('amber');
  });

  it('exactly at the red boundary (105) tints red', () => {
    expect(telemetryStripCoolantTint(105)).toBe('red');
  });

  it('well above the red boundary stays red', () => {
    expect(telemetryStripCoolantTint(130)).toBe('red');
  });
});
