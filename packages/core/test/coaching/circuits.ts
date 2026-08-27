import { readFileSync } from 'node:fs';

import { projectLapSamples, type CornerLapSample, type SessionLapInput } from '../../src/coaching';
import { analyzeCorners } from '../../src/corners';
import type { CircuitProfile, Corner } from '../../src/contracts';
import { driveLap } from '../../src/fixtures';
import { polylineLength } from '../../src/geometry';
import { loadProfileFromJson, type RuntimeProfile } from '../../src/profile';

/**
 * Shared rig for the BOTH-CIRCUITS coaching tests (ticket P5a): the real
 * catalog assets, the real `analyzeCorners` geometry, and a kinematically
 * plausible multi-lap drive built with the production `driveLap` fixture and
 * projected through the production `TrackMatcher`. No new fixture engine and no
 * hard-coded circuit id -- the same helper serves Transilvania Motor Ring
 * (field-validated) and MotorPark (OSM geometry, field-unvalidated).
 *
 * Not a vitest file (no `.test.ts` suffix), so the runner's `test/**\/*.test.ts`
 * include skips it.
 */

export interface TestCircuit {
  profile: CircuitProfile;
  runtime: RuntimeProfile;
  corners: Corner[];
  totalLengthM: number;
  /** False for geometry that has not been validated on track (MotorPark). */
  geometryValidated: boolean;
}

function load(asset: string, geometryValidated: boolean): TestCircuit {
  const json = readFileSync(new URL(`../../assets/circuits/${asset}`, import.meta.url), 'utf8');
  const loaded = loadProfileFromJson(json);
  if (!loaded.ok) throw new Error(`${asset}: ${loaded.errors.join(', ')}`);
  return {
    profile: loaded.profile,
    runtime: loaded.runtime,
    corners: analyzeCorners(loaded.runtime),
    totalLengthM: polylineLength(loaded.runtime.centerline),
    geometryValidated,
  };
}

export function transilvania(): TestCircuit {
  return load('transilvania-motor-ring.v2.json', true);
}

export function motorpark(): TestCircuit {
  return load('motorpark-romania.v1.json', false);
}

function modulo(value: number, modulus: number): number {
  const wrapped = value % modulus;
  return wrapped < 0 ? wrapped + modulus : wrapped;
}

export interface DriveSessionOptions {
  /** How many laps the session holds. */
  laps: number;
  /** Per-lap multiplier on every corner's target speed (index 0 = lap 1). */
  cornerSpeedScales?: readonly number[];
  /** Per-lap braking deceleration, m/s^2 (index 0 = lap 1). */
  brakeDecelMps2?: readonly number[];
  seed?: number;
  sampleRateHz?: number;
  /** Metres of the previous lap kept as the lead-in to corner 1. */
  leadInM?: number;
  /**
   * Which channel tiers the recorded session carries. `tier1` adds the
   * accelerator pedal, `tier2` adds brake pressure, steering angle and the IMU.
   * The values are derived from the SAME drive (speed derivative and centreline
   * curvature), so they are consistent with the GPS trace rather than invented
   * independently of it.
   */
  channels?: 'none' | 'tier1' | 'tier2';
}

const GRAVITY_MPS2 = 9.80665;

function headingDelta(from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta <= -180) delta += 360;
  return delta;
}

/**
 * Derives tier-1/tier-2 channel values from an already-projected drive: pedal
 * and brake from the longitudinal acceleration, steering and lateral G from the
 * centreline curvature the car is actually following.
 */
function enrichChannels(
  samples: readonly CornerLapSample[],
  tier: 'tier1' | 'tier2',
): CornerLapSample[] {
  return samples.map((sample, index) => {
    const next = samples[index + 1];
    const channels: Record<string, number> = { ...(sample.channels ?? {}) };
    const speedMps = (sample.speedKph ?? 0) / 3.6;
    let accelMps2 = 0;
    let yawDps = 0;
    if (next !== undefined) {
      const dtSeconds = (next.tMonoMs - sample.tMonoMs) / 1_000;
      if (dtSeconds > 0) {
        accelMps2 = ((next.speedKph ?? 0) - (sample.speedKph ?? 0)) / 3.6 / dtSeconds;
      }
    }
    // A catalog centreline turns in discrete vertex steps; a real gyro and a
    // real steering wheel do not. Take the yaw rate over a few samples so the
    // derived channels look like a driver, not like a polyline.
    const before = samples[Math.max(0, index - 2)];
    const after = samples[Math.min(samples.length - 1, index + 2)];
    if (
      before !== undefined &&
      after !== undefined &&
      before !== after &&
      before.centrelineHeadingDeg !== undefined &&
      after.centrelineHeadingDeg !== undefined
    ) {
      const spanSeconds = (after.tMonoMs - before.tMonoMs) / 1_000;
      if (spanSeconds > 0) {
        yawDps = headingDelta(before.centrelineHeadingDeg, after.centrelineHeadingDeg) / spanSeconds;
      }
    }
    channels.accelPedalPct = accelMps2 > 0.1 ? Math.min(100, 30 + accelMps2 * 25) : 0;
    if (tier === 'tier2') {
      channels.brakePct = accelMps2 < -0.5 ? Math.min(100, -accelMps2 * 20) : 0;
      // A steering angle proportional to the path curvature the car follows.
      channels.steeringDeg = speedMps > 1 ? (yawDps / speedMps) * 60 : 0;
      channels.longG = accelMps2 / GRAVITY_MPS2;
      channels.latG = (((yawDps * Math.PI) / 180) * speedMps) / GRAVITY_MPS2;
      channels.yawRateDps = yawDps;
    }
    return { ...sample, channels };
  });
}

