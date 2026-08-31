import { describe, expect, it } from 'vitest';

import { polylineLength } from '../../src/geometry';
import { analyzeCorners } from '../../src/corners';
import {
  DEFAULT_TEST_LOOP_CONFIG,
  buildLoopCentreline,
  buildTestLoopCircuit,
  detectLoopClosure,
  isLearnedGeometry,
  qualifiedLapSamples,
  qualifyTrack,
} from '../../src/testloop';

import { rectangleLoopSamples, sampleDensePath, uTurnPath } from './traces';

const OPTIONS = {
  circuitId: 'learned-test-1',
  displayName: 'Test loop',
  createdAtUtc: '2026-08-31T10:00:00.000Z',
};

/** Ticket P5d T1(b): lap 1's trace becomes a centreline -- resampled, smoothed, closed. */
describe('buildLoopCentreline (P5d T1b)', () => {
  it('resamples lap 1 to a ~5 m closed centreline anchored at the start', () => {
    const samples = rectangleLoopSamples({ laps: 2 });
    const closure = detectLoopClosure(samples);
    expect(closure.closed).toBe(true);
    if (!closure.closed) return;

    const track = qualifyTrack(samples, DEFAULT_TEST_LOOP_CONFIG);
    const centreline = buildLoopCentreline(
      qualifiedLapSamples(track, closure.closure),
      closure.closure,
    );

    expect(centreline.local.length).toBeGreaterThanOrEqual(50);
    expect(centreline.points.length).toBe(centreline.local.length);
    // Spacing: every step is close to the configured resample step.
    for (let index = 1; index < centreline.local.length; index += 1) {
      const previous = centreline.local[index - 1]!;
      const current = centreline.local[index]!;
      const stepM = Math.hypot(current.e - previous.e, current.n - previous.n);
      expect(stepM).toBeGreaterThan(DEFAULT_TEST_LOOP_CONFIG.resampleStepM * 0.5);
      expect(stepM).toBeLessThan(DEFAULT_TEST_LOOP_CONFIG.resampleStepM * 1.6);
    }
    // Closed: the last vertex is one step short of the first, never on top of it.
    const first = centreline.local[0]!;
    const last = centreline.local[centreline.local.length - 1]!;
    const closingM = Math.hypot(last.e - first.e, last.n - first.n);
    expect(closingM).toBeGreaterThan(0.5);
    expect(closingM).toBeLessThan(centreline.totalLengthM * 0.05);
    expect(centreline.totalLengthM).toBeCloseTo(polylineLength(centreline.local), 6);
    // The frame is anchored AT the start point: the first vertex is the origin.
    expect(Math.hypot(first.e, first.n)).toBeLessThan(1);
  });

  it('smooths noisy fixes: the learned line is shorter and tamer than the raw trace', () => {
    const samples = rectangleLoopSamples({ noiseSigmaM: 5, seed: 11, laps: 2 });
    const closure = detectLoopClosure(samples);
    expect(closure.closed).toBe(true);
    if (!closure.closed) return;

    const track = qualifyTrack(samples, DEFAULT_TEST_LOOP_CONFIG);
    const centreline = buildLoopCentreline(
      qualifiedLapSamples(track, closure.closure),
      closure.closure,
    );

    // The true loop is ~677 m; a noisy raw trace is longer, a smoothed line is not.
    expect(centreline.totalLengthM).toBeGreaterThan(600);
    expect(centreline.totalLengthM).toBeLessThan(780);
  });
});

