import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { LatLon } from '../../src/contracts';
import {
  generateMotorparkProfile,
  MOTORPARK_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M,
  serializeMotorparkProfile,
} from '../../scripts/generate-motorpark-profile';
import { analyzeCorners } from '../../src/corners';
import { curvatureAtDistance, polylineCumulative } from '../../src/geometry';
import { loadProfileFromJson } from '../../src/profile/loader';

const ASSET_URL = new URL('../../assets/circuits/motorpark-romania.v1.json', import.meta.url);
const assetJson = readFileSync(ASSET_URL, 'utf8');

// --- Raw archived Overpass data, read directly by THIS test file (NOT via the
// generator's helpers) so the pin below is an independent check on the asset,
// per ticket CN-FIX1 F2. ---
const RAW_GEOMETRY_URL = new URL(
  '../../../../data/osm/overpass-motorpark-geom.json',
  import.meta.url,
);
const rawGeometryJson = JSON.parse(readFileSync(RAW_GEOMETRY_URL, 'utf8')) as {
  elements: Array<{ type: string; id: number; nodes: number[]; geometry: LatLon[] }>;
};

function rawWay(wayId: number): { nodes: number[]; geometry: LatLon[] } {
  const way = rawGeometryJson.elements.find(
    (element) => element.type === 'way' && element.id === wayId,
  );
  if (way === undefined) throw new Error(`Raw Overpass data has no way ${wayId}`);
  return { geometry: way.geometry, nodes: way.nodes };
}

const MAIN_LOOP_WAY_ID = 333_031_201;
const EXTENSION_WAY_ID = 949_617_051;
const PIT_SE_WAY_ID = 953_930_215;
const PIT_NW_WAY_ID = 953_930_214;

const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;

function haversineM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLon = (b.lon - a.lon) * DEG_TO_RAD;
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function polylineHaversineLengthM(points: LatLon[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) throw new Error('Sparse polyline');
    total += haversineM(previous, current);
  }
  return total;
}

