import type { TelemetryChannelId } from '../telemetry/contracts';

/**
 * Channels the deterministic analysis engine can consume.
 *
 * `TelemetryChannelId` covers everything the OBD/IMU pipeline records today.
 * `steeringDeg` and `yawRateDps` are the tier-2 / gyro channels
 * `docs/architecture/analysis-engine.md` §1 names but that no shipped provider
 * emits yet (steering angle has no standard mode-01 PID -- it arrives per
 * vehicle profile via a discovered DID). They are declared here so every
 * estimator can be written against the final matrix; when a provider starts
 * emitting them they move into `TelemetryChannelId` and this alias collapses
 * to it. Nothing in coaching ever fabricates a channel value.
 *
 * Ticket P4l-FIX1 F1/F4 (binding): `brakePct` -- and the new `brakeSwitch` --
 * made exactly that move. Both are `TelemetryChannelId` members now (the ENET
 * provider emits them from a Signal-Finder-confirmed binding), so they are no
 * longer listed here; `brakePct` is kept in the union only so the alias stays
 * explicit about what it adds, and TypeScript collapses the duplicate.
 */
export type CoachingChannelId = TelemetryChannelId | 'brakePct' | 'steeringDeg' | 'yawRateDps';

/**
 * The channels this engine actually reads, in a fixed order. Every list the
 * engine reports (`available` / `unsupported` / `missing`) is emitted in this
 * order so results are byte-stable across runs.
 */
export const ANALYSIS_CHANNELS: readonly CoachingChannelId[] = Object.freeze([
  'speedKph',
  'accelPedalPct',
  'throttlePct',
  'brakePct',
  // Ticket P4l-FIX1 F4 (binding): the brake SWITCH, ranked directly after the
  // brake pressure it stands in for -- a pressure channel is strictly more
  // informative, so when a car provides both, `detectBrake` prefers it.
  'brakeSwitch',
  'longG',
  'latG',
  'yawRateDps',
  'steeringDeg',
  'rpm',
] as const);

/** Standard gravity (m/s^2) -- the single conversion constant for g <-> m/s^2. */
export const GRAVITY_MPS2 = 9.80665;

/**
 * One time-ordered sample of a lap, already projected onto the circuit
 * centreline (see `distanceDomain.projectLapSamples`). Pure data: no class, no
 * I/O, JSON-serialisable.
 */
export interface CornerLapSample {
  /** Monotonic milliseconds -- the SAME clock the telemetry samples use. */
  readonly tMonoMs: number;
  /** Lap distance from start/finish, metres, in `[0, totalLengthM)`. */
  readonly distanceM: number;
  /** GNSS (or ECU) speed in km/h. Absent -> derived from d(distance)/dt. */
  readonly speedKph?: number;
  /** Horizontal accuracy (1 sigma, metres) when the fix reported one. */
  readonly accuracyM?: number;
  /** Signed lateral offset from the centreline, metres. */
  readonly lateralM?: number;
  /** Course over ground, degrees, 0 = north. */
  readonly headingDeg?: number;
  /**
   * Direction of the CENTRELINE at this sample's projected distance, degrees,
   * 0 = north. `projectLapSamples` fills it from the catalog geometry; the yaw
   * check turns its rate of change into the yaw rate the track itself implies
   * (curvature x speed) so a measured yaw rate can be compared against it.
   */
  readonly centrelineHeadingDeg?: number;
  /** Decoded channel values at this sample's time, by channel id. */
  readonly channels?: Readonly<Partial<Record<CoachingChannelId, number>>>;
}

/** Which estimator produced the lift point (never fabricated). */
export type LiftSource = 'accelPedalPct' | 'throttlePct' | 'decelOnset';
/** Which estimator produced the braking start. */
export type BrakeSource = 'brakePct' | 'brakeSwitch' | 'longG' | 'gpsSpeed';
/** Which estimator produced the throttle-on point. */
export type ThrottleOnSource = 'accelPedalPct' | 'throttlePct' | 'accelOnset';
/** Which estimator produced the turn-in point. */
export type TurnInSource = 'steeringDeg' | 'yawRateDps';

/** Machine-readable quality flags for one corner's analysis window. */
export type CornerQualityFlag =
  | 'GNSS_ACCURACY_POOR'
  | 'SAMPLE_GAP'
  | 'APPROACH_TRUNCATED'
  | 'CORNER_TRUNCATED'
  | 'NO_APPROACH_COVERAGE'
  | 'NO_CORNER_COVERAGE';

export interface CornerQuality {
  /** True only when `flags` is empty. */
  ok: boolean;
  flags: CornerQualityFlag[];
  /** Worst (largest) reported accuracy inside the analysis window, metres. */
  worstAccuracyM: number | null;
  /** Largest gap between consecutive in-window samples, milliseconds. */
  maxSampleGapMs: number | null;
}

/**
 * Per (lap, corner) deterministic metrics. Every field is either a real
 * measurement or `null` -- there is no "0 means missing" in this record, and
 * nothing here is rounded (rounding is a presentation concern, see
 * `reportText.ts`).
 */