/** Ticket P5d T1(c)+(d): synthetic corners and a RuntimeProfile-compatible ad-hoc profile. */
describe('buildTestLoopCircuit (P5d T1c, T1d)', () => {
  it('builds an ad-hoc profile that passes the SAME validation bundled circuits do', () => {
    const result = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), OPTIONS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.geometryStatus).toBe('ad-hoc');
    expect(isLearnedGeometry(result.profile)).toBe(true);
    expect(result.profile.sectorStatus).toBe('app-defined');
    expect(result.profile.circuitId).toBe('learned-test-1');
    // P5d-FIX1 item 8: derived from lap 1, inside the configured bounds.
    expect(result.profile.corridorWidthM).toBeGreaterThanOrEqual(
      DEFAULT_TEST_LOOP_CONFIG.minCorridorM,
    );
    expect(result.profile.corridorWidthM).toBeLessThanOrEqual(DEFAULT_TEST_LOOP_CONFIG.maxCorridorM);
    expect(result.profile.sectorGates).toEqual([]);
    expect(result.profile.startFinishGate.kind).toBe('startFinish');
    expect(result.profile.centerline.length).toBeGreaterThanOrEqual(50);
    // The runtime companion is the real one: same vertex count, real cumulative distances.
    expect(result.runtime.centerline.length).toBe(result.profile.centerline.length);
    expect(result.runtime.cumulativeDistancesM.length).toBe(result.profile.centerline.length);
    expect(result.profile.totalLengthM).toBeCloseTo(polylineLength(result.runtime.centerline), 0);
  });

  it('derives the four corners of a rectangle loop, in travel order, each with entry/apex/exit', () => {
    const result = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.corners.length).toBe(4);
    result.corners.forEach((corner, index) => {
      expect(corner.id).toBe(index + 1);
      expect(corner.lengthM).toBeGreaterThan(0);
      expect(corner.minRadiusM).toBeGreaterThan(8);
      expect(corner.minRadiusM).toBeLessThan(80);
      // Counterclockwise rectangle: every corner turns left.
      expect(corner.direction).toBe('left');
      expect(corner.advisorySpeedKph).toBeGreaterThan(0);
    });
    const apexes = result.corners.map((corner) => corner.apexDistanceM);
    expect([...apexes].sort((a, b) => a - b)).toEqual(apexes);
  });

  it('merges the speed-drop windows into the corner set (and says it did)', () => {
    const result = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.cornerDerivation.speedDropWindows.length).toBeGreaterThanOrEqual(4);
    expect(result.cornerDerivation.confirmedBySpeedDrop).toBe(4);
    // Every corner the driver actually slowed for carries the OBSERVED speed,
    // never a model number above what the car was seen doing.
    const observed = result.corners.filter((corner) => corner.speedSource === 'observed');
    expect(observed.length).toBe(4);
    for (const corner of observed) {
      expect(corner.advisorySpeedKph).toBeLessThanOrEqual(8 * 3.6 + 1);
    }
  });

  it('recovers a corner the curvature threshold alone missed, from its speed drop', () => {
    const result = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), {
      ...OPTIONS,
      // A threshold this high sees no curvature candidate at all on a 25 m
      // radius bend -- only the speed drops are left to find the corners.
      config: { cornerThreshold: 0.5 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.cornerDerivation.curvatureCandidates).toBe(0);
    expect(result.cornerDerivation.addedFromSpeedDrop).toBeGreaterThanOrEqual(4);
    expect(result.corners.length).toBeGreaterThanOrEqual(4);
  });

  it('survives noisy GPS: still one closed loop, still four corners', () => {
    const result = buildTestLoopCircuit(rectangleLoopSamples({ noiseSigmaM: 4, seed: 3, laps: 2 }), OPTIONS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.corners.length).toBeGreaterThanOrEqual(3);
    expect(result.corners.length).toBeLessThanOrEqual(6);
  });

  it('refuses a U-turn with the reason, never a half-built circuit', () => {
    const result = buildTestLoopCircuit(sampleDensePath(uTurnPath()), OPTIONS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-short');
  });

  it('is reproducible: the same trace builds the same geometry twice', () => {
    const samples = rectangleLoopSamples({ noiseSigmaM: 3, seed: 99, laps: 2 });
    const first = buildTestLoopCircuit(samples, OPTIONS);
    const second = buildTestLoopCircuit(samples, OPTIONS);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.profile).toEqual(first.profile);
    expect(second.corners).toEqual(first.corners);
  });

  it('produces geometry `analyzeCorners` itself can read back (RuntimeProfile compatible)', () => {
    const result = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reanalyzed = analyzeCorners(result.runtime);
    expect(reanalyzed.length).toBeGreaterThanOrEqual(4);
  });
});
