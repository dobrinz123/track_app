import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CORNER_ANALYSIS_VERSION } from '../../src/contracts';
import {
  analyzeCorners,
  applyObservedSpeeds,
  loadObservedSpeedsFromJson,
} from '../../src/corners';
import { curvatureProfile, polylineCumulative, polylineLength } from '../../src/geometry';
import { loadProfileFromJson, makeTestProfile, validateProfile } from '../../src/profile';

const TMR_V2_ASSET_URL = new URL(
  '../../assets/circuits/transilvania-motor-ring.v2.json',
  import.meta.url,
);
const TMR_OBSERVED_SPEEDS_ASSET_URL = new URL(
  '../../assets/circuits/transilvania-motor-ring.observed-speeds.v1.json',
  import.meta.url,
);

const TMR_OBSERVED_APEX_SPEEDS = new Map([
  [2, 159],
  [3, 65],
  [5, 74],
  [6, 170],
  [7, 107],
  [8, 65],
  [9, 112],
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

describe('deterministic corner analysis', () => {
  it('materializes the versioned coaching contract', () => {
    expect(CORNER_ANALYSIS_VERSION).toBe(2);
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
  it('loads the checked-in TMR observations and deliberately omits C4/T5', () => {
    const corners = analyzeCorners(tmrRuntime());
    const asset = loadObservedSpeedsFromJson(
      readFileSync(TMR_OBSERVED_SPEEDS_ASSET_URL, 'utf8'),
      corners,
    );

    expect(asset.provenance.source).toBe(
      'user-supplied onboard observation, M2 Competition, 2026-08-10; advisory, unofficial',
    );
    expect(asset.observations.map((observation) => observation.cornerId)).toEqual([
      2, 3, 5, 6, 7, 8, 9,
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

    expect(overlaidCorners[1]?.advisorySpeedKph).toBe(159);
    expect(overlaidCorners[3]?.advisorySpeedKph).toBe(modelCorners[3]?.advisorySpeedKph);
    expect(overlaidCorners[4]?.advisorySpeedKph).toBe(71.5);
    expect(overlaidCorners[6]?.advisorySpeedKph).toBeCloseTo(99, 12);
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
});
