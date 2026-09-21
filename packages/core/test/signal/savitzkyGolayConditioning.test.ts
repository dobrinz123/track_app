import { describe, expect, it } from 'vitest';

import {
  MAX_SAVITZKY_GOLAY_POLY_ORDER,
  savitzkyGolay,
  savitzkyGolayCoefficients,
} from '../../src/signal/savitzky-golay';

/**
 * Ticket P6a-FIX1 M4 — the solver must never silently return wrong numbers.
 *
 * An independent review measured that smoothing 25 constant samples with
 * `{windowLength: 25, polyOrder: 20}` returned 0.9737744 at both endpoints
 * instead of 1: the unscaled Vandermonde normal equations are too
 * ill-conditioned at that order for this Gauss-Jordan solve, and partial
 * pivoting does not rescue a badly SCALED system. The fix is a measured
 * ceiling on `polyOrder` with a `RangeError` past it, rather than a
 * re-derivation in another basis -- see `MAX_SAVITZKY_GOLAY_POLY_ORDER`'s own
 * doc comment for the measurements and for why rejecting is preferred to
 * changing every currently-valid number.
 */

describe('P6a-FIX1 M4 -- ill-conditioned configurations are refused, not approximated', () => {
  it('the exact reviewer scenario (25/20) now throws instead of returning 0.9737744', () => {
    const ones = new Array<number>(25).fill(1);
    expect(() => savitzkyGolay(ones, { windowLength: 25, polyOrder: 20 })).toThrow(RangeError);
    expect(() => savitzkyGolay(ones, { windowLength: 25, polyOrder: 20 })).toThrow(/polyOrder must be at most 7/);
    // The coefficient entry point refuses it on exactly the same terms.
    expect(() => savitzkyGolayCoefficients({ windowLength: 25, polyOrder: 20 })).toThrow(RangeError);
  });

  it('the boundary: order 7 is accepted, order 8 is refused', () => {
    expect(MAX_SAVITZKY_GOLAY_POLY_ORDER).toBe(7);
    const values = Array.from({ length: 30 }, (_, index) => index * 0.5 - 3);
    expect(() =>
      savitzkyGolay(values, { windowLength: 15, polyOrder: MAX_SAVITZKY_GOLAY_POLY_ORDER }),
    ).not.toThrow();
    expect(() =>
      savitzkyGolay(values, { windowLength: 15, polyOrder: MAX_SAVITZKY_GOLAY_POLY_ORDER + 1 }),
    ).toThrow(RangeError);
  });

  it('everything inside the bound reproduces its own polynomials to better than 1e-9', () => {
    // This is the property the bound was MEASURED against: a fit of degree p
    // must return any polynomial of degree <= p unchanged. Checked over every
    // odd window this library would plausibly be asked for.
    for (let windowLength = 3; windowLength <= 31; windowLength += 2) {
      for (
        let polyOrder = 0;
        polyOrder <= Math.min(MAX_SAVITZKY_GOLAY_POLY_ORDER, windowLength - 1);
        polyOrder += 1
      ) {
        const half = (windowLength - 1) / 2;
        for (let degree = 0; degree <= polyOrder; degree += 1) {
          const values = Array.from(
            { length: windowLength + 6 },
            (_, index) => ((index - half) / half) ** degree,
          );
          const filtered = savitzkyGolay(values, { windowLength, polyOrder });
          for (let index = 0; index < values.length; index += 1) {
            expect(Math.abs(filtered[index]! - values[index]!)).toBeLessThan(1e-9);
          }
        }
        // ... and the smoothing weights sum to 1 at every edge offset too.
        for (let offset = -half; offset <= half; offset += 1) {
          const weights = savitzkyGolayCoefficients({ windowLength, polyOrder }, offset);
          const sum = weights.reduce((total, weight) => total + weight, 0);
          expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('the shipped configuration (9/2) is unaffected by the new gate', () => {
    const values = Array.from({ length: 40 }, (_, index) => Math.sin(index / 4));
    const filtered = savitzkyGolay(values, { windowLength: 9, polyOrder: 2 });
    expect(filtered).toHaveLength(values.length);
    for (const value of filtered) expect(Number.isFinite(value)).toBe(true);
    // Exact on a constant, to the tolerance the bound is defined by.
    const ones = new Array<number>(20).fill(1);
    for (const value of savitzkyGolay(ones, { windowLength: 9, polyOrder: 2 })) {
      expect(Math.abs(value - 1)).toBeLessThan(1e-9);
    }
  });

  it('the existing validation errors still fire, and in their original order', () => {
    const values = new Array<number>(30).fill(0);
    // polyOrder >= windowLength is still reported as such, not as the new bound.
    expect(() => savitzkyGolay(values, { windowLength: 5, polyOrder: 5 })).toThrow(/smaller than/);
    expect(() => savitzkyGolay(values, { windowLength: 6, polyOrder: 2 })).toThrow(/odd/);
    expect(() => savitzkyGolay(values, { windowLength: 2, polyOrder: 1 })).toThrow(/at least 3/);
  });
});
