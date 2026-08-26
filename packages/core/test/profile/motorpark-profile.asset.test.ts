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

  it('matches the LEAD-verified corner sequence against the published LapMeta CW track map', () => {
    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    const corners = analyzeCorners(result.runtime);

    // LEAD verdict (ticket CN-W1 follow-up): 10 corners map onto the published
    // 16-turn LapMeta CW track map as C1=T1, C2=T4, C3=T5, C4=T6, C5=T7, C6=T9,
    // C7=T10, C8=T13+T14, C9=T15, C10=T16 -- T2/T3/T8/T11/T12 are gentle kinks
    // (radius > 125 m) that fall below the corner-detection curvature threshold
    // by design. See .foreman/scratch/motorpark-corners-report.md.
    expect(corners.length).toBe(10);
    expect(corners.map((corner) => corner.direction)).toEqual([
      'right',
      'right',
      'left',
      'left',
      'right',
      'right',
      'left',
      'right',
      'right',
      'left',
    ]);

    for (let index = 1; index < corners.length; index += 1) {
      const previous = corners[index - 1];
      const current = corners[index];
      if (previous === undefined || current === undefined) throw new Error('Corners are sparse');
      expect(current.entryDistanceM).toBeGreaterThan(previous.entryDistanceM);
    }

    // Corner 8 is a LEAD-verified same-direction compound (T13+T14 on the
    // published map, both right-handers with no real gap between them) --
    // its wide ~198 degree arc is legitimate, NOT the opposite-sign
    // direction-split merge bug the M-direction-split fix (CORNER_ANALYSIS_VERSION
    // 3) guards against. If a future algorithm change splits this compound into
    // two corners, that must be a deliberate, reviewed change to this pin --
    // not a silent regression.
    const compoundCorner = corners[7];
    if (compoundCorner === undefined) throw new Error('Corner 8 is missing');
    expect(compoundCorner.totalAngleDeg).toBeGreaterThan(150);
  });
});
