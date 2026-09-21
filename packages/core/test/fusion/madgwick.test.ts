import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MADGWICK_CONFIG, MadgwickAhrs } from '../../src/fusion';
import type { Quaternion, Vector3 } from '../../src/fusion';

const STATIONARY: Vector3 = { x: 0, y: 0, z: 0 };
const LEVEL_GRAVITY: Vector3 = { x: 0, y: 0, z: 1 };

const SETTLE_BETA = 0.5;
const SETTLE_DT_SECONDS = 0.002;

/**
 * Madgwick normalises the gradient before stepping, so each update rotates the
 * estimate by a fixed ~`2 * beta * dt` radians regardless of how small the
 * error already is. A settled filter therefore sits in a limit cycle of that
 * amplitude around the true attitude rather than converging exactly onto it --
 * inherent to the algorithm, not slack in the implementation. Assertions below
 * are made against that bound with a safety factor.
 */
const SETTLED_TOLERANCE_RAD = 2.5 * (2 * SETTLE_BETA * SETTLE_DT_SECONDS);

function magnitude(quaternion: Quaternion): number {
  const { w, x, y, z } = quaternion;
  return Math.sqrt(w * w + x * x + y * y + z * z);
}

function expectSettledNear(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(SETTLED_TOLERANCE_RAD);
}

/** Feeds the same sample repeatedly, as a bench rig holding a fixed attitude. */
function settle(
  filter: MadgwickAhrs,
  accelerometer: Vector3,
  samples = 8000,
  dtSeconds = SETTLE_DT_SECONDS,
): void {
  for (let index = 0; index < samples; index += 1) {
    filter.update(STATIONARY, accelerometer, dtSeconds);
  }
}

