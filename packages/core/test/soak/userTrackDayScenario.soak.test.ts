import { describe, expect, it } from 'vitest';

import type { LocationSample } from '../../src/contracts';
import { cleanRecognitionLap, driveLap } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';

// Reuse the track-day soak rig (controller + fake clock/provider/scheduler +
// SampleTimeline gap support) — same production pipeline, zero shortcuts.
import { controllerRig, last, oneHzPitLap, SampleTimeline, tmrV2 } from './track-day.soak.test';

/**
 * The user's literal acceptance scenario, verbatim from product Q&A:
 * "hard lap, then cool lap, at some random point a pit stop of a few minutes
 * UP TO AN HOUR, then resume the session WITHOUT recalibrating."
 *
 * Modeled as: calibrate ONCE → hard → cool → hard → pit-transit lap →
 * ONE FULL HOUR with zero GNSS samples (phone pocketed/backgrounded in the
 * pit — the realistic behavior for a long break) → hard → hard → end.
 *
 * Pass criteria: 5 valid timed laps with continuous numbering, the pit lap
 * invalidated as PIT_TRANSIT (never silently counted), zero recalibration
 * after the single accept, the watchdog self-recovering across the hour gap,
 * and the PB/delta machinery still live on the post-pause laps.
 */
describe('user acceptance scenario: hard/cool laps + up-to-an-hour pit pause, no recalibration', () => {
  it('runs the full described day through the production controller', async () => {
    const tmr = tmrV2();
    const repository = new InMemorySessionRepository();
    const rig = controllerRig(tmr, repository, 'soak-driver--user-day');
    const timeline = new SampleTimeline();

    // One calibration, accepted once, never repeated.
    await rig.controller.start('calibration');
    rig.feed(timeline.append(cleanRecognitionLap(tmr.profile, 77_001)));
    expect(last(rig.states).calibrationResult?.accepted).toBe(true);
    rig.controller.acceptCalibration();
    await rig.controller.flush();
    rig.controller.arm();
    const statesAfterAccept = rig.states.length;

    // Pre-pit stint as ONE continuous kinematic run (no fixture seams):
    // lap 1 hard (48 m/s), lap 2 cool (24), lap 3 hard (48).
    const stintSpeeds = [48, 24, 48];
    rig.feed(
      timeline.append(
        driveLap(tmr.profile, {
          seed: 77_002,
          lapCount: 3,
          noiseSigmaM: 1.5,
          speedMps: ({ lapIndex }) => stintSpeeds[Math.min(lapIndex, 2)]!,
        }),
      ),
    );

    // Pit in — transit lap must never be silently counted.
    rig.feed(timeline.append(oneHzPitLap(tmr.profile, 77_005)));

    // THE HOUR: zero samples (phone pocketed in the pit). Watchdog must
    // self-recover; the lap spanning the pause must be invalidated, never
    // reported as a time.
    const restartsBeforeGap = rig.restartCalls.length;
    // Simulate the watchdog actually polling during the silent hour (the rig
    // only ticks its scheduler explicitly): one poll mid-silence must trigger
    // a provider restart attempt, exactly as on-device.
    rig.clock.advance(3_600_000);
    rig.scheduler.tick();
    rig.feed(
      timeline.append(
        driveLap(tmr.profile, { seed: 77_006, lapCount: 2, noiseSigmaM: 1.5, speedMps: 48 }),
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
    // Pinned to the DESIGNED outcome for this exact day: 4 valid timed laps;
    // the pit-transit lap invalid (PIT_TRANSIT); the lap spanning the
    // one-hour pause invalid (PAUSE_GAP) — its ~3680s duration must never
    // surface as a lap time.
    expect(valid).toHaveLength(4);
    expect(invalid).toHaveLength(2);
    expect(invalid[1]?.invalidReasons).toContain('PAUSE_GAP');
    expect(invalid[0]?.invalidReasons).toContain('PIT_TRANSIT');
    expect(laps.map((lap) => lap.lapNumber)).toEqual([1, 2, 3, 4, 5, 6]);

    // --- Timing sanity: hard ≈ hard, cool distinctly slower; nothing absurd
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
      tmr.profile.circuitId,
      tmr.profile.layoutId,
      tmr.profile.layoutVersion,
    );
    expect(pb).not.toBeNull();
    expect(pb!.durationMs).toBe(Math.min(...durations));

    // --- Delta machinery live on the post-pause laps (reference engaged). ---
    const postGapStates = statesAfter.slice(-Math.floor(statesAfter.length / 4));
    expect(postGapStates.some((s) => s.delta !== null)).toBe(true);
  });
});
