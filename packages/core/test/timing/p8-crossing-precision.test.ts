/**
 * Ticket P8 -- MEASUREMENT HARNESS.
 *
 * Generates laps whose start/finish crossing instant is KNOWN to sub-millisecond
 * precision, corrupts them with realistic GNSS error, and measures how far each
 * timing strategy lands from that truth.
 *
 * How truth is constructed (and why it is trustworthy):
 *  - A continuous trajectory is defined by an along-CENTERLINE speed profile
 *    u(tau) and a lateral racing-line offset. Position is evaluated in the
 *    profile's own ENU frame from the profile's own centerline, so nothing
 *    about the geometry is re-derived or re-guessed here.
 *  - The truth instant is found by BISECTING the same predicate the detector
 *    uses -- the sign of cross(gateB - gateA, p(tau) - gateA) -- to 1e-4 ms.
 *    Truth and estimate therefore mean the same thing by construction.
 *  - The Doppler channel is the magnitude of the numerically differentiated
 *    2-D position, i.e. GROUND speed along the driven path, NOT the
 *    along-centerline rate. That is what a phone actually reports, and it is
 *    what makes the racing-line projection error in the filter real rather
 *    than assumed away.
 *
 * Error model: 3 m per-axis Gaussian position noise, 0.1 m/s Gaussian Doppler
 * noise, accuracyM = 3, 1 Hz, sampling phase swept uniformly across the fix
 * interval so the crossing lands at every point of it.
 *
 * All three strategies are fed the IDENTICAL TrackMatch/LocationSample stream,
 * so any difference in the reported crossings is attributable to the timing
 * code alone -- which is also how the detection-unchanged assertion below is
 * made exact rather than statistical.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { CircuitProfile, CrossingEvent, LocalPoint, LocationSample } from '../../src/contracts';
import { SeededPrng } from '../../src/fixtures';
import { loadProfileFromJson, type RuntimeProfile } from '../../src/profile';
import { TrackMatcher } from '../../src/matching';
import { CrossingDetector, type ProjectedGate } from '../../src/timing/crossing-detector';
import type { CrossingDetectorConfig } from '../../src/timing/crossing-detector';

function tmr(): { profile: CircuitProfile; runtime: RuntimeProfile } {
  const json = readFileSync(
    new URL('../../assets/circuits/transilvania-motor-ring.v2.json', import.meta.url),
    'utf8',
  );
  const loaded = loadProfileFromJson(json);
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return { profile: loaded.profile, runtime: loaded.runtime };
}

// ---------------------------------------------------------------- geometry

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

interface Frame {
  point: LocalPoint;
  /** Unit tangent, in the direction of increasing arc distance. */
  tangent: LocalPoint;
}

/** Point and unit tangent at an arc distance along the closed centerline. */
function frameAt(runtime: RuntimeProfile, rawDistanceM: number): Frame {
  const points = runtime.centerline;
  const cumulative = runtime.cumulativeDistancesM;
  const totalM = cumulative[cumulative.length - 1] ?? 0;
  const closedTotalM =
    totalM +
    Math.hypot(
      (points[0]?.e ?? 0) - (points[points.length - 1]?.e ?? 0),
      (points[0]?.n ?? 0) - (points[points.length - 1]?.n ?? 0),
    );
  const target = modulo(rawDistanceM, closedTotalM);
  let index = points.length - 1;
  for (let i = 0; i < points.length - 1; i += 1) {
    const next = cumulative[i + 1];
    if (next !== undefined && target < next) {
      index = i;
      break;
    }
  }
  const a = points[index];
  const b = points[(index + 1) % points.length];
  if (a === undefined || b === undefined) throw new Error('sparse centerline');
  const startM = cumulative[index] ?? 0;
  const lengthM = Math.hypot(b.e - a.e, b.n - a.n);
  const f = lengthM === 0 ? 0 : Math.max(0, Math.min(1, (target - startM) / lengthM));
  return {
    point: { e: a.e + (b.e - a.e) * f, n: a.n + (b.n - a.n) * f },
    tangent: { e: (b.e - a.e) / lengthM, n: (b.n - a.n) / lengthM },
  };
}

/** The driven point: centerline at arc distance `s`, pushed `lateral(s)` metres off it. */
function drivenPoint(
  runtime: RuntimeProfile,
  rawDistanceM: number,
  lateral: (rawDistanceM: number) => number,
): LocalPoint {
  const { point, tangent } = frameAt(runtime, rawDistanceM);
  const offset = lateral(rawDistanceM);
  return { e: point.e - tangent.n * offset, n: point.n + tangent.e * offset };
}

