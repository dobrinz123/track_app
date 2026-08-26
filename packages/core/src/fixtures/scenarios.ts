import type { CircuitProfile, LocalPoint, LocationSample } from '../contracts';
import { polylineLength, projectOntoPolyline } from '../geometry';

import {
  driveLap,
  runtimeFor,
  sampleAtLapDistance,
  withFixtureMetadata,
  type TelemetryFixture,
} from './drive-lap';

export interface ScenarioFixtureOptions {
  seed?: number;
}

function seedOf(options: ScenarioFixtureOptions | number | undefined): number {
  return typeof options === 'number' ? options : (options?.seed ?? 1);
}

function relabel(
  samples: LocationSample[],
  scenario: string,
  seed: number,
  expectedOutcome: string,
): TelemetryFixture {
  return withFixtureMetadata(samples, { scenario, seed, expectedOutcome });
}

/** Exercises full-lap calibration; expected: accepted, correct direction, >=95% coverage. */
export function cleanRecognitionLap(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  return relabel(
    driveLap(profile, { seed, noiseSigmaM: 1.5, startDistanceM: 0, endPaddingM: 5 }),
    'cleanRecognitionLap',
    seed,
    'Calibration is accepted in the profile direction with at least 95% coverage.',
  );
}

/** Exercises continuous timing; expected: exactly n complete, valid laps. */
export function multiLapSession(
  profile: CircuitProfile,
  laps: number,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  return relabel(
    driveLap(profile, { seed, lapCount: laps }),
    'multiLapSession',
    seed,
    `Exactly ${laps} valid laps complete with ordered sectors.`,
  );
}

/** Exercises PB replacement; expected: the final lap is strictly faster than every prior lap. */
export function pbImprovementSession(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  return relabel(
    driveLap(profile, {
      seed,
      lapCount: 3,
      speedMps: ({ lapIndex }) => [36, 41, 48][Math.min(lapIndex, 2)] ?? 48,
    }),
    'pbImprovementSession',
    seed,
    'Lap 3 is faster than laps 1 and 2 and is eligible to replace the PB.',
  );
}

/** Exercises PB rejection and positive delta; expected: the final lap is slower than lap 1. */
export function slowerLapSession(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  return relabel(
    driveLap(profile, {
      seed,
      lapCount: 2,
      speedMps: ({ lapIndex }) => (lapIndex === 0 ? 48 : 36),
    }),
    'slowerLapSession',
    seed,
    'Lap 2 is slower than lap 1 and cannot replace it as PB.',
  );
}

/** Exercises matcher robustness to heavy noise; expected: noisy but deterministic telemetry. */
export function noisyGpsLap(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  return relabel(
    driveLap(profile, { seed, noiseSigmaM: 8, accuracyM: 8 }),
    'noisyGpsLap',
    seed,
    'Eight-metre Gaussian noise lowers confidence without breaking deterministic replay.',
  );
}

/** Exercises GNSS-gap propagation; expected: the affected lap is LOW_QUALITY or invalid. */
export function signalLossLap(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  const samples = driveLap(profile, { seed });
  const split = Math.floor(samples.length / 2);
  const shifted = samples.map((sample, index) => ({
    ...sample,
    tMono: sample.tMono + (index >= split ? 15_000 : 0),
  }));
  return relabel(
    shifted,
    'signalLossLap',
    seed,
    'A 15 s gap invalidates the affected lap as LOW_QUALITY.',
  );
}

/** Exercises impossible-speed rejection; expected: teleport rejected and no phantom gate crossing. */
export function impossibleJumpLap(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  const runtime = runtimeFor(profile);
  const samples = driveLap(profile, { seed });
  const index = Math.floor(samples.length / 2);
  const original = samples[index];
  if (original !== undefined) {
    const local = runtime.projection.toLocal(original);
    const teleported = runtime.projection.toLatLon({ e: local.e + 500, n: local.n });
    samples[index] = { ...original, ...teleported };
  }
  return relabel(
    samples,
    'impossibleJumpLap',
    seed,
    'The 500 m teleport is rejected and emits no crossing.',
  );
}

/** Exercises gate debounce; expected: five +/-3 m oscillations count as one forward S/F crossing. */
export function startLineJitterLap(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  const distances = [-10, -3, 3, -3, 3, -3, 3, 10, 60];
  const samples = distances.map((distanceM, index) =>
    sampleAtLapDistance(profile, distanceM, index * 1_000, { speedMps: 6, accuracyM: 2 }),
  );
  return relabel(
    samples,
    'startLineJitterLap',
    seed,
    'The rearm guard suppresses duplicate jitter crossings.',
  );
}

