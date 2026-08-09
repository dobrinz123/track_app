import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Corner, ReferenceLap } from '../../src/contracts';
import { deriveBrakingZones } from '../../src/coach';
import { analyzeCorners } from '../../src/corners';
import { driveLap } from '../../src/fixtures';
import { loadProfileFromJson, makeTestProfile, validateProfile } from '../../src/profile';
import { buildReferenceLap } from '../../src/reference';
import { runSessionPipeline, type ReplayMatchedTelemetry } from '../../src/replay';

const TMR_V2_ASSET_URL = new URL(
  '../../assets/circuits/transilvania-motor-ring.v2.json',
  import.meta.url,
);

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function forwardDistance(fromM: number, toM: number, totalLengthM: number): number {
  const distanceM = modulo(toM - fromM, totalLengthM);
  return distanceM < 1e-6 || totalLengthM - distanceM < 1e-6 ? 0 : distanceM;
}

function testProfile() {
  const profile = makeTestProfile();
  const loaded = validateProfile(profile);
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return { profile, runtime: loaded.runtime };
}

function tmrProfile() {
  const loaded = loadProfileFromJson(readFileSync(TMR_V2_ASSET_URL, 'utf8'));
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return { profile: loaded.profile, runtime: loaded.runtime };
}

function syntheticReference(): { reference: ReferenceLap; corners: Corner[]; lengthM: number } {
  const { profile, runtime } = testProfile();
  const corners = analyzeCorners(runtime);
  const lengthM = profile.totalLengthM;
  const cruiseMps = 30;
  const approachM = 130;
  const samples = driveLap(profile, {
    seed: 808,
    sampleRateHz: 5,
    noiseSigmaM: 0,
    accuracyM: 3,
    speedMps: ({ distanceM }) => {
      const lapDistanceM = modulo(distanceM, lengthM);
      let speedMps = cruiseMps;
      for (const corner of corners) {
        const cornerMps = Math.max(12, Math.min(18, corner.advisorySpeedKph / 3.6));
        const withinCornerM = forwardDistance(corner.entryDistanceM, lapDistanceM, lengthM);
        if (withinCornerM <= corner.lengthM) {
          speedMps = Math.min(speedMps, cornerMps);
          continue;
        }
        const distanceToEntryM = forwardDistance(lapDistanceM, corner.entryDistanceM, lengthM);
        if (distanceToEntryM <= approachM) {
          speedMps = Math.min(
            speedMps,
            cornerMps + (cruiseMps - cornerMps) * (distanceToEntryM / approachM),
          );
        }
      }
      return speedMps;
    },
  });
  const replay = runSessionPipeline(runtime, samples);
  const lap = replay.laps[0];
  if (lap === undefined) throw new Error(`Synthetic drive did not complete: ${JSON.stringify(replay)}`);
  const matches = replay.diagnostics.matches as ReplayMatchedTelemetry[];
  const built = buildReferenceLap({
    profile,
    lap,
    telemetry: matches,
    userId: 'coach-test-driver',
    recordedAtUtc: '2026-08-10T00:00:00.000Z',
    sessionId: 'coach-test-session',
    appVersion: 'test',
    algorithmVersion: 1,
    gridStepM: 10,
  });
  if (!built.ok) throw new Error(built.error);
  return { reference: built.reference, corners, lengthM };
}

