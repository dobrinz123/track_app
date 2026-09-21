import type { LocalPoint } from '../contracts';

/**
 * Arc-aware resampling of a closed centerline (ticket P7G).
 *
 * WHY THIS EXISTS. A traced OSM centerline stores a racetrack as straight
 * chords between sparsely mapped nodes. Where a long chord spans a curve, the
 * chord cuts INSIDE the real arc, so a car driving the real track reads as
 * laterally displaced -- and, past `corridorWidthM`, as OFF TRACK. Those bins
 * then never get covered and calibration cannot complete.
 *
 * WHAT THIS DOES *NOT* DO. It adds no information. Every emitted point that is
 * not an input vertex is INTERPOLATED from the input vertices, never surveyed.
 * The only claim made here is that three consecutive mapped points imply a
 * local curvature, and that honouring it is a better reading of the SAME data
 * than throwing it away for a straight chord.
 *
 * THE CONSERVATIVE RULE. Each segment A->B has two three-point circle fits
 * available: `circle(prev, A, B)` and `circle(A, B, next)`. A racetrack is
 * arcs and straights, and a curve fit that invents oscillation on a straight is
 * worse than the chord it replaces. The dangerous case is real and common: a
 * corner whose apex is mapped as a single sharp vertex followed by a long
 * straight chord. There `circle(prev, A, B)` reports a plausible-looking corner
 * radius even though B->next is provably dead straight, and trusting it would
 * bow a straight by metres.
 *
 * So a segment is bent ONLY by the curvature BOTH of its neighbourhoods agree
 * on -- both fits must exist, sit on the SAME side of the chord, and be no
 * flatter than `maxArcRadiusM`; the arc actually used is then the FLATTER of
 * the two. One-sided evidence buys no bend at all.
 *
 * There is a second trap, and it is not solvable by looking harder: when a
 * segment is far longer than the segments flanking it, a three-point fit stops
 * being an ESTIMATE of curvature and becomes an artefact of the long lever arm.
 * A straight running tangentially between two arcs looks, to both fits, exactly
 * like one long arc -- the mapped points cannot tell those apart, and no amount
 * of cleverness recovers information the trace does not contain. So a segment
 * whose flanking segments are shorter than `minNeighbourChordRatio` of it is
 * left alone as well.
 *
 * All of this is deliberately conservative: it under-corrects genuine sweeps
 * rather than ever inventing a bend a straight does not support. Segments that
 * fail any test are subdivided along their exact chord, so a straight stays
 * bit-for-bit straight.
 */

/** Longest spacing tolerated between emitted points. */
const DEFAULT_MAX_SPACING_M = 22;
/**
 * Fits flatter than this are treated as straight. Over the longest chord in a
 * traced circuit (~240 m) a 2000 m radius implies ~3.6 m of sagitta, and beyond
 * it a three-point fit is dominated by digitising noise rather than curvature.
 */
const DEFAULT_MAX_ARC_RADIUS_M = 2000;
/**
 * Minimum sagitta worth honouring. Below this the implied bend is far inside
 * GNSS noise and any track's corridor, so the chord is kept.
 */
const DEFAULT_MIN_SAGITTA_M = 0.25;
/**
 * Both flanking segments must be at least this fraction of the segment's own
 * chord for its three-point fits to count as curvature evidence rather than
 * long-lever-arm artefact. 1/5 keeps fits whose support is within a factor of
 * five and discards the rest.
 */
const DEFAULT_MIN_NEIGHBOUR_CHORD_RATIO = 0.2;
/** Step used to measure arc length before resampling it uniformly. */
const DEFAULT_ARC_SAMPLE_STEP_M = 1;

