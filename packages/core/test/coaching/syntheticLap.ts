import type { CoachingChannelId, CornerLapSample } from '../../src/coaching';
import type { Corner } from '../../src/contracts';

/**
 * Analytic synthetic lap used by the corner-metrics tests. NOT a vitest file
 * (no `.test.ts` suffix, so vitest's `test/**\/*.test.ts` include skips it) --
 * it is a fixture builder whose answers are known in closed form:
 *
 *   d < 360 m        a = 0            (flat out at 40 m/s)
 *   360 <= d < 400   a = -0.8 m/s^2   (coast: -0.082 g -- above the lift
 *                                      threshold, below the brake threshold)
 *   400 <= d < 600   a = -3.0 m/s^2   (real braking: -0.306 g)
 *   600 <= d < 660   a = 0            (minimum speed held through the apex)
 *   660 <= d < 760   a = +2.0 m/s^2   (power down out of the corner)
 *
 * With the corner's entry at 620 m the expected metrics are therefore
 * `liftPointM ~ 260` (620 - 360), `brakeStartM ~ 220` (620 - 400) and
 * `peakDecelG ~ 3 / 9.80665 = 0.306`, independent of which channel the
 * module derives them from.
 */
export const SYNTHETIC_TOTAL_LENGTH_M = 1_000;
export const SYNTHETIC_LIFT_DISTANCE_M = 360;
export const SYNTHETIC_BRAKE_DISTANCE_M = 400;
export const SYNTHETIC_PEAK_DECEL_G = 3 / 9.80665;
export const SYNTHETIC_CORNER_RADIUS_M = 100;

export const SYNTHETIC_CORNER: Corner = Object.freeze({
  id: 1,
  entryDistanceM: 620,
  apexDistanceM: 650,
  exitDistanceM: 680,
  lengthM: 60,
  minRadiusM: SYNTHETIC_CORNER_RADIUS_M,
  totalAngleDeg: 90,
  direction: 'left',
  severity: 3,
  advisorySpeedKph: 80,
  speedSource: 'model',
});

const GRAVITY_MPS2 = 9.80665;

export type SyntheticChannels =
  | 'none'
  | 'pedal'
  | 'throttlePlate'
  | 'imu'
  | 'all'
  | 'brake'
  | 'steering'
  | 'yaw'
  | 'tier2';

export interface SyntheticLapOptions {
  channels?: SyntheticChannels;
  sampleRateHz?: number;
  accuracyM?: number | ((index: number) => number);
  tStartMs?: number;
  /** Rotates every distance forward by this many metres (mod lap length) -- used to exercise wrap. */
  distanceOffsetM?: number;
  /** Overrides the per-sample heading (default: a uniform circle heading). */
  headingDeg?: (distanceM: number, index: number) => number;
  lateralM?: (distanceM: number, index: number) => number;
  speedScale?: number;
  /**
   * Shifts the whole longitudinal profile (lift, braking, power-down) forward
   * by this many metres, so several laps of the same corner differ in braking
   * point the way real laps do. Positive = braked later.
   */
  profileShiftM?: number;
  /** Replaces the analytic longitudinal profile (m/s^2 at a lap distance). */
  accelAt?: (distanceM: number) => number;
  /** Replaces the analytic accelerator-pedal profile (%, at a lap distance). */
  pedalAt?: (distanceM: number) => number;
  /** Drops `speedKph` from every sample (a GNSS fix with no Doppler speed). */
  withoutDopplerSpeed?: boolean;
  /**
   * Centreline heading at a lap distance, degrees. Emitted as
   * `centrelineHeadingDeg` so the yaw check has an implied-yaw reference.
   */
  centrelineHeadingDeg?: (distanceM: number) => number;
}

function defaultAccelAt(distanceM: number): number {
  if (distanceM < 360) return 0;
  if (distanceM < 400) return -0.8;
  if (distanceM < 600) return -3;
  if (distanceM < 660) return 0;
  if (distanceM < 760) return 2;
  return 0;
}

