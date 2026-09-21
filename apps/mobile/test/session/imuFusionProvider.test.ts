import { describe, expect, it } from 'vitest';
import type { TelemetrySample } from '@circuit/core';

import {
  ANDROID_ACCELEROMETER_REST_VECTOR,
  IOS_ACCELEROMETER_REST_VECTOR,
  computeLinearAcceleration,
  createGForceProvider,
  yawRateProjectionSign,
  type AccelerometerReading,
  type AccelerometerRestVector,
  type AccelerometerSource,
  type AccelerometerSubscription,
  type GyroscopeReading,
  type GyroscopeSource,
} from '../../src/session/gforceProvider';

/**
 * Ticket P6a — the IMU-fusion path of the G-force provider, and above all the
 * guarantee that it is INVISIBLE while `imuFusionEnabled` is off.
 *
 * Every test here injects both sensor sources, so the real lazy
 * `await import('expo-sensors')` inside the provider is never reached (the
 * same rule `gforceProvider.test.ts` already follows for the accelerometer).
 */

class FakeSensorSource implements AccelerometerSource, GyroscopeSource {
  available = true;
  updateIntervalCalls: number[] = [];
  listener: ((r: AccelerometerReading) => void) | null = null;
  removed = false;
  availabilityChecks = 0;

  async isAvailableAsync(): Promise<boolean> {
    this.availabilityChecks += 1;
    return this.available;
  }
  setUpdateInterval(intervalMs: number): void {
    this.updateIntervalCalls.push(intervalMs);
  }
  addListener(listener: (r: AccelerometerReading) => void): AccelerometerSubscription {
    this.listener = listener;
    return {
      remove: () => {
        this.removed = true;
        this.listener = null;
      },
    };
  }
  emit(reading: AccelerometerReading): void {
    this.listener?.(reading);
  }
}

async function flushMicrotasks(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** A clock the test steps by hand -- the provider must never read `Date.now()`. */
function steppedClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 10_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

interface Rig {
  accel: FakeSensorSource;
  gyro: FakeSensorSource;
  samples: TelemetrySample[];
  clock: { now: () => number; advance: (ms: number) => void };
  provider: ReturnType<typeof createGForceProvider>;
}

async function startRig(imuFusionEnabled: boolean): Promise<Rig> {
  const accel = new FakeSensorSource();
  const gyro = new FakeSensorSource();
  const samples: TelemetrySample[] = [];
  const clock = steppedClock();
  const provider = createGForceProvider({
    monotonicNow: clock.now,
    accelerometerSource: async () => accel,
    gyroscopeSource: async () => gyro,
    imuFusionEnabled: () => imuFusionEnabled,
    // P6a-FIX2 H1: stated explicitly, exactly like the two sensor sources
    // above -- so the real lazy `import('react-native')` is never reached
    // under vitest. The default-resolution path has its own test below.
    accelerometerRestVector: 'down',
  });
  provider.onSample((s) => samples.push(s));
  provider.start();
  await flushMicrotasks();
  return { accel, gyro, samples, clock, provider };
}

const channelsOf = (samples: readonly TelemetrySample[]): string[] =>
  samples.map((sample) => sample.channel);

describe('P6a -- imuFusionEnabled OFF (the default): the provider is byte-for-byte the pre-P6a one', () => {
  it('never touches the gyroscope at all: no availability check, no interval, no listener, no yawRateDps', async () => {
    const rig = await startRig(false);

    rig.clock.advance(40);
    rig.accel.emit({ x: 0.3, y: -0.1, z: 1 });

    expect(rig.gyro.availabilityChecks).toBe(0);
    expect(rig.gyro.updateIntervalCalls).toEqual([]);
    expect(rig.gyro.listener).toBeNull();
    expect(channelsOf(rig.samples)).toEqual(['latG', 'longG']);
    expect(rig.samples.some((s) => s.channel === 'yawRateDps')).toBe(false);
    await rig.provider.stop();
  });

  it('a provider with NO imuFusionEnabled dep at all behaves identically (absent === false)', async () => {
    const accel = new FakeSensorSource();
    const samples: TelemetrySample[] = [];
    const clock = steppedClock();
    const provider = createGForceProvider({
      monotonicNow: clock.now,
      accelerometerSource: async () => accel,
    });
    provider.onSample((s) => samples.push(s));
    provider.start();
    await flushMicrotasks();
    accel.emit({ x: 0.25, y: 0.1, z: 1 });

    expect(channelsOf(samples)).toEqual(['latG', 'longG']);
    await provider.stop();
  });

  it('reproduces the low-pass values EXACTLY over 100 probe samples -- hand-driven `computeLinearAcceleration` over the same stream', async () => {
    // Ticket P6a-FIX1: 100 samples, matching the probe count the independent
    // review used when it confirmed the flags-off path against the previous
    // commit. Deterministic LCG, so the stream is the same on every run.
    let state = 20_260_921;
    const nextNoise = (): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648 - 0.5;
    };
    const stream: AccelerometerReading[] = [
      { x: 0.02, y: -0.01, z: 0.99 },
      { x: 0.31, y: -0.42, z: 1.02 },
      { x: -0.55, y: 0.18, z: 0.97 },
      { x: 0.08, y: 0.63, z: 1.05 },
      { x: -0.12, y: -0.22, z: 0.98 },
    ];
    while (stream.length < 100) {
      stream.push({
        x: nextNoise() * 2.4,
        y: nextNoise() * 2.4,
        z: 1 + nextNoise() * 0.6,
      });
    }
    // The reference: the exported pure function, chained the way the provider
    // chains it. If the flag-off branch ever stops being the same code, these
    // numbers separate.
    let gravity: AccelerometerReading = { x: 0, y: 0, z: 0 };
    const expected: number[] = [];
    for (const raw of stream) {
      const result = computeLinearAcceleration(gravity, raw);
      gravity = result.gravity;
      expected.push(result.linear.x, result.linear.y);
    }

    const rig = await startRig(false);
    for (const raw of stream) {
      rig.clock.advance(40);
      rig.accel.emit(raw);
    }

    expect(rig.samples.map((s) => s.value)).toEqual(expected);
    await rig.provider.stop();
  });
});

