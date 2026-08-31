import type { LocalPoint, LocationSample } from '../contracts';
import { createProjection } from '../geometry';

import { resolveTestLoopConfig, type TestLoopConfig, type TestLoopConfigOverrides } from './config';

/**
 * Ticket P5d T1(a) -- "lap 1 defines the track" needs exactly one decision:
 * has the driver come back to where they started, going the way they left?
 *
 * Three independent conditions, all of which must hold, so that the honest
 * failure is always nameable:
 *   1. within `closeRadiusM` of the start point,
 *   2. travelling within `headingToleranceDeg` of the start heading,
 *   3. after at least `minLapLengthM` of driving (this is what rejects a
 *      U-turn -- it satisfies 1 and sometimes even 2, but never 3).
 *
 * Two hardening rules from ticket P5d-FIX1 (Codex P5d-REV1 MEDIUM 4/5) are
 * part of the same pass and cannot be bypassed by a caller:
 *
 *   4. QUALITY GATE. Only fixes that are accurate enough AND actually moving
 *      contribute to distance, departure or closure, and only plausible
 *      segments between them are counted. A parked car drifting in an urban
 *      canyon reports metres of motion per second; without this gate it
 *      would eventually "drive" 300 m without moving and close a lap on top
 *      of itself.
 *   5. STATEFUL RUN. A closure is a RUN of consecutive accepted fixes inside
 *      the closing radius, finalized at the run's NEAREST fix, and only once
 *      the car has left the radius again. Closing on the first qualifying
 *      sample would anchor the whole circuit up to a full radius away from
 *      where the driver actually started, and could fire on a mid-route pass
 *      that merely brushes the start point.
 *
 * Heading is measured from the TRACK, over a `courseBaselineM` baseline, not
 * from a single fix's `headingDeg`: a parked-then-rolling phone reports
 * garbage course, and 5 m of noise on two adjacent 1 Hz fixes is a 30 degree
 * error. A reported `headingDeg` is used only when the track cannot supply a
 * baseline.
 */

export interface LoopClosure {
  /** Index (into the ORIGINAL sample array) the loop is anchored at. */
  startIndex: number;
  /** Index (into the ORIGINAL sample array) that closed the loop. */
  closeIndex: number;
  /** Distance driven from `startIndex` to `closeIndex`, metres. */
  lapLengthM: number;
  /** How near the start point the closing fix passed, metres. */
  closureDistanceM: number;
  /** How far the closing travel direction was from the start heading, degrees. */
  headingErrorDeg: number;
  /** The start heading itself, degrees (0 = north). */
  startHeadingDeg: number;
}

export type LoopClosureFailureReason =
  | 'insufficient-samples'
  | 'not-returned'
  | 'too-short'
  | 'heading-mismatch'
  /**
   * P5d-FIX1 item 5: the car IS back at the start, going the right way, after
   * a long enough lap -- but it has not driven back OUT of the closing radius
   * yet, so the pass is not finished. Nothing is wrong; the loop simply is not
   * confirmed until the driver goes through the start point.
   */
  | 'closure-unconfirmed';

export type LoopClosureResult =
  | { closed: true; closure: LoopClosure; rejectedSamples: number }
  | {
      closed: false;
      reason: LoopClosureFailureReason;
      /** How far the driver actually drove (accepted fixes only), metres. */
      travelledM: number;
      /** Nearest the driver came to the start point after leaving it, metres. */
      closestApproachM: number;
      /** Fixes the quality gate refused -- inaccurate, stationary or implausible. */
      rejectedSamples: number;
    };

const RAD_TO_DEG = 180 / Math.PI;

function distance(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(b.e - a.e, b.n - a.n);
}

/** Bearing of `b` seen from `a`, degrees clockwise from north. */
function bearingDeg(a: LocalPoint, b: LocalPoint): number {
  return (Math.atan2(b.e - a.e, b.n - a.n) * RAD_TO_DEG + 360) % 360;
}

/** Smallest absolute angle between two bearings, degrees (0..180). */
export function headingDifferenceDeg(a: number, b: number): number {
  const raw = Math.abs(((a - b) % 360) + 360) % 360;
  return raw > 180 ? 360 - raw : raw;
}

