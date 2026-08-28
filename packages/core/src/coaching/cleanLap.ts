import { assertPositiveLength, forwardDistance, normalizeDistance } from './distanceDomain';
import {
  GRAVITY_MPS2,
  type ClassifiableLap,
  type CornerLapSample,
  type LapAnomalyReason,
  type LapCheckId,
  type LapClassification,
  type LapStatus,
} from './types';

/**
 * Clean-lap classification -- `docs/architecture/analysis-engine.md` §3.
 *
 * A lap is CLEAN unless it is incomplete, went off track, shows a yaw or
 * deceleration spike, or its GNSS quality is too poor to trust. Only clean laps
 * feed the reference lap and the demonstrated envelope (Phase 5 safety contract
 * rule 2); anomalous laps are still reported as facts, with their reason.
 *
 * Every check states whether it could run at all: a lap whose samples carry no
 * lateral offset cannot be tested for off-track, and the report says so instead
 * of pretending the lap was clean on that axis.
 */

export interface ClassifyLapOptions {
  totalLengthM: number;
  /** |lateral| beyond this is off track, metres. Default 15. */
  corridorHalfWidthM?: number;
  /** GNSS accuracy above this is poor, metres. Default 25. */
  poorAccuracyM?: number;
  /** Fraction of the lap allowed to exceed `poorAccuracyM`. Default 0.05. */
  poorAccuracyFraction?: number;
  /** Sample gap above this makes the lap anomalous, ms. Default 1500. */
  maxSampleGapMs?: number;
  /** |longitudinal g| above this is an implausible spike. Default 1.2. */
  decelSpikeG?: number;
  /**
   * How far the measured yaw rate may exceed the yaw the track's own curvature
   * implies before it counts as a spike, degrees/second. Default 150.
   */
  yawSpikeDps?: number;
  /**
   * A yaw excess only counts as a spike when the lateral acceleration it
   * implies (`excess * speed`) is beyond what any car can hold, in g.
   * Default 2. Course-over-ground noise at crawling speed fails this test.
   */
  yawSpikeLatG?: number;
  /**
   * How long the yaw excess must hold to count as a spike, milliseconds.
   * Default 200. Measured as a DURATION, so the rule does not change with the
   * sample rate.
   */
  yawSpikeMs?: number;
  /** Fraction of the lap distance that must be covered by samples. Default 0.9. */
  minCoverageFraction?: number;
  /**
   * Fraction of the LAP DISTANCE a check's own evidence must span before the
   * check counts as available. Default 0.9: a lateral offset recorded only for
   * the first 100 m of a 1000 m lap proves nothing about the other 900.
   */
  minCheckCoverageFraction?: number;
  /**
   * Largest distance between two consecutive readings of a channel that still
   * counts as continuous evidence, metres. Default 60 (the analysis grid's own
   * bridging distance: 1.5 s at 150 km/h).
   */
  checkBridgeM?: number;
}

/** Fixed reporting/priority order: the first reason present becomes `reason`. */
const REASON_PRIORITY: readonly LapAnomalyReason[] = Object.freeze([
  'incomplete',
  'offTrack',
  'yawSpike',
  'decelSpike',
  'gnssPoor',
]);

/** Number of coverage buckets the lap distance is split into. */
const COVERAGE_BUCKETS = 100;

/**
 * Checks the Phase 5 safety contract (rule 2) requires before a lap may be
 * called CLEAN: "on-track, no yaw/decel anomaly, valid GNSS quality", plus the
 * coverage that proves the lap was actually driven. A lap that passes every
 * check it COULD run but could not run one of these is `unverified`.
 */
const REQUIRED_CHECKS: readonly LapCheckId[] = Object.freeze([
  'offTrack',
  'yawSpike',
  'decelSpike',
  'gnssPoor',
  'coverage',
] as const);

function wrappedHeadingDelta(from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta <= -180) delta += 360;
  return delta;
}

