import { isLearnedGeometry, type CircuitProfile } from '@circuit/core';

/**
 * Ticket P5d T5 -- the two guards Test Loop mode adds, in one place so both
 * the composition layer and the tests read the SAME rule.
 *
 * There is deliberately no third guard for voice: `voiceCoach.ts` speaks
 * nothing but `CoachCue`s, and a controller built with `coaching.enabled:
 * false` never produces one (`SessionController`: "`null` whenever coaching is
 * disabled"). Switching the cues off switches the voice off with them, which
 * is why that is the only switch here.
 *
 * The analysis-side guard needs no code at all: `analysisAssembly` sets
 * `geometryValidated: profile.geometryStatus === 'official'`, and a learned
 * circuit is `'ad-hoc'` by construction (`buildTestLoopCircuit` writes that
 * value as a constant), so the whole suggestion stage is inert on a learned
 * circuit for the same reason it is inert on MotorPark.
 */

/**
 * Whether live coaching cues may run for a session on this circuit.
 * `settingCoachingEnabled` is the driver's own toggle; a learned (ad-hoc)
 * circuit overrides it to `false`, never the other way round.
 */
export function learnedCoachingEnabled(
  settingCoachingEnabled: boolean,
  profile: Pick<CircuitProfile, 'geometryStatus'>,
): boolean {
  if (isLearnedGeometry(profile)) return false;
  return settingCoachingEnabled;
}
