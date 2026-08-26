import type { CircuitProfile, TelemetryFixture } from '@circuit/core';
import {
  cleanRecognitionLap,
  motorparkCleanRecognitionLap,
  motorparkMultiLapSession,
  motorparkPitLaneTransitLap,
  multiLapSession,
  noisyGpsLap,
  pbImprovementSession,
  pitLaneTransitLap,
  reverseTravelLap,
  signalLossLap,
} from '@circuit/core';
import { circuitCatalog, MOTORPARK_CIRCUIT_PROFILE } from './circuitCatalog';
import { TMR_CIRCUIT_PROFILE } from './tmrProfile';

export interface DevReplayScenario {
  id: string;
  label: string;
  /** Which bundled circuit this fixture is built against -- resolved to a real profile via `circuitCatalog`, never hardcoded to one circuit (ticket CN-W2). */
  circuitId: string;
  build: (profile: CircuitProfile) => TelemetryFixture;
}

/**
 * Real bundled fixture scenarios from `@circuit/core/fixtures`
 * (`packages/core/src/fixtures/scenarios.ts` + `motorpark-scenarios.ts`) --
 * each one's `metadata.expectedOutcome` is shown as the row's description in
 * `DevReplayScreen` so the screen stays self-documenting. Extracted into this
 * plain-TS module (no `react-native`/navigation imports) so the scenario ->
 * circuit wiring is unit-testable under vitest's pure-TS config, same as
 * every other `session/*.ts` module -- `DevReplayScreen.tsx` itself imports
 * `DEV_REPLAY_SCENARIOS` from here rather than defining it inline.
 *
 * TMR scenarios keep `circuitId: TMR_CIRCUIT_PROFILE.circuitId` (unchanged
 * behavior); MotorPark scenarios are labeled with a "MotorPark — " prefix so
 * the circuit is obvious in the list.
 */
export const DEV_REPLAY_SCENARIOS: DevReplayScenario[] = [
  {
    id: 'clean-recognition-lap',
    label: 'Clean recognition lap',
    circuitId: TMR_CIRCUIT_PROFILE.circuitId,
    build: (p) => cleanRecognitionLap(p, 901),
  },
  {
    id: 'three-laps',
    label: 'Three timed laps',
    circuitId: TMR_CIRCUIT_PROFILE.circuitId,
    build: (p) => multiLapSession(p, 3, 902),
  },
  {
    id: 'pb-improvement',
    label: 'PB improvement (3 laps, each faster)',
    circuitId: TMR_CIRCUIT_PROFILE.circuitId,
    build: (p) => pbImprovementSession(p, 903),
  },
  {
    id: 'noisy-gps',
    label: 'Noisy GPS (8m Gaussian noise)',
    circuitId: TMR_CIRCUIT_PROFILE.circuitId,
    build: (p) => noisyGpsLap(p, 904),
  },
  {
    id: 'signal-loss',
    label: 'Signal loss (15s gap)',
    circuitId: TMR_CIRCUIT_PROFILE.circuitId,
    build: (p) => signalLossLap(p, 905),
  },
  {
    id: 'reverse-travel',
    label: 'Reverse travel',
    circuitId: TMR_CIRCUIT_PROFILE.circuitId,
    build: (p) => reverseTravelLap(p, 906),
  },
  {
    id: 'pit-lane-transit',
    label: 'Pit lane transit',
    circuitId: TMR_CIRCUIT_PROFILE.circuitId,
    build: (p) => pitLaneTransitLap(p, 907),
  },
  {
    id: 'motorpark-clean-recognition-lap',
    label: 'MotorPark — Clean recognition lap',
    circuitId: MOTORPARK_CIRCUIT_PROFILE.circuitId,
    build: (p) => motorparkCleanRecognitionLap(p),
  },
  {
    id: 'motorpark-three-laps',
    label: 'MotorPark — Three timed laps',
    circuitId: MOTORPARK_CIRCUIT_PROFILE.circuitId,
    build: (p) => motorparkMultiLapSession(p),
  },
  {
    id: 'motorpark-pit-lane-transit',
    label: 'MotorPark — Pit lane transit',
    circuitId: MOTORPARK_CIRCUIT_PROFILE.circuitId,
    build: (p) => motorparkPitLaneTransitLap(p),
  },
];

/** Resolves a scenario's real bundled profile via the catalog -- null only if a scenario names an unbundled circuitId (defensive; every entry above names a real bundled id). */
export function resolveScenarioProfile(scenario: DevReplayScenario): CircuitProfile | null {
  return circuitCatalog.get(scenario.circuitId)?.profile ?? null;
}
