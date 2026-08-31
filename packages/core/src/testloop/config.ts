/**
 * Test Loop mode (Phase 5d, `docs/architecture/contracts.md` "Test Loop mode")
 * -- every tunable of the "lap 1 defines the track" pipeline, in one place.
 *
 * These are STREET numbers, not circuit numbers: the mode exists so the
 * analysis pipeline can be exercised legally and slowly on a block of public
 * road, where the loop is short, the fixes are noisy and the corners are
 * junctions rather than apexes.
 */
export interface TestLoopConfig {
  /** How close to the start point counts as "back at the start", metres. */
  closeRadiusM: number;
  /** How far the travel direction may differ from the start heading, degrees. */
  headingToleranceDeg: number;
  /** Shorter than this is not a lap -- this is what rejects a U-turn. */
  minLapLengthM: number;
  /**
   * Baseline the travel direction is measured over, metres. Long enough that
   * 5 m of GNSS noise cannot swing the heading test, short enough to stay a
   * local direction.
   */
  courseBaselineM: number;

  // --- quality gate (P5d-FIX1 item 4) -------------------------------------
  /**
   * Worst reported horizontal accuracy a fix may carry and still count.
   * A phone that has lost the sky reports tens of metres; those fixes must
   * not build distance, departure or a closure.
   */
  maxAccuracyM: number;
  /**
   * Slowest speed that counts as MOVING, m/s. A parked car's drift is the
   * single most effective way to fabricate a lap out of nothing; ~1.4 m/s
   * (5 km/h) is below any real driving and far above any drift.
   */
  minSpeedMps: number;
  /**
   * Fastest between-fix speed that is still plausible, m/s -- a segment
   * implying more than this is a reflection/teleport and is dropped whole
   * (never clamped into the distance total). 60 m/s = 216 km/h.
   */
  maxSegmentSpeedMps: number;
  /** Hard ceiling on ONE segment's length, metres, regardless of the gap between fixes. */
  maxSegmentM: number;

  // --- centreline ---------------------------------------------------------
  /** Centreline resample spacing, metres. */
  resampleStepM: number;
  /** Circular moving-average width, in resampled vertices (odd). */
  smoothingWindow: number;
  /**
   * Two centreline vertices this close together (P5d-FIX1 item 6), while far
   * apart ALONG the line, are the same piece of road traversed twice.
   */
  overlapRadiusM: number;
  /** ...where "far apart along the line" starts, metres. */
  overlapSeparationM: number;
  /** Fraction of vertices allowed to be overlapped before the trace is refused. */
  maxOverlapFraction: number;

  // --- profile ------------------------------------------------------------
  /** Lower bound on the derived corridor half-width, metres (P5d-FIX1 item 8). */
  minCorridorM: number;
  /** Upper bound on the derived corridor half-width, metres. */
  maxCorridorM: number;
  /** Multiplier applied to lap 1's own accuracy/dispersion to size the corridor. */
  corridorAccuracyFactor: number;
  /**
   * Start/finish gate width, metres -- sized INDEPENDENTLY of the corridor
   * (P5d-FIX1 item 8): the gate has to be crossed reliably at a junction, the
   * corridor decides what counts as off-track.
   */
  gateWidthM: number;

  // --- corners ------------------------------------------------------------
  /** Curvature (rad/m) that starts a corner candidate. 0.01 = a 100 m radius bend. */
  cornerThreshold: number;
  /** Window the curvature profile is measured over, metres. */
  curvatureWindowM: number;
  /** A corner has to turn at least this far to be a corner (P5d-FIX1 item 7). */
  minCornerAngleDeg: number;
  /** ...and to last at least this long, metres. */
  minCornerLengthM: number;
  /** ...and its peak curvature must exceed the threshold by this factor. */
  minCornerProminence: number;
  /** Speed loss that makes a slow-down a corner candidate, km/h. */
  speedDropKph: number;
  /** ...and the fraction of the approach speed it must also represent. */
  speedDropFraction: number;
  /** Mean curvature a speed-drop window must carry to be a CORNER and not a stop sign, rad/m. */
  speedDropMinCurvature: number;
}

/**
 * Hard cap on a learned circuit's corner count (P5d-FIX1 item 7). Well under
 * the storage envelope's own 200-corner limit, so a wiggly trace is pruned
 * HERE -- deterministically, keeping the most prominent corners -- rather
 * than silently failing to decode after it has been written.
 */
export const MAX_TEST_LOOP_CORNERS = 60;

export const DEFAULT_TEST_LOOP_CONFIG: TestLoopConfig = Object.freeze({
  closeRadiusM: 25,
  headingToleranceDeg: 45,
  minLapLengthM: 300,
  courseBaselineM: 30,

  maxAccuracyM: 35,
  minSpeedMps: 1.4,
  maxSegmentSpeedMps: 60,
  maxSegmentM: 250,

  resampleStepM: 5,
  smoothingWindow: 5,
  overlapRadiusM: 12,
  overlapSeparationM: 60,
  maxOverlapFraction: 0.15,

  minCorridorM: 8,
  maxCorridorM: 25,
  corridorAccuracyFactor: 2,
  gateWidthM: 30,

  cornerThreshold: 0.01,
  curvatureWindowM: 30,
  minCornerAngleDeg: 10,
  minCornerLengthM: 8,
  minCornerProminence: 1.3,
  speedDropKph: 8,
  speedDropFraction: 0.12,
  speedDropMinCurvature: 0.004,
});

export type TestLoopConfigOverrides = Partial<TestLoopConfig>;

/** Applies caller overrides over the defaults, rejecting values that cannot mean anything. */
export function resolveTestLoopConfig(overrides: TestLoopConfigOverrides = {}): TestLoopConfig {
  const resolved: TestLoopConfig = { ...DEFAULT_TEST_LOOP_CONFIG, ...overrides };
  const positive: Array<keyof TestLoopConfig> = [
    'closeRadiusM',
    'headingToleranceDeg',
    'minLapLengthM',
    'courseBaselineM',
    'maxAccuracyM',
    'maxSegmentSpeedMps',
    'maxSegmentM',
    'resampleStepM',
    'smoothingWindow',
    'overlapRadiusM',
    'overlapSeparationM',
    'maxOverlapFraction',
    'minCorridorM',
    'maxCorridorM',
    'corridorAccuracyFactor',
    'gateWidthM',
    'cornerThreshold',
    'curvatureWindowM',
  ];
  for (const key of positive) {
    const value = resolved[key];
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`testloop config: ${key} must be a positive, finite number`);
    }
  }
  if (resolved.minSpeedMps < 0 || !Number.isFinite(resolved.minSpeedMps)) {
    throw new RangeError('testloop config: minSpeedMps must be a nonnegative, finite number');
  }
  if (resolved.headingToleranceDeg > 180) {
    throw new RangeError('testloop config: headingToleranceDeg must be at most 180');
  }
  if (resolved.smoothingWindow % 2 === 0) {
    throw new RangeError('testloop config: smoothingWindow must be odd');
  }
  if (resolved.minCorridorM > resolved.maxCorridorM) {
    throw new RangeError('testloop config: minCorridorM must not exceed maxCorridorM');
  }
  return resolved;
}
