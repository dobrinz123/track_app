import type { BrakingZone, Corner, ReferenceLap } from '../contracts';

const KPH_PER_MPS = 3.6;
const DISTANCE_EPSILON_M = 1e-6;

export interface BrakingZoneConfig {
  /** Required for physics-only derivation; inferred from a valid reference grid otherwise. */
  totalLengthM?: number;
  decelOnsetThreshold?: number;
  decelMps2?: number;
  vMaxKph?: number;
  longStraightM?: number;
}

export const DEFAULT_BRAKING_ZONE_CONFIG = Object.freeze({
  decelOnsetThreshold: -0.02,
  decelMps2: 8,
  vMaxKph: 180,
  longStraightM: 250,
});

interface SpeedPoint {
  distanceM: number;
  speedMps: number;
  covered: boolean;
}

interface SpeedProfile {
  points: SpeedPoint[];
  totalLengthM: number;
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function forwardDistance(fromM: number, toM: number, totalLengthM: number): number {
  const distanceM = modulo(toM - fromM, totalLengthM);
  return distanceM < DISTANCE_EPSILON_M || totalLengthM - distanceM < DISTANCE_EPSILON_M
    ? 0
    : distanceM;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validateConfig(config: Required<BrakingZoneConfig>): void {
  if (!finitePositive(config.totalLengthM)) {
    throw new RangeError('totalLengthM must be positive and finite');
  }
  if (!Number.isFinite(config.decelOnsetThreshold) || config.decelOnsetThreshold >= 0) {
    throw new RangeError('decelOnsetThreshold must be negative and finite');
  }
  if (
    !finitePositive(config.decelMps2) ||
    !finitePositive(config.vMaxKph) ||
    !Number.isFinite(config.longStraightM) ||
    config.longStraightM < 0
  ) {
    throw new RangeError('decelMps2 and vMaxKph must be positive; longStraightM nonnegative');
  }
}

function referenceLapLength(reference: ReferenceLap | null): number | undefined {
  if (reference === null || reference.distanceGridM.length < 2) return undefined;
  const last = reference.distanceGridM[reference.distanceGridM.length - 1];
  return last !== undefined && finitePositive(last) ? last : undefined;
}

function buildSpeedProfile(reference: ReferenceLap, totalLengthM: number): SpeedProfile | null {
  const { distanceGridM: distances, elapsedMsAtGrid: elapsed } = reference;
  if (distances.length !== elapsed.length || distances.length < 5) return null;

  const raw: number[] = [];
  for (let index = 0; index < distances.length - 1; index += 1) {
    const distanceM = distances[index];
    const nextDistanceM = distances[index + 1];
    const elapsedMs = elapsed[index];
    const nextElapsedMs = elapsed[index + 1];
    if (
      distanceM === undefined ||
      nextDistanceM === undefined ||
      elapsedMs === undefined ||
      nextElapsedMs === undefined ||
      !Number.isFinite(distanceM) ||
      !Number.isFinite(nextDistanceM) ||
      !Number.isFinite(elapsedMs) ||
      !Number.isFinite(nextElapsedMs) ||
      nextDistanceM <= distanceM ||
      nextElapsedMs <= elapsedMs
    ) {
      raw.push(Number.NaN);
      continue;
    }
    raw.push((nextDistanceM - distanceM) / ((nextElapsedMs - elapsedMs) / 1_000));
  }

  const points: SpeedPoint[] = raw.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (let neighbor = Math.max(0, index - 1); neighbor <= Math.min(raw.length - 1, index + 1); neighbor += 1) {
      const value = raw[neighbor];
      if (value !== undefined && finitePositive(value)) {
        sum += value;
        count += 1;
      }
    }
    return {
      distanceM: distances[index] ?? Number.NaN,
      speedMps: count === 0 ? Number.NaN : sum / count,
      covered: finitePositive(raw[index] ?? Number.NaN),
    };
  });