/** Exercises reverse progress; expected: no lap completes and an opened lap is REVERSE_TRAVEL invalid. */
export function reverseTravelLap(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  const total = profile.totalLengthM;
  const distances = [-20, 20, 80, 140, 200];
  for (let distance = 160; distance >= -total * 0.75; distance -= 40) distances.push(distance);
  const samples = distances.map((distanceM, index) =>
    sampleAtLapDistance(profile, distanceM, index * 1_000, { speedMps: 40, accuracyM: 3 }),
  );
  return relabel(
    samples,
    'reverseTravelLap',
    seed,
    'Reverse progress invalidates the open lap and never completes it.',
  );
}

function interpolateRoute(points: readonly LocalPoint[], spacingM: number): LocalPoint[] {
  const output: LocalPoint[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    if (a === undefined || b === undefined) continue;
    const length = Math.hypot(b.e - a.e, b.n - a.n);
    const steps = Math.max(1, Math.ceil(length / spacingM));
    for (let step = 0; step < steps; step += 1) {
      const fraction = step / steps;
      output.push({ e: a.e + (b.e - a.e) * fraction, n: a.n + (b.n - a.n) * fraction });
    }
  }
  const last = points[points.length - 1];
  if (last !== undefined) output.push({ ...last });
  return output;
}

/** Exercises real pit geometry; expected: pit gates fire, inPit is visited, lap is PIT_TRANSIT invalid. */
export function pitLaneTransitLap(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  const runtime = runtimeFor(profile);
  const pit = runtime.pitLane;
  if (pit === undefined)
    throw new RangeError('pitLaneTransitLap requires a profile with a pit lane');
  const total = polylineLength(runtime.centerline);
  const entryRaw = pit.entryGate.distanceM;
  const exitRaw = pit.exitGate.distanceM;
  const beforeEntry: LocalPoint[] = [];
  const beforeEntryStartRaw = runtime.startFinishGate.distanceM - 20;
  // The start/finish gate's raw distance is NOT always near 0 -- it depends on
  // where the closed centerline happens to be parameterized from (TMR's S/F
  // sits at raw~0; MotorPark's sits at raw~totalLengthM, i.e. right at the
  // seam). Unwrap the entry gate forward from the lap-start reference so a
  // late-in-lap S/F (entry raw BEHIND the start reference) still produces the
  // intended "drive from S/F to pit entry" stretch instead of an empty loop.
  const unwrappedEntryRaw = entryRaw >= beforeEntryStartRaw ? entryRaw : entryRaw + total;
  for (let raw = beforeEntryStartRaw; raw < unwrappedEntryRaw; raw += 30) {
    const projected = projectOntoPolyline(
      sampleLocalAtRaw(runtime, raw),
      runtime.centerline,
      runtime.cumulativeDistancesM,
      true,
    );
    beforeEntry.push(projected.point);
  }
  const afterExit: LocalPoint[] = [];
  const unwrappedExit = exitRaw <= entryRaw ? exitRaw + total : exitRaw;
  let finishRaw = runtime.startFinishGate.distanceM + total + 20;
  while (finishRaw <= unwrappedExit) finishRaw += total;
  for (let raw = unwrappedExit; raw <= finishRaw; raw += 30)
    afterExit.push(sampleLocalAtRaw(runtime, raw));
  afterExit.push(sampleLocalAtRaw(runtime, finishRaw));
  const route = interpolateRoute([...beforeEntry, ...pit.polyline, ...afterExit], 30);
  const samples = route.map((point, index) => {
    const geo = runtime.projection.toLatLon(point);
    return { tMono: index * 750, ...geo, accuracyM: 3, speedMps: 40, source: 'replay' as const };
  });
  return relabel(
    samples,
    'pitLaneTransitLap',
    seed,
    'Pit entry and exit are detected and the lap is PIT_TRANSIT invalid.',
  );
}

