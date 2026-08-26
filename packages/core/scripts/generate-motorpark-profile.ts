import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CircuitProfile, Gate, LatLon, LocalPoint } from '../src/contracts';

// This generator deliberately duplicates the small geometry-helper set from
// `generate-tmr-profile.ts` rather than importing from it (or factoring a
// shared module): the TMR script MUST stay byte-for-byte untouched, and a
// self-contained script matches the established one-file-per-circuit pattern.
const curvatureModule = (await import(
  new URL('../src/geometry/curvature.ts', import.meta.url).href
)) as typeof import('../src/geometry/curvature');
const { curvatureAtDistance, curvatureProfile } = curvatureModule;

// ---------------------------------------------------------------------------
// Way IDs (data/osm/overpass-motorpark-{geom,tags}.json, archived read-only).
// ---------------------------------------------------------------------------
const MAIN_LOOP_WAY_ID = 333_031_201;
const EXTENSION_WAY_ID = 949_617_051;
// Short-configuration chord (120 m). Confirmed NOT part of the full layout by
// LEAD's live-Overpass verification; intentionally never read by this script.
// const CHORD_WAY_ID = 333_031_200;
const PIT_LANE_SE_WAY_ID = 953_930_215; // track-side entry, near 44.77690, 26.47614
const PIT_LANE_NW_WAY_ID = 953_930_214; // rejoins track, near 44.78067, 26.47028
// Pit-lane topology (ticket CN-FIX1 F1, correcting the CN-W1 addendum's wrong
// "~41 m gap" claim, which compared endpoint coordinates instead of node ids):
// the two pit ways SHARE this node -- there is no unmapped gap. Way 214's
// first node is a short-configuration pit connector, excluded because it is
// not part of the full-layout pit lane.
const PIT_SHARED_NODE_ID = 8_829_181_316; // way215's last node == way214's node[1]
const PIT_NW_EXCLUDED_CONNECTOR_NODE_ID = 8_829_250_717; // way214's node[0]

// Binding geometry decisions verified by LEAD against live Overpass (see
// .foreman/scratch/ticket-cnw1-motorpark-profile.md) -- asserted below so the
// generator fails loudly if the archived data ever changes shape.
const EXPECTED_MAIN_LOOP_NODE_COUNT = 83; // raw nodes[], includes the closing duplicate
const EXPECTED_MAIN_LOOP_LENGTH_M = 3_326.1;
const MAIN_LOOP_LENGTH_TOLERANCE = 0.005;
const SPLICE_START_NODE_ID = 3_401_455_119;
const SPLICE_END_NODE_ID = 8_791_129_031;
const EXPECTED_SPLICE_START_INDEX = 74;
const EXPECTED_SPLICE_END_INDEX = 79;
const EXPECTED_EXTENSION_NODE_COUNT = 26;
const EXPECTED_SPLICED_POINT_COUNT = 103; // raw, includes the closing duplicate

const RESEARCH_LENGTH_M = 4_052; // racingcircuits.info; official site cites 4,129 m (see confidenceNotes)
const RESEARCH_LENGTH_TOLERANCE = 0.01;
// Published width 11-16 m (motorparkromania.ro) plus a small GNSS matching margin.
const CORRIDOR_WIDTH_M = 16;
const GATE_WIDTH_M = CORRIDOR_WIDTH_M * 2;
export const MOTORPARK_CURVATURE_HALF_WINDOW_M = 40;
export const MOTORPARK_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M = 0.008;
const SECTOR_SNAP_HALF_WINDOW_M = 180;
const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

const GEOMETRY_INPUT_URL = new URL(
  '../../../data/osm/overpass-motorpark-geom.json',
  import.meta.url,
);
const TAGS_INPUT_URL = new URL('../../../data/osm/overpass-motorpark-tags.json', import.meta.url);
const OUTPUT_DIRECTORY_URL = new URL('../assets/circuits/', import.meta.url);

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

/**
 * Mean absolute turning angle per metre inside a window extending equally
 * before and after the requested centerline distance (same metric as TMR).
 */
export function centerlineCurvatureAtDistance(
  points: LocalPoint[],
  distanceM: number,
  halfWindowM = MOTORPARK_CURVATURE_HALF_WINDOW_M,
): number {
  const cumulative = cumulativeDistances(points);
  return Math.abs(curvatureAtDistance(points, cumulative, true, distanceM, halfWindowM));
}

