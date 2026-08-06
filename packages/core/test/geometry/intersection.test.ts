import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  crossingDirection,
  interpolateCrossingTime,
  segmentIntersection,
} from '../../src/geometry';

describe('segmentIntersection', () => {
  it('returns both parameters and the point for a transverse crossing', () => {
    expect(
      segmentIntersection(
        { e: 0, n: 0 },
        { e: 10, n: 0 },
        { e: 2, n: -5 },
        { e: 2, n: 5 },
      ),
    ).toEqual({ t: 0.2, u: 0.5, point: { e: 2, n: 0 } });
  });

  it('includes endpoint intersections and excludes crossings beyond segment bounds', () => {
    expect(
      segmentIntersection(
        { e: 0, n: 0 },
        { e: 10, n: 0 },
        { e: 10, n: 0 },
        { e: 10, n: 5 },
      ),
    ).toEqual({ t: 1, u: 0, point: { e: 10, n: 0 } });
    expect(
      segmentIntersection(
        { e: 0, n: 0 },
        { e: 1, n: 0 },
        { e: 2, n: -1 },
        { e: 2, n: 1 },
      ),
    ).toBeNull();
  });

  it('returns null for parallel, collinear, and degenerate segments', () => {
    expect(
      segmentIntersection(
        { e: 0, n: 0 },
        { e: 2, n: 0 },
        { e: 0, n: 1 },
        { e: 2, n: 1 },
      ),
    ).toBeNull();
    expect(
      segmentIntersection(
        { e: 0, n: 0 },
        { e: 2, n: 0 },
        { e: 1, n: 0 },
        { e: 3, n: 0 },
      ),
    ).toBeNull();
    expect(
      segmentIntersection(
        { e: 0, n: 0 },
        { e: 0, n: 0 },
        { e: 0, n: -1 },
        { e: 0, n: 1 },
      ),
    ).toBeNull();
  });

  it('rejects non-finite coordinates', () => {
    expect(() =>
      segmentIntersection(
        { e: Number.POSITIVE_INFINITY, n: 0 },
        { e: 1, n: 0 },
        { e: 0, n: -1 },
        { e: 0, n: 1 },
      ),
    ).toThrow(RangeError);
  });
});

describe('crossingDirection', () => {
  const gateA = { e: 0, n: 0 };
  const gateB = { e: 10, n: 0 };

  it('defines right-to-left motion across directed gate A->B as forward', () => {
    expect(crossingDirection(gateA, gateB, { e: 5, n: -2 }, { e: 5, n: 2 })).toBe(
      'forward',
    );
    expect(crossingDirection(gateA, gateB, { e: 5, n: 2 }, { e: 5, n: -2 })).toBe(
      'reverse',
    );
  });

  it('rejects degenerate and parallel motion where direction is undefined', () => {
    expect(() => crossingDirection(gateA, gateA, { e: 0, n: -1 }, { e: 0, n: 1 })).toThrow(
      RangeError,
    );
    expect(() => crossingDirection(gateA, gateB, { e: 0, n: 1 }, { e: 1, n: 1 })).toThrow(
      RangeError,
    );
  });
});

describe('interpolateCrossingTime', () => {
  it('interpolates endpoints and an interior timestamp linearly', () => {
    expect(interpolateCrossingTime(1_000, 2_000, 0)).toBe(1_000);
    expect(interpolateCrossingTime(1_000, 2_000, 0.25)).toBe(1_250);
    expect(interpolateCrossingTime(1_000, 2_000, 1)).toBe(2_000);
  });

  it('rejects reversed time, out-of-range parameters, and non-finite values', () => {
    expect(() => interpolateCrossingTime(2, 1, 0.5)).toThrow(RangeError);
    expect(() => interpolateCrossingTime(1, 2, -0.1)).toThrow(RangeError);
    expect(() => interpolateCrossingTime(1, 2, Number.NaN)).toThrow(RangeError);
  });

  it('is strictly inside the timestamp interval for every t in (0, 1)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({
          min: 1e-9,
          max: 1 - 1e-9,
          minExcluded: false,
          maxExcluded: false,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        (start, duration, t) => {
          const end = start + duration;
          const result = interpolateCrossingTime(start, end, t);
          expect(result).toBeGreaterThan(start);
          expect(result).toBeLessThan(end);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
