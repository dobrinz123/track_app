import type { CircuitProfile, Gate, LatLon, LocalPoint } from '../contracts';
import { createProjection, polylineLength } from '../geometry';

import { CURRENT_SCHEMA_VERSION } from './schema';

export type TestProfileOptions = Partial<CircuitProfile>;

const TEST_ORIGIN: LatLon = { lat: 45, lon: 25 };

function superellipsePoint(angle: number): LocalPoint {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    e: 325 * Math.sign(cosine) * Math.sqrt(Math.abs(cosine)),
    n: 225 * Math.sign(sine) * Math.sqrt(Math.abs(sine)),
  };
}

function gateAt(point: LocalPoint, id: string, kind: Gate['kind'], sectorIndex?: number): Gate {
  const projection = createProjection(TEST_ORIGIN);
  const magnitude = Math.hypot(point.e, point.n);
  const radialE = point.e / magnitude;
  const radialN = point.n / magnitude;
  return {
    id,
    kind,
    a: projection.toLatLon({ e: point.e - radialE * 15, n: point.n - radialN * 15 }),
    b: projection.toLatLon({ e: point.e + radialE * 15, n: point.n + radialN * 15 }),
    ...(sectorIndex === undefined ? {} : { sectorIndex }),
  };
}

export function makeTestProfile(options: TestProfileOptions = {}): CircuitProfile {
  const projection = createProjection(TEST_ORIGIN);
  const localCenterline = Array.from({ length: 80 }, (_, index) =>
    superellipsePoint((index / 80) * Math.PI * 2),
  );
  const centerline = localCenterline.map((point) => projection.toLatLon(point));
  const projectedCenterline = centerline.map((point) => projection.toLocal(point));
  const totalLengthM = polylineLength(projectedCenterline);
  const maximumRadiusM = Math.max(...projectedCenterline.map((point) => Math.hypot(point.e, point.n)));

  const base: CircuitProfile = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    circuitId: 'dev-test-ring',
    displayName: 'Dev Test Ring (synthetic)',
    country: 'Synthetic',
    locality: 'Test Fixture',
    layoutId: 'rounded-rectangle',
    layoutVersion: 1,
    source: { name: 'Generated test fixture' },
    geometryStatus: 'dev-only',
    sectorStatus: 'app-defined',
    direction: 'counterclockwise',
    centerline,
    totalLengthM,
    startFinishGate: gateAt(localCenterline[0] as LocalPoint, 'start-finish', 'startFinish'),
    sectorGates: [
      gateAt(localCenterline[27] as LocalPoint, 'sector-1', 'sector', 1),
      gateAt(localCenterline[53] as LocalPoint, 'sector-2', 'sector', 2),
    ],
    boundingRegion: { center: TEST_ORIGIN, radiusM: maximumRadiusM + 1 },
    corridorWidthM: 20,
    createdAtUtc: '2025-01-01T00:00:00.000Z',
    updatedAtUtc: '2025-01-01T00:00:00.000Z',
    confidenceNotes: 'Synthetic geometry for automated tests only.',
  };
  return { ...base, ...options };
}

