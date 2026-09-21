import { describe, expect, it } from 'vitest';
import {
  cleanRecognitionLap,
  multiLapSession,
  runSessionPipeline,
  type LocationSample,
  type TelemetrySample,
} from '@circuit/core';

import { InMemorySettingsStore } from '../../src/session/settingsStore';
import { createGForceProvider } from '../../src/session/gforceProvider';
import {
  assembleSessionAnalysis,
  type AnalysisLapRecording,
} from '../../src/session/analysisAssembly';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P6a, the acceptance test (requirement E): the SAME fixture session
 * driven end to end with both new flags OFF and with both ON.
 *
 * "End to end" here means all three things the ticket touches, each wired the
 * way `composition.ts` wires it:
 *  1. the production lap-timing pipeline (`runSessionPipeline`) over a real
 *     replay fixture on a real catalog circuit;
 *  2. the live G-force provider, reading `imuFusionEnabled` off a real
 *     `SettingsStore`;
 *  3. the post-session analysis read path, reading `analysisSmoothingEnabled`
 *     off the same store.
 *
 * The two claims: (i) LAP TIMES ARE IDENTICAL with the flags off, on, and
 * against a baseline run that has neither a provider nor a settings store
 * anywhere near it -- lap times are the product, and neither flag is allowed
 * within reach of them; (ii) the ON path produces finite, bounded latG/longG.
 */

const GRAVITY_MPS2 = 9.80665;
/** The synthesized stimulus is a car, not a polyline: cap the derived yaw rate at a rate a car can actually hold. */
const MAX_STIMULUS_YAW_DPS = 30;
const FIXTURE_SEED = 6_101;
const FIXTURE_LAPS = 3;

const { circuit } = allBundledCircuits()[0]!;