function formatMetres(value: number): string {
  return `${Math.round(value)} m`;
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

/**
 * How far the implied-yaw window may be widened to absorb the projection lag
 * between the car's own heading and the centreline vertex it is crossing.
 * Expressed in METRES and MILLISECONDS, never in samples: the projection
 * uncertainty is a few metres of track whatever the GNSS rate is, and a sample
 * tolerance would silently become 16 m at 5 Hz and 40 m/s -- wide enough to
 * borrow a 35 degree OSM vertex from the next straight and explain away a spin.
 */
const YAW_IMPLIED_TOLERANCE_M = 8;
const YAW_IMPLIED_TOLERANCE_MS = 400;
/**
 * Longest median sample interval the yaw rule can still say anything with. At
 * 1 Hz a 200 ms window becomes a 1 s window and the check still runs; slower
 * than that, a spin can start and end between two fixes, so the check is
 * reported UNAVAILABLE (-> the lap is unverified) instead of "no spike found".
 */
const YAW_MAX_SAMPLE_INTERVAL_MS = 1_000;

/**
 * Degrees of the measured turn that the centreline cannot explain, minimised
 * over the tolerated window widenings. Returns the measured turn itself when no
 * centreline heading is available (implied yaw 0).
 */
function smallestUnexplainedTurn(
  samples: readonly CornerLapSample[],
  from: number,
  to: number,
  measuredTurn: number,
  totalLengthM: number,
): number {
  let best = Math.abs(measuredTurn);
  const start = samples[from];
  const finish = samples[to];
  if (start === undefined || finish === undefined) return best;
  const withinTolerance = (probe: CornerLapSample, edge: CornerLapSample): boolean => {
    const gapM = Math.min(
      forwardDistance(probe.distanceM, edge.distanceM, totalLengthM),
      forwardDistance(edge.distanceM, probe.distanceM, totalLengthM),
    );
    return gapM <= YAW_IMPLIED_TOLERANCE_M &&
      Math.abs(probe.tMonoMs - edge.tMonoMs) <= YAW_IMPLIED_TOLERANCE_MS;
  };
  for (let a = from; a >= 0; a -= 1) {
    const before = samples[a];
    if (before === undefined || !withinTolerance(before, start)) break;
    if (!finite(before.centrelineHeadingDeg)) continue;
    for (let b = to; b < samples.length; b += 1) {
      const after = samples[b];
      if (after === undefined || !withinTolerance(after, finish)) break;
      if (!finite(after.centrelineHeadingDeg)) continue;
      const implied = wrappedHeadingDelta(before.centrelineHeadingDeg, after.centrelineHeadingDeg);
      const unexplained = Math.abs(measuredTurn - implied);
      if (unexplained < best) best = unexplained;
    }
  }
  return best;
}

interface YawEvaluation {
  /**
   * False when the samples carry neither a gyro channel nor two headings, or
   * when the sample rate is too low for the rule to mean anything.
   */
  available: boolean;
  /** Which signal the measured turn came from -- the one coverage is judged on. */
  source: 'yawRateDps' | 'headingDeg' | null;
  /** Worst excess over the implied yaw that satisfied every guard, deg/s. */
  worstDps: number | null;
  /** The duration window the rule actually used, ms. */
  windowMs: number;
}

/** Median of the positive intervals between consecutive samples, ms. */
function medianSampleIntervalMs(samples: readonly CornerLapSample[]): number | null {
  const intervals: number[] = [];
  for (let index = 0; index + 1 < samples.length; index += 1) {
    const current = samples[index];
    const next = samples[index + 1];
    if (current === undefined || next === undefined) continue;
    const dt = next.tMonoMs - current.tMonoMs;
    if (dt > 0 && Number.isFinite(dt)) intervals.push(dt);
  }
  if (intervals.length === 0) return null;
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor((intervals.length - 1) / 2)] ?? null;
}

