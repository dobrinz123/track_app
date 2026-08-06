import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CircuitProfile, Gate, LatLon, LocalPoint } from '../src/contracts';

const CENTERLINE_WAY_ID = 488429454;
const PIT_LANE_WAY_ID = 488429716;
const RESEARCH_LENGTH_M = 3_708;
const RESEARCH_LENGTH_TOLERANCE = 0.01;
const CORRIDOR_WIDTH_M = 15;
const GATE_WIDTH_M = CORRIDOR_WIDTH_M * 2;
export const TMR_CURVATURE_HALF_WINDOW_M = 40;
export const TMR_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M = 0.008;
const SECTOR_SNAP_HALF_WINDOW_M = 180;
const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

const GEOMETRY_INPUT_URL = new URL('../../../data/osm/overpass-tmr-geom.json', import.meta.url);
const TAGS_INPUT_URL = new URL('../../../data/osm/overpass-tmr-tags.json', import.meta.url);
const OUTPUT_DIRECTORY_URL = new URL('../assets/circuits/', import.meta.url);

type TmrLayoutVersion = 1 | 2;

interface OSMWay {
  geometry: LatLon[];
  id: number;
  nodes: number[];
  tags: Record<string, string>;
}

interface Projection {
  toLatLon(point: LocalPoint): LatLon;
  toLocal(point: LatLon): LocalPoint;
}

interface LinePosition {
  point: LocalPoint;
  tangent: LocalPoint;
}

interface ClosedProjection extends LinePosition {
  distanceM: number;
  segmentIndex: number;
  segmentParameter: number;
}

interface SectorPlacement {
  curvatureRadPerM: number;
  distanceM: number;
  fellBack: boolean;
  position: LinePosition;
}

interface VertexCurvature {
  curvatureRadPerM: number;
  distanceM: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requireWay(json: string, wayId: number, label: string): OSMWay {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || !Array.isArray(parsed.elements)) {
    throw new Error(`${label} is not an Overpass extract`);
  }
  const rawWay = parsed.elements.find(
    (element) => isRecord(element) && element.type === 'way' && element.id === wayId,
  );
  if (!isRecord(rawWay)) throw new Error(`${label} does not contain way ${wayId}`);

  const rawGeometry = rawWay.geometry;
  const rawNodes = rawWay.nodes;
  const rawTags = rawWay.tags;
  const geometry = Array.isArray(rawGeometry)
    ? rawGeometry.map((point, index) => {
        if (!isRecord(point)) throw new Error(`${label} geometry[${index}] is invalid`);
        return {
          lat: requireFiniteNumber(point.lat, `${label} geometry[${index}].lat`),
          lon: requireFiniteNumber(point.lon, `${label} geometry[${index}].lon`),
        };
      })
    : [];
  const nodes = Array.isArray(rawNodes)
    ? rawNodes.map((node, index) => requireFiniteNumber(node, `${label} nodes[${index}]`))
    : [];
  const tags: Record<string, string> = {};
  if (isRecord(rawTags)) {
    for (const [key, value] of Object.entries(rawTags)) {
      if (typeof value === 'string') tags[key] = value;
    }
  }
  return { geometry, id: wayId, nodes, tags };
}

function requireTagWay(json: string, wayId: number): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || !Array.isArray(parsed.elements)) {
    throw new Error('OSM tags input is not an Overpass extract');
  }
  const rawWay = parsed.elements.find(
    (element) => isRecord(element) && element.type === 'way' && element.id === wayId,
  );
  if (!isRecord(rawWay) || !isRecord(rawWay.tags)) {
    throw new Error(`OSM tags input does not contain tags for way ${wayId}`);
  }
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawWay.tags)) {
    if (typeof value === 'string') tags[key] = value;
  }
  return tags;
}

function sameLatLon(a: LatLon, b: LatLon): boolean {
  return a.lat === b.lat && a.lon === b.lon;
}

function centroid(points: LatLon[]): LatLon {
  if (points.length === 0) throw new Error('Cannot compute the centroid of an empty line');
  const sum = points.reduce(
    (accumulator, point) => ({
      lat: accumulator.lat + point.lat,
      lon: accumulator.lon + point.lon,
    }),
    { lat: 0, lon: 0 },
  );
  return { lat: sum.lat / points.length, lon: sum.lon / points.length };
}

