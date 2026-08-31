import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  chooseInitialActiveVehicleProfileId,
  type VehicleProfileBindingSummary,
} from '../../src/session/settingsStore';
import { formatActiveVehicleProfileDisplay } from '../../src/session/telemetryProvider';

/**
 * Ticket P4p G1 (binding, field test 9 BUG-A): bindings are stored PER
 * PROFILE (`vehicle_profile_bindings.profile_id`), and the field exports of
 * 2026-08-31 prove the split -- `2026-08-31-steeringAngle-1.json` (profile
 * `generic`) carries `brakePressure = 0x12/0x4002`, while
 * `-2.json` (profile `toyota-supra-b58`) carries the binding the user
 * actually confirmed with the engine running, `0x12/0x58B7`. The monitor read
 * the GENERIC profile, so it polled 0x4002 and showed raw 131/155 = 0/100 %.
 *
 * The fix is ONE app-level `activeVehicleProfileId` setting. This suite pins
 * its pure parts: the default, the one-time migration heuristic, and the
 * label the monitor header renders.
 */

function binding(
  profileId: string,
  channel: string,
  status: VehicleProfileBindingSummary['status'] = 'field-confirmed',
): VehicleProfileBindingSummary {
  return { profileId, channel, status };
}

describe('P4p G1 -- activeVehicleProfileId setting', () => {
  it('defaults to the hypothesis-free generic profile', () => {
    expect(DEFAULT_SETTINGS.activeVehicleProfileId).toBe('generic');
  });
});

describe('P4p G1 -- the one-time initial-profile heuristic', () => {
  it('prefers the profile that carries field-confirmed bindings when generic carries the SAME channel (the field-test-9 situation)', () => {
    const chosen = chooseInitialActiveVehicleProfileId([
      binding('generic', 'brakePressure'),
      binding('generic', 'brakeSwitch'),
      binding('toyota-supra-b58', 'brakePressure'),
      binding('toyota-supra-b58', 'brakeSwitch'),
    ]);
    expect(chosen).toBe('toyota-supra-b58');
  });

  it('changes nothing when only the generic profile has ever been confirmed against', () => {
    expect(chooseInitialActiveVehicleProfileId([binding('generic', 'brakePressure')])).toBeNull();
  });

  it('changes nothing when the non-generic profile shares no channel with generic (nothing to disambiguate)', () => {
    expect(
      chooseInitialActiveVehicleProfileId([
        binding('generic', 'brakeSwitch'),
        binding('toyota-supra-b58', 'steeringAngle'),
      ]),
    ).toBeNull();
  });

  it('ignores bindings that were never field-confirmed', () => {
    expect(
      chooseInitialActiveVehicleProfileId([
        binding('generic', 'brakePressure'),
        binding('toyota-supra-b58', 'brakePressure', 'hypothesis'),
      ]),
    ).toBeNull();
  });

  it('is deterministic when two non-generic profiles qualify -- the one with the most field-confirmed overlapping channels wins', () => {
    const chosen = chooseInitialActiveVehicleProfileId([
      binding('generic', 'brakePressure'),
      binding('generic', 'brakeSwitch'),
      binding('other-car', 'brakePressure'),
      binding('toyota-supra-b58', 'brakePressure'),
      binding('toyota-supra-b58', 'brakeSwitch'),
    ]);
    expect(chosen).toBe('toyota-supra-b58');
  });

  it('never returns generic itself (the default already is generic -- there is nothing to migrate to)', () => {
    expect(chooseInitialActiveVehicleProfileId([binding('generic', 'brakePressure')])).not.toBe('generic');
    expect(chooseInitialActiveVehicleProfileId([])).toBeNull();
  });
});

describe('P4p G1 -- the monitor header label', () => {
  it('names the active profile by its catalog label and its id', () => {
    expect(formatActiveVehicleProfileDisplay('toyota-supra-b58', 'en')).toBe(
      'Toyota GR Supra (A90/J29), BMW B58 (toyota-supra-b58)',
    );
  });

  it('renders the label in the app language', () => {
    expect(formatActiveVehicleProfileDisplay('generic', 'ro')).not.toBe(
      formatActiveVehicleProfileDisplay('generic', 'en'),
    );
    expect(formatActiveVehicleProfileDisplay('generic', 'en')).toContain('(generic)');
  });

  it('keeps an unknown id visible rather than silently claiming the generic profile', () => {
    expect(formatActiveVehicleProfileDisplay('ford-fiesta', 'en')).toContain('(ford-fiesta)');
  });
});
