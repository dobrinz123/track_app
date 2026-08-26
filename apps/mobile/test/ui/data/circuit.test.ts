import { describe, expect, it } from 'vitest';
import { ADVISORY_NOTICE, circuitDisplayData } from '../../../src/ui/data/circuit';
import { TMR_CIRCUIT_PROFILE } from '../../../src/session/tmrProfile';
import { MOTORPARK_CIRCUIT_PROFILE } from '../../../src/session/circuitCatalog';

/**
 * `circuitDisplayData()` (ticket CN-W3) replaces the old hardcoded
 * `TRANSILVANIA_MOTOR_RING` constant -- it must render EITHER bundled
 * circuit from its real `CircuitProfile` alone, and must never claim
 * "official" (contracts.md's Coaching/geometry addenda: geometry is
 * community-derived, sectors are app-defined, for both circuits).
 */
describe('circuitDisplayData (ticket CN-W3)', () => {
  it('TMR: renders the real profile fields, never the word "official"', () => {
    const data = circuitDisplayData(TMR_CIRCUIT_PROFILE);
    expect(data.circuitId).toBe(TMR_CIRCUIT_PROFILE.circuitId);
    expect(data.displayName).toBe(TMR_CIRCUIT_PROFILE.displayName);
    expect(data.locality).toBe(TMR_CIRCUIT_PROFILE.locality);
    expect(data.country).toBe(TMR_CIRCUIT_PROFILE.country);
    expect(data.layoutId).toBe(TMR_CIRCUIT_PROFILE.layoutId);
    expect(data.direction).toBe(TMR_CIRCUIT_PROFILE.direction);
    expect(data.geometryStatus).toBe(TMR_CIRCUIT_PROFILE.geometryStatus);
    expect(data.sectorStatus).toBe(TMR_CIRCUIT_PROFILE.sectorStatus);
    expect(data.lengthKm).toBeCloseTo(TMR_CIRCUIT_PROFILE.totalLengthM / 1000, 6);
    // TMR-specific extras (researched, not on the profile itself) still surface.
    expect(data.extras.openedYear).toBe(2018);
    expect(data.extras.county).toBe('Mureș County');
    expect(data.provenanceText.toLowerCase()).not.toContain('official');
    expect(data.osmAttribution.toLowerCase()).not.toContain('official');
    expect(ADVISORY_NOTICE.toLowerCase()).toContain('not an official');
  });

  it('MotorPark: renders the real profile fields, no invented extras, never the word "official" (beyond the disclaimer copy)', () => {
    const data = circuitDisplayData(MOTORPARK_CIRCUIT_PROFILE);
    expect(data.circuitId).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(data.displayName).toBe('MotorPark România');
    expect(data.layoutId).toBe(MOTORPARK_CIRCUIT_PROFILE.layoutId);
    expect(data.direction).toBe(MOTORPARK_CIRCUIT_PROFILE.direction);
    expect(data.geometryStatus).toBe(MOTORPARK_CIRCUIT_PROFILE.geometryStatus);
    expect(data.sectorStatus).toBe(MOTORPARK_CIRCUIT_PROFILE.sectorStatus);
    // Nothing invented beyond what MotorPark's own asset carries.
    expect(data.extras).toEqual({});
    expect(data.provenanceText.toLowerCase()).not.toContain('official');
    expect(data.provenanceText).toContain(MOTORPARK_CIRCUIT_PROFILE.source.name);
  });

  it('provenance text includes the profile source URL/license/retrievedAt when present', () => {
    const data = circuitDisplayData(TMR_CIRCUIT_PROFILE);
    expect(data.provenanceText).toContain(TMR_CIRCUIT_PROFILE.source.name);
    if (TMR_CIRCUIT_PROFILE.source.url !== undefined) {
      expect(data.provenanceText).toContain(TMR_CIRCUIT_PROFILE.source.url);
    }
  });
});