function createLocalProjection(origin: LatLon): Projection {
  const longitudeScale = Math.cos(origin.lat * DEG_TO_RAD);
  return {
    toLocal(point) {
      return {
        e: EARTH_RADIUS_M * (point.lon - origin.lon) * DEG_TO_RAD * longitudeScale,
        n: EARTH_RADIUS_M * (point.lat - origin.lat) * DEG_TO_RAD,
      };
    },
    toLatLon(point) {
      return {
        lat: origin.lat + (point.n / EARTH_RADIUS_M) * RAD_TO_DEG,
        lon: origin.lon + (point.e / (EARTH_RADIUS_M * longitudeScale)) * RAD_TO_DEG,
      };
    },
  };
}

function segmentLength(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(b.e - a.e, b.n - a.n);
}

function cumulativeDistances(points: LocalPoint[]): number[] {
  if (points.length === 0) return [];
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) throw new Error('Sparse polyline');
    cumulative.push((cumulative[index - 1] ?? 0) + segmentLength(previous, current));
  }
  return cumulative;
}

function closedLength(points: LocalPoint[]): number {
  if (points.length < 2) throw new Error('A closed line needs at least two points');
  const cumulative = cumulativeDistances(points);
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) throw new Error('Sparse closed line');
  return (cumulative[cumulative.length - 1] ?? 0) + segmentLength(last, first);
}

function openLength(points: LocalPoint[]): number {
  const cumulative = cumulativeDistances(points);
  return cumulative[cumulative.length - 1] ?? 0;
}

function interpolateOpenLine(points: LocalPoint[], distanceM: number): LocalPoint {
  const cumulative = cumulativeDistances(points);
  const totalLengthM = cumulative[cumulative.length - 1] ?? 0;
  if (distanceM < 0 || distanceM > totalLengthM) {
    throw new Error('Open-line interpolation distance is out of range');
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const startM = cumulative[index] ?? 0;
    const endM = cumulative[index + 1] ?? 0;
    if (a !== undefined && b !== undefined && distanceM <= endM) {
      const parameter = endM === startM ? 0 : (distanceM - startM) / (endM - startM);
      return {
        e: a.e + parameter * (b.e - a.e),
        n: a.n + parameter * (b.n - a.n),
      };
    }
  }
  const last = points[points.length - 1];
  if (last === undefined) throw new Error('Cannot interpolate an empty line');
  return last;
}

function projectOntoClosedLine(point: LocalPoint, line: LocalPoint[]): ClosedProjection {
  const cumulative = cumulativeDistances(line);
  let best: ClosedProjection | undefined;
  let bestSquaredDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < line.length; index += 1) {
    const a = line[index];
    const b = line[(index + 1) % line.length];
    if (a === undefined || b === undefined) throw new Error('Sparse closed line');
    const deltaE = b.e - a.e;
    const deltaN = b.n - a.n;
    const lengthSquared = deltaE * deltaE + deltaN * deltaN;
    if (lengthSquared === 0) continue;
    const parameter = Math.max(
      0,
      Math.min(1, ((point.e - a.e) * deltaE + (point.n - a.n) * deltaN) / lengthSquared),
    );
    const projected = { e: a.e + parameter * deltaE, n: a.n + parameter * deltaN };
    const squaredDistance = (point.e - projected.e) ** 2 + (point.n - projected.n) ** 2;
    if (squaredDistance < bestSquaredDistance) {
      const lengthM = Math.sqrt(lengthSquared);
      bestSquaredDistance = squaredDistance;
      best = {
        distanceM: (cumulative[index] ?? 0) + parameter * lengthM,
        point: projected,
        segmentIndex: index,
        segmentParameter: parameter,
        tangent: { e: deltaE / lengthM, n: deltaN / lengthM },
      };
    }
  }
  if (best === undefined) throw new Error('Cannot project onto a degenerate closed line');
  return best;
}

function positionAtClosedDistance(line: LocalPoint[], distanceM: number): LinePosition {
  const cumulative = cumulativeDistances(line);
  const totalLengthM = closedLength(line);
  const targetM = ((distanceM % totalLengthM) + totalLengthM) % totalLengthM;
  for (let index = 0; index < line.length; index += 1) {
    const a = line[index];
    const b = line[(index + 1) % line.length];
    if (a === undefined || b === undefined) throw new Error('Sparse closed line');
    const startM = cumulative[index] ?? 0;
    const lengthM = segmentLength(a, b);
    const endM = startM + lengthM;
    if (targetM <= endM || index === line.length - 1) {
      const parameter = lengthM === 0 ? 0 : (targetM - startM) / lengthM;
      return {
        point: { e: a.e + parameter * (b.e - a.e), n: a.n + parameter * (b.n - a.n) },
        tangent: { e: (b.e - a.e) / lengthM, n: (b.n - a.n) / lengthM },
      };
    }
  }
  throw new Error('Could not locate a closed-line distance');
}

