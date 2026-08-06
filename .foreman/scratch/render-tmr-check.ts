import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type LatLon = { lat: number; lon: number };
type Point = { e: number; n: number };
type Gate = { id: string; a: LatLon; b: LatLon };

const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const assetPath = resolve(root, 'packages/core/assets/circuits/transilvania-motor-ring.v1.json');
const osmPath = resolve(root, 'data/osm/overpass-tmr-geom.json');
const svgPath = resolve(here, 'tmr-geometry-check.svg');
const reportPath = resolve(here, 'tmr-geometry-check.md');

const asset = JSON.parse(await readFile(assetPath, 'utf8'));
const osm = JSON.parse(await readFile(osmPath, 'utf8'));
const origin: LatLon = asset.boundingRegion.center;
const longitudeScale = Math.cos(origin.lat * DEG_TO_RAD);

// Same spherical local equirectangular ENU projection used by
// packages/core/src/geometry/projection.ts:createProjection.
function toLocal(point: LatLon): Point {
  const dLon = ((point.lon - origin.lon + 180) % 360 + 360) % 360 - 180;
  return {
    e: EARTH_RADIUS_M * dLon * DEG_TO_RAD * longitudeScale,
    n: EARTH_RADIUS_M * (point.lat - origin.lat) * DEG_TO_RAD,
  };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.e - a.e, b.n - a.n);
}

function closedSegments(points: Point[]) {
  return points.map((a, i) => ({ a, b: points[(i + 1) % points.length], index: i }));
}

function openSegments(points: Point[]) {
  return points.slice(0, -1).map((a, i) => ({ a, b: points[i + 1], index: i }));
}

function cumulativeClosed(points: Point[]): number[] {
  const cumulative = [0];
  for (const segment of closedSegments(points)) {
    cumulative.push(cumulative.at(-1)! + distance(segment.a, segment.b));
  }
  return cumulative;
}

function polylineLength(points: Point[], closed = false): number {
  const segments = closed ? closedSegments(points) : openSegments(points);
  return segments.reduce((sum, segment) => sum + distance(segment.a, segment.b), 0);
}

function projectPointToSegment(point: Point, a: Point, b: Point) {
  const dx = b.e - a.e;
  const dy = b.n - a.n;
  const denom = dx * dx + dy * dy;
  const rawT = denom === 0 ? 0 : ((point.e - a.e) * dx + (point.n - a.n) * dy) / denom;
  const t = Math.max(0, Math.min(1, rawT));
  const projected = { e: a.e + t * dx, n: a.n + t * dy };
  return { t, point: projected, distance: distance(point, projected) };
}

function nearestOnPolyline(point: Point, points: Point[], closed = false) {
  const segments = closed ? closedSegments(points) : openSegments(points);
  let best: ReturnType<typeof projectPointToSegment> & { index: number; progress: number } | null = null;
  let traversed = 0;
  for (const segment of segments) {
    const segmentLength = distance(segment.a, segment.b);
    const candidate = projectPointToSegment(point, segment.a, segment.b);
    const decorated = {
      ...candidate,
      index: segment.index,
      progress: traversed + candidate.t * segmentLength,
    };
    if (!best || decorated.distance < best.distance) best = decorated;
    traversed += segmentLength;
  }
  return best!;
}

function pointAtProgress(points: Point[], progress: number) {
  const cumulative = cumulativeClosed(points);
  const total = cumulative.at(-1)!;
  const target = ((progress % total) + total) % total;
  for (let i = 0; i < points.length; i += 1) {
    if (target <= cumulative[i + 1]) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const segmentLength = cumulative[i + 1] - cumulative[i];
      const t = segmentLength === 0 ? 0 : (target - cumulative[i]) / segmentLength;
      return {
        point: { e: a.e + t * (b.e - a.e), n: a.n + t * (b.n - a.n) },
        tangent: { e: b.e - a.e, n: b.n - a.n },
        segmentIndex: i,
      };
    }
  }
  throw new Error('Progress did not map to the closed centerline');
}

function gateLocation(gate: Gate, centerline: Point[]) {
  const midpoint = {
    e: (toLocal(gate.a).e + toLocal(gate.b).e) / 2,
    n: (toLocal(gate.a).n + toLocal(gate.b).n) / 2,
  };
  return { midpoint, nearest: nearestOnPolyline(midpoint, centerline, true) };
}

