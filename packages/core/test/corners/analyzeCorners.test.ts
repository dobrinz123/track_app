import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { LocalPoint } from '../../src/contracts';
import { CORNER_ANALYSIS_VERSION } from '../../src/contracts';
import {
  analyzeCorners,
  applyObservedSpeeds,
  loadObservedSpeedsFromJson,
} from '../../src/corners';
import { createProjection, curvatureProfile, polylineCumulative, polylineLength } from '../../src/geometry';
import { loadProfileFromJson, makeTestProfile, validateProfile } from '../../src/profile';
import type { RuntimeProfile } from '../../src/profile';

const TMR_V2_ASSET_URL = new URL(
  '../../assets/circuits/transilvania-motor-ring.v2.json',
  import.meta.url,
);
const TMR_OBSERVED_SPEEDS_ASSET_URL = new URL(
  '../../assets/circuits/transilvania-motor-ring.observed-speeds.v1.json',
  import.meta.url,
);

/**
 * CORNER_ANALYSIS_VERSION 3 corner IDs (M-direction-split fix remapped these
 * -- see `contracts.ts`'s doc comment on the constant for the full history).
 */
const TMR_OBSERVED_APEX_SPEEDS = new Map([
  [3, 159],
  [4, 65],
  [6, 74],
  [8, 170],
  [9, 107],
  [11, 65],
  [12, 112],
]);

function testRuntime() {
  const result = validateProfile(makeTestProfile());
  if (!result.ok) throw new Error(result.errors.join(', '));
  return result.runtime;
}

function tmrRuntime() {
  const result = loadProfileFromJson(readFileSync(TMR_V2_ASSET_URL, 'utf8'));
  if (!result.ok) throw new Error(result.errors.join(', '));
  return result.runtime;
}

// --- M-direction-split synthetic chicane fixture -----------------------
// A minimal, hand-built RuntimeProfile (NOT going through full CircuitProfile
// validation -- analyzeCorners only reads centerline/cumulativeDistancesM/
// startFinishGate.distanceM) with a real S-chicane: a sustained ~110-degree
// LEFT arc immediately followed by a sustained ~110-degree RIGHT arc, radius
// tight enough (60m, curvature ~0.0167 rad/m) to stay comfortably above the
// default cornerThreshold (0.008) on both sides of the crossover, each arm
// (~115m) well past the default gapToleranceM (25m) -- exactly the "no real
// gap between opposite bends" shape the fix targets. Long straights (radius
// ~0, curvature far below threshold) bound it so nothing else registers as a
// corner.
function arcPoints(
  start: LocalPoint,
  headingRad: number,
  radiusM: number,
  turnRad: number,
  stepM: number,
): { points: LocalPoint[]; end: LocalPoint; endHeading: number } {
  const arcLengthM = Math.abs(radiusM * turnRad);
  const steps = Math.max(2, Math.round(arcLengthM / stepM));
  const angularStep = turnRad / steps;
  const segStepM = arcLengthM / steps;
  const points: LocalPoint[] = [];
  let heading = headingRad;
  let point = start;
  for (let step = 0; step < steps; step += 1) {
    heading += angularStep;
    point = { e: point.e + Math.cos(heading) * segStepM, n: point.n + Math.sin(heading) * segStepM };
    points.push(point);
  }
  return { points, end: point, endHeading: heading };
}

function straightPoints(
  start: LocalPoint,
  headingRad: number,
  lengthM: number,
  stepM: number,
): { points: LocalPoint[]; end: LocalPoint } {
  const steps = Math.max(2, Math.round(lengthM / stepM));
  const segStepM = lengthM / steps;
  const points: LocalPoint[] = [];
  let point = start;
  for (let step = 0; step < steps; step += 1) {
    point = { e: point.e + Math.cos(headingRad) * segStepM, n: point.n + Math.sin(headingRad) * segStepM };
    points.push(point);
  }
  return { points, end: point };
}

