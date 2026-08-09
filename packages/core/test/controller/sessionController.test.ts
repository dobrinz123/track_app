import { describe, expect, it } from 'vitest';

import type {
  Corner,
  LocalSessionRepository,
  LocationSample,
  ReferenceLap,
  SessionMachineSnapshot,
} from '../../src/contracts';
import { SessionController, type FacadeStateCore, type SessionControllerDeps } from '../../src/controller';
import { analyzeCorners } from '../../src/corners';
import {
  cleanRecognitionLap,
  driveLap,
  multiLapSession,
  pbImprovementSession,
  sampleAtLapDistance,
} from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';

import { ControllableRepository, FakeClock, FakeLocationProvider, FakeWatchdogScheduler, tmr } from './testSupport';

function last<T>(items: readonly T[]): T {
  const value = items[items.length - 1];
  if (value === undefined) throw new Error('expected at least one item');
  return value;
}

/** Builds a fresh controller + its dependencies, all fakes under full test control. Optional `coaching` forwards straight to `SessionControllerDeps.coaching` (Phase 3 addendum) -- omitted, coaching stays disabled exactly like every pre-existing test in this file. */
function setup(existingRepository?: LocalSessionRepository, coaching?: SessionControllerDeps['coaching']) {
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
    ...(coaching === undefined ? {} : { coaching }),
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

  it('trims the raw-sample buffer to the in-flight lap on every lap completion (M2 fix)', async () => {
    const { profile, controller, feed } = setup();
    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 701));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    const samples = pbImprovementSession(profile, 702);
    feed(samples);
    await controller.flush();

    const diag = controller.diagnostics();
    expect(diag.matchedSampleCount).toBeGreaterThan(0);
    // The buffer must hold only the still in-flight tail after each lap's
    // samples are persisted, not the whole 3-lap session's worth of samples.
    expect(diag.rawSampleBufferSize).toBeLessThan(samples.length / 2);
  });

  it('raw-sample buffer size does not grow with total session length (M2 fix, O(current lap) not O(session))', async () => {
    async function bufferSizeAfterLaps(laps: number, seed: number): Promise<number> {
      const { profile, controller, feed } = setup();
      await controller.start('calibration');
      feed(cleanRecognitionLap(profile, seed));
      controller.acceptCalibration();
      await controller.flush();
      controller.arm();
      feed(multiLapSession(profile, laps, seed + 1));
      await controller.flush();
      return controller.diagnostics().rawSampleBufferSize;
    }

    const shortSessionBuffer = await bufferSizeAfterLaps(2, 710);
    const longSessionBuffer = await bufferSizeAfterLaps(10, 720);

    // If rawSamples grew unboundedly for the whole session, a 5x-longer
    // session would leave behind proportionally more buffered samples. With
    // per-lap trimming both stay small and close together.
    expect(longSessionBuffer).toBeLessThan(shortSessionBuffer + 50);
  });

  it('wires CircuitProfile.corridorWidthM into the live calibration engine (MUST DO #1)', async () => {
    const { profile, controller, provider, clock, states } = setup();
    // The real bundled TMR profile's corridorWidthM (15 m) is narrower than
    // both TrackMatcher's and CalibrationEngine's own 20 m defaults -- a
    // sample at 17 m lateral offset is a genuine corridor-boundary case:
    // off-corridor for the real profile, on-corridor for the stale default.
    expect(profile.corridorWidthM).toBe(15);

    await controller.start('calibration');
    const sample = sampleAtLapDistance(profile, 200, clock.now(), { lateralOffsetM: 17, accuracyM: 3 });
    provider.push(sample);

    // If corridorWidthM weren't wired (defaulting to 20 m), 17 m would still
    // read onTrack=true -- this fails red without the MUST DO #1 fix.
    expect(last(states).calibration?.onTrack).toBe(false);
  });

  it('checkpointNow() is public and persists the current state/laps on demand (MUST DO #4)', async () => {
    const { profile, repository, controller, feed } = setup();
    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 801));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    const sessionId = controller.diagnostics().sessionId!;
    // Nothing but 'calibration'/'acceptCalibration' has checkpointed yet in
    // this flow beyond what those internally trigger; call the newly-public
    // API directly, simulating the app-background lifecycle hook.
    await controller.checkpointNow();

    const checkpoint = await repository.loadCheckpoint(sessionId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.snapshot.state).toBe('armed');
  });

  it('checkpointNow() is a safe no-op before any session has started', async () => {
    const { controller } = setup();
    await expect(controller.checkpointNow()).resolves.toBeUndefined();
  });

  it('restoreFromCheckpoint seeds lap numbering past restored history so recovery does not collide (MUST DO #5)', async () => {
    const { profile, controller, provider, clock, states } = setup();
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
      {
        lapNumber: 2,
        tStart: 90_000,
        tEnd: 180_000,
        durationMs: 90_000,
        sectorTimes: [],
        valid: true,
        invalidReasons: [],
        quality: 'good' as const,
      },
    ];
    const snapshot: SessionMachineSnapshot = {
      state: 'armed',
      lapNumber: 0,
      context: { lapNumber: 0, priorState: null, pendingInvalidReasons: [], gnssDegraded: false, preflightFailureReasons: [] },
    };
    controller.restoreFromCheckpoint('driver-1--recovered', snapshot, historicalLaps);
    // Skip straight to armed off the stored reference, per the documented
    // recovery flow (no live recalibration).
    await controller.start('session');
    expect(last(states).sessionState).toBe('armed');
    controller.arm();

    // Drive one full lap live. Without the MUST DO #5 fix, both the
    // reducer-driven live lapNumber display AND the completed LapRecord
    // would renumber back to 1, colliding with the restored lap 1.
    const drivingSamples = driveLap(profile, { seed: 900, speedMps: 40, noiseSigmaM: 1 });
    let wallClock = clock.now();
    let previousTMono: number | null = null;
    for (const sample of drivingSamples) {
      const delta = previousTMono === null ? 0 : Math.max(0, sample.tMono - previousTMono);
      previousTMono = sample.tMono;
      wallClock += delta;
      clock.set(wallClock);
      provider.push(sample);
    }
    await controller.flush();

    const finalState = last(states);
    expect(finalState.laps).toHaveLength(3); // 2 restored + 1 freshly completed
    const freshLap = finalState.laps[2]!;
    expect(freshLap.lapNumber).toBe(3);

    // The live "current lap" display (state.lapNumber, reducer-driven) must
    // stay in sync with the real numbering too: while lap 3 was in progress
    // it must read 3 (not 1, which is what the unfixed reducer would stamp
    // on the very first live crossing after a resume) -- and it must never
    // regress into the 1/2 range that would collide with the two restored
    // historical laps.
    const timingLapNumbers = states.filter((s) => s.sessionState === 'timing').map((s) => s.lapNumber);
    expect(timingLapNumbers.length).toBeGreaterThan(0);
    expect(timingLapNumbers).toContain(3);
    expect(timingLapNumbers.every((n) => n >= 3)).toBe(true);
  });

  // -------------------------------------------------------------------
  // C1 -- one-shot controller: dispose()
  // -------------------------------------------------------------------

  it('dispose() stops the watchdog and provider, detaches the sample listener, and is idempotent (C1 fix)', async () => {
    const { profile, controller, provider, clock, scheduler, restartCalls, states, feed } = setup();
    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 901));
    expect(last(states).sessionState).toBe('calibrationReview');
    const emissionsBeforeDispose = states.length;
    expect(provider.stopCount).toBe(0);

    await controller.dispose();
    expect(provider.stopCount).toBe(1);

    // Idempotent: a second call must not throw, double-stop the provider, or
    // do anything else observable.
    await expect(controller.dispose()).resolves.toBeUndefined();
    expect(provider.stopCount).toBe(1);

    // No emissions after dispose: the controller's sample listener was
    // detached from `provider` (`providerUnsubscribe`), so pushing a sample
    // through it directly -- simulating a shared GnssLocationProvider handing
    // samples to whichever controller is currently subscribed -- must not
    // reach this (disposed) controller at all.
    provider.push(sampleAtLapDistance(profile, 500, clock.now(), { lateralOffsetM: 0, accuracyM: 3 }));
    expect(states.length).toBe(emissionsBeforeDispose);

    // The watchdog is stopped too: advancing well past its timeout and
    // ticking the scheduler must not restart the provider or emit again.
    clock.advance(10_000);
    scheduler.tick();
    expect(restartCalls).toHaveLength(0);
    expect(states.length).toBe(emissionsBeforeDispose);
  });

  // -------------------------------------------------------------------
  // C4 (also pins blind-verifier B2) -- endSession() must await flush()
  // BEFORE saveSession/checkpoint, using Promise.all (not allSettled) so a
  // persistence failure propagates instead of being silently swallowed.
  // -------------------------------------------------------------------

  it('endSession() resolves only once a slow-resolving telemetry write has committed, with the repository fully consistent at resolution (C4 fix)', async () => {
    const inner = new InMemorySessionRepository();
    const controllable = new ControllableRepository(inner);
    const { profile, controller, feed } = setup(controllable);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 950));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    // Gate saveTelemetry BEFORE driving the lap, so the write queued by
    // onLapCompleted() is still pending when endSession() is called.
    let releaseGate: () => void = () => undefined;
    controllable.saveTelemetryGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    feed(driveLap(profile, { seed: 951, speedMps: 40, noiseSigmaM: 1 }));

    let ended = false;
    const endPromise = controller.endSession().then(() => {
      ended = true;
    });

    // Let pending microtasks progress (including the queued saveTelemetry
    // call reaching the gate) without resolving it.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(controllable.saveTelemetryCalls.length).toBeGreaterThan(0);
    expect(ended).toBe(false); // endSession() must NOT have resolved yet -- it is awaiting flush().

    releaseGate();
    await endPromise;
    expect(ended).toBe(true);

    // Repository contents are fully committed at resolution: telemetry,
    // checkpoint, PB, and the session summary itself.
    const sessionId = controller.diagnostics().sessionId!;
    const telemetry = await inner.loadTelemetry(sessionId, 1);
    expect(telemetry.length).toBeGreaterThan(0);
    const checkpoint = await inner.loadCheckpoint(sessionId);
    expect(checkpoint?.laps).toHaveLength(1);
    const pb = await inner.getReferenceLap('driver-1', profile.circuitId, profile.layoutId, profile.layoutVersion);
    expect(pb).not.toBeNull();
    const sessions = await inner.listSessions('driver-1', profile.circuitId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.laps).toHaveLength(1);
  });

  it('endSession() rejects when a pending telemetry write fails, and never saves the session summary (C4 fix; pins B2 -- flush() must use Promise.all, not allSettled)', async () => {
    const inner = new InMemorySessionRepository();
    const controllable = new ControllableRepository(inner);
    const { profile, controller, feed } = setup(controllable);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 960));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    controllable.saveTelemetryShouldReject = true;
    feed(driveLap(profile, { seed: 961, speedMps: 40, noiseSigmaM: 1 }));

    await expect(controller.endSession()).rejects.toThrow('saveTelemetry failed');

    // A reverted flush() (Promise.allSettled instead of Promise.all) would
    // swallow the rejection, let endSession() proceed past it, and save the
    // session summary anyway -- this is exactly what this assertion catches.
    const sessions = await inner.listSessions('driver-1', profile.circuitId);
    expect(sessions).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // C8 -- background checkpointNow() must never throw synchronously and
  // must reject cleanly (so composition.ts's onBackground handler can
  // `.catch()` it without an unhandled rejection).
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // F1 -- C7 regression: a failed start() must leave state/subscriptions
  // untouched, and a subsequent successful retry must yield EXACTLY ONE
  // provider subscription (not two, which double-ingests every sample).
  // -------------------------------------------------------------------

  it('a failed start() leaves sessionState/mode unchanged and installs zero provider subscriptions (F1 fix)', async () => {
    const { controller, provider, states } = setup();
    provider.startFailuresRemaining = 1;

    const emissionsBefore = states.length;
    await expect(controller.start('calibration')).rejects.toThrow('start failed');

    // No dispatch/mode mutation happened -- nothing was ever emitted for
    // this failed attempt, and the controller's own diagnostics/state stay
    // exactly as they were before the call (still idle).
    expect(states.length).toBe(emissionsBefore);
    expect(last(states).sessionState).toBe('idle');
    expect(provider.listenerCount).toBe(0);
    expect(provider.startCount).toBe(1);
  });

  it('after a failed start(), a retry succeeds with exactly ONE provider subscription that ingests every sample exactly once -- not twice (F1 fix, C7 regression)', async () => {
    const { profile, controller, provider, feed } = setup();
    provider.startFailuresRemaining = 1;

    await expect(controller.start('calibration')).rejects.toThrow('start failed');
    expect(provider.listenerCount).toBe(0);

    // Retry: this time the provider succeeds.
    await controller.start('calibration');
    expect(provider.listenerCount).toBe(1);

    // Drive a full calibration + one timed lap. If the F1 bug were present,
    // the leaked first (never-unsubscribed) subscription would receive
    // every sample a SECOND time, doubling matched+rejected sample counts
    // relative to what was actually fed.
    const calibrationSamples = cleanRecognitionLap(profile, 990);
    feed(calibrationSamples);
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    const drivingSamples = driveLap(profile, { seed: 991, speedMps: 40, noiseSigmaM: 1 });
    feed(drivingSamples);
    await controller.flush();

    expect(provider.listenerCount).toBe(1);
    const diag = controller.diagnostics();
    // Exactly the fed sample count, not double it -- a duplicate listener
    // would push this to 2x the driving-sample count (calibration samples
    // don't reach `core.ingest`, only live-mode ones do).
    expect(diag.matchedSampleCount + diag.rejectedSampleCount).toBe(drivingSamples.length);
  });

  // -------------------------------------------------------------------
  // F2 residue -- dispose() must detach the sample listener/watchdog even
  // when the provider's stop() rejects.
  // -------------------------------------------------------------------

  it('dispose() detaches the sample listener and clears watchdog/listeners even when locationProvider.stop() rejects (F2 fix)', async () => {
    const { profile, controller, provider, clock, scheduler, restartCalls, states, feed } = setup();
    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 992));
    const emissionsBeforeDispose = states.length;

    provider.stopShouldReject = true;
    await expect(controller.dispose()).rejects.toThrow('stop failed');

    // Detachment happened anyway: no further emissions reach this
    // (disposed) controller, even though stop() rejected.
    provider.push(sampleAtLapDistance(profile, 500, clock.now(), { lateralOffsetM: 0, accuracyM: 3 }));
    expect(states.length).toBe(emissionsBeforeDispose);

    clock.advance(10_000);
    scheduler.tick();
    expect(restartCalls).toHaveLength(0);
    expect(states.length).toBe(emissionsBeforeDispose);
  });

  it('checkpointNow() propagates a repository failure as a real rejection -- never a synchronous throw, never silently swallowed (C8 fix)', async () => {
    const inner = new InMemorySessionRepository();
    const controllable = new ControllableRepository(inner);
    controllable.saveCheckpoint = async () => {
      throw new Error('disk full');
    };
    const { profile, controller, feed } = setup(controllable);
    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 970));

    let threwSynchronously = false;
    let promise: Promise<void> | undefined;
    try {
      promise = controller.checkpointNow();
    } catch {
      threwSynchronously = true;
    }
    // Calling it always yields a Promise (async-function semantics) -- this
    // is what lets a caller safely attach `.catch()` instead of needing a
    // try/catch around the call site itself.
    expect(threwSynchronously).toBe(false);
    // Rejects (not resolved, not hung): if this rejection were ever left
    // unconsumed anywhere inside the controller instead of surfacing here,
    // vitest's own unhandled-rejection detection would fail this suite.
    await expect(promise!).rejects.toThrow('disk full');
  });
});