export interface CornerMetrics {
  cornerId: number;
  /** `CORNER_ANALYSIS_VERSION` the corner geometry came from. */
  analysisVersion: number;
  /** Metres BEFORE the corner entry where the driver lifted. */
  liftPointM: number | null;
  liftSource: LiftSource | null;
  /** Metres BEFORE the corner entry where sustained braking started. */
  brakeStartM: number | null;
  brakeSource: BrakeSource | null;
  /**
   * Ticket P4l-FIX4 N3 (binding, Codex P4l-REV2b finding 7): how wide the
   * "when" of `brakeStartM` really is, in metres -- the distance covered over
   * one sampling interval of the channel the onset came from. Non-null only
   * for a HELD (state) channel such as `brakeSwitch`, which can place the
   * onset no more precisely than "at one of its own samples"; a continuously
   * sampled pressure channel is already at the grid's resolution and reports
   * `null`. The true brake point is never LATER than `brakeStartM` says, so
   * the demonstrated latest-brake safety bound uses `brakeStartM + this`.
   */
  brakeOnsetUncertaintyM: number | null;
  /** Peak deceleration in the braking zone, positive magnitude, g. */
  peakDecelG: number | null;
  minSpeedKph: number | null;
  /** Absolute lap distance (metres from S/F) of the minimum speed. */
  minSpeedPositionM: number | null;
  /** Signed metres from the apex to the minimum speed (+ = after the apex). */
  minSpeedVsApexM: number | null;
  entrySpeedKph: number | null;
  exitSpeedKph: number | null;
  maxLatG: number | null;
  maxLatGSource: 'imu' | null;
  /** Time from corner entry to corner exit, milliseconds. */
  sectorMs: number | null;
  /** Samples used for the in-corner metrics. */
  sampleCount: number;
  quality: CornerQuality;
  /** Signed metres from the apex to the throttle-on point (+ = after apex). */
  throttleOnM: number | null;
  throttleOnSource: ThrottleOnSource | null;
  /** Fraction (0..1) of the exit zone spent at full throttle; pedal channel only. */
  fullThrottleFraction: number | null;
  /** max sqrt(latG^2 + longG^2) in the corner -- friction-circle utilisation, g. */
  frictionCircleMaxG: number | null;
  /** Metres BEFORE the corner entry where the car turned in. */
  turnInM: number | null;
  turnInSource: TurnInSource | null;
  /** RMS of d(steering)/ds over the corner, deg/m; steering channel only. */
  steeringSmoothness: number | null;
  /** Steering-correction count (sign changes above a dead-band); steering channel only. */
  steeringCorrections: number | null;
}

/** What `channelAvailability` reports for a session or lap. */
export interface ChannelAvailability {
  /** Analysis channels observed in the samples and not declared unsupported. */
  available: CoachingChannelId[];
  /** Analysis channels the caller declared unsupported for this vehicle. */
  unsupported: CoachingChannelId[];
  /** Analysis channels neither observed nor declared unsupported. */
  missing: CoachingChannelId[];
}

/** The subset of `LapRecord` lap classification needs (a `LapRecord` satisfies it). */
export interface ClassifiableLap {
  lapNumber: number;
  durationMs: number;
  valid: boolean;
  invalidReasons: readonly string[];
  quality: string;
}

/** Why a lap is not clean. */
export type LapAnomalyReason = 'incomplete' | 'offTrack' | 'yawSpike' | 'decelSpike' | 'gnssPoor';

/** Checks that could not run because the samples lack the required field. */
export type LapCheckId = 'offTrack' | 'yawSpike' | 'decelSpike' | 'gnssPoor' | 'coverage';

/**
 * Three-valued lap status. `unverified` is the honest middle: no anomaly was
 * found, but at least one of the checks the safety contract requires
 * ("on-track, no yaw/decel anomaly, valid GNSS quality") could not run, so the
 * lap is NOT established as clean and never feeds the reference or the
 * demonstrated envelope.
 */
export type LapStatus = 'clean' | 'unverified' | 'anomalous';

export interface LapClassification {
  lapNumber: number;
  status: LapStatus;
  /** True only for `status === 'clean'`. */
  clean: boolean;
  /** Highest-priority reason, or `null` when the lap is clean. */
  reason: LapAnomalyReason | null;
  /** Every reason found, in the fixed priority order. */
  reasons: LapAnomalyReason[];
  /** Human-readable, deterministic evidence string (never empty, never "NaN"). */
  detail: string;
  /** Checks skipped because their evidence did not span the lap. */
  unavailableChecks: LapCheckId[];
  /**
   * Fraction of the LAP DISTANCE each required check had continuous evidence
   * over, 0..1. A check below `minCheckCoverageFraction` is unavailable, and the
   * number is what the report quotes instead of a bare "no data".
   */
  checkCoverage: Record<LapCheckId, number>;
  /** Fraction of the lap distance covered by samples, 0..1. */
  coverageFraction: number;
  /** Worst reported accuracy over the lap, metres. */
  worstAccuracyM: number | null;
  /** Largest gap between consecutive samples, milliseconds. */
  maxSampleGapMs: number | null;
}

/** One clean lap's corner metrics, the input to the demonstrated envelope. */
export interface CleanLapMetrics {
  lapNumber: number;
  corners: CornerMetrics[];
}
