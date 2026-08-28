import type { LocationSample } from '../contracts';
import { polylineLength } from '../geometry';
import { TrackMatcher, type TrackMatcherConfig } from '../matching';
import type { RuntimeProfile } from '../profile';
import type { TelemetrySample } from '../telemetry/contracts';

import { ANALYSIS_CHANNELS, type CoachingChannelId, type CornerLapSample } from './types';

/**
 * Distance-domain alignment -- the backbone of the analysis engine
 * (`docs/architecture/analysis-engine.md` §2).
 *
 *   1. project every sample onto the catalog centreline -> `s` metres from S/F,
 *      monotone within a lap (back-steps rejected by a small hysteresis);
 *   2. resample every channel onto a fixed `dS` grid so two laps are
 *      comparable point-by-point;
 *   3. `t(s)` per lap and `dt(s) = t_lap(s) - t_ref(s)` versus the driver's best
 *      CLEAN lap -- the slope of `dt` inside a corner is WHERE time is lost.
 *
 * Projection is NOT reimplemented here: `projectLapSamples` drives the
 * production `TrackMatcher` (same corridor, quality and hysteresis rules the
 * live pipeline uses), so an offline analysis can never disagree with the
 * distances the app showed while driving.
 *
 * Everything in this file is pure and deterministic: no clock, no I/O, no
 * randomness, and no value is ever invented for a channel that was not
 * recorded.
 */

/** Default resampling step (metres) -- 1 m, per the binding design. */
export const DEFAULT_GRID_STEP_M = 1;
/**
 * Default largest distance between two real samples that may still be bridged
 * by linear interpolation. 60 m ~ 1.5 s at 150 km/h and 2 GNSS samples at 1 Hz
 * on a fast straight; beyond that the grid reports "not covered" rather than
 * inventing a value.
 */
export const DEFAULT_MAX_BRIDGE_M = 60;

export function assertPositiveLength(totalLengthM: number, label = 'totalLengthM'): void {
  if (!Number.isFinite(totalLengthM) || totalLengthM <= 0) {
    throw new RangeError(`${label} must be a positive, finite number of metres`);
  }
}

/** Wraps a lap distance into `[0, totalLengthM)`. */
export function normalizeDistance(distanceM: number, totalLengthM: number): number {
  const wrapped = distanceM % totalLengthM;
  return wrapped < 0 ? wrapped + totalLengthM : wrapped;
}

/** Forward (travel-direction) distance from `fromM` to `toM`, always in `[0, totalLengthM)`. */
export function forwardDistance(fromM: number, toM: number, totalLengthM: number): number {
  return normalizeDistance(toM - fromM, totalLengthM);
}

/**
 * Wrap-aware window membership: true when `distanceM` lies on the arc that runs
 * forward from `startM` to `endM` (inclusive at both ends).
 */
export function inDistanceWindow(
  distanceM: number,
  startM: number,
  endM: number,
  totalLengthM: number,
): boolean {
  const span = forwardDistance(startM, endM, totalLengthM);
  const offset = forwardDistance(startM, distanceM, totalLengthM);
  return offset <= span;
}

/** True when the arc from `startM` forward to `endM` crosses the start/finish line. */
export function windowWraps(startM: number, endM: number, totalLengthM: number): boolean {
  return normalizeDistance(startM, totalLengthM) > normalizeDistance(endM, totalLengthM);
}

// ---------------------------------------------------------------------------
// 1. Projection
// ---------------------------------------------------------------------------

export interface ProjectLapOptions {
  /** Passed straight to the production `TrackMatcher`. */
  matcher?: Partial<TrackMatcherConfig>;
  /**
   * Largest backwards jump (metres of unwrapped progress) tolerated before a
   * sample is rejected as a projection back-step. Default 5 m.
   */
  hysteresisM?: number;
}