describe('deriveBrakingZones', () => {
  it('finds sustained PB braking before every synthetic arc without crossing the prior exit', () => {
    const { reference, corners, lengthM } = syntheticReference();
    const zones = deriveBrakingZones(reference, corners);

    expect(zones).toHaveLength(corners.length);
    for (let index = 0; index < corners.length; index += 1) {
      const corner = corners[index];
      const previous = corners[modulo(index - 1, corners.length)];
      const zone = zones[index];
      if (corner === undefined || previous === undefined || zone === undefined) {
        throw new Error('Synthetic output is sparse');
      }
      expect(zone.source, JSON.stringify(zones)).toBe('reference');
      expect(zone.brakeCueAvailable).toBe(true);
      expect(forwardDistance(zone.brakeStartDistanceM, corner.entryDistanceM, lengthM)).toBeGreaterThan(
        0,
      );
      expect(
        forwardDistance(previous.exitDistanceM, zone.brakeStartDistanceM, lengthM),
      ).toBeLessThanOrEqual(
        forwardDistance(previous.exitDistanceM, corner.entryDistanceM, lengthM) + 1e-6,
      );
      expect(zone.entrySpeedKph).toBeGreaterThan(30);
      expect(zone.entrySpeedKph).toBeLessThan(190);
      expect(zone.apexSpeedKph).toBeGreaterThan(30);
      expect(zone.apexSpeedKph).toBeLessThanOrEqual(zone.entrySpeedKph * 1.25);
    }
  });

  it('produces bounded, non-overlapping physics fallbacks for every TMR v2 corner', () => {
    const { profile, runtime } = tmrProfile();
    const corners = analyzeCorners(runtime);
    const zones = deriveBrakingZones(null, corners, { totalLengthM: profile.totalLengthM });

    expect(zones).toHaveLength(corners.length);
    for (let index = 0; index < corners.length; index += 1) {
      const corner = corners[index];
      const previous = corners[modulo(index - 1, corners.length)];
      const zone = zones[index];
      if (corner === undefined || previous === undefined || zone === undefined) {
        throw new Error('TMR output is sparse');
      }
      expect(zone.source).toBe('physics');
      expect(zone.brakeStartDistanceM).toBeGreaterThanOrEqual(0);
      expect(zone.brakeStartDistanceM).toBeLessThan(profile.totalLengthM);
      const brakingM = forwardDistance(
        zone.brakeStartDistanceM,
        corner.entryDistanceM,
        profile.totalLengthM,
      );
      const availableM = forwardDistance(
        previous.exitDistanceM,
        corner.entryDistanceM,
        profile.totalLengthM,
      );
      expect(brakingM).toBeLessThanOrEqual(availableM + 1e-6);
      expect(zone.entrySpeedKph).toBeGreaterThanOrEqual(zone.apexSpeedKph);
    }
  });

  it('falls back per corner when the PB grid poorly covers that corner segment', () => {
    const { reference, corners, lengthM } = syntheticReference();
    const targetIndex = 1;
    const target = corners[targetIndex];
    const previous = corners[targetIndex - 1];
    if (target === undefined || previous === undefined) throw new Error('Synthetic corners are sparse');
    const damagedElapsed = [...reference.elapsedMsAtGrid];
    const firstDamagedIndex = reference.distanceGridM.findIndex(
      (distanceM) => distanceM >= previous.exitDistanceM,
    );
    const lastDamagedIndex = reference.distanceGridM.findIndex(
      (distanceM) => distanceM > target.exitDistanceM,
    );
    const heldElapsed = damagedElapsed[Math.max(0, firstDamagedIndex)] ?? 0;
    for (
      let index = Math.max(0, firstDamagedIndex);
      index < (lastDamagedIndex < 0 ? damagedElapsed.length : lastDamagedIndex);
      index += 1
    ) {
      damagedElapsed[index] = heldElapsed;
    }
    const zones = deriveBrakingZones(
      { ...reference, elapsedMsAtGrid: damagedElapsed },
      corners,
      { totalLengthM: lengthM },
    );

    expect(zones[targetIndex]?.source).toBe('physics');
  });

  it('keeps usable braking distances positive and inside the preceding straight', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 300, max: 8_000, noNaN: true }),
        fc.double({ min: 0.05, max: 0.45, noNaN: true }),
        fc.double({ min: 0.46, max: 0.8, noNaN: true }),
        fc.double({ min: 30, max: 220, noNaN: true }),
        (totalLengthM, exitFraction, entryFraction, advisorySpeedKph) => {
          const previous: Corner = {
            id: 1,
            entryDistanceM: totalLengthM * 0.1,
            apexDistanceM: totalLengthM * 0.15,
            exitDistanceM: totalLengthM * exitFraction,
            lengthM: totalLengthM * 0.1,
            minRadiusM: 100,
            totalAngleDeg: 45,
            direction: 'left',
            severity: 3,
            advisorySpeedKph: 80,
          };
          const corner: Corner = {
            ...previous,
            id: 2,
            entryDistanceM: totalLengthM * entryFraction,
            apexDistanceM: totalLengthM * Math.min(0.9, entryFraction + 0.03),
            exitDistanceM: totalLengthM * Math.min(0.95, entryFraction + 0.06),
            advisorySpeedKph,
          };
          const zone = deriveBrakingZones(null, [previous, corner], {
            totalLengthM,
            vMaxKph: 180,
            longStraightM: 0,
          })[1];
          if (zone === undefined) return false;
          const brakingM = forwardDistance(
            zone.brakeStartDistanceM,
            corner.entryDistanceM,
            totalLengthM,
          );
          const availableM = forwardDistance(
            previous.exitDistanceM,
            corner.entryDistanceM,
            totalLengthM,
          );
          return zone.brakeCueAvailable === false
            ? brakingM <= 1e-6
            : brakingM > 0 && brakingM <= availableM + 1e-6;
        },
      ),
      { seed: 31_415, numRuns: 250 },
    );
  });
});