  return points.some((point) => finitePositive(point.speedMps))
    ? { points, totalLengthM }
    : null;
}

function speedAt(profile: SpeedProfile, distanceM: number): number | null {
  const normalized = modulo(distanceM, profile.totalLengthM);
  const points = profile.points;
  let beforeIndex = -1;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point !== undefined && point.distanceM <= normalized) beforeIndex = index;
    else break;
  }
  const before = points[Math.max(0, beforeIndex)];
  const after = points[Math.min(points.length - 1, beforeIndex + 1)];
  if (before === undefined || after === undefined) return null;
  if (
    !before.covered ||
    !after.covered ||
    !finitePositive(before.speedMps) ||
    !finitePositive(after.speedMps)
  ) {
    return null;
  }
  if (after.distanceM <= before.distanceM) return before.speedMps;
  const fraction = (normalized - before.distanceM) / (after.distanceM - before.distanceM);
  return before.speedMps + fraction * (after.speedMps - before.speedMps);
}

function minimumSpeed(
  profile: SpeedProfile,
  entryDistanceM: number,
  exitDistanceM: number,
): number | null {
  const spanM = forwardDistance(entryDistanceM, exitDistanceM, profile.totalLengthM);
  const speeds: number[] = [];
  const entrySpeed = speedAt(profile, entryDistanceM);
  const exitSpeed = speedAt(profile, exitDistanceM);
  if (entrySpeed !== null) speeds.push(entrySpeed);
  if (exitSpeed !== null) speeds.push(exitSpeed);
  for (const point of profile.points) {
    if (
      point.covered &&
      finitePositive(point.speedMps) &&
      forwardDistance(entryDistanceM, point.distanceM, profile.totalLengthM) <= spanM
    ) {
      speeds.push(point.speedMps);
    }
  }
  return speeds.length === 0 ? null : Math.min(...speeds);
}

function referenceBrakeStart(
  profile: SpeedProfile,
  previousExitM: number,
  entryDistanceM: number,
  threshold: number,
): number | null {
  const availableM = forwardDistance(previousExitM, entryDistanceM, profile.totalLengthM);
  if (availableM <= DISTANCE_EPSILON_M) return null;

  const approach = profile.points
    .map((point) => ({
      ...point,
      offsetM: forwardDistance(previousExitM, point.distanceM, profile.totalLengthM),
    }))
    .filter(
      (point) =>
        point.offsetM < availableM &&
        point.covered &&
        finitePositive(point.speedMps) &&
        Number.isFinite(point.distanceM),
    )
    .sort((left, right) => left.offsetM - right.offsetM);
  if (approach.length < 4) return null;

  const descending: boolean[] = [];
  for (let index = 0; index < approach.length - 1; index += 1) {
    const current = approach[index];
    const next = approach[index + 1];
    if (current === undefined || next === undefined || next.offsetM <= current.offsetM) {
      descending.push(false);
      continue;
    }
    descending.push((next.speedMps - current.speedMps) / (next.offsetM - current.offsetM) < threshold);
  }

  let latestOnsetIndex: number | null = null;
  let runStart = 0;
  while (runStart < descending.length) {
    if (descending[runStart] !== true) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart;
    while (runEnd + 1 < descending.length && descending[runEnd + 1] === true) runEnd += 1;
    if (runEnd - runStart + 1 >= 3) latestOnsetIndex = runStart;
    runStart = runEnd + 1;
  }
  if (latestOnsetIndex === null) return null;
  return approach[latestOnsetIndex]?.distanceM ?? null;
}

