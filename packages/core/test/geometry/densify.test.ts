import { describe, expect, it } from 'vitest';

import type { LocalPoint } from '../../src/contracts';
import { densifyClosedCenterline } from '../../src/geometry';

function circlePoints(radiusM: number, count: number): LocalPoint[] {
  return Array.from({ length: count }, (_unused, index) => {
    const angle = (2 * Math.PI * index) / count;
    return { e: radiusM * Math.cos(angle), n: radiusM * Math.sin(angle) };
  });
}

/** A closed loop: one long dead-straight run, then a half-circle back. */
function stadium(straightM: number, radiusM: number, arcPoints: number): LocalPoint[] {
  const points: LocalPoint[] = [
    { e: 0, n: radiusM },
    { e: straightM, n: radiusM },
  ];
  for (let index = 1; index < arcPoints; index += 1) {
    const angle = Math.PI / 2 - (Math.PI * index) / arcPoints;
    points.push({ e: straightM + radiusM * Math.cos(angle), n: radiusM * Math.sin(angle) });
  }
  points.push({ e: straightM, n: -radiusM }, { e: 0, n: -radiusM });
  for (let index = 1; index < arcPoints; index += 1) {
    const angle = -Math.PI / 2 - (Math.PI * index) / arcPoints;
    points.push({ e: radiusM * Math.cos(angle), n: radiusM * Math.sin(angle) });
  }
  return points;
}

function lateralOffsetM(point: LocalPoint, a: LocalPoint, b: LocalPoint): number {
  const length = Math.hypot(b.e - a.e, b.n - a.n);
  return Math.abs((point.e - a.e) * (b.n - a.n) - (point.n - a.n) * (b.e - a.e)) / length;
}

