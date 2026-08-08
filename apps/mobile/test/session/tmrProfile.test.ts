import { describe, expect, it } from 'vitest';
import { TMR_CIRCUIT_PROFILE, TMR_RUNTIME_PROFILE } from '../../src/session/tmrProfile';

// Proves the module-level static `.json` import (Metro's resolveJsonModule
// semantics: inlined at build time, not a runtime fetch/fs read) also
// resolves and validates correctly under vitest/Vite's own native JSON
// module handling -- both interpret the file the same way (a plain object
// default export), so no special vitest config is needed for this import.
describe('tmrProfile (bundled v2 asset, MUST DO #6)', () => {
  it('loads and validates the bundled v2 profile via loadProfileFromJson', () => {
    expect(TMR_CIRCUIT_PROFILE.circuitId).toBe('transilvania-motor-ring');
    expect(TMR_CIRCUIT_PROFILE.layoutId).toBe('main');
    expect(TMR_CIRCUIT_PROFILE.layoutVersion).toBe(2);
    expect(TMR_CIRCUIT_PROFILE.direction).toBe('clockwise');
    expect(TMR_CIRCUIT_PROFILE.totalLengthM).toBeGreaterThan(0);
    expect(TMR_CIRCUIT_PROFILE.centerline.length).toBeGreaterThan(1);
    expect(TMR_CIRCUIT_PROFILE.sectorGates.length).toBeGreaterThan(0);
    expect(TMR_CIRCUIT_PROFILE.startFinishGate).toBeTruthy();
  });

  it('exports a non-null, real runtime companion (projected centerline/cumulative distances)', () => {
    expect(TMR_RUNTIME_PROFILE).not.toBeNull();
    expect(TMR_RUNTIME_PROFILE.startFinishGate.distanceM).toBeGreaterThanOrEqual(0);
  });
});