export interface ProjectedLap {
  samples: CornerLapSample[];
  /** Samples the matcher refused (off corridor, unusable quality, ...). */
  rejected: number;
  /** Samples dropped because they moved backwards beyond the hysteresis. */
  backSteps: number;
  /**
   * Samples kept but whose distance was CLAMPED to the furthest progress seen
   * so far (a back-step inside the hysteresis). The sample's channels and time
   * are real; only its distance is held, so the emitted series is monotone.
   */
  clamped: number;
}

/**
 * Direction of the centreline at a lap distance (metres from start/finish),
 * degrees, 0 = north -- the same convention as `LocationSample.headingDeg`.
 * The rate of change of this heading along the driven path IS the yaw rate the
 * track geometry implies (curvature x speed).
 */
function centrelineHeadingAt(
  runtime: RuntimeProfile,
  lapDistanceM: number,
  totalLengthM: number,
): number | undefined {
  const centreline = runtime.centerline;
  const cumulative = runtime.cumulativeDistancesM;
  if (centreline.length < 2 || cumulative.length < 2) return undefined;
  const raw = normalizeDistance(lapDistanceM + runtime.startFinishGate.distanceM, totalLengthM);
  let low = 0;
  let high = cumulative.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if ((cumulative[mid] ?? 0) <= raw) low = mid;
    else high = mid;
  }
  const a = centreline[low];
  const b = centreline[(low + 1) % centreline.length];
  if (a === undefined || b === undefined) return undefined;
  const de = b.e - a.e;
  const dn = b.n - a.n;
  if (de === 0 && dn === 0) return undefined;
  return normalizeDistance((Math.atan2(de, dn) * 180) / Math.PI, 360);
}

/**
 * Projects raw GNSS samples of ONE lap onto the circuit centreline through the
 * production matcher and returns analysis-ready, monotone samples.
 *
 * Monotone is a guarantee, not a hope: a projection that steps backwards by
 * more than `hysteresisM` is dropped, and one that steps backwards by less is
 * kept with its distance CLAMPED to the furthest progress already reached. No
 * consecutive pair of emitted samples ever moves backwards (the single
 * start/finish wrap aside), so downstream unwrapping cannot reorder events.
 */
export function projectLapSamples(
  runtime: RuntimeProfile,
  locationSamples: readonly LocationSample[],
  options: ProjectLapOptions = {},
): ProjectedLap {
  const hysteresisM = options.hysteresisM ?? 5;
  if (!Number.isFinite(hysteresisM) || hysteresisM < 0) {
    throw new RangeError('hysteresisM must be a non-negative, finite number of metres');
  }
  const totalLengthM = polylineLength(runtime.centerline);
  assertPositiveLength(totalLengthM, 'centreline length');
  const matcher = new TrackMatcher(runtime, options.matcher ?? {});
  const samples: CornerLapSample[] = [];
  let rejected = 0;
  let backSteps = 0;
  let clamped = 0;
  let previousProgressM: number | undefined;

  for (const sample of locationSamples) {
    const match = matcher.match(sample);
    if (match === null) {
      rejected += 1;
      continue;
    }
    if (previousProgressM !== undefined && match.unwrappedProgressM < previousProgressM - hysteresisM) {
      backSteps += 1;
      continue;
    }
    const heldBack = previousProgressM !== undefined && match.unwrappedProgressM < previousProgressM;
    if (heldBack) clamped += 1;
    const progressM = heldBack
      ? (previousProgressM as number)
      : match.unwrappedProgressM;
    const distanceM = heldBack
      ? normalizeDistance(progressM, totalLengthM)
      : match.distanceM;
    previousProgressM = progressM;
    const centrelineHeadingDeg = centrelineHeadingAt(runtime, distanceM, totalLengthM);
    samples.push({
      tMonoMs: match.tMono,
      distanceM,
      ...(sample.speedMps === undefined ? {} : { speedKph: sample.speedMps * 3.6 }),
      ...(sample.accuracyM === undefined ? {} : { accuracyM: sample.accuracyM }),
      lateralM: match.lateralM,
      ...(sample.headingDeg === undefined ? {} : { headingDeg: sample.headingDeg }),
      ...(centrelineHeadingDeg === undefined ? {} : { centrelineHeadingDeg }),
    });
  }

  return { samples, rejected, backSteps, clamped };
}

