import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CircuitCatalogError,
  circuitCatalogKey,
  createCircuitCatalog,
  summarize,
} from '../../src/catalog';
import { makeTestProfile } from '../../src/profile';

const TMR_ASSET_URL = new URL(
  '../../assets/circuits/transilvania-motor-ring.v1.json',
  import.meta.url,
);

function readTmrProfile(): unknown {
  return JSON.parse(readFileSync(TMR_ASSET_URL, 'utf8')) as unknown;
}

describe('circuit catalog', () => {
  it('lists real and synthetic validated profiles in display-name order', () => {
    const synthetic = makeTestProfile();
    const catalog = createCircuitCatalog([{ raw: readTmrProfile() }, { raw: synthetic }]);

    expect(catalog.list().map(({ displayName }) => displayName)).toEqual([
      'Dev Test Ring (synthetic)',
      'Transilvania Motor Ring',
    ]);
    expect(catalog.list()).toContainEqual(summarize(synthetic));
    expect(
      catalog.summaries[circuitCatalogKey(synthetic.circuitId, synthetic.layoutId)],
    ).toEqual(summarize(synthetic));
  });

  it('returns the validated profile and computed runtime', () => {
    const catalog = createCircuitCatalog([{ raw: readTmrProfile() }]);
    const loaded = catalog.get('transilvania-motor-ring');

    expect(loaded?.profile.circuitId).toBe('transilvania-motor-ring');
    expect(loaded?.runtime.centerline.length).toBe(loaded?.profile.centerline.length);
    expect(loaded?.runtime.cumulativeDistancesM.length).toBe(loaded?.profile.centerline.length);
  });

  it('collects validation failures and identifies the failing circuit', () => {
    const corrupt = makeTestProfile({ circuitId: 'broken-ring', centerline: [] });

    expect(() =>
      createCircuitCatalog([
        { raw: corrupt },
        { raw: makeTestProfile({ circuitId: 'also-broken', totalLengthM: -1 }) },
      ]),
    ).toThrowError(CircuitCatalogError);

    try {
      createCircuitCatalog([
        { raw: corrupt },
        { raw: makeTestProfile({ circuitId: 'also-broken', totalLengthM: -1 }) },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitCatalogError);
      expect((error as CircuitCatalogError).errors).toHaveLength(2);
      expect((error as Error).message).toContain('broken-ring');
      expect((error as Error).message).toContain('also-broken');
    }
  });

  it('rejects duplicate circuit and layout pairs explicitly', () => {
    const profile = makeTestProfile();

    expect(() => createCircuitCatalog([{ raw: profile }, { raw: profile }])).toThrowError(
      /dev-test-ring\/rounded-rectangle: DUPLICATE_CIRCUIT_LAYOUT/,
    );
  });

  it('addresses multiple layouts explicitly without choosing an ambiguous default', () => {
    const first = makeTestProfile({ layoutId: 'layout-a' });
    const second = makeTestProfile({ layoutId: 'layout-b', displayName: 'Dev Test Ring B' });
    const catalog = createCircuitCatalog([{ raw: first }, { raw: second }]);

    expect(catalog.get(first.circuitId)).toBeNull();
    expect(catalog.get(first.circuitId, first.layoutId)?.profile).toEqual(first);
    expect(Object.keys(catalog.summaries)).toEqual([
      circuitCatalogKey(first.circuitId, first.layoutId),
      circuitCatalogKey(second.circuitId, second.layoutId),
    ]);
  });
});
