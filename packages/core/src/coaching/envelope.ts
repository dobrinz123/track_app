import { CORNER_ANALYSIS_VERSION } from '../contracts';

import type { CleanLapMetrics, CornerMetrics, CornerQualityFlag } from './types';

/**
 * The driver's DEMONSTRATED envelope -- Phase 5 safety contract rule 2.
 *
 * Built from CLEAN laps only: the latest braking point the driver has actually
 * shown, the highest minimum corner speed they have actually carried, the
 * earliest lift. It is the evidence base for consistency reporting today and
 * the hard bound for any future suggestion ("brake later than you ever have" is
 * impossible by construction). Suggestions are OFF in V1 -- this module only
 * states what the driver already did, with the lap that proves it.
 */

/** Approach-window flags that make a lap's brake/lift point unusable as a bound. */
export const ENVELOPE_APPROACH_EXCLUDING_FLAGS: readonly CornerQualityFlag[] = Object.freeze([
  'APPROACH_TRUNCATED',
  'NO_APPROACH_COVERAGE',
  'SAMPLE_GAP',
  'GNSS_ACCURACY_POOR',
] as const);

/** Corner-window flags that make a lap's in-corner speeds unusable as a bound. */
export const ENVELOPE_CORNER_EXCLUDING_FLAGS: readonly CornerQualityFlag[] = Object.freeze([
  'CORNER_TRUNCATED',
  'NO_CORNER_COVERAGE',
  'SAMPLE_GAP',
  'GNSS_ACCURACY_POOR',
] as const);

export interface CornerEnvelope {
  cornerId: number;
  /** Smallest distance before the corner at which the driver has braked, metres. */
  latestBrakeStartM: number | null;
  latestBrakeStartLapNumber: number | null;
  /** Largest such distance -- the earliest they have braked. */
  earliestBrakeStartM: number | null;
  earliestBrakeStartLapNumber: number | null;
  /** Lower median of the clean braking points, metres. */
  medianBrakeStartM: number | null;
  /** Largest distance before the corner at which the driver has lifted, metres. */
  earliestLiftM: number | null;
  earliestLiftLapNumber: number | null;
  latestLiftM: number | null;
  latestLiftLapNumber: number | null;
  medianLiftM: number | null;
  /** Highest minimum corner speed the driver has carried, km/h. */
  highestMinSpeedKph: number | null;
  highestMinSpeedLapNumber: number | null;
  lowestMinSpeedKph: number | null;
  lowestMinSpeedLapNumber: number | null;
  medianMinSpeedKph: number | null;
  /** Highest exit speed demonstrated, km/h. */
  highestExitSpeedKph: number | null;
  highestExitSpeedLapNumber: number | null;
  /** Highest peak deceleration and lateral load demonstrated, g. */
  maxDecelG: number | null;
  maxLatG: number | null;
  /** Clean laps fully usable as evidence for this corner, ascending. */
  evidenceLapIds: number[];
}

export interface DemonstratedEnvelope {
  analysisVersion: number;
  cleanLapCount: number;
  cleanLapIds: number[];
  corners: CornerEnvelope[];
}

interface Candidate {
  lapNumber: number;
  value: number;
}

function excluded(
  metrics: CornerMetrics,
  flags: readonly CornerQualityFlag[],
): boolean {
  return metrics.quality.flags.some((flag) => flags.includes(flag));
}

/** Lower median: for an even count the smaller of the two middle values. */
function lowerMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function pick(
  candidates: readonly Candidate[],
  better: (candidate: number, incumbent: number) => boolean,
): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (best === null || better(candidate.value, best.value)) best = candidate;
  }
  return best;
}

function collect(
  laps: readonly CleanLapMetrics[],
  cornerId: number,
  flags: readonly CornerQualityFlag[],
  read: (metrics: CornerMetrics) => number | null,
): Candidate[] {
  const out: Candidate[] = [];
  for (const lap of laps) {
    const metrics = lap.corners.find((entry) => entry.cornerId === cornerId);
    if (metrics === undefined || excluded(metrics, flags)) continue;
    const value = read(metrics);
    if (value === null || !Number.isFinite(value)) continue;
    out.push({ lapNumber: lap.lapNumber, value });
  }
  return out;
}

/**
 * Builds the per-corner demonstrated envelope from the clean laps' metrics.
 * Deterministic: laps are ordered by number and corners by id before anything
 * is measured, so the result does not depend on input order. Nothing is
 * fabricated -- a corner with no usable evidence comes back all-`null`.
 */
