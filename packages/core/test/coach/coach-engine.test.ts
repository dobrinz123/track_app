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
  it('LIVE re-emission (F1/F2): re-emits the SAME corner every match with a non-increasing distanceToTargetM while approaching, in travel order, and clears the instant the target is passed', () => {
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

    // Live re-emission means MANY more cues than one-per-corner-per-lap now
    // (each corner is approached over several 1 Hz samples within the lead
    // window) -- proves the countdown is really firing repeatedly, not once.
    expect(cues.length).toBeGreaterThan(corners.length * 2);
    for (const cue of cues) {
      expect(cue.distanceToTargetM).toBeGreaterThanOrEqual(0);
      expect(cue.distanceToTargetM).toBeLessThanOrEqual(120.000001);
    }

    // Group consecutive same-corner cues into "activations" (an approach
    // cycle) and confirm each one's distance is non-increasing -- a genuine
    // live countdown, not noise -- and that activations proceed in travel
    // order (corner 1..N) each lap.
    const activations: { cornerId: number; kind: CoachCue['kind']; distances: number[] }[] = [];
    for (const cue of cues) {
      const last = activations[activations.length - 1];
      if (last !== undefined && last.cornerId === cue.cornerId && last.kind === cue.kind) {
        last.distances.push(cue.distanceToTargetM);
      } else {
        activations.push({ cornerId: cue.cornerId, kind: cue.kind, distances: [cue.distanceToTargetM] });
      }
    }
    // Corner order (collapsing the BRAKE->CORNER_AHEAD kind-flip -- the
    // target itself changes at that instant, so distance legitimately jumps
    // there) must still be strict travel order, once per corner per lap.
    const cornerOrder: number[] = [];
    for (const activation of activations) {
      if (cornerOrder[cornerOrder.length - 1] !== activation.cornerId) cornerOrder.push(activation.cornerId);
    }
    expect(cornerOrder).toEqual([
      ...corners.map((corner) => corner.id),
      ...corners.map((corner) => corner.id),
    ]);
    // Within a single (corner, kind) run -- i.e. between target changes --
    // distance is a genuine non-increasing countdown.
    for (const activation of activations) {
      for (let i = 1; i < activation.distances.length; i += 1) {
        expect(activation.distances[i]).toBeLessThanOrEqual(activation.distances[i - 1]! + 1e-9);
      }
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

    // Passing the target ends the cue on the very next match (no memory of
    // "already shown" needed -- forwardDistance to a point now behind us
    // reads as almost a full lap away).
    const pastEntryM = (firstCorner.entryDistanceM + 5) % profile.totalLengthM;
    expect(gateEngine.onMatch(matchAt(pastEntryM, profile.totalLengthM), 40)).toBeNull();
  });

  it("a corner already driven past this lap does NOT re-candidate even if a later match's forward-distance briefly reads small again (defensive completion guard)", () => {
    const { profile, runtime } = tmr();
    const corner = analyzeCorners(runtime)[0];
    if (corner === undefined) throw new Error('TMR has no corners');
    const engine = new CoachEngine({ totalLengthM: profile.totalLengthM, minLeadM: 500 });
    engine.configure([corner], []);

    const approachM = (corner.entryDistanceM - 50 + profile.totalLengthM) % profile.totalLengthM;
    expect(engine.onMatch(matchAt(approachM, profile.totalLengthM), 20)?.cornerId).toBe(corner.id);

    const pastExitM = (corner.exitDistanceM + 600) % profile.totalLengthM;
    expect(engine.onMatch(matchAt(pastExitM, profile.totalLengthM), 20)).toBeNull();

    // A noisy sample lands back near the entry point again (implausible in
    // reality, but exercises the guard directly) -- must NOT re-fire.
    expect(engine.onMatch(matchAt(approachM, profile.totalLengthM), 20)).toBeNull();
  });

  it('configure() with preserveEmitted:true keeps the completion guard across a mid-lap zone refresh (M-PB-refresh)', () => {
    const { profile, runtime } = tmr();
    const corner = analyzeCorners(runtime)[0];
    if (corner === undefined) throw new Error('TMR has no corners');
    const zoneA = deriveBrakingZones(null, [corner], { totalLengthM: profile.totalLengthM });
    const engine = new CoachEngine({ totalLengthM: profile.totalLengthM, minLeadM: 500 });
    engine.configure([corner], zoneA);

    const approachM = (corner.entryDistanceM - 50 + profile.totalLengthM) % profile.totalLengthM;
    expect(engine.onMatch(matchAt(approachM, profile.totalLengthM), 20)?.cornerId).toBe(corner.id);
    const pastExitM = (corner.exitDistanceM + 600) % profile.totalLengthM;
    expect(engine.onMatch(matchAt(pastExitM, profile.totalLengthM), 20)).toBeNull();

    // Mid-lap zone refresh (as `refreshCoachZones` performs on a new PB).
    const zoneB = deriveBrakingZones(null, [corner], {
      totalLengthM: profile.totalLengthM,
      decelMps2: 12,
    });
    engine.configure([corner], zoneB, { preserveEmitted: true });

    // C1 must NOT re-fire on the same lap even though it's still configured.
    expect(engine.onMatch(matchAt(approachM, profile.totalLengthM), 20)).toBeNull();

    // Without preserveEmitted, a fresh configure legitimately rearms it (used
    // by session start, not mid-lap refresh) -- proves the option is doing
    // the work, not some other invariant.
    engine.configure([corner], zoneB);
    expect(engine.onMatch(matchAt(approachM, profile.totalLengthM), 20)?.cornerId).toBe(corner.id);
  });

  it('M-speed-clamp: a glitchy 150 m/s sample does not blow the lead window past maxLeadSpeedMps (default 90)', () => {
    const { profile, runtime } = tmr();
    const corner = analyzeCorners(runtime)[0];
    if (corner === undefined) throw new Error('TMR has no corners');
    const engine = new CoachEngine({ totalLengthM: profile.totalLengthM, minLeadM: 80, leadSeconds: 3 });
    engine.configure([corner], []);

    // 90 m/s cap * 3s = 270m lead; 150 m/s uncapped would be 450m.
    const justOutsideCappedLeadM =
      (corner.entryDistanceM - 300 + profile.totalLengthM) % profile.totalLengthM;
    expect(engine.onMatch(matchAt(justOutsideCappedLeadM, profile.totalLengthM), 150)).toBeNull();

    const withinCappedLeadM =
      (corner.entryDistanceM - 250 + profile.totalLengthM) % profile.totalLengthM;
    expect(engine.onMatch(matchAt(withinCappedLeadM, profile.totalLengthM), 150)?.cornerId).toBe(
      corner.id,
    );
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
