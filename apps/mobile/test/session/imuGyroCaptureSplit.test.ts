import { describe, expect, it } from 'vitest';
import { SqlSessionRepository, type TelemetrySample } from '@circuit/core';

import { DEFAULT_SETTINGS, InMemorySettingsStore } from '../../src/session/settingsStore';
import { SqlSettingsStore } from '../../src/persistence/sqlSettingsStore';
import {
  createGForceProvider,
  type AccelerometerReading,
  type AccelerometerSubscription,
} from '../../src/session/gforceProvider';
import {
  IMU_FUSION_SETTING_STRINGS,
  IMU_GYRO_CAPTURE_SETTING_STRINGS,
} from '../../src/ui/screens/imuSettingsStrings';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * Ticket P7R E3 — gyroscope CAPTURE split from Madgwick FUSION.
 *
 * Before this, one flag decided two unrelated things, and they carry very
 * different risk:
 *
 *  - CAPTURE adds the `yawRateDps` channel. It feeds no existing live value,
 *    so it cannot move `latG`/`longG` — the two channels that are already
 *    field-proven.
 *  - FUSION replaces the gravity estimator BEHIND `latG`/`longG`, on a sign
 *    convention that has never been checked against a real corner.
 *
 * Tying them together meant the only way to record a yaw trace was to also
 * swap the estimator, on the very day the recording matters. Hence capture ON
 * by default, fusion OFF — and hence the central assertion in this file,
 * which the ticket asks for by name: with capture on and fusion off,
 * `latG`/`longG` must be identical VALUE FOR VALUE to a run with both off.
 */

const flushMicrotasks = async (times = 12): Promise<void> => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

class ScriptedSensor {
  listener: ((r: AccelerometerReading) => void) | null = null;
  subscribeCount = 0;
  async isAvailableAsync(): Promise<boolean> {
    return true;
  }
  setUpdateInterval(): void {
    /* the stimulus drives the cadence */
  }
  addListener(listener: (r: AccelerometerReading) => void): AccelerometerSubscription {
    this.subscribeCount += 1;
    this.listener = listener;
    return {
      remove: () => {
        this.listener = null;
      },
    };
  }
}

interface Step {
  tMonoMs: number;
  accel: AccelerometerReading;
  gyro: AccelerometerReading;
}

/**
 * A flat-mounted phone (device z vertical, +1 g at rest — the Android
 * convention, stated explicitly so the lazy platform read is never reached)
 * turning steadily, with a plausible lateral/longitudinal signature on the
 * accelerometer. 25 Hz, the rate the provider asks its sensors for.
 */
function stimulus(count: number): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < count; i += 1) {
    const phase = i / 25;
    const yawRadPerSec = 0.6 * Math.sin(phase);
    steps.push({
      tMonoMs: i * 40,
      accel: { x: 0.35 * Math.sin(phase), y: 0.2 * Math.cos(phase * 0.7), z: 1 },
      gyro: { x: 0, y: 0, z: -yawRadPerSec },
    });
  }
  return steps;
}

interface Flags {
  imuFusionEnabled: boolean;
  imuGyroCaptureEnabled: boolean;
}

interface Run {
  samples: TelemetrySample[];
  gyroSubscribed: boolean;
}

/** One provider run, wired exactly as `composition.ts` wires it. */
async function run(flags: Flags, steps: Step[]): Promise<Run> {
  const store = new InMemorySettingsStore();
  store.update(flags);
  const accel = new ScriptedSensor();
  const gyro = new ScriptedSensor();
  const samples: TelemetrySample[] = [];
  let clockMs = 0;

  const provider = createGForceProvider({
    monotonicNow: () => clockMs,
    accelerometerSource: async () => accel,
    gyroscopeSource: async () => gyro,
    // THE PRODUCTION WIRING, both flags, read live from the store.
    imuFusionEnabled: () => store.getSettings().imuFusionEnabled,
    imuGyroCaptureEnabled: () => store.getSettings().imuGyroCaptureEnabled,
    accelerometerRestVector: 'up',
  });
  provider.onSample((sample) => samples.push(sample));
  provider.start();
  await flushMicrotasks();

  for (const step of steps) {
    clockMs = step.tMonoMs;
    gyro.listener?.(step.gyro);
    accel.listener?.(step.accel);
  }
  await provider.stop();
  return { samples, gyroSubscribed: gyro.subscribeCount > 0 };
}