function rotateCenterlineAtProjection(
  centerline: LatLon[],
  projection: Projection,
  start: ClosedProjection,
): LatLon[] {
  const nextIndex = (start.segmentIndex + 1) % centerline.length;
  if (start.segmentParameter <= Number.EPSILON * 16) {
    return [...centerline.slice(start.segmentIndex), ...centerline.slice(0, start.segmentIndex)];
  }
  if (1 - start.segmentParameter <= Number.EPSILON * 16) {
    return [...centerline.slice(nextIndex), ...centerline.slice(0, nextIndex)];
  }
  return [
    projection.toLatLon(start.point),
    ...centerline.slice(nextIndex),
    ...centerline.slice(0, nextIndex),
  ];
}

function signedArea(points: LocalPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current === undefined || next === undefined) throw new Error('Sparse closed line');
    twiceArea += current.e * next.n - next.e * current.n;
  }
  return twiceArea / 2;
}

function makeGate(
  id: string,
  kind: Gate['kind'],
  position: LinePosition,
  projection: Projection,
  sectorIndex?: number,
): Gate {
  // Gate vector (tangent.n, -tangent.e) makes cross(gate, forward tangent) positive,
  // matching the binding forward-crossing convention in contracts.md.
  const gateUnit = { e: position.tangent.n, n: -position.tangent.e };
  const halfWidthM = GATE_WIDTH_M / 2;
  return {
    id,
    kind,
    a: projection.toLatLon({
      e: position.point.e - gateUnit.e * halfWidthM,
      n: position.point.n - gateUnit.n * halfWidthM,
    }),
    b: projection.toLatLon({
      e: position.point.e + gateUnit.e * halfWidthM,
      n: position.point.n + gateUnit.n * halfWidthM,
    }),
    ...(sectorIndex === undefined ? {} : { sectorIndex }),
  };
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function segmentBearing(points: LocalPoint[], segmentIndex: number): number {
  const a = points[segmentIndex];
  const b = points[(segmentIndex + 1) % points.length];
  if (a === undefined || b === undefined) throw new Error('Sparse closed line');
  if (a.e === b.e && a.n === b.n) throw new Error('Closed line contains a zero-length segment');
  return Math.atan2(b.n - a.n, b.e - a.e);
}

function absoluteTurningAngle(fromBearing: number, toBearing: number): number {
  const difference = toBearing - fromBearing;
  return Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference)));
}

/**
 * Mean absolute turning angle per metre inside a window extending equally
 * before and after the requested centerline distance. Turns are derived from
 * consecutive polyline-segment bearings, so S-bends cannot cancel out.
 */
export function centerlineCurvatureAtDistance(
  points: LocalPoint[],
  distanceM: number,
  halfWindowM = TMR_CURVATURE_HALF_WINDOW_M,
): number {
  const totalLengthM = closedLength(points);
  if (!(halfWindowM > 0 && halfWindowM * 2 < totalLengthM)) {
    throw new Error('Curvature half-window must be positive and shorter than half the line');
  }
  const cumulative = cumulativeDistances(points);
  const windowLengthM = halfWindowM * 2;
  const windowStartM = modulo(distanceM - halfWindowM, totalLengthM);
  let totalTurningAngle = 0;

  for (let index = 0; index < points.length; index += 1) {
    const vertexDistanceM = cumulative[index];
    if (vertexDistanceM === undefined) throw new Error('Sparse cumulative distances');
    const distanceFromWindowStartM = modulo(vertexDistanceM - windowStartM, totalLengthM);
    if (distanceFromWindowStartM <= 0 || distanceFromWindowStartM >= windowLengthM) continue;
    const previousSegmentIndex = modulo(index - 1, points.length);
    totalTurningAngle += absoluteTurningAngle(
      segmentBearing(points, previousSegmentIndex),
      segmentBearing(points, index),
    );
  }

  return totalTurningAngle / windowLengthM;
}

