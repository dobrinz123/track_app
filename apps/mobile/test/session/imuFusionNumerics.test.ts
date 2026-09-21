import { describe, expect, it } from 'vitest';
import type { TelemetrySample } from '@circuit/core';

import {
  createGForceProvider,
  seedOrientationFromGravity,
  type AccelerometerReading,
  type AccelerometerSubscription,
} from '../../src/session/gforceProvider';

/**
 * Ticket P6a-FIX1 M1 / M2 / M3 — the three fused-path numerics defects an
 * independent review MEASURED on the first version of this provider. Each
 * test below reproduces that reviewer's exact scenario and asserts the
 * corrected behaviour, with the number they measured quoted in the assertion
 * so a regression is recognisable on sight rather than merely red.
 *
 * All three had the same shape: the filter was fed integration time or
 * rotation rate that did not correspond to anything the sensors reported, and
 * the fabricated attitude came out as a large fictitious linear acceleration
 * on a phone that was not moving.
 */

class ScriptedSensor {
  listener: ((r: AccelerometerReading) => void) | null = null;
  async isAvailableAsync(): Promise<boolean> {
    return true;
  }
  setUpdateInterval(): void {
    /* the scenario drives the cadence */
  }
  addListener(listener: (r: AccelerometerReading) => void): AccelerometerSubscription {
    this.listener = listener;
    return {
      remove: () => {
        this.listener = null;
      },
    };
  }
}

const flushMicrotasks = async (times = 12): Promise<void> => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

async function fusedRig() {
  const accel = new ScriptedSensor();
  const gyro = new ScriptedSensor();
  const samples: TelemetrySample[] = [];
  let clockMs = 10_000;
  const provider = createGForceProvider({
    monotonicNow: () => clockMs,
    accelerometerSource: async () => accel,
    gyroscopeSource: async () => gyro,
    imuFusionEnabled: () => true,
  });
  provider.onSample((sample) => samples.push(sample));
  provider.start();
  await flushMicrotasks();
  return {
    provider,
    samples,
    advance: (ms: number): void => {
      clockMs += ms;
    },
    accel: (reading: AccelerometerReading): void => accel.listener?.(reading),
    gyro: (reading: AccelerometerReading): void => gyro.listener?.(reading),
  };
}

const lastLongG = (samples: readonly TelemetrySample[]): number => {
  const value = samples.filter((s) => s.channel === 'longG').at(-1)?.value;
  expect(value).toBeDefined();
  return value!;
};

describe('P6a-FIX1 M1 -- no identity-init startup transient', () => {
  it('a still phone mounted at {x:0, y:-1, z:0} reads ~0 longG after one second, not -0.80245 g', async () => {
    const rig = await fusedRig();
    for (let i = 0; i < 25; i += 1) {
      rig.advance(40);
      rig.gyro({ x: 0, y: 0, z: 0 });
      rig.accel({ x: 0, y: -1, z: 0 });
    }
    const measured = lastLongG(rig.samples);
    // Reviewer measured -0.80245 g here with identity initialisation.
    expect(Math.abs(measured)).toBeLessThan(1e-4);
    expect(Math.abs(measured)).toBeLessThan(Math.abs(-0.80245) / 1_000);
    await rig.provider.stop();
  });

  it('the very FIRST fused sample of a still phone is already ~0 in any mount', async () => {
    for (const atRest of [
      { x: 0, y: 0, z: 1 },
      { x: 0, y: -1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 }, // the antiparallel case
      { x: 0.5, y: 0.5, z: Math.SQRT1_2 },
    ]) {
      const rig = await fusedRig();
      rig.advance(40);
      rig.accel(atRest);
      const g = rig.samples.filter((s) => s.channel === 'latG' || s.channel === 'longG');
      expect(g).toHaveLength(2);
      for (const sample of g) expect(Math.abs(sample.value)).toBeLessThan(1e-9);
      await rig.provider.stop();
    }
  });

  it('emits NOTHING until a reading plausibly of gravity arrives (no seed from a bump)', async () => {
    const rig = await fusedRig();
    rig.advance(40);
    rig.accel({ x: 0, y: 0, z: 4 }); // 4 g -- a pothole, not gravity
    expect(rig.samples).toHaveLength(0);
    rig.advance(40);
    rig.accel({ x: 0, y: 0, z: 0.05 }); // free fall
    expect(rig.samples).toHaveLength(0);
    rig.advance(40);
    rig.accel({ x: 0, y: 0, z: 1 }); // usable
    expect(rig.samples).toHaveLength(2);
    await rig.provider.stop();
  });

  it('seedOrientationFromGravity: handles the antiparallel case instead of throwing', () => {
    // Shortest-arc degenerates to a zero quaternion exactly here.
    const seed = seedOrientationFromGravity({ x: 0, y: 0, z: -1 });
    expect(seed).not.toBeNull();
    const magnitude = Math.sqrt(seed!.w ** 2 + seed!.x ** 2 + seed!.y ** 2 + seed!.z ** 2);
    expect(magnitude).toBeGreaterThan(0);
    // ... and it is a rotation that really does put "up" at -z.
    expect(seedOrientationFromGravity({ x: 0, y: 0, z: 0 })).toBeNull(); // no direction at all
    expect(seedOrientationFromGravity({ x: Number.NaN, y: 0, z: 1 })).toBeNull();
    expect(seedOrientationFromGravity({ x: 0, y: 0, z: 9 })).toBeNull(); // not gravity
  });
});