function chicaneRuntime(): RuntimeProfile {
  const stepM = 4;
  const turnRad = (110 * Math.PI) / 180;
  let heading = 0;
  let point: LocalPoint = { e: 0, n: 0 };
  const centerline: LocalPoint[] = [point];

  const leadIn = straightPoints(point, heading, 150, stepM);
  centerline.push(...leadIn.points);
  point = leadIn.end;

  const leftArc = arcPoints(point, heading, 60, turnRad, stepM);
  centerline.push(...leftArc.points);
  point = leftArc.end;
  heading = leftArc.endHeading;

  const rightArc = arcPoints(point, heading, 60, -turnRad, stepM);
  centerline.push(...rightArc.points);
  point = rightArc.end;
  heading = rightArc.endHeading;

  const leadOut = straightPoints(point, heading, 150, stepM);
  centerline.push(...leadOut.points);

  const cumulativeDistancesM = polylineCumulative(centerline);
  const zeroGate = { gate: { id: 'sf', kind: 'startFinish' as const, a: { lat: 0, lon: 0 }, b: { lat: 0, lon: 0 } }, a: { e: 0, n: 0 }, b: { e: 0, n: 0 }, distanceM: 0 };
  return {
    projection: createProjection({ lat: 0, lon: 0 }),
    centerline,
    cumulativeDistancesM,
    startFinishGate: zeroGate,
    sectorGates: [],
  };
}

