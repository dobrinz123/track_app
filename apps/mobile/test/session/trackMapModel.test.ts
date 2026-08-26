import { describe, expect, it } from 'vitest';
import type { LocalPoint } from '@circuit/core';
import {
  buildOutlineSegments,
  computeBounds,
  decimateCenterline,
  densifyToSpacing,
  fitCenterline,
  fitCenterlineAutoRotated,
  pointAtLapFraction,
  segmentAngleDeg,
} from '../../src/session/trackMapModel';

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
    // centered (letterboxed) vertically. marginFrac=0 reproduces the original
    // edge-to-edge fit exactly (P1 fix: pinned tests updated to pass it explicitly).
    const points: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 200, n: 100 },
    ];
    const fit = fitCenterline(points, 1, 0); // square container (aspect = width/height = 1)

    // scale = min(1/200, 1/100) = 1/200 -> usedWidthUnits=1 (fills width),
    // usedHeightUnits=100/200=0.5 -> padYUnits=(1-0.5)/2=0.25.
    expect(fit.project({ e: 0, n: 0 })).toEqual({ xFrac: 0, yFrac: 0.75 }); // bottom-left of the box: y measured from the bottom, flipped to screen-down
    expect(fit.project({ e: 200, n: 100 })).toEqual({ xFrac: 1, yFrac: 0.25 }); // top-right of the box
    expect(fit.project({ e: 100, n: 50 })).toEqual({ xFrac: 0.5, yFrac: 0.5 }); // box center maps to container center on both axes
    expect(fit.contentAspect).toBeCloseTo(2, 5); // 200/100
  });

  it('preserves aspect for a container wider than the bounding box (taller-than-container box)', () => {
    // A 50m (E) x 100m (N) box in a 2:1 (wide) container -- height is now the binding
    // constraint: the box fills the container's full height and is centered
    // horizontally. marginFrac=0 reproduces the original edge-to-edge fit exactly.
    const points: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 50, n: 100 },
    ];
    const fit = fitCenterline(points, 2, 0);

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
    const fit = fitCenterline(points, 1, 0);
    const south = fit.project({ e: 5, n: 0 });
    const north = fit.project({ e: 5, n: 10 });
    expect(north.yFrac).toBeLessThan(south.yFrac);
  });

  it('P1 fix: with the default marginFrac, every projected fraction stays within [marginFrac - epsilon, 1 - marginFrac + epsilon] on both axes', () => {
    const marginFrac = 0.06;
    const epsilon = 1e-9;
    const points: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 200, n: 100 },
    ];
    // A wider-than-container box (binds on width) and a container-matching-ish
    // aspect are both covered by testing several containerAspect values against
    // the same box's corners and center.
    for (const containerAspect of [0.5, 1, 2]) {
      const fit = fitCenterline(points, containerAspect, marginFrac);
      for (const point of [
        { e: 0, n: 0 },
        { e: 200, n: 100 },
        { e: 100, n: 50 },
        { e: 0, n: 100 },
        { e: 200, n: 0 },
      ]) {
        const { xFrac, yFrac } = fit.project(point);
        expect(xFrac).toBeGreaterThanOrEqual(marginFrac - epsilon);
        expect(xFrac).toBeLessThanOrEqual(1 - marginFrac + epsilon);
        expect(yFrac).toBeGreaterThanOrEqual(marginFrac - epsilon);
        expect(yFrac).toBeLessThanOrEqual(1 - marginFrac + epsilon);
      }
    }
  });

  it('contentAspect is the input frame\'s own span ratio, independent of containerAspect and marginFrac', () => {
    const points: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 50, n: 100 },
    ];
    expect(fitCenterline(points, 2, 0).contentAspect).toBeCloseTo(0.5, 5); // 50/100
    expect(fitCenterline(points, 1, 0.06).contentAspect).toBeCloseTo(0.5, 5);
  });
});