// ---------------------------------------------------------------------------
// 2. Channel join (telemetry stream -> per-sample channel values)
// ---------------------------------------------------------------------------

export interface JoinChannelsOptions {
  /**
   * How old a channel value may be and still be attached to a location sample.
   * Default 1000 ms (a 1 Hz channel is still usable; a stale one is dropped
   * rather than carried forward forever).
   */
  maxStalenessMs?: number;
}

/**
 * Attaches decoded telemetry channel values to already-projected samples by
 * monotonic time: each sample gets the most recent value of every channel at or
 * before its own timestamp, provided that value is not older than
 * `maxStalenessMs`. Nothing is interpolated forwards in time and nothing is
 * invented -- a channel with no fresh value is simply absent from the sample.
 */
export function joinTelemetryChannels(
  samples: readonly CornerLapSample[],
  telemetry: readonly TelemetrySample[],
  options: JoinChannelsOptions = {},
): CornerLapSample[] {
  const maxStalenessMs = options.maxStalenessMs ?? 1_000;
  if (!Number.isFinite(maxStalenessMs) || maxStalenessMs < 0) {
    throw new RangeError('maxStalenessMs must be a non-negative, finite number of milliseconds');
  }
  const ordered = [...telemetry]
    .filter((entry) => Number.isFinite(entry.tMonoMs) && Number.isFinite(entry.value))
    .sort((a, b) => a.tMonoMs - b.tMonoMs || a.channel.localeCompare(b.channel));

  const latest = new Map<CoachingChannelId, { value: number; tMonoMs: number }>();
  let cursor = 0;
  return samples.map((sample) => {
    while (cursor < ordered.length) {
      const entry = ordered[cursor];
      if (entry === undefined || entry.tMonoMs > sample.tMonoMs) break;
      latest.set(entry.channel, { value: entry.value, tMonoMs: entry.tMonoMs });
      cursor += 1;
    }
    const channels: Partial<Record<CoachingChannelId, number>> = { ...(sample.channels ?? {}) };
    for (const channel of ANALYSIS_CHANNELS) {
      const entry = latest.get(channel);
      if (entry !== undefined && sample.tMonoMs - entry.tMonoMs <= maxStalenessMs) {
        channels[channel] = entry.value;
      }
    }
    return Object.keys(channels).length === 0 ? { ...sample } : { ...sample, channels };
  });
}

// ---------------------------------------------------------------------------
// 3. Resampling onto the distance grid
// ---------------------------------------------------------------------------

export interface DistanceGridOptions {
  totalLengthM: number;
  /** Grid spacing, metres. Default `DEFAULT_GRID_STEP_M` (1 m). */
  stepM?: number;
  /** Largest sample-to-sample distance still bridged by interpolation. */
  maxBridgeM?: number;
  /** Channels to resample. Default: every analysis channel present in the samples. */
  channels?: readonly CoachingChannelId[];
}

export interface DistanceGrid {
  stepM: number;
  totalLengthM: number;
  /** Grid distances from S/F, metres: `[0, stepM, 2*stepM, ...]`. */
  distanceM: number[];
  /**
   * `t(s)`: milliseconds since THIS LAP's start/finish crossing, per grid point.
   * The origin is the line, never the first recorded fix, so two laps sliced at
   * different points are still directly comparable.
   */
  elapsedMs: (number | null)[];
  speedKph: (number | null)[];
  /** Resampled channel values, keyed by channel id; every array is grid-length. */
  channels: Partial<Record<CoachingChannelId, (number | null)[]>>;
  /** True where `elapsedMs` came from real samples close enough to interpolate. */
  covered: boolean[];
  /** Lap distance the clock is anchored at: the start/finish line, 0 m. */
  originDistanceM: number;
  /** Monotonic timestamp of that crossing (interpolated between the two fixes around it). */
  originTMonoMs: number;
  /** Fraction of grid points covered, 0..1. */
  coverageFraction: number;
  /**
   * `∫ds/v(s)` over the covered lap MINUS the measured span between the same two
   * points, milliseconds. Positive = the integral is slower than the clock.
   * `null` when the profile could not be integrated (no speed somewhere).
   */
  timeIntegrationDriftMs: number | null;
  /**
   * True when `|timeIntegrationDriftMs|` is more than
   * `TIME_INTEGRATION_DRIFT_TOLERANCE` of the measured span: the speed profile
   * and the timestamps disagree, and `t(s)` is only as good as the speeds.
   */
  timeIntegrationDriftExceeded: boolean;
}