/** Projects a sample trace into a metre frame anchored at its first sample. */
export function toLocalTrack(samples: readonly LocationSample[]): {
  points: LocalPoint[];
  cumulativeM: number[];
} {
  const first = samples[0];
  if (first === undefined) return { points: [], cumulativeM: [] };
  const projection = createProjection({ lat: first.lat, lon: first.lon });
  const points = samples.map((sample) => projection.toLocal({ lat: sample.lat, lon: sample.lon }));
  const cumulativeM: number[] = new Array<number>(points.length);
  cumulativeM[0] = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) break;
    cumulativeM[index] = (cumulativeM[index - 1] ?? 0) + distance(previous, current);
  }
  return { points, cumulativeM };
}

/** One fix that passed the quality gate, with its place in the original array. */
export interface QualifiedFix {
  /** Index into the caller's original sample array. */
  sourceIndex: number;
  point: LocalPoint;
  /** Distance driven from the first accepted fix, metres. */
  cumulativeM: number;
  sample: LocationSample;
}

export interface QualifiedTrack {
  fixes: QualifiedFix[];
  /** How many fixes the gate refused. */
  rejected: number;
}

/**
 * P5d-FIX1 item 4: the quality gate. A fix is kept when it is accurate
 * enough AND moving; the SEGMENT to the previous kept fix is counted only
 * when its implied speed and its length are both plausible. A dropped
 * segment contributes nothing to the distance total -- an implausible jump
 * is never clamped into a smaller lie, it is simply not evidence.
 */
export function qualifyTrack(
  samples: readonly LocationSample[],
  config: TestLoopConfig,
): QualifiedTrack {
  const first = samples[0];
  if (first === undefined) return { fixes: [], rejected: 0 };
  const projection = createProjection({ lat: first.lat, lon: first.lon });

  const fixes: QualifiedFix[] = [];
  let rejected = 0;
  let cumulativeM = 0;
  let previous: { point: LocalPoint; sample: LocationSample } | null = null;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample === undefined) continue;
    const accuracyM = sample.accuracyM;
    if (accuracyM !== undefined && Number.isFinite(accuracyM) && accuracyM > config.maxAccuracyM) {
      rejected += 1;
      continue;
    }
    const speedMps = sample.speedMps;
    if (speedMps !== undefined && Number.isFinite(speedMps) && speedMps < config.minSpeedMps) {
      rejected += 1;
      continue;
    }
    const point = projection.toLocal({ lat: sample.lat, lon: sample.lon });

    if (previous !== null) {
      const segmentM = distance(previous.point, point);
      const gapMs = sample.tMono - previous.sample.tMono;
      const plausibleM =
        gapMs > 0
          ? Math.min(config.maxSegmentM, (config.maxSegmentSpeedMps * gapMs) / 1000)
          : config.maxSegmentM;
      if (segmentM > plausibleM) {
        // A teleport: neither the jump nor the fix behind it is evidence of
        // driving. Re-anchor on it (the car IS somewhere) but count nothing.
        rejected += 1;
        previous = { point, sample };
        continue;
      }
      cumulativeM += segmentM;
    }

    previous = { point, sample };
    fixes.push({ sourceIndex: index, point, cumulativeM, sample });
  }
  return { fixes, rejected };
}

/**
 * Travel direction at `index` within the QUALIFIED track, measured over a
 * `baselineM` window of track either side of it (clipped at the ends).
 * `null` when there is no usable baseline and no fix reported a heading.
 */
function courseAtDeg(
  fixes: readonly QualifiedFix[],
  index: number,
  baselineM: number,
): number | null {
  const here = fixes[index];
  if (here === undefined) return null;

  let backIndex = index;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    backIndex = cursor;
    if (here.cumulativeM - (fixes[cursor]?.cumulativeM ?? here.cumulativeM) >= baselineM) break;
  }
  let forwardIndex = index;
  for (let cursor = index + 1; cursor < fixes.length; cursor += 1) {
    forwardIndex = cursor;
    if ((fixes[cursor]?.cumulativeM ?? here.cumulativeM) - here.cumulativeM >= baselineM) break;
  }

  const from = fixes[backIndex];
  const to = fixes[forwardIndex];
  if (from !== undefined && to !== undefined && distance(from.point, to.point) >= 1) {
    return bearingDeg(from.point, to.point);
  }
  const reported = here.sample.headingDeg;
  return reported !== undefined && Number.isFinite(reported) ? ((reported % 360) + 360) % 360 : null;
}

/**
 * Finds the first honest closure of lap 1. Never throws: a trace that does not
 * close is a NAMED outcome, because the driver has to be told which of the
 * three conditions was the one that did not hold.
 */
