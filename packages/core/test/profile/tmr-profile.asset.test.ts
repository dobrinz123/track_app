import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  centerlineCurvatureAtDistance,
  generateTmrProfile,
  serializeTmrProfile,
  TMR_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M,
} from '../../scripts/generate-tmr-profile';
import type { LocalPoint } from '../../src/contracts';
import { polylineCumulative, projectOntoPolyline } from '../../src/geometry';

import { loadProfileFromJson } from '../../src/profile/loader';

const V1_ASSET_URL = new URL(
  '../../assets/circuits/transilvania-motor-ring.v1.json',
  import.meta.url,
);
const V2_ASSET_URL = new URL(
  '../../assets/circuits/transilvania-motor-ring.v2.json',
  import.meta.url,
);
const v1AssetJson = readFileSync(V1_ASSET_URL, 'utf8');
const v2AssetJson = readFileSync(V2_ASSET_URL, 'utf8');

function midpointAlongOpenLine(points: LocalPoint[]): LocalPoint {
  const cumulative = polylineCumulative(points);
  const midpointM = (cumulative[cumulative.length - 1] ?? 0) / 2;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const startM = cumulative[index] ?? 0;
    const endM = cumulative[index + 1] ?? 0;
    if (start !== undefined && end !== undefined && midpointM <= endM) {
      const parameter = (midpointM - startM) / (endM - startM);
      return {
        e: start.e + parameter * (end.e - start.e),
        n: start.n + parameter * (end.n - start.n),
      };
    }
  }
  throw new Error('Pit lane has no midpoint');
}

function signedArea(points: LocalPoint[]): number {
  return (
    points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length];
      if (next === undefined) throw new Error('Centerline is sparse');
      return area + point.e * next.n - next.e * point.n;
    }, 0) / 2
  );
}

describe('Transilvania Motor Ring generated v2 profile asset', () => {
  it('loads through the production loader with zero validation errors', () => {
    const result = loadProfileFromJson(v2AssetJson);
    expect(result.ok).toBe(true);
    if (!result.ok) expect(result.errors).toEqual([]);
  });

  it('matches the researched length and has ordered app-defined sector gates', () => {
    const result = loadProfileFromJson(v2AssetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    expect(Math.abs(result.profile.totalLengthM - 3_708) / 3_708).toBeLessThanOrEqual(0.01);
    expect(result.runtime.sectorGates.map((gate) => gate.distanceM)).toEqual(
      [...result.runtime.sectorGates.map((gate) => gate.distanceM)].sort((a, b) => a - b),
    );
    const fractions = result.runtime.sectorGates.map(
      (gate) => gate.distanceM / result.profile.totalLengthM,
    );
    expect(fractions[0]).toBeGreaterThanOrEqual(0.28);
    expect(fractions[0]).toBeLessThanOrEqual(0.39);
    expect(fractions[1]).toBeGreaterThanOrEqual(0.61);
    expect(fractions[1]).toBeLessThanOrEqual(0.72);
  });

  it('places all timing gates on stretches below the v2 straight-curvature threshold', () => {
    const result = loadProfileFromJson(v2AssetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    const gateDistances = [
      result.runtime.startFinishGate.distanceM,
      ...result.runtime.sectorGates.map((gate) => gate.distanceM),
    ];
    for (const distanceM of gateDistances) {
      expect(centerlineCurvatureAtDistance(result.runtime.centerline, distanceM)).toBeLessThan(
        TMR_STRAIGHT_CURVATURE_THRESHOLD_RAD_PER_M,
      );
    }
  });

  it('records the direction implied by signed local-ENU area', () => {
    const result = loadProfileFromJson(v2AssetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    const expectedDirection =
      signedArea(result.runtime.centerline) > 0 ? 'counterclockwise' : 'clockwise';
    expect(result.profile.direction).toBe(expectedDirection);
  });

  it('places start/finish at the pit midpoint abeam point', () => {
    const result = loadProfileFromJson(v2AssetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    if (result.runtime.pitLane === undefined) throw new Error('Profile has no pit lane');
    const pitMidpoint = midpointAlongOpenLine(result.runtime.pitLane.polyline);
    const abeam = projectOntoPolyline(
      pitMidpoint,
      result.runtime.centerline,
      result.runtime.cumulativeDistancesM,
      true,
    ).point;
    const gateMidpoint = {
      e: (result.runtime.startFinishGate.a.e + result.runtime.startFinishGate.b.e) / 2,
      n: (result.runtime.startFinishGate.a.n + result.runtime.startFinishGate.b.n) / 2,
    };
    expect(Math.hypot(gateMidpoint.e - abeam.e, gateMidpoint.n - abeam.n)).toBeLessThanOrEqual(60);
  });

  it('is deterministic across independent v2 generation calls and matches checked-in bytes', () => {
    const first = generateTmrProfile();
    const second = generateTmrProfile();
    expect(first).toEqual(second);
    expect(serializeTmrProfile(first)).toBe(v2AssetJson);
  });

  it('keeps the v1 asset valid and byte-stable under the unchanged v1 rule', () => {
    const loaded = loadProfileFromJson(v1AssetJson);
    expect(loaded.ok).toBe(true);
    expect(serializeTmrProfile(generateTmrProfile(1))).toBe(v1AssetJson);
  });
});