describe('deterministic corner analysis', () => {
  it('materializes the versioned coaching contract', () => {
    expect(CORNER_ANALYSIS_VERSION).toBe(3);
  });

  it('M-direction-split: splits a touching left/right chicane (no real gap between the bends) into two corners with the correct, un-suppressed directions', () => {
    const runtime = chicaneRuntime();
    const corners = analyzeCorners(runtime);

    // The chicane must produce (at least) one LEFT corner immediately
    // followed by one RIGHT corner, each with a plausible ~110-degree turn
    // -- NOT one merged corner whose direction is whichever apex won and
    // whose angle would read close to 220 degrees (both magnitudes summed).
    const chicanePair = corners.find(
      (corner, index) =>
        corner.direction === 'left' &&
        corners[index + 1]?.direction === 'right' &&
        corner.totalAngleDeg < 150 &&
        (corners[index + 1]?.totalAngleDeg ?? 0) < 150,
    );
    expect(chicanePair).toBeDefined();
    const leftIndex = corners.indexOf(chicanePair!);
    const rightCorner = corners[leftIndex + 1]!;

    expect(chicanePair!.totalAngleDeg).toBeGreaterThan(60);
    expect(chicanePair!.totalAngleDeg).toBeLessThan(150);
    expect(rightCorner.totalAngleDeg).toBeGreaterThan(60);
    expect(rightCorner.totalAngleDeg).toBeLessThan(150);
    // The two bends are adjacent (the right corner's entry is at or just
    // after the left corner's exit) -- proves this really is the SAME
    // chicane split in two, not two unrelated corners.
    expect(rightCorner.entryDistanceM).toBeGreaterThanOrEqual(chicanePair!.exitDistanceM - 1e-6);
    expect(rightCorner.entryDistanceM).toBeLessThan(chicanePair!.exitDistanceM + 30);

    // No corner anywhere in this fixture has a merged, implausible angle
    // (the pre-fix bug's signature: ~220 degrees, both bends' magnitudes
    // summed into one run).
    expect(corners.every((corner) => corner.totalAngleDeg < 150)).toBe(true);
  });

  it('reports positive left and negative right signed curvature', () => {
    const counterclockwise = [
      { e: 0, n: 0 },
      { e: 10, n: 0 },
      { e: 10, n: 10 },
      { e: 0, n: 10 },
    ];
    const clockwise = [...counterclockwise].reverse();
    const left = curvatureProfile(
      counterclockwise,
      polylineCumulative(counterclockwise),
      true,
      2,
    );
    const right = curvatureProfile(clockwise, polylineCumulative(clockwise), true, 2);

    expect(left.every((curvature) => curvature > 0)).toBe(true);
    expect(right.every((curvature) => curvature < 0)).toBe(true);
    const leftMagnitudes = left.map(Math.abs).sort((a, b) => a - b);
    const rightMagnitudes = right.map(Math.abs).sort((a, b) => a - b);
    for (let index = 0; index < leftMagnitudes.length; index += 1) {
      expect(leftMagnitudes[index]).toBeCloseTo(rightMagnitudes[index] ?? 0, 12);
    }
  });

  it('finds the four uniform, consistently directed arcs of the synthetic ring', () => {
    const corners = analyzeCorners(testRuntime());

    expect(corners).toHaveLength(4);
    expect(new Set(corners.map((corner) => corner.severity)).size).toBe(1);
    expect(corners.every((corner) => corner.direction === 'left')).toBe(true);
    expect(corners.map((corner) => corner.id)).toEqual([1, 2, 3, 4]);
  });

  it('finds a reference-compatible number of TMR v2 corners with valid v2 advice', () => {
    const corners = analyzeCorners(tmrRuntime());

    expect(corners.length).toBeGreaterThanOrEqual(8);
    expect(corners.length).toBeLessThanOrEqual(12);
    expect(corners[0]?.entryDistanceM).toBeGreaterThan(0);
    for (let index = 0; index < corners.length; index += 1) {
      const corner = corners[index];
      if (corner === undefined) throw new Error('Corner output is sparse');
      expect(corner.id).toBe(index + 1);
      expect(corner.severity).toBeGreaterThanOrEqual(1);
      expect(corner.severity).toBeLessThanOrEqual(6);
      expect(corner.advisorySpeedKph % 5).toBe(0);
      expect(corner.speedSource).toBe('model');
      if (index > 0) {
        expect(corner.entryDistanceM).toBeGreaterThan(corners[index - 1]?.entryDistanceM ?? 0);
      }
    }

  });

  /**
   * Byte-stable regression pin (M-direction-split fix's binding requirement)
   * -- CORNER_ANALYSIS_VERSION 3's TMR corner set, locked down exactly.
   * Three of the old (v2) 9 corners each secretly contained an implausible
   * ~180-degree merged left+right pair (see `contracts.ts`'s doc comment);
   * this fixes that, producing 12 corners. ANY further change to this exact
   * set (count, direction, or ordering) must be a deliberate, reviewed
   * algorithm change -- bump CORNER_ANALYSIS_VERSION again and update this
   * pin together, never one without the other.
   */
  it('pins the exact CORNER_ANALYSIS_VERSION 3 TMR corner count/direction/id sequence', () => {
    const corners = analyzeCorners(tmrRuntime());

    expect(corners.map((corner) => [corner.id, corner.direction])).toEqual([
      [1, 'right'],
      [2, 'left'],
      [3, 'left'],
      [4, 'right'],
      [5, 'right'],
      [6, 'left'],
      [7, 'right'],
      [8, 'right'],
      [9, 'right'],
      [10, 'left'],
      [11, 'right'],
      [12, 'right'],
    ]);
    // No corner keeps the pre-fix bug's signature (an implausible, two-bend
    // merged angle).
    expect(corners.every((corner) => corner.totalAngleDeg < 150)).toBe(true);
  });

  it('allows the angle-aware lateral-g buckets to be overridden', () => {
    const defaultCorners = analyzeCorners(testRuntime());
    const lowGripCorners = analyzeCorners(testRuntime(), {
      latGBuckets: [{ minimumAngleDeg: 0, latG: 0.5 }],
    });

    expect(lowGripCorners).toHaveLength(defaultCorners.length);
    expect(
      lowGripCorners.every(
        (corner, index) => corner.advisorySpeedKph < (defaultCorners[index]?.advisorySpeedKph ?? 0),
      ),
    ).toBe(true);
  });

  it('matches every anchored TMR apex speed within 18% and stays conservative on five', () => {
    const corners = analyzeCorners(tmrRuntime());
    let conservativeCount = 0;

    for (const [cornerId, observedKph] of TMR_OBSERVED_APEX_SPEEDS) {
      const corner = corners.find((candidate) => candidate.id === cornerId);
      if (corner === undefined) throw new Error(`TMR corner C${cornerId} was not analyzed`);
      expect(
        Math.abs(corner.advisorySpeedKph - observedKph) / observedKph,
        `C${cornerId}: model ${corner.advisorySpeedKph}, observed ${observedKph}`,
      ).toBeLessThanOrEqual(0.18);
      if (corner.advisorySpeedKph <= observedKph) conservativeCount += 1;
    }

    expect(conservativeCount).toBeGreaterThanOrEqual(5);
  });

  it('returns deeply equal TMR results on independent runs', () => {
    const runtime = tmrRuntime();
    expect(analyzeCorners(runtime)).toEqual(analyzeCorners(runtime));
  });

  it('keeps a corner spanning S/F whole when the lap-distance datum is rotated', () => {
    const runtime = testRuntime();
    const originalCorners = analyzeCorners(runtime);
    const targetCorner = originalCorners[1];
    if (targetCorner === undefined) throw new Error('Synthetic profile has no second corner');
    const totalLengthM = polylineLength(runtime.centerline);
    const shiftedStartFinishM =
      (runtime.startFinishGate.distanceM + targetCorner.apexDistanceM) % totalLengthM;
    const shiftedRuntime = {
      ...runtime,
      startFinishGate: { ...runtime.startFinishGate, distanceM: shiftedStartFinishM },
    };
    const rotatedCorners = analyzeCorners(shiftedRuntime);

    expect(originalCorners).toHaveLength(4);
    expect(rotatedCorners).toHaveLength(originalCorners.length);
    expect(rotatedCorners.filter((corner) => corner.entryDistanceM > corner.exitDistanceM)).toHaveLength(
      1,
    );
  });
});