interface UnwrappedSample {
  du: number;
  tMonoMs: number;
  speedKph: number | null;
  channels: Readonly<Partial<Record<CoachingChannelId, number>>>;
}

function unwrapSamples(
  samples: readonly CornerLapSample[],
  totalLengthM: number,
): UnwrappedSample[] {
  const out: UnwrappedSample[] = [];
  let previous: CornerLapSample | undefined;
  let du = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.distanceM) || !Number.isFinite(sample.tMonoMs)) {
      throw new RangeError('every sample needs a finite tMonoMs and distanceM');
    }
    if (previous === undefined) {
      du = normalizeDistance(sample.distanceM, totalLengthM);
    } else {
      const forward = forwardDistance(previous.distanceM, sample.distanceM, totalLengthM);
      const step = forward > totalLengthM / 2 ? forward - totalLengthM : forward;
      du += Math.max(0, step);
    }
    const last = out[out.length - 1];
    const speedKph = sample.speedKph;
    out.push({
      du: last === undefined ? du : Math.max(du, last.du),
      tMonoMs: sample.tMonoMs,
      speedKph: speedKph === undefined || !Number.isFinite(speedKph) ? null : speedKph,
      channels: sample.channels ?? {},
    });
    previous = sample;
  }
  return out;
}

function interpolateAt(
  points: readonly { du: number; value: number }[],
  target: number,
  maxBridgeM: number,
): number | null {
  if (points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;
  if (target < first.du || target > last.du) return null;
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    const point = points[mid];
    if (point === undefined) return null;
    if (point.du <= target) low = mid;
    else high = mid;
  }
  const a = points[low];
  const b = points[high];
  if (a === undefined || b === undefined) return null;
  if (b.du - a.du > maxBridgeM) return null;
  if (b.du === a.du) return a.value;
  const ratio = (target - a.du) / (b.du - a.du);
  return a.value + (b.value - a.value) * ratio;
}

/** Half-width of the moving average applied to a ds/dt speed profile, metres. */
const SPEED_SMOOTHING_HALF_WIDTH_M = 7;
/** Below this the car is standing still and `ds/v` cannot carry the clock. */
const MIN_INTEGRATION_SPEED_MPS = 0.05;

/**
 * Fills the grid speed where GNSS Doppler was absent, from `ds/dt` of the
 * timestamp curve, and smooths ONLY those derived values (the Doppler speed is
 * a measurement and is never altered) -- `analysis-engine.md` §2.2.
 */
