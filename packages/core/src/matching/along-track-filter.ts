/**
 * Ticket P8.2 -- a one-dimensional estimator of where the car is ALONG the
 * centerline, and how fast it is moving along it.
 *
 * Why 1-D. The car is confined to a known track, so the free 2-D position
 * problem collapses to a single coordinate: distance along the centerline.
 * That matters for timing specifically, because a gate is (very nearly)
 * perpendicular to travel -- LATERAL error barely moves the instant you cross
 * it, ALONG-TRACK error moves it in direct proportion. At 150 km/h, 3 m of
 * along-track error is 72 ms.
 *
 * What it is NOT. This estimator never decides whether a crossing happened.
 * `CrossingDetector` answers that from raw fixes and raw geometry exactly as
 * it did before P8. This only ever refines the INSTANT, and every consumer is
 * required to fall back to the unfiltered answer when `converged` is false.
 *
 * =====================================================================
 * FILTER FORM
 * =====================================================================
 * A textbook two-state linear Kalman filter:
 *
 *     x = [ s ]  along-track distance, metres (the matcher's
 *         [ v ]  `unwrappedProgressM`, monotonic across laps)
 *              along-track speed, m/s
 *
 *     F = [ 1  dt ]      (constant velocity)
 *         [ 0   1 ]
 *
 *     Q = sigmaA^2 * [ dt^4/4  dt^3/2 ]      (white-noise acceleration)
 *                    [ dt^3/2  dt^2   ]
 *
 * with TWO scalar measurements per fix, applied sequentially (exact, because
 * R is diagonal):
 *
 *     z_v = Doppler speed, R_v  -- the accurate observable ("predict")
 *     z_s = projected GPS distance along the centerline, R_s -- the noisy one
 *           ("correct")
 *
 * The velocity update is deliberately applied FIRST. That is what makes this
 * filter worth building rather than a plain position smoother: the off-diagonal
 * `Q[0][1] = sigmaA^2*dt^3/2` is exactly the covariance the constant-velocity
 * model induces between the unknown acceleration and the distance it adds over
 * the interval, so correcting `v` with a 0.1 m/s Doppler reading at the END of
 * the interval also pulls `s` back onto the trapezoidal (constant-acceleration)
 * integral of the speed. Without that ordering there is nothing in a 1 Hz
 * constant-velocity filter that can absorb the 1/2*a*dt^2 term, which is 4.9 m
 * under 1 g -- far bigger than the 3 m of GPS noise we are trying to beat, and
 * the filter would be worse than useless.
 *
 * =====================================================================
 * THE GAIN, AND WHERE ITS NUMBERS COME FROM
 * =====================================================================
 * The gain is not tuned. It is the Kalman gain implied by R and Q, recomputed
 * every step from the actual `dt`, so a dropped fix or a rate change is handled
 * by the recursion rather than by a constant someone picked.
 *
 * R_s -- position. `DEFAULT_POSITION_NOISE_M = 3`, the ticket's figure and the
 *   accuracy a phone reports on an open circuit. When the fix carries
 *   `accuracyM` that value is used instead, clamped to
 *   [MIN, MAX]_POSITION_NOISE_M so one absurd report cannot either freeze the
 *   filter or make it chase noise. CONVENTION, stated rather than assumed: we
 *   read `accuracyM` as a ONE-AXIS 1-sigma in metres and use it directly as
 *   the along-track sigma. If a platform's radius is instead a 2-D radial
 *   figure, the true per-axis sigma is smaller and this filter is mildly
 *   conservative -- it will trust GPS slightly less than optimal, never more.
 *
 * R_v -- Doppler, `DEFAULT_DOPPLER_NOISE_MPS = 0.1` (the ticket's figure;
 *   carrier-phase Doppler is roughly an order of magnitude better than
 *   differencing positions), PLUS a speed-proportional term:
 *
 *       R_v = sigmaD^2 + (projectionFraction * v)^2
 *
 *   because the Doppler observable is GROUND speed along the driven path,
 *   while the state is speed along the CENTERLINE. The two differ by the
 *   cosine of the path/centerline misalignment and by the racing line being
 *   longer or shorter than the centerline through a corner. That difference is
 *   a slowly varying BIAS, not noise, and a filter that believes Doppler to
 *   0.1 m/s integrates it: with projectionFraction = 0 a sustained 0.2 m/s
 *   mismatch walks the position estimate out to ~6 m (steady-state K_s is only
 *   0.033), which makes timing WORSE than raw. That is not hypothetical --
 *   `test/timing/p8-crossing-precision.test.ts` measures it. Sweeping this
 *   one number against known truth on a racing line (200 trials/scenario,
 *   mean |crossing-time error| in ms; run it with P8_SWEEP=1):
 *
 *     kappa      0      0.005   0.01   0.015   0.02   0.03   0.05   0.08
 *     80 km/h   63.0    59.7    54.4    49.3   46.6   46.8   51.7   57.4
 *     150       50.1    39.7    31.4    28.3   27.3   28.4   31.5   47.3
 *     200       43.7    31.2    23.1    21.1   21.0   22.8   35.5   35.5
 *     brake 1g  48.4    36.4    29.3    27.7   28.7   30.7   47.6   48.2
 *     accel     48.9    43.9    36.7    30.9   27.1   26.3   29.6   46.4
 *     (linear interpolation, for reference: 88.9 / 47.3 / 35.5 / 51.8 / 47.4)
 *
 *   kappa = 0 is WORSE THAN DOING NOTHING at 150 and 200 km/h. The optimum is
 *   broad and flat over 0.02-0.03, so `DEFAULT_PROJECTION_FRACTION = 0.02` is
 *   picked from the middle of a plateau rather than from a minimum, which is
 *   what keeps it from being a fit to this particular synthetic racing line.
 *   Physically it admits a 2 % projection error: ~11 degrees of instantaneous
 *   misalignment, or a racing line 2 % longer than the centerline. Above
 *   ~0.06 the filter stops reaching `converged` at all and every crossing
 *   falls back to linear -- which is exactly what the kappa = 0.08 row shows,
 *   and is the convergence gate behaving as designed.
 *
 * sigmaA -- `DEFAULT_ACCELERATION_NOISE_MPS2 = 10`, i.e. the longitudinal
 *   acceleration of a car on a circuit is unknown to about 1 g between fixes.
 *   Note the steady state is almost INSENSITIVE to it (0.541 m at sigmaA = 2
 *   and at 15, with R_v = 0.1^2) precisely because the Doppler measurement
 *   plus the Q cross-term absorb it; it matters only for how fast the filter
 *   re-converges after a reset.
 *
 * Resulting steady state at 1 Hz, sigma_s = 3 m, v = 42 m/s: distance sigma
 * ~1.5 m, i.e. about 2x better than the raw projection. (With kappa = 0 it
 * would be 0.54 m -- but see the sweep above for why that number is a trap.)
 *
 * =====================================================================
 * IT MUST NOT WEDGE
 * =====================================================================
 * Every abnormal input RESETS to the measurement rather than rejecting it
 * forever: a non-finite input, a non-advancing or backwards clock, a gap
 * longer than `maxGapS`, along-track progress running backwards by more than
 * `reverseResetM`, or `maxOutlierRun` consecutive measurements outside the
 * innovation gate. A reset clears `converged`, and an unconverged filter is
 * required by contract to be ignored by its consumer -- so the worst outcome
 * of any of these paths is that timing falls back to the unfiltered answer.
 */