function centerlineVertexCurvatures(points: LocalPoint[]): VertexCurvature[] {
  return cumulativeDistances(points).map((distanceM) => ({
    curvatureRadPerM: centerlineCurvatureAtDistance(points, distanceM),
    distanceM,
  }));
}

function placeSectorGate(
  centerline: LocalPoint[],
  vertexCurvatures: VertexCurvature[],
  targetFraction: number,
  layoutVersion: TmrLayoutVersion,
): SectorPlacement {
  const totalLengthM = closedLength(centerline);
  const targetDistanceM = targetFraction * totalLengthM;
  if (layoutVersion === 1) {
    return {
      curvatureRadPerM: centerlineCurvatureAtDistance(centerline, targetDistanceM),
      distanceM: targetDistanceM,
      fellBack: false,
      position: positionAtClosedDistance(centerline, targetDistanceM),
    };
  }

  let best: { curvatureRadPerM: number; distanceM: number; offsetM: number } | undefined;
  for (const vertex of vertexCurvatures) {
    const offsetM = Math.abs(vertex.distanceM - targetDistanceM);
    if (offsetM > SECTOR_SNAP_HALF_WINDOW_M) continue;
    if (vertex.curvatureRadPerM >= TMR_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M) continue;
    // Strict comparison makes an exact tie resolve to the earlier source vertex.
    if (best === undefined || offsetM < best.offsetM) {
      best = {
        curvatureRadPerM: vertex.curvatureRadPerM,
        distanceM: vertex.distanceM,
        offsetM,
      };
    }
  }

  if (best === undefined) {
    return {
      curvatureRadPerM: centerlineCurvatureAtDistance(centerline, targetDistanceM),
      distanceM: targetDistanceM,
      fellBack: true,
      position: positionAtClosedDistance(centerline, targetDistanceM),
    };
  }
  return {
    curvatureRadPerM: best.curvatureRadPerM,
    distanceM: best.distanceM,
    fellBack: false,
    position: positionAtClosedDistance(centerline, best.distanceM),
  };
}

export interface TmrGeneratorInputs {
  geometryJson: string;
  tagsJson: string;
}

function readDefaultInputs(): TmrGeneratorInputs {
  return {
    geometryJson: readFileSync(GEOMETRY_INPUT_URL, 'utf8'),
    tagsJson: readFileSync(TAGS_INPUT_URL, 'utf8'),
  };
}

