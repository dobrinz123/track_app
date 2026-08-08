import { describe, expect, it } from 'vitest';
import { circuitCatalog } from '../../src/session/circuitCatalog';
import { TMR_CIRCUIT_PROFILE, TMR_RUNTIME_PROFILE } from '../../src/session/tmrProfile';

describe('circuitCatalog (real bundled v2 TMR asset)', () => {
  it('list() returns exactly the bundled TMR entry, summarizing the real profile', () => {
    const list = circuitCatalog.list();
    expect(list).toHaveLength(1);
    const [entry] = list;
    expect(entry!.circuitId).toBe(TMR_CIRCUIT_PROFILE.circuitId);
    expect(entry!.displayName).toBe(TMR_CIRCUIT_PROFILE.displayName);
    expect(entry!.country).toBe(TMR_CIRCUIT_PROFILE.country);
    expect(entry!.locality).toBe(TMR_CIRCUIT_PROFILE.locality);
    expect(entry!.lengthM).toBe(TMR_CIRCUIT_PROFILE.totalLengthM);
    expect(entry!.layoutId).toBe(TMR_CIRCUIT_PROFILE.layoutId);
    expect(entry!.layoutVersion).toBe(TMR_CIRCUIT_PROFILE.layoutVersion);
    expect(entry!.geometryStatus).toBe(TMR_CIRCUIT_PROFILE.geometryStatus);
    expect(entry!.sectorStatus).toBe(TMR_CIRCUIT_PROFILE.sectorStatus);
  });

  it('get() returns the matching {profile, runtime} pair for the bundled circuit id, and null for an unknown id', () => {
    const result = circuitCatalog.get(TMR_CIRCUIT_PROFILE.circuitId);
    expect(result).not.toBeNull();
    expect(result!.profile).toBe(TMR_CIRCUIT_PROFILE);
    expect(result!.runtime).toBe(TMR_RUNTIME_PROFILE);

    expect(circuitCatalog.get('does-not-exist')).toBeNull();
  });
});