function signedArea(points: Point[]): number {
  return closedSegments(points).reduce(
    (sum, { a, b }) => sum + a.e * b.n - b.e * a.n,
    0,
  ) / 2;
}

function bearingDegrees(tangent: Point): number {
  return (Math.atan2(tangent.e, tangent.n) * 180 / Math.PI + 360) % 360;
}

function cardinal(bearing: number): string {
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return labels[Math.round(bearing / 45) % 8];
}

function fmt(value: number, digits = 1): string {
  return value.toFixed(digits);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]!);
}

const centerline: Point[] = asset.centerline.map(toLocal);
const pitLane: Point[] = asset.pitLane.polyline.map(toLocal);
const startFinish = gateLocation(asset.startFinishGate, centerline);
const sector1 = gateLocation(asset.sectorGates[0], centerline);
const sector2 = gateLocation(asset.sectorGates[1], centerline);
const totalLength = polylineLength(centerline, true);
const pitLength = polylineLength(pitLane);
const area = signedArea(centerline);
const computedDirection = area < 0 ? 'clockwise' : 'counterclockwise';
const deltaAlong = (progress: number) => (progress - startFinish.nearest.progress + totalLength) % totalLength;
const sector1Distance = deltaAlong(sector1.nearest.progress);
const sector2Distance = deltaAlong(sector2.nearest.progress);
const sfSegment = closedSegments(centerline)[startFinish.nearest.index];
const sfTangent = { e: sfSegment.b.e - sfSegment.a.e, n: sfSegment.b.n - sfSegment.a.n };
const sfBearing = bearingDegrees(sfTangent);
const sfToPit = nearestOnPolyline(startFinish.midpoint, pitLane, false).distance;

const centerEs = centerline.map((point) => point.e);
const centerNs = centerline.map((point) => point.n);
const bbox = {
  minE: Math.min(...centerEs), maxE: Math.max(...centerEs),
  minN: Math.min(...centerNs), maxN: Math.max(...centerNs),
};

// Determine pit side from the median signed lateral offset of internal pit-lane
// vertices to their nearest centerline segment. Positive cross product is left.
const pitOffsets = pitLane.slice(1, -1).map((pitPoint) => {
  const nearest = nearestOnPolyline(pitPoint, centerline, true);
  const segment = closedSegments(centerline)[nearest.index];
  const tangent = { e: segment.b.e - segment.a.e, n: segment.b.n - segment.a.n };
  const offset = { e: pitPoint.e - nearest.point.e, n: pitPoint.n - nearest.point.n };
  const cross = tangent.e * offset.n - tangent.n * offset.e;
  return Math.sign(cross) * nearest.distance;
}).sort((a, b) => a - b);
const medianPitOffset = pitOffsets[Math.floor(pitOffsets.length / 2)];
const pitSide = medianPitOffset >= 0 ? 'left' : 'right';

const endpointGap = distance(centerline.at(-1)!, centerline[0]);
const assertions = [
  {
    name: 'closed loop',
    pass: centerline.length >= 3 && Number.isFinite(totalLength) && endpointGap <= Math.max(250, totalLength * 0.1),
    detail: `implicit last-to-first closure is ${fmt(endpointGap)} m`,
  },
  {
    name: 'S/F gate within 3×corridorWidth of centerline',
    pass: startFinish.nearest.distance <= 3 * asset.corridorWidthM,
    detail: `${fmt(startFinish.nearest.distance, 2)} m ≤ ${fmt(3 * asset.corridorWidthM)} m`,
  },
  {
    name: 'sector gate 1 at 1/3±2% of lap',
    pass: Math.abs(sector1Distance / totalLength - 1 / 3) <= 0.02,
    detail: `${fmt(100 * sector1Distance / totalLength, 2)}%`,
  },
  {
    name: 'sector gate 2 at 2/3±2% of lap',
    pass: Math.abs(sector2Distance / totalLength - 2 / 3) <= 0.02,
    detail: `${fmt(100 * sector2Distance / totalLength, 2)}%`,
  },
  {
    name: 'declared direction matches signed-area computation',
    pass: computedDirection === asset.direction,
    detail: `declared ${asset.direction}; computed ${computedDirection}`,
  },
];