export function buildDemonstratedEnvelope(
  cleanLaps: readonly CleanLapMetrics[],
): DemonstratedEnvelope {
  const seen = new Set<number>();
  let version: number | null = null;
  for (const lap of cleanLaps) {
    if (seen.has(lap.lapNumber)) {
      throw new RangeError(`duplicate lap number ${lap.lapNumber} in the clean-lap set`);
    }
    seen.add(lap.lapNumber);
    for (const metrics of lap.corners) {
      if (version === null) version = metrics.analysisVersion;
      else if (metrics.analysisVersion !== version) {
        throw new RangeError(
          `mixed corner-analysis versions in the clean-lap set (${version} and ${metrics.analysisVersion})`,
        );
      }
    }
  }

  const laps = [...cleanLaps].sort((a, b) => a.lapNumber - b.lapNumber);
  const cornerIds = [
    ...new Set(laps.flatMap((lap) => lap.corners.map((metrics) => metrics.cornerId))),
  ].sort((a, b) => a - b);

  const corners = cornerIds.map((cornerId): CornerEnvelope => {
    const brake = collect(laps, cornerId, ENVELOPE_APPROACH_EXCLUDING_FLAGS, (m) => m.brakeStartM);
    const lift = collect(laps, cornerId, ENVELOPE_APPROACH_EXCLUDING_FLAGS, (m) => m.liftPointM);
    const decel = collect(laps, cornerId, ENVELOPE_APPROACH_EXCLUDING_FLAGS, (m) => m.peakDecelG);
    const minSpeed = collect(laps, cornerId, ENVELOPE_CORNER_EXCLUDING_FLAGS, (m) => m.minSpeedKph);
    const exitSpeed = collect(laps, cornerId, ENVELOPE_CORNER_EXCLUDING_FLAGS, (m) => m.exitSpeedKph);
    const latG = collect(laps, cornerId, ENVELOPE_CORNER_EXCLUDING_FLAGS, (m) => m.maxLatG);

    const latestBrake = pick(brake, (candidate, incumbent) => candidate < incumbent);
    const earliestBrake = pick(brake, (candidate, incumbent) => candidate > incumbent);
    const earliestLift = pick(lift, (candidate, incumbent) => candidate > incumbent);
    const latestLift = pick(lift, (candidate, incumbent) => candidate < incumbent);
    const highestMin = pick(minSpeed, (candidate, incumbent) => candidate > incumbent);
    const lowestMin = pick(minSpeed, (candidate, incumbent) => candidate < incumbent);
    const highestExit = pick(exitSpeed, (candidate, incumbent) => candidate > incumbent);
    const maxDecel = pick(decel, (candidate, incumbent) => candidate > incumbent);
    const maxLat = pick(latG, (candidate, incumbent) => candidate > incumbent);

    // Evidence = laps fully usable for this corner (both windows clean) that
    // actually measured something.
    const evidenceLapIds = laps
      .filter((lap) => {
        const metrics = lap.corners.find((entry) => entry.cornerId === cornerId);
        if (metrics === undefined) return false;
        if (excluded(metrics, ENVELOPE_APPROACH_EXCLUDING_FLAGS)) return false;
        if (excluded(metrics, ENVELOPE_CORNER_EXCLUDING_FLAGS)) return false;
        return (
          metrics.brakeStartM !== null || metrics.liftPointM !== null || metrics.minSpeedKph !== null
        );
      })
      .map((lap) => lap.lapNumber);

    return {
      cornerId,
      latestBrakeStartM: latestBrake?.value ?? null,
      latestBrakeStartLapNumber: latestBrake?.lapNumber ?? null,
      earliestBrakeStartM: earliestBrake?.value ?? null,
      earliestBrakeStartLapNumber: earliestBrake?.lapNumber ?? null,
      medianBrakeStartM: lowerMedian(brake.map((entry) => entry.value)),
      earliestLiftM: earliestLift?.value ?? null,
      earliestLiftLapNumber: earliestLift?.lapNumber ?? null,
      latestLiftM: latestLift?.value ?? null,
      latestLiftLapNumber: latestLift?.lapNumber ?? null,
      medianLiftM: lowerMedian(lift.map((entry) => entry.value)),
      highestMinSpeedKph: highestMin?.value ?? null,
      highestMinSpeedLapNumber: highestMin?.lapNumber ?? null,
      lowestMinSpeedKph: lowestMin?.value ?? null,
      lowestMinSpeedLapNumber: lowestMin?.lapNumber ?? null,
      medianMinSpeedKph: lowerMedian(minSpeed.map((entry) => entry.value)),
      highestExitSpeedKph: highestExit?.value ?? null,
      highestExitSpeedLapNumber: highestExit?.lapNumber ?? null,
      maxDecelG: maxDecel?.value ?? null,
      maxLatG: maxLat?.value ?? null,
      evidenceLapIds,
    };
  });

  return {
    analysisVersion: version ?? CORNER_ANALYSIS_VERSION,
    cleanLapCount: laps.length,
    cleanLapIds: laps.map((lap) => lap.lapNumber),
    corners,
  };
}
