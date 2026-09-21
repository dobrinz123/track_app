/**
 * Madgwick's gradient-descent attitude filter (IMU form: gyroscope +
 * accelerometer).
 *
 * The gyroscope gives a clean short-term rotation rate that drifts without
 * bound; the accelerometer gives a noisy but drift-free gravity reference.
 * Madgwick fuses them by taking one gradient-descent step per update towards
 * the orientation that best explains the measured gravity direction, then
 * blending that correction into the integrated gyroscope rate. It costs a
 * fraction of an EKF and needs no covariance tuning -- a single gain, `beta`.
 *
 * Scope decision -- no magnetometer. The published MARG (9-axis) form adds an
 * absolute heading reference from the magnetometer, but a phone inside a steel
 * car body sits in a badly distorted magnetic field, and on track we already
 * have a better heading source in GNSS course-over-ground. Feeding a distorted
 * magnetometer into the filter would corrupt roll and pitch too, so this
 * implementation deliberately stops at the 6-axis form: roll and pitch are
 * observable and trustworthy, yaw is dead-reckoned from the gyroscope and
 * drifts. Do not treat `yawRad` as a compass heading.
 *
 * Implemented natively rather than taken as a dependency: the candidate npm
 * package ships contradictory licence metadata (Apache-2.0 in its LICENSE file,
 * APSL-2.0 in its package.json), which is not a risk worth carrying into a
 * shipped binary for ~150 lines of published, well-documented algorithm.
 */

/** Right-handed sensor-frame vector: x right, y forward, z up. */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** Unit quaternion, scalar-first, rotating sensor frame to earth frame. */
export interface Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;
}

/** Aircraft-sequence (ZYX) Euler angles in radians. */
export interface EulerAngles {
  rollRad: number;
  pitchRad: number;
  yawRad: number;
}

export interface MadgwickAhrsConfig {
  /**
   * Filter gain, in the same units as gyroscope error (rad/s). Larger values
   * trust the accelerometer more: faster convergence and less gyro drift, but
   * more of the vehicle's own linear acceleration leaks into the attitude
   * estimate. Madgwick's paper derives beta as the expected gyroscope drift
   * rate; 0.1 is the usual starting point for consumer MEMS sensors.
   */
  beta: number;
}

export const DEFAULT_MADGWICK_CONFIG: MadgwickAhrsConfig = { beta: 0.1 };

const IDENTITY: Quaternion = { w: 1, x: 0, y: 0, z: 0 };

function assertFiniteVector(vector: Vector3, name: string): void {
  if (!Number.isFinite(vector.x) || !Number.isFinite(vector.y) || !Number.isFinite(vector.z)) {
    throw new RangeError(`${name} components must be finite numbers`);
  }
}

function normaliseQuaternion(quaternion: Quaternion): Quaternion {
  const { w, x, y, z } = quaternion;
  const magnitude = Math.sqrt(w * w + x * x + y * y + z * z);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) {
    throw new RangeError('quaternion must have a positive finite magnitude');
  }
  return { w: w / magnitude, x: x / magnitude, y: y / magnitude, z: z / magnitude };
}

/**
 * Stateful attitude estimator. One instance tracks one sensor stream; feed it
 * every IMU sample in order via {@link MadgwickAhrs.update}.
 */
export class MadgwickAhrs {
  private readonly beta: number;
  private quaternion: Quaternion = IDENTITY;

  constructor(config: Partial<MadgwickAhrsConfig> = {}) {
    const beta = config.beta ?? DEFAULT_MADGWICK_CONFIG.beta;
    if (!Number.isFinite(beta) || beta < 0) {
      throw new RangeError('beta must be a non-negative finite number');
    }
    this.beta = beta;
  }

  /** Current orientation as a defensive copy. */
  get orientation(): Quaternion {
    return { ...this.quaternion };
  }

  /**
   * Returns the filter to a known orientation, defaulting to identity (level,
   * facing the sensor-frame y axis). Call this when the sample stream breaks --
   * a new session, or a gap long enough that integrating across it is a lie.
   */
  reset(orientation: Quaternion = IDENTITY): void {
    this.quaternion = normaliseQuaternion(orientation);
  }

  /**
   * Advances the estimate by one sample.
   *
   * `gyroRadPerSec` is the body rotation rate and `accelerometer` the measured
   * specific force -- units are irrelevant because it is normalised, but the
   * axes must match the gyroscope's. A zero-magnitude accelerometer reading
   * carries no gravity direction, so the correction step is skipped and the
   * sample integrates on the gyroscope alone.
   */
  update(gyroRadPerSec: Vector3, accelerometer: Vector3, dtSeconds: number): Quaternion {
    assertFiniteVector(gyroRadPerSec, 'gyroRadPerSec');
    assertFiniteVector(accelerometer, 'accelerometer');
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      throw new RangeError('dtSeconds must be a positive finite number');
    }

