import { describe, expect, it } from 'vitest';
import type { TelemetrySample } from '@circuit/core';

import {
  computeLinearAcceleration,
  createGForceProvider,
  type AccelerometerReading,
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

  it('reproduces the low-pass values EXACTLY -- hand-driven `computeLinearAcceleration` over the same stream', async () => {
    const stream: AccelerometerReading[] = [
      { x: 0.02, y: -0.01, z: 0.99 },
      { x: 0.31, y: -0.42, z: 1.02 },
      { x: -0.55, y: 0.18, z: 0.97 },
      { x: 0.08, y: 0.63, z: 1.05 },
      { x: -0.12, y: -0.22, z: 0.98 },
    ];
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

  it('emits yawRateDps off the device Z axis, in deg/s and in the COMPASS sense (a right turn is positive)', async () => {
    const rig = await startRig(true);
    // Right-handed about +z (up) means a LEFT turn is positive rad/s, so a
    // RIGHT turn -- what a positive course-over-ground rate means -- is
    // negative on the gyroscope.
    const rightTurnRadPerSec = -0.5;
    rig.clock.advance(40);
    rig.gyro.emit({ x: 0, y: 0, z: rightTurnRadPerSec });

    const yaw = rig.samples.filter((s) => s.channel === 'yawRateDps');
    expect(yaw).toHaveLength(1);
    expect(yaw[0]!.value).toBeCloseTo((0.5 * 180) / Math.PI, 9);
    expect(yaw[0]!.value).toBeGreaterThan(0);

    // ... and the mirror case, so the sign is pinned in both directions.
    rig.clock.advance(40);
    rig.gyro.emit({ x: 0, y: 0, z: 0.5 });
    expect(rig.samples.filter((s) => s.channel === 'yawRateDps')[1]!.value).toBeLessThan(0);
    await rig.provider.stop();
  });

  it('yawRateDps is stamped with the injected monotonic clock, never Date.now()', async () => {
    const rig = await startRig(true);
    rig.clock.advance(40);
    const expectedStamp = rig.clock.now();
    rig.gyro.emit({ x: 0.01, y: -0.02, z: 0.3 });
    const yaw = rig.samples.filter((s) => s.channel === 'yawRateDps');
    expect(yaw[0]!.tMonoMs).toBe(expectedStamp);
    await rig.provider.stop();
  });

  it('keeps the latG/longG cadence and the portrait axis mapping, and produces DIFFERENT (fused) values than the low-pass', async () => {
    const stream: AccelerometerReading[] = [
      { x: 0.0, y: 0.0, z: 1.0 },
      { x: 0.35, y: -0.2, z: 1.0 },
      { x: 0.4, y: -0.25, z: 1.0 },
      { x: 0.2, y: 0.1, z: 1.0 },
    ];
    const off = await startRig(false);
    const on = await startRig(true);
    for (const raw of stream) {
      off.clock.advance(40);
      off.accel.emit(raw);
      on.clock.advance(40);
      on.gyro.emit({ x: 0, y: 0, z: -0.2 });
      on.accel.emit(raw);
    }

    const gOnly = (r: Rig): TelemetrySample[] =>
      r.samples.filter((s) => s.channel === 'latG' || s.channel === 'longG');
    // Same count, same order, same channels -- only the values move.
    expect(channelsOf(gOnly(on))).toEqual(channelsOf(gOnly(off)));
    expect(gOnly(on)).toHaveLength(stream.length * 2);
    expect(gOnly(on).map((s) => s.value)).not.toEqual(gOnly(off).map((s) => s.value));
    await off.provider.stop();
    await on.provider.stop();
  });

  it('holds the last gyroscope reading between accelerometer samples (the documented pairing) and never blocks on one', async () => {
    const rig = await startRig(true);
    // An accelerometer reading BEFORE any gyroscope reading still produces its
    // pair of samples -- the filter simply integrates a zero rotation rate.
    rig.clock.advance(40);
    rig.accel.emit({ x: 0.1, y: 0.05, z: 1 });
    expect(channelsOf(rig.samples)).toEqual(['latG', 'longG']);

    // One gyroscope reading, then two accelerometer readings: both are fused
    // (the gyro is held), and the gyro emits exactly once.
    rig.clock.advance(40);
    rig.gyro.emit({ x: 0, y: 0, z: -0.4 });
    rig.clock.advance(40);
    rig.accel.emit({ x: 0.2, y: 0.05, z: 1 });
    rig.clock.advance(40);
    rig.accel.emit({ x: 0.2, y: 0.05, z: 1 });

    expect(rig.samples.filter((s) => s.channel === 'yawRateDps')).toHaveLength(1);
    expect(rig.samples.filter((s) => s.channel === 'latG')).toHaveLength(3);
    expect(rig.samples.filter((s) => s.channel === 'longG')).toHaveLength(3);
    await rig.provider.stop();
  });

  it('a level, stationary device converges to ~0 latG/longG -- the fused gravity really is gravity', async () => {
    const rig = await startRig(true);
    for (let i = 0; i < 200; i += 1) {
      rig.clock.advance(40);
      rig.gyro.emit({ x: 0, y: 0, z: 0 });
      rig.accel.emit({ x: 0, y: 0, z: 1 });
    }
    const last = rig.samples.slice(-2);
    expect(Math.abs(last[0]!.value)).toBeLessThan(0.01);
    expect(Math.abs(last[1]!.value)).toBeLessThan(0.01);
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
