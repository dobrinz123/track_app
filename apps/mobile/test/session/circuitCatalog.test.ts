import { describe, expect, it } from 'vitest';
import { circuitCatalog, MOTORPARK_CIRCUIT_PROFILE, MOTORPARK_RUNTIME_PROFILE } from '../../src/session/circuitCatalog';
import { TMR_CIRCUIT_PROFILE, TMR_RUNTIME_PROFILE } from '../../src/session/tmrProfile';

function summaryFor(profile: typeof TMR_CIRCUIT_PROFILE) {
  return {
    circuitId: profile.circuitId,
    displayName: profile.displayName,
    country: profile.country,
    locality: profile.locality,
    lengthM: profile.totalLengthM,
    layoutId: profile.layoutId,
    layoutVersion: profile.layoutVersion,
    geometryStatus: profile.geometryStatus,
    sectorStatus: profile.sectorStatus,
  };
}

describe('circuitCatalog (real bundled TMR + MotorPark assets, CN-W2)', () => {
  it('list() returns both bundled entries, summarizing the real profiles', () => {
    const list = circuitCatalog.list();
    expect(list).toHaveLength(2);
    expect(list.map((entry) => entry.circuitId).sort()).toEqual(
      [TMR_CIRCUIT_PROFILE.circuitId, MOTORPARK_CIRCUIT_PROFILE.circuitId].sort(),
    );

    const tmrEntry = list.find((entry) => entry.circuitId === TMR_CIRCUIT_PROFILE.circuitId);
    expect(tmrEntry).toEqual(summaryFor(TMR_CIRCUIT_PROFILE));

    const motorparkEntry = list.find(
      (entry) => entry.circuitId === MOTORPARK_CIRCUIT_PROFILE.circuitId,
    );
    expect(motorparkEntry).toEqual(summaryFor(MOTORPARK_CIRCUIT_PROFILE));
    expect(motorparkEntry!.displayName).toBe('MotorPark România');
    expect(motorparkEntry!.locality).toBe('Adâncata, Ialomița');
    expect(motorparkEntry!.country).toBe('Romania');
    expect(motorparkEntry!.lengthM).toBeGreaterThan(4000);
  });

  it('get() returns the matching {profile, runtime} pair for each bundled circuit id, and null for an unknown id', () => {
    const tmrResult = circuitCatalog.get(TMR_CIRCUIT_PROFILE.circuitId);
    expect(tmrResult).not.toBeNull();
    expect(tmrResult!.profile).toBe(TMR_CIRCUIT_PROFILE);
    expect(tmrResult!.runtime).toBe(TMR_RUNTIME_PROFILE);

    const motorparkResult = circuitCatalog.get(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(motorparkResult).not.toBeNull();
    expect(motorparkResult!.profile).toBe(MOTORPARK_CIRCUIT_PROFILE);
    expect(motorparkResult!.runtime).toBe(MOTORPARK_RUNTIME_PROFILE);
    expect(motorparkResult!.runtime.centerline.length).toBe(
      motorparkResult!.profile.centerline.length,
    );
    expect(motorparkResult!.runtime.cumulativeDistancesM.length).toBe(
      motorparkResult!.profile.centerline.length,
    );

    expect(circuitCatalog.get('does-not-exist')).toBeNull();
  });
});