/** Degrees the gyro says the car turned between two indices. */
function integratedGyroTurn(
  samples: readonly CornerLapSample[],
  from: number,
  to: number,
): number | null {
  let total = 0;
  for (let index = from; index < to; index += 1) {
    const sample = samples[index];
    const next = samples[index + 1];
    if (sample === undefined || next === undefined) return null;
    const rate = sample.channels?.yawRateDps;
    if (!finite(rate)) return null;
    const dtSeconds = (next.tMonoMs - sample.tMonoMs) / 1_000;
    if (!(dtSeconds > 0)) return null;
    total += rate * dtSeconds;
  }
  return total;
}

/**
 * Yaw anomaly per `analysis-engine.md` §3: the yaw the car ACTUALLY turned
 * through -- the recorded gyro when the session has one, else the GNSS course
 * over ground -- against the yaw the CENTRELINE's own curvature implies over
 * the same stretch. A car following a hairpin turns fast and is not sliding; a
 * car turning fast where the track does not is.
 *
 * Both signals are compared over a fixed DURATION window rather than per sample
 * interval: the rule is then identical at 5 Hz and at 20 Hz, and the shared
 * turn across a centreline vertex cancels instead of appearing as a spike in
 * one signal only. With no centreline heading the implied yaw is 0, so the
 * check degrades to an absolute-rate rule -- never to attributing yaw to a
 * track it cannot see -- and the implausible-lateral-g guard still applies.
 */
function evaluateYaw(
  samples: readonly CornerLapSample[],
  yawSpikeMs: number,
  yawSpikeDps: number,
  yawSpikeLatG: number,
  totalLengthM: number,
): YawEvaluation {
  let gyroCount = 0;
  let headingCount = 0;
  for (const sample of samples) {
    if (finite(sample.channels?.yawRateDps)) gyroCount += 1;
    if (finite(sample.headingDeg)) headingCount += 1;
  }
  const useGyro = gyroCount >= 2;
  const source = useGyro ? 'yawRateDps' : headingCount >= 2 ? 'headingDeg' : null;
  if (source === null) {
    return { available: false, source: null, worstDps: null, windowMs: yawSpikeMs };
  }
  // The rule is a DURATION rule, so a rate that cannot resolve that duration
  // widens the window to one sample interval instead of skipping every window
  // and reporting "no spike" -- and below `YAW_MAX_SAMPLE_INTERVAL_MS` it
  // reports that it cannot judge at all.
  const intervalMs = medianSampleIntervalMs(samples);
  if (intervalMs === null || intervalMs > YAW_MAX_SAMPLE_INTERVAL_MS) {
    return { available: false, source, worstDps: null, windowMs: yawSpikeMs };
  }
  const windowMs = Math.max(yawSpikeMs, intervalMs);
  const maxWindowMs = Math.max(yawSpikeMs * 4, windowMs * 1.5);

  let worstDps: number | null = null;
  for (let index = 0; index < samples.length; index += 1) {
    const start = samples[index];
    if (start === undefined) continue;
    let end = index + 1;
    while (end < samples.length && (samples[end]?.tMonoMs ?? 0) - start.tMonoMs < windowMs) {
      end += 1;
    }
    const finish = samples[end];
    if (finish === undefined) continue;
    const spanMs = finish.tMonoMs - start.tMonoMs;
    // The window must be the duration the rule asks for, and must not straddle
    // a data gap (which is already reported on its own).
    if (spanMs < windowMs || spanMs > maxWindowMs) continue;
    const measuredTurn = useGyro
      ? integratedGyroTurn(samples, index, end)
      : finite(start.headingDeg) && finite(finish.headingDeg)
        ? wrappedHeadingDelta(start.headingDeg, finish.headingDeg)
        : null;
    if (measuredTurn === null) continue;
    // The projected distance carries a few metres of GNSS/projection
    // uncertainty, and a catalog centreline turns in discrete vertex steps (a
    // single OSM vertex can be worth 35 degrees). Comparing two step functions
    // whose phase differs by a metre or two would invent a spin at every such
    // vertex, so the implied turn is taken over the window WIDENED by up to
    // `YAW_IMPLIED_TOLERANCE_SAMPLES` on each side and the reading that best
    // explains the measured turn wins. Nothing is widened for the measurement
    // itself, so a real rotation the track does not ask for still stands out.
    const excessDeg = smallestUnexplainedTurn(samples, index, end, measuredTurn, totalLengthM);
    const excessDps = excessDeg / (spanMs / 1_000);
    const speedMps = finite(start.speedKph) ? start.speedKph / 3.6 : null;
    const excessLatG =
      speedMps === null ? null : (((excessDps * Math.PI) / 180) * speedMps) / GRAVITY_MPS2;
    if (excessDps <= yawSpikeDps) continue;
    if (excessLatG !== null && excessLatG <= yawSpikeLatG) continue;
    if (worstDps === null || excessDps > worstDps) worstDps = excessDps;
  }
  return { available: true, source, worstDps, windowMs };
}