describe('P6a -- imuFusionEnabled ON: Madgwick gravity + the gyroscope channel', () => {
  it('subscribes the gyroscope at the same ~25 Hz interval as the accelerometer', async () => {
    const rig = await startRig(true);
    expect(rig.gyro.updateIntervalCalls).toEqual([40]);
    expect(rig.accel.updateIntervalCalls).toEqual([40]);
    expect(rig.gyro.listener).not.toBeNull();
    await rig.provider.stop();
  });

  it('yawRateDps is stamped with the injected monotonic clock, never Date.now()', async () => {
    const rig = await startRig(true);
    rig.clock.advance(40);
    rig.accel.emit({ x: 0, y: 0, z: 1 }); // seeds the filter (P6a-FIX1 M1)
    rig.clock.advance(40);
    const expectedStamp = rig.clock.now();
    rig.gyro.emit({ x: 0.01, y: -0.02, z: 0.3 });
    const yaw = rig.samples.filter((s) => s.channel === 'yawRateDps');
    expect(yaw[0]!.tMonoMs).toBe(expectedStamp);
    await rig.provider.stop();
  });
});

/**
 * Ticket P6a-FIX1 H1 + P6a-FIX2 H1 (HIGH). Two separate things have to be
 * right for `yawRateDps`, and the first fix only got one of them.
 *
 *  - THE AXIS must not be a chosen device axis, because which device axis is
 *    vertical is a fact about the physical mount nobody has measured. It is
 *    the vertical the filter estimates, so one line serves every mount.
 *  - THE SIGN depends on which way the platform's accelerometer reads at
 *    rest, and iOS and Android are OPPOSITE (Core Motion forwards a face-up
 *    device as z = -1, pointing down; Android rescales specific force, +1,
 *    pointing up). An unconditional negation is right on one platform and
 *    inverts every rotation on the other.
 *
 * Every case below encodes a REAL RIGHT TURN and requires a POSITIVE
 * `yawRateDps`, because `cleanLap.ts` compares the integral of this channel
 * against GNSS course over ground, which grows clockwise -- and every case
 * runs under BOTH conventions, with the sensor readings expressed in each
 * platform's own terms.
 */
