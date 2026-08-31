import type { GeoProjection, LatLon, LocalPoint, LocationSample } from '../contracts';
import { createProjection, polylineCumulative, polylineLength } from '../geometry';

import { resolveTestLoopConfig, type TestLoopConfigOverrides } from './config';
import type { LoopClosure } from './loopClosure';

/**
 * Ticket P5d T1(b) -- lap 1's raw trace becomes a centreline: resampled to an
 * even spacing, lightly smoothed, closed, and expressed in an ENU frame
 * anchored at the start point.
 *
 * The smoothing is deliberately light (a 5-vertex circular moving average over
 * 5 m steps = a 25 m window). It exists to take the 3-5 m per-fix jitter off a
 * phone trace, NOT to invent a racing line: a heavier filter would cut the
 * corners the whole mode exists to find.
 */

export interface LoopCentreline {
  /** The frame's origin -- lap 1's start fix. */
  origin: LatLon;
  /** The learned line in lat/lon, ready to go into a `CircuitProfile`. */
  points: LatLon[];
  /** The same line in the anchored ENU frame (metres). */
  local: LocalPoint[];
  /** Closed-loop length including the implicit last-to-first segment, metres. */
  totalLengthM: number;
  /** Travel direction at the start point, degrees (0 = north). */
  startHeadingDeg: number;
  direction: 'clockwise' | 'counterclockwise';
  /** Raw fixes lap 1 was built from (after the closure slice), for diagnostics. */
  sampleCount: number;
}

function distance(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(b.e - a.e, b.n - a.n);
}

/**
 * Resamples an OPEN polyline at an even spacing chosen so a whole number of
 * steps fits exactly -- `stepM` is a target, never a remainder generator.
 */
function resampleOpen(points: readonly LocalPoint[], stepM: number): LocalPoint[] {
  const cumulative = polylineCumulative(points as LocalPoint[]);
  const lengthM = cumulative[cumulative.length - 1] ?? 0;
  if (!(lengthM > 0)) return [...points];
  const steps = Math.max(1, Math.round(lengthM / stepM));
  const spacingM = lengthM / steps;

  const out: LocalPoint[] = [];
  let segment = 1;
  for (let index = 0; index <= steps; index += 1) {
    const target = Math.min(index * spacingM, lengthM);
    while (segment < cumulative.length - 1 && (cumulative[segment] ?? 0) < target) segment += 1;
    const startM = cumulative[segment - 1] ?? 0;
    const endM = cumulative[segment] ?? startM;
    const from = points[segment - 1];
    const to = points[segment];
    if (from === undefined || to === undefined) break;
    const span = endM - startM;
    const fraction = span <= 0 ? 0 : Math.min(1, Math.max(0, (target - startM) / span));
    out.push({
      e: from.e + (to.e - from.e) * fraction,
      n: from.n + (to.n - from.n) * fraction,
    });
  }
  return out;
}

/** Circular moving average over an implicitly closed ring of vertices. */
function smoothClosed(points: readonly LocalPoint[], window: number): LocalPoint[] {
  const count = points.length;
  if (count < window || window <= 1) return [...points];
  const half = (window - 1) / 2;
  return points.map((_, index) => {
    let e = 0;
    let n = 0;
    for (let offset = -half; offset <= half; offset += 1) {
      const neighbour = points[(index + offset + count * 2) % count];
      if (neighbour === undefined) continue;
      e += neighbour.e;
      n += neighbour.n;
    }
    return { e: e / window, n: n / window };
  });
}

/** Signed area (shoelace) of the closed ring: positive = counterclockwise. */
function signedArea(points: readonly LocalPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current === undefined || next === undefined) continue;
    total += current.e * next.n - next.e * current.n;
  }
  return total / 2;
}

/**
 * Builds lap 1's centreline. `closure` says which slice of `samples` lap 1 is;
 * the line is closed by driving the last fix back to the start point, which is
 * at most `closeRadiusM` away by construction.
 */
export function buildLoopCentreline(
  samples: readonly LocationSample[],
  closure: LoopClosure,
  overrides: TestLoopConfigOverrides = {},
): LoopCentreline {
  const config = resolveTestLoopConfig(overrides);
  const lap = samples.slice(closure.startIndex, closure.closeIndex + 1);
  const first = lap[0];
  if (first === undefined || lap.length < 4) {
    throw new RangeError('buildLoopCentreline: lap 1 slice is too short to be a loop');
  }
  const origin: LatLon = { lat: first.lat, lon: first.lon };
  const projection: GeoProjection = createProjection(origin);
  const raw = lap.map((sample) => projection.toLocal({ lat: sample.lat, lon: sample.lon }));

  // Close the ring explicitly: the final leg runs from the closing fix back to
  // the start point (the two are within the closing radius of each other).
  const startPoint = raw[0];
  if (startPoint === undefined) {
    throw new RangeError('buildLoopCentreline: lap 1 slice is sparse');
  }
  // The closing fix is the NEAREST one to the start, which means it can
  // already be a few metres PAST the start line. Left in, that overshoot
  // becomes a spur at the seam -- the line runs past the start point and then
  // doubles back onto it. Trim any tail fix that is both inside the closing
  // radius and already past the start line before closing the ring.
  const headingRad = (closure.startHeadingDeg * Math.PI) / 180;
  const forward = { e: Math.sin(headingRad), n: Math.cos(headingRad) };
  const trimmed = [...raw];
  while (trimmed.length > 4) {
    const tail = trimmed[trimmed.length - 1];
    if (tail === undefined) break;
    const past = (tail.e - startPoint.e) * forward.e + (tail.n - startPoint.n) * forward.n;
    if (distance(tail, startPoint) > config.closeRadiusM || past <= 0) break;
    trimmed.pop();
  }
  // The start point ALWAYS terminates the path, however short the last leg is.
  // Leaving it out (because the closing fix was already within a step of it)
  // makes the ring's wrap segment shorter than every other segment, which
  // drags the seam vertices sideways under the circular smoothing below.
  const lastPoint = trimmed[trimmed.length - 1] ?? startPoint;
  const closedPath = distance(lastPoint, startPoint) < 0.5 ? trimmed : [...trimmed, startPoint];

  // Resample -> smooth -> resample again: smoothing shortens the line slightly
  // and unevens the spacing, so the spacing is re-established afterwards. The
  // trailing vertex (a duplicate of the first) is dropped both times: a
  // `CircuitProfile` centreline is a closed loop with an IMPLICIT wrap.
  const evenly = resampleOpen(closedPath, config.resampleStepM).slice(0, -1);
  const smoothed = smoothClosed(evenly, config.smoothingWindow);
  const local = resampleOpen([...smoothed, smoothed[0] ?? startPoint], config.resampleStepM).slice(
    0,
    -1,
  );

  if (local.length < 50) {
    throw new RangeError('buildLoopCentreline: learned loop is too short to describe a circuit');
  }

  return {
    origin,
    points: local.map((point) => projection.toLatLon(point)),
    local,
    totalLengthM: polylineLength(local),
    startHeadingDeg: closure.startHeadingDeg,
    direction: signedArea(local) >= 0 ? 'counterclockwise' : 'clockwise',
    sampleCount: lap.length,
  };
}