function fillDerivedSpeed(
  order: readonly number[],
  targets: readonly (number | null)[],
  measuredAbsMs: readonly (number | null)[],
  speedKph: (number | null)[],
  stepM: number,
): void {
  const derived: (number | null)[] = new Array<number | null>(order.length).fill(null);
  for (let position = 0; position < order.length; position += 1) {
    const index = order[position];
    if (index === undefined || speedKph[index] !== null) continue;
    const before = order[Math.max(0, position - 1)];
    const after = order[Math.min(order.length - 1, position + 1)];
    if (before === undefined || after === undefined || before === after) continue;
    const ds = (targets[after] ?? 0) - (targets[before] ?? 0);
    const dtMs = (measuredAbsMs[after] ?? 0) - (measuredAbsMs[before] ?? 0);
    if (!(ds > 0) || !(dtMs > 0)) continue;
    derived[position] = (ds / (dtMs / 1_000)) * 3.6;
  }
  const window = Math.max(1, Math.round(SPEED_SMOOTHING_HALF_WIDTH_M / stepM));
  for (let position = 0; position < order.length; position += 1) {
    const index = order[position];
    if (index === undefined || derived[position] === null) continue;
    let sum = 0;
    let count = 0;
    for (let probe = position - window; probe <= position + window; probe += 1) {
      const value = probe < 0 || probe >= order.length ? null : derived[probe];
      if (value === null || value === undefined) continue;
      sum += value;
      count += 1;
    }
    speedKph[index] = count === 0 ? (derived[position] ?? null) : sum / count;
  }
}

/** Relative disagreement between the integral and the clock that gets reported. */
export const TIME_INTEGRATION_DRIFT_TOLERANCE = 0.02;

interface TimeIntegration {
  /** `elapsedMs` written for every covered grid point. */
  originTMonoMs: number;
  driftMs: number;
  measuredMs: number;
}

/**
 * `t(s) = sum ds / v(s)`, anchored at the start/finish crossing
 * (`analysis-engine.md` line 29). The measured timestamps do NOT distribute the
 * time -- they only place the whole curve on the real clock and then VALIDATE
 * it: the difference between the integral and the measured span is reported as
 * `timeIntegrationDriftMs`. So 10 m covered at 20 m/s contribute 0.5 s even when
 * the two fixes around them are 2 s apart.
 *
 * The one thing `ds/v` cannot express is time that passes without distance: a
 * standstill. Its measured duration is added at the distance where it happened,
 * which is a measurement too, not an interpolation.
 */
function integrateElapsed(
  order: readonly number[],
  targets: readonly (number | null)[],
  elapsedMs: (number | null)[],
  speedKph: readonly (number | null)[],
  unwrapped: readonly UnwrappedSample[],
  measuredAbs: readonly (number | null)[],
  anchorDu: number,
): TimeIntegration | null {
  if (order.length < 2) return null;
  const duAt = (position: number): number => targets[order[position] as number] ?? 0;
  const speedAt = (position: number): number | null => {
    const value = speedKph[order[position] as number];
    return value === null || value === undefined || !Number.isFinite(value) ? null : value;
  };

  // 1. the integral itself, seconds.
  const model: number[] = new Array<number>(order.length).fill(0);
  for (let position = 1; position < order.length; position += 1) {
    const ds = duAt(position) - duAt(position - 1);
    const a = speedAt(position - 1);
    const b = speedAt(position);
    if (a === null || b === null || !(ds > 0)) return null;
    const mean = Math.max(MIN_INTEGRATION_SPEED_MPS, (a + b) / 2 / 3.6);
    model[position] = (model[position - 1] ?? 0) + ds / mean;
  }

  // 2. time spent standing still, where `ds/v` carries no clock at all.
  const stalls: { du: number; ms: number }[] = [];
  for (let index = 0; index + 1 < unwrapped.length; index += 1) {
    const a = unwrapped[index];
    const b = unwrapped[index + 1];
    if (a === undefined || b === undefined) continue;
    const ms = b.tMonoMs - a.tMonoMs;
    if (b.du > a.du || !(ms > 0)) continue;
    stalls.push({ du: a.du, ms });
  }
  const stalledBefore = (du: number): number => {
    let total = 0;
    for (const stall of stalls) if (stall.du < du) total += stall.ms;
    return total;
  };
  const timeAt = (position: number): number =>
    (model[position] ?? 0) * 1_000 + stalledBefore(duAt(position));

  // 3. the same curve at an arbitrary distance -- the start/finish crossing sits
  //    between two grid points, or (a lap sliced a few metres late) just before
  //    the first one, where the nearest speed extrapolates it.
  const lastPosition = order.length - 1;
  const timeAtDu = (du: number): number => {
    if (du <= duAt(0)) {
      const speed = speedAt(0);
      const mps = speed === null ? null : Math.max(MIN_INTEGRATION_SPEED_MPS, speed / 3.6);
      return timeAt(0) - (mps === null ? 0 : ((duAt(0) - du) / mps) * 1_000);
    }
    if (du >= duAt(lastPosition)) {
      const speed = speedAt(lastPosition);
      const mps = speed === null ? null : Math.max(MIN_INTEGRATION_SPEED_MPS, speed / 3.6);
      return timeAt(lastPosition) + (mps === null ? 0 : ((du - duAt(lastPosition)) / mps) * 1_000);
    }
    let low = 0;
    let high = lastPosition;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (duAt(mid) <= du) low = mid;
      else high = mid;
    }
    const span = duAt(high) - duAt(low);
    if (!(span > 0)) return timeAt(low);
    return timeAt(low) + ((timeAt(high) - timeAt(low)) * (du - duAt(low))) / span;
  };

  const anchorMs = timeAtDu(anchorDu);
  for (let position = 0; position < order.length; position += 1) {
    elapsedMs[order[position] as number] = timeAt(position) - anchorMs;
  }

  const firstMeasured = measuredAbs[order[0] as number];
  const lastMeasured = measuredAbs[order[lastPosition] as number];
  const measuredMs =
    firstMeasured === null ||
    firstMeasured === undefined ||
    lastMeasured === null ||
    lastMeasured === undefined
      ? 0
      : lastMeasured - firstMeasured;
  return {
    originTMonoMs: (firstMeasured ?? 0) - (timeAt(0) - anchorMs),
    driftMs: timeAt(lastPosition) - timeAt(0) - measuredMs,
    measuredMs,
  };
}