const report = `# Transilvania Motor Ring geometry verification

- Projection: local ENU metres, origin at boundingRegion.center (${origin.lat}, ${origin.lon}); north up, east right.
- Centerline bounding box: **${fmt(bbox.maxE - bbox.minE)} × ${fmt(bbox.maxN - bbox.minN)} m** (east–west × north–south).
- Total closed-loop length: **${fmt(totalLength, 3)} m** (asset totalLengthM: ${fmt(asset.totalLengthM, 3)} m; difference ${fmt(totalLength - asset.totalLengthM, 3)} m).
- Travel bearing at the centerline segment nearest the S/F gate midpoint: **${fmt(sfBearing, 1)}° (${cardinal(sfBearing)})**.
- Perpendicular distance from S/F gate midpoint to nearest pit-lane point: **${fmt(sfToPit, 1)} m**.
- S/F → sector gate 1 along travel: **${fmt(sector1Distance, 1)} m** (**${fmt(sector1Distance / totalLength, 4)} lap; ${fmt(100 * sector1Distance / totalLength, 2)}%**).
- S/F → sector gate 2 along travel: **${fmt(sector2Distance, 1)} m** (**${fmt(sector2Distance / totalLength, 4)} lap; ${fmt(100 * sector2Distance / totalLength, 2)}%**).
- Signed centerline area: **${fmt(area, 1)} m²**; negative in east/north Cartesian coordinates means **clockwise**. Computed direction: **${computedDirection}**; declared direction: **${asset.direction}** — **${computedDirection === asset.direction ? 'MATCH' : 'MISMATCH'}**.
- Pit-lane length: **${fmt(pitLength, 1)} m**.
- Pit-lane side: **${pitSide} of travel** (median signed lateral offset of internal pit vertices: ${fmt(medianPitOffset, 1)} m; positive = left, negative = right).
- Raw OSM input read: **${osm.elements?.length ?? 0} element(s)** from data/osm/overpass-tmr-geom.json.

## Sanity assertions

${assertions.map((assertion) => `- **${assertion.pass ? 'PASS' : 'FAIL'}** — ${assertion.name} (${assertion.detail})`).join('\n')}

## Measurement notes

All distances are computed after projecting the asset coordinates with the same spherical equirectangular formula and IUGG mean Earth radius used by \`createProjection\`. The centerline is implicitly cyclic, so length, progress, arrows, area, and SVG rendering include the last-to-first segment. Gate progress is the closest centerline projection of each gate midpoint.
`;

const gates: Array<{ gate: Gate; label: string; color: string; width: number }> = [
  { gate: asset.startFinishGate, label: 'S/F', color: '#ef4444', width: 8 },
  { gate: asset.sectorGates[0], label: 'S1→S2', color: '#f59e0b', width: 5 },
  { gate: asset.sectorGates[1], label: 'S2→S3', color: '#f59e0b', width: 5 },
  { gate: asset.pitLane.entryGate, label: 'Pit entry', color: '#38bdf8', width: 4 },
  { gate: asset.pitLane.exitGate, label: 'Pit exit', color: '#38bdf8', width: 4 },
];
const gatePoints = gates.flatMap(({ gate }) => [toLocal(gate.a), toLocal(gate.b)]);
const allPoints = [...centerline, ...pitLane, ...gatePoints];
const minE = Math.min(...allPoints.map((point) => point.e));
const maxE = Math.max(...allPoints.map((point) => point.e));
const minN = Math.min(...allPoints.map((point) => point.n));
const maxN = Math.max(...allPoints.map((point) => point.n));
const padding = 130;
const viewMinE = minE - padding;
const viewMaxN = maxN + padding;
const viewWidth = maxE - minE + 2 * padding;
const viewHeight = maxN - minN + 2 * padding;
const sx = (point: Point) => point.e - viewMinE;
const sy = (point: Point) => viewMaxN - point.n;
const pathData = (points: Point[], close = false) =>
  points.map((point, index) => `${index ? 'L' : 'M'} ${fmt(sx(point), 2)} ${fmt(sy(point), 2)}`).join(' ') + (close ? ' Z' : '');

