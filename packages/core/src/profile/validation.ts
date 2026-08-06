import type { CircuitProfile, Gate, GeoProjection, LocalPoint } from '../contracts';
import {
  createProjection,
  polylineCumulative,
  polylineLength,
  projectOntoPolyline,
} from '../geometry';

import { circuitProfileSchema } from './schema';

export interface ProjectedGate {
  gate: Gate;
  a: LocalPoint;
  b: LocalPoint;
  distanceM: number;
}

export interface RuntimeProfile {
  projection: GeoProjection;
  centerline: LocalPoint[];
  cumulativeDistancesM: number[];
  startFinishGate: ProjectedGate;
  sectorGates: ProjectedGate[];
  pitLane?: {
    polyline: LocalPoint[];
    cumulativeDistancesM: number[];
    entryGate: ProjectedGate;
    exitGate: ProjectedGate;
  };
}

export type ProfileValidationResult =
  | { ok: true; profile: CircuitProfile; runtime: RuntimeProfile }
  | { ok: false; errors: string[] };

const distance = (a: LocalPoint, b: LocalPoint): number => Math.hypot(b.e - a.e, b.n - a.n);

function structuralErrors(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
    return `STRUCTURE:${path}: ${issue.message}`;
  });
}

function projectGate(
  gate: Gate,
  projection: GeoProjection,
  centerline: LocalPoint[],
  cumulative: number[],
): ProjectedGate {
  const a = projection.toLocal(gate.a);
  const b = projection.toLocal(gate.b);
  const midpoint = { e: (a.e + b.e) / 2, n: (a.n + b.n) / 2 };
  return {
    gate,
    a,
    b,
    distanceM: projectOntoPolyline(midpoint, centerline, cumulative, true).distanceM,
  };
}

function endpointNearLine(
  point: LocalPoint,
  line: LocalPoint[],
  cumulative: number[],
  closed: boolean,
  maximumM: number,
): boolean {
  const projected = projectOntoPolyline(point, line, cumulative, closed);
  const toleranceM = Math.max(1, maximumM) * 1e-9;
  return distance(point, projected.point) <= maximumM + toleranceM;
}

function circularDistance(a: number, b: number, total: number): number {
  const direct = Math.abs(a - b);
  return Math.min(direct, total - direct);
}

