import { describe, expect, it } from 'vitest';
import { circuitCatalog, MOTORPARK_CIRCUIT_PROFILE } from '../../src/session/circuitCatalog';
import { DEV_REPLAY_SCENARIOS, resolveScenarioProfile } from '../../src/session/devReplayScenarios';
import { TMR_CIRCUIT_PROFILE } from '../../src/session/tmrProfile';

describe('devReplayScenarios (CN-W2: DevReplay circuit resolution)', () => {
  it('every scenario names a circuitId that resolves to a real bundled profile', () => {
    expect(DEV_REPLAY_SCENARIOS.length).toBeGreaterThan(0);
    for (const scenario of DEV_REPLAY_SCENARIOS) {
      const resolved = resolveScenarioProfile(scenario);
      expect(resolved, `scenario "${scenario.id}" (circuitId "${scenario.circuitId}")`).not.toBeNull();
      expect(resolved!.circuitId).toBe(scenario.circuitId);
    }
  });

  it('TMR scenarios keep circuitId = TMR_CIRCUIT_PROFILE.circuitId (unchanged behavior)', () => {
    const tmrScenarios = DEV_REPLAY_SCENARIOS.filter(
      (scenario) => scenario.circuitId === TMR_CIRCUIT_PROFILE.circuitId,
    );
    expect(tmrScenarios.length).toBeGreaterThanOrEqual(7);
    for (const scenario of tmrScenarios) {
      expect(scenario.label.startsWith('MotorPark')).toBe(false);
    }
  });

  it('MotorPark scenarios resolve to the MotorPark profile and are labeled unambiguously', () => {
    const motorparkScenarios = DEV_REPLAY_SCENARIOS.filter(
      (scenario) => scenario.circuitId === MOTORPARK_CIRCUIT_PROFILE.circuitId,
    );
    expect(motorparkScenarios.length).toBeGreaterThanOrEqual(3);
    for (const scenario of motorparkScenarios) {
      expect(scenario.label).toMatch(/^MotorPark — /);
      const built = scenario.build(MOTORPARK_CIRCUIT_PROFILE);
      expect(built.length).toBeGreaterThan(0);
      expect(built.every((sample) => Number.isFinite(sample.lat) && Number.isFinite(sample.lon))).toBe(
        true,
      );
    }
  });

  it('resolveScenarioProfile returns the SAME object instances the catalog holds', () => {
    const scenario = DEV_REPLAY_SCENARIOS.find(
      (candidate) => candidate.circuitId === MOTORPARK_CIRCUIT_PROFILE.circuitId,
    )!;
    expect(resolveScenarioProfile(scenario)).toBe(circuitCatalog.get(scenario.circuitId)!.profile);
  });
});