const gateSvg = gates.map(({ gate, label, color, width }) => {
  const a = toLocal(gate.a);
  const b = toLocal(gate.b);
  const midpoint = { e: (a.e + b.e) / 2, n: (a.n + b.n) / 2 };
  return `<g><line x1="${fmt(sx(a), 2)}" y1="${fmt(sy(a), 2)}" x2="${fmt(sx(b), 2)}" y2="${fmt(sy(b), 2)}" stroke="${color}" stroke-width="${width}"/><text x="${fmt(sx(midpoint) + 14, 2)}" y="${fmt(sy(midpoint) - 12, 2)}">${escapeXml(label)}</text></g>`;
}).join('\n    ');

const arrowSvg = [0.1, 0.4, 0.7].map((fraction) => {
  const at = pointAtProgress(centerline, totalLength * fraction);
  const norm = Math.hypot(at.tangent.e, at.tangent.n);
  const unit = { e: at.tangent.e / norm, n: at.tangent.n / norm };
  const from = { e: at.point.e - unit.e * 28, n: at.point.n - unit.n * 28 };
  const to = { e: at.point.e + unit.e * 28, n: at.point.n + unit.n * 28 };
  return `<line x1="${fmt(sx(from), 2)}" y1="${fmt(sy(from), 2)}" x2="${fmt(sx(to), 2)}" y2="${fmt(sy(to), 2)}" class="travel-arrow" marker-end="url(#arrowhead)"/><text x="${fmt(sx(at.point) + 18, 2)}" y="${fmt(sy(at.point) - 18, 2)}">${Math.round(fraction * 100)}%</text>`;
}).join('\n    ');

const scaleX = 70;
const scaleY = viewHeight - 65;
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(viewWidth, 2)} ${fmt(viewHeight, 2)}" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="title desc">
  <title id="title">Transilvania Motor Ring geometry verification</title>
  <desc id="desc">North-up metric rendering of the closed centerline, pit lane, gates, and clockwise direction arrows.</desc>
  <defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L10,4 L0,8 Z" fill="#22c55e"/></marker>
    <style>
      text { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 25px; font-weight: 700; fill: #e5e7eb; paint-order: stroke; stroke: #111827; stroke-width: 5px; stroke-linejoin: round; }
      .travel-arrow { stroke: #22c55e; stroke-width: 10; stroke-linecap: round; }
    </style>
  </defs>
  <rect width="100%" height="100%" fill="#111827"/>
  <path d="${pathData(centerline, true)}" fill="none" stroke="#f8fafc" stroke-width="14" stroke-linejoin="round" stroke-linecap="round"/>
  <path d="${pathData(pitLane)}" fill="none" stroke="#38bdf8" stroke-width="9" stroke-dasharray="25 18" stroke-linejoin="round" stroke-linecap="round"/>
  ${gateSvg}
  ${arrowSvg}
  <g aria-label="north arrow"><line x1="${fmt(viewWidth - 75)}" y1="125" x2="${fmt(viewWidth - 75)}" y2="55" stroke="#e5e7eb" stroke-width="7" marker-end="url(#arrowhead)"/><text x="${fmt(viewWidth - 88)}" y="165">N</text></g>
  <g aria-label="500 metre scale bar"><line x1="${scaleX}" y1="${fmt(scaleY)}" x2="${scaleX + 500}" y2="${fmt(scaleY)}" stroke="#e5e7eb" stroke-width="9"/><line x1="${scaleX}" y1="${fmt(scaleY - 15)}" x2="${scaleX}" y2="${fmt(scaleY + 15)}" stroke="#e5e7eb" stroke-width="7"/><line x1="${scaleX + 500}" y1="${fmt(scaleY - 15)}" x2="${scaleX + 500}" y2="${fmt(scaleY + 15)}" stroke="#e5e7eb" stroke-width="7"/><text x="${scaleX + 215}" y="${fmt(scaleY - 20)}">500 m</text></g>
</svg>
`;

await mkdir(here, { recursive: true });
await writeFile(svgPath, svg, 'utf8');
await writeFile(reportPath, report, 'utf8');

console.log(`Wrote ${svgPath}`);
console.log(`Wrote ${reportPath}`);
for (const assertion of assertions) {
  console.log(`${assertion.pass ? 'PASS' : 'FAIL'} — ${assertion.name} (${assertion.detail})`);
}
if (assertions.some((assertion) => !assertion.pass)) process.exitCode = 1;
