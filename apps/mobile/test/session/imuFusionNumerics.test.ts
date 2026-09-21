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
// P6a-FIX2 H1: stated explicitly so the lazy platform read is never reached under vitest.
accelerometerRestVector: 'down',
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

  it('a gap just INSIDE the limit still integrates the rotation the gyro EVIDENCES', async () => {
    // Rewritten for P6a-FIX2 M6. The previous version of this test delivered
    // ONE gyro reading and asserted that a 120 ms accelerometer gap integrated
    // it across the whole span -- which is precisely the defect M6 names, so
    // the assertion was pinning a bug. Two readings now close a real 40 ms
    // interval, and that 40 ms of rotation (not 120 ms of it) is what may be
    // applied.
    const rig = await fusedRig();
    rig.advance(40);
    rig.accel({ x: 0, y: 0, z: 1 }); // seed
    rig.advance(40);
    rig.gyro({ x: 1, y: 0, z: 0 });
    rig.advance(40);
    rig.gyro({ x: 1, y: 0, z: 0 }); // closes a 40 ms interval at 1 rad/s
    rig.advance(40); // 120 ms since the seed: inside both limits
    rig.accel({ x: 0, y: 0, z: 1 });
    const measured = Math.abs(lastLongG(rig.samples));
    // 40 ms at 1 rad/s is 0.04 rad of pitch, so roughly 0.04 g on longG once
    // the accelerometer correction has had its say -- present, but nowhere
    // near the 0.12 rad the whole 120 ms gap would have fabricated.
    expect(measured).toBeGreaterThan(0.005);
    expect(measured).toBeLessThan(Math.sin(0.12));
    await rig.provider.stop();
  });
});

describe('P6a-FIX2 M6 -- a gyro reading is never smeared across the interval before it', () => {
  it('the exact reviewer scenario: 500 ms silence then one fresh 1 rad/s reading emits ~0, not -0.4705882353 g', async () => {
    const rig = await fusedRig();
    rig.advance(40);
    rig.accel({ x: 0, y: 0, z: 1 }); // seed level
    rig.advance(500);
    // Age ZERO, so the freshness check of M2 passes -- but this reading is
    // evidence about now, not about the 500 ms of silence behind it.
    rig.gyro({ x: 1, y: 0, z: 0 });
    rig.accel({ x: 0, y: 0, z: 1 }); // level, stationary
    expect(Math.abs(lastLongG(rig.samples))).toBeLessThan(1e-9);
    await rig.provider.stop();
  });

  it('rotation is integrated in proportion to the gyro intervals that actually closed', async () => {
    // Half the accelerometer interval is covered by gyro evidence, so half
    // the rotation may be applied -- not all of it, and not none of it.
    const halfCovered = await fusedRig();
    halfCovered.advance(40);
    halfCovered.accel({ x: 0, y: 0, z: 1 });
    halfCovered.advance(40);
    halfCovered.gyro({ x: 1, y: 0, z: 0 });
    halfCovered.advance(40);
    halfCovered.gyro({ x: 1, y: 0, z: 0 }); // 40 ms of evidence
    halfCovered.advance(40);
    halfCovered.accel({ x: 0, y: 0, z: 1 }); // over an 80 ms interval

    const fullyCovered = await fusedRig();
    fullyCovered.advance(40);
    fullyCovered.accel({ x: 0, y: 0, z: 1 });
    fullyCovered.advance(40);
    fullyCovered.gyro({ x: 1, y: 0, z: 0 });
    fullyCovered.advance(40);
    fullyCovered.gyro({ x: 1, y: 0, z: 0 });
    fullyCovered.advance(40);
    fullyCovered.gyro({ x: 1, y: 0, z: 0 }); // 80 ms of evidence
    fullyCovered.accel({ x: 0, y: 0, z: 1 }); // over the same 80 ms interval

    expect(Math.abs(lastLongG(fullyCovered.samples))).toBeGreaterThan(
      Math.abs(lastLongG(halfCovered.samples)) * 1.5,
    );
    await halfCovered.provider.stop();
    await fullyCovered.provider.stop();
  });
});

describe('P6a-FIX2 M5 -- yawRateDps stops when the attitude estimate goes stale', () => {
  it('gyro callbacks after the accelerometer stops emit nothing rather than project onto a frozen vertical', async () => {
    const rig = await fusedRig();
    for (let i = 0; i < 40; i += 1) {
      rig.advance(40);
      rig.gyro({ x: 0, y: 0, z: 0 });
      rig.accel({ x: 0, y: 0, z: 1 });
    }
    const healthy = rig.samples.filter((s) => s.channel === 'yawRateDps').length;
    expect(healthy).toBeGreaterThan(30);

    // The accelerometer stops; the gyroscope keeps firing for 1.6 s.
    for (let i = 0; i < 40; i += 1) {
      rig.advance(40);
      rig.gyro({ x: 0, y: 0, z: -1 });
    }
    const afterwards = rig.samples.filter((s) => s.channel === 'yawRateDps').length - healthy;
    // Only the readings inside ATTITUDE_MAX_AGE_MS (500 ms) of the last
    // accelerometer sample are emitted; everything past that is silence.
    expect(afterwards).toBeGreaterThan(0);
    expect(afterwards).toBeLessThanOrEqual(13); // 500 ms / 40 ms, inclusive
    await rig.provider.stop();
  });

  it('the channel resumes as soon as the accelerometer comes back', async () => {
    const rig = await fusedRig();
    rig.advance(40);
    rig.accel({ x: 0, y: 0, z: 1 });
    rig.advance(2_000); // attitude now stale
    rig.gyro({ x: 0, y: 0, z: -1 });
    rig.gyro({ x: 0, y: 0, z: -1 });
    expect(rig.samples.filter((s) => s.channel === 'yawRateDps')).toHaveLength(0);

    rig.accel({ x: 0, y: 0, z: 1 }); // reseeds, attitude fresh again
    rig.advance(40);
    rig.gyro({ x: 0, y: 0, z: -1 });
    rig.advance(40);
    rig.gyro({ x: 0, y: 0, z: -1 });
    expect(
      rig.samples.filter((s) => s.channel === 'yawRateDps').length,
    ).toBeGreaterThan(0);
    await rig.provider.stop();
  });
});

