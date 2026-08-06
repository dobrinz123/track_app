import type { CircuitProfile, LocalPoint, LocationSample } from '../contracts';
import { polylineLength } from '../geometry';
import { validateProfile, type RuntimeProfile } from '../profile';

import { SeededPrng } from './prng';

export interface FixtureMetadata {
  scenario: string;
  seed: number;
  expectedOutcome: string;
}

export type TelemetryFixture = LocationSample[] & { readonly metadata: FixtureMetadata };

export interface SpeedProfileContext {
  distanceM: number;
  progress: number;
  lapIndex: number;
}

export interface DriveLapOptions {
  seed?: number;
  sampleRateHz?: number;
  noiseSigmaM?: number;
  accuracyM?: number | ((sampleIndex: number) => number);
  startDistanceM?: number;
  endPaddingM?: number;
  direction?: 'forward' | 'reverse';
  lapCount?: number;
  tStartMono?: number;
  speedMps?: number | ((context: SpeedProfileContext) => number);
  lateralOffsetM?: (progress: number) => number;
}

export function runtimeFor(profile: CircuitProfile): RuntimeProfile {
  const result = validateProfile(profile);
  if (!result.ok) throw new RangeError(`Invalid circuit profile: ${result.errors.join(', ')}`);
  return result.runtime;
}