describe('observed corner-speed overlay', () => {
  it('loads the checked-in TMR observations (CORNER_ANALYSIS_VERSION 3 IDs) and deliberately omits the rest', () => {
    const corners = analyzeCorners(tmrRuntime());
    const asset = loadObservedSpeedsFromJson(
      readFileSync(TMR_OBSERVED_SPEEDS_ASSET_URL, 'utf8'),
      corners,
    );

    expect(asset.provenance.source).toContain('user-supplied onboard observation, M2 Competition, 2026-08-10');
    expect(asset.observations.map((observation) => observation.cornerId)).toEqual([
      3, 4, 6, 8, 9, 11, 12,
    ]);
    expect(asset.observations).toHaveLength(7);
  });

  it('uses observed speeds when present and falls back to model v2 when missing', () => {
    const modelCorners = analyzeCorners(tmrRuntime());
    const asset = loadObservedSpeedsFromJson(
      readFileSync(TMR_OBSERVED_SPEEDS_ASSET_URL, 'utf8'),
      modelCorners,
    );
    const overlaidCorners = applyObservedSpeeds(modelCorners, asset.observations);

    for (const modelCorner of modelCorners) {
      const overlaid = overlaidCorners.find((corner) => corner.id === modelCorner.id);
      if (overlaid === undefined) throw new Error(`Overlaid corner C${modelCorner.id} is missing`);
      const observation = asset.observations.find(
        (candidate) => candidate.cornerId === modelCorner.id,
      );
      if (observation === undefined) {
        expect(overlaid.advisorySpeedKph).toBe(modelCorner.advisorySpeedKph);
        expect(overlaid.speedSource).toBe('model');
      } else {
        expect(overlaid.advisorySpeedKph).toBe(
          Math.min(observation.apexSpeedKph, modelCorner.advisorySpeedKph * 1.1),
        );
        expect(overlaid.speedSource).toBe('observed');
      }
    }

    // Corner-id-keyed (not positional) so this stays correct if the corner
    // count ever changes again -- one still-unaffected corner (C3, model
    // unchanged by the split) and one genuinely overlaid corner (C6, whose
    // model speed the 10% ceiling does NOT clamp).
    const c3 = overlaidCorners.find((corner) => corner.id === 3);
    const c6 = overlaidCorners.find((corner) => corner.id === 6);
    expect(c3?.advisorySpeedKph).toBe(159);
    expect(c6?.advisorySpeedKph).toBe(74);
    expect(c6?.speedSource).toBe('observed');
  });

  it('rejects unknown corner IDs and speeds outside 20..320 kph', () => {
    const corners = analyzeCorners(testRuntime());
    const source = 'test observation';

    expect(() =>
      applyObservedSpeeds(corners, [{ cornerId: 999, apexSpeedKph: 80, source }]),
    ).toThrow(/does not exist/);
    expect(() =>
      applyObservedSpeeds(corners, [{ cornerId: 1, apexSpeedKph: 19, source }]),
    ).toThrow(/between 20 and 320/);
    expect(() =>
      applyObservedSpeeds(corners, [{ cornerId: 1, apexSpeedKph: 321, source }]),
    ).toThrow(/between 20 and 320/);
  });

  it('M-observed-version: an analysisVersion mismatch returns empty observations with a warning, never throws at load time', () => {
    const corners = analyzeCorners(testRuntime());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const asset = loadObservedSpeedsFromJson(
        JSON.stringify({
          analysisVersion: CORNER_ANALYSIS_VERSION + 1,
          provenance: { source: 'future analysis' },
          observations: [{ cornerId: 1, apexSpeedKph: 80, source: 'test' }],
        }),
        corners,
      );

      expect(asset.observations).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('M-observed-version: an unknown cornerId is skipped with a warning, never crashes the whole load -- other valid observations still apply', () => {
    const corners = analyzeCorners(testRuntime());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const asset = loadObservedSpeedsFromJson(
        JSON.stringify({
          analysisVersion: CORNER_ANALYSIS_VERSION,
          provenance: { source: 'partial mismatch' },
          observations: [
            { cornerId: 999, apexSpeedKph: 80, source: 'stale' },
            { cornerId: 1, apexSpeedKph: 90, source: 'still valid' },
          ],
        }),
        corners,
      );

      expect(asset.observations).toEqual([{ cornerId: 1, apexSpeedKph: 90, source: 'still valid' }]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('M-observed-version: still throws on a genuinely malformed asset (missing analysisVersion, bad range, duplicate ID)', () => {
    const corners = analyzeCorners(testRuntime());

    expect(() =>
      loadObservedSpeedsFromJson(
        JSON.stringify({ provenance: { source: 'x' }, observations: [] }),
        corners,
      ),
    ).toThrow(/analysisVersion/);

    expect(() =>
      loadObservedSpeedsFromJson(
        JSON.stringify({
          analysisVersion: CORNER_ANALYSIS_VERSION,
          provenance: { source: 'x' },
          observations: [{ cornerId: 1, apexSpeedKph: 999, source: 'x' }],
        }),
        corners,
      ),
    ).toThrow(/between 20 and 320/);

    expect(() =>
      loadObservedSpeedsFromJson(
        JSON.stringify({
          analysisVersion: CORNER_ANALYSIS_VERSION,
          provenance: { source: 'x' },
          observations: [
            { cornerId: 1, apexSpeedKph: 80, source: 'x' },
            { cornerId: 1, apexSpeedKph: 85, source: 'y' },
          ],
        }),
        corners,
      ),
    ).toThrow(/Duplicate/);
  });
});