describe('densifyClosedCenterline', () => {
  it('preserves every input vertex exactly, in order', () => {
    const input = circlePoints(200, 12);
    const result = densifyClosedCenterline(input, { maxSpacingM: 10 });
    expect(result.sourceVertexAt.length).toBe(input.length);
    for (let index = 0; index < input.length; index += 1) {
      const emitted = result.points[result.sourceVertexAt[index]!]!;
      expect(emitted.e).toBe(input[index]!.e);
      expect(emitted.n).toBe(input[index]!.n);
    }
    expect(result.sourceVertexAt[0]).toBe(0);
  });

  it('never emits a segment longer than maxSpacingM', () => {
    const input = stadium(400, 120, 6);
    const result = densifyClosedCenterline(input, { maxSpacingM: 15 });
    for (let index = 0; index < result.points.length; index += 1) {
      const a = result.points[index]!;
      const b = result.points[(index + 1) % result.points.length]!;
      expect(Math.hypot(b.e - a.e, b.n - a.n)).toBeLessThanOrEqual(15.0001);
    }
  });

  it('recovers a circle it was given as a coarse polygon', () => {
    const radiusM = 150;
    const input = circlePoints(radiusM, 10);
    const chordSagittaM =
      radiusM - Math.sqrt(radiusM ** 2 - (Math.hypot(
        input[1]!.e - input[0]!.e,
        input[1]!.n - input[0]!.n,
      ) / 2) ** 2);
    expect(chordSagittaM).toBeGreaterThan(7); // the error we are trying to remove

    const result = densifyClosedCenterline(input, { maxSpacingM: 12 });
    // Every emitted point should sit on the original circle, not inside it.
    let worstRadialErrorM = 0;
    for (const point of result.points) {
      worstRadialErrorM = Math.max(worstRadialErrorM, Math.abs(Math.hypot(point.e, point.n) - radiusM));
    }
    expect(worstRadialErrorM).toBeLessThan(0.05);
  });

  it('subdivides a straight without moving it off the chord', () => {
    // A stadium: a 400 m straight running tangentially between two semicircles.
    // Both three-point fits "see" a single long arc here -- the mapped points
    // genuinely cannot distinguish that from a straight -- so the long-lever-arm
    // guard is what keeps this straight straight.
    const input = stadium(400, 120, 8);
    const result = densifyClosedCenterline(input, { maxSpacingM: 20 });

    // Source segment 0 is the long straight from (0, 120) to (400, 120).
    const straight = result.segments[0]!;
    expect(straight.arcRadiusM).toBeNull();
    expect(straight.maxLateralShiftM).toBe(0);
    expect(straight.pieces).toBe(20);

    const start = result.sourceVertexAt[0]!;
    const end = result.sourceVertexAt[1]!;
    expect(end - start).toBe(20);
    for (let index = start + 1; index < end; index += 1) {
      // Exactly on the straight: identical n, strictly increasing e.
      expect(result.points[index]!.n).toBe(120);
      expect(result.points[index]!.e).toBeGreaterThan(result.points[index - 1]!.e);
    }
  });

  it('refuses to bow a straight that follows a sharp single-vertex kink', () => {
    // The MotorPark failure mode: a corner apex mapped as one sharp vertex, then
    // a long straight. circle(prev, A, B) reports a plausible corner radius that
    // the far side flatly contradicts, and honouring it would bend the straight.
    const input: LocalPoint[] = [
      { e: -40, n: 60 },
      { e: -20, n: 20 },
      { e: 0, n: 0 }, // the kink
      { e: 200, n: 0 }, // 200 m dead straight ...
      { e: 400, n: 0 }, // ... continuing, provably straight
      { e: 420, n: 40 },
      { e: 400, n: 120 },
      { e: 0, n: 120 },
    ];
    const result = densifyClosedCenterline(input, { maxSpacingM: 20 });

    const kinkToStraight = result.segments[2]!; // (0,0) -> (200,0)
    const straightRun = result.segments[3]!; // (200,0) -> (400,0)
    expect(kinkToStraight.arcRadiusM).toBeNull();
    expect(kinkToStraight.maxLateralShiftM).toBe(0);
    expect(straightRun.arcRadiusM).toBeNull();
    expect(straightRun.maxLateralShiftM).toBe(0);

    // Nothing emitted between (0,0) and (400,0) may leave n === 0.
    const from = result.sourceVertexAt[2]!;
    const to = result.sourceVertexAt[4]!;
    for (let index = from; index <= to; index += 1) {
      expect(result.points[index]!.n).toBe(0);
    }
  });

  it('does not bend across an inflection, where the two fits disagree on side', () => {
    // A true S-bend: two radius-100 arcs meeting tangentially at the origin,
    // one curving each way. The segment straddling the inflection has one fit
    // bulging left and the other right, so nothing is agreed and it stays a
    // straight chord -- densification must never smooth an S into a bow.
    const arcA = (t: number): LocalPoint => ({ e: 100 * Math.sin(t), n: -100 + 100 * Math.cos(t) });
    const arcB = (t: number): LocalPoint => ({ e: 100 * Math.sin(t), n: 100 - 100 * Math.cos(t) });
    const input: LocalPoint[] = [
      arcA(-1.2),
      arcA(-0.8),
      arcA(-0.4),
      arcB(0.4),
      arcB(0.8),
      arcB(1.2),
      // A wide return path, far enough away not to interact with the S.
      { e: 40, n: 300 },
      { e: -300, n: 300 },
      { e: -300, n: -120 },
    ];
    const result = densifyClosedCenterline(input, { maxSpacingM: 15 });
    // Segment 2 runs arcA(-0.4) -> arcB(0.4), straddling the inflection.
    const join = result.segments[2]!;
    expect(join.chordLengthM).toBeGreaterThan(70);
    expect(join.arcRadiusM).toBeNull();
    expect(join.maxLateralShiftM).toBe(0);
    // Its interior points must stay on the straight chord, not bow either way.
    const a = result.points[result.sourceVertexAt[2]!]!;
    const b = result.points[result.sourceVertexAt[3]!]!;
    for (let index = result.sourceVertexAt[2]! + 1; index < result.sourceVertexAt[3]!; index += 1) {
      expect(lateralOffsetM(result.points[index]!, a, b)).toBeLessThan(1e-9);
    }
    // The arcs on either side are still honoured.
    expect(result.segments[1]!.arcRadiusM).toBeGreaterThan(50);
    expect(result.segments[3]!.arcRadiusM).toBeGreaterThan(50);
  });

  it('bends only by the flatter of the two fits, never the tighter one', () => {
    // prev is close in, next is far out, so circle(prev,A,B) is much tighter
    // than circle(A,B,next). Only the flatter bend may be applied.
    const input: LocalPoint[] = [
      { e: -10, n: 14 },
      { e: 0, n: 0 },
      { e: 120, n: 0 },
      { e: 240, n: 14 },
      { e: 240, n: -90 },
      { e: 0, n: -90 },
    ];
    const result = densifyClosedCenterline(input, { maxSpacingM: 20 });
    const middle = result.segments[1]!; // (0,0) -> (120,0)
    if (middle.arcRadiusM === null) {
      expect(middle.maxLateralShiftM).toBe(0);
      return;
    }
    const sagittaOf = (radiusM: number): number =>
      radiusM - Math.sqrt(Math.max(0, radiusM ** 2 - 60 ** 2));
    // Whatever radius was agreed, the resulting bow must not exceed the sagitta
    // of the FLATTER fit -- so a tight one-sided fit can never win.
    expect(middle.maxLateralShiftM).toBeLessThanOrEqual(sagittaOf(middle.arcRadiusM) + 1e-9);

    const a = result.points[result.sourceVertexAt[1]!]!;
    const b = result.points[result.sourceVertexAt[2]!]!;
    for (let index = result.sourceVertexAt[1]! + 1; index < result.sourceVertexAt[2]!; index += 1) {
      expect(lateralOffsetM(result.points[index]!, a, b)).toBeLessThanOrEqual(
        middle.maxLateralShiftM + 1e-9,
      );
    }
  });

  it('honours the minimum-sagitta and maximum-radius guards', () => {
    const input = circlePoints(5000, 40); // very flat: ~785 m chords, huge radius
    const result = densifyClosedCenterline(input, { maxSpacingM: 25 });
    for (const segment of result.segments) {
      expect(segment.arcRadiusM).toBeNull();
      expect(segment.maxLateralShiftM).toBe(0);
    }
  });

  it('rejects degenerate inputs', () => {
    expect(() => densifyClosedCenterline(circlePoints(50, 3))).toThrow(RangeError);
    expect(() => densifyClosedCenterline(circlePoints(50, 8), { maxSpacingM: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      densifyClosedCenterline([...circlePoints(50, 7), { e: Number.NaN, n: 0 }]),
    ).toThrow(RangeError);
  });
});
