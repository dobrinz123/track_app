import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LocalPoint } from '../../src/contracts';
import {
  polylineCumulative,
  polylineLength,
  projectOntoPolyline,
  unwrapProgress,
} from '../../src/geometry';

const square: LocalPoint[] = [
  { e: 0, n: 0 },
  { e: 10, n: 0 },
  { e: 10, n: 10 },
  { e: 0, n: 10 },
];

describe('polyline distances', () => {
  it('computes per-vertex cumulative distances and includes the closing segment in length', () => {
    expect(polylineCumulative(square)).toEqual([0, 10, 20, 30]);
    expect(polylineLength(square)).toBe(40);
  });

  it('handles empty, single-point, and duplicate-vertex lines explicitly', () => {
    expect(polylineCumulative([])).toEqual([]);
    expect(polylineLength([])).toBe(0);
    expect(polylineCumulative([{ e: 2, n: 3 }])).toEqual([0]);
    expect(polylineLength([{ e: 2, n: 3 }])).toBe(0);
    expect(
      polylineCumulative([
        { e: 0, n: 0 },
        { e: 0, n: 0 },
        { e: 3, n: 4 },
      ]),
    ).toEqual([0, 0, 5]);
  });

  it('rejects non-finite vertices instead of returning non-finite distances', () => {
    expect(() => polylineCumulative([{ e: Number.NaN, n: 0 }])).toThrow(RangeError);
  });
});

describe('projectOntoPolyline', () => {
  it('returns along-line distance, positive-left lateral, segment, and closest point', () => {
    const line = [
      { e: 0, n: 0 },
      { e: 10, n: 0 },
      { e: 20, n: 0 },
    ];
    const cumulative = polylineCumulative(line);

    expect(projectOntoPolyline({ e: 4, n: 3 }, line, cumulative, false)).toEqual({
      distanceM: 4,
      lateralM: 3,
      segmentIndex: 0,
      point: { e: 4, n: 0 },
    });
    expect(projectOntoPolyline({ e: 14, n: -2 }, line, cumulative, false).lateralM).toBe(-2);
  });

  it('projects onto the implicit closing segment with wrapped distance', () => {
    const result = projectOntoPolyline(
      { e: -2, n: 5 },
      square,
      polylineCumulative(square),
      true,
    );

    expect(result.segmentIndex).toBe(3);
    expect(result.distanceM).toBe(35);
    expect(result.lateralM).toBe(-2);
    expect(result.point).toEqual({ e: 0, n: 5 });
  });

  it('ignores duplicate vertices and deterministically uses the first closest usable segment', () => {
    const line = [
      { e: 0, n: 0 },
      { e: 0, n: 0 },
      { e: 10, n: 0 },
    ];
    const result = projectOntoPolyline(
      { e: 5, n: 1 },
      line,
      polylineCumulative(line),
      false,
    );
    expect(result.segmentIndex).toBe(1);
    expect(result.distanceM).toBe(5);
  });

  it('limits an open-line search to the hinted interval', () => {
    const line = [
      { e: 0, n: 0 },
      { e: 10, n: 0 },
      { e: 10, n: 10 },
    ];
    const result = projectOntoPolyline(
      { e: 9, n: 8 },
      line,
      polylineCumulative(line),
      false,
      { distanceM: 2, windowM: 1 },
    );
    expect(result.segmentIndex).toBe(0);
  });

  it('wraps a closed-loop hint window across start/finish', () => {
    const result = projectOntoPolyline(
      { e: -1, n: 1 },
      square,
      polylineCumulative(square),
      true,
      { distanceM: 1, windowM: 3 },
    );
    expect(result.segmentIndex).toBe(3);
    expect(result.distanceM).toBe(39);
  });

  it('rejects malformed geometry, cumulative data, and hints', () => {
    expect(() => projectOntoPolyline({ e: 0, n: 0 }, [], [], false)).toThrow(RangeError);
    expect(() =>
      projectOntoPolyline(
        { e: 0, n: 0 },
        [
          { e: 1, n: 1 },
          { e: 1, n: 1 },
        ],
        [0, 0],
        false,
      ),
    ).toThrow(RangeError);
    expect(() => projectOntoPolyline({ e: 0, n: 0 }, square, [0], true)).toThrow(RangeError);
    expect(() => projectOntoPolyline({ e: 0, n: 0 }, square, [0, 9, 20, 30], true)).toThrow(
      RangeError,
    );
    expect(() =>
      projectOntoPolyline({ e: 0, n: 0 }, square, polylineCumulative(square), true, {
        distanceM: 0,
        windowM: -1,
      }),
    ).toThrow(RangeError);
  });

  it('matches full brute-force search when the hint contains the true nearest segment', () => {
    const loop = Array.from({ length: 32 }, (_, index) => {
      const angle = (index / 32) * Math.PI * 2;
      return { e: Math.cos(angle) * 100, n: Math.sin(angle) * 100 };
    });
    const cumulative = polylineCumulative(loop);

    fc.assert(
      fc.property(
        fc.record({
          e: fc.double({ min: -150, max: 150, noNaN: true, noDefaultInfinity: true }),
          n: fc.double({ min: -150, max: 150, noNaN: true, noDefaultInfinity: true }),
        }),
        fc.double({ min: 0, max: 30, noNaN: true, noDefaultInfinity: true }),
        (point, windowM) => {
          const full = projectOntoPolyline(point, loop, cumulative, true);
          const hinted = projectOntoPolyline(point, loop, cumulative, true, {
            distanceM: full.distanceM,
            windowM,
          });
          expect(hinted.segmentIndex).toBe(full.segmentIndex);
          expect(hinted.distanceM).toBeCloseTo(full.distanceM, 10);
          expect(hinted.lateralM).toBeCloseTo(full.lateralM, 10);
          expect(hinted.point.e).toBeCloseTo(full.point.e, 10);
          expect(hinted.point.n).toBeCloseTo(full.point.n, 10);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe('unwrapProgress', () => {
  it('lifts forward and reverse start/finish crossings to the nearest lap', () => {
    expect(unwrapProgress(95, 5, 100)).toBe(105);
    expect(unwrapProgress(105, 95, 100)).toBe(95);
    expect(unwrapProgress(295, 5, 100)).toBe(305);
  });

  it('rejects non-finite values and non-positive loop lengths', () => {
    expect(() => unwrapProgress(Number.NaN, 0, 100)).toThrow(RangeError);
    expect(() => unwrapProgress(0, 0, 0)).toThrow(RangeError);
  });

  it('always chooses an equivalent value within half a lap of previous progress', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (total, previous, next) => {
          const result = unwrapProgress(previous, next, total);
          expect(Math.abs(result - previous)).toBeLessThanOrEqual(total / 2 + 1e-9);
          expect(((result - next) / total) % 1).toBeCloseTo(0, 10);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('is monotone under forward steps shorter than half a lap', () => {
    const scenario = fc.integer({ min: 3, max: 100_000 }).chain((total) =>
      fc.record({
        total: fc.constant(total),
        turn: fc.integer({ min: -100, max: 100 }),
        distance: fc.integer({ min: 0, max: total - 1 }),
        step: fc.integer({ min: 0, max: Math.floor((total - 1) / 2) }),
      }),
    );

    fc.assert(
      fc.property(scenario, ({ total, turn, distance, step }) => {
        const previous = turn * total + distance;
        const nextWrapped = (distance + step) % total;
        const result = unwrapProgress(previous, nextWrapped, total);
        expect(result).toBe(previous + step);
        expect(result).toBeGreaterThanOrEqual(previous);
      }),
      { numRuns: 2_000 },
    );
  });
});