// ---------------------------------------------------------------- scenarios

interface Scenario {
  name: string;
  /** Along-centerline speed, m/s, as a function of arc distance still to go before the line. */
  speedAt: (secondsFromStart: number) => number;
  /** Seconds of run-up before the crossing. */
  runupS: number;
  /** Racing-line lateral offset amplitude, metres. */
  lateralAmplitudeM: number;
  note: string;
}

const KMH = 1 / 3.6;

const SCENARIOS: Scenario[] = [
  {
    name: 'steady 80 km/h',
    speedAt: () => 80 * KMH,
    runupS: 30,
    lateralAmplitudeM: 4,
    note: 'constant speed, slow end of the range',
  },
  {
    name: 'steady 150 km/h',
    speedAt: () => 150 * KMH,
    runupS: 30,
    lateralAmplitudeM: 4,
    note: "constant speed, the ticket's reference case",
  },
  {
    name: 'steady 200 km/h',
    speedAt: () => 200 * KMH,
    runupS: 30,
    lateralAmplitudeM: 4,
    note: 'constant speed, fast end of the range',
  },
  {
    name: 'braking 1.0 g through the line',
    // 200 km/h until 1.5 s before the line, then a full 1 g stop-style brake
    // straight through it -- the case linear interpolation gets most wrong.
    speedAt: (t) => Math.max(20 * KMH, 200 * KMH - 9.81 * Math.max(0, t - (30 - 1.5))),
    runupS: 30,
    lateralAmplitudeM: 4,
    note: 'heavy braking zone on the line',
  },
  {
    name: 'accelerating 0.5 g through the line',
    speedAt: (t) => Math.min(220 * KMH, 100 * KMH + 4.9 * Math.max(0, t - (30 - 3))),
    runupS: 30,
    lateralAmplitudeM: 4,
    note: 'power-down exit over the line',
  },
  {
    name: 'steady 150 km/h, centerline (no racing line)',
    speedAt: () => 150 * KMH,
    runupS: 30,
    lateralAmplitudeM: 0,
    note: 'isolates the ground-speed vs along-track projection effect',
  },
];

// ---------------------------------------------------------------- truth + fixes

const TRUTH_STEP_MS = 0.5;

interface Trial {
  samples: LocationSample[];
  truthTMono: number;
}

/**
 * Builds one trial: a continuous trajectory, its exact gate-crossing instant,
 * and the 1 Hz noisy fix stream sampled from it at the given phase.
 */
