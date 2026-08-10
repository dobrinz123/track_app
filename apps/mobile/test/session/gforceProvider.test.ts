import { describe, expect, it } from 'vitest';
import type { TelemetrySample } from '@circuit/core';
import {
  computeLinearAcceleration,
  createGForceProvider,
  type AccelerometerReading,
  type AccelerometerSource,
  type AccelerometerSubscription,
} from '../../src/session/gforceProvider';

/**
 * Telemetry addendum — channel revision (2026-08-11, binding): G-force
 * provider math (pure `computeLinearAcceleration`) and lifecycle
 * (start/stop/samples). Every lifecycle test below injects
 * `accelerometerSource` -- the real, lazy `await import('expo-sensors')`
 * inside `gforceProvider.ts`'s `defaultAccelerometerSource()` is NEVER
 * reached by any test here, so vitest never loads the native module (same
 * requirement `motionCapture.ts`'s own doc comment describes for that
 * module's eager import).
 */

function monotonicCounter(start = 1_000): () => number {
  let t = start;
  return () => {
    t += 1;
    return t;
  };
}

class FakeAccelerometerSource implements AccelerometerSource {
  available = true;
  updateIntervalCalls: number[] = [];
  listener: ((r: AccelerometerReading) => void) | null = null;
  removed = false;

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
        this.removed = true;
        this.listener = null;
      },
    };
  }
  emit(reading: AccelerometerReading): void {
    this.listener?.(reading);
  }
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('computeLinearAcceleration (channel revision, binding math: gravity low-pass alpha 0.8, linear = raw - gravity, unit g)', () => {
  it('gravity converges from a constant-gravity stream -- linear acceleration (latG/longG-equivalent x/y) approaches 0', () => {
    let gravity: AccelerometerReading = { x: 0, y: 0, z: 0 };
    const raw: AccelerometerReading = { x: 0.05, y: -0.03, z: 0.98 };
    let linear: AccelerometerReading = { x: 1, y: 1, z: 1 };
    for (let i = 0; i < 30; i += 1) {
      const result = computeLinearAcceleration(gravity, raw);
      gravity = result.gravity;
      linear = result.linear;
    }
    expect(Math.abs(linear.x)).toBeLessThan(0.001);
    expect(Math.abs(linear.y)).toBeLessThan(0.001);
    expect(gravity.x).toBeCloseTo(raw.x, 3);
    expect(gravity.y).toBeCloseTo(raw.y, 3);
  });

  it('a step lateral/longitudinal acceleration after convergence produces the expected immediate latG/longG: delta * alpha, in g', () => {
    // "Converged" is constructed directly (gravity === the reading it would
    // have settled on) rather than iterated, to keep this test's expected
    // value an exact closed-form -- alpha=0.8 means a single sample's gravity
    // estimate only moves (1-alpha) of the way toward a NEW reading, so the
    // immediate linear (post-step) reading is `delta * alpha`.
    const converged: AccelerometerReading = { x: 0, y: 0, z: 1 };
    const stepped: AccelerometerReading = { x: 0.5, y: -0.2, z: 1 };
    const { linear } = computeLinearAcceleration(converged, stepped);
    expect(linear.x).toBeCloseTo(0.4, 10); // latG: 0.5 * 0.8
    expect(linear.y).toBeCloseTo(-0.16, 10); // longG: -0.2 * 0.8
  });

  it('no unit re-scaling: output stays in g (expo-sensors already delivers g-unit readings per Expo SDK 57 docs) -- NOT divided by 9.81', () => {
    const gravity: AccelerometerReading = { x: 0, y: 0, z: 0 };
    const raw: AccelerometerReading = { x: 1, y: 0, z: 0 };
    const { linear } = computeLinearAcceleration(gravity, raw);
    expect(linear.x).toBeCloseTo(0.8, 10);
    // A literal `/ 9.81` on top would put this near 0.0816 -- explicitly rule that out.
    expect(Math.abs(linear.x - 0.8 / 9.81)).toBeGreaterThan(0.5);
  });

  it('a custom alpha is honored (default stays 0.8 when omitted)', () => {
    const gravity: AccelerometerReading = { x: 0, y: 0, z: 0 };
    const raw: AccelerometerReading = { x: 1, y: 0, z: 0 };
    const { linear: defaultAlpha } = computeLinearAcceleration(gravity, raw);
    const { linear: customAlpha } = computeLinearAcceleration(gravity, raw, 0.5);
    expect(defaultAlpha.x).toBeCloseTo(0.8, 10);
    expect(customAlpha.x).toBeCloseTo(0.5, 10);
  });
});