describe('fitCenterlineAutoRotated (F1 auto-rotate to fit)', () => {
  it('rotates a portrait track (TMR-shaped: 704m E-W x 1538m N-S) before fitting, filling most of a landscape container\'s width', () => {
    const points: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 704, n: 1538 },
    ];
    const containerAspect = 1 / 0.55; // TRACK_MAP_ASPECT_RATIO -- a wide/landscape container
    const fit = fitCenterlineAutoRotated(points, containerAspect);
    expect(fit.rotated).toBe(true);

    const a = fit.project(points[0] as LocalPoint);
    const b = fit.project(points[1] as LocalPoint);
    const widthFrac = Math.abs(b.xFrac - a.xFrac);
    expect(widthFrac).toBeGreaterThanOrEqual(0.8);
  });

  it('does not rotate a landscape track, matching plain fitCenterline exactly', () => {
    const points: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 1538, n: 704 },
    ];
    const containerAspect = 1 / 0.55;
    const fit = fitCenterlineAutoRotated(points, containerAspect);
    expect(fit.rotated).toBe(false);

    const plain = fitCenterline(points, containerAspect);
    expect(fit.project({ e: 500, n: 300 })).toEqual(plain.project({ e: 500, n: 300 }));
  });

  it('does not rotate a square (equal-span) track -- only a strictly portrait one', () => {
    const points: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 100, n: 100 },
    ];
    expect(fitCenterlineAutoRotated(points, 1).rotated).toBe(false);
  });

  it('contentAspect reflects the POST-rotation frame for a portrait track', () => {
    const points: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 704, n: 1538 },
    ];
    const fit = fitCenterlineAutoRotated(points, 1 / 0.55);
    expect(fit.rotated).toBe(true);
    // Rotated frame: spanE' = old spanN = 1538, spanN' = old spanE = 704.
    expect(fit.contentAspect).toBeCloseTo(1538 / 704, 5);
  });
});

describe('buildOutlineSegments (F2 connected outline + P2 joint dots)', () => {
  it('builds 4 right-angled, correctly-lengthed segments for a known square, plus one joint per vertex', () => {
    const square = [
      { xFrac: 0, yFrac: 0 },
      { xFrac: 1, yFrac: 0 },
      { xFrac: 1, yFrac: 1 },
      { xFrac: 0, yFrac: 1 },
      { xFrac: 0, yFrac: 0 },
    ];
    const { segments, joints } = buildOutlineSegments(square, 100, 100);
    // 4 sides + the loop-closing segment (degenerate here: last point already
    // repeats the first, so the closer has ~0 length).
    expect(segments).toHaveLength(5);
    for (const segment of segments.slice(0, 4)) expect(segment.lengthPx).toBeCloseTo(100, 5);
    expect(segments[4]!.lengthPx).toBeCloseTo(0, 5);

    const angles = segments.map((segment) => segment.angleDeg);
    expect(angles[0]).toBeCloseTo(0, 5); // right
    expect(angles[1]).toBeCloseTo(90, 5); // down (screen y grows downward)
    expect(angles[2]).toBeCloseTo(180, 5); // left
    expect(angles[3]).toBeCloseTo(-90, 5); // up

    // One joint per vertex, in container pixels, matching each segment's own start.
    expect(joints).toHaveLength(5);
    expect(joints[0]).toEqual({ x: 0, y: 0 });
    expect(joints[1]).toEqual({ x: 100, y: 0 });
    expect(joints[2]).toEqual({ x: 100, y: 100 });
    expect(joints[3]).toEqual({ x: 0, y: 100 });
  });

  it('returns no segments or joints for fewer than 3 points', () => {
    expect(buildOutlineSegments([{ xFrac: 0, yFrac: 0 }], 100, 100)).toEqual({ segments: [], joints: [] });
    expect(buildOutlineSegments([], 100, 100)).toEqual({ segments: [], joints: [] });
  });

  it('closes an OPEN loop with a real closing segment (the user-reported missing last piece)', () => {
    const openSquare = [
      { xFrac: 0, yFrac: 0 },
      { xFrac: 1, yFrac: 0 },
      { xFrac: 1, yFrac: 1 },
      { xFrac: 0, yFrac: 1 },
    ];
    const { segments } = buildOutlineSegments(openSquare, 100, 100);
    expect(segments).toHaveLength(4);
    expect(segments[3]!.lengthPx).toBeCloseTo(100, 5); // (0,1) back to (0,0)
    expect(segments[3]!.angleDeg).toBeCloseTo(-90, 5);
  });
});