export function validateProfile(raw: unknown): ProfileValidationResult {
  const parsed = circuitProfileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: structuralErrors(parsed.error) };

  const profile = parsed.data;
  const errors: string[] = [];
  let projection: GeoProjection;
  try {
    projection = createProjection(profile.boundingRegion.center);
  } catch {
    return { ok: false, errors: ['PROJECTION_INVALID'] };
  }

  const centerline = profile.centerline.map((point) => projection.toLocal(point));
  const cumulativeDistancesM = polylineCumulative(centerline);
  const computedLengthM = polylineLength(centerline);

  if (centerline.length < 50) errors.push('CENTERLINE_TOO_FEW_VERTICES');
  for (let index = 1; index < centerline.length; index += 1) {
    const previous = centerline[index - 1];
    const current = centerline[index];
    if (previous !== undefined && current !== undefined && distance(previous, current) < 0.5) {
      errors.push('CENTERLINE_CONSECUTIVE_DUPLICATE');
      break;
    }
  }

  const first = centerline[0];
  const last = centerline[centerline.length - 1];
  if (
    first === undefined ||
    last === undefined ||
    computedLengthM <= 0 ||
    distance(last, first) >= computedLengthM * 0.05
  ) {
    errors.push('CENTERLINE_NOT_PLAUSIBLY_CLOSED');
  }

  if (
    computedLengthM <= 0 ||
    Math.abs(profile.totalLengthM - computedLengthM) / computedLengthM > 0.005
  ) {
    errors.push('TOTAL_LENGTH_MISMATCH');
  }
  if (profile.corridorWidthM < 5 || profile.corridorWidthM > 60) {
    errors.push('CORRIDOR_WIDTH_OUT_OF_RANGE');
  }

  const origin = { e: 0, n: 0 };
  if (
    profile.boundingRegion.radiusM < 0 ||
    centerline.some((point) => distance(origin, point) > profile.boundingRegion.radiusM)
  ) {
    errors.push('BOUNDING_REGION_EXCLUDES_CENTERLINE');
  }

  if (centerline.length < 2 || computedLengthM <= 0) {
    return { ok: false, errors: [...new Set(errors)] };
  }

  const projectedStartFinish = projectGate(
    profile.startFinishGate,
    projection,
    centerline,
    cumulativeDistancesM,
  );
  const projectedSectors = profile.sectorGates.map((gate) =>
    projectGate(gate, projection, centerline, cumulativeDistancesM),
  );
  const allProjectedGates = [projectedStartFinish, ...projectedSectors];
  const maximumGateDistanceM = profile.corridorWidthM * 3;

  for (const gate of allProjectedGates) {
    if (
      !endpointNearLine(gate.a, centerline, cumulativeDistancesM, true, maximumGateDistanceM) ||
      !endpointNearLine(gate.b, centerline, cumulativeDistancesM, true, maximumGateDistanceM)
    ) {
      errors.push('GATE_ENDPOINT_TOO_FAR_FROM_CENTERLINE');
    }
    const lengthM = distance(gate.a, gate.b);
    if (lengthM < 2) errors.push('GATE_TOO_SHORT');
    if (lengthM > 100) errors.push('GATE_TOO_LONG');
  }

  for (let index = 1; index < projectedSectors.length; index += 1) {
    const previous = projectedSectors[index - 1];
    const current = projectedSectors[index];
    if (previous !== undefined && current !== undefined && current.distanceM <= previous.distanceM) {
      errors.push('SECTOR_GATES_NOT_STRICTLY_ORDERED');
      break;
    }
  }
  for (let index = 0; index < projectedSectors.length; index += 1) {
    const gate = projectedSectors[index];
    if (gate === undefined) continue;
    if (circularDistance(gate.distanceM, projectedStartFinish.distanceM, computedLengthM) < 30) {
      errors.push('SECTOR_GATE_TOO_CLOSE_TO_START_FINISH');
    }
    for (let otherIndex = index + 1; otherIndex < projectedSectors.length; otherIndex += 1) {
      const other = projectedSectors[otherIndex];
      if (
        other !== undefined &&
        circularDistance(gate.distanceM, other.distanceM, computedLengthM) < 30
      ) {
        errors.push('SECTOR_GATES_TOO_CLOSE');
      }
    }
  }

  let runtimePitLane: RuntimeProfile['pitLane'];
  if (profile.pitLane !== undefined) {
    const pitPolyline = profile.pitLane.polyline.map((point) => projection.toLocal(point));
    const pitCumulative = polylineCumulative(pitPolyline);
    const pitLengthM = pitCumulative[pitCumulative.length - 1] ?? 0;
    if (pitPolyline.length < 2) errors.push('PIT_POLYLINE_TOO_FEW_VERTICES');
    if (pitLengthM <= 0) errors.push('PIT_POLYLINE_DEGENERATE');

    if (pitPolyline.length >= 2 && pitLengthM > 0) {
      const entryGate = projectGate(
        profile.pitLane.entryGate,
        projection,
        centerline,
        cumulativeDistancesM,
      );
      const exitGate = projectGate(
        profile.pitLane.exitGate,
        projection,
        centerline,
        cumulativeDistancesM,
      );
      for (const gate of [entryGate, exitGate]) {
        for (const endpoint of [gate.a, gate.b]) {
          if (
            !endpointNearLine(endpoint, centerline, cumulativeDistancesM, true, maximumGateDistanceM) ||
            !endpointNearLine(endpoint, pitPolyline, pitCumulative, false, maximumGateDistanceM)
          ) {
            errors.push('PIT_GATE_ENDPOINT_TOO_FAR_FROM_REQUIRED_LINE');
          }
        }
        const lengthM = distance(gate.a, gate.b);
        if (lengthM < 2) errors.push('GATE_TOO_SHORT');
        if (lengthM > 100) errors.push('GATE_TOO_LONG');
      }
      runtimePitLane = {
        polyline: pitPolyline,
        cumulativeDistancesM: pitCumulative,
        entryGate,
        exitGate,
      };
    }
  }

  const uniqueErrors = [...new Set(errors)];
  if (uniqueErrors.length > 0) return { ok: false, errors: uniqueErrors };
  return {
    ok: true,
    profile,
    runtime: {
      projection,
      centerline,
      cumulativeDistancesM,
      startFinishGate: projectedStartFinish,
      sectorGates: projectedSectors,
      ...(runtimePitLane === undefined ? {} : { pitLane: runtimePitLane }),
    },
  };
}
