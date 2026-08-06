import { describe, expect, it } from 'vitest';

import type { CircuitProfile, Gate, LocalPoint } from '../../src/contracts';
import { polylineLength } from '../../src/geometry';

import { makeTestProfile } from '../../src/profile/test-fixture';
import { validateProfile } from '../../src/profile/validation';

function clone(profile: CircuitProfile): CircuitProfile {
  return structuredClone(profile);
}

function recalculateLength(profile: CircuitProfile): void {
  const result = validateProfile(makeTestProfile());
  if (!result.ok) throw new Error('base fixture must be valid');
  const local = profile.centerline.map((point) => result.runtime.projection.toLocal(point));
  profile.totalLengthM = polylineLength(local);
}

function gateAt(profile: CircuitProfile, vertexIndex: number, id: string, sectorIndex: number): Gate {
  const validated = validateProfile(makeTestProfile());
  if (!validated.ok) throw new Error('base fixture must be valid');
  const point = validated.runtime.centerline[vertexIndex];
  if (point === undefined) throw new Error('missing test vertex');
  const magnitude = Math.hypot(point.e, point.n);
  const radial = { e: point.e / magnitude, n: point.n / magnitude };
  return {
    id,
    kind: 'sector',
    sectorIndex,
    a: validated.runtime.projection.toLatLon({
      e: point.e - radial.e * 15,
      n: point.n - radial.n * 15,
    }),
    b: validated.runtime.projection.toLatLon({
      e: point.e + radial.e * 15,
      n: point.n + radial.n * 15,
    }),
  };
}

function expectError(profile: CircuitProfile, code: string): void {
  const result = validateProfile(profile);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors).toContain(code);
}

