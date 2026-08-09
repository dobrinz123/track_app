import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { CoachCue } from '../../src/contracts';
import { CoachEngine, deriveBrakingZones } from '../../src/coach';
import { analyzeCorners } from '../../src/corners';
import { driveLap } from '../../src/fixtures';
import { TrackMatcher } from '../../src/matching';
import { loadProfileFromJson } from '../../src/profile';

const TMR_V2_ASSET_URL = new URL(
  '../../assets/circuits/transilvania-motor-ring.v2.json',
  import.meta.url,
);

interface RecordedCue {
  targetLap: number;
  cue: CoachCue;
}

function replay(): RecordedCue[] {
  const loaded = loadProfileFromJson(readFileSync(TMR_V2_ASSET_URL, 'utf8'));
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  const { profile, runtime } = loaded;
  const corners = analyzeCorners(runtime);
  const zones = deriveBrakingZones(null, corners, { totalLengthM: profile.totalLengthM });
  const coach = new CoachEngine({ totalLengthM: profile.totalLengthM });
  coach.configure(corners, zones);
  const matcher = new TrackMatcher(runtime);
  const samples = driveLap(profile, {
    seed: 20_260_810,
    lapCount: 2,
    sampleRateHz: 2,
    noiseSigmaM: 0,
    accuracyM: 3,
    speedMps: ({ progress }) => 32 + 10 * Math.sin(progress * Math.PI * 2) ** 2,
  });

  const cues: RecordedCue[] = [];
  for (const sample of samples) {
    const match = matcher.match(sample);
    if (match === null) continue;
    const cue = coach.onMatch(match, sample.speedMps);
    if (cue === null) continue;
    cues.push({
      targetLap: Math.floor(
        (match.unwrappedProgressM + cue.distanceToTargetM + 1e-6) / profile.totalLengthM,
      ),
      cue,
    });
  }
  return cues;
}

describe('coaching replay integration on TMR v2', () => {
  it('emits exactly one ordered cue per corner per complete target lap, deterministically', () => {
    const first = replay();
    const second = replay();
    expect(second).toEqual(first);

    const byLap = new Map<number, RecordedCue[]>();
    for (const item of first) {
      const lap = byLap.get(item.targetLap) ?? [];
      lap.push(item);
      byLap.set(item.targetLap, lap);
    }
    expect([...byLap.keys()]).toEqual([1, 2]);
    for (const lap of byLap.values()) {
      expect(lap.map((item) => item.cue.cornerId)).toEqual(
        Array.from({ length: lap.length }, (_, index) => index + 1),
      );
    }
    expect(byLap.get(1)?.length).toBe(byLap.get(2)?.length);
    expect(byLap.get(1)?.length).toBeGreaterThanOrEqual(8);
  });
});
