import { assertPositiveLength, normalizeDistance } from './distanceDomain';
import {
  GRAVITY_MPS2,
  type ClassifiableLap,
  type CornerLapSample,
  type LapAnomalyReason,
  type LapCheckId,
  type LapClassification,
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
  /** Heading rate above this is a yaw spike, degrees/second. Default 150. */
  yawSpikeDps?: number;
  /**
   * A yaw rate only counts as a spike when the lateral acceleration it implies
   * (`yawRate * speed`) is beyond what any car can hold, in g. Default 2.
   * Course-over-ground noise and centreline-vertex jitter fail this test.
   */
  yawSpikeLatG?: number;
  /** Fraction of the lap distance that must be covered by samples. Default 0.9. */
  minCoverageFraction?: number;
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
 * How many consecutive sample intervals must exceed the yaw threshold before it
 * counts as a spike. A single interval is jitter -- a sharp centreline vertex,
 * or one noisy course-over-ground fix -- while a slide or spin lasts.
 */
const YAW_SPIKE_MIN_INTERVALS = 2;

function wrappedHeadingDelta(from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta <= -180) delta += 360;
  return delta;
}

function formatMetres(value: number): string {
  return `${Math.round(value)} m`;
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
  const minCoverageFraction = options.minCoverageFraction ?? 0.9;

  const reasons = new Set<LapAnomalyReason>();
  const unavailable = new Set<LapCheckId>();
  const details: string[] = [];

  // --- the lap record itself ------------------------------------------------
  if (!lap.valid) {
    reasons.add('incomplete');
    const listed = lap.invalidReasons.length > 0 ? lap.invalidReasons.join(', ') : 'no reason given';
    details.push(`lap record is invalid (${listed})`);
  }

  // --- coverage -------------------------------------------------------------
  const buckets = new Array<boolean>(COVERAGE_BUCKETS).fill(false);
  let sampleCount = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.distanceM) || !Number.isFinite(sample.tMonoMs)) continue;
    sampleCount += 1;
    const wrapped = normalizeDistance(sample.distanceM, options.totalLengthM);
    const bucket = Math.min(
      COVERAGE_BUCKETS - 1,
      Math.floor((wrapped / options.totalLengthM) * COVERAGE_BUCKETS),
    );
    buckets[bucket] = true;
  }
  const coverageFraction = buckets.filter(Boolean).length / COVERAGE_BUCKETS;
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
  let headingCount = 0;
  let worstYawDps: number | null = null;
  let yawRun = 0;
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
    if (sample.headingDeg !== undefined && Number.isFinite(sample.headingDeg)) headingCount += 1;

    if (next === undefined) continue;
    const dtSeconds = (next.tMonoMs - sample.tMonoMs) / 1_000;
    if (dtSeconds > 0) {
      const gapMs = dtSeconds * 1_000;
      if (observedMaxGapMs === null || gapMs > observedMaxGapMs) observedMaxGapMs = gapMs;
      if (
        sample.headingDeg !== undefined &&
        next.headingDeg !== undefined &&
        Number.isFinite(sample.headingDeg) &&
        Number.isFinite(next.headingDeg)
      ) {
        const rate = Math.abs(wrappedHeadingDelta(sample.headingDeg, next.headingDeg)) / dtSeconds;
        const speedMps =
          sample.speedKph !== undefined && Number.isFinite(sample.speedKph)
            ? sample.speedKph / 3.6
            : null;
        const impliedLatG =
          speedMps === null ? null : ((rate * Math.PI) / 180) * speedMps / GRAVITY_MPS2;
        const beyond = rate > yawSpikeDps && (impliedLatG === null || impliedLatG > yawSpikeLatG);
        yawRun = beyond ? yawRun + 1 : 0;
        if (yawRun >= YAW_SPIKE_MIN_INTERVALS && (worstYawDps === null || rate > worstYawDps)) {
          worstYawDps = rate;
        }
      }
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

  if (lateralCount === 0) unavailable.add('offTrack');
  else if (worstLateralM !== null && worstLateralM > corridorHalfWidthM) {
    reasons.add('offTrack');
    details.push(
      `lateral offset reached ${formatMetres(worstLateralM)} (corridor ${formatMetres(corridorHalfWidthM)})`,
    );
  }

  if (headingCount < 2) unavailable.add('yawSpike');
  else if (worstYawDps !== null && worstYawDps > yawSpikeDps) {
    reasons.add('yawSpike');
    details.push(`heading rate reached ${Math.round(worstYawDps)} deg/s (limit ${yawSpikeDps})`);
  }

  if (speedCount === 0) unavailable.add('decelSpike');
  else if (worstDecelG !== null && worstDecelG > decelSpikeG) {
    reasons.add('decelSpike');
    details.push(
      `deceleration reached ${worstDecelG.toFixed(2)} g (limit ${decelSpikeG.toFixed(2)} g)`,
    );
  }

  if (accuracyCount === 0) unavailable.add('gnssPoor');
  else if (poorAccuracyCount / accuracyCount > poorAccuracyFraction) {
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
  return {
    lapNumber: lap.lapNumber,
    clean: ordered.length === 0,
    reason: first,
    reasons: ordered,
    detail: details.length === 0 ? 'no anomaly detected' : details.join('; '),
    unavailableChecks: (['offTrack', 'yawSpike', 'decelSpike', 'gnssPoor', 'coverage'] as const)
      .filter((check) => unavailable.has(check)),
    coverageFraction,
    worstAccuracyM,
    maxSampleGapMs: observedMaxGapMs,
  };
}