export interface DensifyOptions {
  /** Longest spacing tolerated between emitted points (default 22 m). */
  maxSpacingM?: number;
  /** Circle fits flatter than this count as straight (default 2000 m). */
  maxArcRadiusM?: number;
  /** Implied bends smaller than this are not worth honouring (default 0.25 m). */
  minSagittaM?: number;
  /**
   * Shortest flanking segment, as a fraction of a segment's own chord, for its
   * three-point fits to count as evidence (default 0.2).
   */
  minNeighbourChordRatio?: number;
  /** Arc-length measurement step before uniform resampling (default 1 m). */
  arcSampleStepM?: number;
}

export interface DensifiedSegment {
  /** Index of this segment's first vertex in the INPUT polyline. */
  sourceIndex: number;
  /** Straight-line distance between the segment's two input vertices. */
  chordLengthM: number;
  /** Length actually emitted for this segment (equals the chord when straight). */
  emittedLengthM: number;
  /** Number of emitted pieces the segment was split into (1 = not subdivided). */
  pieces: number;
  /** Radius of the agreed arc, or `null` when the segment was left straight. */
  arcRadiusM: number | null;
  /** Largest lateral shift this segment's resampling introduces (0 when straight). */
  maxLateralShiftM: number;
}

export interface DensifyResult {
  /** The resampled closed centerline. Input vertices are preserved exactly. */
  points: LocalPoint[];
  /** `sourceVertexAt[k]` is the index in `points` of input vertex `k`. */
  sourceVertexAt: number[];
  /** One entry per input segment, in input order. */
  segments: DensifiedSegment[];
}

interface AgreedArc {
  radiusM: number;
  /** Point on the arc at chord-frame abscissa `x`, measured from the midpoint. */
  at(x: number): LocalPoint;
  /** Perpendicular offset from the chord at abscissa `x`. */
  offsetAt(x: number): number;
}

// Kept dependency-free on purpose: the circuit generators load this module
// directly by URL under `node --experimental-strip-types`, which cannot resolve
// extensionless value imports. Same constraint `./curvature.ts` lives under.
function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function assertLocalPoint(point: LocalPoint, name: string): void {
  assertFiniteNumber(point.e, `${name}.e`);
  assertFiniteNumber(point.n, `${name}.n`);
}

function distance(a: LocalPoint, b: LocalPoint): number {
  const result = Math.hypot(b.e - a.e, b.n - a.n);
  assertFiniteNumber(result, 'segment length');
  return result;
}

/** Circumscribed circle of three points, or `null` when they are collinear. */
function circleThrough(a: LocalPoint, b: LocalPoint, c: LocalPoint): LocalPoint & { r: number } | null {
  const determinant = 2 * (a.e * (b.n - c.n) + b.e * (c.n - a.n) + c.e * (a.n - b.n));
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return null;
  const aa = a.e * a.e + a.n * a.n;
  const bb = b.e * b.e + b.n * b.n;
  const cc = c.e * c.e + c.n * c.n;
  const e = (aa * (b.n - c.n) + bb * (c.n - a.n) + cc * (a.n - b.n)) / determinant;
  const n = (aa * (c.e - b.e) + bb * (a.e - c.e) + cc * (b.e - a.e)) / determinant;
  if (!Number.isFinite(e) || !Number.isFinite(n)) return null;
  const r = Math.hypot(a.e - e, a.n - n);
  return Number.isFinite(r) ? { e, n, r } : null;
}

/**
 * The arc both neighbourhoods of segment `a`->`b` agree on, or `null` when the
 * segment must stay a straight chord. See the file header for the rule.
 */