function defaultPedalAt(distanceM: number): number {
  if (distanceM < 360) return 90;
  if (distanceM < 660) return 0;
  return Math.min(90, (distanceM - 660) * 0.9);
}

/** Tier-2 brake channel: pressure only while the analytic profile really brakes. */
function brakeAt(distanceM: number): number {
  return distanceM >= 400 && distanceM < 600 ? 45 : 0;
}

/** Tier-2 steering angle: 0 -> 30 deg -> 0 across the corner (turn-in near 610 m). */
function steeringAt(distanceM: number): number {
  if (distanceM < 600 || distanceM > 700) return 0;
  return distanceM <= 650 ? (distanceM - 600) * 0.6 : (700 - distanceM) * 0.6;
}

/** Gyro yaw rate consistent with the steering profile, deg/s. */
function yawAt(distanceM: number): number {
  return steeringAt(distanceM) * 0.5;
}

export function syntheticLap(options: SyntheticLapOptions = {}): CornerLapSample[] {
  const sampleRateHz = options.sampleRateHz ?? 10;
  const dt = 1 / sampleRateHz;
  const speedScale = options.speedScale ?? 1;
  const offsetM = options.distanceOffsetM ?? 0;
  const samples: CornerLapSample[] = [];
  let distanceM = 0;
  let speedMps = 40 * speedScale;
  let tMs = options.tStartMs ?? 0;
  let index = 0;

  const shiftM = options.profileShiftM ?? 0;
  const accelAt = options.accelAt ?? defaultAccelAt;
  const pedalAt = options.pedalAt ?? defaultPedalAt;
  while (distanceM < SYNTHETIC_TOTAL_LENGTH_M) {
    const accel = accelAt(distanceM - shiftM) * speedScale;
    const inCorner = distanceM >= 620 && distanceM <= 680;
    const latG = inCorner ? (speedMps * speedMps) / SYNTHETIC_CORNER_RADIUS_M / GRAVITY_MPS2 : 0;
    const accuracyM =
      typeof options.accuracyM === 'function' ? options.accuracyM(index) : (options.accuracyM ?? 4);
    const reportedDistanceM = (distanceM + offsetM) % SYNTHETIC_TOTAL_LENGTH_M;
    const channels: Partial<Record<CoachingChannelId, number>> = {};
    const mode = options.channels ?? 'none';
    if (mode === 'pedal' || mode === 'all') channels.accelPedalPct = pedalAt(distanceM - shiftM);
    if (mode === 'throttlePlate') channels.throttlePct = Math.max(14, pedalAt(distanceM - shiftM));
    if (mode === 'imu' || mode === 'all' || mode === 'tier2') {
      channels.longG = accel / GRAVITY_MPS2;
      channels.latG = latG;
    }
    if (mode === 'brake' || mode === 'tier2') channels.brakePct = brakeAt(distanceM - shiftM);
    if (mode === 'steering' || mode === 'tier2') channels.steeringDeg = steeringAt(distanceM);
    if (mode === 'yaw') channels.yawRateDps = yawAt(distanceM);

    samples.push({
      tMonoMs: tMs,
      distanceM: reportedDistanceM,
      ...(options.withoutDopplerSpeed === true ? {} : { speedKph: speedMps * 3.6 }),
      accuracyM,
      lateralM: options.lateralM?.(reportedDistanceM, index) ?? 0,
      headingDeg:
        options.headingDeg?.(reportedDistanceM, index) ??
        ((reportedDistanceM / SYNTHETIC_TOTAL_LENGTH_M) * 360) % 360,
      ...(options.centrelineHeadingDeg === undefined
        ? {}
        : { centrelineHeadingDeg: options.centrelineHeadingDeg(reportedDistanceM) }),
      ...(Object.keys(channels).length > 0 ? { channels } : {}),
    });

    speedMps = Math.max(5, Math.min(40 * speedScale, speedMps + accel * dt));
    distanceM += speedMps * dt;
    tMs += dt * 1_000;
    index += 1;
  }
  return samples;
}
