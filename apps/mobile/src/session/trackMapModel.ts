import type { LocalPoint } from '@circuit/core';

/**
 * V2 track-map plumbing (lean): pure geometry/fitting helpers for the calibration
 * screen's live track-map (`TrackMapView.tsx`, `apps/mobile/src/ui/components/`).
 * Deliberately free of any `react-native` import so it stays directly unit-testable
 * (vitest) and reusable from the pure `.tsx` layer without a test renderer -- ALL
 * mapping/fitting logic lives HERE; `TrackMapView.tsx` only turns its output into
 * absolutely-positioned `View`s.
 */

/** Axis-aligned bounding box in the same local (ENU meters) frame as `LocalPoint`. */
export interface Bounds {
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
}

/** A point's position inside its container, as a [0,1] fraction of the container's own
 * width/height -- independent of the container's actual pixel size, so `TrackMapView`
 * can place it with percentage-based `left`/`top` styles. */
export interface ContainerFraction {
  xFrac: number;
  yFrac: number;
}

/**
 * Deterministically reduces a closed-loop centerline to at most `n` evenly spaced
 * points by index, always including the first and last vertex (a centerline with `n`
 * or fewer points is returned unchanged, copied). Pure and side-effect-free -- callers
 * memoize the result by profile identity (V2 binding design: "computed ONCE per
 * profile"); this module does no caching of its own.
 */
export function decimateCenterline(centerline: readonly LocalPoint[], n = 200): LocalPoint[] {
  if (n <= 0 || centerline.length === 0) return [];
  if (centerline.length <= n) return [...centerline];
  if (n === 1) {
    const first = centerline[0];
    return first === undefined ? [] : [first];
  }
  const lastIndex = centerline.length - 1;
  const result: LocalPoint[] = [];
  for (let step = 0; step < n; step += 1) {
    const index = Math.round((step * lastIndex) / (n - 1));
    const point = centerline[index];
    if (point !== undefined) result.push(point);
  }
  return result;
}

/** Bounding box of `points`, in the local (ENU meters) frame. `{0,0,0,0}` for an empty
 * input -- callers with a non-empty centerline never hit that case. */
export function computeBounds(points: readonly LocalPoint[]): Bounds {
  if (points.length === 0) return { minE: 0, maxE: 0, minN: 0, maxN: 0 };
  let minE = Number.POSITIVE_INFINITY;
  let maxE = Number.NEGATIVE_INFINITY;
  let minN = Number.POSITIVE_INFINITY;
  let maxN = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.e < minE) minE = point.e;
    if (point.e > maxE) maxE = point.e;
    if (point.n < minN) minN = point.n;
    if (point.n > maxN) maxN = point.n;
  }
  return { minE, maxE, minN, maxN };
}

/** Guards a degenerate (single-point, or perfectly straight along one axis) bounding
 * box against a divide-by-zero span. */
const MIN_SPAN_M = 1;

/**
 * Ties a fixed bounding box (computed once from a decimated centerline) to a fixed
 * container aspect ratio (`width / height`) -- `project` maps any local-frame point to
 * a `ContainerFraction`, letterboxed so the track's real-world aspect ratio is always
 * preserved (the shape is never stretched to fill a container of a different aspect).
 * North is up: increasing `n` (north) maps to a SMALLER `yFrac` -- screen y grows
 * downward, local n grows north/"up".
 */
export interface CenterlineFit {
  bounds: Bounds;
  /** The content's own natural aspect ratio (`spanE / spanN` of the frame actually
   * passed in -- e.g. already rotated when called from `fitCenterlineAutoRotated`),
   * independent of `containerAspect`/`marginFrac`: letterboxing can never change it,
   * since both axes are always scaled by the same factor. Lets a caller
   * (`ActiveCalibrationScreen`, P1 fix) size its container to match the content
   * instead of assuming a fixed ratio. */
  contentAspect: number;
  project(point: LocalPoint): ContainerFraction;
}