export function generateTmrProfile(
  layoutVersion: TmrLayoutVersion = 2,
  inputs: TmrGeneratorInputs = readDefaultInputs(),
): CircuitProfile {
  const centerlineWay = requireWay(inputs.geometryJson, CENTERLINE_WAY_ID, 'OSM geometry input');
  const pitLaneWay = requireWay(inputs.geometryJson, PIT_LANE_WAY_ID, 'OSM geometry input');
  const centerlineTags = requireTagWay(inputs.tagsJson, CENTERLINE_WAY_ID);
  const pitLaneTags = requireTagWay(inputs.tagsJson, PIT_LANE_WAY_ID);

  if (centerlineTags.oneway !== 'yes' || pitLaneTags.oneway !== 'yes') {
    throw new Error('Both archived OSM ways must retain oneway=yes');
  }
  if (centerlineWay.geometry.length !== centerlineWay.nodes.length) {
    throw new Error('Centerline node and geometry arrays must have equal lengths');
  }
  if (pitLaneWay.geometry.length !== pitLaneWay.nodes.length) {
    throw new Error('Pit-lane node and geometry arrays must have equal lengths');
  }
  const firstCenterlineNode = centerlineWay.nodes[0];
  const lastCenterlineNode = centerlineWay.nodes[centerlineWay.nodes.length - 1];
  const firstCenterlinePoint = centerlineWay.geometry[0];
  const lastCenterlinePoint = centerlineWay.geometry[centerlineWay.geometry.length - 1];
  if (
    firstCenterlineNode === undefined ||
    lastCenterlineNode !== firstCenterlineNode ||
    firstCenterlinePoint === undefined ||
    lastCenterlinePoint === undefined ||
    !sameLatLon(firstCenterlinePoint, lastCenterlinePoint)
  ) {
    throw new Error('OSM centerline way must be explicitly closed by a duplicated final node');
  }

  // The serialized centerline uses implicit closure, so only the duplicated final
  // OSM node is dropped. Every other coordinate stays in source way order.
  const sourceCenterline = centerlineWay.geometry.slice(0, -1);
  const pitLane = pitLaneWay.geometry;
  if (sourceCenterline.length < 2 || pitLane.length < 2) {
    throw new Error('OSM ways contain insufficient geometry');
  }

  const sourceProjection = createLocalProjection(centroid(sourceCenterline));
  const sourceCenterlineLocal = sourceCenterline.map((point) => sourceProjection.toLocal(point));
  const pitLaneLocalAtSource = pitLane.map((point) => sourceProjection.toLocal(point));
  const pitMidpoint = interpolateOpenLine(
    pitLaneLocalAtSource,
    openLength(pitLaneLocalAtSource) / 2,
  );
  const startProjection = projectOntoClosedLine(pitMidpoint, sourceCenterlineLocal);
  const centerline = rotateCenterlineAtProjection(
    sourceCenterline,
    sourceProjection,
    startProjection,
  );

  // The bounding center is the arithmetic centroid of the generated centerline.
  // Reprojecting from that same datum makes both the asset and runtime validator
  // use an identical local ENU scale for length, area, gates, and radius.
  const boundingCenter = centroid(centerline);
  const projection = createLocalProjection(boundingCenter);
  const centerlineLocal = centerline.map((point) => projection.toLocal(point));
  const pitLaneLocal = pitLane.map((point) => projection.toLocal(point));
  const totalLengthM = closedLength(centerlineLocal);
  const lengthErrorFraction = Math.abs(totalLengthM - RESEARCH_LENGTH_M) / RESEARCH_LENGTH_M;
  if (lengthErrorFraction > RESEARCH_LENGTH_TOLERANCE) {
    throw new Error(
      `Computed centerline length ${totalLengthM.toFixed(3)} m is not within 1% of the ` +
        '3,708 m verified length in docs/research/transilvania-motor-ring.md',
    );
  }

  const startFinishPosition = positionAtClosedDistance(centerlineLocal, 0);
  const vertexCurvatures = centerlineVertexCurvatures(centerlineLocal);
  const startFinishCurvatureRadPerM = vertexCurvatures[0]?.curvatureRadPerM;
  if (startFinishCurvatureRadPerM === undefined) throw new Error('Centerline has no vertices');
  if (startFinishCurvatureRadPerM >= TMR_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M) {
    throw new Error(
      `Start/finish curvature ${startFinishCurvatureRadPerM} rad/m is not below the ` +
        `${TMR_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M} rad/m straight threshold`,
    );
  }
  const sectorOne = placeSectorGate(centerlineLocal, vertexCurvatures, 1 / 3, layoutVersion);
  const sectorTwo = placeSectorGate(centerlineLocal, vertexCurvatures, 2 / 3, layoutVersion);
  const pitFirst = pitLaneLocal[0];
  const pitLast = pitLaneLocal[pitLaneLocal.length - 1];
  if (pitFirst === undefined || pitLast === undefined) throw new Error('Pit lane is empty');
  const pitFirstProjection = projectOntoClosedLine(pitFirst, centerlineLocal);
  const pitLastProjection = projectOntoClosedLine(pitLast, centerlineLocal);

  // The entry is the endpoint encountered first along the short centerline arc
  // bypassed by the pit. Since both OSM ways are one-way, the pit's first node
  // must lead to its last node over that forward arc. This circular comparison is
  // essential across the S/F datum: there the entry has the greater numeric
  // distance immediately before wrap, while the exit has the smaller distance.
  const firstToLastForwardM = modulo(
    pitLastProjection.distanceM - pitFirstProjection.distanceM,
    totalLengthM,
  );
  if (!(firstToLastForwardM > 0 && firstToLastForwardM < totalLengthM / 2)) {
    throw new Error('Pit-lane node order is inconsistent with centerline travel direction');
  }

  const allLocalPoints = [...centerlineLocal, ...pitLaneLocal];
  const maximumDistanceM = Math.max(...allLocalPoints.map((point) => Math.hypot(point.e, point.n)));
  const direction = signedArea(centerlineLocal) > 0 ? 'counterclockwise' : 'clockwise';

  return {
    schemaVersion: 1,
    circuitId: 'transilvania-motor-ring',
    displayName: 'Transilvania Motor Ring',
    country: 'Romania',
    locality: 'Cerghid',
    layoutId: 'main',
    layoutVersion,
    source: {
      name: '© OpenStreetMap contributors',
      url: 'https://www.openstreetmap.org/way/488429454',
      license: 'ODbL 1.0',
      retrievedAt: '2026-08-06',
    },
    geometryStatus: 'community-derived',
    sectorStatus: 'app-defined',
    direction,
    centerline,
    totalLengthM,
    startFinishGate: makeGate('start-finish', 'startFinish', startFinishPosition, projection),
    sectorGates: [
      makeGate('sector-1', 'sector', sectorOne.position, projection, 1),
      makeGate('sector-2', 'sector', sectorTwo.position, projection, 2),
    ],
    pitLane: {
      polyline: pitLane,
      entryGate: makeGate('pit-entry', 'pitEntry', pitFirstProjection, projection),
      exitGate: makeGate('pit-exit', 'pitExit', pitLastProjection, projection),
    },
    boundingRegion: { center: boundingCenter, radiusM: maximumDistanceM + 500 },
    // Research reports an unverified 11–14 m track width. Fifteen meters keeps
    // the full plausible pavement width plus a small GNSS matching margin.
    corridorWidthM: CORRIDOR_WIDTH_M,
    createdAtUtc: '2026-08-06T00:00:00Z',
    updatedAtUtc: '2026-08-06T00:00:00Z',
    confidenceNotes:
      layoutVersion === 1
        ? 'Start/finish, sector, and pit gates are app-defined from OSM geometry and have not ' +
          'been validated on-site. corridorWidthM=15 combines the researched 11–14 m ' +
          '[PLAUSIBLE] track width with GNSS margin.'
        : 'Start/finish, sector, and pit gates are app-defined from OSM geometry and have not ' +
          'been validated on-site. V2 sector rule: for each target fraction (1/3, 2/3), find ' +
          'the nearest qualifying straight vertex within ±180 m of the target distance; place ' +
          'the gate there (perpendicular, same width rules as v1). A vertex qualifies as ' +
          'straight when its mean absolute turning angle over a ±40 m centerline window is ' +
          '< 0.008 rad/m; this ~0.46°/m threshold rejects sustained corners while retaining ' +
          'timing-stable straight stretches. If no qualifying vertex exists in the window, ' +
          'fall back to the exact fraction and note it in confidenceNotes. ' +
          (sectorOne.fellBack || sectorTwo.fellBack
            ? `Fallback used for${sectorOne.fellBack ? ' sector 1' : ''}${
                sectorTwo.fellBack ? ' sector 2' : ''
              }.`
            : 'No fallback was required.') +
          ' corridorWidthM=15 combines the researched 11–14 m [PLAUSIBLE] track width with ' +
          'GNSS margin.',
  };
}