// ---------------------------------------------------------------------------
// Phase 3 coaching addendum (docs/architecture/contracts.md's "Coaching
// addendum"). `setup()`'s optional `coaching` argument wires `CoachEngine`
// into the SAME controller instance every other test in this file already
// exercises against the real TMR profile/matcher/timing pipeline -- these
// tests only add the coaching-specific assertions on top.
// ---------------------------------------------------------------------------

describe('SessionController coaching (Phase 3 addendum)', () => {
  function coachingCorners(): Corner[] {
    const { runtime } = tmr();
    return analyzeCorners(runtime);
  }

  it('emits at least one BRAKE cue with a plausible distanceToTargetM while driving, and the cue clears again after the corner (lap rollover)', async () => {
    const { profile, controller, states, feed } = setup(undefined, {
      enabled: true,
      corners: coachingCorners(),
    });

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 801));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    // Same speed profile shape as the coaching replay integration test
    // (test/coach/coach.replay.test.ts) -- proven to produce >=8 cues per
    // lap on this exact TMR geometry.
    feed(
      driveLap(profile, {
        seed: 801,
        lapCount: 1,
        sampleRateHz: 2,
        noiseSigmaM: 0,
        accuracyM: 3,
        speedMps: ({ progress }) => 32 + 10 * Math.sin(progress * Math.PI * 2) ** 2,
      }),
    );
    await controller.flush();

    const brakeCueStates = states.filter((s) => s.coachCue?.kind === 'BRAKE');
    expect(brakeCueStates.length).toBeGreaterThan(0);
    for (const state of brakeCueStates) {
      const cue = state.coachCue!;
      expect(cue.distanceToTargetM).toBeGreaterThanOrEqual(0);
      // leadM = max(80, leadSeconds*speed); speeds here stay well under 45
      // m/s, so 300 m is a generous, still-meaningful upper bound -- proves
      // the cue is a genuine near-term advisory, not an arbitrary value.
      expect(cue.distanceToTargetM).toBeLessThan(300);
      expect(cue.confidence).toBeGreaterThanOrEqual(0.4);
      expect(['left', 'right']).toContain(cue.direction);
    }

    // The lap completes (forward S/F crossing) well before the fixture's
    // trailing samples run out -- MUST DO #1's "lap rollover" clear must have
    // fired by the very last observed state.
    expect(states[states.length - 1]!.coachCue).toBeNull();
  });

  it('emits no coaching cues at all when coaching is disabled', async () => {
    const { profile, controller, states, feed } = setup(undefined, {
      enabled: false,
      corners: coachingCorners(),
    });

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 802));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    feed(
      driveLap(profile, {
        seed: 802,
        lapCount: 1,
        sampleRateHz: 2,
        noiseSigmaM: 0,
        accuracyM: 3,
        speedMps: ({ progress }) => 32 + 10 * Math.sin(progress * Math.PI * 2) ** 2,
      }),
    );
    await controller.flush();

    expect(states.every((s) => s.coachCue === null)).toBe(true);
    expect(controller.diagnostics().coachZoneRefreshes).toBe(0);
  });

  it('regenerates braking zones from the new PB reference each time one lands mid-session, counted by diagnostics().coachZoneRefreshes', async () => {
    const { profile, controller, feed } = setup(undefined, {
      enabled: true,
      corners: coachingCorners(),
    });

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 803));
    controller.acceptCalibration();
    await controller.flush();
    // Configured once (physics-only fallback, no PB yet) when the reference
    // is first loaded for this session -- that initial configure is not
    // itself counted as a "refresh" (it happens before any PB has landed).
    expect(controller.diagnostics().coachZoneRefreshes).toBe(0);

    controller.arm();
    // Three successively faster laps (36/41/48 m/s) -- every lap replaces the
    // PB (matches this file's own top-of-suite assertion on the same
    // fixture), so each one is a genuine mid-session zone refresh.
    feed(pbImprovementSession(profile, 803));
    await controller.flush();

    expect(controller.diagnostics().coachZoneRefreshes).toBe(3);
  });
});