/**
 * @param marginFrac Inner margin, as a fraction of each axis, kept clear of the
 * fitted content on every side (P1 fix: "outline corners touch/exceed the map
 * container edges" -- a phone-screen field report). The fitted content occupies
 * only the central `(1 - 2*marginFrac)` of each axis; `0` reproduces the original
 * edge-to-edge letterbox fit exactly.
 */
export function fitCenterline(points: readonly LocalPoint[], containerAspect: number, marginFrac = 0.06): CenterlineFit {
  const bounds = computeBounds(points);
  const spanE = Math.max(bounds.maxE - bounds.minE, MIN_SPAN_M);
  const spanN = Math.max(bounds.maxN - bounds.minN, MIN_SPAN_M);

  // Letterbox fit, inset by `marginFrac` on each axis: fit into a virtual box
  // shrunk to (1 - 2*marginFrac) of the real container on both axes (still at
  // `containerAspect`, since scaling both axes by the same factor leaves the box's
  // own aspect ratio unchanged), then center that smaller box within the full
  // container -- this is what keeps the fitted content off the edges. A single
  // scale (same on both axes) is what preserves aspect: pick the axis that is the
  // tighter constraint, exactly like fitting an image inside a frame of a
  // different aspect ratio ("contain", not "cover" or "stretch").
  const innerAspectWidthUnits = containerAspect * (1 - 2 * marginFrac);
  const innerHeightUnits = 1 - 2 * marginFrac;
  const scale = Math.min(innerAspectWidthUnits / spanE, innerHeightUnits / spanN);
  const usedWidthUnits = spanE * scale;
  const usedHeightUnits = spanN * scale;
  const padXUnits = (containerAspect - usedWidthUnits) / 2;
  const padYUnits = (1 - usedHeightUnits) / 2;

  return {
    bounds,
    contentAspect: spanE / spanN,
    project(point: LocalPoint): ContainerFraction {
      const xUnits = padXUnits + (point.e - bounds.minE) * scale;
      const yUnitsFromBottom = padYUnits + (point.n - bounds.minN) * scale;
      return {
        xFrac: xUnits / containerAspect,
        yFrac: 1 - yUnitsFromBottom,
      };
    },
  };
}

/** Rotates a local-frame point 90 degrees ((e, n) -> (n, -e)) -- the F1 auto-rotate
 * transform. Pure. */
export function rotatePoint90(point: LocalPoint): LocalPoint {
  return { e: point.n, n: -point.e };
}

/** `fitCenterline`'s result, plus whether every point `project` accepts is first
 * rotated 90 degrees (F1 auto-rotate to fit). */
export interface AutoRotatedCenterlineFit extends CenterlineFit {
  rotated: boolean;
}

/**
 * F1 auto-rotate to fit: wraps `fitCenterline` so a PORTRAIT track (bounding-box
 * `spanN > spanE`) is rotated 90 degrees before fitting -- its long axis then lies
 * along the container's long axis instead of being letterboxed into a thin band.
 * `project` transparently rotates its input the same way, so callers always pass
 * ORIGINAL local-frame points and never need to know rotation happened. A LANDSCAPE
 * (or square) track (`spanN <= spanE`) is fit unrotated, exactly as `fitCenterline`
 * already does -- `fitCenterline` itself is untouched (its own pinned tests keep
 * passing unchanged). `marginFrac` forwards straight to the inner `fitCenterline`
 * call (P1 fix). Pure.
 */
export function fitCenterlineAutoRotated(
  points: readonly LocalPoint[],
  containerAspect: number,
  marginFrac = 0.06,
): AutoRotatedCenterlineFit {
  const rawBounds = computeBounds(points);
  const rotated = rawBounds.maxN - rawBounds.minN > rawBounds.maxE - rawBounds.minE;
  const framePoints = rotated ? points.map(rotatePoint90) : points;
  const innerFit = fitCenterline(framePoints, containerAspect, marginFrac);
  return {
    bounds: innerFit.bounds,
    contentAspect: innerFit.contentAspect,
    rotated,
    project(point: LocalPoint): ContainerFraction {
      return innerFit.project(rotated ? rotatePoint90(point) : point);
    },
  };
}