describe('P6a-FIX2 M7 -- "fusion is on but not fusing" is visible, not silent', () => {
  it('healthy 25 Hz delivery reports a clean bill of health', async () => {
    const rig = await fusedRig();
    const rate = Math.PI / 2;
    for (let i = 0; i < 100; i += 1) {
      rig.advance(40);
      rig.gyro({ x: 0, y: 0, z: -rate });
      rig.accel({ x: 0, y: 0, z: 1 });
    }
    const diagnostics = rig.provider.getFusionDiagnostics();
    expect(diagnostics).toEqual({
      fusionActive: true,
      seeded: true,
      reseeds: 0,
      slowIntervals: 0,
      gyroStarvedUpdates: 0,
      degraded: false,
    });
    await rig.provider.stop();
  });

  it('the exact reviewer scenario: sustained 1 Hz delivery raises `degraded` instead of passing silently', async () => {
    const rig = await fusedRig();
    for (let i = 0; i < 12; i += 1) {
      rig.advance(1_000);
      rig.accel({ x: 0.5, y: 0, z: 1 });
    }
    const diagnostics = rig.provider.getFusionDiagnostics();
    expect(diagnostics.degraded).toBe(true);
    expect(diagnostics.slowIntervals).toBeGreaterThan(1);
    expect(diagnostics.gyroStarvedUpdates).toBeGreaterThan(1);

    // The lateral reading itself is NOT a fusion regression and is not
    // claimed to be fixed: an attitude estimate with no gyroscope cannot tell
    // a tilt from a sustained lateral acceleration, so it leans into it. The
    // measured 0.0528 g is in fact CLOSER to the truth than the legacy
    // low-pass path gives for the same input (0.0344 g, measured) -- which is
    // why this state is reported rather than suppressed.
    const latG = rig.samples.filter((s) => s.channel === 'latG').at(-1)?.value;
    expect(latG).toBeCloseTo(0.0527864, 6);
    await rig.provider.stop();
  });

  it('the 90 deg/s yaw that silently read 80.4984472 is now not emitted at all', async () => {
    const rig = await fusedRig();
    const rate = Math.PI / 2;
    for (let i = 0; i < 12; i += 1) {
      rig.advance(1_000);
      rig.gyro({ x: 0, y: 0, z: -rate });
      rig.accel({ x: 0.5, y: 0, z: 1 });
    }
    expect(rig.samples.filter((s) => s.channel === 'yawRateDps')).toHaveLength(0);
    expect(rig.provider.getFusionDiagnostics().degraded).toBe(true);
    // ... while latG/longG keep flowing, because there the fused value is no
    // worse than the flags-off path and an absent channel would be worse.
    expect(rig.samples.filter((s) => s.channel === 'latG').length).toBeGreaterThan(5);
    await rig.provider.stop();
  });

  it('ONE long gap is a stream break, not degradation -- M3 behaviour is preserved', async () => {
    const rig = await fusedRig();
    for (let i = 0; i < 25; i += 1) {
      rig.advance(40);
      rig.gyro({ x: 0, y: 0, z: 0 });
      rig.accel({ x: 0, y: 0, z: 1 });
    }
    rig.advance(5_000);
    rig.gyro({ x: 1, y: 0, z: 0 });
    rig.accel({ x: 0, y: 0, z: 1 });
    expect(Math.abs(lastLongG(rig.samples))).toBeLessThan(1e-9); // reseeded
    const diagnostics = rig.provider.getFusionDiagnostics();
    expect(diagnostics.reseeds).toBe(1);
    expect(diagnostics.degraded).toBe(false);
    await rig.provider.stop();
  });

  it('diagnostics are all-clear and inert while the flag is OFF', async () => {
    const accel = new ScriptedSensor();
    const provider = createGForceProvider({
      monotonicNow: () => 0,
      accelerometerSource: async () => accel,
      imuFusionEnabled: () => false,
    });
    provider.start();
    await flushMicrotasks();
    expect(provider.getFusionDiagnostics()).toEqual({
      fusionActive: false,
      seeded: false,
      reseeds: 0,
      slowIntervals: 0,
      gyroStarvedUpdates: 0,
      degraded: false,
    });
    await provider.stop();
  });
});