function wrappedHeadingDelta(from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

/**
 * The PRODUCTION timing pipeline over the shared replay fixture. Deliberately
 * takes no settings, no provider and no flag: this is the baseline every run
 * below has to reproduce exactly.
 */
function fixtureLapTimes(): number[] {
  const result = runSessionPipeline(circuit.runtime, multiLapSession(circuit.profile, FIXTURE_LAPS, FIXTURE_SEED), {
    calibrateFirst: cleanRecognitionLap(circuit.profile, FIXTURE_SEED - 1),
  });
  return result.laps.map((lap) => lap.durationMs);
}

interface ImuStimulus {
  tMonoMs: number;
  accel: { x: number; y: number; z: number };
  gyro: { x: number; y: number; z: number };
}

/**
 * An accelerometer + gyroscope stream derived from the lap's OWN GNSS trace,
 * so the synthetic IMU agrees with the drive instead of being invented beside
 * it. Flat/portrait mount, matching the provider's documented assumption:
 * device x is lateral, y is longitudinal, z is vertical (gravity reads +1 g).
 * The gyroscope's z is NEGATED relative to the compass-sense yaw rate, because
 * that is the convention a real right-handed gyroscope reports in.
 */
function imuStimulus(samples: readonly LocationSample[]): ImuStimulus[] {
  const out: ImuStimulus[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const next = samples[index + 1];
    if (sample === undefined) continue;
    const speedMps = sample.speedMps ?? 0;
    let accelMps2 = 0;
    let yawDps = 0;
    if (next !== undefined) {
      const dtSeconds = (next.tMono - sample.tMono) / 1_000;
      if (dtSeconds > 0) {
        accelMps2 = ((next.speedMps ?? 0) - speedMps) / dtSeconds;
        if (sample.headingDeg !== undefined && next.headingDeg !== undefined) {
          yawDps = wrappedHeadingDelta(sample.headingDeg, next.headingDeg) / dtSeconds;
        }
      }
    }
    const clampedYawDps = Math.max(-MAX_STIMULUS_YAW_DPS, Math.min(MAX_STIMULUS_YAW_DPS, yawDps));
    const yawRadPerSec = (clampedYawDps * Math.PI) / 180;
    out.push({
      tMonoMs: sample.tMono,
      accel: {
        x: (yawRadPerSec * speedMps) / GRAVITY_MPS2,
        y: accelMps2 / GRAVITY_MPS2,
        z: 1,
      },
      gyro: { x: 0, y: 0, z: -yawRadPerSec },
    });
  }
  return out;
}

const flushMicrotasks = async (times = 12): Promise<void> => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

class ScriptedSensor {
  listener: ((r: { x: number; y: number; z: number }) => void) | null = null;
  async isAvailableAsync(): Promise<boolean> {
    return true;
  }
  setUpdateInterval(): void {
    /* the stimulus drives the cadence here, not the sensor */
  }
  addListener(listener: (r: { x: number; y: number; z: number }) => void): { remove(): void } {
    this.listener = listener;
    return {
      remove: () => {
        this.listener = null;
      },
    };
  }
}

/** Runs one lap's IMU stimulus through the REAL provider, wired off the REAL settings store. */
async function captureGSamples(
  store: InMemorySettingsStore,
  stimulus: readonly ImuStimulus[],
): Promise<TelemetrySample[]> {
  const accel = new ScriptedSensor();
  const gyro = new ScriptedSensor();
  const samples: TelemetrySample[] = [];
  let clockMs = 0;
  const provider = createGForceProvider({
    monotonicNow: () => clockMs,
    accelerometerSource: async () => accel,
    gyroscopeSource: async () => gyro,
    // Exactly the wiring `composition.ts` uses.
    imuFusionEnabled: () => store.getSettings().imuFusionEnabled,
  });
  provider.onSample((sample) => samples.push(sample));
  provider.start();
  await flushMicrotasks();
  for (const step of stimulus) {
    clockMs = step.tMonoMs;
    gyro.listener?.(step.gyro);
    accel.listener?.(step.accel);
  }
  await provider.stop();
  return samples;
}

interface FixtureRun {
  lapTimes: number[];
  gSamples: TelemetrySample[];
  assembled: ReturnType<typeof assembleSessionAnalysis>;
}

async function driveFixture(flags: {
  imuFusionEnabled: boolean;
  analysisSmoothingEnabled: boolean;
}): Promise<FixtureRun> {
  const store = new InMemorySettingsStore();
  store.update(flags);

  // 1. Lap timing -- the same production pipeline over the same fixture.
  const lapTimes = fixtureLapTimes();

  // 2. The live G provider over the recorded drive of the same session.
  const session = driveSession(circuit, {
    laps: FIXTURE_LAPS,
    channels: 'full',
    seed: FIXTURE_SEED,
  });
  const gSamples: TelemetrySample[] = [];
  const recordings: AnalysisLapRecording[] = [];
  for (const recording of session.recordings) {
    const lapG = await captureGSamples(store, imuStimulus(recording.locationSamples));
    gSamples.push(...lapG);
    recordings.push({ ...recording, telemetry: [...recording.telemetry, ...lapG] });
  }

  // 3. The post-session analysis read path, gated by the same store.
  const assembled = assembleSessionAnalysis(
    circuit,
    recordings,
    store.getSettings().analysisSmoothingEnabled ? { smoothGForceChannels: true } : {},
  );
  return { lapTimes, gSamples, assembled };
}

describe('P6a requirement E -- the same fixture session, flags OFF and ON', () => {
  it('(i) lap times are IDENTICAL: flags off, flags on, and the flag-free baseline', async () => {
    const baseline = fixtureLapTimes();
    expect(baseline.length).toBe(FIXTURE_LAPS);
    expect(baseline.every((ms) => ms > 0)).toBe(true);

    const off = await driveFixture({ imuFusionEnabled: false, analysisSmoothingEnabled: false });
    const on = await driveFixture({ imuFusionEnabled: true, analysisSmoothingEnabled: true });

    expect(off.lapTimes).toEqual(baseline);
    expect(on.lapTimes).toEqual(baseline);
    expect(on.lapTimes).toEqual(off.lapTimes);
  });

  it('(ii) the ON path produces finite, bounded latG/longG -- and a yaw-rate channel that was not there before', async () => {
    const off = await driveFixture({ imuFusionEnabled: false, analysisSmoothingEnabled: false });
    const on = await driveFixture({ imuFusionEnabled: true, analysisSmoothingEnabled: true });

    const gOf = (run: FixtureRun): TelemetrySample[] =>
      run.gSamples.filter((s) => s.channel === 'latG' || s.channel === 'longG');

    expect(gOf(on).length).toBeGreaterThan(100);
    // Same cadence: the flag changes the VALUES, never how many rows a session records.
    expect(gOf(on)).toHaveLength(gOf(off).length);
    for (const sample of gOf(on)) {
      expect(Number.isFinite(sample.value)).toBe(true);
      expect(Math.abs(sample.value)).toBeLessThanOrEqual(5);
    }
    // ... and they are genuinely the fused estimate, not the low-pass one.
    expect(gOf(on).map((s) => s.value)).not.toEqual(gOf(off).map((s) => s.value));

    expect(off.gSamples.filter((s) => s.channel === 'yawRateDps')).toHaveLength(0);
    const yaw = on.gSamples.filter((s) => s.channel === 'yawRateDps');
    expect(yaw.length).toBeGreaterThan(100);
    for (const sample of yaw) {
      expect(Number.isFinite(sample.value)).toBe(true);
      expect(Math.abs(sample.value)).toBeLessThanOrEqual(MAX_STIMULUS_YAW_DPS + 1e-9);
    }
  });

  it('the flags-OFF assembly is the assembly this code produced before the flags existed', async () => {
    const off = await driveFixture({ imuFusionEnabled: false, analysisSmoothingEnabled: false });
    const session = driveSession(circuit, {
      laps: FIXTURE_LAPS,
      channels: 'full',
      seed: FIXTURE_SEED,
    });
    // The pre-P6a call: no provider samples, no options object at all.
    const legacyRecordings = session.recordings.map((recording, index) => ({
      ...recording,
      telemetry: [
        ...recording.telemetry,
        ...off.gSamples.filter(
          (sample) =>
            sample.tMonoMs >= (session.recordings[index]?.locationSamples[0]?.tMono ?? 0) &&
            sample.tMonoMs <=
              (session.recordings[index]?.locationSamples.at(-1)?.tMono ?? Number.MAX_SAFE_INTEGER),
        ),
      ],
    }));
    expect(assembleSessionAnalysis(circuit, legacyRecordings)).toEqual(off.assembled);
  });

  it('the ON path carries yawRateDps all the way into the analysis engine input', async () => {
    const on = await driveFixture({ imuFusionEnabled: true, analysisSmoothingEnabled: true });
    const carrying = on.assembled.laps
      .flatMap((lap) => lap.samples)
      .filter((sample) => Number.isFinite(sample.channels?.yawRateDps));
    expect(carrying.length).toBeGreaterThan(100);
    expect(on.assembled.usedChannels).toContain('yawRateDps');
  });
});
