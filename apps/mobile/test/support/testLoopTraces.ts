import { createProjection, type LocationSample } from '@circuit/core';

/**
 * Mobile-side synthetic Test Loop trace (ticket P5d). A trimmed copy of
 * `packages/core/test/testloop/traces.ts`'s rounded-rectangle generator --
 * kept local for the same cross-tsconfig reason as `coreTestDoubles.ts`
 * (core's own `test/` tree is not part of the published module graph).
 *
 * A counterclockwise rounded rectangle, ~677 m round, driven at 16 m/s on the
 * straights and 8 m/s through the four 25 m-radius bends, starting mid-way
 * along the bottom straight.
 */

const ORIGIN = { lat: 46.7712, lon: 23.6236 };

interface Point {
  e: number;
  n: number;
}

function straight(from: Point, to: Point): Point[] {
  const lengthM = Math.hypot(to.e - from.e, to.n - from.n);
  const steps = Math.max(1, Math.round(lengthM));
  return Array.from({ length: steps }, (_, index) => ({
    e: from.e + ((to.e - from.e) * index) / steps,
    n: from.n + ((to.n - from.n) * index) / steps,
  }));
}

function arc(centre: Point, radiusM: number, fromDeg: number, toDeg: number): Point[] {
  const sweepRad = ((toDeg - fromDeg) * Math.PI) / 180;
  const steps = Math.max(1, Math.round(Math.abs(sweepRad) * radiusM));
  return Array.from({ length: steps }, (_, index) => {
    const angleRad = (fromDeg * Math.PI) / 180 + (sweepRad * index) / steps;
    return {
      e: centre.e + radiusM * Math.cos(angleRad),
      n: centre.n + radiusM * Math.sin(angleRad),
    };
  });
}

function smooth(values: readonly number[], half: number): number[] {
  const count = values.length;
  return values.map((_, index) => {
    let total = 0;
    for (let offset = -half; offset <= half; offset += 1) {
      total += values[(index + offset + count * 2) % count] ?? 0;
    }
    return total / (2 * half + 1);
  });
}

function rectanglePath(): { points: Point[]; speedMps: number[] } {
  const widthM = 220;
  const heightM = 140;
  const r = 25;
  const fast = 16;
  const slow = 8;
  const segments: Array<{ points: Point[]; speedMps: number }> = [
    { points: straight({ e: r, n: 0 }, { e: widthM - r, n: 0 }), speedMps: fast },
    { points: arc({ e: widthM - r, n: r }, r, -90, 0), speedMps: slow },
    { points: straight({ e: widthM, n: r }, { e: widthM, n: heightM - r }), speedMps: fast },
    { points: arc({ e: widthM - r, n: heightM - r }, r, 0, 90), speedMps: slow },
    { points: straight({ e: widthM - r, n: heightM }, { e: r, n: heightM }), speedMps: fast },
    { points: arc({ e: r, n: heightM - r }, r, 90, 180), speedMps: slow },
    { points: straight({ e: 0, n: heightM - r }, { e: 0, n: r }), speedMps: fast },
    { points: arc({ e: r, n: r }, r, 180, 270), speedMps: slow },
  ];
  const points: Point[] = [];
  const speeds: number[] = [];
  for (const segment of segments) {
    for (const point of segment.points) {
      points.push(point);
      speeds.push(segment.speedMps);
    }
  }
  const offset = Math.round((widthM - 2 * r) / 2);
  return {
    points: [...points.slice(offset), ...points.slice(0, offset)],
    speedMps: smooth([...speeds.slice(offset), ...speeds.slice(0, offset)], 15),
  };
}

export interface TestLoopTraceOptions {
  /** How many times round the loop (1 = the learning lap only). */
  laps?: number;
  periodMs?: number;
  startTMono?: number;
  startTUtc?: number;
}

/** A 1 Hz GNSS trace of `laps` laps of the rectangle loop. */
export function rectangleLoopSamples(options: TestLoopTraceOptions = {}): LocationSample[] {
  const { points, speedMps } = rectanglePath();
  const periodMs = options.periodMs ?? 1000;
  const laps = Math.max(1, options.laps ?? 1);
  const projection = createProjection(ORIGIN);
  const samples: LocationSample[] = [];
  const count = points.length;
  let tMono = options.startTMono ?? 0;
  let index = 0;
  let carried = 0;

  while (index < count * laps) {
    const wrapped = index % count;
    const point = points[wrapped];
    const next = points[(wrapped + 1) % count];
    const speed = speedMps[wrapped] ?? 10;
    if (point === undefined || next === undefined) break;
    const { lat, lon } = projection.toLatLon(point);
    samples.push({
      tMono,
      ...(options.startTUtc === undefined ? {} : { tUtc: options.startTUtc + tMono }),
      lat,
      lon,
      speedMps: speed,
      accuracyM: 3,
      headingDeg: ((Math.atan2(next.e - point.e, next.n - point.n) * 180) / Math.PI + 360) % 360,
      source: 'gnss',
    });
    const advanceM = (speed * periodMs) / 1000 + carried;
    const wholeM = Math.floor(advanceM);
    carried = advanceM - wholeM;
    index += Math.max(1, wholeM);
    tMono += periodMs;
  }
  return samples;
}

/** An out-and-back that never closes a loop -- the honest-failure fixture. */
export function uTurnSamples(): LocationSample[] {
  const projection = createProjection(ORIGIN);
  const points = [
    ...straight({ e: 0, n: 0 }, { e: 120, n: 0 }),
    ...arc({ e: 120, n: 6 }, 6, -90, 90),
    ...straight({ e: 120, n: 12 }, { e: 0, n: 12 }),
  ];
  return points
    .filter((_, index) => index % 12 === 0)
    .map((point, index) => {
      const { lat, lon } = projection.toLatLon(point);
      return {
        tMono: index * 1000,
        lat,
        lon,
        speedMps: 12,
        accuracyM: 3,
        source: 'gnss' as const,
      };
    });
}
