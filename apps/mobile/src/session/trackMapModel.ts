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
  project(point: LocalPoint): ContainerFraction;
}

export function fitCenterline(points: readonly LocalPoint[], containerAspect: number): CenterlineFit {
  const bounds = computeBounds(points);
  const spanE = Math.max(bounds.maxE - bounds.minE, MIN_SPAN_M);
  const spanN = Math.max(bounds.maxN - bounds.minN, MIN_SPAN_M);

  // Letterbox fit: a single scale (same on both axes) is what preserves aspect: pick
  // the axis that is the tighter constraint, exactly like fitting an image inside a
  // frame of a different aspect ratio ("contain", not "cover" or "stretch").
  const scale = Math.min(containerAspect / spanE, 1 / spanN);
  const usedWidthUnits = spanE * scale;
  const usedHeightUnits = spanN * scale;
  const padXUnits = (containerAspect - usedWidthUnits) / 2;
  const padYUnits = (1 - usedHeightUnits) / 2;

  return {
    bounds,
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
