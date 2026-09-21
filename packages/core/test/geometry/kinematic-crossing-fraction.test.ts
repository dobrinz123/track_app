import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  interpolateCrossingTime,
  kinematicCrossingFraction,
} from '../../src/geometry/intersection';

/**
 * Ticket P8.1. Two things matter here and nothing else does: that the constant
 * acceleration model is the RIGHT one (checked against an independent
 * numerical integration of the same physics, not against itself), and that
 * every path out of it lands back on today's linear behaviour bit for bit.
 */

/**
 * Independent reference: integrate `v(tau) = v0 + a*tau` forward in tiny steps
 * and report the time fraction at which the travelled distance first reaches
 * `t` of the total. Deliberately written as a dumb Riemann sum so it shares no
 * algebra with the closed form under test.
 */
function integratedTimeFraction(t: number, v0: number, v1: number, steps = 4_000_000): number {
  const dt = 1;
  const a = v1 - v0;
  const total = ((v0 + v1) / 2) * dt;
  const target = t * total;
  const h = dt / steps;
  let travelled = 0;
  for (let i = 0; i < steps; i += 1) {
    const tau = i * h;
    const step = (v0 + a * (tau + h / 2)) * h;
    if (travelled + step >= target) return (tau + ((target - travelled) / step) * h) / dt;
    travelled += step;
  }
  return 1;
}

describe('kinematicCrossingFraction', () => {
  it('matches an independent numerical integration of the same physics', () => {
    const cases: Array<[number, number, number]> = [
      [0.5, 50, 30],
      [0.25, 20, 60],
      [0.75, 55.6, 25],
      [0.1, 41.7, 41.7 - 9.81],
      [0.9, 22.2, 30],
    ];
    for (const [t, v0, v1] of cases) {
      expect(kinematicCrossingFraction(t, v0, v1)).toBeCloseTo(
        integratedTimeFraction(t, v0, v1),
        6,
      );
    }
  });

  it('moves the crossing EARLIER under braking and LATER under acceleration', () => {
    // Derived, not assumed from the word "braking": a decelerating car covers
    // the first half of the distance in less than half the time.
    expect(kinematicCrossingFraction(0.5, 50, 30)).toBeLessThan(0.5);
    expect(kinematicCrossingFraction(0.5, 30, 50)).toBeGreaterThan(0.5);
    // And the magnitude is the ~29 ms the ticket quotes: 1 g over a 1 s fix
    // interval at 150 km/h.
    const v0 = 150 / 3.6;
    const shift = Math.abs(kinematicCrossingFraction(0.5, v0, v0 - 9.81) - 0.5) * 1_000;
    expect(shift).toBeGreaterThan(20);
    expect(shift).toBeLessThan(35);
  });

  it('is exactly the identity for constant speed', () => {
    for (const t of [0.01, 0.25, 0.5, 0.731, 0.99]) {
      expect(kinematicCrossingFraction(t, 41.66, 41.66)).toBe(t);
    }
  });

  it('treats every absent or invalid speed as absent and returns t unchanged', () => {
    const t = 0.37;
    // iOS sends -1 when it has no Doppler solution; zero is a stopped car;
    // NaN/Infinity are corruption. None of them may perturb the result.
    for (const bad of [undefined, -1, 0, Number.NaN, Number.POSITIVE_INFINITY, -0.0001]) {
      expect(kinematicCrossingFraction(t, bad, 40)).toBe(t);
      expect(kinematicCrossingFraction(t, 40, bad)).toBe(t);
    }
  });

  it('passes endpoints and out-of-range parameters straight through', () => {
    expect(kinematicCrossingFraction(0, 50, 30)).toBe(0);
    expect(kinematicCrossingFraction(1, 50, 30)).toBe(1);
    expect(kinematicCrossingFraction(-0.2, 50, 30)).toBe(-0.2);
    expect(kinematicCrossingFraction(1.4, 50, 30)).toBe(1.4);
    expect(Number.isNaN(kinematicCrossingFraction(Number.NaN, 50, 30))).toBe(true);
  });

  it('stays strictly inside (0, 1) and monotonic in t for any positive speed pair', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 120, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.5, max: 120, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1e-9, max: 1 - 1e-9, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1e-9, max: 1 - 1e-9, noNaN: true, noDefaultInfinity: true }),
        (v0, v1, ta, tb) => {
          const lo = Math.min(ta, tb);
          const hi = Math.max(ta, tb);
          const fLo = kinematicCrossingFraction(lo, v0, v1);
          const fHi = kinematicCrossingFraction(hi, v0, v1);
          expect(fLo).toBeGreaterThan(0);
          expect(fLo).toBeLessThan(1);
          expect(fHi).toBeGreaterThan(0);
          expect(fHi).toBeLessThan(1);
          // Monotonicity holds mathematically but NOT bit-exactly: `lo` and
          // `hi` can differ by a single ULP, and the two evaluations then take
          // different rounding paths through the sqrt. Asserting exact
          // monotonicity made this property flaky -- it passed in isolation and
          // failed roughly one full-suite run in twenty, which is the worst
          // kind of test to own now that CI runs on every push.
          //
          // The bound is measured, not guessed: a direct 4,000,000-case search
          // (speeds 0.5-120 m/s, t in [1e-9, 1-1e-9], one third of the pairs
          // forced to within 1 ULP of each other) found ZERO violations of the
          // strict-interior property above, and a worst monotonicity regression
          // of 3.33e-16 -- about 1.5 ULP at that magnitude. Eight ULP leaves
          // more than a factor of five of headroom while still failing on any
          // real ordering bug, which would move the result by far more.
          const monotonicityToleranceUlp = 8 * Number.EPSILON * Math.max(fLo, 1);
          expect(fHi).toBeGreaterThanOrEqual(fLo - monotonicityToleranceUlp);
        },
      ),
      { numRuns: 3_000 },
    );
  });

  it('composed with interpolateCrossingTime it is bit-identical to today when speeds are absent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (start, duration, t) => {
          const end = start + duration;
          const today = interpolateCrossingTime(start, end, t);
          const withP8 = interpolateCrossingTime(
            start,
            end,
            kinematicCrossingFraction(t, undefined, undefined),
          );
          // Object.is, not toBeCloseTo: the fallback must be the same float.
          expect(Object.is(withP8, today)).toBe(true);
        },
      ),
      { numRuns: 3_000 },
    );
  });
});