function sampleLocalAtRaw(
  runtime: ReturnType<typeof runtimeFor>,
  rawDistanceM: number,
): LocalPoint {
  const total = polylineLength(runtime.centerline);
  const normalized = ((rawDistanceM % total) + total) % total;
  const index = runtime.cumulativeDistancesM.findIndex((distance) => distance > normalized);
  const segmentIndex = index <= 0 ? runtime.centerline.length - 1 : index - 1;
  const a = runtime.centerline[segmentIndex];
  const b = runtime.centerline[(segmentIndex + 1) % runtime.centerline.length];
  if (a === undefined || b === undefined) throw new RangeError('centerline is sparse');
  const start = runtime.cumulativeDistancesM[segmentIndex] ?? 0;
  const length = Math.hypot(b.e - a.e, b.n - a.n);
  const fraction = Math.max(0, Math.min(1, (normalized - start) / length));
  return { e: a.e + (b.e - a.e) * fraction, n: a.n + (b.n - a.n) * fraction };
}

/** Exercises zero-motion line contact; expected: 60 s stationary creates no duplicate S/F crossings. */
export function stoppedOnLineSession(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  const samples = driveLap(profile, { seed, lapCount: 2, noiseSigmaM: 0 });
  const insertion = samples.findIndex((sample) => sample.tMono > 1_000);
  const before = insertion > 0 ? samples.slice(0, insertion) : [];
  const after = insertion > 0 ? samples.slice(insertion) : samples;
  const baseTime = before[before.length - 1]?.tMono ?? 0;
  const stationary = Array.from({ length: 61 }, (_, index) => ({
    ...sampleAtLapDistance(profile, 0, baseTime + index * 1_000, { speedMps: 0, accuracyM: 2 }),
  }));
  const shift = stationary[stationary.length - 1]?.tMono ?? baseTime;
  const resumed = after.map((sample, index) => ({ ...sample, tMono: shift + (index + 1) * 1_000 }));
  return relabel(
    [...before, ...stationary, ...resumed],
    'stoppedOnLineSession',
    seed,
    'Stationary samples on the gate do not create duplicate crossings.',
  );
}

/** Exercises pause state propagation; expected: only lap 1 gets PAUSE_GAP and lap 2 stays valid. */
export function pauseResumeSession(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  const samples = driveLap(profile, { seed, lapCount: 2 });
  const split = Math.floor(samples.length / 4);
  const before = samples.slice(0, split);
  const heldPosition = before[before.length - 1];
  if (heldPosition === undefined) throw new RangeError('pause fixture requires telemetry');
  const heldSample: LocationSample = {
    ...heldPosition,
    tMono: heldPosition.tMono + 45_000,
    speedMps: 0,
  };
  const resumed = samples
    .slice(split)
    .map((sample) => ({ ...sample, tMono: sample.tMono + 45_000 }));
  return relabel(
    [...before, heldSample, ...resumed],
    'pauseResumeSession',
    seed,
    'A 45 s position hold invalidates only the paused lap with PAUSE_GAP.',
  );
}

/** Exercises timestamp validation; expected: swapped non-increasing timestamps are rejected and replay continues. */
export function outOfOrderTimestampsLap(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  const samples = driveLap(profile, { seed });
  const index = Math.floor(samples.length / 2);
  const first = samples[index];
  const second = samples[index + 1];
  if (first !== undefined && second !== undefined) {
    samples[index] = { ...first, tMono: second.tMono };
    samples[index + 1] = { ...second, tMono: first.tMono };
  }
  return relabel(
    samples,
    'outOfOrderTimestampsLap',
    seed,
    'Non-increasing samples are rejected and later samples continue through the pipeline.',
  );
}

/** Exercises accuracy grading; expected: 30-60 m fixes are unreliable or invalid, never silently good. */
export function lowQualitySamplesLap(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  return relabel(
    driveLap(profile, { seed, accuracyM: (index) => 30 + (index % 31) }),
    'lowQualitySamplesLap',
    seed,
    'Accuracy from 30-60 m is surfaced as unreliable or invalid quality.',
  );
}

/** Exercises progress zero unwrapping; expected: first S/F crossing occurs within seconds and timing stays monotone. */
export function wraparoundSession(
  profile: CircuitProfile,
  options?: ScenarioFixtureOptions | number,
): TelemetryFixture {
  const seed = seedOf(options);
  return relabel(
    driveLap(profile, { seed, startDistanceM: -50, endPaddingM: 20 }),
    'wraparoundSession',
    seed,
    'The early interpolated S/F crossing opens a lap and unwrapped progress crosses zero monotonically.',
  );
}
