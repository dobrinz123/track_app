import { describe, expect, it } from 'vitest';

import type { LocationSample, ReferenceLap, SessionMachineSnapshot } from '../../src/contracts';
import { SessionController, type FacadeStateCore } from '../../src/controller';
import { cleanRecognitionLap, driveLap, pbImprovementSession } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';

import { FakeClock, FakeLocationProvider, FakeWatchdogScheduler, tmr } from './testSupport';

function last<T>(items: readonly T[]): T {
  const value = items[items.length - 1];
  if (value === undefined) throw new Error('expected at least one item');
  return value;
}

/** Builds a fresh controller + its dependencies, all fakes under full test control. */
function setup(existingRepository?: InMemorySessionRepository) {
  const { profile, runtime } = tmr();
  const repository = existingRepository ?? new InMemorySessionRepository();
  const provider = new FakeLocationProvider();
  const clock = new FakeClock(1_000_000);
  const scheduler = new FakeWatchdogScheduler();
  const restartCalls: number[] = [];
  const restartProvider = (): void => {
    restartCalls.push(clock.now());
  };

  const controller = new SessionController({
    runtimeProfile: runtime,
    circuitProfile: profile,
    locationProvider: provider,
    clock,
    repository,
    userId: 'driver-1',
    appVersion: 'controller-test',
    algorithmVersion: 1,
    restartProvider,
    config: { scheduler, watchdogTimeoutMs: 5_000, watchdogPollMs: 1_000 },
  });

  const states: FacadeStateCore[] = [];
  controller.subscribe((s) => states.push(s));

  let wallClock = clock.now();
  let previousTMono: number | null = null;
  /** Pushes samples through the provider while advancing the fake clock by the same real-time deltas, so `deps.clock.now()` and `sample.tMono` stay consistent -- mirroring `GnssLocationProvider`, where both are stamped from the same monotonic source. */
  function feed(samples: readonly LocationSample[]): void {
    for (const sample of samples) {
      const delta = previousTMono === null ? 0 : Math.max(0, sample.tMono - previousTMono);
      previousTMono = sample.tMono;
      wallClock += delta;
      clock.set(wallClock);
      provider.push(sample);
    }
  }

  return { profile, runtime, repository, provider, clock, scheduler, restartCalls, controller, states, feed };
}