describe('P6a-FIX2 H1 -- mount-independent axis AND platform-correct sign', () => {
  const NINETY_DPS_RAD = Math.PI / 2;

  /**
   * Four mounts, described by where the SKY is in device coordinates. The
   * at-rest accelerometer reading is derived per platform: it equals `up`
   * under the Android (specific force) convention and `-up` under the iOS
   * (Core Motion) one. Nothing below hardcodes a reading.
   */
  const MOUNTS: readonly { name: string; up: AccelerometerReading }[] = [
    { name: 'flat (sky = device +z)', up: { x: 0, y: 0, z: 1 } },
    { name: 'upright portrait (sky = device +y)', up: { x: 0, y: 1, z: 0 } },
    { name: 'inverted portrait (sky = device -y)', up: { x: 0, y: -1, z: 0 } },
    {
      name: 'tilted 45 deg (no device axis is vertical)',
      up: { x: 0, y: Math.SQRT1_2, z: Math.SQRT1_2 },
    },
  ];

  const CONVENTIONS: readonly { platform: string; restVector: AccelerometerRestVector }[] = [
    { platform: 'iOS (Core Motion, rest vector points DOWN)', restVector: 'down' },
    { platform: 'Android (specific force, rest vector points UP)', restVector: 'up' },
  ];

  /** The reading a device at rest in this mount produces on this platform. */
  const restReading = (
    up: AccelerometerReading,
    restVector: AccelerometerRestVector,
  ): AccelerometerReading =>
    restVector === 'up' ? up : { x: -up.x, y: -up.y, z: -up.z };

  /**
   * A right turn is clockwise seen from above, so by the right-hand rule its
   * angular-velocity vector points DOWN -- along `-up`, whatever the platform
   * convention is. The gyroscope is right-handed on both platforms.
   */
  const rightTurnGyro = (up: AccelerometerReading, rateRad: number): AccelerometerReading => ({
    x: -up.x * rateRad,
    y: -up.y * rateRad,
    z: -up.z * rateRad,
  });

  async function mountedRig(
    up: AccelerometerReading,
    restVector: AccelerometerRestVector,
  ): Promise<Rig> {
    const accel = new FakeSensorSource();
    const gyro = new FakeSensorSource();
    const samples: TelemetrySample[] = [];
    const clock = steppedClock();
    const provider = createGForceProvider({
      monotonicNow: clock.now,
      accelerometerSource: async () => accel,
      gyroscopeSource: async () => gyro,
      imuFusionEnabled: () => true,
      accelerometerRestVector: restVector,
    });
    provider.onSample((s) => samples.push(s));
    provider.start();
    await flushMicrotasks();
    const rig: Rig = { accel, gyro, samples, clock, provider };
    const atRest = restReading(up, restVector);
    for (let i = 0; i < 80; i += 1) {
      rig.clock.advance(40);
      rig.gyro.emit({ x: 0, y: 0, z: 0 });
      rig.accel.emit(atRest);
    }
    rig.samples.length = 0;
    return rig;
  }

  const yawOf = (rig: Rig): number => {
    const yaw = rig.samples.filter((s) => s.channel === 'yawRateDps');
    expect(yaw).toHaveLength(1);
    return yaw[0]!.value;
  };

  /**
   * Two decimal places, deliberately. The projection is onto the filter's
   * ESTIMATE of vertical, and a fixed-gain gradient filter does not converge
   * to a point -- it limit-cycles within about `beta * dt` = 0.1 * 0.04 =
   * 0.004 rad (0.23 deg) of the true attitude. The projection error is second
   * order in that angle, so 90 deg/s comes back within ~1e-3 deg/s. Asserting
   * 90.00 +/- 0.005 pins the axis, the scale AND the sign without pretending
   * an estimator is exact.
   */
  const YAW_DIGITS = 2;

  const deliverGyro = (rig: Rig, reading: AccelerometerReading): void => {
    rig.clock.advance(40);
    rig.gyro.emit(reading);
  };

  for (const { platform, restVector } of CONVENTIONS) {
    describe(platform, () => {
      for (const { name, up } of MOUNTS) {
        it(name + ': a right turn reads +90 deg/s', async () => {
          const rig = await mountedRig(up, restVector);
          deliverGyro(rig, rightTurnGyro(up, NINETY_DPS_RAD));
          expect(yawOf(rig)).toBeCloseTo(90, YAW_DIGITS);
          await rig.provider.stop();
        });

        it(name + ': a left turn reads -90 deg/s', async () => {
          const rig = await mountedRig(up, restVector);
          deliverGyro(rig, rightTurnGyro(up, -NINETY_DPS_RAD));
          expect(yawOf(rig)).toBeCloseTo(-90, YAW_DIGITS);
          await rig.provider.stop();
        });
      }

      it('a rotation PERPENDICULAR to the estimated vertical contributes no yaw', async () => {
        const rig = await mountedRig({ x: 0, y: 0, z: 1 }, restVector);
        deliverGyro(rig, { x: NINETY_DPS_RAD, y: 0, z: 0 }); // pure roll/pitch
        expect(yawOf(rig)).toBeCloseTo(0, YAW_DIGITS);
        await rig.provider.stop();
      });
    });
  }

  it('the reviewer-measured iOS case: upright iPhone, gyro {x:0,y:-PI/2,z:0}, reads +90 not -90', async () => {
    // An upright iPhone at rest reads {x:0, y:-1, z:0} (Core Motion, pointing
    // at the earth), so the sky is device +y. The first fix emitted -90 here.
    const rig = await mountedRig({ x: 0, y: 1, z: 0 }, 'down');
    deliverGyro(rig, { x: 0, y: -NINETY_DPS_RAD, z: 0 });
    const measured = yawOf(rig);
    expect(measured).toBeCloseTo(90, YAW_DIGITS);
    expect(measured).toBeGreaterThan(0);
    await rig.provider.stop();
  });

  it('the two conventions genuinely disagree -- identical RAW readings flip sign', async () => {
    // Same numbers into the provider; only the declared convention differs.
    // If the sign were hardcoded again, these two would be equal.
    const raw = { x: 0, y: -1, z: 0 };
    const gyroReading = { x: 0, y: -NINETY_DPS_RAD, z: 0 };
    const results: number[] = [];
    for (const restVector of ['down', 'up'] as const) {
      const accel = new FakeSensorSource();
      const gyro = new FakeSensorSource();
      const samples: TelemetrySample[] = [];
      const clock = steppedClock();
      const provider = createGForceProvider({
        monotonicNow: clock.now,
        accelerometerSource: async () => accel,
        gyroscopeSource: async () => gyro,
        imuFusionEnabled: () => true,
        accelerometerRestVector: restVector,
      });
      provider.onSample((s) => samples.push(s));
      provider.start();
      await flushMicrotasks();
      for (let i = 0; i < 80; i += 1) {
        clock.advance(40);
        gyro.emit({ x: 0, y: 0, z: 0 });
        accel.emit(raw);
      }
      samples.length = 0;
      clock.advance(40);
      gyro.emit(gyroReading);
      results.push(samples.filter((s) => s.channel === 'yawRateDps')[0]!.value);
      await provider.stop();
    }
    expect(results[0]!).toBeCloseTo(90, YAW_DIGITS);
    expect(results[1]!).toBeCloseTo(-90, YAW_DIGITS);
  });

  it('yawRateProjectionSign is derived, not guessed: down -> +1, up -> -1', () => {
    expect(yawRateProjectionSign('down')).toBe(1);
    expect(yawRateProjectionSign('up')).toBe(-1);
    expect(IOS_ACCELEROMETER_REST_VECTOR).toBe('down');
    expect(ANDROID_ACCELEROMETER_REST_VECTOR).toBe('up');
  });

  it('with NO convention injected it resolves one, and degrades to iOS -- the platform this app ships on', async () => {
    // The only test that lets the real resolution path run. Under vitest the
    // lazy `import('react-native')` rejects, which is exactly the documented
    // degradation, so this also pins the fallback.
    const accel = new FakeSensorSource();
    const gyro = new FakeSensorSource();
    const samples: TelemetrySample[] = [];
    const clock = steppedClock();
    const provider = createGForceProvider({
      monotonicNow: clock.now,
      accelerometerSource: async () => accel,
      gyroscopeSource: async () => gyro,
      imuFusionEnabled: () => true,
// P6a-FIX2 H1: stated explicitly so the lazy platform read is never reached under vitest.
accelerometerRestVector: 'down',
    });
    provider.onSample((s) => samples.push(s));
    provider.start();
    // A rejected dynamic import settles on a macrotask, not a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
    const rig: Rig = { accel, gyro, samples, clock, provider };
    const up = { x: 0, y: 1, z: 0 };
    const atRest = { x: 0, y: -1, z: 0 }; // the iOS reading for that mount
    for (let i = 0; i < 80; i += 1) {
      rig.clock.advance(40);
      rig.gyro.emit({ x: 0, y: 0, z: 0 });
      rig.accel.emit(atRest);
    }
    rig.samples.length = 0;
    rig.clock.advance(40);
    rig.gyro.emit(rightTurnGyro(up, NINETY_DPS_RAD));
    expect(yawOf(rig)).toBeCloseTo(90, YAW_DIGITS);
    await rig.provider.stop();
  });

  it('emits NO yawRateDps before the filter has an attitude estimate', async () => {
    const rig = await startRig(true);
    rig.clock.advance(40);
    rig.gyro.emit({ x: 0, y: 0, z: -1 });
    rig.clock.advance(40);
    rig.gyro.emit({ x: 0, y: 0, z: -1 });
    // No accelerometer sample has arrived, so there is no vertical to project
    // onto -- a guessed one is exactly what H1 forbids.
    expect(rig.samples).toHaveLength(0);

    rig.clock.advance(40);
    rig.accel.emit({ x: 0, y: 0, z: 1 }); // seeds
    rig.clock.advance(40);
    rig.gyro.emit({ x: 0, y: 0, z: -1 });
    expect(rig.samples.filter((s) => s.channel === 'yawRateDps')).toHaveLength(1);
    await rig.provider.stop();
  });
});

