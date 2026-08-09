import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { CoachCue, TrackMatch } from '../../src/contracts';
import { CoachEngine, deriveBrakingZones } from '../../src/coach';
import { analyzeCorners } from '../../src/corners';
import { driveLap } from '../../src/fixtures';
import { TrackMatcher } from '../../src/matching';
import { loadProfileFromJson } from '../../src/profile';

const TMR_V2_ASSET_URL = new URL(
  '../../assets/circuits/transilvania-motor-ring.v2.json',
  import.meta.url,
);

function tmr() {
  const loaded = loadProfileFromJson(readFileSync(TMR_V2_ASSET_URL, 'utf8'));
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return { profile: loaded.profile, runtime: loaded.runtime };
}

function matchAt(
  distanceM: number,
  totalLengthM: number,
  overrides: Partial<TrackMatch> = {},
): TrackMatch {
  return {
    tMono: 0,
    distanceM,
    progress: distanceM / totalLengthM,
    unwrappedProgressM: distanceM,
    lateralM: 0,
    confidence: 1,
    sectorIndex: 0,
    quality: { level: 'good', reasons: [] },
    onPitLane: false,
    ...overrides,
  };
}

describe('CoachEngine', () => {
  it('fires once per TMR corner in travel order, gates bad telemetry, and rearms on lap two', () => {
    const { profile, runtime } = tmr();
    const corners = analyzeCorners(runtime);
    const zones = deriveBrakingZones(null, corners, { totalLengthM: profile.totalLengthM });
    const engine = new CoachEngine({ totalLengthM: profile.totalLengthM });
    engine.configure(corners, zones);
    const matcher = new TrackMatcher(runtime);
    const samples = driveLap(profile, {
      seed: 9001,
      lapCount: 2,
      sampleRateHz: 1,
      noiseSigmaM: 0,
      accuracyM: 3,
      speedMps: 40,
    });
    const cues: CoachCue[] = [];
    for (const sample of samples) {
      const match = matcher.match(sample);
      if (match === null) continue;
      const cue = engine.onMatch(match, sample.speedMps);
      if (cue !== null) cues.push(cue);
    }

    expect(cues).toHaveLength(corners.length * 2);
    expect(cues.map((cue) => cue.cornerId)).toEqual([
      ...corners.map((corner) => corner.id),
      ...corners.map((corner) => corner.id),
    ]);
    for (const cue of cues) {
      expect(cue.distanceToTargetM).toBeGreaterThanOrEqual(0);
      expect(cue.distanceToTargetM).toBeLessThanOrEqual(120.000001);
    }

    const firstCorner = corners[0];
    const firstZone = zones[0];
    if (firstCorner === undefined || firstZone === undefined) throw new Error('TMR has no corner');
    const gateEngine = new CoachEngine({ totalLengthM: profile.totalLengthM });
    gateEngine.configure([firstCorner], [firstZone]);
    const sightDistanceM =
      (firstZone.brakeStartDistanceM - 100 + profile.totalLengthM) % profile.totalLengthM;
    expect(
      gateEngine.onMatch(
        matchAt(sightDistanceM, profile.totalLengthM, {
          confidence: 0.9,
          quality: { level: 'unreliable', reasons: ['TEST_WINDOW'] },
        }),
        40,
      ),
    ).toBeNull();
    const recovered = gateEngine.onMatch(
      matchAt((sightDistanceM + 40) % profile.totalLengthM, profile.totalLengthM, {
        confidence: 0.9,
      }),
      40,
    );
    expect(recovered?.cornerId).toBe(firstCorner.id);
  });

  it('uses CORNER_AHEAD when first sight is already beyond the braking point', () => {
    const { profile, runtime } = tmr();
    const corner = analyzeCorners(runtime)[1];
    if (corner === undefined) throw new Error('TMR has fewer than two corners');
    const zone = deriveBrakingZones(null, [corner], {
      totalLengthM: profile.totalLengthM,
      longStraightM: 0,
    })[0];
    if (zone === undefined) throw new Error('Missing braking zone');
    const engine = new CoachEngine({ totalLengthM: profile.totalLengthM, minLeadM: 200 });
    engine.configure([corner], [zone]);
    const distanceM = (zone.brakeStartDistanceM + 5) % profile.totalLengthM;
    const cue = engine.onMatch(matchAt(distanceM, profile.totalLengthM), 30);

    expect(cue?.kind).toBe('CORNER_AHEAD');
    expect(cue?.distanceToTargetM).toBeGreaterThanOrEqual(0);
  });

  it('accepts degraded quality at the binding confidence threshold, but never worse', () => {
    const { profile, runtime } = tmr();
    const corner = analyzeCorners(runtime)[0];
    if (corner === undefined) throw new Error('TMR has no corners');
    const engine = new CoachEngine({ totalLengthM: profile.totalLengthM });
    engine.configure([corner], []);
    const distanceM =
      (corner.entryDistanceM - 60 + profile.totalLengthM) % profile.totalLengthM;

    expect(
      engine.onMatch(
        matchAt(distanceM, profile.totalLengthM, {
          confidence: 0.4,
          quality: { level: 'degraded', reasons: [] },
        }),
        undefined,
      )?.kind,
    ).toBe('CORNER_AHEAD');
    engine.reset();
    expect(
      engine.onMatch(
        matchAt(distanceM, profile.totalLengthM, {
          confidence: 1,
          quality: { level: 'unreliable', reasons: [] },
        }),
        20,
      ),
    ).toBeNull();
  });
});