describe('MadgwickAhrs', () => {
  it('starts level and normalised', () => {
    const filter = new MadgwickAhrs();
    expect(filter.orientation).toEqual({ w: 1, x: 0, y: 0, z: 0 });
    const { rollRad, pitchRad, yawRad } = filter.euler();
    expect(rollRad).toBeCloseTo(0, 12);
    expect(pitchRad).toBeCloseTo(0, 12);
    expect(yawRad).toBeCloseTo(0, 12);
  });

  it('exposes orientation as a copy that cannot mutate filter state', () => {
    const filter = new MadgwickAhrs();
    const snapshot = filter.orientation;
    snapshot.w = 0.5;
    expect(filter.orientation.w).toBe(1);
  });

  it('holds level attitude when the accelerometer reads pure downward gravity', () => {
    const filter = new MadgwickAhrs();
    settle(filter, LEVEL_GRAVITY, 500);
    const { rollRad, pitchRad } = filter.euler();
    expect(rollRad).toBeCloseTo(0, 6);
    expect(pitchRad).toBeCloseTo(0, 6);
  });

  it('converges to the roll angle implied by a tilted accelerometer', () => {
    const rollRad = (30 * Math.PI) / 180;
    const filter = new MadgwickAhrs({ beta: SETTLE_BETA });
    settle(filter, { x: 0, y: Math.sin(rollRad), z: Math.cos(rollRad) });

    const euler = filter.euler();
    expectSettledNear(euler.rollRad, rollRad);
    expectSettledNear(euler.pitchRad, 0);
  });

  it('converges to the pitch angle implied by a tilted accelerometer', () => {
    const pitchRad = (-20 * Math.PI) / 180;
    // Pitch about the x axis of the earth frame shows up on the sensor x axis.
    const filter = new MadgwickAhrs({ beta: SETTLE_BETA });
    settle(filter, { x: -Math.sin(pitchRad), y: 0, z: Math.cos(pitchRad) });

    const euler = filter.euler();
    expectSettledNear(euler.pitchRad, pitchRad);
    expectSettledNear(euler.rollRad, 0);
  });

  it('recovers gravity direction matching the accelerometer it settled on', () => {
    const rollRad = (15 * Math.PI) / 180;
    const accelerometer = { x: 0, y: Math.sin(rollRad), z: Math.cos(rollRad) };
    const filter = new MadgwickAhrs({ beta: SETTLE_BETA });
    settle(filter, accelerometer);

    const gravity = filter.gravity();
    expectSettledNear(gravity.x, accelerometer.x);
    expectSettledNear(gravity.y, accelerometer.y);
    expectSettledNear(gravity.z, accelerometer.z);
    // Normalisation, unlike attitude, is exact on every update.
    expect(Math.hypot(gravity.x, gravity.y, gravity.z)).toBeCloseTo(1, 9);
  });

  it('integrates a constant yaw rate when no gravity reference is supplied', () => {
    // A zero accelerometer skips the correction step, isolating the gyroscope
    // integration: 90 deg/s for one second must land on 90 degrees of yaw.
    const filter = new MadgwickAhrs();
    const yawRatePerSec = Math.PI / 2;
    for (let index = 0; index < 1000; index += 1) {
      filter.update({ x: 0, y: 0, z: yawRatePerSec }, STATIONARY, 0.001);
    }
    expect(filter.euler().yawRad).toBeCloseTo(Math.PI / 2, 3);
  });

  it('leaves yaw untouched by the accelerometer correction', () => {
    // The 6-axis form has no heading reference, so a level accelerometer must
    // not nudge yaw away from where the gyroscope put it.
    const filter = new MadgwickAhrs({ beta: 0.5 });
    for (let index = 0; index < 500; index += 1) {
      filter.update({ x: 0, y: 0, z: 0.4 }, LEVEL_GRAVITY, 0.002);
    }
    const yawAfterRotation = filter.euler().yawRad;
    settle(filter, LEVEL_GRAVITY, 2000);
    expect(filter.euler().yawRad).toBeCloseTo(yawAfterRotation, 3);
  });

  it('corrects gyroscope drift back towards the accelerometer reference', () => {
    const drifting = new MadgwickAhrs({ beta: 0 });
    const corrected = new MadgwickAhrs({ beta: 0.3 });
    const gyroBias: Vector3 = { x: 0.05, y: 0, z: 0 };

    for (let index = 0; index < 2000; index += 1) {
      drifting.update(gyroBias, LEVEL_GRAVITY, 0.01);
      corrected.update(gyroBias, LEVEL_GRAVITY, 0.01);
    }

    // beta = 0 disables the correction entirely, so the bias integrates freely.
    expect(Math.abs(drifting.euler().rollRad)).toBeGreaterThan(0.5);
    expect(Math.abs(corrected.euler().rollRad)).toBeLessThan(0.2);
  });

  it('keeps the quaternion normalised across arbitrary sample streams', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            gx: fc.double({ min: -20, max: 20, noNaN: true }),
            gy: fc.double({ min: -20, max: 20, noNaN: true }),
            gz: fc.double({ min: -20, max: 20, noNaN: true }),
            ax: fc.double({ min: -30, max: 30, noNaN: true }),
            ay: fc.double({ min: -30, max: 30, noNaN: true }),
            az: fc.double({ min: -30, max: 30, noNaN: true }),
            dt: fc.double({ min: 0.001, max: 0.1, noNaN: true }),
          }),
          { minLength: 1, maxLength: 120 },
        ),
        (samples) => {
          const filter = new MadgwickAhrs();
          for (const sample of samples) {
            filter.update(
              { x: sample.gx, y: sample.gy, z: sample.gz },
              { x: sample.ax, y: sample.ay, z: sample.az },
              sample.dt,
            );
          }
          const orientation = filter.orientation;
          expect(magnitude(orientation)).toBeCloseTo(1, 9);
          expect(Number.isFinite(orientation.w)).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('resets to identity or to a supplied orientation', () => {
    const filter = new MadgwickAhrs({ beta: 0.5 });
    settle(filter, { x: 0, y: 0.6, z: 0.8 }, 500);
    expect(filter.euler().rollRad).not.toBeCloseTo(0, 3);

    filter.reset();
    expect(filter.orientation).toEqual({ w: 1, x: 0, y: 0, z: 0 });

    // A non-unit input is normalised rather than rejected.
    filter.reset({ w: 2, x: 0, y: 0, z: 0 });
    expect(filter.orientation.w).toBeCloseTo(1, 12);
  });

  it('rejects malformed configuration and samples', () => {
    expect(() => new MadgwickAhrs({ beta: -1 })).toThrow(/beta/);
    expect(() => new MadgwickAhrs({ beta: Number.NaN })).toThrow(/beta/);

    const filter = new MadgwickAhrs();
    expect(() => filter.update(STATIONARY, LEVEL_GRAVITY, 0)).toThrow(/dtSeconds/);
    expect(() => filter.update(STATIONARY, LEVEL_GRAVITY, -0.01)).toThrow(/dtSeconds/);
    expect(() => filter.update(STATIONARY, LEVEL_GRAVITY, Number.NaN)).toThrow(/dtSeconds/);
    expect(() =>
      filter.update({ x: Number.NaN, y: 0, z: 0 }, LEVEL_GRAVITY, 0.01),
    ).toThrow(/gyroRadPerSec/);
    expect(() =>
      filter.update(STATIONARY, { x: 0, y: Number.POSITIVE_INFINITY, z: 1 }, 0.01),
    ).toThrow(/accelerometer/);
    expect(() => filter.reset({ w: 0, x: 0, y: 0, z: 0 })).toThrow(/magnitude/);
  });

  it('defaults beta to the documented consumer-MEMS starting point', () => {
    expect(DEFAULT_MADGWICK_CONFIG.beta).toBe(0.1);
    const explicit = new MadgwickAhrs({ beta: DEFAULT_MADGWICK_CONFIG.beta });
    const implicit = new MadgwickAhrs();
    settle(explicit, { x: 0.2, y: 0.1, z: 0.97 }, 200);
    settle(implicit, { x: 0.2, y: 0.1, z: 0.97 }, 200);
    expect(implicit.orientation).toEqual(explicit.orientation);
  });
});
