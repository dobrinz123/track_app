import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { generateTmrProfile, serializeTmrProfile } from '../../scripts/generate-tmr-profile';
import type { LocalPoint } from '../../src/contracts';
import { polylineCumulative, projectOntoPolyline } from '../../src/geometry';

import { loadProfileFromJson } from '../../src/profile/loader';

const ASSET_URL = new URL('../../assets/circuits/transilvania-motor-ring.v1.json', import.meta.url);
const assetJson = readFileSync(ASSET_URL, 'utf8');

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

describe('Transilvania Motor Ring generated profile asset', () => {
  it('loads through the production loader with zero validation errors', () => {
    const result = loadProfileFromJson(assetJson);
    expect(result.ok).toBe(true);
    if (!result.ok) expect(result.errors).toEqual([]);
  });

  it('matches the researched length and has ordered app-defined sector gates', () => {
    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    expect(Math.abs(result.profile.totalLengthM - 3_708) / 3_708).toBeLessThanOrEqual(0.01);
    expect(result.runtime.sectorGates.map((gate) => gate.distanceM)).toEqual(
      [...result.runtime.sectorGates.map((gate) => gate.distanceM)].sort((a, b) => a - b),
    );
  });

  it('records the direction implied by signed local-ENU area', () => {
    const result = loadProfileFromJson(assetJson);
    if (!result.ok) throw new Error(result.errors.join(', '));
    const expectedDirection =
      signedArea(result.runtime.centerline) > 0 ? 'counterclockwise' : 'clockwise';
    expect(result.profile.direction).toBe(expectedDirection);
  });

  it('places start/finish at the pit midpoint abeam point', () => {
    const result = loadProfileFromJson(assetJson);
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

  it('is deterministic across independent generation calls and matches the checked-in bytes', () => {
    const first = generateTmrProfile();
    const second = generateTmrProfile();
    expect(first).toEqual(second);
    expect(serializeTmrProfile(first)).toBe(assetJson);
  });
});