/**
 * The start/finish crossing this lap's clock is anchored at, as unwrapped
 * distance. A lap handed over with a lead-in from the previous lap crosses the
 * line twice; the crossing that starts THIS lap is the one whose forward lap
 * covers the most of the samples, and mapping every grid point off that single
 * crossing is what keeps `t(s)` monotone from 0 m to the flag.
 */
function chooseAnchorDu(
  firstDu: number,
  lastDu: number,
  totalLengthM: number,
  stepM: number,
  gridSize: number,
): number {
  let bestAnchor = 0;
  let bestCount = -1;
  const lastTurn = Math.max(0, Math.floor(lastDu / totalLengthM));
  for (let turn = 0; turn <= lastTurn; turn += 1) {
    const anchor = turn * totalLengthM;
    let count = 0;
    for (let index = 0; index < gridSize; index += 1) {
      const target = anchor + index * stepM;
      if (target >= firstDu && target <= lastDu) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      bestAnchor = anchor;
    }
  }
  return bestAnchor;
}

/**
 * Resamples one lap onto a fixed distance grid. Grid points outside the
 * sampled distance range, or inside a gap wider than `maxBridgeM`, are `null`
 * (and `covered[k] === false`) -- never guessed.
 */
export function resampleLapToDistanceGrid(
  samples: readonly CornerLapSample[],
  options: DistanceGridOptions,
): DistanceGrid {
  assertPositiveLength(options.totalLengthM);
  const stepM = options.stepM ?? DEFAULT_GRID_STEP_M;
  if (!Number.isFinite(stepM) || stepM <= 0) {
    throw new RangeError('stepM must be a positive, finite number of metres');
  }
  const maxBridgeM = options.maxBridgeM ?? DEFAULT_MAX_BRIDGE_M;
  if (!Number.isFinite(maxBridgeM) || maxBridgeM <= 0) {
    throw new RangeError('maxBridgeM must be a positive, finite number of metres');
  }
  const totalLengthM = options.totalLengthM;
  const gridSize = Math.max(1, Math.ceil(totalLengthM / stepM));
  const distanceM = Array.from({ length: gridSize }, (_, index) => index * stepM);
  const unwrapped = unwrapSamples(samples, totalLengthM);
  const first = unwrapped[0];
  const last = unwrapped[unwrapped.length - 1];

  const requested =
    options.channels ??
    ANALYSIS_CHANNELS.filter((channel) =>
      unwrapped.some((sample) => Number.isFinite(sample.channels[channel])),
    );
  const channelPoints = new Map<CoachingChannelId, { du: number; value: number }[]>();
  for (const channel of requested) {
    channelPoints.set(
      channel,
      unwrapped
        .filter((sample) => Number.isFinite(sample.channels[channel]))
        .map((sample) => ({ du: sample.du, value: sample.channels[channel] as number })),
    );
  }

  const elapsedMs: (number | null)[] = new Array<number | null>(gridSize).fill(null);
  const speedKph: (number | null)[] = new Array<number | null>(gridSize).fill(null);
  const covered: boolean[] = new Array<boolean>(gridSize).fill(false);
  const channels: Partial<Record<CoachingChannelId, (number | null)[]>> = {};
  for (const channel of requested) {
    channels[channel] = new Array<number | null>(gridSize).fill(null);
  }

  if (first === undefined || last === undefined) {
    return {
      stepM,
      totalLengthM,
      distanceM,
      elapsedMs,
      speedKph,
      channels,
      covered,
      originDistanceM: 0,
      originTMonoMs: 0,
      coverageFraction: 0,
      timeIntegrationDriftMs: null,
      timeIntegrationDriftExceeded: false,
    };
  }

  const timePoints = unwrapped.map((sample) => ({ du: sample.du, value: sample.tMonoMs }));
  const speedPoints = unwrapped
    .filter((sample) => sample.speedKph !== null)
    .map((sample) => ({ du: sample.du, value: sample.speedKph as number }));

  // --- pass 1: coverage, the measured time, Doppler speed --------------------
  // Every grid point is measured off ONE start/finish crossing, so grid index 0
  // is this lap's beginning and grid index n-1 its end -- never the lead-in of
  // the previous lap that happens to sit at the same distance.
  const anchorDu = chooseAnchorDu(first.du, last.du, totalLengthM, stepM, gridSize);
  const targets: (number | null)[] = new Array<number | null>(gridSize).fill(null);
  const measuredAbs: (number | null)[] = new Array<number | null>(gridSize).fill(null);
  let coveredCount = 0;
  for (let index = 0; index < gridSize; index += 1) {
    const target = anchorDu + index * stepM;
    if (target < first.du || target > last.du) continue;
    const t = interpolateAt(timePoints, target, maxBridgeM);
    if (t === null) continue;
    targets[index] = target;
    measuredAbs[index] = t;
    covered[index] = true;
    coveredCount += 1;
    speedKph[index] = interpolateAt(speedPoints, target, maxBridgeM);
    for (const channel of requested) {
      const points = channelPoints.get(channel);
      const series = channels[channel];
      if (points === undefined || series === undefined) continue;
      series[index] = interpolateAt(points, target, maxBridgeM);
    }
  }

  // Grid points in travel order -- the targets increase with the grid index.
  const order = distanceM
    .map((_value, index) => index)
    .filter((index) => covered[index] === true);

  fillDerivedSpeed(order, targets, measuredAbs, speedKph, stepM);
  const integration = integrateElapsed(
    order,
    targets,
    elapsedMs,
    speedKph,
    unwrapped,
    measuredAbs,
    anchorDu,
  );
  // No usable speed profile: the measured clock stands in for the integral, and
  // no drift is claimed. The crossing is still the origin.
  const fallbackOrigin =
    interpolateAt(timePoints, anchorDu, maxBridgeM) ??
    measuredAbs[order[0] ?? -1] ??
    first.tMonoMs;
  if (integration === null) {
    for (const index of order) {
      const measured = measuredAbs[index];
      if (measured !== null && measured !== undefined) elapsedMs[index] = measured - fallbackOrigin;
    }
  }

  return {
    stepM,
    totalLengthM,
    distanceM,
    elapsedMs,
    speedKph,
    channels,
    covered,
    originDistanceM: 0,
    originTMonoMs: integration?.originTMonoMs ?? fallbackOrigin,
    coverageFraction: coveredCount / gridSize,
    timeIntegrationDriftMs: integration?.driftMs ?? null,
    timeIntegrationDriftExceeded:
      integration !== null &&
      integration.measuredMs > 0 &&
      Math.abs(integration.driftMs) > TIME_INTEGRATION_DRIFT_TOLERANCE * integration.measuredMs,
  };
}

