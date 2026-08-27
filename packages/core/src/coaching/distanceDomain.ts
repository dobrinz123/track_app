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
  /** Milliseconds since the lap's first projected sample, per grid point. */
  elapsedMs: (number | null)[];
  speedKph: (number | null)[];
  /** Resampled channel values, keyed by channel id; every array is grid-length. */
  channels: Partial<Record<CoachingChannelId, (number | null)[]>>;
  /** True where `elapsedMs` came from real samples close enough to interpolate. */
  covered: boolean[];
  /** Lap distance of the first projected sample (the `elapsedMs` origin). */
  originDistanceM: number;
  /** Monotonic timestamp of that first sample. */
  originTMonoMs: number;
  /** Fraction of grid points covered, 0..1. */
  coverageFraction: number;
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
  elapsedMs: readonly (number | null)[],
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
    const dtMs = (elapsedMs[after] ?? 0) - (elapsedMs[before] ?? 0);
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

/**
 * Turns `t(s)` into the integral the design asks for: `t(s) = sum ds / v(s)`.
 *
 * The speed profile decides HOW the time is distributed inside each pair of
 * real samples (so sub-sample resolution follows the physics, not timestamp
 * jitter), while the measured timestamps still anchor both ends of every
 * interval -- a standstill, where `ds/v` carries no clock at all, therefore
 * keeps its real duration. Where no speed profile exists the linear-in-distance
 * interpolation stands.
 */
function integrateElapsedFromSpeed(
  order: readonly number[],
  targets: readonly (number | null)[],
  elapsedMs: (number | null)[],
  speedKph: readonly (number | null)[],
  unwrapped: readonly UnwrappedSample[],
  originTMonoMs: number,
): void {
  if (order.length < 2) return;
  // Cumulative "model time" (seconds) along the grid: sum of ds / v.
  const model: number[] = new Array<number>(order.length).fill(0);
  for (let position = 1; position < order.length; position += 1) {
    const previous = order[position - 1];
    const current = order[position];
    if (previous === undefined || current === undefined) return;
    const ds = (targets[current] ?? 0) - (targets[previous] ?? 0);
    const a = speedKph[previous];
    const b = speedKph[current];
    if (a === null || a === undefined || b === null || b === undefined || !(ds > 0)) return;
    const mean = Math.max(MIN_INTEGRATION_SPEED_MPS, (a + b) / 2 / 3.6);
    model[position] = (model[position - 1] ?? 0) + ds / mean;
  }
  const modelAt = (du: number): number | null => {
    let low = 0;
    let high = order.length - 1;
    const firstTarget = targets[order[0] as number] ?? 0;
    const lastTarget = targets[order[order.length - 1] as number] ?? 0;
    if (du <= firstTarget) return model[0] ?? 0;
    if (du >= lastTarget) return model[order.length - 1] ?? 0;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if ((targets[order[mid] as number] ?? 0) <= du) low = mid;
      else high = mid;
    }
    const lowTarget = targets[order[low] as number] ?? 0;
    const highTarget = targets[order[high] as number] ?? 0;
    const lowModel = model[low] ?? 0;
    const highModel = model[high] ?? 0;
    if (highTarget === lowTarget) return lowModel;
    return lowModel + ((highModel - lowModel) * (du - lowTarget)) / (highTarget - lowTarget);
  };

  let cursor = 0;
  for (const index of order) {
    const target = targets[index];
    if (target === null || target === undefined) continue;
    while (cursor + 1 < unwrapped.length && (unwrapped[cursor + 1]?.du ?? 0) < target) cursor += 1;
    const a = unwrapped[cursor];
    const b = unwrapped[cursor + 1];
    if (a === undefined || b === undefined) continue;
    if (target < a.du || target > b.du) continue;
    const spanMs = b.tMonoMs - a.tMonoMs;
    const modelA = modelAt(a.du);
    const modelB = modelAt(b.du);
    if (modelA === null || modelB === null) continue;
    const modelSpan = modelB - modelA;
    if (!(modelSpan > 0) || !Number.isFinite(spanMs)) continue;
    const fraction = ((modelAt(target) ?? modelA) - modelA) / modelSpan;
    if (!Number.isFinite(fraction)) continue;
    elapsedMs[index] = a.tMonoMs + fraction * spanMs - originTMonoMs;
  }
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
    };
  }

  const timePoints = unwrapped.map((sample) => ({ du: sample.du, value: sample.tMonoMs }));
  const speedPoints = unwrapped
    .filter((sample) => sample.speedKph !== null)
    .map((sample) => ({ du: sample.du, value: sample.speedKph as number }));

  // --- pass 1: coverage, the timestamp-interpolated time, Doppler speed ------
  const targets: (number | null)[] = new Array<number | null>(gridSize).fill(null);
  let coveredCount = 0;
  for (let index = 0; index < gridSize; index += 1) {
    const base = index * stepM;
    // The lap may start anywhere; try the wrap offsets that can land inside the
    // sampled span, smallest first, so the mapping is deterministic.
    let target: number | null = null;
    for (let turn = Math.floor((first.du - base) / totalLengthM); ; turn += 1) {
      const candidate = base + turn * totalLengthM;
      if (candidate > last.du) break;
      if (candidate >= first.du) {
        target = candidate;
        break;
      }
    }
    if (target === null) continue;
    const t = interpolateAt(timePoints, target, maxBridgeM);
    if (t === null) continue;
    targets[index] = target;
    elapsedMs[index] = t - first.tMonoMs;
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

  // Grid points in TRAVEL order (a lap may start anywhere on the grid).
  const order = distanceM
    .map((_value, index) => index)
    .filter((index) => covered[index] === true)
    .sort((a, b) => (targets[a] ?? 0) - (targets[b] ?? 0));

  fillDerivedSpeed(order, targets, elapsedMs, speedKph, stepM);
  integrateElapsedFromSpeed(order, targets, elapsedMs, speedKph, unwrapped, first.tMonoMs);

  return {
    stepM,
    totalLengthM,
    distanceM,
    elapsedMs,
    speedKph,
    channels,
    covered,
    originDistanceM: normalizeDistance(first.du, totalLengthM),
    originTMonoMs: first.tMonoMs,
    coverageFraction: coveredCount / gridSize,
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
 * delta on that sector.
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