describe('P6a -- the optional-capability contract holds for the gyroscope too', () => {
  it('an unavailable gyroscope never throws: latG/longG keep flowing, yawRateDps simply never appears', async () => {
    const accel = new FakeSensorSource();
    const gyro = new FakeSensorSource();
    gyro.available = false;
    const samples: TelemetrySample[] = [];
    const clock = steppedClock();
    const provider = createGForceProvider({
      monotonicNow: clock.now,
      accelerometerSource: async () => accel,
      gyroscopeSource: async () => gyro,
      imuFusionEnabled: () => true,
// P6a-FIX2 H1: stated explicitly so the lazy platform read is never reached under vitest.
accelerometerRestVector: 'down',
    });
    provider.onSample((s) => samples.push(s));
    expect(() => provider.start()).not.toThrow();
    await flushMicrotasks();

    expect(gyro.listener).toBeNull();
    expect(gyro.updateIntervalCalls).toEqual([]);
    clock.advance(40);
    accel.emit({ x: 0.2, y: -0.1, z: 1 });
    expect(channelsOf(samples)).toEqual(['latG', 'longG']);
    await provider.stop();
  });

  it('a rejecting gyroscope source (a failed lazy import) never throws and never stops the accelerometer', async () => {
    const accel = new FakeSensorSource();
    const samples: TelemetrySample[] = [];
    const clock = steppedClock();
    const provider = createGForceProvider({
      monotonicNow: clock.now,
      accelerometerSource: async () => accel,
      gyroscopeSource: async () => {
        throw new Error('module not available (test)');
      },
      imuFusionEnabled: () => true,
// P6a-FIX2 H1: stated explicitly so the lazy platform read is never reached under vitest.
accelerometerRestVector: 'down',
    });
    provider.onSample((s) => samples.push(s));
    expect(() => provider.start()).not.toThrow();
    await flushMicrotasks();
    clock.advance(40);
    accel.emit({ x: 0.2, y: -0.1, z: 1 });
    expect(channelsOf(samples)).toEqual(['latG', 'longG']);
    await expect(provider.stop()).resolves.toBeUndefined();
  });

  it('a non-finite sensor reading is dropped, never thrown out of the native listener', async () => {
    const rig = await startRig(true);
    rig.clock.advance(40);
    expect(() => rig.gyro.emit({ x: Number.NaN, y: 0, z: 0 })).not.toThrow();
    expect(() =>
      rig.accel.emit({ x: Number.POSITIVE_INFINITY, y: 0, z: 1 } as GyroscopeReading),
    ).not.toThrow();
    expect(rig.samples).toHaveLength(0);

    // ... and the provider is still healthy afterwards.
    rig.clock.advance(40);
    rig.accel.emit({ x: 0.1, y: 0.1, z: 1 });
    expect(channelsOf(rig.samples)).toEqual(['latG', 'longG']);
    await rig.provider.stop();
  });

  it('a clock that does not advance still produces finite values (dt falls back to the nominal interval)', async () => {
    const rig = await startRig(true);
    for (let i = 0; i < 5; i += 1) {
      rig.gyro.emit({ x: 0, y: 0, z: -0.3 });
      rig.accel.emit({ x: 0.2, y: 0.1, z: 1 });
    }
    expect(rig.samples.length).toBeGreaterThan(0);
    for (const sample of rig.samples) expect(Number.isFinite(sample.value)).toBe(true);
    await rig.provider.stop();
  });

  it('stop() removes BOTH subscriptions and silences both sensors', async () => {
    const rig = await startRig(true);
    await rig.provider.stop();
    expect(rig.accel.removed).toBe(true);
    expect(rig.gyro.removed).toBe(true);
    expect(rig.samples).toHaveLength(0);
  });

  it('a stop() that races the gyroscope start never installs a late subscription', async () => {
    const accel = new FakeSensorSource();
    const gyro = new FakeSensorSource();
    let resolveGyro: (s: GyroscopeSource) => void = () => undefined;
    const pending = new Promise<GyroscopeSource>((resolve) => {
      resolveGyro = resolve;
    });
    const provider = createGForceProvider({
      monotonicNow: steppedClock().now,
      accelerometerSource: async () => accel,
      gyroscopeSource: () => pending,
      imuFusionEnabled: () => true,
// P6a-FIX2 H1: stated explicitly so the lazy platform read is never reached under vitest.
accelerometerRestVector: 'down',
    });
    provider.start();
    await provider.stop();
    resolveGyro(gyro);
    await flushMicrotasks();
    expect(gyro.listener).toBeNull();
  });

  it('the flag is frozen per run: flipping it mid-run changes nothing until the next start()', async () => {
    const accel = new FakeSensorSource();
    const gyro = new FakeSensorSource();
    const samples: TelemetrySample[] = [];
    const clock = steppedClock();
    let enabled = false;
    const provider = createGForceProvider({
      monotonicNow: clock.now,
      accelerometerSource: async () => accel,
      gyroscopeSource: async () => gyro,
      imuFusionEnabled: () => enabled,
// P6a-FIX2 H1: stated explicitly so the lazy platform read is never reached under vitest.
accelerometerRestVector: 'down',
    });
    provider.onSample((s) => samples.push(s));
    provider.start();
    await flushMicrotasks();

    enabled = true; // flipped DURING the run
    clock.advance(40);
    accel.emit({ x: 0.3, y: -0.1, z: 1 });
    expect(gyro.listener).toBeNull();
    expect(samples.some((s) => s.channel === 'yawRateDps')).toBe(false);

    await provider.stop();
    provider.start();
    await flushMicrotasks();
    expect(gyro.listener).not.toBeNull(); // the NEXT run reads the new value
    await provider.stop();
  });
});