export function detectLoopClosure(
  samples: readonly LocationSample[],
  overrides: TestLoopConfigOverrides = {},
): LoopClosureResult {
  const config = resolveTestLoopConfig(overrides);
  const { fixes, rejected } = qualifyTrack(samples, config);
  const start = fixes[0];
  const travelledM = fixes[fixes.length - 1]?.cumulativeM ?? 0;
  if (start === undefined || fixes.length < 4) {
    return {
      closed: false,
      reason: 'insufficient-samples',
      travelledM,
      closestApproachM: 0,
      rejectedSamples: rejected,
    };
  }
  const startHeadingDeg = courseAtDeg(fixes, 0, config.courseBaselineM);
  if (startHeadingDeg === null) {
    return {
      closed: false,
      reason: 'insufficient-samples',
      travelledM,
      closestApproachM: 0,
      rejectedSamples: rejected,
    };
  }

  let closestApproachM = Number.POSITIVE_INFINITY;
  let sawReturn = false;
  let sawLongEnoughReturn = false;
  let departed = false;

  // P5d-FIX1 item 5: a "return" is a RUN of consecutive accepted fixes inside
  // the closing radius. The candidate within it is the closest approach, and
  // the run is only judged once it ENDS -- i.e. once the car has driven back
  // out of the radius. Nothing is decided while the car is still in there.
  let runBestIndex: number | null = null;
  let runBestDistanceM = Number.POSITIVE_INFINITY;

  const evaluateRun = (): LoopClosure | null => {
    if (runBestIndex === null) return null;
    const index = runBestIndex;
    runBestIndex = null;
    runBestDistanceM = Number.POSITIVE_INFINITY;
    const fix = fixes[index];
    if (fix === undefined) return null;
    sawReturn = true;
    if (fix.cumulativeM < config.minLapLengthM) return null;
    sawLongEnoughReturn = true;
    const course = courseAtDeg(fixes, index, config.courseBaselineM);
    if (course === null) return null;
    const headingErrorDeg = headingDifferenceDeg(course, startHeadingDeg);
    if (headingErrorDeg > config.headingToleranceDeg) return null;
    return {
      startIndex: start.sourceIndex,
      closeIndex: fix.sourceIndex,
      lapLengthM: fix.cumulativeM,
      closureDistanceM: distance(start.point, fix.point),
      headingErrorDeg,
      startHeadingDeg,
    };
  };

  for (let index = 1; index < fixes.length; index += 1) {
    const fix = fixes[index];
    if (fix === undefined) continue;
    const toStartM = distance(start.point, fix.point);
    if (!departed) {
      // The trace must LEAVE the closing circle before returning to it can
      // mean anything -- otherwise a car creeping away from the kerb closes
      // a zero-length loop on its second fix.
      if (toStartM > config.closeRadiusM) departed = true;
      continue;
    }
    if (toStartM <= config.closeRadiusM) {
      closestApproachM = Math.min(closestApproachM, toStartM);
      if (toStartM < runBestDistanceM) {
        runBestDistanceM = toStartM;
        runBestIndex = index;
      }
      continue;
    }
    const closure = evaluateRun();
    if (closure !== null) return { closed: true, closure, rejectedSamples: rejected };
  }

  // P5d-FIX1 item 5: a trace that stops while the car is still inside the
  // closing radius has not proved it drove THROUGH the start point, so it can
  // never CLOSE here -- the learn phase simply keeps recording. The pending
  // run is still read for DIAGNOSIS, because "you came back, but that was only
  // 240 m" is the honest message for an out-and-back that ends at its start,
  // and "you never came back" would be a lie.
  let pendingPass = false;
  if (runBestIndex !== null) {
    const pending = fixes[runBestIndex];
    if (pending !== undefined) {
      sawReturn = true;
      if (pending.cumulativeM >= config.minLapLengthM) {
        sawLongEnoughReturn = true;
        const course = courseAtDeg(fixes, runBestIndex, config.courseBaselineM);
        pendingPass =
          course !== null &&
          headingDifferenceDeg(course, startHeadingDeg) <= config.headingToleranceDeg;
      }
    }
  }
  const reason: LoopClosureFailureReason = pendingPass
    ? 'closure-unconfirmed'
    : !sawReturn
      ? 'not-returned'
      : sawLongEnoughReturn
        ? 'heading-mismatch'
        : 'too-short';
  return {
    closed: false,
    reason,
    travelledM,
    closestApproachM: Number.isFinite(closestApproachM) ? closestApproachM : travelledM,
    rejectedSamples: rejected,
  };
}