// ---------------------------------------------------------------------------
// 4. Delta curve
// ---------------------------------------------------------------------------

/**
 * `dt(s) = t_lap(s) - t_ref(s)` on the shared grid. `null` wherever either lap
 * has no covered value. Both grids must share step and circuit length.
 */
export function deltaCurveMs(lap: DistanceGrid, reference: DistanceGrid): (number | null)[] {
  if (lap.stepM !== reference.stepM || lap.totalLengthM !== reference.totalLengthM) {
    throw new RangeError('delta needs two grids with the same stepM and totalLengthM');
  }
  return lap.elapsedMs.map((value, index) => {
    const other = reference.elapsedMs[index];
    if (value === null || other === null || other === undefined) return null;
    return value - other;
  });
}

/**
 * Time gained (negative) or lost (positive) between two lap distances: the
 * change of the delta curve across the segment, which is independent of where
 * each lap's `elapsedMs` origin sits. `null` when an end is uncovered.
 *
 * A segment that crosses the start/finish line is TWO stretches of the curve --
 * `startM -> end of lap` and `start of lap -> endM` -- and its contribution is
 * their sum. Subtracting `delta[endM] - delta[startM]` across the line instead
 * would report a slower-everywhere lap as having GAINED almost a full lap's
 * delta on that sector. Both terms only mean anything because each grid's
 * `t(s)` is anchored at ITS OWN start/finish crossing: "start of lap" is then
 * 0 m for every lap, however many metres after the line its first fix landed.
 */
