import { describe, expect, it } from 'vitest';
import {
  cleanRecognitionLap,
  multiLapSession,
  runSessionPipeline,
  type LocationSample,
  type TelemetrySample,
} from '@circuit/core';

import { InMemorySettingsStore } from '../../src/session/settingsStore';
import {
  connectGForceRecording,
  createGForceProvider,
  type AccelerometerReading,
  type AccelerometerSubscription,
} from '../../src/session/gforceProvider';
import {
  assembleSessionAnalysis,
  type AnalysisLapRecording,
} from '../../src/session/analysisAssembly';
import { allBundledCircuits, driveSession } from '../support/analysisHarness';

/**
 * Ticket P6a requirement E, REWRITTEN for P6a-FIX1 V1.
 *
 * The first version of this file was VACUOUS and a blind verifier caught it:
 * its `fixtureLapTimes()` took no arguments and touched neither the settings
 * store nor the G-force provider, so `off.lapTimes`, `on.lapTimes` and
 * `baseline` were three calls to the same pure function and the assertion
 * could not fail whatever the flags did. The PROPERTY is true, but the test
 * was not evidence of it and it gave false regression cover.
 *
 * What replaces it drives the fixture session through the wiring that decides
 * the property, with that wiring as a PARAMETER:
 *
 *  - {@link PRODUCTION_SINK} is what `composition.ts` actually does with a
 *    G-force sample -- `gForceProvider.onSample(s => recorder.record(s, lap))`
 *    and nothing else. The recorder is a telemetry sink; the timing engine
 *    never sees it.
 *  - {@link LEAKY_SINK} is the isolation being broken: the same samples ALSO
 *    reach the location stream the timing pipeline consumes, which is the
 *    realistic form of the mistake (someone "improves" positioning with the
 *    accelerometer).
 *
 * Both run the real `runSessionPipeline` over the resulting stream. With the
 * production sink the lap times must not move when the flags move; with the
 * leaky sink they MUST, and that second test is what proves the first one has
 * teeth. A change that let G samples reach the timing stream would flip both.
 */

const GRAVITY_MPS2 = 9.80665;
const MAX_STIMULUS_YAW_DPS = 30;
const FIXTURE_SEED = 6_101;
const FIXTURE_LAPS = 3;

const { circuit } = allBundledCircuits()[0]!;

interface Flags {
  imuFusionEnabled: boolean;
  analysisSmoothingEnabled: boolean;
}

const FLAGS_OFF: Flags = { imuFusionEnabled: false, analysisSmoothingEnabled: false };
const FLAGS_ON: Flags = { imuFusionEnabled: true, analysisSmoothingEnabled: true };

