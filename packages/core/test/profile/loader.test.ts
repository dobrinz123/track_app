import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { loadProfileFromJson, MAX_PROFILE_JSON_BYTES } from '../../src/profile/loader';
import { makeTestProfile } from '../../src/profile/test-fixture';

describe('loadProfileFromJson', () => {
  it('preserves every serialized profile field and numeric value on round-trip', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: 5, max: 60, noNaN: true, noDefaultInfinity: true }),
        (layoutVersion, corridorWidthM) => {
          const profile = makeTestProfile({ layoutVersion, corridorWidthM });
          const result = loadProfileFromJson(JSON.stringify(profile));
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.profile).toEqual(profile);
        },
      ),
    );
  });

  it('migrates schema version 0 trackName to displayName', () => {
    const { displayName, ...current } = makeTestProfile();
    const versionZero = { ...current, schemaVersion: 0, trackName: displayName };
    const result = loadProfileFromJson(JSON.stringify(versionZero));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.schemaVersion).toBe(1);
      expect(result.profile.displayName).toBe('Dev Test Ring (synthetic)');
    }
  });

  it('returns UNSUPPORTED_SCHEMA_VERSION for an unknown version without throwing', () => {
    const result = loadProfileFromJson(JSON.stringify(makeTestProfile({ schemaVersion: 99 })));
    expect(result).toEqual({ ok: false, errors: ['UNSUPPORTED_SCHEMA_VERSION'] });
  });

  it('returns INVALID_JSON for malformed JSON without throwing', () => {
    expect(loadProfileFromJson('{')).toEqual({ ok: false, errors: ['INVALID_JSON'] });
  });

  it('rejects JSON inputs larger than 5 MB before parsing', () => {
    const oversized = ' '.repeat(MAX_PROFILE_JSON_BYTES + 1);
    expect(loadProfileFromJson(oversized)).toEqual({ ok: false, errors: ['PROFILE_TOO_LARGE'] });
  });
});