export function deltaOverSegmentMs(
  delta: readonly (number | null)[],
  startM: number,
  endM: number,
  grid: Pick<DistanceGrid, 'stepM' | 'totalLengthM'>,
): number | null {
  assertPositiveLength(grid.totalLengthM);
  if (delta.length === 0) return null;
  const indexOf = (distance: number): number => {
    const wrapped = normalizeDistance(distance, grid.totalLengthM);
    return Math.min(delta.length - 1, Math.max(0, Math.round(wrapped / grid.stepM) % delta.length));
  };
  const at = (index: number): number | null => {
    const value = delta[index];
    return value === null || value === undefined || !Number.isFinite(value) ? null : value;
  };
  const startValue = at(indexOf(startM));
  const endValue = at(indexOf(endM));
  if (startValue === null || endValue === null) return null;
  if (!windowWraps(startM, endM, grid.totalLengthM)) return endValue - startValue;
  // The lap's own last and first covered grid points stand for "end of lap" and
  // "start of lap": the delta accumulated between them is a full lap's worth.
  let lapEndIndex = -1;
  for (let index = delta.length - 1; index >= 0; index -= 1) {
    if (at(index) !== null) {
      lapEndIndex = index;
      break;
    }
  }
  let lapStartIndex = -1;
  for (let index = 0; index < delta.length; index += 1) {
    if (at(index) !== null) {
      lapStartIndex = index;
      break;
    }
  }
  if (lapEndIndex < indexOf(startM) || lapStartIndex > indexOf(endM)) return null;
  const lapEndValue = at(lapEndIndex);
  const lapStartValue = at(lapStartIndex);
  if (lapEndValue === null || lapStartValue === null) return null;
  return lapEndValue - startValue + (endValue - lapStartValue);
}
