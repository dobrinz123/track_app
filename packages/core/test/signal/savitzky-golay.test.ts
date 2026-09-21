import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { savitzkyGolay, savitzkyGolayCoefficients } from '../../src/signal';

/** Sum of an array, used to assert the moment conditions on the weights. */
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('savitzkyGolayCoefficients', () => {
  it('reproduces the textbook quadratic 5-point smoothing weights', () => {
    // Savitzky & Golay (1964): [-3, 12, 17, 12, -3] / 35.
    const coefficients = savitzkyGolayCoefficients({ windowLength: 5, polyOrder: 2 });
    const expected = [-3 / 35, 12 / 35, 17 / 35, 12 / 35, -3 / 35];
    coefficients.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 12);
    });
  });

  it('reproduces the textbook quadratic 7-point smoothing weights', () => {
    // [-2, 3, 6, 7, 6, 3, -2] / 21.
    const coefficients = savitzkyGolayCoefficients({ windowLength: 7, polyOrder: 2 });
    const expected = [-2 / 21, 3 / 21, 6 / 21, 7 / 21, 6 / 21, 3 / 21, -2 / 21];
    coefficients.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 12);
    });
  });

  it('collapses to a moving average when polyOrder is zero', () => {
    const coefficients = savitzkyGolayCoefficients({ windowLength: 5, polyOrder: 0 });
    coefficients.forEach((value) => expect(value).toBeCloseTo(1 / 5, 12));
  });

  it('satisfies the moment conditions: smoothing weights sum to one, derivative weights to zero', () => {
    expect(sum(savitzkyGolayCoefficients({ windowLength: 9, polyOrder: 3 }))).toBeCloseTo(1, 12);
    expect(
      sum(savitzkyGolayCoefficients({ windowLength: 9, polyOrder: 3, derivative: 1 })),
    ).toBeCloseTo(0, 12);
    expect(
      sum(savitzkyGolayCoefficients({ windowLength: 9, polyOrder: 3, derivative: 2 })),
    ).toBeCloseTo(0, 12);
  });

  it('produces symmetric smoothing weights and antisymmetric first-derivative weights', () => {
    const smoothing = savitzkyGolayCoefficients({ windowLength: 11, polyOrder: 4 });
    const derivative = savitzkyGolayCoefficients({ windowLength: 11, polyOrder: 4, derivative: 1 });
    for (let index = 0; index < 11; index += 1) {
      const mirrored = 10 - index;
      expect(smoothing[index] ?? Number.NaN).toBeCloseTo(smoothing[mirrored] ?? Number.NaN, 12);
      expect(derivative[index] ?? Number.NaN).toBeCloseTo(-(derivative[mirrored] ?? Number.NaN), 12);
    }
  });

  it('scales derivative weights by the sample spacing', () => {
    const unit = savitzkyGolayCoefficients({ windowLength: 5, polyOrder: 2, derivative: 1 });
    const halved = savitzkyGolayCoefficients({
      windowLength: 5,
      polyOrder: 2,
      derivative: 1,
      spacing: 0.5,
    });
    halved.forEach((value, index) => {
      expect(value).toBeCloseTo((unit[index] ?? Number.NaN) * 2, 12);
    });
  });
});

