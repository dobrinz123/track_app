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

/** Collapses a raw per-match cue stream into one entry per (targetLap, corner, kind) "activation" -- the live engine (F1/F2) re-emits a corner every match while approaching, so counting raw cues no longer means "one per corner". */
function activationsByLap(cues: RecordedCue[]): Map<number, { cornerId: number; kind: CoachCue['kind'] }[]> {
  const byLap = new Map<number, { cornerId: number; kind: CoachCue['kind'] }[]>();
  for (const { targetLap, cue } of cues) {
    const lapActivations = byLap.get(targetLap) ?? [];
    const last = lapActivations[lapActivations.length - 1];
    if (last === undefined || last.cornerId !== cue.cornerId || last.kind !== cue.kind) {
      lapActivations.push({ cornerId: cue.cornerId, kind: cue.kind });
    }
    byLap.set(targetLap, lapActivations);
  }
  return byLap;
}

describe('coaching replay integration on TMR v2', () => {
  it('deterministically emits a live, repeatedly-updating cue per corner (F1/F2) in strict travel order, once per corner per complete target lap', () => {
    const first = replay();
    const second = replay();
    expect(second).toEqual(first);

    // Live re-emission (F1/F2): many more raw cues than "one per corner" now,
    // since each corner is re-announced every match while in the lead window.
    expect(first.length).toBeGreaterThan(16);

    for (const { cue } of first) {
      expect(cue.distanceToTargetM).toBeGreaterThanOrEqual(0);
    }

    const byLap = activationsByLap(first);
    expect([...byLap.keys()]).toEqual([1, 2]);
    for (const activations of byLap.values()) {
      // Collapse the BRAKE->CORNER_AHEAD kind-flip (same corner, target
      // changes) down to one entry per corner before checking travel order.
      const cornerOrder: number[] = [];
      for (const activation of activations) {
        if (cornerOrder[cornerOrder.length - 1] !== activation.cornerId) cornerOrder.push(activation.cornerId);
      }
      expect(cornerOrder).toEqual(Array.from({ length: cornerOrder.length }, (_, index) => index + 1));
    }
    // Both laps must announce the same DISTINCT corner set (activation
    // counts can differ by one BRAKE->CORNER_AHEAD kind-split landing on a
    // different sample boundary between laps -- that's sampling phase, not a
    // missed/duplicated corner).
    const lap1Corners = new Set((byLap.get(1) ?? []).map((a) => a.cornerId));
    const lap2Corners = new Set((byLap.get(2) ?? []).map((a) => a.cornerId));
    expect(lap1Corners).toEqual(lap2Corners);
    expect(lap1Corners.size).toBeGreaterThanOrEqual(8);
  });
});