/**
 * Fraction of the LAP DISTANCE over which a channel is continuous evidence:
 * the lap is split into `COVERAGE_BUCKETS` cells and every cell a pair of
 * consecutive readings no more than `bridgeM` apart spans is counted. "The
 * channel appeared once" is not evidence about the rest of the lap.
 */
function channelCoverageFraction(
  samples: readonly CornerLapSample[],
  carries: (sample: CornerLapSample) => boolean,
  totalLengthM: number,
  bridgeM: number,
): number {
  const bucketM = totalLengthM / COVERAGE_BUCKETS;
  const buckets = new Array<boolean>(COVERAGE_BUCKETS).fill(false);
  let previous: CornerLapSample | null = null;
  for (const sample of samples) {
    if (!Number.isFinite(sample.distanceM) || !carries(sample)) continue;
    const from = normalizeDistance(sample.distanceM, totalLengthM);
    buckets[Math.min(COVERAGE_BUCKETS - 1, Math.floor(from / bucketM))] = true;
    if (previous !== null) {
      const span = forwardDistance(previous.distanceM, sample.distanceM, totalLengthM);
      if (span <= bridgeM) {
        const start = normalizeDistance(previous.distanceM, totalLengthM);
        const first = Math.floor(start / bucketM);
        const steps = Math.floor(((start % bucketM) + span) / bucketM);
        for (let step = 0; step <= steps; step += 1) {
          buckets[(first + step) % COVERAGE_BUCKETS] = true;
        }
      }
    }
    previous = sample;
  }
  return buckets.filter(Boolean).length / COVERAGE_BUCKETS;
}

/**
 * Classifies ONE lap as clean or anomalous from its record plus its projected
 * samples. Pure and deterministic: the same inputs always produce the same
 * classification, including the order of `reasons`.
 */