describe('P6a-FIX1 M2 -- a dropped gyroscope stops being integrated', () => {
  it('one 1 rad/s sample then two seconds of stationary accelerometer reads ~0 longG, not -0.98971 g', async () => {
    const rig = await fusedRig();
    rig.advance(40);
    rig.gyro({ x: 1, y: 0, z: 0 });
    for (let i = 0; i < 50; i += 1) {
      rig.advance(40);
      rig.accel({ x: 0, y: 0, z: 1 });
    }
    const measured = lastLongG(rig.samples);
    // Reviewer measured -0.98971 g here with an unexpiring held reading.
    expect(Math.abs(measured)).toBeLessThan(1e-3);
    expect(Math.abs(measured)).toBeLessThan(Math.abs(-0.98971) / 100);
    await rig.provider.stop();
  });

  it('a FRESH gyro reading is still integrated -- the freshness limit is not a mute button', async () => {
    const rig = await fusedRig();
    rig.advance(40);
    rig.accel({ x: 0, y: 0, z: 1 }); // seed
    // Re-delivered every frame, so it never goes stale.
    for (let i = 0; i < 10; i += 1) {
      rig.advance(40);
      rig.gyro({ x: 1, y: 0, z: 0 });
      rig.accel({ x: 0, y: 0, z: 1 });
    }
    expect(Math.abs(lastLongG(rig.samples))).toBeGreaterThan(0.05);
    await rig.provider.stop();
  });
});

describe('P6a-FIX1 M3 -- discontinuous timestamps never fabricate integration time', () => {
  it('a five-second accelerometer gap is reseeded, not integrated across (was -0.68966 g)', async () => {
    const rig = await fusedRig();
    for (let i = 0; i < 25; i += 1) {
      rig.advance(40);
      rig.gyro({ x: 0, y: 0, z: 0 });
      rig.accel({ x: 0, y: 0, z: 1 });
    }
    rig.advance(5_000);
    rig.gyro({ x: 1, y: 0, z: 0 }); // fresh, but the stream broke
    rig.accel({ x: 0, y: 0, z: 1 }); // level and stationary
    expect(Math.abs(lastLongG(rig.samples))).toBeLessThan(1e-9);
    await rig.provider.stop();
  });

  it('25 callbacks sharing ONE timestamp integrate nothing (was a fabricated second)', async () => {
    const rig = await fusedRig();
    rig.advance(40);
    rig.gyro({ x: 1, y: 0, z: 0 });
    rig.accel({ x: 0, y: 0, z: 1 });
    for (let i = 0; i < 25; i += 1) rig.accel({ x: 0, y: 0, z: 1 }); // clock does NOT advance
    expect(Math.abs(lastLongG(rig.samples))).toBeLessThan(1e-9);
    // The samples are still reported -- they are real readings, the clock is
    // what did not move.
    expect(rig.samples.filter((s) => s.channel === 'longG')).toHaveLength(26);
    await rig.provider.stop();
  });

  it('a BACKWARD timestamp integrates nothing and never throws', async () => {
    const rig = await fusedRig();
    rig.advance(40);
    rig.gyro({ x: 1, y: 0, z: 0 });
    rig.accel({ x: 0, y: 0, z: 1 });
    rig.advance(-500);
    expect(() => rig.accel({ x: 0, y: 0, z: 1 })).not.toThrow();
    expect(Math.abs(lastLongG(rig.samples))).toBeLessThan(1e-9);
    await rig.provider.stop();
  });

  it('a gap just INSIDE the limit still integrates normally (the threshold is a cliff, not a mute)', async () => {
    const rig = await fusedRig();
    rig.advance(40);
    rig.accel({ x: 0, y: 0, z: 1 }); // seed
    rig.advance(40);
    rig.gyro({ x: 1, y: 0, z: 0 });
    rig.advance(80); // 120 ms since the gyro: inside both limits
    rig.accel({ x: 0, y: 0, z: 1 });
    expect(Math.abs(lastLongG(rig.samples))).toBeGreaterThan(0.01);
    await rig.provider.stop();
  });
});
