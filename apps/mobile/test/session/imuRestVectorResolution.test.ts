import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelemetrySample } from '@circuit/core';

import type {
  AccelerometerReading,
  AccelerometerSubscription,
  GForceProvider,
} from '../../src/session/gforceProvider';

/**
 * Ticket P7D R5 + R4 — THE LAZY ACCELEROMETER-CONVENTION RESOLVER, ACTUALLY RUN.
 *
 * R5. `imuFusionProvider.test.ts` carried a case named "with NO convention
 * injected" that passed `accelerometerRestVector: 'down'`. The lazy
 * `import('react-native')` it claimed to cover therefore never executed: a
 * resolver broken in any way at all would have kept that test green. It is
 * the same class of defect as the vacuous lap-time fixture a blind verifier
 * caught earlier in this project -- green, and proving nothing. That test now
 * omits the injection and covers the REJECTED path against the real import
 * (React Native's Flow-typed source will not parse under vitest, so the
 * import genuinely rejects). This file covers the two paths a real device
 * takes, by mocking `react-native` per case:
 *
 *   - SUCCESSFUL resolution, on BOTH platforms, checked by the SIGN of a real
 *     right turn -- the only observable that distinguishes the conventions.
 *   - REJECTED resolution, from an explicitly throwing module factory.
 *   - DELAYED resolution: nothing at all is emitted while it is in flight,
 *     and the right sign appears once it lands.
 *
 * R4. What "rejected" now means. The resolver used to answer with the iOS
 * convention when it could not tell, which is right for the platform TRACE
 * ships on and inverts every rotation on Android -- a right turn reading
 * -90 deg/s. `coaching/cleanLap.ts` has a tested GNSS course-over-ground
 * fallback for an ABSENT `yawRateDps` and nothing whatever for an inverted
 * one, so an unresolved convention suppresses the channel. latG/longG are
 * convention-independent and must keep flowing regardless; every case below
 * asserts that too.
 */

class FakeSensorSource {
  available = true;
  updateIntervalCalls: number[] = [];
  listener: ((r: AccelerometerReading) => void) | null = null;
  async isAvailableAsync(): Promise<boolean> {
    return this.available;
  }
  setUpdateInterval(intervalMs: number): void {
    this.updateIntervalCalls.push(intervalMs);
  }
  addListener(listener: (r: AccelerometerReading) => void): AccelerometerSubscription {
    this.listener = listener;
    return {
      remove: () => {
        this.listener = null;
      },
    };
  }
  emit(reading: AccelerometerReading): void {
    this.listener?.(reading);
  }
}

const flushMicrotasks = async (times = 12): Promise<void> => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};
/** A rejected or deferred dynamic import settles on a macrotask, not a microtask. */
const flushMacrotask = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushMicrotasks();
};
/**
 * Waits for `startGyroscope` to get past the convention resolution, which is
 * where it installs the listener. A CONDITION rather than a fixed number of
 * ticks: these cases are the only ones in the suite that load a mocked module
 * graph for real, and how many macrotasks that takes is the module runner's
 * business, not a property under test. Returns whether it happened.
 */
async function waitForGyroSubscription(rig: Rig, maxTicks = 400): Promise<boolean> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (rig.gyro.listener !== null) return true;
    await flushMacrotask();
  }
  return rig.gyro.listener !== null;
}

const NINETY_DPS_RAD = Math.PI / 2;
/** Where the SKY is, in device coordinates, for the mount every case uses. */
const UP: AccelerometerReading = { x: 0, y: 1, z: 0 };
/**
 * A right turn is clockwise seen from above, so by the right-hand rule its
 * angular-velocity vector points DOWN -- along `-up` on both platforms.
 */
const RIGHT_TURN: AccelerometerReading = {
  x: -UP.x * NINETY_DPS_RAD,
  y: -UP.y * NINETY_DPS_RAD,
  z: -UP.z * NINETY_DPS_RAD,
};
/** Android reports specific force (rest reading = up); iOS reports its negation. */
const REST_READING: Record<string, AccelerometerReading> = {
  android: UP,
  ios: { x: -UP.x, y: -UP.y, z: -UP.z },
};

interface Rig {
  accel: FakeSensorSource;
  gyro: FakeSensorSource;
  samples: TelemetrySample[];
  advance: (ms: number) => void;
  provider: GForceProvider;
}

/**
 * Builds a provider from a FRESH module instance so the mocked
 * `expo-modules-core` below is the one its dynamic import sees, and crucially with
 * NO `accelerometerRestVector` -- the omission is what puts the lazy resolver
 * on the code path at all.
 */
async function startRig(): Promise<Rig> {
  const { createGForceProvider } = await import('../../src/session/gforceProvider');
  const accel = new FakeSensorSource();
  const gyro = new FakeSensorSource();
  const samples: TelemetrySample[] = [];
  let clockMs = 10_000;
  const provider = createGForceProvider({
    monotonicNow: () => clockMs,
    accelerometerSource: async () => accel,
    gyroscopeSource: async () => gyro,
    imuFusionEnabled: () => true,
  });
  provider.onSample((s) => samples.push(s));
  provider.start();
  return { accel, gyro, samples, advance: (ms) => (clockMs += ms), provider };
}

/** Settles the filter on a still phone in the given platform's own terms. */
function settle(rig: Rig, platform: string): void {
  const atRest = REST_READING[platform]!;
  for (let i = 0; i < 80; i += 1) {
    rig.advance(40);
    rig.gyro.emit({ x: 0, y: 0, z: 0 });
    rig.accel.emit(atRest);
  }
}

const yawSamples = (rig: Rig): TelemetrySample[] =>
  rig.samples.filter((s) => s.channel === 'yawRateDps');