const channel = (r: Run, id: string): TelemetrySample[] => r.samples.filter((s) => s.channel === id);
const values = (r: Run, id: string): number[] => channel(r, id).map((s) => s.value);
const stamps = (r: Run, id: string): number[] => channel(r, id).map((s) => s.tMonoMs);

const BOTH_OFF: Flags = { imuFusionEnabled: false, imuGyroCaptureEnabled: false };
const CAPTURE_ONLY: Flags = { imuFusionEnabled: false, imuGyroCaptureEnabled: true };
const FUSION_ONLY: Flags = { imuFusionEnabled: true, imuGyroCaptureEnabled: false };

describe('P7R E3 -- capture-on/fusion-off does not alter latG/longG', () => {
  it('produces latG and longG IDENTICAL, value for value, to a run with both flags off', async () => {
    const steps = stimulus(200);
    const off = await run(BOTH_OFF, steps);
    const capture = await run(CAPTURE_ONLY, steps);

    // Not a no-op comparison: the run really did produce a lot of g samples.
    expect(values(off, 'latG').length).toBeGreaterThan(150);
    expect(values(capture, 'latG')).toHaveLength(values(off, 'latG').length);
    expect(values(capture, 'longG')).toHaveLength(values(off, 'longG').length);

    // THE GUARANTEE. Exact equality, not a tolerance -- the capture flag must
    // not touch the estimator at all.
    expect(values(capture, 'latG')).toEqual(values(off, 'latG'));
    expect(values(capture, 'longG')).toEqual(values(off, 'longG'));
    // ... and not their timing either: the low-pass path's freshness stamp is
    // taken from the emit that already happened, so the clock-call sequence
    // is unchanged too.
    expect(stamps(capture, 'latG')).toEqual(stamps(off, 'latG'));
    expect(stamps(capture, 'longG')).toEqual(stamps(off, 'longG'));
  });

  it('SENSITIVITY: fusion DOES move them -- so the equality above has teeth', async () => {
    const steps = stimulus(200);
    const off = await run(BOTH_OFF, steps);
    const fused = await run(FUSION_ONLY, steps);
    // If this ever fails, the assertion above is vacuous: it would mean this
    // harness cannot observe an estimator change in latG/longG at all.
    expect(values(fused, 'latG')).not.toEqual(values(off, 'latG'));
  });
});

describe('P7R E3 -- the two flags are genuinely independent', () => {
  it('capture ON subscribes the gyroscope and records yawRateDps; both OFF records none', async () => {
    const steps = stimulus(200);
    const off = await run(BOTH_OFF, steps);
    const capture = await run(CAPTURE_ONLY, steps);

    expect(off.gyroSubscribed).toBe(false);
    expect(values(off, 'yawRateDps')).toHaveLength(0);

    expect(capture.gyroSubscribed).toBe(true);
    const yaw = values(capture, 'yawRateDps');
    expect(yaw.length).toBeGreaterThan(100);
    for (const value of yaw) {
      expect(Number.isFinite(value)).toBe(true);
      // 0.6 rad/s is ~34.4 deg/s; the projection cannot exceed the rotation.
      expect(Math.abs(value)).toBeLessThanOrEqual(35);
    }
    // Not a constant: the channel actually follows the stimulus.
    expect(new Set(yaw.map((v) => v.toFixed(3))).size).toBeGreaterThan(20);
  });

  it('the captured yaw carries the SIGN of the rotation -- what Monday exists to settle', async () => {
    // A steady right turn under the Android rest convention (`up`): the
    // compass-sense rate must come out POSITIVE. Steady, so the low-pass
    // vertical the capture-only path projects onto is fully settled.
    const steps: Step[] = [];
    for (let i = 0; i < 200; i += 1) {
      steps.push({ tMonoMs: i * 40, accel: { x: 0, y: 0, z: 1 }, gyro: { x: 0, y: 0, z: -0.5 } });
    }
    const yaw = values(await run(CAPTURE_ONLY, steps), 'yawRateDps');
    expect(yaw.length).toBeGreaterThan(100);
    const settled = yaw.slice(-50);
    for (const value of settled) expect(value).toBeGreaterThan(0);
    // ~28.6 deg/s, projected onto a settled unit vertical.
    expect(settled[settled.length - 1]).toBeCloseTo((0.5 * 180) / Math.PI, 1);
  });

  it('fusion ON with capture OFF still subscribes the gyroscope -- fusion needs it', async () => {
    const fused = await run(FUSION_ONLY, stimulus(200));
    expect(fused.gyroSubscribed).toBe(true);
  });

  it('a provider given NEITHER dependency is the pre-P7R provider', async () => {
    // Every existing caller that wires only `imuFusionEnabled` must behave
    // exactly as it did: absent means capture off.
    const accel = new ScriptedSensor();
    const gyro = new ScriptedSensor();
    const samples: TelemetrySample[] = [];
    let clockMs = 0;
    const provider = createGForceProvider({
      monotonicNow: () => clockMs,
      accelerometerSource: async () => accel,
      gyroscopeSource: async () => gyro,
      accelerometerRestVector: 'up',
    });
    provider.onSample((s) => samples.push(s));
    provider.start();
    await flushMicrotasks();
    for (const step of stimulus(50)) {
      clockMs = step.tMonoMs;
      gyro.listener?.(step.gyro);
      accel.listener?.(step.accel);
    }
    await provider.stop();

    expect(gyro.subscribeCount).toBe(0);
    expect(samples.filter((s) => s.channel === 'yawRateDps')).toHaveLength(0);
    expect(samples.filter((s) => s.channel === 'latG').length).toBeGreaterThan(40);
  });
});

