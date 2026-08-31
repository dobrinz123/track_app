import type { CircuitProfile, Corner, Gate, LatLon, LocalPoint, LocationSample } from '../contracts';
import { createProjection } from '../geometry';
import { CURRENT_SCHEMA_VERSION, validateProfile, type RuntimeProfile } from '../profile';

import { resolveTestLoopConfig, type TestLoopConfigOverrides } from './config';
import { buildLoopCentreline, type LoopCentreline } from './centreline';
import { detectLoopClosure, type LoopClosure, type LoopClosureFailureReason } from './loopClosure';
import { deriveTestLoopCorners, type TestLoopCornerDerivation } from './syntheticCorners';

/**
 * Ticket P5d T1(d) -- the learned loop as a `CircuitProfile` + `RuntimeProfile`
 * the rest of the app already knows how to drive.
 *
 * Two honesty rules are built into the shape of this file, not bolted on:
 *
 *  - `geometryStatus` is ALWAYS `'ad-hoc'`. It is written here as a constant,
 *    never taken from a caller, so a learned circuit can never present itself
 *    as surveyed geometry. Every gate that asks "has this geometry been
 *    validated on track?" (`analysisAssembly`'s `geometryValidated`, and the
 *    suggestion engine behind it) therefore answers NO by construction.
 *  - the profile is built as data and then pushed through `validateProfile` --
 *    the SAME validation the bundled circuit assets go through. A learned loop
 *    that cannot pass it is a NAMED failure, never a half-built circuit handed
 *    to the timing pipeline.
 */

/** The one geometry status a learned/test loop may ever carry. */
export const TEST_LOOP_GEOMETRY_STATUS = 'ad-hoc' as const;
/** Layout id every learned circuit shares -- it has exactly one layout, its own. */
export const TEST_LOOP_LAYOUT_ID = 'learned';
export const TEST_LOOP_LAYOUT_VERSION = 1;

/** True for geometry learned from a lap rather than surveyed. The gate every honesty check reads. */
export function isLearnedGeometry(profile: Pick<CircuitProfile, 'geometryStatus'>): boolean {
  return profile.geometryStatus === TEST_LOOP_GEOMETRY_STATUS;
}

export interface BuildTestLoopCircuitOptions {
  /** Stable id for the learned circuit (the mobile layer generates it). */
  circuitId: string;
  /** What the driver calls it. */
  displayName: string;
  /** ISO instant the loop was learned. */
  createdAtUtc: string;
  country?: string;
  locality?: string;
  config?: TestLoopConfigOverrides;
}

export type TestLoopFailureReason = LoopClosureFailureReason | 'profile-invalid';

export interface TestLoopCircuit {
  profile: CircuitProfile;
  runtime: RuntimeProfile;
  corners: Corner[];
  closure: LoopClosure;
  centreline: LoopCentreline;
  cornerDerivation: TestLoopCornerDerivation;
}

export type BuildTestLoopCircuitResult =
  | ({ ok: true } & TestLoopCircuit)
  | {
      ok: false;
      reason: TestLoopFailureReason;
      /** Present for `profile-invalid`: the validator's own machine-readable codes. */
      errors?: string[];
      /** Present for a closure failure: how far the driver drove, metres. */
      travelledM?: number;
    };

const RAD_TO_DEG = 180 / Math.PI;

/**
 * The start/finish gate: a segment across the road at the start point,
 * perpendicular to the direction the driver was travelling, directed so that
 * driving the loop's own direction reads as a FORWARD crossing
 * (`crossingDirection`: cross(gate, motion) > 0).
 */
function startFinishGate(
  centre: LocalPoint,
  headingDeg: number,
  lengthM: number,
  toLatLon: (point: LocalPoint) => LatLon,
): Gate {
  const headingRad = headingDeg / RAD_TO_DEG;
  const motion = { e: Math.sin(headingRad), n: Math.cos(headingRad) };
  const gate = { e: motion.n, n: -motion.e };
  const half = lengthM / 2;
  return {
    id: 'sf',
    kind: 'startFinish',
    a: toLatLon({ e: centre.e - gate.e * half, n: centre.n - gate.n * half }),
    b: toLatLon({ e: centre.e + gate.e * half, n: centre.n + gate.n * half }),
  };
}

/**
 * Learns a circuit from a raw GNSS trace whose first lap closes a loop.
 * Never throws for a trace that simply is not a loop -- that is a named
 * outcome the driver gets told about.
 */
export function buildTestLoopCircuit(
  samples: readonly LocationSample[],
  options: BuildTestLoopCircuitOptions,
): BuildTestLoopCircuitResult {
  const config = resolveTestLoopConfig(options.config ?? {});
  const closureResult = detectLoopClosure(samples, options.config ?? {});
  if (!closureResult.closed) {
    return {
      ok: false,
      reason: closureResult.reason,
      travelledM: closureResult.travelledM,
    };
  }
  const closure = closureResult.closure;
  const centreline = buildLoopCentreline(samples, closure, options.config ?? {});

  const projection = createProjection(centreline.origin);
  const first = centreline.local[0];
  if (first === undefined) {
    return { ok: false, reason: 'profile-invalid', errors: ['CENTERLINE_EMPTY'] };
  }
  const radiusM =
    centreline.local.reduce((worst, point) => Math.max(worst, Math.hypot(point.e, point.n)), 0) + 25;

  const profile: CircuitProfile = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    circuitId: options.circuitId,
    displayName: options.displayName,
    country: options.country ?? '',
    locality: options.locality ?? '',
    layoutId: TEST_LOOP_LAYOUT_ID,
    layoutVersion: TEST_LOOP_LAYOUT_VERSION,
    source: {
      name: 'Learned on device from lap 1 (Test loop)',
      retrievedAt: options.createdAtUtc,
    },
    geometryStatus: TEST_LOOP_GEOMETRY_STATUS,
    sectorStatus: 'app-defined',
    direction: centreline.direction,
    centerline: centreline.points,
    totalLengthM: centreline.totalLengthM,
    startFinishGate: startFinishGate(
      first,
      centreline.startHeadingDeg,
      config.corridorWidthM,
      (point) => projection.toLatLon(point),
    ),
    sectorGates: [],
    boundingRegion: { center: centreline.origin, radiusM },
    corridorWidthM: config.corridorWidthM,
    createdAtUtc: options.createdAtUtc,
    updatedAtUtc: options.createdAtUtc,
    confidenceNotes:
      'Ad-hoc geometry learned from a single lap on device. Not surveyed, not validated on track.',
  };

  const validated = validateProfile(profile);
  if (!validated.ok) {
    return { ok: false, reason: 'profile-invalid', errors: validated.errors };
  }

  const lapSamples = samples.slice(closure.startIndex, closure.closeIndex + 1);
  const cornerDerivation = deriveTestLoopCorners(
    validated.runtime,
    lapSamples,
    options.config ?? {},
  );

  return {
    ok: true,
    profile: validated.profile,
    runtime: validated.runtime,
    corners: cornerDerivation.corners,
    closure,
    centreline,
    cornerDerivation,
  };
}