const linearSamples = (rig: Rig): TelemetrySample[] =>
  rig.samples.filter((s) => s.channel === 'latG' || s.channel === 'longG');

afterEach(() => {
  vi.doUnmock('expo-modules-core');
  vi.resetModules();
});

describe('P7D R5 -- SUCCESSFUL resolution: the platform decides the sign, and both are checked', () => {
  for (const platform of ['ios', 'android'] as const) {
    it(`Platform.OS === '${platform}' resolves a convention and a right turn reads +90 deg/s`, async () => {
      vi.resetModules();
      vi.doMock('expo-modules-core', () => ({ Platform: { OS: platform } }));
      const rig = await startRig();
      // The resolution completes BEFORE the subscription -- that ordering is
      // what stops a sample ever being emitted under an unknown convention.
      expect(await waitForGyroSubscription(rig)).toBe(true);
      expect(rig.gyro.updateIntervalCalls).toEqual([40]);

      settle(rig, platform);
      rig.samples.length = 0;
      rig.advance(40);
      rig.gyro.emit(RIGHT_TURN);

      const yaw = yawSamples(rig);
      expect(yaw).toHaveLength(1);
      // Two decimals: the projection is onto the filter's ESTIMATE of
      // vertical, which limit-cycles within about `beta * dt`.
      expect(yaw[0]!.value).toBeCloseTo(90, 2);
      await rig.provider.stop();
    });
  }
});

describe('P7D R4/R5 -- REJECTED resolution suppresses yawRateDps instead of guessing', () => {
  it('a throwing expo-modules-core module leaves the convention unresolved and the channel silent', async () => {
    vi.resetModules();
    vi.doMock('expo-modules-core', () => {
      throw new Error('Flow-typed source cannot be parsed');
    });
    const rig = await startRig();
    // The gyroscope IS still subscribed -- its rotation feeds the attitude
    // estimate latG/longG come from. Only the yaw emit is suppressed.
    expect(await waitForGyroSubscription(rig)).toBe(true);

    settle(rig, 'ios');
    rig.advance(40);
    rig.gyro.emit(RIGHT_TURN);

    // Pre-P7D this emitted +90 on the iOS guess -- and -90 on the Android
    // device the same failed resolution would have been reached from.
    expect(yawSamples(rig)).toHaveLength(0);
    // latG/longG are convention-independent and never stop.
    expect(linearSamples(rig).length).toBeGreaterThan(100);
    expect(linearSamples(rig).every((s) => Number.isFinite(s.value))).toBe(true);
    await rig.provider.stop();
  });

  it('an expo-modules-core whose Platform.OS is not a string is unresolved too, not "not android"', async () => {
    // The guard matters because `Platform?.OS === 'android'` is false for
    // `undefined` as readily as it is for `'ios'`, and the old code turned
    // that false into the iOS convention.
    vi.resetModules();
    vi.doMock('expo-modules-core', () => ({ Platform: {} }));
    const rig = await startRig();
    expect(await waitForGyroSubscription(rig)).toBe(true);

    settle(rig, 'ios');
    rig.advance(40);
    rig.gyro.emit(RIGHT_TURN);

    expect(yawSamples(rig)).toHaveLength(0);
    expect(linearSamples(rig).length).toBeGreaterThan(100);
    await rig.provider.stop();
  });
});

describe('P7D R5 -- DELAYED resolution: nothing is emitted while the answer is in flight', () => {
  it('the gyroscope is not even subscribed until the convention lands, then the sign is right', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.resetModules();
    vi.doMock('expo-modules-core', async () => {
      await gate;
      return { Platform: { OS: 'android' } };
    });

    const rig = await startRig();
    // In flight: the listener does not appear however long we wait, because
    // the gate -- not the scheduler -- is what is holding it. 60 macrotask
    // ticks is many times what the resolved cases above need.
    expect(await waitForGyroSubscription(rig, 60)).toBe(false);
    expect(rig.gyro.listener).toBeNull();
    expect(rig.gyro.updateIntervalCalls).toEqual([]);
    // ... and the accelerometer half is already running regardless.
    settle(rig, 'android');
    expect(linearSamples(rig).length).toBeGreaterThan(100);
    expect(yawSamples(rig)).toHaveLength(0);

    release();
    expect(await waitForGyroSubscription(rig)).toBe(true);

    settle(rig, 'android');
    rig.samples.length = 0;
    rig.advance(40);
    rig.gyro.emit(RIGHT_TURN);
    const yaw = yawSamples(rig);
    expect(yaw).toHaveLength(1);
    expect(yaw[0]!.value).toBeCloseTo(90, 2);
    await rig.provider.stop();
  });
});

describe('BUILD-14 CRASH -- the resolver never imports react-native wholesale', () => {
  it('resolves through expo-modules-core and never touches react-native (whose importAll aborted the iOS release build)', async () => {
    vi.resetModules();
    let reactNativeLoaded = false;
    vi.doMock('react-native', () => {
      reactNativeLoaded = true;
      throw new Error('react-native must not be imported by the gyroscope path');
    });
    vi.doMock('expo-modules-core', () => ({ Platform: { OS: 'ios' } }));
    const rig = await startRig();
    expect(await waitForGyroSubscription(rig)).toBe(true);
    settle(rig, 'ios');
    rig.samples.length = 0;
    rig.advance(40);
    rig.gyro.emit(RIGHT_TURN);
    expect(reactNativeLoaded).toBe(false);
    expect(yawSamples(rig)).toHaveLength(1);
    expect(yawSamples(rig)[0]!.value).toBeCloseTo(90, 2);
    rig.provider.stop();
    vi.doUnmock('react-native');
  });
});
