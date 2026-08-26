import { describe, expect, it } from 'vitest';
import type { LocalPoint } from '@circuit/core';
import { computeBounds, decimateCenterline, fitCenterline } from '../../src/session/trackMapModel';

function square(sideM: number, perSide: number): LocalPoint[] {
  // A simple closed-loop "track": a square, `perSide` points per side, CCW from the
  // origin.
  const points: LocalPoint[] = [];
  for (let step = 0; step < perSide; step += 1) points.push({ e: (sideM * step) / perSide, n: 0 });
  for (let step = 0; step < perSide; step += 1) points.push({ e: sideM, n: (sideM * step) / perSide });
  for (let step = 0; step < perSide; step += 1) points.push({ e: sideM - (sideM * step) / perSide, n: sideM });
  for (let step = 0; step < perSide; step += 1) points.push({ e: 0, n: sideM - (sideM * step) / perSide });
  return points;
}

describe('decimateCenterline', () => {
  it('returns exactly n points for a centerline longer than n', () => {
    const centerline = square(400, 100); // 400 points, over n=200
    const decimated = decimateCenterline(centerline, 200);
    expect(decimated).toHaveLength(200);
  });

  it('preserves the first and last vertex exactly', () => {
    const centerline = square(400, 100);
    const decimated = decimateCenterline(centerline, 200);
    expect(decimated[0]).toEqual(centerline[0]);
    expect(decimated[decimated.length - 1]).toEqual(centerline[centerline.length - 1]);
  });

  it('is deterministic -- repeated calls on the same input produce identical output', () => {
    const centerline = square(400, 100);
    const first = decimateCenterline(centerline, 200);
    const second = decimateCenterline(centerline, 200);
    expect(second).toEqual(first);
  });

  it('returns the centerline unchanged (copied) when it already has n or fewer points', () => {
    const centerline = square(40, 40); // 160 points, under n=200
    const decimated = decimateCenterline(centerline, 200);
    expect(decimated).toEqual(centerline);
    expect(decimated).not.toBe(centerline); // copied, not the same array reference
  });

  it('handles an empty centerline', () => {
    expect(decimateCenterline([], 200)).toEqual([]);
  });
});

describe('computeBounds', () => {
  it('computes the axis-aligned bounding box of a point set', () => {
    const points: LocalPoint[] = [
      { e: -5, n: 2 },
      { e: 10, n: -3 },
      { e: 0, n: 8 },
    ];
    expect(computeBounds(points)).toEqual({ minE: -5, maxE: 10, minN: -3, maxN: 8 });
  });
});

describe('fitCenterline', () => {
  it('maps a known centerline + known sample to the expected container coordinates, preserving aspect (wider-than-container box)', () => {
    // A 200m (E) x 100m (N) box -- box aspect (2.0) is WIDER than a 1:1 container, so
    // width is the binding constraint: the box fills the container's full width and is
    // centered (letterboxed) vertically.
    const points: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 200, n: 100 },
    ];
    const fit = fitCenterline(points, 1); // square container (aspect = width/height = 1)

    // scale = min(1/200, 1/100) = 1/200 -> usedWidthUnits=1 (fills width),
    // usedHeightUnits=100/200=0.5 -> padYUnits=(1-0.5)/2=0.25.
    expect(fit.project({ e: 0, n: 0 })).toEqual({ xFrac: 0, yFrac: 0.75 }); // bottom-left of the box: y measured from the bottom, flipped to screen-down
    expect(fit.project({ e: 200, n: 100 })).toEqual({ xFrac: 1, yFrac: 0.25 }); // top-right of the box
    expect(fit.project({ e: 100, n: 50 })).toEqual({ xFrac: 0.5, yFrac: 0.5 }); // box center maps to container center on both axes
  });

  it('preserves aspect for a container wider than the bounding box (taller-than-container box)', () => {
    // A 50m (E) x 100m (N) box in a 2:1 (wide) container -- height is now the binding
    // constraint: the box fills the container's full height and is centered
    // horizontally.
    const points: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 50, n: 100 },
    ];
    const fit = fitCenterline(points, 2);

    // scale = min(2/50, 1/100) = 1/100 -> usedHeightUnits=1 (fills height),
    // usedWidthUnits=50/100=0.5 -> padXUnits=(2-0.5)/2=0.75 -> xFrac pad = 0.75/2=0.375.
    expect(fit.project({ e: 0, n: 0 })).toEqual({ xFrac: 0.375, yFrac: 1 });
    expect(fit.project({ e: 50, n: 100 })).toEqual({ xFrac: 0.625, yFrac: 0 });
    expect(fit.project({ e: 25, n: 50 })).toEqual({ xFrac: 0.5, yFrac: 0.5 });
  });

  it('north is up: a larger n maps to a smaller yFrac than a smaller n at the same e', () => {
    const points: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 10, n: 10 },
    ];
    const fit = fitCenterline(points, 1);
    const south = fit.project({ e: 5, n: 0 });
    const north = fit.project({ e: 5, n: 10 });
    expect(north.yFrac).toBeLessThan(south.yFrac);
  });
});