function agreedArc(
  previous: LocalPoint,
  a: LocalPoint,
  b: LocalPoint,
  next: LocalPoint,
  maxArcRadiusM: number,
  minSagittaM: number,
  minNeighbourChordRatio: number,
): AgreedArc | null {
  const chordLengthM = distance(a, b);
  if (!(chordLengthM > 0)) return null;

  // Long-lever-arm guard: with stub neighbours the two fits describe the stubs,
  // not this segment, and a tangent straight is indistinguishable from an arc.
  const shortestNeighbourM = Math.min(distance(previous, a), distance(b, next));
  if (shortestNeighbourM < chordLengthM * minNeighbourChordRatio) return null;

  const halfChordM = chordLengthM / 2;
  const unit = { e: (b.e - a.e) / chordLengthM, n: (b.n - a.n) / chordLengthM };
  const normal = { e: -unit.n, n: unit.e };
  const midpoint = { e: (a.e + b.e) / 2, n: (a.n + b.n) / 2 };

  const left = circleThrough(previous, a, b);
  const right = circleThrough(a, b, next);
  if (left === null || right === null) return null;
  if (left.r > maxArcRadiusM || right.r > maxArcRadiusM) return null;

  // Both circles pass through a and b, so each centre sits on the chord's
  // perpendicular bisector; `offset` is its signed position along `normal`.
  const leftOffset = (left.e - midpoint.e) * normal.e + (left.n - midpoint.n) * normal.n;
  const rightOffset = (right.e - midpoint.e) * normal.e + (right.n - midpoint.n) * normal.n;
  if (leftOffset === 0 || rightOffset === 0) return null;
  if (Math.sign(leftOffset) !== Math.sign(rightOffset)) return null;

  // The FLATTER fit is the curvature both neighbourhoods support.
  const radiusM = Math.max(left.r, right.r);
  if (!(radiusM >= halfChordM)) return null;
  const centreOffsetM = Math.sqrt(Math.max(0, radiusM * radiusM - halfChordM * halfChordM));
  const sagittaM = radiusM - centreOffsetM;
  if (!(sagittaM >= minSagittaM)) return null;

  const side = Math.sign(leftOffset);
  const signedCentreM = side * centreOffsetM;
  const offsetAt = (x: number): number =>
    signedCentreM - side * Math.sqrt(Math.max(0, radiusM * radiusM - x * x));
  return {
    radiusM,
    offsetAt,
    at(x: number) {
      const offset = offsetAt(x);
      return {
        e: midpoint.e + x * unit.e + offset * normal.e,
        n: midpoint.n + x * unit.n + offset * normal.n,
      };
    },
  };
}

function requirePoint(points: readonly LocalPoint[], index: number): LocalPoint {
  const point = points[((index % points.length) + points.length) % points.length];
  if (point === undefined) throw new RangeError(`closed line is sparse at index ${index}`);
  return point;
}

/**
 * Resample a closed centerline so no emitted segment is longer than
 * `maxSpacingM`, following the local arc where -- and only where -- the
 * surrounding mapped points agree one exists.
 *
 * Input vertices are preserved exactly and in order: this only ADDS
 * interpolated points between them. It never moves, drops, or reorders a
 * mapped point, and it never claims the geometry became more trustworthy.
 */