function buildTrial(
  runtime: RuntimeProfile,
  scenario: Scenario,
  prng: SeededPrng,
  phaseMs: number,
  positionSigmaM: number,
  dopplerSigmaMps: number,
): Trial {
  const gateDistanceM = runtime.startFinishGate.distanceM;
  const gateA = runtime.startFinishGate.a;
  const gateB = runtime.startFinishGate.b;
  const gateE = gateB.e - gateA.e;
  const gateN = gateB.n - gateA.n;

  const lateral = (rawDistanceM: number): number =>
    scenario.lateralAmplitudeM === 0
      ? 0
      : scenario.lateralAmplitudeM * Math.sin((rawDistanceM / 220) * Math.PI * 2);

  // The trajectory starts `runupS` before the line. Integrate the along-track
  // speed BACKWARDS from the line to find where to start, then forwards on a
  // fine grid so s(tau) is exact to the grid.
  let backS = 0;
  let backDistance = 0;
  while (backS < scenario.runupS) {
    const u = scenario.speedAt(scenario.runupS - backS);
    backDistance += (u * TRUTH_STEP_MS) / 1_000;
    backS += TRUTH_STEP_MS / 1_000;
  }
  const originRawM = gateDistanceM - backDistance;

  const stepCount = Math.ceil(((scenario.runupS + 3) * 1_000) / TRUTH_STEP_MS);
  const arcM = new Float64Array(stepCount + 1);
  let s = originRawM;
  arcM[0] = s;
  for (let i = 1; i <= stepCount; i += 1) {
    const u = scenario.speedAt(((i - 1) * TRUTH_STEP_MS) / 1_000);
    s += (u * TRUTH_STEP_MS) / 1_000;
    arcM[i] = s;
  }

  const arcAt = (tMs: number): number => {
    const x = tMs / TRUTH_STEP_MS;
    const i = Math.max(0, Math.min(stepCount - 1, Math.floor(x)));
    const f = x - i;
    return (arcM[i] ?? 0) + ((arcM[i + 1] ?? 0) - (arcM[i] ?? 0)) * f;
  };
  const posAt = (tMs: number): LocalPoint => drivenPoint(runtime, arcAt(tMs), lateral);
  /** Ground speed: the magnitude of the derivative of the DRIVEN path, which is what Doppler measures. */
  const groundSpeedAt = (tMs: number): number => {
    const h = 5;
    const p1 = posAt(tMs - h);
    const p2 = posAt(tMs + h);
    return Math.hypot(p2.e - p1.e, p2.n - p1.n) / ((2 * h) / 1_000);
  };
  const sideAt = (tMs: number): number => {
    const p = posAt(tMs);
    return gateE * (p.n - gateA.n) - gateN * (p.e - gateA.e);
  };

  // Truth: bisect the detector's own crossing predicate. The gate LINE is
  // infinite, and a closed circuit re-crosses its extension elsewhere, so the
  // bracket is pinned to the moment the along-track arc reaches the gate --
  // then widened by +/-0.8 s, far more than any racing-line offset can shift
  // the actual crossing along an almost-perpendicular gate.
  let arcIndex = 0;
  while (arcIndex <= stepCount && (arcM[arcIndex] ?? 0) < gateDistanceM) arcIndex += 1;
  if (arcIndex > stepCount) throw new Error(`trajectory never reaches the gate (${scenario.name})`);
  const nominalMs = arcIndex * TRUTH_STEP_MS;
  let lo = Math.max(0, nominalMs - 800);
  let hi = Math.min(stepCount * TRUTH_STEP_MS, nominalMs + 800);
  const loSide = sideAt(lo);
  if (loSide === 0 || Math.sign(loSide) === Math.sign(sideAt(hi))) {
    throw new Error(`trajectory does not cross the gate exactly once (${scenario.name})`);
  }
  for (let i = 0; i < 80 && hi - lo > 1e-4; i += 1) {
    const mid = (lo + hi) / 2;
    if (Math.sign(sideAt(mid)) === Math.sign(loSide)) lo = mid;
    else hi = mid;
  }
  const truthMs = (lo + hi) / 2;

  const samples: LocationSample[] = [];
  const lastMs = stepCount * TRUTH_STEP_MS;
  for (let tMs = phaseMs; tMs <= lastMs - 10; tMs += 1_000) {
    const truthPoint = posAt(tMs);
    const noisy = {
      e: truthPoint.e + prng.gaussian() * positionSigmaM,
      n: truthPoint.n + prng.gaussian() * positionSigmaM,
    };
    const geo = runtime.projection.toLatLon(noisy);
    samples.push({
      tMono: tMs,
      lat: geo.lat,
      lon: geo.lon,
      accuracyM: positionSigmaM,
      speedMps: Math.max(0.1, groundSpeedAt(tMs) + prng.gaussian() * dopplerSigmaMps),
      source: 'replay',
    });
  }
  return { samples, truthTMono: truthMs };
}

// ---------------------------------------------------------------- strategies

const LINEAR: CrossingDetectorConfig = { dopplerCrossingTime: false, alongTrackFusion: false };
const P81: CrossingDetectorConfig = { dopplerCrossingTime: true, alongTrackFusion: false };
const P81_P82: CrossingDetectorConfig = { dopplerCrossingTime: true, alongTrackFusion: true };
/**
 * The same thing with the ground-speed/along-track projection allowance turned
 * OFF -- i.e. a filter that believes the Doppler channel measures along-track
 * speed exactly. Kept in the default table because it is the obvious
 * implementation and it is measurably worse than doing nothing.
 */
const P81_P82_NAIVE: CrossingDetectorConfig = {
  dopplerCrossingTime: true,
  alongTrackFusion: true,
  alongTrackFilter: { dopplerProjectionFraction: 0 },
};

function projectedGates(runtime: RuntimeProfile): ProjectedGate[] {
  const gates = [runtime.startFinishGate, ...runtime.sectorGates];
  if (runtime.pitLane !== undefined) gates.push(runtime.pitLane.entryGate, runtime.pitLane.exitGate);
  return gates.map(({ gate, a, b }) => ({ gate, aLocal: a, bLocal: b }));
}

