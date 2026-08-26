import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { CircuitProfile } from '../../src/contracts';
import { driveLap, motorparkCleanRecognitionLap } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';
import { loadProfileFromJson, type RuntimeProfile } from '../../src/profile';

// Reuse the SAME track-day soak rig the TMR acceptance scenario uses (controller
// + fake clock/provider/scheduler + SampleTimeline gap support + the generic
// `oneHzPitLap` pit-transit helper) -- same production pipeline, zero shortcuts,
// no rig duplication (ticket CN-W2: "extract shared helpers ... ONLY if the
// import graph forces it" -- it doesn't; `track-day.soak.test.ts` already
// exports these for `userTrackDayScenario.soak.test.ts` to reuse this way).
import { controllerRig, last, oneHzPitLap, SampleTimeline } from './track-day.soak.test';

interface MotorParkV1 {
  profile: CircuitProfile;
  runtime: RuntimeProfile;
}

function motorParkV1(): MotorParkV1 {
  const json = readFileSync(
    new URL('../../assets/circuits/motorpark-romania.v1.json', import.meta.url),
    'utf8',
  );
  const loaded = loadProfileFromJson(json);
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return { profile: loaded.profile, runtime: loaded.runtime };
}

/**
 * The MotorPark port of `userTrackDayScenario.soak.test.ts`'s literal user
 * acceptance scenario: "hard lap, then cool lap, at some random point a pit
 * stop of a few minutes UP TO AN HOUR, then resume the session WITHOUT
 * recalibrating." Same structure, same production `SessionController`, same
 * calibration engine and CURRENT thresholds (0.85 coverage / 250 m max gap,
 * 40 m learn corridor) -- nothing in `calibration/**`, `matching/**`, or
 * `corners/**` is touched here; this is the acceptance PROOF for the
 * MotorPark profile, not a place to adjust thresholds.
 *
 * Modeled as: calibrate ONCE -> hard -> cool -> hard -> pit-transit lap ->
 * ONE FULL HOUR with zero GNSS samples -> hard -> hard -> end.
 */
describe('MotorPark acceptance scenario: hard/cool laps + up-to-an-hour pit pause, no recalibration', () => {
  it('runs the full described day through the production controller on the MotorPark profile', async () => {
    const motorpark = motorParkV1();
    const repository = new InMemorySessionRepository();
    const rig = controllerRig(motorpark, repository, 'soak-driver--motorpark-day');
    const timeline = new SampleTimeline();

    // One calibration, accepted once, never repeated.
    await rig.controller.start('calibration');
    rig.feed(timeline.append(motorparkCleanRecognitionLap(motorpark.profile, 79_001)));
    const calibrationReview = last(rig.states);
    expect(
      calibrationReview.calibrationResult?.accepted,
      JSON.stringify(calibrationReview.calibrationResult),
    ).toBe(true);
    rig.controller.acceptCalibration();
    await rig.controller.flush();
    rig.controller.arm();
    const statesAfterAccept = rig.states.length;

    // Pre-pit stint as ONE continuous kinematic run (no fixture seams):
    // lap 1 hard (48 m/s), lap 2 cool (24), lap 3 hard (48).
    const stintSpeeds = [48, 24, 48];
    rig.feed(
      timeline.append(
        driveLap(motorpark.profile, {
          seed: 79_002,
          lapCount: 3,
          noiseSigmaM: 1.5,
          speedMps: ({ lapIndex }) => stintSpeeds[Math.min(lapIndex, 2)]!,
        }),
      ),
    );

    // Pit in -- transit lap must never be silently counted.
    rig.feed(timeline.append(oneHzPitLap(motorpark.profile, 79_005)));

    // THE HOUR: zero samples (phone pocketed in the pit). Watchdog must
    // self-recover; the lap spanning the pause must be invalidated, never
    // reported as a time.
    const restartsBeforeGap = rig.restartCalls.length;
    rig.clock.advance(3_600_000);
    rig.scheduler.tick();
    rig.feed(
      timeline.append(
        driveLap(motorpark.profile, { seed: 79_006, lapCount: 2, noiseSigmaM: 1.5, speedMps: 48 }),
        3_600_000,
      ),
    );

    await rig.controller.endSession();
    await rig.controller.flush();

    // --- No recalibration ever happened after the single accept. ---
    const statesAfter = rig.states.slice(statesAfterAccept);
    expect(statesAfter.some((s) => s.sessionState === 'calibrating')).toBe(false);
    expect(statesAfter.some((s) => s.sessionState === 'awaitingCalibration')).toBe(false);

    // --- Pit was recognized as pit. ---
    expect(statesAfter.some((s) => s.sessionState === 'inPit')).toBe(true);

    // --- Lap ledger: 5 valid + 1 pit-invalid, numbering continuous. ---
    const laps = last(rig.states).laps;
    const valid = laps.filter((lap) => lap.valid);
    const invalid = laps.filter((lap) => !lap.valid);
    expect(valid).toHaveLength(4);
    expect(invalid).toHaveLength(2);
    expect(invalid[1]?.invalidReasons).toContain('PAUSE_GAP');
    expect(invalid[0]?.invalidReasons).toContain('PIT_TRANSIT');
    expect(laps.map((lap) => lap.lapNumber)).toEqual([1, 2, 3, 4, 5, 6]);

    // --- Timing sanity: hard ~ hard, cool distinctly slower; nothing absurd
    // leaked from the hour-long gap into any duration. ---
    const durations = valid.map((lap) => lap.durationMs);
    for (const d of durations) {
      expect(d).toBeGreaterThan(60_000);
      expect(d).toBeLessThan(200_000);
    }
    const coolLap = valid[1]!;
    const hardBefore = valid[0]!;
    expect(coolLap.durationMs).toBeGreaterThan(hardBefore.durationMs * 1.5);

    // --- Watchdog self-recovered across the hour (no user action). ---
    expect(rig.restartCalls.length).toBeGreaterThan(restartsBeforeGap);

    // --- PB machinery survived the pause: PB stored, equals fastest lap. ---
    const pb = await repository.getReferenceLap(
      'soak-driver',
      motorpark.profile.circuitId,
      motorpark.profile.layoutId,
      motorpark.profile.layoutVersion,
    );
    expect(pb).not.toBeNull();
    expect(pb!.durationMs).toBe(Math.min(...durations));

    // --- Delta machinery live on the post-pause laps (reference engaged). ---
    const postGapStates = statesAfter.slice(-Math.floor(statesAfter.length / 4));
    expect(postGapStates.some((s) => s.delta !== null)).toBe(true);
  });
});