    const { w, x, y, z } = this.quaternion;
    const { x: gx, y: gy, z: gz } = gyroRadPerSec;

    // Quaternion derivative from the measured rotation rate.
    let rateW = 0.5 * (-x * gx - y * gy - z * gz);
    let rateX = 0.5 * (w * gx + y * gz - z * gy);
    let rateY = 0.5 * (w * gy - x * gz + z * gx);
    let rateZ = 0.5 * (w * gz + x * gy - y * gx);

    const accelMagnitude = Math.sqrt(
      accelerometer.x * accelerometer.x +
        accelerometer.y * accelerometer.y +
        accelerometer.z * accelerometer.z,
    );

    if (accelMagnitude > 0 && this.beta > 0) {
      const ax = accelerometer.x / accelMagnitude;
      const ay = accelerometer.y / accelMagnitude;
      const az = accelerometer.z / accelMagnitude;

      // Objective function: predicted gravity direction minus the measured one.
      const errorX = 2 * (x * z - w * y) - ax;
      const errorY = 2 * (w * x + y * z) - ay;
      const errorZ = 1 - 2 * (x * x + y * y) - az;

      // Gradient = J^T * f, with J the Jacobian of the objective above.
      const gradientW = -2 * y * errorX + 2 * x * errorY;
      const gradientX = 2 * z * errorX + 2 * w * errorY - 4 * x * errorZ;
      const gradientY = -2 * w * errorX + 2 * z * errorY - 4 * y * errorZ;
      const gradientZ = 2 * x * errorX + 2 * y * errorY;

      const gradientMagnitude = Math.sqrt(
        gradientW * gradientW +
          gradientX * gradientX +
          gradientY * gradientY +
          gradientZ * gradientZ,
      );

      // A zero gradient means the estimate already explains the measurement.
      if (gradientMagnitude > 0) {
        rateW -= (this.beta * gradientW) / gradientMagnitude;
        rateX -= (this.beta * gradientX) / gradientMagnitude;
        rateY -= (this.beta * gradientY) / gradientMagnitude;
        rateZ -= (this.beta * gradientZ) / gradientMagnitude;
      }
    }

    this.quaternion = normaliseQuaternion({
      w: w + rateW * dtSeconds,
      x: x + rateX * dtSeconds,
      y: y + rateY * dtSeconds,
      z: z + rateZ * dtSeconds,
    });
    return this.orientation;
  }

  /**
   * Current attitude as Euler angles. `yawRad` is gyro-integrated and drifts;
   * see the module note on why there is no magnetometer.
   */
  euler(): EulerAngles {
    const { w, x, y, z } = this.quaternion;
    const sinePitch = 2 * (w * y - z * x);
    const clampedSinePitch = sinePitch > 1 ? 1 : sinePitch < -1 ? -1 : sinePitch;
    return {
      rollRad: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
      pitchRad: Math.asin(clampedSinePitch),
      yawRad: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
    };
  }

  /**
   * Unit vector along gravity as the current attitude predicts the
   * accelerometer should measure it. Subtracting `gravity * g` from a raw
   * accelerometer sample leaves the vehicle's own linear acceleration -- the
   * longitudinal and lateral g the coaching engine cares about.
   *
   * MIND THE DIRECTION -- AND DO NOT ASSUME IT. This filter has no opinion of
   * its own about which way is up: it drives this vector towards whatever the
   * normalised accelerometer reading is, so the direction it settles on is
   * entirely the SENSOR's convention, and the two mobile platforms disagree.
   *
   *   Android (`Sensor.TYPE_ACCELEROMETER`, specific force): a device at rest
   *     reads +1 g along the axis pointing SKYWARD. This vector points UP.
   *   iOS (Core Motion `CMAccelerometerData.acceleration`): a device at rest
   *     face-up reads z = -1. This vector points DOWN.
   *
   * (expo-sensors forwards Core Motion unchanged on iOS and only rescales by
   * `GRAVITY_EARTH` on Android, so it does not reconcile the two.)
   *
   * Either way this is the estimated VERTICAL in sensor coordinates, which is
   * what lets a caller build a mount-independent yaw axis by projecting the
   * gyroscope onto it. But the SIGN of that projection depends on the
   * convention above, so a caller must establish which one its input follows
   * rather than assuming -- getting it backwards silently reverses every
   * measured rotation. See `apps/mobile/src/session/gforceProvider.ts`.
   *
   * The subtraction described above is unaffected: removing this vector from
   * the raw sample isolates linear acceleration under either convention.
   */
  gravity(): Vector3 {
    const { w, x, y, z } = this.quaternion;
    return {
      x: 2 * (x * z - w * y),
      y: 2 * (w * x + y * z),
      z: 1 - 2 * (x * x + y * y),
    };
  }
}