function physicsZone(
  corner: Corner,
  previousCorner: Corner,
  totalLengthM: number,
  config: Required<BrakingZoneConfig>,
): BrakingZone {
  const availableM = forwardDistance(previousCorner.exitDistanceM, corner.entryDistanceM, totalLengthM);
  const cornerSpeedMps = corner.advisorySpeedKph / KPH_PER_MPS;
  const approachSpeedMps =
    availableM >= config.longStraightM
      ? config.vMaxKph / KPH_PER_MPS
      : Math.max(cornerSpeedMps, previousCorner.advisorySpeedKph / KPH_PER_MPS);
  const modeledDistanceM = Math.max(
    0,
    (approachSpeedMps ** 2 - cornerSpeedMps ** 2) / (2 * config.decelMps2),
  );
  const brakeDistanceM = Math.min(availableM, modeledDistanceM);
  return {
    cornerId: corner.id,
    brakeStartDistanceM: modulo(corner.entryDistanceM - brakeDistanceM, totalLengthM),
    source: 'physics',
    entrySpeedKph: approachSpeedMps * KPH_PER_MPS,
    apexSpeedKph: corner.advisorySpeedKph,
    brakeCueAvailable: brakeDistanceM > DISTANCE_EPSILON_M,
  };
}

/** Derive one deterministic, wrap-aware advisory braking zone per corner. */
export function deriveBrakingZones(
  reference: ReferenceLap | null,
  corners: Corner[],
  config: BrakingZoneConfig = {},
): BrakingZone[] {
  if (corners.length === 0) return [];
  const inferredLengthM = referenceLapLength(reference);
  const totalLengthM = config.totalLengthM ?? inferredLengthM;
  if (totalLengthM === undefined) {
    throw new RangeError('totalLengthM is required when no usable reference grid is available');
  }
  const resolved: Required<BrakingZoneConfig> = {
    totalLengthM,
    decelOnsetThreshold:
      config.decelOnsetThreshold ?? DEFAULT_BRAKING_ZONE_CONFIG.decelOnsetThreshold,
    decelMps2: config.decelMps2 ?? DEFAULT_BRAKING_ZONE_CONFIG.decelMps2,
    vMaxKph: config.vMaxKph ?? DEFAULT_BRAKING_ZONE_CONFIG.vMaxKph,
    longStraightM: config.longStraightM ?? DEFAULT_BRAKING_ZONE_CONFIG.longStraightM,
  };
  validateConfig(resolved);

  const profile = reference === null ? null : buildSpeedProfile(reference, totalLengthM);
  return corners.map((corner, index) => {
    const previousCorner = corners[modulo(index - 1, corners.length)];
    if (previousCorner === undefined) throw new RangeError('corners must not be sparse');
    const fallback = physicsZone(corner, previousCorner, totalLengthM, resolved);
    if (profile === null) return fallback;

    const brakeStartDistanceM = referenceBrakeStart(
      profile,
      previousCorner.exitDistanceM,
      corner.entryDistanceM,
      resolved.decelOnsetThreshold,
    );
    const entrySpeedMps = speedAt(profile, corner.entryDistanceM);
    const apexSpeedMps = minimumSpeed(profile, corner.entryDistanceM, corner.exitDistanceM);
    if (
      brakeStartDistanceM === null ||
      entrySpeedMps === null ||
      apexSpeedMps === null ||
      apexSpeedMps > entrySpeedMps * 1.25
    ) {
      return fallback;
    }

    const availableM = forwardDistance(
      previousCorner.exitDistanceM,
      corner.entryDistanceM,
      totalLengthM,
    );
    const derivedDistanceM = forwardDistance(
      brakeStartDistanceM,
      corner.entryDistanceM,
      totalLengthM,
    );
    const clampedDistanceM = Math.min(availableM, derivedDistanceM);
    return {
      cornerId: corner.id,
      brakeStartDistanceM: modulo(corner.entryDistanceM - clampedDistanceM, totalLengthM),
      source: 'reference',
      entrySpeedKph: entrySpeedMps * KPH_PER_MPS,
      apexSpeedKph: apexSpeedMps * KPH_PER_MPS,
      brakeCueAvailable: clampedDistanceM > DISTANCE_EPSILON_M,
    };
  });
}