/**
 * F3 densify to spacing: subdivides every consecutive pair in `centerline` with evenly
 * spaced interior points so no resulting segment exceeds `targetSpacingM` -- replaces
 * the old fixed ~2x densification (P2 fix: "choppy" line -- a segment far longer than
 * its neighbors reads as a visible facet/notch once drawn as a straight
 * `OutlineSegment`, whatever the pipeline's total point count ends up being). A segment
 * already at or under the target is left untouched (0 interior points inserted) -- a
 * no-op (copied) once every segment already qualifies, or `centerline` has fewer than 2
 * points (nothing to interpolate between). Pure -- total path length (sum of
 * consecutive-point distances) is preserved exactly, since every inserted point sits on
 * its original segment's straight line.
 */
export function densifyToSpacing(centerline: readonly LocalPoint[], targetSpacingM = 12): LocalPoint[] {
  if (centerline.length < 2) return [...centerline];
  const result: LocalPoint[] = [];
  for (let index = 0; index < centerline.length - 1; index += 1) {
    const a = centerline[index];
    const b = centerline[index + 1];
    if (a === undefined || b === undefined) continue;
    result.push(a);
    const segmentLengthM = Math.hypot(b.e - a.e, b.n - a.n);
    const subdivisions = Math.ceil(segmentLengthM / targetSpacingM);
    for (let step = 1; step < subdivisions; step += 1) {
      const t = step / subdivisions;
      result.push({ e: a.e + (b.e - a.e) * t, n: a.n + (b.n - a.n) * t });
    }
  }
  const last = centerline[centerline.length - 1];
  if (last !== undefined) result.push(last);
  return result;
}

/** A drawable segment of the connected circuit outline (F2), in container pixels: a
 * thin line `lengthPx` long, starting at `(x, y)`, rotated `angleDeg` degrees around its
 * left-center origin (screen convention: `angleDeg` grows clockwise from the positive-x
 * axis, since `y` grows downward). */
export interface OutlineSegment {
  x: number;
  y: number;
  lengthPx: number;
  angleDeg: number;
}

/** Angle (screen-space degrees, `atan2` convention) from container-fraction point `a`
 * to `b`, given the container's pixel size -- shared by `buildOutlineSegments` and the
 * F5 direction chevron so both compute on-screen direction the same way. Pure. */