export function withFixtureMetadata(
  samples: LocationSample[],
  metadata: FixtureMetadata,
): TelemetryFixture {
  Object.defineProperty(samples, 'metadata', {
    configurable: true,
    enumerable: false,
    writable: false,
    value: Object.freeze({ ...metadata }),
  });
  return samples as TelemetryFixture;
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function pointAtRawDistance(
  runtime: RuntimeProfile,
  rawDistanceM: number,
): { point: LocalPoint; tangent: LocalPoint } {
  const points = runtime.centerline;
  const cumulative = runtime.cumulativeDistancesM;
  const totalLengthM = polylineLength(points);
  const targetM = modulo(rawDistanceM, totalLengthM);
  let segmentIndex = points.length - 1;
  for (let index = 0; index < points.length - 1; index += 1) {
    const nextDistance = cumulative[index + 1];
    if (nextDistance !== undefined && targetM < nextDistance) {
      segmentIndex = index;
      break;
    }
  }
  const a = points[segmentIndex];
  const b = points[(segmentIndex + 1) % points.length];
  if (a === undefined || b === undefined) throw new RangeError('centerline is sparse');
  const startM = cumulative[segmentIndex] ?? 0;
  const lengthM = Math.hypot(b.e - a.e, b.n - a.n);
  const fraction = lengthM === 0 ? 0 : Math.max(0, Math.min(1, (targetM - startM) / lengthM));
  return {
    point: { e: a.e + (b.e - a.e) * fraction, n: a.n + (b.n - a.n) * fraction },
    tangent: { e: (b.e - a.e) / lengthM, n: (b.n - a.n) / lengthM },
  };
}

export function sampleAtLapDistance(
  profile: CircuitProfile,
  distanceM: number,
  tMono: number,
  options: { accuracyM?: number; speedMps?: number; lateralOffsetM?: number } = {},
): LocationSample {
  const runtime = runtimeFor(profile);
  const rawDistanceM = runtime.startFinishGate.distanceM + distanceM;
  const { point, tangent } = pointAtRawDistance(runtime, rawDistanceM);
  const lateralOffsetM = options.lateralOffsetM ?? 0;
  const local = {
    e: point.e - tangent.n * lateralOffsetM,
    n: point.n + tangent.e * lateralOffsetM,
  };
  const geo = runtime.projection.toLatLon(local);
  return {
    tMono,
    lat: geo.lat,
    lon: geo.lon,
    accuracyM: options.accuracyM ?? 3,
    speedMps: options.speedMps ?? 40,
    headingDeg: modulo((Math.atan2(tangent.e, tangent.n) * 180) / Math.PI, 360),
    source: 'replay',
  };
}

function resolvedSpeed(speed: DriveLapOptions['speedMps'], context: SpeedProfileContext): number {
  const value =
    typeof speed === 'function'
      ? speed(context)
      : (speed ?? 42.5 + 12.5 * Math.sin(Math.PI * 2 * context.progress));
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('speedMps must stay positive');
  return value;
}

/**
 * Generates a deterministic kinematic lap around the real profile centerline.
 * It exercises nominal matching, gate interpolation, sector timing, progress
 * unwrapping, optional racing-line offsets, and GNSS-noise tolerance.
 */
export function driveLap(profile: CircuitProfile, options: DriveLapOptions = {}): TelemetryFixture {
  const runtime = runtimeFor(profile);
  const totalLengthM = polylineLength(runtime.centerline);
  const seed = options.seed ?? 1;
  const prng = new SeededPrng(seed);
  const sampleRateHz = options.sampleRateHz ?? 1;
  const intervalMs = 1_000 / sampleRateHz;
  const noiseSigmaM = options.noiseSigmaM ?? 2.5;
  const startDistanceM = options.startDistanceM ?? -20;
  const endPaddingM = options.endPaddingM ?? 20;
  const lapCount = options.lapCount ?? 1;
  const sign = options.direction === 'reverse' ? -1 : 1;
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new RangeError('sampleRateHz must be positive');
  }
  if (!Number.isInteger(lapCount) || lapCount < 1)
    throw new RangeError('lapCount must be positive');
  if (!Number.isFinite(noiseSigmaM) || noiseSigmaM < 0) {
    throw new RangeError('noiseSigmaM must be non-negative');
  }

  const travelTargetM = lapCount * totalLengthM + endPaddingM - startDistanceM;
  const samples: LocationSample[] = [];
  let travelledM = 0;
  let tMono = options.tStartMono ?? 0;
  while (true) {
    const signedDistanceM = startDistanceM + sign * travelledM;
    const progress = modulo(signedDistanceM, totalLengthM) / totalLengthM;
    const lapIndex = Math.max(0, Math.floor((signedDistanceM - startDistanceM) / totalLengthM));
    const speedMps = resolvedSpeed(options.speedMps, {
      distanceM: signedDistanceM,
      progress,
      lapIndex,
    });
    const { point, tangent } = pointAtRawDistance(
      runtime,
      runtime.startFinishGate.distanceM + signedDistanceM,
    );
    const directedTangent = { e: tangent.e * sign, n: tangent.n * sign };
    const lateralOffsetM = options.lateralOffsetM?.(progress) ?? 0;
    const local = {
      e: point.e - tangent.n * lateralOffsetM + prng.gaussian() * noiseSigmaM,
      n: point.n + tangent.e * lateralOffsetM + prng.gaussian() * noiseSigmaM,
    };
    const geo = runtime.projection.toLatLon(local);
    const sampleIndex = samples.length;
    const accuracyM =
      typeof options.accuracyM === 'function'
        ? options.accuracyM(sampleIndex)
        : (options.accuracyM ?? Math.max(3, noiseSigmaM));
    samples.push({
      tMono,
      lat: geo.lat,
      lon: geo.lon,
      accuracyM,
      speedMps,
      headingDeg: modulo((Math.atan2(directedTangent.e, directedTangent.n) * 180) / Math.PI, 360),
      source: 'replay',
    });
    if (travelledM >= travelTargetM) break;
    const stepM = Math.min(travelTargetM - travelledM, speedMps / sampleRateHz);
    travelledM += stepM;
    tMono += (stepM / speedMps) * 1_000 || intervalMs;
  }

  return withFixtureMetadata(samples, {
    scenario: 'driveLap',
    seed,
    expectedOutcome: 'Nominal samples match the centerline and produce interpolated timing gates.',
  });
}