export function serializeTmrProfile(profile: CircuitProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}

export function writeTmrProfile(layoutVersion: TmrLayoutVersion = 2): CircuitProfile {
  const profile = generateTmrProfile(layoutVersion);
  const outputUrl = new URL(
    `../assets/circuits/transilvania-motor-ring.v${layoutVersion}.json`,
    import.meta.url,
  );
  mkdirSync(OUTPUT_DIRECTORY_URL, { recursive: true });
  writeFileSync(outputUrl, serializeTmrProfile(profile), 'utf8');
  return profile;
}

function parseLayoutVersion(arguments_: string[]): TmrLayoutVersion {
  if (arguments_.length === 0) return 2;
  if (arguments_.length === 1 && /^--layout-version=[12]$/.test(arguments_[0] ?? '')) {
    return arguments_[0]?.endsWith('1') === true ? 1 : 2;
  }
  if (
    arguments_.length === 2 &&
    arguments_[0] === '--layout-version' &&
    /^[12]$/.test(arguments_[1] ?? '')
  ) {
    return arguments_[1] === '1' ? 1 : 2;
  }
  throw new Error('Usage: generate-tmr-profile.ts [--layout-version=1|2]');
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  // `npm run generate:tmr` defaults to v2. Reproduce v1 without changing it via
  // `npm run generate:tmr -- --layout-version=1`.
  const layoutVersion = parseLayoutVersion(process.argv.slice(2));
  const profile = writeTmrProfile(layoutVersion);
  process.stdout.write(
    `Generated transilvania-motor-ring.v${layoutVersion}.json (` +
      `${profile.centerline.length} vertices, ` +
      `${profile.totalLengthM.toFixed(3)} m)\n`,
  );
}