function wrappedHeadingDelta(from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

interface ImuStimulus {
  tMonoMs: number;
  accel: AccelerometerReading;
  gyro: AccelerometerReading;
}

/** One GNSS fix and the IMU samples that arrive while it is the newest one. */
interface ImuGroup {
  base: LocationSample;
  steps: ImuStimulus[];
}

/** The rate the provider actually asks its sensors for (~25 Hz). */
const IMU_INTERVAL_MS = 40;

/**
 * An accelerometer + gyroscope stream derived from a GNSS trace, so the
 * synthetic IMU agrees with the drive instead of being invented beside it.
 *
 * Driven at the IMU's OWN ~25 Hz rate, not at the GNSS rate. The bundled
 * replay fixtures are 1 Hz (which is what the shipped app records on iPhone),
 * and feeding an inertial filter one sample per second would be a stimulus no
 * real device ever produces -- it would sit permanently past the provider's
 * stream-break threshold and reseed on every sample. Each GNSS interval is
 * therefore filled with the ~25 IMU samples that would really have arrived
 * inside it, holding that interval's derived acceleration and yaw rate.
 *
 * Flat mount (device z vertical, reading +1 g at rest); the gyroscope's z is
 * negated relative to the compass-sense yaw rate, as a right-handed gyroscope
 * reports it.
 */
function imuStimulusGroups(samples: readonly LocationSample[]): ImuGroup[] {
  const groups: ImuGroup[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const next = samples[index + 1];
    if (sample === undefined) continue;
    const speedMps = sample.speedMps ?? 0;
    let accelMps2 = 0;
    let yawDps = 0;
    let spanMs = IMU_INTERVAL_MS;
    if (next !== undefined) {
      spanMs = next.tMono - sample.tMono;
      const dtSeconds = spanMs / 1_000;
      if (dtSeconds > 0) {
        accelMps2 = ((next.speedMps ?? 0) - speedMps) / dtSeconds;
        if (sample.headingDeg !== undefined && next.headingDeg !== undefined) {
          yawDps = wrappedHeadingDelta(sample.headingDeg, next.headingDeg) / dtSeconds;
        }
      }
    }
    const clampedYawDps = Math.max(-MAX_STIMULUS_YAW_DPS, Math.min(MAX_STIMULUS_YAW_DPS, yawDps));
    const yawRadPerSec = (clampedYawDps * Math.PI) / 180;
    const accel: AccelerometerReading = {
      x: (yawRadPerSec * speedMps) / GRAVITY_MPS2,
      y: accelMps2 / GRAVITY_MPS2,
      z: 1,
    };
    const gyro: AccelerometerReading = { x: 0, y: 0, z: -yawRadPerSec };
    const count = Math.max(1, Math.round(spanMs / IMU_INTERVAL_MS));
    const steps: ImuStimulus[] = [];
    for (let step = 0; step < count; step += 1) {
      steps.push({ tMonoMs: sample.tMono + step * IMU_INTERVAL_MS, accel, gyro });
    }
    groups.push({ base: sample, steps });
  }
  return groups;
}

class ScriptedSensor {
  listener: ((r: AccelerometerReading) => void) | null = null;
  async isAvailableAsync(): Promise<boolean> {
    return true;
  }
  setUpdateInterval(): void {
    /* the stimulus drives the cadence */
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

/**
 * Ticket P6a-FIX2 V1: where a recorded G-force sample ends up.
 *
 * `record` is the dependency `connectGForceRecording` -- the REAL production
 * seam, imported from `composition.ts` -- is given. In production
 * `startTelemetryRecording` passes `recorder.record`; here the test passes one
 * of the two below. The subscription itself, the lap-number tagging and the
 * callback body are production code in both cases, executed by this test.
 */
interface SinkContext {
  /** The telemetry recorder stand-in -- where production samples go. */
  recorded: TelemetrySample[];
  /** The location stream the TIMING pipeline will consume. */
  timingStream: LocationSample[];
  /** The GNSS fix currently being processed. */
  current: () => LocationSample | null;
}
type GSampleSink = (
  sample: TelemetrySample,
  lapNumber: number | null,
  context: SinkContext,
) => void;

/** What a `TelemetryRecorder` does: store the sample against its lap. Nothing else. */
const PRODUCTION_SINK: GSampleSink = (sample, lapNumber, context) => {
  context.recorded.push({ ...sample, lapNumber } as TelemetrySample & { lapNumber: number | null });
};

/**
 * The isolation deliberately broken AT THE SAME BOUNDARY: the recorder also
 * turns the sample into a location fix the timing pipeline will read. This is
 * the realistic shape of the mistake -- something downstream of the provider
 * feeding the positioning path -- and it is injected exactly where production
 * injects its own sink, so the sensitivity test exercises the same code.
 */
const LEAKY_SINK: GSampleSink = (sample, lapNumber, context) => {
  PRODUCTION_SINK(sample, lapNumber, context);
  const current = context.current();
  if (current === null) return;
  context.timingStream.push({
    ...current,
    // The G sample's OWN monotonic stamp, so the leaked fix is a distinct
    // sample in the stream rather than a duplicate the pipeline discards.
    tMono: sample.tMonoMs,
    lat: current.lat + sample.value * 1e-4,
    lon: current.lon + sample.value * 1e-4,
  });
};

interface FixtureRun {
  lapTimes: number[];
  recorded: TelemetrySample[];
}

/**
 * One whole fixture session: the IMU stimulus through the REAL provider wired
 * off a REAL settings store, the resulting samples through `sink`, and the
 * production timing pipeline over whatever location stream came out.
 */
async function runTimedFixture(flags: Flags, sink: GSampleSink): Promise<FixtureRun> {
  const store = new InMemorySettingsStore();
  store.update(flags);

  const gnss = multiLapSession(circuit.profile, FIXTURE_LAPS, FIXTURE_SEED);
  const groups = imuStimulusGroups(gnss);

  const accel = new ScriptedSensor();
  const gyro = new ScriptedSensor();
  const recorded: TelemetrySample[] = [];
  const timingStream: LocationSample[] = [];
  let current: LocationSample | null = null;
  let currentLap: number | null = null;
  let clockMs = 0;

  const provider = createGForceProvider({
    monotonicNow: () => clockMs,
    accelerometerSource: async () => accel,
    gyroscopeSource: async () => gyro,
    // The wiring `composition.ts` uses.
    imuFusionEnabled: () => store.getSettings().imuFusionEnabled,
// P6a-FIX2 H1: stated explicitly so the lazy platform read is never reached under vitest.
accelerometerRestVector: 'down',
  });
  // THE PRODUCTION WIRING, executed -- not a copy of it. `composition.ts`'s
  // `startTelemetryRecording` calls this exact function with the session's
  // recorder; the only thing this test substitutes is where `record` puts the
  // sample, which is the same seam the sensitivity mutation is injected at.
  const unsubscribe = connectGForceRecording({
    provider,
    record: (sample, lapNumber) => {
      sink(sample, lapNumber, { recorded, timingStream, current: () => current });
    },
    currentLapNumber: () => currentLap,
  });
  provider.start();
  await flushMicrotasks();

  for (const [index, group] of groups.entries()) {
    current = group.base;
    // A plausible lap number so the seam's own tagging is exercised too.
    currentLap = Math.floor(index / Math.max(1, Math.ceil(groups.length / FIXTURE_LAPS))) + 1;
    // The GNSS fix first, then the ~25 Hz IMU samples that arrive while it is
    // the newest one -- the sink fires from inside those, so anything it
    // appends lands after the fix it belongs to.
    timingStream.push(group.base);
    for (const step of group.steps) {
      clockMs = step.tMonoMs;
      gyro.listener?.(step.gyro);
      accel.listener?.(step.accel); // the sink fires from inside here
    }
  }
  unsubscribe();
  await provider.stop();

  const result = runSessionPipeline(circuit.runtime, timingStream, {
    calibrateFirst: cleanRecognitionLap(circuit.profile, FIXTURE_SEED - 1),
  });
  return { lapTimes: result.laps.map((lap) => lap.durationMs), recorded };
}

/** The pipeline over the untouched fixture: no provider, no store, no flag. */
function baselineLapTimes(): number[] {
  const result = runSessionPipeline(
    circuit.runtime,
    multiLapSession(circuit.profile, FIXTURE_LAPS, FIXTURE_SEED),
    { calibrateFirst: cleanRecognitionLap(circuit.profile, FIXTURE_SEED - 1) },
  );
  return result.laps.map((lap) => lap.durationMs);
}

describe('P6a requirement E (rewritten, P6a-FIX1 V1) -- lap times do not depend on the flags', () => {
  it('with the PRODUCTION sink, lap times are identical: flags off, flags on, and the flag-free baseline', async () => {
    const baseline = baselineLapTimes();
    expect(baseline).toHaveLength(FIXTURE_LAPS);
    expect(baseline.every((ms) => ms > 0)).toBe(true);

    const off = await runTimedFixture(FLAGS_OFF, PRODUCTION_SINK);
    const on = await runTimedFixture(FLAGS_ON, PRODUCTION_SINK);

    // The runs really did produce different telemetry -- so this is a
    // comparison between two genuinely different G streams, not two no-ops.
    expect(off.recorded.length).toBeGreaterThan(100);
    expect(on.recorded.length).toBeGreaterThan(off.recorded.length); // yawRateDps rows
    expect(on.recorded.map((s) => s.value)).not.toEqual(off.recorded.map((s) => s.value));

    expect(off.lapTimes).toEqual(baseline);
    expect(on.lapTimes).toEqual(baseline);
  });

  it('SENSITIVITY: with the isolation broken, the same comparison DOES separate -- so the test above has teeth', async () => {
    // If this fails, the assertion above is vacuous again: it would mean the
    // harness cannot observe the flags influencing lap times even when the
    // G samples are wired straight into the location stream.
    const off = await runTimedFixture(FLAGS_OFF, LEAKY_SINK);
    const on = await runTimedFixture(FLAGS_ON, LEAKY_SINK);
    expect(on.lapTimes).not.toEqual(off.lapTimes);

    // ... and the leak moves the times away from the baseline at all, which is
    // what makes the production-sink equality above a real statement.
    const baseline = baselineLapTimes();
    expect(off.lapTimes).not.toEqual(baseline);
  });

  it('the ON path produces finite, bounded latG/longG, and a yaw-rate channel that was not there before', async () => {
    const off = await runTimedFixture(FLAGS_OFF, PRODUCTION_SINK);
    const on = await runTimedFixture(FLAGS_ON, PRODUCTION_SINK);
    const gOf = (run: FixtureRun): TelemetrySample[] =>
      run.recorded.filter((s) => s.channel === 'latG' || s.channel === 'longG');

    expect(gOf(on).length).toBeGreaterThan(100);
    expect(gOf(on)).toHaveLength(gOf(off).length);
    for (const sample of gOf(on)) {
      expect(Number.isFinite(sample.value)).toBe(true);
      expect(Math.abs(sample.value)).toBeLessThanOrEqual(5);
    }
    expect(gOf(on).map((s) => s.value)).not.toEqual(gOf(off).map((s) => s.value));

    expect(off.recorded.filter((s) => s.channel === 'yawRateDps')).toHaveLength(0);
    const yaw = on.recorded.filter((s) => s.channel === 'yawRateDps');
    expect(yaw.length).toBeGreaterThan(100);
    for (const sample of yaw) {
      expect(Number.isFinite(sample.value)).toBe(true);
      expect(Math.abs(sample.value)).toBeLessThanOrEqual(MAX_STIMULUS_YAW_DPS + 1e-3);
    }
  });
});

describe('P6a requirement E -- the analysis half of the same fixture session', () => {
  async function analysedFixture(flags: Flags): Promise<{
    assembled: ReturnType<typeof assembleSessionAnalysis>;
    recordings: AnalysisLapRecording[];
  }> {
    const store = new InMemorySettingsStore();
    store.update(flags);
    const session = driveSession(circuit, {
      laps: FIXTURE_LAPS,
      channels: 'full',
      seed: FIXTURE_SEED,
    });

    const recordings: AnalysisLapRecording[] = [];
    for (const recording of session.recordings) {
      const accel = new ScriptedSensor();
      const gyro = new ScriptedSensor();
      const lapG: TelemetrySample[] = [];
      let clockMs = 0;
      const provider = createGForceProvider({
        monotonicNow: () => clockMs,
        accelerometerSource: async () => accel,
        gyroscopeSource: async () => gyro,
        imuFusionEnabled: () => store.getSettings().imuFusionEnabled,
// P6a-FIX2 H1: stated explicitly so the lazy platform read is never reached under vitest.
accelerometerRestVector: 'down',
      });
      provider.onSample((sample) => lapG.push(sample));
      provider.start();
      await flushMicrotasks();
      for (const group of imuStimulusGroups(recording.locationSamples)) {
        for (const step of group.steps) {
          clockMs = step.tMonoMs;
          gyro.listener?.(step.gyro);
          accel.listener?.(step.accel);
        }
      }
      await provider.stop();
      recordings.push({ ...recording, telemetry: [...recording.telemetry, ...lapG] });
    }

    return {
      assembled: assembleSessionAnalysis(
        circuit,
        recordings,
        store.getSettings().analysisSmoothingEnabled ? { smoothGForceChannels: true } : {},
      ),
      recordings,
    };
  }

  it('the flags-OFF assembly is the assembly this code produced before the flags existed', async () => {
    const off = await analysedFixture(FLAGS_OFF);
    // The pre-P6a call: no options object at all, over the same recordings.
    expect(assembleSessionAnalysis(circuit, off.recordings)).toEqual(off.assembled);
  });

  it('the ON path carries yawRateDps all the way into the analysis engine input', async () => {
    const on = await analysedFixture(FLAGS_ON);
    const carrying = on.assembled.laps
      .flatMap((lap) => lap.samples)
      .filter((sample) => Number.isFinite(sample.channels?.yawRateDps));
    expect(carrying.length).toBeGreaterThan(100);
    expect(on.assembled.usedChannels).toContain('yawRateDps');
  });
});

describe('P6a-FIX2 V1 -- the production seam itself', () => {
  it('connectGForceRecording routes a sample to `record` and does nothing else with it', () => {
    // The seam is the ONE place `startTelemetryRecording` routes G samples,
    // so "it only records" is the property that keeps the provider away from
    // lap timing -- asserted here on the real function.
    const listeners = new Set<(s: TelemetrySample) => void>();
    const provider = {
      onSample(cb: (s: TelemetrySample) => void): () => void {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    const calls: { sample: TelemetrySample; lapNumber: number | null }[] = [];
    let lap: number | null = null;
    const unsubscribe = connectGForceRecording({
      provider,
      record: (sample, lapNumber) => calls.push({ sample, lapNumber }),
      currentLapNumber: () => lap,
    });

    const emit = (sample: TelemetrySample): void => {
      for (const listener of [...listeners]) listener(sample);
    };
    emit({ channel: 'latG', value: 0.4, tMonoMs: 10 });
    lap = 3;
    emit({ channel: 'yawRateDps', value: -12, tMonoMs: 20 });

    // Exactly one `record` per sample, the sample passed through unchanged,
    // and the lap number read at DELIVERY time rather than captured.
    expect(calls).toEqual([
      { sample: { channel: 'latG', value: 0.4, tMonoMs: 10 }, lapNumber: null },
      { sample: { channel: 'yawRateDps', value: -12, tMonoMs: 20 }, lapNumber: 3 },
    ]);

    unsubscribe();
    emit({ channel: 'latG', value: 9, tMonoMs: 30 });
    expect(calls).toHaveLength(2); // the handle really detaches
  });
});