/** Configuration for {@link AlongTrackFilter}; every field has a documented default. */
export interface AlongTrackFilterConfig {
  /** Along-track 1-sigma of the projected GPS distance when the fix reports no accuracy, metres. */
  positionNoiseM?: number;
  /** Lower clamp applied to a fix-reported `accuracyM`, metres. */
  minPositionNoiseM?: number;
  /** Upper clamp applied to a fix-reported `accuracyM`, metres. */
  maxPositionNoiseM?: number;
  /** Doppler speed 1-sigma, m/s. */
  dopplerNoiseMps?: number;
  /** Speed-proportional Doppler term covering ground-speed vs along-track projection, dimensionless. */
  dopplerProjectionFraction?: number;
  /** White-noise-acceleration process intensity, m/s^2. */
  accelerationNoiseMps2?: number;
  /** A fix gap longer than this resets the filter, seconds. */
  maxGapS?: number;
  /** Position innovations beyond this many sigma are treated as outliers. */
  innovationSigmaGate?: number;
  /** Consecutive outliers tolerated before a hard reset. */
  maxOutlierRun?: number;
  /** Along-track progress running backwards by more than this resets the filter, metres. */
  reverseResetM?: number;
  /** The filter is `converged` only once its distance sigma is at most this fraction of the raw one. */
  convergenceFraction?: number;
  /** ...and only after this many accepted fixes since the last reset. */
  minSamplesForConvergence?: number;
}

