import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  generateMotorparkProfile,
  MOTORPARK_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M,
  serializeMotorparkProfile,
} from '../../scripts/generate-motorpark-profile';
import { analyzeCorners } from '../../src/corners';
import { curvatureAtDistance, polylineCumulative } from '../../src/geometry';
import { loadProfileFromJson } from '../../src/profile/loader';

const ASSET_URL = new URL('../../assets/circuits/motorpark-romania.v1.json', import.meta.url);
const assetJson = readFileSync(ASSET_URL, 'utf8');

describe('MotorPark România generated v1 profile asset', () => {
  it('is deterministic across independent generation calls and matches checked-in bytes', () => {
    const first = generateMotorparkProfile();
    const second = generateMotorparkProfile();
    expect(first).toEqual(second);
    expect(serializeMotorparkProfile(first)).toBe(assetJson);
  });

  it('loads through the production loader with zero validation errors', () => {
    const result = loadProfileFromJson(assetJson);
    expect(result.ok).toBe(true);
    if (!result.ok) expect(result.errors).toEqual([]);
  });

  it('matches the published length within 1%', () => {
    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    expect(Math.abs(result.profile.totalLengthM - 4_052) / 4_052).toBeLessThanOrEqual(0.01);
  });

  it('places all timing gates (S/F, sectors, pit entry/exit) on stretches below the straight-curvature threshold', () => {
    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    if (result.runtime.pitLane === undefined) throw new Error('Profile has no pit lane');
    const cumulative = polylineCumulative(result.runtime.centerline);
    const gateDistances = [
      result.runtime.startFinishGate.distanceM,
      ...result.runtime.sectorGates.map((gate) => gate.distanceM),
      result.runtime.pitLane.entryGate.distanceM,
      result.runtime.pitLane.exitGate.distanceM,
    ];
    for (const distanceM of gateDistances) {
      const curvatureRadPerM = Math.abs(
        curvatureAtDistance(result.runtime.centerline, cumulative, true, distanceM, 40),
      );
      expect(curvatureRadPerM).toBeLessThan(MOTORPARK_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M);
    }
  });

  it('produces a runtime whose centerline/cumulativeDistances lengths match', () => {
    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    expect(result.runtime.centerline.length).toBe(result.profile.centerline.length);
    expect(result.runtime.cumulativeDistancesM.length).toBe(result.runtime.centerline.length);
  });

  it('has a plausible corner count (exact sequence pinned only after LEAD verifies the published map)', () => {
    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    const corners = analyzeCorners(result.runtime);
    expect(corners.length).toBeGreaterThanOrEqual(10);
    expect(corners.length).toBeLessThanOrEqual(18);
  });
});