interface RunOutcome {
  /** Crossing identity, ignoring tCross -- the detection-unchanged fingerprint. */
  fingerprint: string;
  /** tCross of the forward start/finish crossing, or null when none was detected. */
  startFinishTCross: number | null;
}

/** Fixes the matcher placed on the pit lane (which suppresses timing gates). */
let lastPitLaneMatches = 0;

/**
 * Runs every strategy over ONE shared matcher pass, so the TrackMatch stream is
 * byte-identical across strategies and only the timing code differs.
 */
function runStrategies(
  runtime: RuntimeProfile,
  samples: LocationSample[],
  configs: readonly CrossingDetectorConfig[],
): RunOutcome[] {
  const matcher = new TrackMatcher(runtime, { corridorWidthM: 25 });
  const gates = projectedGates(runtime);
  const detectors = configs.map((config) => new CrossingDetector(gates, runtime.projection, config));
  const events: CrossingEvent[][] = configs.map(() => []);

  let prevMatch = null as ReturnType<TrackMatcher['match']>;
  let prevSample: LocationSample | null = null;
  lastPitLaneMatches = 0;
  for (const sample of samples) {
    const match = matcher.match(sample);
    if (match === null) continue;
    if (match.onPitLane) lastPitLaneMatches += 1;
    detectors.forEach((detector, index) => {
      const produced = detector.update(prevMatch, match, prevSample, sample);
      for (const event of produced) events[index]?.push(event);
    });
    prevMatch = match;
    prevSample = sample;
  }

  return events.map((list) => ({
    fingerprint: list
      .map((e) => `${e.gateId}|${e.direction}|${e.lapDistanceM.toFixed(6)}|${e.confidence.toFixed(6)}`)
      .join(';'),
    startFinishTCross:
      list.find((e) => e.kind === 'startFinish' && e.direction === 'forward')?.tCross ?? null,
  }));
}

// ---------------------------------------------------------------- statistics

function meanAbs(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, v) => sum + Math.abs(v), 0) / values.length;
}

function percentileAbs(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].map(Math.abs).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

function bias(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

const SWEEP = process.env['P8_SWEEP'] === '1';
const SWEEP_KAPPAS = [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.05, 0.08];
const STRATEGY_NAMES = SWEEP
  ? ['linear (today)', ...SWEEP_KAPPAS.map((k) => `P8.1+P8.2 kappa=${k}`)]
  : ['linear (today)', 'P8.1 only', 'P8.1 + P8.2', 'P8.1+P8.2, no kappa'];
const STRATEGY_CONFIGS: CrossingDetectorConfig[] = SWEEP
  ? [
      LINEAR,
      ...SWEEP_KAPPAS.map((k) => ({
        dopplerCrossingTime: true,
        alongTrackFusion: true,
        alongTrackFilter: { dopplerProjectionFraction: k },
      })),
    ]
  : [LINEAR, P81, P81_P82, P81_P82_NAIVE];
const TRIALS = Number(process.env['P8_TRIALS'] ?? 150);
const POSITION_SIGMA_M = 3;
const DOPPLER_SIGMA_MPS = 0.1;

interface ScenarioResult {
  scenario: Scenario;
  errorsMs: number[][];
  detections: number[];
  fingerprintMismatches: number;
  trials: number;
}

function measure(runtime: RuntimeProfile): ScenarioResult[] {
  return SCENARIOS.map((scenario) => {
    const errorsMs: number[][] = STRATEGY_CONFIGS.map(() => []);
    const detections = STRATEGY_CONFIGS.map(() => 0);
    let fingerprintMismatches = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const prng = new SeededPrng(1_000 + trial);
      const phaseMs = (trial / TRIALS) * 1_000;
      const { samples, truthTMono } = buildTrial(
        runtime,
        scenario,
        prng,
        phaseMs,
        POSITION_SIGMA_M,
        DOPPLER_SIGMA_MPS,
      );
      const outcomes = runStrategies(runtime, samples, STRATEGY_CONFIGS);
      const reference = outcomes[0]?.fingerprint ?? '';
      if (process.env['P8_DUMP_MISSES'] === '1' && outcomes[0]?.startFinishTCross === null) {
        console.log(
          `MISS ${scenario.name} trial=${trial} phase=${phaseMs.toFixed(0)} ` +
            `pitLaneMatches=${lastPitLaneMatches} events=[${reference}]`,
        );
      }
      outcomes.forEach((outcome, index) => {
        if (outcome.fingerprint !== reference) fingerprintMismatches += 1;
        if (outcome.startFinishTCross !== null) {
          detections[index] = (detections[index] ?? 0) + 1;
          errorsMs[index]?.push(outcome.startFinishTCross - truthTMono);
        }
      });
    }
    return { scenario, errorsMs, detections, fingerprintMismatches, trials: TRIALS };
  });
}