/** The filter's posterior at one fix. */
export interface AlongTrackEstimate {
  /** The fix timestamp this posterior belongs to, monotonic ms. */
  tMono: number;
  /** Filtered along-track distance on the matcher's `unwrappedProgressM` scale, metres. */
  distanceM: number;
  /** Filtered along-track speed, m/s. */
  speedMps: number;
  /** Posterior 1-sigma of `distanceM`, metres. */
  distanceSigmaM: number;
  /** False until the filter has settled; consumers MUST fall back when false. */
  converged: boolean;
}

/** One fix as this filter sees it: an along-track measurement plus the Doppler speed. */
export interface AlongTrackObservation {
  tMono: number;
  /** The matcher's `unwrappedProgressM` for this fix, metres. */
  measuredDistanceM: number;
  /** Raw `LocationSample.speedMps`; -1, 0, undefined and NaN are all treated as absent. */
  speedMps?: number | undefined;
  /** Raw `LocationSample.accuracyM`, if the fix carried one. */
  accuracyM?: number | undefined;
}

const DEFAULT_POSITION_NOISE_M = 3;
const DEFAULT_MIN_POSITION_NOISE_M = 1.5;
const DEFAULT_MAX_POSITION_NOISE_M = 25;
const DEFAULT_DOPPLER_NOISE_MPS = 0.1;
const DEFAULT_PROJECTION_FRACTION = 0.02;
const DEFAULT_ACCELERATION_NOISE_MPS2 = 10;
const DEFAULT_MAX_GAP_S = 3;
const DEFAULT_INNOVATION_SIGMA_GATE = 5;
const DEFAULT_MAX_OUTLIER_RUN = 2;
const DEFAULT_REVERSE_RESET_M = 5;
const DEFAULT_CONVERGENCE_FRACTION = 0.7;
const DEFAULT_MIN_SAMPLES_FOR_CONVERGENCE = 5;
/** Seed variance for the speed state: wide enough that the first Doppler reading effectively sets it. */
const SEED_SPEED_VARIANCE = 400;

