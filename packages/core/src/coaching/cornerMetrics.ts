import { CORNER_ANALYSIS_VERSION, type Corner } from '../contracts';

import { forwardDistance, inDistanceWindow, normalizeDistance } from './distanceDomain';
import {
  ANALYSIS_CHANNELS,
  GRAVITY_MPS2,
  type ChannelAvailability,
  type CoachingChannelId,
  type CornerLapSample,
  type CornerMetrics,
  type CornerQualityFlag,
} from './types';

/**
 * Per (lap, corner) deterministic metrics -- `docs/architecture/analysis-engine.md`
 * §4 and the Phase 5 safety contract rule 1 ("deterministic numbers").
 *
 * Everything is measured on the 1 m DISTANCE GRID (§2.2): the raw samples are
 * resampled onto it first, so a brake point, an entry speed or a corner time
 * has metre resolution instead of inheriting the GNSS sample spacing (40 m at
 * 1 Hz and 40 m/s). Only the data-quality checks -- reported accuracy and real
 * sample gaps -- read the raw samples, because those are facts about the
 * recording, not about the car.
 *
 * Tier 0 (GPS only) always works: braking onset and the lift point fall back to
 * the speed derivative. Tier 1 (`accelPedalPct` / `throttlePct`) and tier 2
 * (`brakePct`, `steeringDeg`) refine them WITHOUT changing the shape of the
 * output -- every metric carries the estimator that produced it, so the report
 * can name it. A channel the caller declared unsupported is never read, and a
 * metric that cannot be measured is `null`, never a guess.
 */

export interface CornerMetricsOptions {
  /** Circuit length, metres -- corner windows are wrap-aware. */
  totalLengthM: number;
  /** Channels this vehicle/session does not provide; never read even if present. */
  unsupportedChannels?: readonly CoachingChannelId[];
  /**
   * Braking-zone length before the corner entry, metres. Default: derived from
   * the corner's speed drop (see `approachLengthM`).
   */
  approachWindowM?: number;
  /**
   * Exit-zone length after the corner exit, metres. Default: derived from the
   * corner's speed drop (see `exitLengthM`).
   */
  exitWindowM?: number;
  /** Sustained deceleration that counts as braking, g. Default 0.15. */
  brakeThresholdG?: number;
  /** Sustained deceleration that counts as a lift, g. Default 0.05. */
  liftThresholdG?: number;
  /** How long a threshold must hold to count as sustained, ms. Default 300. */
  sustainMs?: number;
  /** GNSS accuracy above this is "poor", metres. Default 25. */
  poorAccuracyM?: number;
  /** Gap between consecutive in-window samples that is flagged, ms. Default 2000. */
  sampleGapMs?: number;
  /** Analysis grid spacing, metres. Default 1 (the binding design's `ds`). */
  gridStepM?: number;
  /** Largest sample-to-sample distance the grid still bridges, metres. Default 60. */
  maxBridgeM?: number;
}

interface ResolvedOptions {
  totalLengthM: number;
  /** Caller override, or `null` when the window is derived per corner. */
  approachWindowM: number | null;
  exitWindowM: number | null;
  brakeThresholdG: number;
  liftThresholdG: number;
  sustainMs: number;
  poorAccuracyM: number;
  sampleGapMs: number;
  gridStepM: number;
  maxBridgeM: number;
  unsupported: ReadonlySet<CoachingChannelId>;
}

/** Accelerator-pedal reading at or below this counts as "off the throttle" (%). */
const LIFT_PEDAL_PCT = 10;
/** Throttle-plate lift threshold as a fraction of the highest opening seen in the approach. */
const LIFT_PLATE_FRACTION = 0.25;
/** Accelerator-pedal reading above this counts as "back on the throttle" (%). */
const THROTTLE_ON_PCT = 20;
/** Accelerator-pedal reading at or above this counts as full throttle (%). */
const FULL_THROTTLE_PCT = 90;
/** Brake channel reading above this counts as braking (%). */
const BRAKE_ON_PCT = 5;
/** Sustained acceleration that counts as "back on the power" without a pedal channel, g. */
const THROTTLE_ON_G = 0.05;
/** Steering angle that counts as turn-in, degrees. */
const TURN_IN_STEERING_DEG = 5;
/** Yaw rate that counts as turn-in, degrees/second. */
const TURN_IN_YAW_DPS = 5;
/** Steering change below this is noise, not a correction (degrees). */
const STEERING_DEADBAND_DEG = 0.5;
/** How far into a window coverage may start/end before it counts as truncated (metres). */
const COVERAGE_TOLERANCE_M = 20;
/** Fraction of in-window samples allowed to exceed the accuracy threshold. */
const POOR_ACCURACY_FRACTION = 0.05;
/**
 * Speed the car must actually lose over the sustain window before an IMU
 * deceleration is accepted as braking, km/h. A tilted phone reads a steady
 * negative longitudinal g while the GPS speed does not move at all.
 */
const BRAKE_SPEED_DROP_KPH = 0.5;

// --- corner-window derivation (analysis-engine.md §2.4) ----------------------
/** Nominal acceleration out of a corner, m/s^2 -- sizes the windows only. */
const WINDOW_ACCEL_MPS2 = 2.5;
/** Nominal braking deceleration, m/s^2 -- sizes the approach window only. */
const WINDOW_BRAKE_MPS2 = 3.5;
/** Margin on the derived braking distance: a road driver brakes well before the limit. */
const WINDOW_BRAKE_MARGIN = 1.4;
/** Metres added so the window always contains the lift that precedes the brake. */
const WINDOW_LEAD_M = 25;
/** Highest straight-line speed the derivation assumes, m/s (~250 km/h). */
const WINDOW_TOP_SPEED_MPS = 70;
const MIN_APPROACH_M = 40;
const MAX_APPROACH_M = 400;
const MIN_EXIT_M = 30;
const MAX_EXIT_M = 300;