function renderTable(results: ScenarioResult[]): string {
  const lines: string[] = [];
  lines.push(
    `P8 crossing-time error vs known truth -- ${TRIALS} trials/scenario, 1 Hz, ` +
      `position sigma ${POSITION_SIGMA_M} m/axis, Doppler sigma ${DOPPLER_SIGMA_MPS} m/s`,
  );
  lines.push('');
  const header = `| ${'scenario'.padEnd(40)} | ${'strategy'.padEnd(22)} | mean|err| ms | p95|err| ms | bias ms | detected |`;
  lines.push(header);
  lines.push(`|${'-'.repeat(42)}|${'-'.repeat(24)}|${'-'.repeat(14)}|${'-'.repeat(13)}|${'-'.repeat(9)}|${'-'.repeat(10)}|`);
  for (const result of results) {
    STRATEGY_NAMES.forEach((name, index) => {
      const errors = result.errorsMs[index] ?? [];
      lines.push(
        `| ${(index === 0 ? result.scenario.name : '').padEnd(40)} | ${name.padEnd(22)} | ` +
          `${meanAbs(errors).toFixed(1).padStart(12)} | ${percentileAbs(errors, 95).toFixed(1).padStart(11)} | ` +
          `${bias(errors).toFixed(1).padStart(7)} | ${String(result.detections[index]).padStart(8)} |`,
      );
    });
  }
  lines.push('');
  lines.push(
    `detection fingerprint mismatches across all strategies and scenarios: ` +
      `${results.reduce((sum, r) => sum + r.fingerprintMismatches, 0)}`,
  );
  return lines.join('\n');
}

describe('P8 crossing-time precision against known truth', () => {
  const { runtime } = tmr();
  const results = measure(runtime);
  const table = renderTable(results);

  it('reports the measured error table', () => {
    console.log(`\n${table}\n`);
    expect(results).toHaveLength(SCENARIOS.length);
  });

  it('detects exactly the same crossings under every timing strategy', () => {
    for (const result of results) {
      // The fingerprint is gate id + direction + lapDistanceM + confidence for
      // every crossing in the run, in order -- everything the detector emits
      // EXCEPT tCross. Zero mismatches means no timing strategy changed which
      // crossings happened, only when they are reported to have happened.
      expect(
        result.fingerprintMismatches,
        `${result.scenario.name}: a timing strategy changed the detected crossing set`,
      ).toBe(0);
      const baseline = result.detections[0] ?? 0;
      for (const count of result.detections) {
        expect(count, `${result.scenario.name}: a strategy lost a crossing`).toBe(baseline);
      }
      // The handful of trials with no start/finish crossing at all are a
      // PRE-EXISTING detector behaviour, identical with P8 off: the synthetic
      // racing line plus 3 m of noise occasionally puts one fix inside the pit
      // corridor beside the main straight, and `CrossingDetector.update` skips
      // timing gates whenever either bracketing match is `onPitLane`. Run the
      // harness with P8_DUMP_MISSES=1 to see it -- every miss reports
      // pitLaneMatches >= 1.
      expect(baseline / result.trials).toBeGreaterThan(0.9);
    }
  });

  it('P8.1 removes the braking bias that linear interpolation carries', () => {
    const braking = results.find((r) => r.scenario.name.startsWith('braking'));
    if (braking === undefined) throw new Error('missing braking scenario');
    const linearBias = Math.abs(bias(braking.errorsMs[0] ?? []));
    const p81Bias = Math.abs(bias(braking.errorsMs[1] ?? []));
    expect(p81Bias).toBeLessThan(linearBias * 0.5);
  });

  it('P8.1 + P8.2 beats linear interpolation on mean and p95 in every scenario', () => {
    for (const result of results) {
      const linear = result.errorsMs[0] ?? [];
      const fused = result.errorsMs[2] ?? [];
      expect(meanAbs(fused), `${result.scenario.name} mean`).toBeLessThan(meanAbs(linear));
      expect(percentileAbs(fused, 95), `${result.scenario.name} p95`).toBeLessThan(
        percentileAbs(linear, 95),
      );
    }
  });
});
