import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createProjection } from '../../src/geometry';

describe('createProjection', () => {
  it('maps its origin to zero and uses east/north meter axes', () => {
    const projection = createProjection({ lat: 45, lon: 25 });

    expect(projection.toLocal({ lat: 45, lon: 25 })).toEqual({ e: 0, n: 0 });
    expect(projection.toLocal({ lat: 45.001, lon: 25 }).n).toBeCloseTo(111.195, 2);
    expect(projection.toLocal({ lat: 45, lon: 25.001 }).e).toBeCloseTo(78.627, 2);
  });

  it('handles a local displacement across the antimeridian', () => {
    const projection = createProjection({ lat: 0, lon: 179.99 });
    const local = projection.toLocal({ lat: 0, lon: -179.99 });

    expect(local.e).toBeCloseTo(2_223.9, 0);
    expect(projection.toLatLon(local).lon).toBeCloseTo(-179.99, 10);
  });

  it('rejects non-finite, out-of-range, and polar inputs', () => {
    expect(() => createProjection({ lat: Number.NaN, lon: 0 })).toThrow(RangeError);
    expect(() => createProjection({ lat: 91, lon: 0 })).toThrow(RangeError);
    expect(() => createProjection({ lat: 90, lon: 0 })).toThrow(RangeError);

    const projection = createProjection({ lat: 0, lon: 0 });
    expect(() => projection.toLocal({ lat: 0, lon: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    expect(() => projection.toLatLon({ e: 0, n: 11_000_000 })).toThrow(RangeError);
  });

  it('round-trips points within 20 km to less than 1e-6 degrees', () => {
    const originArbitrary = fc.record({
      lat: fc.double({ min: -80, max: 80, noNaN: true, noDefaultInfinity: true }),
      lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
    });
    const offsetArbitrary = fc.record({
      e: fc.double({ min: -20_000, max: 20_000, noNaN: true, noDefaultInfinity: true }),
      n: fc.double({ min: -20_000, max: 20_000, noNaN: true, noDefaultInfinity: true }),
    });

    fc.assert(
      fc.property(originArbitrary, offsetArbitrary, (origin, offset) => {
        const projection = createProjection(origin);
        const geographic = projection.toLatLon(offset);
        const roundTrip = projection.toLatLon(projection.toLocal(geographic));
        expect(Math.abs(roundTrip.lat - geographic.lat)).toBeLessThan(1e-6);
        expect(Math.abs(roundTrip.lon - geographic.lon)).toBeLessThan(1e-6);
      }),
      { numRuns: 1_000 },
    );
  });
});