describe('segmentAngleDeg', () => {
  it('measures screen-space direction between two container fractions', () => {
    const rightward = segmentAngleDeg({ xFrac: 0, yFrac: 0.5 }, { xFrac: 1, yFrac: 0.5 }, 100, 100);
    expect(rightward).toBeCloseTo(0, 5);
    const downward = segmentAngleDeg({ xFrac: 0.5, yFrac: 0 }, { xFrac: 0.5, yFrac: 1 }, 100, 100);
    expect(downward).toBeCloseTo(90, 5);
  });
});

function pathLength(points: readonly LocalPoint[]): number {
  let sum = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1] as LocalPoint;
    const b = points[index] as LocalPoint;
    sum += Math.hypot(b.e - a.e, b.n - a.n);
  }
  return sum;
}

describe('densifyToSpacing (F3 densify to target spacing)', () => {
  it('subdivides every segment so no gap exceeds the target spacing (max segment length <= target within tolerance)', () => {
    const centerline = square(400, 4); // 16 points, 100m sides -- far coarser than the 12m target
    const densified = densifyToSpacing(centerline, 12);
    expect(densified.length).toBeGreaterThan(centerline.length);
    for (let index = 1; index < densified.length; index += 1) {
      const a = densified[index - 1] as LocalPoint;
      const b = densified[index] as LocalPoint;
      expect(Math.hypot(b.e - a.e, b.n - a.n)).toBeLessThanOrEqual(12 + 1e-9);
    }
  });

  it('preserves total path length within 0.1%', () => {
    const centerline = square(400, 4);
    const before = pathLength(centerline);
    const densified = densifyToSpacing(centerline, 12);
    const after = pathLength(densified);
    expect(Math.abs(after - before) / before).toBeLessThan(0.001);
  });

  it('is a no-op (copied) once every existing segment is already within the target spacing', () => {
    const centerline = square(400, 100); // 4m per step -- well under the 12m target
    const densified = densifyToSpacing(centerline, 12);
    expect(densified).toEqual(centerline);
    expect(densified).not.toBe(centerline);
  });

  it('handles an empty and a single-point centerline', () => {
    expect(densifyToSpacing([], 12)).toEqual([]);
    expect(densifyToSpacing([{ e: 1, n: 2 }], 12)).toEqual([{ e: 1, n: 2 }]);
  });
});

describe('pointAtLapFraction (F5 direction chevron)', () => {
  it('returns undefined for a centerline with fewer than 2 points', () => {
    expect(pointAtLapFraction([], 0.1)).toBeUndefined();
    expect(pointAtLapFraction([{ e: 0, n: 0 }], 0.1)).toBeUndefined();
  });

  it("locates the point at 10% of a straight line's total length, with a forward-pointing ahead point", () => {
    const centerline: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 1000, n: 0 },
    ];
    const lap = pointAtLapFraction(centerline, 0.1);
    if (lap === undefined) throw new Error('expected pointAtLapFraction to return a result');
    expect(lap.point.e).toBeCloseTo(100, 5);
    expect(lap.point.n).toBeCloseTo(0, 5);
    expect(lap.aheadPoint.e).toBeGreaterThan(lap.point.e);
  });
});

describe('F4 live marker mapping (pure viewmodel fn reacts to state changes)', () => {
  it('maps two successive calibration states with different rawLocalX to different container fractions', () => {
    const centerline: LocalPoint[] = [
      { e: 0, n: 0 },
      { e: 100, n: 0 },
      { e: 100, n: 50 },
      { e: 0, n: 50 },
    ];
    const fit = fitCenterlineAutoRotated(centerline, 1 / 0.55);

    // Two successive `FacadeState.calibration` snapshots, as `ActiveCalibrationScreen`
    // would read them -- only `rawLocalX` differs between the two samples.
    const stateA = { rawLocalX: 10, rawLocalY: 10 };
    const stateB = { rawLocalX: 90, rawLocalY: 10 };

    const fractionA = fit.project({ e: stateA.rawLocalX, n: stateA.rawLocalY });
    const fractionB = fit.project({ e: stateB.rawLocalX, n: stateB.rawLocalY });

    expect(fractionA).not.toEqual(fractionB);
  });
});