export function segmentAngleDeg(a: ContainerFraction, b: ContainerFraction, containerW: number, containerH: number): number {
  const dx = (b.xFrac - a.xFrac) * containerW;
  const dy = (b.yFrac - a.yFrac) * containerH;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** A joint (vertex) of the connected circuit outline, in container pixels -- P2 fix:
 * `TrackMapView` draws a filled circle here, the same diameter as the outline's line
 * thickness, to round over the notch a rotated `OutlineSegment` otherwise leaves at
 * every join ("choppy" line, user field report). */
export interface OutlineJoint {
  x: number;
  y: number;
}

/** `buildOutlineSegments`'s result: the connected outline's segments, plus one joint
 * per vertex (P2 fix -- see `OutlineJoint`). Both arrays are empty together for fewer
 * than 3 fitted points. */
export interface OutlineBuild {
  segments: OutlineSegment[];
  joints: OutlineJoint[];
}

/**
 * F2 connected outline: turns already-fitted (container-fraction) points into thin
 * line segments joining each consecutive pair -- replaces the old dot-cloud outline.
 * `containerW`/`containerH` are the map container's actual pixel size (segment lengths
 * are pixel lengths, positioned absolutely). Pure; `fittedPoints.length` segments (and
 * joints), 0 for fewer than 3 points.
 */
export function buildOutlineSegments(
  fittedPoints: readonly ContainerFraction[],
  containerW: number,
  containerH: number,
): OutlineBuild {
  const segments: OutlineSegment[] = [];
  const joints: OutlineJoint[] = [];
  if (fittedPoints.length < 3) return { segments, joints };
  // A circuit is a closed loop, but the OSM-derived centerline's endpoints sit
  // ~179 m apart (the start/finish straight) -- without an explicit closing
  // segment the drawn outline has a visible gap there (user field report).
  // Iterating to length (not length-1) pairs the LAST point back with the
  // FIRST via the modulo below, closing the loop; degenerate closings (first
  // and last already coincident) produce a ~0-length segment, which is fine.
  for (let index = 0; index < fittedPoints.length; index += 1) {
    const a = fittedPoints[index];
    const b = fittedPoints[(index + 1) % fittedPoints.length];
    if (a === undefined || b === undefined) continue;
    const ax = a.xFrac * containerW;
    const ay = a.yFrac * containerH;
    const bx = b.xFrac * containerW;
    const by = b.yFrac * containerH;
    joints.push({ x: ax, y: ay });
    segments.push({
      x: ax,
      y: ay,
      lengthPx: Math.hypot(bx - ax, by - ay),
      angleDeg: segmentAngleDeg(a, b, containerW, containerH),
    });
  }
  return { segments, joints };
}

/** How far ahead (as a fraction of total lap distance) `pointAtLapFraction` samples a
 * second point to derive a direction, for the F5 chevron. */
const CHEVRON_AHEAD_FRACTION = 0.005;

/** A point along `centerline` at a given fraction of its total path length, plus a
 * second point a little further along the same path -- a caller projects both through
 * a `CenterlineFit`/`AutoRotatedCenterlineFit` and feeds them to `segmentAngleDeg` to
 * get the ON-SCREEN travel-direction angle (F5's chevron): computing the angle from the
 * PROJECTED pair, rather than from `e`/`n` directly, is what keeps it correct under
 * `fitCenterlineAutoRotated`'s rotation. */
export interface LapFractionPoint {
  point: LocalPoint;
  aheadPoint: LocalPoint;
}

function interpolateAtFraction(centerline: readonly LocalPoint[], fraction: number): LocalPoint | undefined {
  if (centerline.length === 0) return undefined;
  if (centerline.length === 1) return centerline[0];
  const clamped = Math.min(1, Math.max(0, fraction));
  const cumulative: number[] = [0];
  for (let index = 1; index < centerline.length; index += 1) {
    const a = centerline[index - 1];
    const b = centerline[index];
    const prev = cumulative[cumulative.length - 1] ?? 0;
    cumulative.push(a === undefined || b === undefined ? prev : prev + Math.hypot(b.e - a.e, b.n - a.n));
  }
  const totalLength = cumulative[cumulative.length - 1] ?? 0;
  const targetLength = totalLength * clamped;
  let segmentIndex = centerline.length - 2;
  for (let index = 1; index < cumulative.length; index += 1) {
    if ((cumulative[index] ?? 0) >= targetLength) {
      segmentIndex = index - 1;
      break;
    }
  }
  const a = centerline[segmentIndex];
  const b = centerline[segmentIndex + 1];
  if (a === undefined || b === undefined) return a ?? b;
  const segStart = cumulative[segmentIndex] ?? 0;
  const segLen = (cumulative[segmentIndex + 1] ?? segStart) - segStart;
  const t = segLen <= 0 ? 0 : (targetLength - segStart) / segLen;
  return { e: a.e + (b.e - a.e) * t, n: a.n + (b.n - a.n) * t };
}

/**
 * F5 direction chevron: locates the point on `centerline` at `fraction` (0-1, clamped)
 * of its total path length, together with a second point `CHEVRON_AHEAD_FRACTION`
 * further along -- see `LapFractionPoint`'s doc comment for why both are returned.
 * Pure; `undefined` for a centerline with fewer than 2 points.
 */
export function pointAtLapFraction(centerline: readonly LocalPoint[], fraction: number): LapFractionPoint | undefined {
  if (centerline.length < 2) return undefined;
  const point = interpolateAtFraction(centerline, fraction);
  const aheadPoint = interpolateAtFraction(centerline, Math.min(1, fraction + CHEVRON_AHEAD_FRACTION));
  if (point === undefined || aheadPoint === undefined) return undefined;
  return { point, aheadPoint };
}