describe('SessionController', () => {
  it('runs calibration accept flow, times three laps, checkpoints after each, replaces PB atomically, and saves the session summary', async () => {
    const { profile, repository, controller, states, feed } = setup();

    await controller.start('calibration');
    expect(last(states).sessionState).toBe('calibrating');

    feed(cleanRecognitionLap(profile, 501));
    expect(last(states).sessionState).toBe('calibrationReview');
    expect(last(states).calibrationResult?.accepted).toBe(true);

    controller.acceptCalibration();
    expect(last(states).sessionState).toBe('armed');
    await controller.flush();

    controller.arm();

    feed(pbImprovementSession(profile, 502));
    await controller.flush();

    const finalState = last(states);
    expect(finalState.laps).toHaveLength(3);
    expect(finalState.laps.every((lap) => lap.valid)).toBe(true);

    // Checkpoint saved after every completed lap.
    const sessionId = controller.diagnostics().sessionId;
    expect(sessionId).not.toBeNull();
    const checkpoint = await repository.loadCheckpoint(sessionId!);
    expect(checkpoint?.laps).toHaveLength(3);

    // PB created on lap 1, then improved by faster laps 2 and 3 (immediately, not deferred to session end).
    const pb = await repository.getReferenceLap('driver-1', profile.circuitId, profile.layoutId, profile.layoutVersion);
    expect(pb).not.toBeNull();
    expect(pb!.durationMs).toBe(finalState.laps[2]!.durationMs);
    expect(pb!.durationMs).toBeLessThan(finalState.laps[0]!.durationMs);

    await controller.endSession();
    expect(last(states).sessionState).toBe('sessionComplete');
    const sessions = await repository.listSessions('driver-1', profile.circuitId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(sessionId);
    expect(sessions[0]?.laps).toHaveLength(3);
  });

  it('watchdog restarts the provider after a silent gap while active and unpaused', async () => {
    const { controller, clock, scheduler, restartCalls } = setup();

    await controller.start('calibration');
    expect(controller.diagnostics().watchRestarts).toBe(0);

    clock.advance(5_001);
    scheduler.tick();

    expect(controller.diagnostics().watchRestarts).toBe(1);
    expect(restartCalls).toHaveLength(1);

    // A second tick before another 5s gap must not double-fire.
    clock.advance(100);
    scheduler.tick();
    expect(controller.diagnostics().watchRestarts).toBe(1);
  });

  it('does not fire the watchdog while paused', async () => {
    const { profile, controller, clock, scheduler, restartCalls, feed, states } = setup();
    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 503));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();
    expect(last(states).sessionState).toBe('armed');

    controller.pause();
    clock.advance(10_000);
    scheduler.tick();
    expect(restartCalls).toHaveLength(0);
  });

  it('pause/resume with a >30s gap marks the affected lap PAUSE_GAP', async () => {
    const { profile, controller, clock, feed, states } = setup();
    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 504));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    const drivingSamples = pbImprovementSession(profile, 505);
    const firstHalf = drivingSamples.slice(0, Math.floor(drivingSamples.length / 6));
    const rest = drivingSamples.slice(Math.floor(drivingSamples.length / 6));
    feed(firstHalf);
    expect(last(states).sessionState === 'timing' || last(states).sessionState === 'outLap').toBe(true);

    controller.pause();
    expect(last(states).sessionState).toBe('paused');
    clock.advance(45_000);
    controller.resume();

    feed(rest);
    await controller.flush();

    const laps = last(states).laps;
    expect(laps.length).toBeGreaterThan(0);
    expect(laps[0]?.invalidReasons).toContain('PAUSE_GAP');
    expect(laps[0]?.valid).toBe(false);
  });

  it('restoreFromCheckpoint restores historical laps and marks the interrupted in-flight lap RECOVERY', () => {
    const { controller, states } = setup();
    const historicalLaps = [
      {
        lapNumber: 1,
        tStart: 0,
        tEnd: 90_000,
        durationMs: 90_000,
        sectorTimes: [],
        valid: true,
        invalidReasons: [],
        quality: 'good' as const,
      },
    ];
    const snapshot: SessionMachineSnapshot = {
      state: 'timing',
      lapNumber: 2,
      context: { lapNumber: 2, priorState: null, pendingInvalidReasons: [], gnssDegraded: false, preflightFailureReasons: [] },
    };

    controller.restoreFromCheckpoint('driver-1--recovered-session', snapshot, historicalLaps);

    const restored = last(states);
    expect(restored.sessionState).toBe('awaitingCalibration');
    expect(restored.laps).toHaveLength(2);
    expect(restored.laps[0]?.valid).toBe(true);
    const recoveryLap = restored.laps[1]!;
    expect(recoveryLap.lapNumber).toBe(2);
    expect(recoveryLap.valid).toBe(false);
    expect(recoveryLap.invalidReasons).toContain('RECOVERY');
    expect(controller.diagnostics().sessionId).toBe('driver-1--recovered-session');
  });

  it('start("session") skips calibration and arms directly off the stored reference lap (recovery resume)', async () => {
    const { profile, repository, controller, states } = setup();
    const stored: ReferenceLap = {
      circuitId: profile.circuitId,
      layoutId: profile.layoutId,
      layoutVersion: profile.layoutVersion,
      userId: 'driver-1',
      durationMs: 90_000,
      sectorTimes: [
        { sectorIndex: 0, durationMs: 30_000, quality: 'good' },
        { sectorIndex: 1, durationMs: 30_000, quality: 'good' },
        { sectorIndex: 2, durationMs: 30_000, quality: 'good' },
      ],
      recordedAtUtc: '2026-08-01T00:00:00.000Z',
      sessionId: 'driver-1--prior-session',
      lapNumber: 1,
      distanceGridM: [0, profile.totalLengthM],
      elapsedMsAtGrid: [0, 90_000],
      gnssQualitySummary: { level: 'good', reasons: [] },
      appVersion: 'controller-test',
      algorithmVersion: 1,
      profileSchemaVersion: profile.schemaVersion,
    };
    await repository.putReferenceLap(stored);

    await controller.start('session');
    expect(last(states).sessionState).toBe('armed');
    expect(last(states).pbMs).toBe(90_000);
  });

  it('emits a live delta with positive confidence while timing against an existing reference lap', async () => {
    // First session: create a PB the normal way (calibrate, arm, drive one lap).
    const first = setup();
    await first.controller.start('calibration');
    first.feed(cleanRecognitionLap(first.profile, 601));
    first.controller.acceptCalibration();
    await first.controller.flush();
    first.controller.arm();
    first.feed(driveLap(first.profile, { seed: 602, speedMps: 40, noiseSigmaM: 1 }));
    await first.controller.flush();
    await first.controller.endSession();
    const pb = await first.repository.getReferenceLap(
      'driver-1',
      first.profile.circuitId,
      first.profile.layoutId,
      first.profile.layoutVersion,
    );
    expect(pb).not.toBeNull();

    // Second session, fresh controller, same repository: start('session')
    // loads the stored reference synchronously before any sample is
    // ingested, so the live delta engine has it from the first matched
    // sample once armed.
    const second = setup(first.repository);
    await second.controller.start('session');
    second.controller.arm();
    second.feed(driveLap(second.profile, { seed: 603, speedMps: 42, noiseSigmaM: 1 }));

    const deltaSeen = second.states.some((s) => s.delta !== null && s.delta.confidence > 0);
    expect(deltaSeen).toBe(true);
  });
});