describe('savitzkyGolay', () => {
  it('reproduces a polynomial of equal or lower order exactly, edges included', () => {
    // A cubic is in the fit space of a cubic filter, so smoothing must be a
    // no-op everywhere -- this is the property that distinguishes SG from a
    // moving average, which would bow the curve at every point.
    const quadratic = (x: number): number => 2 * x * x - 3 * x + 7;
    const values = Array.from({ length: 25 }, (_, index) => quadratic(index));
    const filtered = savitzkyGolay(values, { windowLength: 9, polyOrder: 3 });
    filtered.forEach((value, index) => {
      expect(value).toBeCloseTo(quadratic(index), 6);
    });
  });

  it('differentiates a known polynomial, honouring spacing', () => {
    const spacing = 0.25;
    const position = (x: number): number => 3 * x * x + 5 * x - 1;
    const values = Array.from({ length: 21 }, (_, index) => position(index * spacing));
    const derivative = savitzkyGolay(values, {
      windowLength: 7,
      polyOrder: 2,
      derivative: 1,
      spacing,
    });
    derivative.forEach((value, index) => {
      expect(value).toBeCloseTo(6 * (index * spacing) + 5, 6);
    });
  });

  it('preserves the height of a peak that a moving average would flatten', () => {
    // Gaussian-shaped braking spike sampled at 20 points either side.
    const peakIndex = 20;
    const values = Array.from({ length: 41 }, (_, index) =>
      Math.exp(-((index - peakIndex) ** 2) / 18),
    );
    const filtered = savitzkyGolay(values, { windowLength: 9, polyOrder: 3 });
    const movingAverage = savitzkyGolay(values, { windowLength: 9, polyOrder: 0 });

    const filteredPeak = filtered[peakIndex] ?? Number.NaN;
    const averagedPeak = movingAverage[peakIndex] ?? Number.NaN;

    // Both filters use the same 9-sample window, so the only difference is the
    // fit order: the cubic tracks the curvature of the peak, the box filter
    // (polyOrder 0) averages it away and loses a quarter of the amplitude.
    expect(filteredPeak).toBeGreaterThan(0.95);
    expect(averagedPeak).toBeLessThan(0.75);
    expect(1 - filteredPeak).toBeLessThan((1 - averagedPeak) / 5);
  });

  it('attenuates alternating noise superimposed on a smooth ramp', () => {
    const clean = Array.from({ length: 60 }, (_, index) => index * 0.5);
    const noisy = clean.map((value, index) => value + (index % 2 === 0 ? 0.4 : -0.4));
    const filtered = savitzkyGolay(noisy, { windowLength: 11, polyOrder: 2 });

    const errorBefore = sum(noisy.map((value, index) => Math.abs(value - (clean[index] ?? 0))));
    const errorAfter = sum(filtered.map((value, index) => Math.abs(value - (clean[index] ?? 0))));
    expect(errorAfter).toBeLessThan(errorBefore / 3);
  });

  it('returns a series of the same length and leaves the interior identical across edge modes', () => {
    const values = Array.from({ length: 30 }, (_, index) => Math.sin(index / 3) * 4 + index);
    const interpolated = savitzkyGolay(values, { windowLength: 7, polyOrder: 2 });
    const nearest = savitzkyGolay(values, {
      windowLength: 7,
      polyOrder: 2,
      edgeMode: 'nearest',
    });

    expect(interpolated).toHaveLength(values.length);
    expect(nearest).toHaveLength(values.length);
    for (let index = 3; index <= values.length - 4; index += 1) {
      expect(interpolated[index] ?? Number.NaN).toBeCloseTo(nearest[index] ?? Number.NaN, 12);
    }
    // The edges are where the modes must differ on a sloped signal.
    expect(interpolated[0] ?? Number.NaN).not.toBeCloseTo(nearest[0] ?? Number.NaN, 6);
  });

  it('handles a series exactly one window long', () => {
    const values = [1, 4, 9, 16, 25];
    const filtered = savitzkyGolay(values, { windowLength: 5, polyOrder: 2 });
    filtered.forEach((value, index) => {
      expect(value).toBeCloseTo(values[index] ?? Number.NaN, 8);
    });
  });

  it('rejects malformed options and inputs', () => {
    const values = Array.from({ length: 20 }, (_, index) => index);
    expect(() => savitzkyGolay(values, { windowLength: 6, polyOrder: 2 })).toThrow(/odd/);
    expect(() => savitzkyGolay(values, { windowLength: 2, polyOrder: 1 })).toThrow(/at least 3/);
    expect(() => savitzkyGolay(values, { windowLength: 5, polyOrder: 5 })).toThrow(/smaller than/);
    expect(() =>
      savitzkyGolay(values, { windowLength: 5, polyOrder: 2, derivative: 3 }),
    ).toThrow(/must not exceed polyOrder/);
    expect(() =>
      savitzkyGolay(values, { windowLength: 5, polyOrder: 2, spacing: 0 }),
    ).toThrow(/spacing/);
    expect(() => savitzkyGolay([1, 2, 3], { windowLength: 5, polyOrder: 2 })).toThrow(
      /at least windowLength/,
    );
    expect(() =>
      savitzkyGolay([1, 2, Number.NaN, 4, 5, 6, 7], { windowLength: 5, polyOrder: 2 }),
    ).toThrow(/values\[2\]/);
    expect(() =>
      savitzkyGolay([1, 2, Number.POSITIVE_INFINITY, 4, 5, 6, 7], {
        windowLength: 5,
        polyOrder: 2,
      }),
    ).toThrow(/values\[2\]/);
  });

  it('is exact on affine input for any admissible window and order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 4 }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        (halfWindow, polyOrder, slope, intercept) => {
          const windowLength = halfWindow * 2 + 1;
          fc.pre(polyOrder < windowLength);
          const values = Array.from(
            { length: windowLength + 8 },
            (_, index) => slope * index + intercept,
          );
          const filtered = savitzkyGolay(values, { windowLength, polyOrder });
          filtered.forEach((value, index) => {
            expect(value).toBeCloseTo(slope * index + intercept, 6);
          });
        },
      ),
      { numRuns: 60 },
    );
  });

  it('never returns a non-finite value for finite input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), {
          minLength: 11,
          maxLength: 80,
        }),
        (values) => {
          const filtered = savitzkyGolay(values, { windowLength: 11, polyOrder: 3 });
          expect(filtered).toHaveLength(values.length);
          filtered.forEach((value) => expect(Number.isFinite(value)).toBe(true));
        },
      ),
      { numRuns: 60 },
    );
  });
});
