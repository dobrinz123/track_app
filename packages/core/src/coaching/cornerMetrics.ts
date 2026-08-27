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
  /** Braking-zone length before the corner entry, metres. Default 300. */
  approachWindowM?: number;
  /** Exit-zone length after the corner exit, metres. Default 150. */
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
}

interface ResolvedOptions extends Required<Omit<CornerMetricsOptions, 'unsupportedChannels'>> {
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

function resolveOptions(options: CornerMetricsOptions): ResolvedOptions {
  if (!Number.isFinite(options.totalLengthM) || options.totalLengthM <= 0) {
    throw new RangeError('totalLengthM must be a positive, finite number of metres');
  }
  const resolved: ResolvedOptions = {
    totalLengthM: options.totalLengthM,
    approachWindowM: options.approachWindowM ?? 300,
    exitWindowM: options.exitWindowM ?? 150,
    brakeThresholdG: options.brakeThresholdG ?? 0.15,
    liftThresholdG: options.liftThresholdG ?? 0.05,
    sustainMs: options.sustainMs ?? 300,
    poorAccuracyM: options.poorAccuracyM ?? 25,
    sampleGapMs: options.sampleGapMs ?? 2_000,
    unsupported: new Set(options.unsupportedChannels ?? []),
  };
  for (const [key, value] of Object.entries(resolved)) {
    if (key === 'unsupported') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${key} must be a positive, finite number`);
    }
  }
  return resolved;
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
  tMonoMs: number[];
  accuracyM: (number | null)[];
  speedKph: (number | null)[];
  /** Forward longitudinal acceleration in g (negative = deceleration). */
  accelG: (number | null)[];
  accelSource: 'longG' | 'gpsSpeed' | null;
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

function buildSeries(samples: readonly CornerLapSample[], options: ResolvedOptions): LapSeries {
  const distanceM: number[] = [];
  const tMonoMs: number[] = [];
  const accuracyM: (number | null)[] = [];
  const speedKph: (number | null)[] = [];
  const channels = new Map<CoachingChannelId, (number | null)[]>();
  for (const channel of ANALYSIS_CHANNELS) channels.set(channel, []);

  for (const sample of samples) {
    if (!Number.isFinite(sample.distanceM) || !Number.isFinite(sample.tMonoMs)) {
      throw new RangeError('every sample needs a finite tMonoMs and distanceM');
    }
    distanceM.push(normalizeDistance(sample.distanceM, options.totalLengthM));
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
  for (let index = 0; index < speedKph.length; index += 1) {
    if (speedKph[index] !== null) continue;
    const dCurrent = distanceM[index];
    const dNext = distanceM[index + 1];
    const tCurrent = tMonoMs[index];
    const tNext = tMonoMs[index + 1];
    if (dCurrent === undefined || dNext === undefined || tCurrent === undefined || tNext === undefined) {
      continue;
    }
    const dtSeconds = (tNext - tCurrent) / 1_000;
    if (!(dtSeconds > 0)) continue;
    const stepM = forwardDistance(dCurrent, dNext, options.totalLengthM);
    if (stepM > options.totalLengthM / 2) continue;
    speedKph[index] = (stepM / dtSeconds) * 3.6;
  }

  const longG = channels.get('longG') ?? [];
  const hasLongG = longG.some((value) => value !== null);
  const accelG: (number | null)[] = new Array<number | null>(distanceM.length).fill(null);
  let accelSource: LapSeries['accelSource'] = null;
  if (hasLongG) {
    accelSource = 'longG';
    for (let index = 0; index < accelG.length; index += 1) accelG[index] = longG[index] ?? null;
  } else if (speedKph.some((value) => value !== null)) {
    accelSource = 'gpsSpeed';
    for (let index = 0; index + 1 < accelG.length; index += 1) {
      const vCurrent = speedKph[index];
      const vNext = speedKph[index + 1];
      const tCurrent = tMonoMs[index];
      const tNext = tMonoMs[index + 1];
      if (vCurrent === null || vNext === null || vCurrent === undefined || vNext === undefined) continue;
      if (tCurrent === undefined || tNext === undefined) continue;
      const dtSeconds = (tNext - tCurrent) / 1_000;
      if (!(dtSeconds > 0)) continue;
      accelG[index] = (vNext - vCurrent) / 3.6 / dtSeconds / GRAVITY_MPS2;
    }
  }

  return { distanceM, tMonoMs, accuracyM, speedKph, accelG, accelSource, channels };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

interface Run {
  start: number;
  end: number;
  /** Distance from the window start to this run's first sample, metres. */
  startOffsetM: number;
  /** Distance from the window start to this run's last sample, metres. */
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
        current = { start: index, end: index, startOffsetM: offset, endOffsetM: offset };
      } else {
        current.end = index;
        current.endOffsetM = offset;
      }
    } else if (current !== null) {
      runs.push(current);
      current = null;
    }
  }
  if (current !== null) runs.push(current);
  let chosen: Run | null = null;
  for (const run of runs) {
    const span = run.endOffsetM - run.startOffsetM;
    if (chosen === null || span >= chosen.endOffsetM - chosen.startOffsetM) chosen = run;
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

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * First index in `[run.start, run.end]` from which `predicate` holds
 * continuously for at least `sustainMs` (or, at the very end of the run, for
 * every remaining sample -- at least two of them).
 */
function firstSustained(
  series: LapSeries,
  run: Pick<Run, 'start' | 'end'>,
  sustainMs: number,
  predicate: (index: number) => boolean,
): number | null {
  for (let index = run.start; index <= run.end; index += 1) {
    if (!predicate(index)) continue;
    const startTime = series.tMonoMs[index];
    if (startTime === undefined) continue;
    let held = true;
    let reached = false;
    let count = 1;
    for (let probe = index + 1; probe <= run.end; probe += 1) {
      if (!predicate(probe)) {
        held = false;
        break;
      }
      count += 1;
      const time = series.tMonoMs[probe];
      if (time !== undefined && time - startTime >= sustainMs) {
        reached = true;
        break;
      }
    }
    if (held && (reached || count >= 2)) return index;
  }
  return null;
}

function maxValue(values: readonly (number | null)[], run: Run): number | null {
  let best: number | null = null;
  for (let index = run.start; index <= run.end; index += 1) {
    const value = values[index];
    if (value === null || value === undefined) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

function hasValue(values: readonly (number | null)[] | undefined, run: Run | null): boolean {
  if (values === undefined || run === null) return false;
  for (let index = run.start; index <= run.end; index += 1) {
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
    for (let index = run.start; index <= run.end; index += 1) {
      const value = values[index];
      if (value === null || value === undefined) continue;
      if (value > threshold) {
        seenOnThrottle = true;
        continue;
      }
      if (!seenOnThrottle) continue;
      const found = firstSustained(series, { start: index, end: run.end }, options.sustainMs, (probe) => {
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
  if (series.accelSource === null) return null;
  const found = firstSustained(series, run, options.sustainMs, (index) => {
    const value = series.accelG[index];
    return value !== null && value !== undefined && value <= -options.brakeThresholdG;
  });
  if (found === null) return null;
  return { index: found, source: series.accelSource };
}

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
    return null;
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

/** Length of the approach window, clipped so it cannot reach back into the previous corner. */
function approachLengthM(
  corner: Corner,
  corners: readonly Corner[],
  options: ResolvedOptions,
): number {
  if (corners.length < 2) return options.approachWindowM;
  let gapM = options.totalLengthM;
  for (const other of corners) {
    if (other.id === corner.id) continue;
    const gap = forwardDistance(other.exitDistanceM, corner.entryDistanceM, options.totalLengthM);
    if (gap > 0 && gap < gapM) gapM = gap;
  }
  return Math.max(COVERAGE_TOLERANCE_M, Math.min(options.approachWindowM, gapM));
}

export interface CornerWindows {
  /** Start of the braking zone (corner entry minus the clipped approach), metres from S/F. */
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
    exitEndM: normalizeDistance(corner.exitDistanceM + resolved.exitWindowM, resolved.totalLengthM),
  };
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
  const series = buildSeries(samples, resolved);
  const ordered = [...corners].sort((a, b) => a.id - b.id);
  const totalLengthM = resolved.totalLengthM;

  return ordered.map((corner) => {
    const entryM = normalizeDistance(corner.entryDistanceM, totalLengthM);
    const apexM = normalizeDistance(corner.apexDistanceM, totalLengthM);
    const exitM = normalizeDistance(corner.exitDistanceM, totalLengthM);
    const approachM = approachLengthM(corner, ordered, resolved);
    const approachStartM = normalizeDistance(entryM - approachM, totalLengthM);

    const approach = buildWindow(series, approachStartM, entryM, totalLengthM);
    const cornerWindow = buildWindow(series, entryM, exitM, totalLengthM);
    const brakingZone = buildWindow(series, approachStartM, apexM, totalLengthM);
    const exitZone = buildWindow(
      series,
      apexM,
      normalizeDistance(exitM + resolved.exitWindowM, totalLengthM),
      totalLengthM,
    );
    const analysisWindow = buildWindow(series, approachStartM, exitM, totalLengthM);

    const flags: CornerQualityFlag[] = [
      ...coverageFlags(approach, 'APPROACH_TRUNCATED', 'NO_APPROACH_COVERAGE'),
      ...coverageFlags(cornerWindow, 'CORNER_TRUNCATED', 'NO_CORNER_COVERAGE'),
    ];

    // Quality is measured over every in-window sample. Gaps count inside a run
    // and between two runs that CONTINUE each other (a real hole in the data);
    // a run that rewinds to distance already covered is a second pass through
    // the window -- a lead-in from the previous lap, or a corner that spans the
    // start/finish line -- and its jump is not a gap.
    let worstAccuracyM: number | null = null;
    let poorCount = 0;
    let accuracyCount = 0;
    let maxSampleGapMs: number | null = null;
    let previousRun: Run | null = null;
    for (const run of analysisWindow.runs) {
      for (let index = run.start; index <= run.end; index += 1) {
        const accuracy = series.accuracyM[index];
        if (accuracy !== null && accuracy !== undefined) {
          accuracyCount += 1;
          if (worstAccuracyM === null || accuracy > worstAccuracyM) worstAccuracyM = accuracy;
          if (accuracy > resolved.poorAccuracyM) poorCount += 1;
        }
        if (index === run.start) continue;
        const current = series.tMonoMs[index];
        const previous = series.tMonoMs[index - 1];
        if (current === undefined || previous === undefined) continue;
        const gap = current - previous;
        if (maxSampleGapMs === null || gap > maxSampleGapMs) maxSampleGapMs = gap;
      }
      if (previousRun !== null && run.startOffsetM > previousRun.endOffsetM) {
        const current = series.tMonoMs[run.start];
        const previous = series.tMonoMs[previousRun.end];
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
      for (let index = brakingZone.run.start; index <= brakingZone.run.end; index += 1) {
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
    if (run !== null) {
      base.sampleCount = run.end - run.start + 1;
      const firstTime = series.tMonoMs[run.start];
      const lastTime = series.tMonoMs[run.end];
      if (firstTime !== undefined && lastTime !== undefined) base.sectorMs = lastTime - firstTime;
      base.entrySpeedKph = series.speedKph[run.start] ?? null;
      base.exitSpeedKph = series.speedKph[run.end] ?? null;

      let minSpeed: number | null = null;
      let minSpeedIndex: number | null = null;
      let maxLatG: number | null = null;
      let frictionMax: number | null = null;
      for (let index = run.start; index <= run.end; index += 1) {
        const speed = series.speedKph[index];
        if (speed !== null && speed !== undefined && (minSpeed === null || speed < minSpeed)) {
          minSpeed = speed;
          minSpeedIndex = index;
        }
        const latG = series.channels.get('latG')?.[index] ?? null;
        if (latG !== null) {
          const magnitude = Math.abs(latG);
          if (maxLatG === null || magnitude > maxLatG) maxLatG = magnitude;
          const longG = series.channels.get('longG')?.[index] ?? null;
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
        for (let index = run.start; index < run.end; index += 1) {
          const current = steering[index];
          const next = steering[index + 1];
          const dCurrent = series.distanceM[index];
          const dNext = series.distanceM[index + 1];
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
      const throttleOn = detectThrottleOn(series, exitZone.run, resolved);
      if (throttleOn !== null) {
        const distance = series.distanceM[throttleOn.index];
        if (distance !== undefined) {
          const fromApex = forwardDistance(apexM, distance, totalLengthM);
          base.throttleOnM = fromApex > totalLengthM / 2 ? fromApex - totalLengthM : fromApex;
          base.throttleOnSource = throttleOn.source;
        }
      }
      const pedal = ['accelPedalPct', 'throttlePct'].find((channel) =>
        hasValue(series.channels.get(channel as CoachingChannelId), exitZone.run),
      ) as CoachingChannelId | undefined;
      if (pedal !== undefined) {
        const values = series.channels.get(pedal) ?? [];
        let fullM = 0;
        let totalM = 0;
        for (let index = exitZone.run.start; index < exitZone.run.end; index += 1) {
          const dCurrent = series.distanceM[index];
          const dNext = series.distanceM[index + 1];
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