describe('P7R E3 -- the setting, its default and its copy', () => {
  it('defaults to capture ON, fusion OFF', () => {
    expect(DEFAULT_SETTINGS.imuGyroCaptureEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.imuFusionEnabled).toBe(false);
  });

  it('is an independent toggle on the in-memory store', () => {
    const store = new InMemorySettingsStore();
    store.update({ imuGyroCaptureEnabled: false });
    expect(store.getSettings().imuGyroCaptureEnabled).toBe(false);
    expect(store.getSettings().imuFusionEnabled).toBe(false);
    store.update({ imuFusionEnabled: true });
    expect(store.getSettings().imuGyroCaptureEnabled).toBe(false);
  });

  it('a row written BEFORE this setting existed hydrates to the default (true), not to undefined', async () => {
    const db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ units: 'mph', imuFusionEnabled: false }),
    ]);
    const store = await SqlSettingsStore.create(db);
    expect(store.getSettings().imuGyroCaptureEnabled).toBe(true);
  });

  it('a present-but-malformed value is repaired to the DEFAULT, never trusted as written', async () => {
    const db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ imuGyroCaptureEnabled: 'yes' }),
    ]);
    const store = await SqlSettingsStore.create(db);
    expect(store.getSettings().imuGyroCaptureEnabled).toBe(true);
  });

  it('an explicit OFF survives the round trip -- the default never overrides a choice', async () => {
    const db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    const first = await SqlSettingsStore.create(db);
    first.update({ imuGyroCaptureEnabled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reopened = await SqlSettingsStore.create(db);
    expect(reopened.getSettings().imuGyroCaptureEnabled).toBe(false);
  });

  it('RO carries every key EN does, and the copy separates the two rows', () => {
    const table = IMU_GYRO_CAPTURE_SETTING_STRINGS;
    expect(Object.keys(table.ro).sort()).toEqual(Object.keys(table.en).sort());
    for (const language of ['en', 'ro'] as const) {
      for (const value of Object.values(table[language])) {
        expect(typeof value).toBe('string');
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
    // The distinction a driver has to be able to make: this row records a new
    // measurement and is on; the other changes an existing one and is off.
    expect(table.en.helpBounds).toContain('On by default');
    expect(table.ro.helpBounds).toContain('Pornit implicit');
    expect(IMU_FUSION_SETTING_STRINGS.en.helpBounds).toContain('Off by default');
    // And each says the bound that matters: neither touches lap timing.
    expect(table.en.helpBounds).toContain('lap timing');
    expect(table.ro.helpBounds).toContain('cronometrare');
  });
});