export function classifyLap(
  lap: ClassifiableLap,
  samples: readonly CornerLapSample[],
  options: ClassifyLapOptions,
): LapClassification {
  assertPositiveLength(options.totalLengthM);
  const corridorHalfWidthM = options.corridorHalfWidthM ?? 15;
  const poorAccuracyM = options.poorAccuracyM ?? 25;
  const poorAccuracyFraction = options.poorAccuracyFraction ?? 0.05;
  const maxSampleGapMs = options.maxSampleGapMs ?? 1_500;
  const decelSpikeG = options.decelSpikeG ?? 1.2;
  const yawSpikeDps = options.yawSpikeDps ?? 150;
  const yawSpikeLatG = options.yawSpikeLatG ?? 2;
  const yawSpikeMs = options.yawSpikeMs ?? 200;
  const minCoverageFraction = options.minCoverageFraction ?? 0.9;
  const minCheckCoverageFraction = options.minCheckCoverageFraction ?? 0.9;
  const checkBridgeM = options.checkBridgeM ?? 60;

  const reasons = new Set<LapAnomalyReason>();
  const unavailable = new Set<LapCheckId>();
  const details: string[] = [];

  // --- the lap record itself ------------------------------------------------
  if (!lap.valid) {
    reasons.add('incomplete');
    const listed = lap.invalidReasons.length > 0 ? lap.invalidReasons.join(', ') : 'no reason given';
    details.push(`lap record is invalid (${listed})`);
  }
  // A lap time that is not a finite positive number of milliseconds is not a
  // lap time: it must never reach the reference selection or the report text.
  if (!Number.isFinite(lap.durationMs) || lap.durationMs <= 0) {
    reasons.add('incomplete');
    details.push('lap duration is not a finite, positive number of milliseconds');
  }

  // --- coverage -------------------------------------------------------------
  let sampleCount = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.distanceM) || !Number.isFinite(sample.tMonoMs)) continue;
    sampleCount += 1;
  }
  // The SAME rule the per-check coverage uses: two consecutive fixes no further
  // apart than `checkBridgeM` cover the track between them. Counting "a fix
  // landed in this 1 % of the lap" instead would call every 1 Hz lap incomplete
  // -- at 40 m/s a 1 Hz receiver reports one fix per 4 % of a 1 km circuit, and
  // 1 Hz is what the shipped app records on iPhone.
  const coverageFraction = channelCoverageFraction(
    samples,
    (sample) => Number.isFinite(sample.tMonoMs),
    options.totalLengthM,
    checkBridgeM,
  );
  if (sampleCount === 0) {
    unavailable.add('coverage');
    reasons.add('incomplete');
    details.push('no usable samples for this lap');
  } else if (coverageFraction < minCoverageFraction) {
    reasons.add('incomplete');
    details.push(
      `samples cover ${Math.round(coverageFraction * 100)}% of the lap ` +
        `(minimum ${Math.round(minCoverageFraction * 100)}%)`,
    );
  }

  // --- per-sample checks ----------------------------------------------------
  let worstAccuracyM: number | null = null;
  let poorAccuracyCount = 0;
  let accuracyCount = 0;
  let worstLateralM: number | null = null;
  let lateralCount = 0;
  const yaw = evaluateYaw(samples, yawSpikeMs, yawSpikeDps, yawSpikeLatG, options.totalLengthM);
  // Availability is a COVERAGE question, not an existence one: a check may only
  // speak for the lap if its evidence spans the lap (§3 / safety contract 2).
  const coverageOf = (carries: (sample: CornerLapSample) => boolean): number =>
    channelCoverageFraction(samples, carries, options.totalLengthM, checkBridgeM);
  const checkCoverage: Record<LapCheckId, number> = {
    offTrack: coverageOf((sample) => finite(sample.lateralM)),
    yawSpike:
      yaw.source === 'yawRateDps'
        ? coverageOf((sample) => finite(sample.channels?.yawRateDps))
        : coverageOf((sample) => finite(sample.headingDeg)),
    decelSpike: coverageOf((sample) => finite(sample.speedKph)),
    gnssPoor: coverageOf((sample) => finite(sample.accuracyM)),
    coverage: coverageFraction,
  };
  let speedCount = 0;
  let worstDecelG: number | null = null;
  let observedMaxGapMs: number | null = null;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample === undefined) continue;
    const next = samples[index + 1];

    if (sample.accuracyM !== undefined && Number.isFinite(sample.accuracyM)) {
      accuracyCount += 1;
      if (worstAccuracyM === null || sample.accuracyM > worstAccuracyM) {
        worstAccuracyM = sample.accuracyM;
      }
      if (sample.accuracyM > poorAccuracyM) poorAccuracyCount += 1;
    }
    if (sample.lateralM !== undefined && Number.isFinite(sample.lateralM)) {
      lateralCount += 1;
      const magnitude = Math.abs(sample.lateralM);
      if (worstLateralM === null || magnitude > worstLateralM) worstLateralM = magnitude;
    }
    if (next === undefined) continue;
    const dtSeconds = (next.tMonoMs - sample.tMonoMs) / 1_000;
    if (dtSeconds > 0) {
      const gapMs = dtSeconds * 1_000;
      if (observedMaxGapMs === null || gapMs > observedMaxGapMs) observedMaxGapMs = gapMs;
      const speed = sample.speedKph;
      const nextSpeed = next.speedKph;
      if (
        speed !== undefined &&
        nextSpeed !== undefined &&
        Number.isFinite(speed) &&
        Number.isFinite(nextSpeed)
      ) {
        speedCount += 1;
        const accelG = (nextSpeed - speed) / 3.6 / dtSeconds / GRAVITY_MPS2;
        if (accelG < 0 && (worstDecelG === null || -accelG > worstDecelG)) worstDecelG = -accelG;
      }
    }
  }

  // What a check DID see is always reported: an excursion observed over the
  // first 100 m is a fact even when the rest of the lap carries no evidence.
  // Thin coverage only removes the right to call the lap clean.
  if (lateralCount === 0 || checkCoverage.offTrack < minCheckCoverageFraction) {
    unavailable.add('offTrack');
  }
  if (worstLateralM !== null && worstLateralM > corridorHalfWidthM) {
    reasons.add('offTrack');
    details.push(
      `lateral offset reached ${formatMetres(worstLateralM)} (corridor ${formatMetres(corridorHalfWidthM)})`,
    );
  }

  if (!yaw.available || checkCoverage.yawSpike < minCheckCoverageFraction) {
    unavailable.add('yawSpike');
  }
  if (yaw.worstDps !== null) {
    reasons.add('yawSpike');
    details.push(
      `yaw rate exceeded the implied (centreline) yaw by ${Math.round(yaw.worstDps)} deg/s ` +
        `over ${Math.round(yaw.windowMs)} ms (limit ${yawSpikeDps} deg/s)`,
    );
  }

  if (speedCount === 0 || checkCoverage.decelSpike < minCheckCoverageFraction) {
    unavailable.add('decelSpike');
  }
  if (worstDecelG !== null && worstDecelG > decelSpikeG) {
    reasons.add('decelSpike');
    details.push(
      `deceleration reached ${worstDecelG.toFixed(2)} g (limit ${decelSpikeG.toFixed(2)} g)`,
    );
  }

  if (accuracyCount === 0 || checkCoverage.gnssPoor < minCheckCoverageFraction) {
    unavailable.add('gnssPoor');
  }
  if (accuracyCount > 0 && poorAccuracyCount / accuracyCount > poorAccuracyFraction) {
    reasons.add('gnssPoor');
    const percent = Math.round((poorAccuracyCount / accuracyCount) * 100);
    details.push(`${percent}% of fixes worse than ${formatMetres(poorAccuracyM)}`);
  }
  if (observedMaxGapMs !== null && observedMaxGapMs > maxSampleGapMs) {
    reasons.add('gnssPoor');
    details.push(`sample gap of ${Math.round(observedMaxGapMs)} ms (limit ${maxSampleGapMs} ms)`);
  }

  const ordered = REASON_PRIORITY.filter((reason) => reasons.has(reason));
  const first = ordered[0] ?? null;
  const unavailableChecks = REQUIRED_CHECKS.filter((check) => unavailable.has(check));
  // An unavailable required check can never be reported as "clean": the lap did
  // not fail, but the evidence to call it clean was not there either.
  const status: LapStatus =
    ordered.length > 0 ? 'anomalous' : unavailableChecks.length > 0 ? 'unverified' : 'clean';
  // The evidence percentage belongs in the sentence: "could not run" reads very
  // differently from "ran over 11 % of the lap".
  const listUnavailable = (): string =>
    unavailableChecks
      .map((check) => `${check} (evidence over ${Math.round(checkCoverage[check] * 100)} % of the lap)`)
      .join(', ');
  const detail =
    details.length > 0
      ? details.join('; ')
      : status === 'unverified'
        ? `no anomaly detected, but these checks could not run: ${listUnavailable()}`
        : 'no anomaly detected';
  return {
    lapNumber: lap.lapNumber,
    status,
    clean: status === 'clean',
    reason: first,
    reasons: ordered,
    detail,
    unavailableChecks: [...unavailableChecks],
    checkCoverage,
    coverageFraction,
    worstAccuracyM,
    maxSampleGapMs: observedMaxGapMs,
  };
}
