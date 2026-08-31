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
  /** Centreline resample spacing, metres. */
  resampleStepM: number;
  /** Circular moving-average width, in resampled vertices (odd). */
  smoothingWindow: number;
  /** Corridor half-width of the learned circuit, metres -- deliberately generous. */
  corridorWidthM: number;
  /** Curvature (rad/m) that starts a corner candidate. 0.01 = a 100 m radius bend. */
  cornerThreshold: number;
  /** Window the curvature profile is measured over, metres. */
  curvatureWindowM: number;
  /** Speed loss that makes a slow-down a corner candidate, km/h. */
  speedDropKph: number;
  /** ...and the fraction of the approach speed it must also represent. */
  speedDropFraction: number;
  /** Mean curvature a speed-drop window must carry to be a CORNER and not a stop sign, rad/m. */
  speedDropMinCurvature: number;
}

export const DEFAULT_TEST_LOOP_CONFIG: TestLoopConfig = Object.freeze({
  closeRadiusM: 25,
  headingToleranceDeg: 45,
  minLapLengthM: 300,
  courseBaselineM: 30,
  resampleStepM: 5,
  smoothingWindow: 5,
  corridorWidthM: 25,
  cornerThreshold: 0.01,
  curvatureWindowM: 30,
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
    'resampleStepM',
    'smoothingWindow',
    'corridorWidthM',
    'cornerThreshold',
    'curvatureWindowM',
  ];
  for (const key of positive) {
    const value = resolved[key];
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`testloop config: ${key} must be a positive, finite number`);
    }
  }
  if (resolved.headingToleranceDeg > 180) {
    throw new RangeError('testloop config: headingToleranceDeg must be at most 180');
  }
  if (resolved.smoothingWindow % 2 === 0) {
    throw new RangeError('testloop config: smoothingWindow must be odd');
  }
  return resolved;
}