describe('validateProfile', () => {
  it('accepts the synthetic rounded-rectangle fixture and builds runtime data', () => {
    const profile = makeTestProfile();
    const result = validateProfile(profile);

    expect(result.ok).toBe(true);
    expect(profile.totalLengthM).toBeGreaterThan(1_800);
    expect(profile.totalLengthM).toBeLessThan(2_200);
    if (result.ok) {
      expect(result.profile).toEqual(profile);
      expect(result.runtime.projection.origin).toEqual(profile.boundingRegion.center);
      expect(result.runtime.centerline).toHaveLength(profile.centerline.length);
      expect(result.runtime.cumulativeDistancesM).toHaveLength(profile.centerline.length);
      expect(result.runtime.sectorGates.map((gate) => gate.distanceM)).toEqual(
        [...result.runtime.sectorGates.map((gate) => gate.distanceM)].sort((a, b) => a - b),
      );
    }
  });

  it('rejects a structurally invalid profile', () => {
    const raw = { ...makeTestProfile(), direction: 'sideways' };
    const result = validateProfile(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('STRUCTURE:direction');
  });

  it('rejects fewer than 50 centerline vertices', () => {
    const profile = clone(makeTestProfile());
    profile.centerline = profile.centerline.slice(0, 49);
    recalculateLength(profile);
    expectError(profile, 'CENTERLINE_TOO_FEW_VERTICES');
  });

  it('rejects consecutive centerline vertices less than 0.5 m apart', () => {
    const profile = clone(makeTestProfile());
    profile.centerline[1] = profile.centerline[0] as CircuitProfile['centerline'][number];
    recalculateLength(profile);
    expectError(profile, 'CENTERLINE_CONSECUTIVE_DUPLICATE');
  });

  it('rejects a centerline whose implicit closing gap is implausibly large', () => {
    const profile = clone(makeTestProfile());
    profile.centerline[profile.centerline.length - 1] = profile.centerline[40] as CircuitProfile['centerline'][number];
    recalculateLength(profile);
    expectError(profile, 'CENTERLINE_NOT_PLAUSIBLY_CLOSED');
  });

  it('rejects totalLengthM outside the 0.5% tolerance', () => {
    const profile = clone(makeTestProfile());
    profile.totalLengthM *= 1.006;
    expectError(profile, 'TOTAL_LENGTH_MISMATCH');
  });

  it('rejects a gate endpoint farther than three corridor widths from centerline', () => {
    const profile = clone(makeTestProfile());
    profile.startFinishGate.a.lat += 0.01;
    expectError(profile, 'GATE_ENDPOINT_TOO_FAR_FROM_CENTERLINE');
  });

  it('rejects gates shorter than 2 m', () => {
    const profile = clone(makeTestProfile());
    profile.startFinishGate.b = { ...profile.startFinishGate.a };
    expectError(profile, 'GATE_TOO_SHORT');
  });

  it('rejects gates longer than 100 m', () => {
    const profile = clone(makeTestProfile());
    const validated = validateProfile(makeTestProfile());
    if (!validated.ok) throw new Error('base fixture must be valid');
    const center = validated.runtime.centerline[0] as LocalPoint;
    profile.startFinishGate.a = validated.runtime.projection.toLatLon({ e: center.e - 60, n: center.n });
    profile.startFinishGate.b = validated.runtime.projection.toLatLon({ e: center.e + 60, n: center.n });
    expectError(profile, 'GATE_TOO_LONG');
  });

  it('rejects sector gates that are not strictly ordered', () => {
    const profile = clone(makeTestProfile());
    profile.sectorGates.reverse();
    expectError(profile, 'SECTOR_GATES_NOT_STRICTLY_ORDERED');
  });

  it('rejects sector gates within 30 m of one another', () => {
    const profile = clone(makeTestProfile());
    profile.sectorGates[1] = gateAt(profile, 28, 'sector-2-nearby', 2);
    expectError(profile, 'SECTOR_GATES_TOO_CLOSE');
  });

  it('rejects a sector gate within 30 m of start/finish', () => {
    const profile = clone(makeTestProfile());
    const validated = validateProfile(makeTestProfile());
    if (!validated.ok) throw new Error('base fixture must be valid');
    const startA = validated.runtime.projection.toLocal(profile.startFinishGate.a);
    const startB = validated.runtime.projection.toLocal(profile.startFinishGate.b);
    profile.sectorGates[0] = {
      id: 'sector-near-start',
      kind: 'sector',
      sectorIndex: 1,
      a: validated.runtime.projection.toLatLon({ e: startA.e, n: startA.n + 10 }),
      b: validated.runtime.projection.toLatLon({ e: startB.e, n: startB.n + 10 }),
    };
    expectError(profile, 'SECTOR_GATE_TOO_CLOSE_TO_START_FINISH');
  });

  it.each([4.99, 60.01])('rejects corridorWidthM %s outside [5, 60]', (corridorWidthM) => {
    expectError(makeTestProfile({ corridorWidthM }), 'CORRIDOR_WIDTH_OUT_OF_RANGE');
  });

  it('rejects a bounding region that excludes centerline points', () => {
    const profile = clone(makeTestProfile());
    profile.boundingRegion.radiusM = 1;
    expectError(profile, 'BOUNDING_REGION_EXCLUDES_CENTERLINE');
  });

  it('accepts a valid pit lane and projects its runtime geometry', () => {
    const profile = clone(makeTestProfile());
    profile.pitLane = {
      polyline: profile.centerline.slice(0, 11),
      entryGate: { ...profile.startFinishGate, id: 'pit-entry', kind: 'pitEntry' },
      exitGate: { ...gateAt(profile, 10, 'pit-exit', 1), kind: 'pitExit', sectorIndex: undefined },
    };
    const result = validateProfile(profile);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.runtime.pitLane?.polyline).toHaveLength(11);
  });

  it('rejects a pit polyline with fewer than two vertices', () => {
    const profile = clone(makeTestProfile());
    profile.pitLane = {
      polyline: [profile.centerline[0] as CircuitProfile['centerline'][number]],
      entryGate: { ...profile.startFinishGate, kind: 'pitEntry' },
      exitGate: { ...profile.startFinishGate, kind: 'pitExit' },
    };
    expectError(profile, 'PIT_POLYLINE_TOO_FEW_VERTICES');
  });

  it('rejects a degenerate pit polyline', () => {
    const profile = clone(makeTestProfile());
    const point = profile.centerline[0] as CircuitProfile['centerline'][number];
    profile.pitLane = {
      polyline: [point, { ...point }],
      entryGate: { ...profile.startFinishGate, kind: 'pitEntry' },
      exitGate: { ...profile.startFinishGate, kind: 'pitExit' },
    };
    expectError(profile, 'PIT_POLYLINE_DEGENERATE');
  });

  it('rejects pit gate endpoints not near both pit polyline and centerline', () => {
    const profile = clone(makeTestProfile());
    const farGate = clone(makeTestProfile()).startFinishGate;
    farGate.a.lat += 0.01;
    farGate.b.lat += 0.01;
    profile.pitLane = {
      polyline: profile.centerline.slice(0, 11),
      entryGate: { ...farGate, kind: 'pitEntry' },
      exitGate: { ...gateAt(profile, 10, 'pit-exit', 1), kind: 'pitExit', sectorIndex: undefined },
    };
    expectError(profile, 'PIT_GATE_ENDPOINT_TOO_FAR_FROM_REQUIRED_LINE');
  });
});