function centerlineVertexCurvatures(points: LocalPoint[]): VertexCurvature[] {
  const cumulative = cumulativeDistances(points);
  const curvatures = curvatureProfile(points, cumulative, true, MOTORPARK_CURVATURE_HALF_WINDOW_M);
  return cumulative.map((distanceM, index) => ({
    curvatureRadPerM: Math.abs(curvatures[index] ?? 0),
    distanceM,
  }));
}

/**
 * TMR v2 "straight vertex" sector rule, copied verbatim (per ticket CN-W1):
 * for each target fraction (1/3, 2/3), find the nearest qualifying straight
 * vertex within +/-180 m of the target distance; a vertex qualifies when its
 * mean absolute turning angle over a +/-40 m centerline window is below
 * 0.008 rad/m. If no qualifying vertex exists in the window, fall back to
 * the exact fraction and note it in confidenceNotes.
 */
function placeSectorGate(
  centerline: LocalPoint[],
  vertexCurvatures: VertexCurvature[],
  targetFraction: number,
): SectorPlacement {
  const totalLengthM = closedLength(centerline);
  const targetDistanceM = targetFraction * totalLengthM;

  let best: { curvatureRadPerM: number; distanceM: number; offsetM: number } | undefined;
  for (const vertex of vertexCurvatures) {
    const offsetM = Math.abs(vertex.distanceM - targetDistanceM);
    if (offsetM > SECTOR_SNAP_HALF_WINDOW_M) continue;
    if (vertex.curvatureRadPerM >= MOTORPARK_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M) continue;
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

export interface MotorparkGeneratorInputs {
  geometryJson: string;
  tagsJson: string;
}

function readDefaultInputs(): MotorparkGeneratorInputs {
  return {
    geometryJson: readFileSync(GEOMETRY_INPUT_URL, 'utf8'),
    tagsJson: readFileSync(TAGS_INPUT_URL, 'utf8'),
  };
}

export function generateMotorparkProfile(
  inputs: MotorparkGeneratorInputs = readDefaultInputs(),
): CircuitProfile {
  const mainLoopWay = requireWay(inputs.geometryJson, MAIN_LOOP_WAY_ID, 'OSM geometry input');
  const extensionWay = requireWay(inputs.geometryJson, EXTENSION_WAY_ID, 'OSM geometry input');
  const pitSeWay = requireWay(inputs.geometryJson, PIT_LANE_SE_WAY_ID, 'OSM geometry input');
  const pitNwWay = requireWay(inputs.geometryJson, PIT_LANE_NW_WAY_ID, 'OSM geometry input');
  const mainLoopTags = requireTagWay(inputs.tagsJson, MAIN_LOOP_WAY_ID);
  const extensionTags = requireTagWay(inputs.tagsJson, EXTENSION_WAY_ID);
  const pitSeTags = requireTagWay(inputs.tagsJson, PIT_LANE_SE_WAY_ID);
  const pitNwTags = requireTagWay(inputs.tagsJson, PIT_LANE_NW_WAY_ID);

  if (
    mainLoopTags.oneway !== 'yes' ||
    extensionTags.oneway !== 'yes' ||
    pitSeTags.oneway !== 'yes' ||
    pitNwTags.oneway !== 'yes'
  ) {
    throw new Error('All four archived OSM ways must retain oneway=yes');
  }
  if (mainLoopWay.geometry.length !== mainLoopWay.nodes.length) {
    throw new Error('Main-loop node and geometry arrays must have equal lengths');
  }
  if (extensionWay.geometry.length !== extensionWay.nodes.length) {
    throw new Error('Extension node and geometry arrays must have equal lengths');
  }

  // --- Shape-drift guards for the binding splice decision (ticket CN-W1) ---
  if (mainLoopWay.nodes.length !== EXPECTED_MAIN_LOOP_NODE_COUNT) {
    throw new Error(
      `Main loop way ${MAIN_LOOP_WAY_ID} has ${mainLoopWay.nodes.length} nodes, expected ` +
        `${EXPECTED_MAIN_LOOP_NODE_COUNT} -- the archived OSM data no longer matches the ` +
        'verified splice topology in ticket CN-W1.',
    );
  }
  const firstMainNode = mainLoopWay.nodes[0];
  const lastMainNode = mainLoopWay.nodes[mainLoopWay.nodes.length - 1];
  const firstMainPoint = mainLoopWay.geometry[0];
  const lastMainPoint = mainLoopWay.geometry[mainLoopWay.geometry.length - 1];
  if (
    firstMainNode === undefined ||
    lastMainNode !== firstMainNode ||
    firstMainPoint === undefined ||
    lastMainPoint === undefined ||
    !sameLatLon(firstMainPoint, lastMainPoint)
  ) {
    throw new Error('OSM main-loop way must be explicitly closed by a duplicated final node');
  }
  const mainLoopOpenGeometry = mainLoopWay.geometry.slice(0, -1);
  const mainLoopLengthProjection = createLocalProjection(centroid(mainLoopOpenGeometry));
  const mainLoopLengthM = closedLength(
    mainLoopOpenGeometry.map((point) => mainLoopLengthProjection.toLocal(point)),
  );
  if (
    Math.abs(mainLoopLengthM - EXPECTED_MAIN_LOOP_LENGTH_M) / EXPECTED_MAIN_LOOP_LENGTH_M >
    MAIN_LOOP_LENGTH_TOLERANCE
  ) {
    throw new Error(
      `Main loop closed length ${mainLoopLengthM.toFixed(1)} m is not within ` +
        `${(MAIN_LOOP_LENGTH_TOLERANCE * 100).toFixed(1)}% of the verified ` +
        `${EXPECTED_MAIN_LOOP_LENGTH_M} m in ticket CN-W1.`,
    );
  }

  const spliceStartIndex = mainLoopWay.nodes.indexOf(SPLICE_START_NODE_ID);
  const spliceEndIndex = mainLoopWay.nodes.indexOf(SPLICE_END_NODE_ID);
  if (spliceStartIndex !== EXPECTED_SPLICE_START_INDEX || spliceEndIndex !== EXPECTED_SPLICE_END_INDEX) {
    throw new Error(
      `Splice node-indices are ${spliceStartIndex}/${spliceEndIndex}, expected ` +
        `${EXPECTED_SPLICE_START_INDEX}/${EXPECTED_SPLICE_END_INDEX} -- the archived main-loop ` +
        'node order no longer matches the verified splice topology in ticket CN-W1.',
    );
  }
  if (extensionWay.nodes.length !== EXPECTED_EXTENSION_NODE_COUNT) {
    throw new Error(
      `Extension way ${EXTENSION_WAY_ID} has ${extensionWay.nodes.length} nodes, expected ` +
        `${EXPECTED_EXTENSION_NODE_COUNT}.`,
    );
  }
  const extensionFirstNode = extensionWay.nodes[0];
  const extensionLastNode = extensionWay.nodes[extensionWay.nodes.length - 1];
  if (
    extensionFirstNode !== SPLICE_START_NODE_ID ||
    extensionLastNode !== SPLICE_END_NODE_ID ||
    !sameLatLon(extensionWay.geometry[0] as LatLon, mainLoopWay.geometry[spliceStartIndex] as LatLon) ||
    !sameLatLon(
      extensionWay.geometry[extensionWay.geometry.length - 1] as LatLon,
      mainLoopWay.geometry[spliceEndIndex] as LatLon,
    )
  ) {
    throw new Error(
      'Extension way endpoints/orientation no longer match the main loop at the splice indices.',
    );
  }

  // Full-layout splice: main[0..spliceStartIndex] + extension interior nodes
  // (both endpoints already covered by the main loop) + main[spliceEndIndex..]
  // (which ends on the main loop's own closing duplicate).
  const splicedWithClosingDuplicate: LatLon[] = [
    ...mainLoopWay.geometry.slice(0, spliceStartIndex + 1),
    ...extensionWay.geometry.slice(1, -1),
    ...mainLoopWay.geometry.slice(spliceEndIndex),
  ];
  if (splicedWithClosingDuplicate.length !== EXPECTED_SPLICED_POINT_COUNT) {
    throw new Error(
      `Spliced loop has ${splicedWithClosingDuplicate.length} points, expected ` +
        `${EXPECTED_SPLICED_POINT_COUNT}.`,
    );
  }
  const splicedFirst = splicedWithClosingDuplicate[0];
  const splicedLast = splicedWithClosingDuplicate[splicedWithClosingDuplicate.length - 1];
  if (splicedFirst === undefined || splicedLast === undefined || !sameLatLon(splicedFirst, splicedLast)) {
    throw new Error('Spliced loop is not closed by a duplicated final point');
  }

  // The seam vertex (main loop's own first/last node) is the S/F gate location
  // per ticket CN-W1, and it is already the first point of the spliced loop --
  // no centerline rotation is required (unlike TMR, whose S/F is derived from
  // the pit-lane midpoint instead of a fixed seam vertex).
  const sourceCenterline = splicedWithClosingDuplicate.slice(0, -1);
  if (sourceCenterline.length < 50) {
    throw new Error('Spliced centerline has insufficient geometry');
  }

  // --- Pit-lane topology guards (ticket CN-FIX1 F1) ---
  const pitSeLastNode = pitSeWay.nodes[pitSeWay.nodes.length - 1];
  if (pitSeLastNode !== PIT_SHARED_NODE_ID) {
    throw new Error(
      `Pit-lane SE way ${PIT_LANE_SE_WAY_ID} does not end at the expected shared node ` +
        `${PIT_SHARED_NODE_ID} (got ${String(pitSeLastNode)}).`,
    );
  }
  if (pitNwWay.nodes[0] !== PIT_NW_EXCLUDED_CONNECTOR_NODE_ID) {
    throw new Error(
      `Pit-lane NW way ${PIT_LANE_NW_WAY_ID} does not start with the expected excluded ` +
        `short-config connector node ${PIT_NW_EXCLUDED_CONNECTOR_NODE_ID} (got ` +
        `${String(pitNwWay.nodes[0])}).`,
    );
  }
  const pitNwSharedIndex = pitNwWay.nodes.indexOf(PIT_SHARED_NODE_ID);
  if (pitNwSharedIndex !== 1) {
    throw new Error(
      `Pit-lane NW way ${PIT_LANE_NW_WAY_ID} shared node ${PIT_SHARED_NODE_ID} is at index ` +
        `${pitNwSharedIndex}, expected 1 (immediately after the excluded connector).`,
    );
  }
  const pitEntryNode = pitSeWay.nodes[0];
  const pitExitNode = pitNwWay.nodes[pitNwWay.nodes.length - 1];
  if (pitEntryNode === undefined || !extensionWay.nodes.includes(pitEntryNode)) {
    throw new Error(
      `Pit entry node ${String(pitEntryNode)} (way ${PIT_LANE_SE_WAY_ID} first node) must lie ` +
        `on the full-layout extension way ${EXTENSION_WAY_ID}.`,
    );
  }
  if (pitExitNode === undefined || !mainLoopWay.nodes.includes(pitExitNode)) {
    throw new Error(
      `Pit exit node ${String(pitExitNode)} (way ${PIT_LANE_NW_WAY_ID} last node) must lie on ` +
        `the main loop way ${MAIN_LOOP_WAY_ID}.`,
    );
  }

  // pitLane.polyline = way215.geometry ++ way214.geometry (interior, after the
  // shared node -- deduped, and the excluded connector node dropped).
  const pitLanePolyline: LatLon[] = [
    ...pitSeWay.geometry,
    ...pitNwWay.geometry.slice(pitNwSharedIndex + 1),
  ];
  if (pitLanePolyline.length < 2) throw new Error('Pit lane geometry is insufficient');
  for (let index = 1; index < pitLanePolyline.length; index += 1) {
    const previous = pitLanePolyline[index - 1];
    const current = pitLanePolyline[index];
    if (previous !== undefined && current !== undefined && sameLatLon(previous, current)) {
      throw new Error(`Pit lane polyline has consecutive identical points at index ${index}.`);
    }
  }
  {
    // No-backtracking guard: heading must not reverse by more than 150 degrees
    // between consecutive segments anywhere along the pit polyline.
    const backtrackProjection = createLocalProjection(centroid(pitLanePolyline));
    const backtrackLocal = pitLanePolyline.map((point) => backtrackProjection.toLocal(point));
    for (let index = 1; index < backtrackLocal.length - 1; index += 1) {
      const previous = backtrackLocal[index - 1];
      const current = backtrackLocal[index];
      const next = backtrackLocal[index + 1];
      if (previous === undefined || current === undefined || next === undefined) continue;
      const inHeadingDeg = Math.atan2(current.e - previous.e, current.n - previous.n) * RAD_TO_DEG;
      const outHeadingDeg = Math.atan2(next.e - current.e, next.n - current.n) * RAD_TO_DEG;
      const turnDeg = Math.abs(((outHeadingDeg - inHeadingDeg + 540) % 360) - 180);
      if (turnDeg > 150) {
        throw new Error(
          `Pit lane polyline backtracks at vertex ${index} (heading reverses by ` +
            `${turnDeg.toFixed(1)} degrees).`,
        );
      }
    }
  }

  // The bounding center is the arithmetic centroid of the centerline itself
  // (there is no rotation step here), matching TMR's re-projection choice so
  // length/area/gate/radius math all share one local ENU scale.
  const boundingCenter = centroid(sourceCenterline);
  const projection = createLocalProjection(boundingCenter);
  const centerlineLocal = sourceCenterline.map((point) => projection.toLocal(point));
  const pitLaneLocal = pitLanePolyline.map((point) => projection.toLocal(point));
  const totalLengthM = closedLength(centerlineLocal);
  const lengthErrorFraction = Math.abs(totalLengthM - RESEARCH_LENGTH_M) / RESEARCH_LENGTH_M;
  if (lengthErrorFraction > RESEARCH_LENGTH_TOLERANCE) {
    throw new Error(
      `Computed centerline length ${totalLengthM.toFixed(3)} m is not within 1% of the ` +
        `${RESEARCH_LENGTH_M} m published length (racingcircuits.info).`,
    );
  }

  const direction = signedArea(centerlineLocal) > 0 ? 'counterclockwise' : 'clockwise';
  if (direction !== 'clockwise') {
    throw new Error(
      `Spliced loop signed area implies ${direction} travel; ticket CN-W1 verified clockwise.`,
    );
  }

  const startFinishPosition = positionAtClosedDistance(centerlineLocal, 0);
  const vertexCurvatures = centerlineVertexCurvatures(centerlineLocal);
  const startFinishCurvatureRadPerM = vertexCurvatures[0]?.curvatureRadPerM;
  if (startFinishCurvatureRadPerM === undefined) throw new Error('Centerline has no vertices');
  if (startFinishCurvatureRadPerM >= MOTORPARK_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M) {
    throw new Error(
      `Start/finish curvature ${startFinishCurvatureRadPerM} rad/m is not below the ` +
        `${MOTORPARK_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M} rad/m straight threshold`,
    );
  }
  const sectorOne = placeSectorGate(centerlineLocal, vertexCurvatures, 1 / 3);
  const sectorTwo = placeSectorGate(centerlineLocal, vertexCurvatures, 2 / 3);

  const pitFirst = pitLaneLocal[0];
  const pitLast = pitLaneLocal[pitLaneLocal.length - 1];
  if (pitFirst === undefined || pitLast === undefined) throw new Error('Pit lane is empty');
  const pitFirstProjection = projectOntoClosedLine(pitFirst, centerlineLocal);
  const pitLastProjection = projectOntoClosedLine(pitLast, centerlineLocal);

  // Entry (953930215's first point, where it leaves the track) must lead
  // forward to exit (953930214's last point, where it rejoins) over the
  // SHORT arc bypassed by the pit lane -- same circular check as TMR.
  const firstToLastForwardM = modulo(
    pitLastProjection.distanceM - pitFirstProjection.distanceM,
    totalLengthM,
  );
  if (!(firstToLastForwardM > 0 && firstToLastForwardM < totalLengthM / 2)) {
    throw new Error('Pit-lane node order is inconsistent with centerline travel direction');
  }

  const allLocalPoints = [...centerlineLocal, ...pitLaneLocal];
  const maximumDistanceM = Math.max(...allLocalPoints.map((point) => Math.hypot(point.e, point.n)));

  const sectorNotes =
    'Sector gates use the TMR v2 "straight vertex" rule verbatim: for each target fraction ' +
    '(1/3, 2/3 of lap distance), find the nearest qualifying straight vertex within +/-180 m ' +
    'of the target distance; place the gate there (perpendicular, same width rules as the ' +
    'start/finish gate). A vertex qualifies as straight when its mean absolute turning angle ' +
    'over a +/-40 m centerline window is < 0.008 rad/m. If no qualifying vertex exists in the ' +
    'window, fall back to the exact fraction and note it here. ' +
    (sectorOne.fellBack || sectorTwo.fellBack
      ? `Fallback used for${sectorOne.fellBack ? ' sector 1' : ''}${
          sectorTwo.fellBack ? ' sector 2' : ''
        }.`
      : 'No fallback was required.');

  return {
    schemaVersion: 1,
    circuitId: 'motorpark-romania',
    displayName: 'MotorPark România',
    country: 'Romania',
    locality: 'Adâncata, Ialomița',
    layoutId: 'full',
    layoutVersion: 1,
    source: {
      name: '© OpenStreetMap contributors',
      url: 'https://www.openstreetmap.org/way/333031201',
      license: 'ODbL 1.0',
      retrievedAt: '2026-08-26',
    },
    geometryStatus: 'community-derived',
    sectorStatus: 'app-defined',
    direction,
    centerline: sourceCenterline,
    totalLengthM,
    startFinishGate: makeGate('start-finish', 'startFinish', startFinishPosition, projection),
    sectorGates: [
      makeGate('sector-1', 'sector', sectorOne.position, projection, 1),
      makeGate('sector-2', 'sector', sectorTwo.position, projection, 2),
    ],
    pitLane: {
      polyline: pitLanePolyline,
      entryGate: makeGate('pit-entry', 'pitEntry', pitFirstProjection, projection),
      exitGate: makeGate('pit-exit', 'pitExit', pitLastProjection, projection),
    },
    boundingRegion: { center: boundingCenter, radiusM: maximumDistanceM + 500 },
    corridorWidthM: CORRIDOR_WIDTH_M,
    createdAtUtc: '2026-08-26T00:00:00Z',
    updatedAtUtc: '2026-08-26T00:00:00Z',
    confidenceNotes:
      'Geometry OpenStreetMap © OpenStreetMap contributors, ODbL 1.0 -- attribution mandatory ' +
      'wherever this circuit is shown. Traced from OSM aerial mapping and NOT validated ' +
      'on-site. Nothing in this asset is "official": start/finish, sector, and pit gates are ' +
      'app-defined (ADR-0002), not sanctioning-body-provided. Way IDs: main loop 333031201 ' +
      '(83 nodes incl. closing duplicate, 3326.1 m closed), full-layout extension 949617051 ' +
      '(26 nodes) splicing in for the main-loop segment between node-index 74 (node ' +
      '3401455119) and node-index 79 (node 8791129031, same orientation) -- short-config ' +
      'chord way 333031200 (120 m) is excluded, it is not part of this full layout. Computed ' +
      `closed length ${totalLengthM.toFixed(1)} m vs published 4052 m (racingcircuits.info, ` +
      `${(lengthErrorFraction * 100).toFixed(2)}% delta) vs 4129 m (motorparkromania.ro, ` +
      `${(Math.abs(totalLengthM - 4129) / 4129 * 100).toFixed(2)}% delta) -- both published ` +
      'figures recorded for reference. Pit lane: way 953930215 (SE, track-side entry) then way ' +
      '953930214 (NW, rejoins track); the two ways SHARE node 8829181316 -- there is NO ' +
      'unmapped gap (corrected after Codex CN-REV1; the earlier "~41 m gap" claim wrongly ' +
      'compared endpoint coordinates instead of node ids). Way 953930214 node[0] (8829250717) ' +
      'is a short-configuration pit connector, excluded because it is not part of the ' +
      'full-layout pit lane; pitLane.polyline = way215.geometry followed by way214.geometry ' +
      'after the shared node (deduped). corridorWidthM=16 combines the published 11-16 m ' +
      '[PLAUSIBLE] track width with a GNSS matching margin. ' +
      sectorNotes,
  };
}

export function serializeMotorparkProfile(profile: CircuitProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}

export function writeMotorparkProfile(): CircuitProfile {
  const profile = generateMotorparkProfile();
  const outputUrl = new URL('../assets/circuits/motorpark-romania.v1.json', import.meta.url);
  mkdirSync(OUTPUT_DIRECTORY_URL, { recursive: true });
  writeFileSync(outputUrl, serializeMotorparkProfile(profile), 'utf8');
  return profile;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  const profile = writeMotorparkProfile();
  process.stdout.write(
    `Generated motorpark-romania.v1.json (${profile.centerline.length} vertices, ` +
      `${profile.totalLengthM.toFixed(3)} m)\n`,
  );
}
