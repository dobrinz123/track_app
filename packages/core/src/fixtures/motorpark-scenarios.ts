import type { CircuitProfile } from '../contracts';

import { withFixtureMetadata, type TelemetryFixture } from './drive-lap';
import { cleanRecognitionLap, multiLapSession, pitLaneTransitLap } from './scenarios';

/**
 * MotorPark-scoped fixture presets (ticket CN-W2). These are thin, fixed-seed
 * wrappers around the existing profile-parametrized scenario builders in
 * `./scenarios` -- no new fixture engine -- so DevReplay and the acceptance
 * soak can exercise the MotorPark circuit the same way the TMR fixtures are
 * exercised (profile passed at the call site). Seeds are fixed (9_1xx range,
 * distinct from every other scenario's seed) so replay stays deterministic,
 * and the `scenario`/`expectedOutcome` metadata is relabeled to name
 * MotorPark explicitly rather than inheriting the generic builder's text.
 */

/** Mirrors `cleanRecognitionLap`'s calibration-acceptance scenario, scoped to MotorPark. */
export function motorparkCleanRecognitionLap(
  profile: CircuitProfile,
  seed = 9_101,
): TelemetryFixture {
  return withFixtureMetadata(cleanRecognitionLap(profile, seed), {
    scenario: 'motorparkCleanRecognitionLap',
    seed,
    expectedOutcome:
      'MotorPark calibration is accepted in the profile direction with at least 95% coverage.',
  });
}

/** Mirrors `multiLapSession`'s continuous-timing scenario, fixed to 3 MotorPark laps. */
export function motorparkMultiLapSession(
  profile: CircuitProfile,
  seed = 9_102,
): TelemetryFixture {
  return withFixtureMetadata(multiLapSession(profile, 3, seed), {
    scenario: 'motorparkMultiLapSession',
    seed,
    expectedOutcome: 'Exactly 3 valid MotorPark laps complete with ordered sectors.',
  });
}

/** Mirrors `pitLaneTransitLap`'s real pit-geometry scenario, scoped to MotorPark. */
export function motorparkPitLaneTransitLap(
  profile: CircuitProfile,
  seed = 9_103,
): TelemetryFixture {
  return withFixtureMetadata(pitLaneTransitLap(profile, seed), {
    scenario: 'motorparkPitLaneTransitLap',
    seed,
    expectedOutcome: 'MotorPark pit entry and exit are detected and the lap is PIT_TRANSIT invalid.',
  });
}