function positive(value: number, key: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${key} must be a positive, finite number`);
  }
  return value;
}

function resolveOptions(options: CornerMetricsOptions): ResolvedOptions {
  if (!Number.isFinite(options.totalLengthM) || options.totalLengthM <= 0) {
    throw new RangeError('totalLengthM must be a positive, finite number of metres');
  }
  return {
    totalLengthM: options.totalLengthM,
    approachWindowM:
      options.approachWindowM === undefined
        ? null
        : positive(options.approachWindowM, 'approachWindowM'),
    exitWindowM:
      options.exitWindowM === undefined ? null : positive(options.exitWindowM, 'exitWindowM'),
    brakeThresholdG: positive(options.brakeThresholdG ?? 0.15, 'brakeThresholdG'),
    liftThresholdG: positive(options.liftThresholdG ?? 0.05, 'liftThresholdG'),
    sustainMs: positive(options.sustainMs ?? 300, 'sustainMs'),
    poorAccuracyM: positive(options.poorAccuracyM ?? 25, 'poorAccuracyM'),
    sampleGapMs: positive(options.sampleGapMs ?? 2_000, 'sampleGapMs'),
    gridStepM: positive(options.gridStepM ?? 1, 'gridStepM'),
    maxBridgeM: positive(options.maxBridgeM ?? 60, 'maxBridgeM'),
    unsupported: new Set(options.unsupportedChannels ?? []),
  };
}

// ---------------------------------------------------------------------------
// Channel availability
// ---------------------------------------------------------------------------

/**
 * Which analysis channels this lap actually carries. `unsupportedChannels`
 * (from the vehicle profile / telemetry contract) wins over presence: a channel
 * declared unsupported is reported as unsupported and never read.
 */
export function channelAvailability(
  samples: readonly CornerLapSample[],
  unsupportedChannels: readonly CoachingChannelId[] = [],
): ChannelAvailability {
  const unsupportedSet = new Set(unsupportedChannels);
  const present = new Set<CoachingChannelId>();
  for (const sample of samples) {
    if (sample.speedKph !== undefined && Number.isFinite(sample.speedKph)) present.add('speedKph');
    const channels = sample.channels;
    if (channels === undefined) continue;
    for (const channel of ANALYSIS_CHANNELS) {
      if (Number.isFinite(channels[channel])) present.add(channel);
    }
  }
  const available: CoachingChannelId[] = [];
  const unsupported: CoachingChannelId[] = [];
  const missing: CoachingChannelId[] = [];
  for (const channel of ANALYSIS_CHANNELS) {
    if (unsupportedSet.has(channel)) unsupported.push(channel);
    else if (present.has(channel)) available.push(channel);
    else missing.push(channel);
  }
  return { available, unsupported, missing };
}

// ---------------------------------------------------------------------------
// Per-sample series
// ---------------------------------------------------------------------------

interface LapSeries {
  distanceM: number[];
  /** Unwrapped, non-decreasing progress of each entry, metres. */
  du: number[];
  tMonoMs: number[];
  accuracyM: (number | null)[];
  speedKph: (number | null)[];
  /** Forward longitudinal acceleration in g (negative = deceleration). */
  accelG: (number | null)[];
  accelSource: 'longG' | 'gpsSpeed' | null;
  /** The same, always derived from speed when speed exists -- the cross-check. */
  speedAccelG: (number | null)[] | null;
  channels: Map<CoachingChannelId, (number | null)[]>;
}

function channelValue(
  sample: CornerLapSample,
  channel: CoachingChannelId,
  unsupported: ReadonlySet<CoachingChannelId>,
): number | null {
  if (unsupported.has(channel)) return null;
  const value = sample.channels?.[channel];
  return value === undefined || !Number.isFinite(value) ? null : value;
}

/** Longitudinal acceleration in g from a speed series, forward differences. */
function speedDerivativeG(
  speedKph: readonly (number | null)[],
  tMonoMs: readonly number[],
): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(speedKph.length).fill(null);
  for (let index = 0; index + 1 < speedKph.length; index += 1) {
    const vCurrent = speedKph[index];
    const vNext = speedKph[index + 1];
    const tCurrent = tMonoMs[index];
    const tNext = tMonoMs[index + 1];
    if (vCurrent === null || vNext === null || vCurrent === undefined || vNext === undefined) continue;
    if (tCurrent === undefined || tNext === undefined) continue;
    const dtSeconds = (tNext - tCurrent) / 1_000;
    if (!(dtSeconds > 0)) continue;
    out[index] = (vNext - vCurrent) / 3.6 / dtSeconds / GRAVITY_MPS2;
  }
  return out;
}

function finishSeries(series: Omit<LapSeries, 'accelG' | 'accelSource' | 'speedAccelG'>): LapSeries {
  const longG = series.channels.get('longG') ?? [];
  const hasLongG = longG.some((value) => value !== null);
  const hasSpeed = series.speedKph.some((value) => value !== null);
  const speedAccelG = hasSpeed ? speedDerivativeG(series.speedKph, series.tMonoMs) : null;
  const accelG: (number | null)[] = new Array<number | null>(series.distanceM.length).fill(null);
  let accelSource: LapSeries['accelSource'] = null;
  if (hasLongG) {
    accelSource = 'longG';
    for (let index = 0; index < accelG.length; index += 1) accelG[index] = longG[index] ?? null;
  } else if (speedAccelG !== null) {
    accelSource = 'gpsSpeed';
    for (let index = 0; index < accelG.length; index += 1) accelG[index] = speedAccelG[index] ?? null;
  }
  return { ...series, accelG, accelSource, speedAccelG };
}

/** The raw samples as parallel arrays, in recording order. */
function buildRawSeries(
  samples: readonly CornerLapSample[],
  options: ResolvedOptions,
): LapSeries {
  const distanceM: number[] = [];
  const du: number[] = [];
  const tMonoMs: number[] = [];
  const accuracyM: (number | null)[] = [];
  const speedKph: (number | null)[] = [];
  const channels = new Map<CoachingChannelId, (number | null)[]>();
  for (const channel of ANALYSIS_CHANNELS) channels.set(channel, []);

  for (const sample of samples) {
    if (!Number.isFinite(sample.distanceM) || !Number.isFinite(sample.tMonoMs)) {
      throw new RangeError('every sample needs a finite tMonoMs and distanceM');
    }
    const distance = normalizeDistance(sample.distanceM, options.totalLengthM);
    const previousDistance = distanceM[distanceM.length - 1];
    const previousDu = du[du.length - 1];
    if (previousDistance === undefined || previousDu === undefined) {
      du.push(distance);
    } else {
      const forward = forwardDistance(previousDistance, distance, options.totalLengthM);
      const step = forward > options.totalLengthM / 2 ? forward - options.totalLengthM : forward;
      du.push(previousDu + Math.max(0, step));
    }
    distanceM.push(distance);
    tMonoMs.push(sample.tMonoMs);
    accuracyM.push(
      sample.accuracyM === undefined || !Number.isFinite(sample.accuracyM)
        ? null
        : sample.accuracyM,
    );
    speedKph.push(
      sample.speedKph === undefined || !Number.isFinite(sample.speedKph) ? null : sample.speedKph,
    );
    for (const channel of ANALYSIS_CHANNELS) {
      channels.get(channel)?.push(channelValue(sample, channel, options.unsupported));
    }
  }

  // Speed: reported when present, otherwise the distance derivative (the named
  // tier-0 estimator; `docs/architecture/analysis-engine.md` §2.2).
  for (let index = 0; index + 1 < speedKph.length; index += 1) {
    if (speedKph[index] !== null) continue;
    const duCurrent = du[index];
    const duNext = du[index + 1];
    const tCurrent = tMonoMs[index];
    const tNext = tMonoMs[index + 1];
    if (duCurrent === undefined || duNext === undefined) continue;
    if (tCurrent === undefined || tNext === undefined) continue;
    const dtSeconds = (tNext - tCurrent) / 1_000;
    if (!(dtSeconds > 0)) continue;
    speedKph[index] = ((duNext - duCurrent) / dtSeconds) * 3.6;
  }

  return finishSeries({ distanceM, du, tMonoMs, accuracyM, speedKph, channels });
}

function lerp(a: number, b: number, ratio: number): number {
  return a + (b - a) * ratio;
}

function lerpNullable(
  a: number | null | undefined,
  b: number | null | undefined,
  ratio: number,
): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return lerp(a, b, ratio);
}

/**
 * Resamples the raw series onto the fixed distance grid anchored at the
 * start/finish line: every emitted entry sits at an exact multiple of
 * `gridStepM` metres from S/F. A pair of raw samples further apart than
 * `maxBridgeM` is a hole and produces no grid entries -- nothing is invented
 * across it. A lap handed in with a lead-in from the previous lap crosses some
 * grid distances twice, and both passes are kept.
 */
function buildGridSeries(raw: LapSeries, options: ResolvedOptions): LapSeries {
  const { totalLengthM, gridStepM, maxBridgeM } = options;
  const distanceM: number[] = [];
  const du: number[] = [];
  const tMonoMs: number[] = [];
  const accuracyM: (number | null)[] = [];
  const speedKph: (number | null)[] = [];
  const channels = new Map<CoachingChannelId, (number | null)[]>();
  for (const channel of ANALYSIS_CHANNELS) channels.set(channel, []);

  const firstDu = raw.du[0];
  const lastDu = raw.du[raw.du.length - 1];
  if (firstDu === undefined || lastDu === undefined || raw.du.length < 2) {
    return finishSeries({ distanceM, du, tMonoMs, accuracyM, speedKph, channels });
  }

  const gridSize = Math.max(1, Math.ceil(totalLengthM / gridStepM));
  const firstTurn = Math.floor(firstDu / totalLengthM);
  const lastTurn = Math.floor(lastDu / totalLengthM);
  let cursor = 0;
  for (let turn = firstTurn; turn <= lastTurn; turn += 1) {
    for (let step = 0; step < gridSize; step += 1) {
      const gridDistanceM = step * gridStepM;
      if (gridDistanceM >= totalLengthM) break;
      const target = turn * totalLengthM + gridDistanceM;
      if (target < firstDu) continue;
      if (target > lastDu) break;
      while (cursor + 1 < raw.du.length && (raw.du[cursor + 1] ?? 0) < target) cursor += 1;
      const lowDu = raw.du[cursor];
      const highDu = raw.du[cursor + 1];
      if (lowDu === undefined || highDu === undefined) continue;
      if (highDu - lowDu > maxBridgeM) continue;
      const ratio = highDu === lowDu ? 0 : (target - lowDu) / (highDu - lowDu);
      const tLow = raw.tMonoMs[cursor];
      const tHigh = raw.tMonoMs[cursor + 1];
      if (tLow === undefined || tHigh === undefined) continue;
      distanceM.push(gridDistanceM);
      du.push(target);
      tMonoMs.push(lerp(tLow, tHigh, ratio));
      accuracyM.push(lerpNullable(raw.accuracyM[cursor], raw.accuracyM[cursor + 1], ratio));
      speedKph.push(lerpNullable(raw.speedKph[cursor], raw.speedKph[cursor + 1], ratio));
      for (const channel of ANALYSIS_CHANNELS) {
        const source = raw.channels.get(channel);
        channels
          .get(channel)
          ?.push(lerpNullable(source?.[cursor], source?.[cursor + 1], ratio));
      }
    }
  }

  return finishSeries({ distanceM, du, tMonoMs, accuracyM, speedKph, channels });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

interface Run {
  /** Series indices of this pass through the window, in travel order. */
  indices: number[];
  /** Distance from the window start to this run's first entry, metres. */
  startOffsetM: number;
  /** Distance from the window start to this run's last entry, metres. */
  endOffsetM: number;
}

interface WindowView {
  startM: number;
  endM: number;
  spanM: number;
  runs: Run[];
  /**
   * The run the metrics are measured over: the one covering the most of the
   * window, and among equals the LAST one -- a lap handed to the analysis with
   * a lead-in from the previous lap passes some corners twice, and the pass
   * that belongs to this lap is the later one.
   */
  run: Run | null;
}

function runSpan(run: Run): number {
  return run.endOffsetM - run.startOffsetM;
}

function buildWindow(
  series: LapSeries,
  startM: number,
  endM: number,
  totalLengthM: number,
): WindowView {
  const windowStartM = normalizeDistance(startM, totalLengthM);
  const runs: Run[] = [];
  let current: Run | null = null;
  for (let index = 0; index < series.distanceM.length; index += 1) {
    const distance = series.distanceM[index];
    const inside =
      distance !== undefined && inDistanceWindow(distance, startM, endM, totalLengthM);
    if (inside && distance !== undefined) {
      const offset = forwardDistance(windowStartM, distance, totalLengthM);
      if (current === null) {
        current = { indices: [index], startOffsetM: offset, endOffsetM: offset };
      } else {
        current.indices.push(index);
        current.endOffsetM = offset;
      }
    } else if (current !== null) {
      runs.push(current);
      current = null;
    }
  }
  if (current !== null) runs.push(current);

  // A corner that straddles the start/finish line is recorded as the END of the
  // series (its entry half) and the START of the series (its exit half). Those
  // are the two halves of ONE pass through the window, so they are joined --
  // otherwise every such corner is permanently "truncated" and drops out of the
  // envelope. The join is only made for exactly that shape: the series' own
  // first and last runs, in a window that wraps, whose offsets do not overlap.
  const candidates: Run[] = [...runs];
  const head = runs[0];
  const tail = runs[runs.length - 1];
  if (
    runs.length >= 2 &&
    head !== undefined &&
    tail !== undefined &&
    head.indices[0] === 0 &&
    tail.indices[tail.indices.length - 1] === series.distanceM.length - 1 &&
    normalizeDistance(startM, totalLengthM) > normalizeDistance(endM, totalLengthM) &&
    tail.endOffsetM <= head.startOffsetM
  ) {
    candidates.push({
      indices: [...tail.indices, ...head.indices],
      startOffsetM: tail.startOffsetM,
      endOffsetM: head.endOffsetM,
    });
  }

  let chosen: Run | null = null;
  for (const run of candidates) {
    if (chosen === null || runSpan(run) >= runSpan(chosen)) chosen = run;
  }
  return {
    startM: windowStartM,
    endM: normalizeDistance(endM, totalLengthM),
    spanM: forwardDistance(startM, endM, totalLengthM),
    runs,
    run: chosen,
  };
}

function coverageFlags(
  window: WindowView,
  truncatedFlag: CornerQualityFlag,
  emptyFlag: CornerQualityFlag,
): CornerQualityFlag[] {
  if (window.run === null) return [emptyFlag];
  if (
    window.run.startOffsetM > COVERAGE_TOLERANCE_M ||
    window.spanM - window.run.endOffsetM > COVERAGE_TOLERANCE_M
  ) {
    return [truncatedFlag];
  }
  return [];
}

/** Restricts a run to the entries at or after a given window offset. */
function runFromOffset(
  run: Run,
  series: LapSeries,
  windowStartM: number,
  offsetM: number,
  totalLengthM: number,
): Run | null {
  const indices = run.indices.filter((index) => {
    const distance = series.distanceM[index];
    if (distance === undefined) return false;
    return forwardDistance(windowStartM, distance, totalLengthM) >= offsetM;
  });
  const first = indices[0];
  const last = indices[indices.length - 1];
  if (first === undefined || last === undefined) return null;
  return {
    indices,
    startOffsetM: forwardDistance(windowStartM, series.distanceM[first] ?? 0, totalLengthM),
    endOffsetM: forwardDistance(windowStartM, series.distanceM[last] ?? 0, totalLengthM),
  };
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * First entry of `run` from which `predicate` holds continuously for at least
 * `sustainMs` of REAL TIME. "Sustained" is a duration, never a sample count, so
 * the answer does not change with the sample rate; a burst that ends before the
 * duration elapses -- including at the very end of the window -- is not
 * sustained and is not reported.
 */
function firstSustained(
  series: LapSeries,
  run: Run,
  sustainMs: number,
  predicate: (index: number) => boolean,
): number | null {
  const indices = run.indices;
  for (let position = 0; position < indices.length; position += 1) {
    const start = indices[position];
    if (start === undefined || !predicate(start)) continue;
    const startTime = series.tMonoMs[start];
    if (startTime === undefined) continue;
    let reached = false;
    for (let probe = position + 1; probe < indices.length; probe += 1) {
      const index = indices[probe];
      const previous = indices[probe - 1];
      // A join between the two halves of a wrapping corner is not a time
      // interval: the clock cannot be carried across it.
      if (index === undefined || previous === undefined || index !== previous + 1) break;
      if (!predicate(index)) break;
      const time = series.tMonoMs[index];
      if (time !== undefined && time - startTime >= sustainMs) {
        reached = true;
        break;
      }
    }
    if (reached) return start;
  }
  return null;
}

/** Value at the entry `sustainMs` after `fromIndex`, walking the run forward. */
function valueAfterSustain(
  series: LapSeries,
  run: Run,
  fromIndex: number,
  sustainMs: number,
  values: readonly (number | null)[],
): number | null {
  const startTime = series.tMonoMs[fromIndex];
  if (startTime === undefined) return null;
  let seen = false;
  for (const index of run.indices) {
    if (index === fromIndex) seen = true;
    if (!seen) continue;
    const time = series.tMonoMs[index];
    if (time === undefined) continue;
    if (time - startTime >= sustainMs) return values[index] ?? null;
  }
  return null;
}

function maxValue(values: readonly (number | null)[], run: Run): number | null {
  let best: number | null = null;
  for (const index of run.indices) {
    const value = values[index];
    if (value === null || value === undefined) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

function hasValue(values: readonly (number | null)[] | undefined, run: Run | null): boolean {
  if (values === undefined || run === null) return false;
  for (const index of run.indices) {
    if (values[index] !== null && values[index] !== undefined) return true;
  }
  return false;
}

function detectLift(
  series: LapSeries,
  run: Run,
  options: ResolvedOptions,
): { index: number; source: 'accelPedalPct' | 'throttlePct' | 'decelOnset' } | null {
  for (const channel of ['accelPedalPct', 'throttlePct'] as const) {
    const values = series.channels.get(channel);
    if (!hasValue(values, run) || values === undefined) continue;
    const peak = maxValue(values, run);
    if (peak === null) continue;
    const threshold =
      channel === 'accelPedalPct'
        ? LIFT_PEDAL_PCT
        : Math.max(LIFT_PEDAL_PCT, peak * LIFT_PLATE_FRACTION);
    // The lift is only observable when the driver was ON the throttle first.
    let seenOnThrottle = false;
    for (let position = 0; position < run.indices.length; position += 1) {
      const index = run.indices[position];
      if (index === undefined) continue;
      const value = values[index];
      if (value === null || value === undefined) continue;
      if (value > threshold) {
        seenOnThrottle = true;
        continue;
      }
      if (!seenOnThrottle) continue;
      const rest: Run = {
        indices: run.indices.slice(position),
        startOffsetM: run.startOffsetM,
        endOffsetM: run.endOffsetM,
      };
      const found = firstSustained(series, rest, options.sustainMs, (probe) => {
        const probeValue = values[probe];
        return probeValue !== null && probeValue !== undefined && probeValue <= threshold;
      });
      if (found !== null) return { index: found, source: channel };
    }
  }
  if (series.accelSource === null) return null;
  const found = firstSustained(series, run, options.sustainMs, (index) => {
    const value = series.accelG[index];
    return value !== null && value !== undefined && value <= -options.liftThresholdG;
  });
  return found === null ? null : { index: found, source: 'decelOnset' };
}

/**
 * Braking onset: the brake channel when the vehicle profile provides one, then
 * the IMU (cross-checked against `dv/ds` -- a steady longitudinal bias with no
 * speed change is a tilted phone, not a brake application), then the GPS speed
 * derivative.
 */
function detectBrake(
  series: LapSeries,
  run: Run,
  options: ResolvedOptions,
): { index: number; source: 'brakePct' | 'longG' | 'gpsSpeed' } | null {
  const brake = series.channels.get('brakePct');
  if (hasValue(brake, run) && brake !== undefined) {
    const found = firstSustained(series, run, options.sustainMs, (index) => {
      const value = brake[index];
      return value !== null && value !== undefined && value > BRAKE_ON_PCT;
    });
    if (found !== null) return { index: found, source: 'brakePct' };
  }

  const longG = series.channels.get('longG');
  if (hasValue(longG, run) && longG !== undefined) {
    const found = firstSustained(series, run, options.sustainMs, (index) => {
      const value = longG[index];
      return value !== null && value !== undefined && value <= -options.brakeThresholdG;
    });
    if (found !== null) {
      const startSpeed = series.speedKph[found] ?? null;
      const endSpeed = valueAfterSustain(series, run, found, options.sustainMs, series.speedKph);
      // A MISSING speed is not a confirmation. Without a speed at both ends of
      // the sustain window there is no dv/ds to tell a real brake application
      // from a phone lying in the cradle at an angle, so the IMU estimator
      // stands down and the speed-derivative estimator below gets its turn.
      const confirmed =
        startSpeed !== null && endSpeed !== null && endSpeed <= startSpeed - BRAKE_SPEED_DROP_KPH;
      if (confirmed) return { index: found, source: 'longG' };
    }
  }

  const speedAccelG = series.speedAccelG;
  if (speedAccelG === null) return null;
  const found = firstSustained(series, run, options.sustainMs, (index) => {
    const value = speedAccelG[index];
    return value !== null && value !== undefined && value <= -options.brakeThresholdG;
  });
  return found === null ? null : { index: found, source: 'gpsSpeed' };
}

/**
 * Throttle-on, searched only AFTER the minimum speed (`s_vmin`, design §4): a
 * driver already on the pedal at the apex while the car is still slowing has
 * not got back on the power yet. Every estimator in the chain is tried --
 * pedal, then throttle plate, then the acceleration onset -- so an available
 * but non-triggering channel does not silence the metric.
 */
function detectThrottleOn(
  series: LapSeries,
  run: Run,
  options: ResolvedOptions,
): { index: number; source: 'accelPedalPct' | 'throttlePct' | 'accelOnset' } | null {
  for (const channel of ['accelPedalPct', 'throttlePct'] as const) {
    const values = series.channels.get(channel);
    if (!hasValue(values, run) || values === undefined) continue;
    const found = firstSustained(series, run, options.sustainMs, (index) => {
      const value = values[index];
      return value !== null && value !== undefined && value > THROTTLE_ON_PCT;
    });
    if (found !== null) return { index: found, source: channel };
  }
  if (series.accelSource === null) return null;
  const found = firstSustained(series, run, options.sustainMs, (index) => {
    const value = series.accelG[index];
    return value !== null && value !== undefined && value >= THROTTLE_ON_G;
  });
  return found === null ? null : { index: found, source: 'accelOnset' };
}

function detectTurnIn(
  series: LapSeries,
  run: Run,
  options: ResolvedOptions,
): { index: number; source: 'steeringDeg' | 'yawRateDps' } | null {
  const candidates = [
    { channel: 'steeringDeg' as const, threshold: TURN_IN_STEERING_DEG },
    { channel: 'yawRateDps' as const, threshold: TURN_IN_YAW_DPS },
  ];
  for (const candidate of candidates) {
    const values = series.channels.get(candidate.channel);
    if (!hasValue(values, run) || values === undefined) continue;
    const found = firstSustained(series, run, options.sustainMs, (index) => {
      const value = values[index];
      return value !== null && value !== undefined && Math.abs(value) > candidate.threshold;
    });
    if (found !== null) return { index: found, source: candidate.channel };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The metric computation
// ---------------------------------------------------------------------------

function emptyMetrics(cornerId: number, flags: CornerQualityFlag[]): CornerMetrics {
  return {
    cornerId,
    analysisVersion: CORNER_ANALYSIS_VERSION,
    liftPointM: null,
    liftSource: null,
    brakeStartM: null,
    brakeSource: null,
    peakDecelG: null,
    minSpeedKph: null,
    minSpeedPositionM: null,
    minSpeedVsApexM: null,
    entrySpeedKph: null,
    exitSpeedKph: null,
    maxLatG: null,
    maxLatGSource: null,
    sectorMs: null,
    sampleCount: 0,
    quality: { ok: flags.length === 0, flags, worstAccuracyM: null, maxSampleGapMs: null },
    throttleOnM: null,
    throttleOnSource: null,
    fullThrottleFraction: null,
    frictionCircleMaxG: null,
    turnInM: null,
    turnInSource: null,
    steeringSmoothness: null,
    steeringCorrections: null,
  };
}

function assertCorner(corner: Corner): void {
  for (const key of ['entryDistanceM', 'apexDistanceM', 'exitDistanceM'] as const) {
    if (!Number.isFinite(corner[key])) {
      throw new RangeError(`corner ${corner.id}: ${key} must be a finite number of metres`);
    }
  }
}

function cornerSpeedMps(corner: Corner): number {
  const value = corner.advisorySpeedKph / 3.6;
  return Number.isFinite(value) && value > 0 ? value : WINDOW_TOP_SPEED_MPS / 2;
}

/** Smallest forward distance from another corner's exit to this corner's entry. */
function gapBeforeM(corner: Corner, corners: readonly Corner[], totalLengthM: number): number {
  let gapM = totalLengthM;
  for (const other of corners) {
    if (other.id === corner.id) continue;
    const gap = forwardDistance(other.exitDistanceM, corner.entryDistanceM, totalLengthM);
    if (gap > 0 && gap < gapM) gapM = gap;
  }
  return gapM;
}

/** Smallest forward distance from this corner's exit to another corner's entry. */
function gapAfterM(corner: Corner, corners: readonly Corner[], totalLengthM: number): number {
  let gapM = totalLengthM;
  for (const other of corners) {
    if (other.id === corner.id) continue;
    const gap = forwardDistance(corner.exitDistanceM, other.entryDistanceM, totalLengthM);
    if (gap > 0 && gap < gapM) gapM = gap;
  }
  return gapM;
}

function previousCornerOf(
  corner: Corner,
  corners: readonly Corner[],
  totalLengthM: number,
): Corner | null {
  let best: Corner | null = null;
  let bestGap = totalLengthM;
  for (const other of corners) {
    if (other.id === corner.id) continue;
    const gap = forwardDistance(other.exitDistanceM, corner.entryDistanceM, totalLengthM);
    if (gap > 0 && gap < bestGap) {
      bestGap = gap;
      best = other;
    }
  }
  return best;
}

/** Speed the car can reach on the run-up to this corner, m/s. */
function approachSpeedMps(
  corner: Corner,
  corners: readonly Corner[],
  totalLengthM: number,
): number {
  const previous = previousCornerOf(corner, corners, totalLengthM);
  const from = previous === null ? WINDOW_TOP_SPEED_MPS : cornerSpeedMps(previous);
  const gapM = gapBeforeM(corner, corners, totalLengthM);
  return Math.min(
    WINDOW_TOP_SPEED_MPS,
    Math.sqrt(from * from + 2 * WINDOW_ACCEL_MPS2 * Math.max(0, gapM)),
  );
}

/**
 * `L_b` -- the braking-zone length before the corner entry, DERIVED from the
 * corner's speed drop (`analysis-engine.md` §2.4): the distance needed to shed
 * the speed the run-up allows down to the corner's own speed, plus a margin,
 * bounded and clipped so it can never reach back into the previous corner. A
 * 250 km/h -> 80 km/h braking zone is hundreds of metres long and stays
 * observable; a kink that costs no speed gets a short window instead of
 * swallowing 300 m of straight.
 */
function approachLengthM(
  corner: Corner,
  corners: readonly Corner[],
  options: ResolvedOptions,
): number {
  const gapM = corners.length < 2 ? options.totalLengthM : gapBeforeM(corner, corners, options.totalLengthM);
  if (options.approachWindowM !== null) {
    return Math.max(COVERAGE_TOLERANCE_M, Math.min(options.approachWindowM, gapM));
  }
  const vCorner = cornerSpeedMps(corner);
  const vApproach = approachSpeedMps(corner, corners, options.totalLengthM);
  const brakingM = Math.max(
    0,
    (vApproach * vApproach - vCorner * vCorner) / (2 * WINDOW_BRAKE_MPS2),
  );
  const derived = brakingM * WINDOW_BRAKE_MARGIN + WINDOW_LEAD_M;
  const bounded = Math.min(MAX_APPROACH_M, Math.max(MIN_APPROACH_M, derived));
  return Math.max(COVERAGE_TOLERANCE_M, Math.min(bounded, gapM));
}

/**
 * `L_e` -- the exit-zone length after the corner exit, derived from the same
 * speed drop: the distance needed to accelerate back to the speed the corner
 * cost, bounded and clipped by the next corner.
 */
function exitLengthM(
  corner: Corner,
  corners: readonly Corner[],
  options: ResolvedOptions,
): number {
  const gapM = corners.length < 2 ? options.totalLengthM : gapAfterM(corner, corners, options.totalLengthM);
  if (options.exitWindowM !== null) {
    return Math.max(COVERAGE_TOLERANCE_M, Math.min(options.exitWindowM, gapM));
  }
  const vCorner = cornerSpeedMps(corner);
  const vTarget = Math.min(
    approachSpeedMps(corner, corners, options.totalLengthM),
    Math.min(
      WINDOW_TOP_SPEED_MPS,
      Math.sqrt(vCorner * vCorner + 2 * WINDOW_ACCEL_MPS2 * Math.max(0, gapM)),
    ),
  );
  const risingM = Math.max(0, (vTarget * vTarget - vCorner * vCorner) / (2 * WINDOW_ACCEL_MPS2));
  const bounded = Math.min(MAX_EXIT_M, Math.max(MIN_EXIT_M, risingM));
  return Math.max(COVERAGE_TOLERANCE_M, Math.min(bounded, gapM));
}

export interface CornerWindows {
  /** Start of the braking zone (corner entry minus the derived approach), metres from S/F. */
  approachStartM: number;
  entryM: number;
  apexM: number;
  exitM: number;
  /** End of the exit zone, metres from S/F. */
  exitEndM: number;
}

/**
 * The distance windows one corner is analysed over. Exported so the session
 * layer measures its delta-curve contribution across exactly the same span the
 * per-corner metrics were measured over.
 */
export function cornerWindows(
  corner: Corner,
  corners: readonly Corner[],
  options: CornerMetricsOptions,
): CornerWindows {
  const resolved = resolveOptions(options);
  assertCorner(corner);
  const ordered = [...corners].sort((a, b) => a.id - b.id);
  const entryM = normalizeDistance(corner.entryDistanceM, resolved.totalLengthM);
  return {
    approachStartM: normalizeDistance(
      entryM - approachLengthM(corner, ordered, resolved),
      resolved.totalLengthM,
    ),
    entryM,
    apexM: normalizeDistance(corner.apexDistanceM, resolved.totalLengthM),
    exitM: normalizeDistance(corner.exitDistanceM, resolved.totalLengthM),
    exitEndM: normalizeDistance(
      corner.exitDistanceM + exitLengthM(corner, ordered, resolved),
      resolved.totalLengthM,
    ),
  };
}

/** Elapsed time over a run: the sum of its real intervals, joins excluded. */
function runDurationMs(series: LapSeries, run: Run): number | null {
  let total = 0;
  let counted = false;
  for (let position = 1; position < run.indices.length; position += 1) {
    const index = run.indices[position];
    const previous = run.indices[position - 1];
    if (index === undefined || previous === undefined) continue;
    if (index !== previous + 1) continue; // the start/finish join, not an interval
    const current = series.tMonoMs[index];
    const before = series.tMonoMs[previous];
    if (current === undefined || before === undefined) continue;
    total += current - before;
    counted = true;
  }
  return counted ? total : null;
}

/**
 * Computes the per-corner metrics of ONE lap. Corners are returned ordered by
 * `Corner.id`, one entry per corner, always -- a corner the lap never sampled
 * comes back all-`null` with `NO_CORNER_COVERAGE`, never missing.
 */
export function computeCornerMetrics(
  samples: readonly CornerLapSample[],
  corners: readonly Corner[],
  options: CornerMetricsOptions,
): CornerMetrics[] {
  const resolved = resolveOptions(options);
  for (const corner of corners) assertCorner(corner);
  const raw = buildRawSeries(samples, resolved);
  const series = buildGridSeries(raw, resolved);
  const ordered = [...corners].sort((a, b) => a.id - b.id);
  const totalLengthM = resolved.totalLengthM;

  return ordered.map((corner) => {
    const entryM = normalizeDistance(corner.entryDistanceM, totalLengthM);
    const apexM = normalizeDistance(corner.apexDistanceM, totalLengthM);
    const exitM = normalizeDistance(corner.exitDistanceM, totalLengthM);
    const approachM = approachLengthM(corner, ordered, resolved);
    const approachStartM = normalizeDistance(entryM - approachM, totalLengthM);
    const exitEndM = normalizeDistance(exitM + exitLengthM(corner, ordered, resolved), totalLengthM);

    const approach = buildWindow(series, approachStartM, entryM, totalLengthM);
    const cornerWindow = buildWindow(series, entryM, exitM, totalLengthM);
    const brakingZone = buildWindow(series, approachStartM, apexM, totalLengthM);
    const exitZone = buildWindow(series, apexM, exitEndM, totalLengthM);
    const analysisWindow = buildWindow(raw, approachStartM, exitM, totalLengthM);

    const flags: CornerQualityFlag[] = [
      ...coverageFlags(approach, 'APPROACH_TRUNCATED', 'NO_APPROACH_COVERAGE'),
      ...coverageFlags(cornerWindow, 'CORNER_TRUNCATED', 'NO_CORNER_COVERAGE'),
    ];

    // Quality is a fact about the RECORDING, so it is measured over the real
    // samples, never over interpolated grid points. Gaps count inside a run and
    // between two runs that CONTINUE each other (a real hole in the data); a run
    // that rewinds to distance already covered is a second pass through the
    // window -- a lead-in from the previous lap, or a corner that spans the
    // start/finish line -- and its jump is not a gap.
    let worstAccuracyM: number | null = null;
    let poorCount = 0;
    let accuracyCount = 0;
    let maxSampleGapMs: number | null = null;
    let previousRun: Run | null = null;
    for (const run of analysisWindow.runs) {
      for (let position = 0; position < run.indices.length; position += 1) {
        const index = run.indices[position];
        if (index === undefined) continue;
        const accuracy = raw.accuracyM[index];
        if (accuracy !== null && accuracy !== undefined) {
          accuracyCount += 1;
          if (worstAccuracyM === null || accuracy > worstAccuracyM) worstAccuracyM = accuracy;
          if (accuracy > resolved.poorAccuracyM) poorCount += 1;
        }
        if (position === 0) continue;
        const current = raw.tMonoMs[index];
        const previous = raw.tMonoMs[index - 1];
        if (current === undefined || previous === undefined) continue;
        const gap = current - previous;
        if (maxSampleGapMs === null || gap > maxSampleGapMs) maxSampleGapMs = gap;
      }
      if (previousRun !== null && run.startOffsetM > previousRun.endOffsetM) {
        const current = raw.tMonoMs[run.indices[0] ?? 0];
        const previous = raw.tMonoMs[previousRun.indices[previousRun.indices.length - 1] ?? 0];
        if (current !== undefined && previous !== undefined) {
          const gap = current - previous;
          if (maxSampleGapMs === null || gap > maxSampleGapMs) maxSampleGapMs = gap;
        }
      }
      previousRun = run;
    }
    if (accuracyCount > 0 && poorCount / accuracyCount > POOR_ACCURACY_FRACTION) {
      flags.push('GNSS_ACCURACY_POOR');
    }
    if (maxSampleGapMs !== null && maxSampleGapMs > resolved.sampleGapMs) flags.push('SAMPLE_GAP');

    const base = emptyMetrics(corner.id, flags);
    base.quality.worstAccuracyM = worstAccuracyM;
    base.quality.maxSampleGapMs = maxSampleGapMs;

    // --- approach / braking zone -------------------------------------------
    if (brakingZone.run !== null) {
      const lift = detectLift(series, brakingZone.run, resolved);
      if (lift !== null) {
        const distance = series.distanceM[lift.index];
        if (distance !== undefined) {
          base.liftPointM = forwardDistance(distance, entryM, totalLengthM);
          base.liftSource = lift.source;
        }
      }
      const brake = detectBrake(series, brakingZone.run, resolved);
      if (brake !== null) {
        const distance = series.distanceM[brake.index];
        if (distance !== undefined) {
          base.brakeStartM = forwardDistance(distance, entryM, totalLengthM);
          base.brakeSource = brake.source;
        }
      }
      let peak: number | null = null;
      for (const index of brakingZone.run.indices) {
        const value = series.accelG[index];
        if (value === null || value === undefined || value >= 0) continue;
        if (peak === null || -value > peak) peak = -value;
      }
      base.peakDecelG = peak;
      const turnIn = detectTurnIn(series, brakingZone.run, resolved);
      if (turnIn !== null) {
        const distance = series.distanceM[turnIn.index];
        if (distance !== undefined) {
          const before = forwardDistance(distance, entryM, totalLengthM);
          base.turnInM = before > totalLengthM / 2 ? before - totalLengthM : before;
          base.turnInSource = turnIn.source;
        }
      }
    }

    // --- in-corner ----------------------------------------------------------
    const run = cornerWindow.run;
    let minSpeedDistanceM: number | null = null;
    if (run !== null) {
      const rawCorner = buildWindow(raw, entryM, exitM, totalLengthM);
      base.sampleCount = rawCorner.run?.indices.length ?? 0;
      base.sectorMs = runDurationMs(series, run);
      const firstIndex = run.indices[0];
      const lastIndex = run.indices[run.indices.length - 1];
      base.entrySpeedKph = firstIndex === undefined ? null : (series.speedKph[firstIndex] ?? null);
      base.exitSpeedKph = lastIndex === undefined ? null : (series.speedKph[lastIndex] ?? null);

      let minSpeed: number | null = null;
      let minSpeedIndex: number | null = null;
      let maxLatG: number | null = null;
      let frictionMax: number | null = null;
      const latGSeries = series.channels.get('latG');
      const longGSeries = series.channels.get('longG');
      for (const index of run.indices) {
        const speed = series.speedKph[index];
        if (speed !== null && speed !== undefined && (minSpeed === null || speed < minSpeed)) {
          minSpeed = speed;
          minSpeedIndex = index;
        }
        const latG = latGSeries?.[index] ?? null;
        if (latG !== null) {
          const magnitude = Math.abs(latG);
          if (maxLatG === null || magnitude > maxLatG) maxLatG = magnitude;
          const longG = longGSeries?.[index] ?? null;
          if (longG !== null) {
            const combined = Math.hypot(latG, longG);
            if (frictionMax === null || combined > frictionMax) frictionMax = combined;
          }
        }
      }
      base.minSpeedKph = minSpeed;
      base.maxLatG = maxLatG;
      base.maxLatGSource = maxLatG === null ? null : 'imu';
      base.frictionCircleMaxG = frictionMax;
      if (minSpeedIndex !== null) {
        const distance = series.distanceM[minSpeedIndex];
        if (distance !== undefined) {
          minSpeedDistanceM = distance;
          base.minSpeedPositionM = distance;
          const fromApex = forwardDistance(apexM, distance, totalLengthM);
          base.minSpeedVsApexM = fromApex > totalLengthM / 2 ? fromApex - totalLengthM : fromApex;
        }
      }

      const steering = series.channels.get('steeringDeg');
      if (hasValue(steering, run) && steering !== undefined) {
        let sumSquares = 0;
        let samplesCounted = 0;
        let corrections = 0;
        let previousSign = 0;
        for (let position = 0; position + 1 < run.indices.length; position += 1) {
          const index = run.indices[position];
          const nextIndex = run.indices[position + 1];
          if (index === undefined || nextIndex === undefined) continue;
          // The two halves of a corner that wraps the start/finish line are
          // joined into one run, but the join is VIRTUAL: the entries either
          // side of it are a lap apart. A steering derivative -- and a
          // correction -- may only be measured inside a contiguous run, so the
          // seam is skipped and the correction chain restarts after it.
          if (nextIndex !== index + 1) {
            previousSign = 0;
            continue;
          }
          const current = steering[index];
          const next = steering[nextIndex];
          const dCurrent = series.distanceM[index];
          const dNext = series.distanceM[nextIndex];
          if (current === null || next === null || current === undefined || next === undefined) continue;
          if (dCurrent === undefined || dNext === undefined) continue;
          const stepM = forwardDistance(dCurrent, dNext, totalLengthM);
          if (!(stepM > 0) || stepM > totalLengthM / 2) continue;
          const rate = (next - current) / stepM;
          sumSquares += rate * rate;
          samplesCounted += 1;
          const delta = next - current;
          if (Math.abs(delta) > STEERING_DEADBAND_DEG) {
            const sign = delta > 0 ? 1 : -1;
            if (previousSign !== 0 && sign !== previousSign) corrections += 1;
            previousSign = sign;
          }
        }
        if (samplesCounted > 0) {
          base.steeringSmoothness = Math.sqrt(sumSquares / samplesCounted);
          base.steeringCorrections = corrections;
        }
      }
    }

    // --- exit zone ----------------------------------------------------------
    if (exitZone.run !== null) {
      // Throttle-on is only meaningful after the minimum speed. A minimum speed
      // that sits BEFORE the exit zone starts (the apex) restricts nothing:
      // the whole exit zone is already "after s_vmin".
      const vminOffsetM =
        minSpeedDistanceM === null
          ? 0
          : forwardDistance(exitZone.startM, minSpeedDistanceM, totalLengthM);
      const offsetM = vminOffsetM > totalLengthM / 2 ? 0 : vminOffsetM;
      const afterVmin =
        offsetM <= 0
          ? exitZone.run
          : runFromOffset(exitZone.run, series, exitZone.startM, offsetM, totalLengthM);
      if (afterVmin !== null) {
        const throttleOn = detectThrottleOn(series, afterVmin, resolved);
        if (throttleOn !== null) {
          const distance = series.distanceM[throttleOn.index];
          if (distance !== undefined) {
            const fromApex = forwardDistance(apexM, distance, totalLengthM);
            base.throttleOnM = fromApex > totalLengthM / 2 ? fromApex - totalLengthM : fromApex;
            base.throttleOnSource = throttleOn.source;
          }
        }
      }
      const pedal = (['accelPedalPct', 'throttlePct'] as const).find((channel) =>
        hasValue(series.channels.get(channel), exitZone.run),
      );
      if (pedal !== undefined) {
        const values = series.channels.get(pedal) ?? [];
        let fullM = 0;
        let totalM = 0;
        for (let position = 0; position + 1 < exitZone.run.indices.length; position += 1) {
          const index = exitZone.run.indices[position];
          const nextIndex = exitZone.run.indices[position + 1];
          if (index === undefined || nextIndex === undefined) continue;
          // The join between the two halves of a wrapping exit zone is virtual:
          // it is not a metre of track, so it is neither driven distance nor
          // full-throttle distance. Each contiguous run is accumulated on its own.
          if (nextIndex !== index + 1) continue;
          const dCurrent = series.distanceM[index];
          const dNext = series.distanceM[nextIndex];
          if (dCurrent === undefined || dNext === undefined) continue;
          const stepM = forwardDistance(dCurrent, dNext, totalLengthM);
          if (!(stepM > 0) || stepM > totalLengthM / 2) continue;
          totalM += stepM;
          const value = values[index];
          if (value !== null && value !== undefined && value >= FULL_THROTTLE_PCT) fullM += stepM;
        }
        if (totalM > 0) base.fullThrottleFraction = fullM / totalM;
      }
    }

    base.quality.ok = base.quality.flags.length === 0;
    return base;
  });
}