describe('createGForceProvider lifecycle', () => {
  it('start() configures ~25Hz polling and emits latG then longG samples stamped with the injected monotonic clock', async () => {
    const source = new FakeAccelerometerSource();
    const samples: TelemetrySample[] = [];
    const provider = createGForceProvider({
      monotonicNow: monotonicCounter(),
      accelerometerSource: async () => source,
    });
    provider.onSample((s) => samples.push(s));

    provider.start();
    await flushMicrotasks();

    expect(source.updateIntervalCalls).toEqual([40]); // ~25 Hz.
    expect(source.listener).not.toBeNull();

    source.emit({ x: 0.3, y: -0.1, z: 1 });
    expect(samples).toHaveLength(2);
    expect(samples[0]!.channel).toBe('latG');
    expect(samples[1]!.channel).toBe('longG');
    for (const s of samples) expect(Number.isFinite(s.tMonoMs)).toBe(true);

    await provider.stop();
    expect(source.removed).toBe(true);

    const countAfterStop = samples.length;
    source.emit({ x: 1, y: 1, z: 1 });
    expect(samples.length).toBe(countAfterStop); // no further samples after stop().
  });

  it('start() is a no-op while already running -- a second call does not re-subscribe', async () => {
    const source = new FakeAccelerometerSource();
    const provider = createGForceProvider({
      monotonicNow: monotonicCounter(),
      accelerometerSource: async () => source,
    });
    provider.start();
    await flushMicrotasks();
    provider.start();
    await flushMicrotasks();
    expect(source.updateIntervalCalls).toEqual([40]);
    await provider.stop();
  });

  it('an unavailable accelerometer never throws and never emits samples (optional-capability rule, mirrors motionCapture.ts)', async () => {
    const source = new FakeAccelerometerSource();
    source.available = false;
    const samples: TelemetrySample[] = [];
    const provider = createGForceProvider({
      monotonicNow: monotonicCounter(),
      accelerometerSource: async () => source,
    });
    provider.onSample((s) => samples.push(s));

    expect(() => provider.start()).not.toThrow();
    await flushMicrotasks();

    expect(source.listener).toBeNull();
    expect(source.updateIntervalCalls).toEqual([]);
    expect(samples).toHaveLength(0);
    await provider.stop();
  });

  it('a rejected accelerometer source (e.g. the lazy expo-sensors import failing) never throws', async () => {
    const provider = createGForceProvider({
      monotonicNow: monotonicCounter(),
      accelerometerSource: async () => {
        throw new Error('module not available (test)');
      },
    });
    expect(() => provider.start()).not.toThrow();
    await flushMicrotasks();
    await expect(provider.stop()).resolves.toBeUndefined();
  });

  it('stop() called while start() is still resolving its accelerometer source prevents a late subscription from ever being installed', async () => {
    const source = new FakeAccelerometerSource();
    let resolveSource: (s: AccelerometerSource) => void = () => undefined;
    const pending = new Promise<AccelerometerSource>((resolve) => {
      resolveSource = resolve;
    });
    const provider = createGForceProvider({
      monotonicNow: monotonicCounter(),
      accelerometerSource: () => pending,
    });

    provider.start();
    await provider.stop(); // stop() before the accelerometer source has even resolved.
    resolveSource(source);
    await flushMicrotasks();

    expect(source.listener).toBeNull(); // never subscribed -- the race was won by stop().
  });

  it('stop() before start() was ever called is a harmless no-op', async () => {
    const provider = createGForceProvider({ monotonicNow: monotonicCounter() });
    await expect(provider.stop()).resolves.toBeUndefined();
  });
});