function positiveFinite(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function nonNegativeFinite(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

/** Same absence rule as `geometry/intersection.ts`: iOS sends -1 for "no Doppler solution". */
function usableSpeed(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export class AlongTrackFilter {
  private readonly positionNoiseM: number;
  private readonly minPositionNoiseM: number;
  private readonly maxPositionNoiseM: number;
  private readonly dopplerNoiseMps: number;
  private readonly dopplerProjectionFraction: number;
  private readonly accelerationNoiseMps2: number;
  private readonly maxGapS: number;
  private readonly innovationSigmaGate: number;
  private readonly maxOutlierRun: number;
  private readonly reverseResetM: number;
  private readonly convergenceFraction: number;
  private readonly minSamplesForConvergence: number;

  private hasState = false;
  private s = 0;
  private v = 0;
  private p00 = 0;
  private p01 = 0;
  private p11 = 0;
  private lastTMono = 0;
  private lastMeasuredM = 0;
  private samplesSinceReset = 0;
  private outlierRun = 0;
  private resets = 0;

  constructor(config: AlongTrackFilterConfig = {}) {
    this.positionNoiseM = positiveFinite(
      config.positionNoiseM,
      DEFAULT_POSITION_NOISE_M,
      'positionNoiseM',
    );
    this.minPositionNoiseM = positiveFinite(
      config.minPositionNoiseM,
      DEFAULT_MIN_POSITION_NOISE_M,
      'minPositionNoiseM',
    );
    this.maxPositionNoiseM = positiveFinite(
      config.maxPositionNoiseM,
      DEFAULT_MAX_POSITION_NOISE_M,
      'maxPositionNoiseM',
    );
    if (this.maxPositionNoiseM < this.minPositionNoiseM) {
      throw new RangeError('maxPositionNoiseM must not be below minPositionNoiseM');
    }
    this.dopplerNoiseMps = positiveFinite(
      config.dopplerNoiseMps,
      DEFAULT_DOPPLER_NOISE_MPS,
      'dopplerNoiseMps',
    );
    this.dopplerProjectionFraction = nonNegativeFinite(
      config.dopplerProjectionFraction,
      DEFAULT_PROJECTION_FRACTION,
      'dopplerProjectionFraction',
    );
    this.accelerationNoiseMps2 = positiveFinite(
      config.accelerationNoiseMps2,
      DEFAULT_ACCELERATION_NOISE_MPS2,
      'accelerationNoiseMps2',
    );
    this.maxGapS = positiveFinite(config.maxGapS, DEFAULT_MAX_GAP_S, 'maxGapS');
    this.innovationSigmaGate = positiveFinite(
      config.innovationSigmaGate,
      DEFAULT_INNOVATION_SIGMA_GATE,
      'innovationSigmaGate',
    );
    const outlierRun = config.maxOutlierRun ?? DEFAULT_MAX_OUTLIER_RUN;
    if (!Number.isInteger(outlierRun) || outlierRun < 1) {
      throw new RangeError('maxOutlierRun must be a positive integer');
    }
    this.maxOutlierRun = outlierRun;
    this.reverseResetM = positiveFinite(
      config.reverseResetM,
      DEFAULT_REVERSE_RESET_M,
      'reverseResetM',
    );
    const convergence = config.convergenceFraction ?? DEFAULT_CONVERGENCE_FRACTION;
    if (!Number.isFinite(convergence) || convergence <= 0 || convergence >= 1) {
      throw new RangeError('convergenceFraction must lie strictly between zero and one');
    }
    this.convergenceFraction = convergence;
    const minSamples = config.minSamplesForConvergence ?? DEFAULT_MIN_SAMPLES_FOR_CONVERGENCE;
    if (!Number.isInteger(minSamples) || minSamples < 1) {
      throw new RangeError('minSamplesForConvergence must be a positive integer');
    }
    this.minSamplesForConvergence = minSamples;
  }

  /** Drops all state. The next observation re-seeds from scratch and is not converged. */
  reset(): void {
    this.hasState = false;
    this.s = 0;
    this.v = 0;
    this.p00 = 0;
    this.p01 = 0;
    this.p11 = 0;
    this.lastTMono = 0;
    this.lastMeasuredM = 0;
    this.samplesSinceReset = 0;
    this.outlierRun = 0;
    this.resets = 0;
  }

  /** How many times the filter re-seeded itself (gaps, teleports, reverse travel, bad numbers). */
  get resetCount(): number {
    return this.resets;
  }

  /** The current posterior, or null before the first observation. */
  current(): AlongTrackEstimate | null {
    if (!this.hasState) return null;
    return {
      tMono: this.lastTMono,
      distanceM: this.s,
      speedMps: this.v,
      distanceSigmaM: Math.sqrt(Math.max(0, this.p00)),
      converged: this.isConverged(),
    };
  }

  /**
   * Pushes one fix through the filter and returns the new posterior. Returns
   * null only when the observation itself is unusable (non-finite), in which
   * case the filter has reset and the next good fix re-seeds it.
   */
  observe(observation: AlongTrackObservation): AlongTrackEstimate | null {
    const { tMono, measuredDistanceM } = observation;
    if (!Number.isFinite(tMono) || !Number.isFinite(measuredDistanceM)) {
      this.dropState();
      return null;
    }

    const measurementNoiseM = this.positionNoiseFor(observation.accuracyM);
    const speed = usableSpeed(observation.speedMps);

    if (!this.hasState) {
      this.seed(tMono, measuredDistanceM, speed, measurementNoiseM);
      return this.current();
    }

    const dtS = (tMono - this.lastTMono) / 1_000;
    const backwardsM = this.lastMeasuredM - measuredDistanceM;
    if (!Number.isFinite(dtS) || dtS <= 0 || dtS > this.maxGapS || backwardsM > this.reverseResetM) {
      this.seed(tMono, measuredDistanceM, speed, measurementNoiseM);
      return this.current();
    }

    // ---- time update: F P F^T + Q, with Q the white-noise-acceleration form.
    const p00 = this.p00 + dtS * (this.p01 + this.p01) + dtS * dtS * this.p11;
    const p01 = this.p01 + dtS * this.p11;
    const p11 = this.p11;
    const q = this.accelerationNoiseMps2 * this.accelerationNoiseMps2;
    let a00 = p00 + (q * dtS * dtS * dtS * dtS) / 4;
    let a01 = p01 + (q * dtS * dtS * dtS) / 2;
    let a11 = p11 + q * dtS * dtS;
    let s = this.s + this.v * dtS;
    let v = this.v;

    // ---- measurement 1: Doppler speed (H = [0, 1]). Applied first so its
    // information reaches `s` through the Q cross-term -- see the header.
    if (speed !== null) {
      const projection = this.dopplerProjectionFraction * speed;
      const rv = this.dopplerNoiseMps * this.dopplerNoiseMps + projection * projection;
      const innovationVariance = a11 + rv;
      if (innovationVariance > 0) {
        const k0 = a01 / innovationVariance;
        const k1 = a11 / innovationVariance;
        const innovation = speed - v;
        s += k0 * innovation;
        v += k1 * innovation;
        const n00 = a00 - k0 * a01;
        const n01 = a01 - k0 * a11;
        const n11 = a11 - k1 * a11;
        a00 = n00;
        a01 = n01;
        a11 = n11;
      }
    }

    // ---- measurement 2: projected GPS distance (H = [1, 0]), innovation-gated.
    const rs = measurementNoiseM * measurementNoiseM;
    const innovationVariance = a00 + rs;
    const innovation = measuredDistanceM - s;
    const gate = this.innovationSigmaGate * Math.sqrt(Math.max(innovationVariance, 0));
    if (Math.abs(innovation) > gate) {
      this.outlierRun += 1;
      if (this.outlierRun >= this.maxOutlierRun) {
        // Two disagreements in a row are the world, not the sensor. Re-seed
        // rather than keep rejecting -- that is the wedge this must not hit.
        this.seed(tMono, measuredDistanceM, speed, measurementNoiseM);
        return this.current();
      }
      // One-off: keep the propagated state, do not correct.
      return this.commit(tMono, measuredDistanceM, s, v, a00, a01, a11, false);
    }
    this.outlierRun = 0;

    if (innovationVariance > 0) {
      const k0 = a00 / innovationVariance;
      const k1 = a01 / innovationVariance;
      s += k0 * innovation;
      v += k1 * innovation;
      const n00 = a00 - k0 * a00;
      const n01 = a01 - k0 * a01;
      const n11 = a11 - k1 * a01;
      a00 = n00;
      a01 = n01;
      a11 = n11;
    }
    return this.commit(tMono, measuredDistanceM, s, v, a00, a01, a11, true);
  }

  private commit(
    tMono: number,
    measuredDistanceM: number,
    s: number,
    v: number,
    p00: number,
    p01: number,
    p11: number,
    counted: boolean,
  ): AlongTrackEstimate | null {
    if (
      !Number.isFinite(s) ||
      !Number.isFinite(v) ||
      !Number.isFinite(p00) ||
      !Number.isFinite(p01) ||
      !Number.isFinite(p11) ||
      p00 < 0 ||
      p11 < 0
    ) {
      // Numerically dead. Re-seed from the measurement we do trust.
      this.seed(tMono, measuredDistanceM, null, this.positionNoiseM);
      return this.current();
    }
    this.s = s;
    this.v = v;
    this.p00 = p00;
    this.p01 = p01;
    this.p11 = p11;
    this.lastTMono = tMono;
    this.lastMeasuredM = measuredDistanceM;
    if (counted) this.samplesSinceReset += 1;
    return this.current();
  }

  private seed(
    tMono: number,
    measuredDistanceM: number,
    speed: number | null,
    measurementNoiseM: number,
  ): void {
    if (this.hasState) this.resets += 1;
    this.hasState = true;
    this.s = measuredDistanceM;
    this.v = speed ?? 0;
    this.p00 = measurementNoiseM * measurementNoiseM;
    this.p01 = 0;
    this.p11 = speed === null ? SEED_SPEED_VARIANCE : this.dopplerVariance(speed);
    this.lastTMono = tMono;
    this.lastMeasuredM = measuredDistanceM;
    this.samplesSinceReset = 1;
    this.outlierRun = 0;
  }

  private dropState(): void {
    if (this.hasState) this.resets += 1;
    this.hasState = false;
    this.samplesSinceReset = 0;
    this.outlierRun = 0;
  }

  private dopplerVariance(speed: number): number {
    const projection = this.dopplerProjectionFraction * speed;
    return this.dopplerNoiseMps * this.dopplerNoiseMps + projection * projection;
  }

  private positionNoiseFor(accuracyM: number | undefined): number {
    if (accuracyM === undefined || !Number.isFinite(accuracyM) || accuracyM <= 0) {
      return this.positionNoiseM;
    }
    return Math.min(this.maxPositionNoiseM, Math.max(this.minPositionNoiseM, accuracyM));
  }

  private isConverged(): boolean {
    if (this.samplesSinceReset < this.minSamplesForConvergence) return false;
    const sigma = Math.sqrt(Math.max(0, this.p00));
    return sigma <= this.convergenceFraction * this.positionNoiseM;
  }
}
