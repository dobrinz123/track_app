import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CORNER_ANALYSIS_VERSION } from '../../src/contracts';
import { analyzeCorners } from '../../src/corners';
import { curvatureProfile, polylineCumulative, polylineLength } from '../../src/geometry';
import { loadProfileFromJson, makeTestProfile, validateProfile } from '../../src/profile';

const TMR_V2_ASSET_URL = new URL(
  '../../assets/circuits/transilvania-motor-ring.v2.json',
  import.meta.url,
);

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
    expect(CORNER_ANALYSIS_VERSION).toBe(1);
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

  it('finds a reference-compatible number of TMR v2 corners with valid ordered advice', () => {
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
      if (index > 0) {
        expect(corner.entryDistanceM).toBeGreaterThan(corners[index - 1]?.entryDistanceM ?? 0);
      }
    }

    for (const a of corners) {
      for (const b of corners) {
        if (a.minRadiusM > b.minRadiusM) {
          expect(a.advisorySpeedKph).toBeGreaterThanOrEqual(b.advisorySpeedKph);
        }
      }
    }
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