/**
 * Builds a deterministic session on a real circuit: a continuous multi-lap
 * drive whose speed profile brakes for every catalog corner and accelerates out
 * of it, sliced into laps that each carry a lead-in from the previous lap (so
 * the approach to a corner near the start/finish line is real data, not a hole).
 */
export function driveCircuitSession(
  circuit: TestCircuit,
  options: DriveSessionOptions,
): SessionLapInput[] {
  const laps = options.laps;
  if (!Number.isInteger(laps) || laps < 1) throw new RangeError('laps must be a positive integer');
  // The approach window is derived from each corner's speed drop and can reach
  // back several hundred metres, so the lead-in has to be at least that long.
  const leadInM = options.leadInM ?? 460;
  const totalLengthM = circuit.totalLengthM;
  const vMax = 55;
  const accelMps2 = 3;

  const scales = options.cornerSpeedScales ?? [1];
  const decelerations = options.brakeDecelMps2 ?? [4];
  const speedAt = (distanceM: number, lapIndex: number): number => {
    const scale = scales[lapIndex % scales.length] ?? 1;
    const brakeMps2 = decelerations[lapIndex % decelerations.length] ?? 4;
    const here = modulo(distanceM, totalLengthM);
    let speed = vMax;
    for (const corner of circuit.corners) {
      const target = Math.min(
        vMax,
        Math.max(11, (corner.advisorySpeedKph / 3.6) * scale),
      );
      const toEntry = modulo(corner.entryDistanceM - here, totalLengthM);
      const fromExit = modulo(here - corner.exitDistanceM, totalLengthM);
      const inCorner =
        modulo(here - corner.entryDistanceM, totalLengthM) <=
        modulo(corner.exitDistanceM - corner.entryDistanceM, totalLengthM);
      if (inCorner) speed = Math.min(speed, target);
      speed = Math.min(speed, Math.sqrt(target * target + 2 * brakeMps2 * toEntry));
      speed = Math.min(speed, Math.sqrt(target * target + 2 * accelMps2 * fromExit));
    }
    return Math.max(10, Math.min(vMax, speed));
  };

  // One extra lap up front so lap 1 also has a real lead-in.
  const raw = driveLap(circuit.profile, {
    seed: options.seed ?? 5_001,
    sampleRateHz: options.sampleRateHz ?? 10,
    noiseSigmaM: 1.2,
    startDistanceM: 0,
    endPaddingM: 0,
    lapCount: laps + 1,
    speedMps: (context) => speedAt(context.distanceM, Math.max(0, context.lapIndex - 1)),
  });

  const tier = options.channels ?? 'none';
  const projectedRaw = projectLapSamples(circuit.runtime, raw).samples;
  const projected = tier === 'none' ? projectedRaw : enrichChannels(projectedRaw, tier);
  // Unwrap so laps can be sliced by absolute progress.
  const unwrapped: { sample: CornerLapSample; du: number }[] = [];
  let turns = 0;
  let previous: number | null = null;
  for (const sample of projected) {
    if (previous !== null && sample.distanceM < previous - totalLengthM / 2) turns += 1;
    previous = sample.distanceM;
    unwrapped.push({ sample, du: sample.distanceM + turns * totalLengthM });
  }

  const inputs: SessionLapInput[] = [];
  for (let lap = 1; lap <= laps; lap += 1) {
    const startM = lap * totalLengthM;
    const endM = (lap + 1) * totalLengthM;
    const window = unwrapped.filter((entry) => entry.du >= startM - leadInM && entry.du <= endM);
    const timed = window.filter((entry) => entry.du >= startM);
    const firstTimed = timed[0];
    const lastTimed = timed[timed.length - 1];
    if (firstTimed === undefined || lastTimed === undefined) continue;
    inputs.push({
      lap: {
        lapNumber: lap,
        durationMs: lastTimed.sample.tMonoMs - firstTimed.sample.tMonoMs,
        valid: true,
        invalidReasons: [],
        quality: 'good',
      },
      samples: window.map((entry) => entry.sample),
    });
  }
  return inputs;
}
