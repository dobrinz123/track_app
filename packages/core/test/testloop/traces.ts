import { createProjection } from '../../src/geometry';
import type { LatLon, LocalPoint, LocationSample } from '../../src/contracts';

/**
 * Synthetic GNSS traces for the Test Loop tests (ticket P5d T1). Everything is
 * built in the ENU plane first -- a rounded rectangle, a U-turn, a figure
 * eight -- and only then pushed back out to lat/lon through the SAME
 * `createProjection` the production code uses, so a test trace is exactly as
 * accurate as a real one and no test depends on a projection of its own.
 */

/** Deterministic 32-bit PRNG (mulberry32) -- a noisy trace must be the same noisy trace on every run. */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, driven by `makeRandom` so noise is reproducible. */
function gaussian(random: () => number): number {
  const u = Math.max(random(), Number.EPSILON);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const TEST_ORIGIN: LatLon = { lat: 46.7712, lon: 23.6236 };

/** Dense (1 m) ENU path plus the speed the car holds at each point. */
export interface DensePath {
  points: LocalPoint[];
  speedMps: number[];
}

function arc(
  centre: LocalPoint,
  radiusM: number,
  fromDeg: number,
  toDeg: number,
  stepM: number,
): LocalPoint[] {
  const sweepRad = ((toDeg - fromDeg) * Math.PI) / 180;
  const arcLengthM = Math.abs(sweepRad) * radiusM;
  const steps = Math.max(1, Math.round(arcLengthM / stepM));
  const points: LocalPoint[] = [];
  for (let index = 0; index < steps; index += 1) {
    const angleRad = (fromDeg * Math.PI) / 180 + (sweepRad * index) / steps;
    points.push({
      e: centre.e + radiusM * Math.cos(angleRad),
      n: centre.n + radiusM * Math.sin(angleRad),
    });
  }
  return points;
}

function straight(from: LocalPoint, to: LocalPoint, stepM: number): LocalPoint[] {
  const lengthM = Math.hypot(to.e - from.e, to.n - from.n);
  const steps = Math.max(1, Math.round(lengthM / stepM));
  const points: LocalPoint[] = [];
  for (let index = 0; index < steps; index += 1) {
    const fraction = index / steps;
    points.push({
      e: from.e + (to.e - from.e) * fraction,
      n: from.n + (to.n - from.n) * fraction,
    });
  }
  return points;
}

/** Blends step-function segment speeds into a realistic ramp (metres of blend either side). */
function smoothSpeeds(speeds: readonly number[], windowM: number): number[] {
  const half = Math.max(1, Math.round(windowM / 2));
  const count = speeds.length;
  return speeds.map((_, index) => {
    let total = 0;
    for (let offset = -half; offset <= half; offset += 1) {
      total += speeds[(index + offset + count * 2) % count] ?? 0;
    }
    return total / (2 * half + 1);
  });
}

/**
 * A closed rounded-rectangle loop, counterclockwise, starting mid-way along
 * the bottom straight (so the start point sits on a straight with an
 * unambiguous heading -- exactly the "pull away from the kerb" case the mode
 * is for).
 */
export function roundedRectanglePath(
  widthM = 220,
  heightM = 140,
  radiusM = 25,
  stepM = 1,
): DensePath {
  const r = radiusM;
  const straightSpeed = 16;
  const cornerSpeed = 8;
  const segments: Array<{ points: LocalPoint[]; speedMps: number }> = [
    { points: straight({ e: r, n: 0 }, { e: widthM - r, n: 0 }, stepM), speedMps: straightSpeed },
    { points: arc({ e: widthM - r, n: r }, r, -90, 0, stepM), speedMps: cornerSpeed },
    {
      points: straight({ e: widthM, n: r }, { e: widthM, n: heightM - r }, stepM),
      speedMps: straightSpeed,
    },
    { points: arc({ e: widthM - r, n: heightM - r }, r, 0, 90, stepM), speedMps: cornerSpeed },
    {
      points: straight({ e: widthM - r, n: heightM }, { e: r, n: heightM }, stepM),
      speedMps: straightSpeed,
    },
    { points: arc({ e: r, n: heightM - r }, r, 90, 180, stepM), speedMps: cornerSpeed },
    { points: straight({ e: 0, n: heightM - r }, { e: 0, n: r }, stepM), speedMps: straightSpeed },
    { points: arc({ e: r, n: r }, r, 180, 270, stepM), speedMps: cornerSpeed },
  ];

  const points: LocalPoint[] = [];
  const speedMps: number[] = [];
  for (const segment of segments) {
    for (const point of segment.points) {
      points.push(point);
      speedMps.push(segment.speedMps);
    }
  }

  // Rotate so the loop starts halfway along the bottom straight.
  const offset = Math.round((widthM - 2 * r) / 2 / stepM);
  const rotatedPoints = [...points.slice(offset), ...points.slice(0, offset)];
  const rotatedSpeeds = [...speedMps.slice(offset), ...speedMps.slice(0, offset)];
  return { points: rotatedPoints, speedMps: smoothSpeeds(rotatedSpeeds, 30) };
}

/** An out-and-back U-turn: never a loop, and only about 2 x `outM` long. */
export function uTurnPath(outM = 120, stepM = 1): DensePath {
  const out = straight({ e: 0, n: 0 }, { e: outM, n: 0 }, stepM);
  const turn = arc({ e: outM, n: 6 }, 6, -90, 90, stepM);
  const back = straight({ e: outM, n: 12 }, { e: 0, n: 12 }, stepM);
  const points = [...out, ...turn, ...back];
  return { points, speedMps: points.map(() => 12) };
}

/** Decimates a finely-sampled curve down to ~`stepM` spacing. */
function decimate(points: readonly LocalPoint[], stepM: number): LocalPoint[] {
  const out: LocalPoint[] = [];
  let last: LocalPoint | null = null;
  for (const point of points) {
    if (last === null || Math.hypot(point.e - last.e, point.n - last.n) >= stepM) {
      out.push(point);
      last = point;
    }
  }
  return out;
}

/**
 * A real figure eight (Gerono lemniscate), driven from the RIGHT extremity --
 * so the self-crossing is nowhere near the start point and the whole eight is
 * learned as ONE loop, exactly once.
 */
export function figureEightPath(halfWidthM = 150, stepM = 1): DensePath {
  const fine: LocalPoint[] = [];
  const steps = 40_000;
  for (let index = 0; index <= steps; index += 1) {
    const t = (2 * Math.PI * index) / steps;
    fine.push({ e: halfWidthM * Math.cos(t), n: (halfWidthM / 2) * Math.sin(2 * t) });
  }
  const points = decimate(fine, stepM);
  return { points, speedMps: points.map(() => 12) };
}

/**
 * Drives out east, comes back WEST across the start point 20 m to the side
 * (inside the closing radius, heading 180 degrees off), then turns and
 * finally returns east through the start. Only the SECOND return is a
 * closure -- the first one is the heading test doing its job.
 */
export function headingMismatchPath(stepM = 1): DensePath {
  const points = [
    ...straight({ e: 0, n: 0 }, { e: 200, n: 0 }, stepM),
    ...arc({ e: 200, n: 10 }, 10, -90, 90, stepM),
    ...straight({ e: 200, n: 20 }, { e: -200, n: 20 }, stepM),
    ...arc({ e: -200, n: 10 }, 10, 90, 270, stepM),
    ...straight({ e: -200, n: 0 }, { e: 30, n: 0 }, stepM),
  ];
  return { points, speedMps: points.map(() => 12) };
}

export interface SampleOptions {
  /** Sampling period, ms (1000 = 1 Hz). */
  periodMs?: number;
  /** Horizontal noise sigma, metres (0 = perfect fixes). */
  noiseSigmaM?: number;
  /** Reported accuracy, metres. */
  accuracyM?: number;
  seed?: number;
  /** Emit `headingDeg` on each sample (a phone does; some fixes do not). */
  withHeading?: boolean;
  startTMono?: number;
  /** Repeat the whole path this many times (laps 2+ of the same loop). */
  laps?: number;
}

/** Walks a dense path in TIME, emitting the `LocationSample`s the pipeline would see. */
export function sampleDensePath(path: DensePath, options: SampleOptions = {}): LocationSample[] {
  const periodMs = options.periodMs ?? 1000;
  const noiseSigmaM = options.noiseSigmaM ?? 0;
  const laps = Math.max(1, options.laps ?? 1);
  const random = makeRandom(options.seed ?? 12345);
  const projection = createProjection(TEST_ORIGIN);
  const samples: LocationSample[] = [];
  const count = path.points.length;
  let tMono = options.startTMono ?? 0;

  let index = 0;
  let carried = 0;
  const total = count * laps;
  while (index < total) {
    const wrapped = index % count;
    const point = path.points[wrapped];
    const speed = path.speedMps[wrapped] ?? 10;
    if (point === undefined) break;
    const next = path.points[(wrapped + 1) % count] ?? point;
    const headingDeg =
      ((Math.atan2(next.e - point.e, next.n - point.n) * 180) / Math.PI + 360) % 360;
    const noisy: LocalPoint =
      noiseSigmaM === 0
        ? point
        : {
            e: point.e + gaussian(random) * noiseSigmaM,
            n: point.n + gaussian(random) * noiseSigmaM,
          };
    const { lat, lon } = projection.toLatLon(noisy);
    samples.push({
      tMono,
      lat,
      lon,
      speedMps: speed,
      accuracyM: options.accuracyM ?? (noiseSigmaM === 0 ? 3 : noiseSigmaM * 1.5),
      ...(options.withHeading === false ? {} : { headingDeg }),
      source: 'gnss',
    });
    // Advance along the 1 m path by the distance covered in one period.
    const advanceM = (speed * periodMs) / 1000 + carried;
    const wholeM = Math.floor(advanceM);
    carried = advanceM - wholeM;
    index += Math.max(1, wholeM);
    tMono += periodMs;
  }
  return samples;
}

/** Convenience: a clean 1 Hz rectangle-loop trace. */
export function rectangleLoopSamples(options: SampleOptions = {}): LocationSample[] {
  return sampleDensePath(roundedRectanglePath(), options);
}

/**
 * A car parked with the engine running: no motion at all, only GNSS drift
 * around one point. Must never look like departure, distance or a closure.
 */
export function parkedDriftSamples(count = 400, sigmaM = 8, seed = 21): LocationSample[] {
  const random = makeRandom(seed);
  const projection = createProjection(TEST_ORIGIN);
  return Array.from({ length: count }, (_, index) => {
    const { lat, lon } = projection.toLatLon({
      e: gaussian(random) * sigmaM,
      n: gaussian(random) * sigmaM,
    });
    return {
      tMono: index * 1000,
      lat,
      lon,
      speedMps: Math.abs(gaussian(random)) * 0.2,
      accuracyM: 30,
      source: 'gnss' as const,
    };
  });
}

/** Splices one implausible position jump (an urban-canyon reflection) into a trace. */
export function withJump(
  samples: readonly LocationSample[],
  atIndex: number,
  eastM: number,
  northM: number,
): LocationSample[] {
  const projection = createProjection(TEST_ORIGIN);
  return samples.map((sample, index) => {
    if (index !== atIndex) return sample;
    const local = projection.toLocal({ lat: sample.lat, lon: sample.lon });
    const { lat, lon } = projection.toLatLon({ e: local.e + eastM, n: local.n + northM });
    return { ...sample, lat, lon };
  });
}

/** A small rounded rectangle -- under the 300 m minimum on its own. */
export function smallLoopPath(stepM = 1): DensePath {
  return roundedRectanglePath(80, 50, 12, stepM);
}

/**
 * A loop whose straights are covered in small lateral wiggles: every wiggle is
 * a curvature candidate, so this is what a naive corner derivation explodes on.
 */
export function wigglyLoopPath(stepM = 1): DensePath {
  const base = roundedRectanglePath(240, 160, 25, stepM);
  const amplitudeM = 2.5;
  const wavelengthM = 12;
  const count = base.points.length;
  const points = base.points.map((point, index) => {
    const previous = base.points[(index - 1 + count) % count] ?? point;
    const next = base.points[(index + 1) % count] ?? point;
    const tangentE = next.e - previous.e;
    const tangentN = next.n - previous.n;
    const length = Math.hypot(tangentE, tangentN) || 1;
    const normalE = tangentN / length;
    const normalN = -tangentE / length;
    const offset = amplitudeM * Math.sin((2 * Math.PI * index) / wavelengthM);
    return { e: point.e + normalE * offset, n: point.n + normalN * offset };
  });
  return { points, speedMps: base.speedMps };
}