describe('MotorPark România generated v1 profile asset', () => {
  it('is deterministic across independent generation calls and matches checked-in bytes', () => {
    const first = generateMotorparkProfile();
    const second = generateMotorparkProfile();
    expect(first).toEqual(second);
    expect(serializeMotorparkProfile(first)).toBe(assetJson);
  });

  it('loads through the production loader with zero validation errors', () => {
    const result = loadProfileFromJson(assetJson);
    expect(result.ok).toBe(true);
    if (!result.ok) expect(result.errors).toEqual([]);
  });

  it('matches the published length within 1%', () => {
    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    expect(Math.abs(result.profile.totalLengthM - 4_052) / 4_052).toBeLessThanOrEqual(0.01);
  });

  it('places all timing gates (S/F, sectors, pit entry/exit) on stretches below the straight-curvature threshold', () => {
    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    if (result.runtime.pitLane === undefined) throw new Error('Profile has no pit lane');
    const cumulative = polylineCumulative(result.runtime.centerline);
    const gateDistances = [
      result.runtime.startFinishGate.distanceM,
      ...result.runtime.sectorGates.map((gate) => gate.distanceM),
      result.runtime.pitLane.entryGate.distanceM,
      result.runtime.pitLane.exitGate.distanceM,
    ];
    for (const distanceM of gateDistances) {
      const curvatureRadPerM = Math.abs(
        curvatureAtDistance(result.runtime.centerline, cumulative, true, distanceM, 40),
      );
      expect(curvatureRadPerM).toBeLessThan(MOTORPARK_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M);
    }
  });

  it('produces a runtime whose cumulative distances add up to the total lap length', () => {
    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    expect(result.runtime.centerline.length).toBe(result.profile.centerline.length);
    expect(result.runtime.cumulativeDistancesM.length).toBe(result.runtime.centerline.length);
    const lastCumulative =
      result.runtime.cumulativeDistancesM[result.runtime.cumulativeDistancesM.length - 1];
    const lastPoint = result.runtime.centerline[result.runtime.centerline.length - 1];
    const firstPoint = result.runtime.centerline[0];
    if (lastCumulative === undefined || lastPoint === undefined || firstPoint === undefined) {
      throw new Error('Runtime centerline is empty');
    }
    // Cumulative distances only cover the open polyline; add the closing
    // segment back in the local plane to get the true closed-loop length.
    const closingSegmentM = Math.hypot(
      firstPoint.e - lastPoint.e,
      firstPoint.n - lastPoint.n,
    );
    expect(lastCumulative + closingSegmentM).toBeCloseTo(result.profile.totalLengthM, 3);
  });

  it('independently rebuilds the spliced centerline from raw node ids and pins it to the asset (ticket CN-FIX1 F2a/b)', () => {
    const main = rawWay(MAIN_LOOP_WAY_ID);
    const extension = rawWay(EXTENSION_WAY_ID);

    const spliceStartIndex = main.nodes.indexOf(extension.nodes[0]!);
    const spliceEndIndex = main.nodes.indexOf(extension.nodes[extension.nodes.length - 1]!);
    expect(spliceStartIndex).toBe(74);
    expect(spliceEndIndex).toBe(79);

    const rebuiltIds = [
      ...main.nodes.slice(0, spliceStartIndex + 1),
      ...extension.nodes.slice(1, -1),
      ...main.nodes.slice(spliceEndIndex),
    ];
    const rebuiltGeometry = [
      ...main.geometry.slice(0, spliceStartIndex + 1),
      ...extension.geometry.slice(1, -1),
      ...main.geometry.slice(spliceEndIndex),
    ];

    // Rotate the closed (duplicated-endpoint) rebuild so it starts at the S/F
    // seam node (main.nodes[0]) -- a no-op here since the splice already
    // starts there, but done generically rather than assumed.
    const seamNodeId = main.nodes[0]!;
    const seamIndex = rebuiltIds.indexOf(seamNodeId);
    expect(seamIndex).toBe(0);
    const rotatedGeometry = [
      ...rebuiltGeometry.slice(seamIndex, -1),
      ...rebuiltGeometry.slice(0, seamIndex),
    ];

    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    expect(result.profile.centerline.length).toBe(rotatedGeometry.length);
    for (let index = 0; index < rotatedGeometry.length; index += 1) {
      const expectedPoint = rotatedGeometry[index]!;
      const actualPoint = result.profile.centerline[index]!;
      expect(actualPoint.lat).toBeCloseTo(expectedPoint.lat, 7);
      expect(actualPoint.lon).toBeCloseTo(expectedPoint.lon, 7);
    }

    // (b) S/F gate midpoint = the main-loop seam node coordinates.
    const seamPoint = main.geometry[0]!;
    const gate = result.profile.startFinishGate;
    const midLat = (gate.a.lat + gate.b.lat) / 2;
    const midLon = (gate.a.lon + gate.b.lon) / 2;
    expect(Math.abs(midLat - seamPoint.lat)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(midLon - seamPoint.lon)).toBeLessThanOrEqual(1e-6);
  });

  it('independently pins the pit-lane polyline true topology and geometry (ticket CN-FIX1 F1/F2c)', () => {
    const pitSe = rawWay(PIT_SE_WAY_ID);
    const pitNw = rawWay(PIT_NW_WAY_ID);

    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    if (result.profile.pitLane === undefined) throw new Error('Profile has no pit lane');
    const polyline = result.profile.pitLane.polyline;

    const expectedFirst = pitSe.geometry[0]!;
    const expectedLast = pitNw.geometry[pitNw.geometry.length - 1]!;
    const actualFirst = polyline[0]!;
    const actualLast = polyline[polyline.length - 1]!;
    expect(actualFirst.lat).toBeCloseTo(expectedFirst.lat, 7);
    expect(actualFirst.lon).toBeCloseTo(expectedFirst.lon, 7);
    expect(actualLast.lat).toBeCloseTo(expectedLast.lat, 7);
    expect(actualLast.lon).toBeCloseTo(expectedLast.lon, 7);

    // No two consecutive identical points.
    for (let index = 1; index < polyline.length; index += 1) {
      const previous = polyline[index - 1]!;
      const current = polyline[index]!;
      const isSame = previous.lat === current.lat && previous.lon === current.lon;
      expect(isSame, `polyline[${index - 1}] duplicates polyline[${index}]`).toBe(false);
    }

    // No backtracking: heading must never reverse by more than 150 degrees
    // between consecutive segments (independent planar check, local to this
    // test -- not the generator's projection).
    const origin = polyline[0]!;
    const lonScale = Math.cos(origin.lat * DEG_TO_RAD);
    const local = polyline.map((point) => ({
      e: EARTH_RADIUS_M * (point.lon - origin.lon) * DEG_TO_RAD * lonScale,
      n: EARTH_RADIUS_M * (point.lat - origin.lat) * DEG_TO_RAD,
    }));
    for (let index = 1; index < local.length - 1; index += 1) {
      const previous = local[index - 1]!;
      const current = local[index]!;
      const next = local[index + 1]!;
      const inHeadingDeg =
        Math.atan2(current.e - previous.e, current.n - previous.n) * (180 / Math.PI);
      const outHeadingDeg = Math.atan2(next.e - current.e, next.n - current.n) * (180 / Math.PI);
      const turnDeg = Math.abs(((outHeadingDeg - inHeadingDeg + 540) % 360) - 180);
      expect(turnDeg, `backtracking at vertex ${index}`).toBeLessThanOrEqual(150);
    }

    const lengthM = polylineHaversineLengthM(polyline);
    expect(Math.abs(lengthM - 637.5)).toBeLessThanOrEqual(2);
  });

  it('matches the LEAD-verified corner sequence against the published LapMeta CW track map', () => {
    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    const corners = analyzeCorners(result.runtime);

    // LEAD verdict (ticket CN-W1 follow-up): 10 corners map onto the published
    // 16-turn LapMeta CW track map as C1=T1, C2=T4, C3=T5, C4=T6, C5=T7, C6=T9,
    // C7=T10, C8=T13+T14, C9=T15, C10=T16 -- T2/T3/T8/T11/T12 are gentle kinks
    // (radius > 125 m) that fall below the corner-detection curvature threshold
    // by design. See .foreman/scratch/motorpark-corners-report.md.
    expect(corners.length).toBe(10);
    expect(corners.map((corner) => corner.direction)).toEqual([
      'right',
      'right',
      'left',
      'left',
      'right',
      'right',
      'left',
      'right',
      'right',
      'left',
    ]);

    for (let index = 1; index < corners.length; index += 1) {
      const previous = corners[index - 1];
      const current = corners[index];
      if (previous === undefined || current === undefined) throw new Error('Corners are sparse');
      expect(current.entryDistanceM).toBeGreaterThan(previous.entryDistanceM);
    }

    // Corner 8 is a LEAD-verified same-direction compound (T13+T14 on the
    // published map, both right-handers with no real gap between them) --
    // its wide ~198 degree arc is legitimate, NOT the opposite-sign
    // direction-split merge bug the M-direction-split fix (CORNER_ANALYSIS_VERSION
    // 3) guards against. If a future algorithm change splits this compound into
    // two corners, that must be a deliberate, reviewed change to this pin --
    // not a silent regression.
    const compoundCorner = corners[7];
    if (compoundCorner === undefined) throw new Error('Corner 8 is missing');
    expect(compoundCorner.totalAngleDeg).toBeGreaterThan(150);
  });
});