export function densifyClosedCenterline(
  points: readonly LocalPoint[],
  options: DensifyOptions = {},
): DensifyResult {
  const maxSpacingM = options.maxSpacingM ?? DEFAULT_MAX_SPACING_M;
  const maxArcRadiusM = options.maxArcRadiusM ?? DEFAULT_MAX_ARC_RADIUS_M;
  const minSagittaM = options.minSagittaM ?? DEFAULT_MIN_SAGITTA_M;
  const minNeighbourChordRatio =
    options.minNeighbourChordRatio ?? DEFAULT_MIN_NEIGHBOUR_CHORD_RATIO;
  const arcSampleStepM = options.arcSampleStepM ?? DEFAULT_ARC_SAMPLE_STEP_M;

  if (!(maxSpacingM > 0)) throw new RangeError('maxSpacingM must be positive');
  if (!(maxArcRadiusM > 0)) throw new RangeError('maxArcRadiusM must be positive');
  if (!(minSagittaM >= 0)) throw new RangeError('minSagittaM must be nonnegative');
  if (!(minNeighbourChordRatio >= 0)) {
    throw new RangeError('minNeighbourChordRatio must be nonnegative');
  }
  if (!(arcSampleStepM > 0)) throw new RangeError('arcSampleStepM must be positive');
  if (points.length < 4) {
    throw new RangeError('a closed centerline needs at least four vertices to fit local arcs');
  }
  for (let index = 0; index < points.length; index += 1) {
    assertLocalPoint(requirePoint(points, index), `points[${index}]`);
  }

  const emitted: LocalPoint[] = [];
  const sourceVertexAt: number[] = [];
  const segments: DensifiedSegment[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const a = requirePoint(points, index);
    const b = requirePoint(points, index + 1);
    sourceVertexAt.push(emitted.length);
    emitted.push(a);

    const chordLengthM = distance(a, b);
    if (!(chordLengthM > 0)) {
      segments.push({
        sourceIndex: index,
        chordLengthM,
        emittedLengthM: 0,
        pieces: 1,
        arcRadiusM: null,
        maxLateralShiftM: 0,
      });
      continue;
    }

    const arc = agreedArc(
      requirePoint(points, index - 1),
      a,
      b,
      requirePoint(points, index + 2),
      maxArcRadiusM,
      minSagittaM,
      minNeighbourChordRatio,
    );

    if (arc === null) {
      // Straight: subdivide the exact chord. Endpoints are untouched and every
      // inserted point is a convex combination of them, so a straight stays
      // straight to floating-point exactness.
      const pieces = Math.max(1, Math.ceil(chordLengthM / maxSpacingM));
      for (let piece = 1; piece < pieces; piece += 1) {
        const t = piece / pieces;
        emitted.push({ e: a.e + (b.e - a.e) * t, n: a.n + (b.n - a.n) * t });
      }
      segments.push({
        sourceIndex: index,
        chordLengthM,
        emittedLengthM: chordLengthM,
        pieces,
        arcRadiusM: null,
        maxLateralShiftM: 0,
      });
      continue;
    }

    // Bent: measure the arc, then place interior points at uniform arc length.
    const halfChordM = chordLengthM / 2;
    const sampleCount = Math.max(8, Math.ceil(chordLengthM / arcSampleStepM));
    const samples: LocalPoint[] = [];
    let maxLateralShiftM = 0;
    for (let step = 0; step <= sampleCount; step += 1) {
      const x = -halfChordM + (2 * halfChordM * step) / sampleCount;
      samples.push(arc.at(x));
      maxLateralShiftM = Math.max(maxLateralShiftM, Math.abs(arc.offsetAt(x)));
    }
    const cumulative: number[] = [0];
    for (let step = 1; step <= sampleCount; step += 1) {
      const previousSample = samples[step - 1];
      const currentSample = samples[step];
      if (previousSample === undefined || currentSample === undefined) {
        throw new RangeError('arc sampling produced a sparse array');
      }
      cumulative.push((cumulative[step - 1] ?? 0) + distance(previousSample, currentSample));
    }
    const arcLengthM = cumulative[sampleCount] ?? chordLengthM;
    assertFiniteNumber(arcLengthM, 'arc length');
    const pieces = Math.max(1, Math.ceil(arcLengthM / maxSpacingM));
    for (let piece = 1; piece < pieces; piece += 1) {
      const target = (arcLengthM * piece) / pieces;
      let step = 1;
      while (step < sampleCount && (cumulative[step] ?? 0) < target) step += 1;
      const before = samples[step - 1];
      const after = samples[step];
      const startM = cumulative[step - 1] ?? 0;
      const endM = cumulative[step] ?? startM;
      if (before === undefined || after === undefined) {
        throw new RangeError('arc sampling produced a sparse array');
      }
      const span = endM - startM;
      const t = span <= 0 ? 0 : (target - startM) / span;
      emitted.push({
        e: before.e + (after.e - before.e) * t,
        n: before.n + (after.n - before.n) * t,
      });
    }
    segments.push({
      sourceIndex: index,
      chordLengthM,
      emittedLengthM: arcLengthM,
      pieces,
      arcRadiusM: arc.radiusM,
      maxLateralShiftM,
    });
  }

  return { points: emitted, sourceVertexAt, segments };
}
