import { describe, expect, it } from 'vitest';
import type { LocationProvider, LocationSample } from '@circuit/core';
import { InMemorySessionRepository, SessionController, cleanRecognitionLap, driveLap, pbImprovementSession } from '@circuit/core';
import { RealSessionFacade } from '../../src/session/realFacade';
import type { FacadeState } from '../../src/session/facade';
import { TMR_CIRCUIT_PROFILE, TMR_CORNERS, TMR_RUNTIME_PROFILE } from '../../src/session/tmrProfile';
import { FakeClock, FakeLocationProvider, feedSamples } from '../support/coreTestDoubles';

/** A `LocationProvider` whose `start()` rejects for its first `failCount` calls, then behaves like `FakeLocationProvider` -- lets a test drive both "command fails" and "a later command succeeds and clears the error" from the SAME facade/controller instance (C7 fix). */
class FlakyStartLocationProvider implements LocationProvider {
  private readonly listeners = new Set<(s: LocationSample) => void>();
  startCount = 0;

  constructor(private failCount: number) {}

  async start(): Promise<void> {
    this.startCount += 1;
    if (this.startCount <= this.failCount) {
      throw new Error('GNSS start failed (test double)');
    }
  }
  async stop(): Promise<void> {}
  subscribe(cb: (s: LocationSample) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  push(sample: LocationSample): void {
    for (const listener of this.listeners) listener(sample);
  }
}

/** A microtask-flush barrier for RealSessionFacade's fire-and-forget `.then()` chains (`beginCalibration`/`endSession`), which -- unlike `SessionController` itself -- expose no awaitable promise. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setup() {
  const repository = new InMemorySessionRepository();
  const provider = new FakeLocationProvider();
  const clock = new FakeClock(1_000_000);
  const controller = new SessionController({
    runtimeProfile: TMR_RUNTIME_PROFILE,
    circuitProfile: TMR_CIRCUIT_PROFILE,
    locationProvider: provider,
    clock,
    repository,
    userId: 'driver-1',
    appVersion: 'apps-mobile-test',
    algorithmVersion: 1,
    restartProvider: () => {},
  });
  return { repository, provider, clock, controller };
}

describe('RealSessionFacade', () => {
  it('commands issued before any session has started are safe no-ops (no throw)', () => {
    const { controller } = setup();
    const facade = new RealSessionFacade(controller);
    expect(() => {
      facade.startPreflight();
      facade.acceptCalibration();
      facade.rejectCalibration();
      facade.arm();
      facade.pause();
      facade.resume();
      facade.endSession();
    }).not.toThrow();
  });

  it('drives calibration -> accept -> arm -> 3 laps against the real TMR profile, mapping FacadeState transitions, speedKph, lastLapMs, pbMs, and persisting on endSession', async () => {
    const { repository, provider, clock, controller } = setup();
    const events: FacadeState[] = [];
    const startedSessionIds: string[] = [];
    let endedFired = false;

    const facade = new RealSessionFacade(controller, {
      onSessionStarted: (id) => startedSessionIds.push(id),
      onSessionEnded: () => {
        endedFired = true;
      },
    });
    facade.subscribe((s) => events.push(s));

    // Initial synchronous emission from subscribe().
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionState).toBe('idle');

    facade.beginCalibration();
    await flush();
    expect(events.at(-1)!.sessionState).toBe('calibrating');
    expect(startedSessionIds).toHaveLength(1);

    feedSamples(clock, provider, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 501));
    expect(events.at(-1)!.sessionState).toBe('calibrationReview');
    expect(events.at(-1)!.calibrationResult?.accepted).toBe(true);

    facade.acceptCalibration();
    await controller.flush();
    expect(events.at(-1)!.sessionState).toBe('armed');

    facade.arm();

    feedSamples(clock, provider, pbImprovementSession(TMR_CIRCUIT_PROFILE, 502));
    await controller.flush();

    const finalDrivingState = events.at(-1)!;
    expect(finalDrivingState.laps).toHaveLength(3);
    expect(finalDrivingState.lastLapMs).not.toBeNull();
    expect(finalDrivingState.lastLapMs).toBe(finalDrivingState.laps.at(-1)!.durationMs);
    expect(finalDrivingState.pbMs).not.toBeNull();
    // pbImprovementSession's laps get progressively faster and the controller replaces the PB
    // immediately after each lap (not deferred to session end) -- the facade's pbMs must reflect
    // the fastest lap driven, which is also the last one here.
    expect(finalDrivingState.pbMs).toBe(finalDrivingState.laps.at(-1)!.durationMs);
    expect(finalDrivingState.pbMs).toBeLessThan(finalDrivingState.laps[0]!.durationMs);
    expect(finalDrivingState.speedKph).not.toBeNull();
    expect(finalDrivingState.speedKph).toBeGreaterThan(0);

    facade.endSession();
    await flush();
    expect(endedFired).toBe(true);
    expect(events.at(-1)!.sessionState).toBe('sessionComplete');

    const sessions = await repository.listSessions('driver-1', TMR_CIRCUIT_PROFILE.circuitId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe(startedSessionIds[0]);
    expect(sessions[0]!.laps).toHaveLength(3);
  });

  // -------------------------------------------------------------------
  // Phase 3 coaching addendum -- `FacadeState.coachCue` is a 1:1 map of
  // `FacadeStateCore.coachCue` (`mapState` in realFacade.ts); this proves
  // that mapping actually happens end-to-end against the real TMR corner set
  // composition.ts builds (`TMR_CORNERS`), not just that the field exists.
  // -------------------------------------------------------------------

  it('maps coachCue through from the controller when coaching is enabled, and never surfaces one when it is disabled', async () => {
    const repository = new InMemorySessionRepository();
    const provider = new FakeLocationProvider();
    const clock = new FakeClock(1_000_000);
    const controller = new SessionController({
      runtimeProfile: TMR_RUNTIME_PROFILE,
      circuitProfile: TMR_CIRCUIT_PROFILE,
      locationProvider: provider,
      clock,
      repository,
      userId: 'driver-1',
      appVersion: 'apps-mobile-test',
      algorithmVersion: 1,
      restartProvider: () => {},
      coaching: { enabled: true, corners: TMR_CORNERS },
    });
    const facade = new RealSessionFacade(controller);
    const events: FacadeState[] = [];
    facade.subscribe((s) => events.push(s));

    facade.beginCalibration();
    await flush();
    feedSamples(clock, provider, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 601));
    facade.acceptCalibration();
    await controller.flush();
    facade.arm();

    feedSamples(
      clock,
      provider,
      driveLap(TMR_CIRCUIT_PROFILE, {
        seed: 601,
        lapCount: 1,
        sampleRateHz: 2,
        noiseSigmaM: 0,
        accuracyM: 3,
        speedMps: ({ progress }) => 32 + 10 * Math.sin(progress * Math.PI * 2) ** 2,
      }),
    );
    await controller.flush();

    const brakeCueEvents = events.filter((s) => s.coachCue?.kind === 'BRAKE');
    expect(brakeCueEvents.length).toBeGreaterThan(0);
    expect(brakeCueEvents[0]!.coachCue!.distanceToTargetM).toBeGreaterThanOrEqual(0);
  });

  it('never surfaces a coachCue through the facade when coaching is disabled', async () => {
    const repository = new InMemorySessionRepository();
    const provider = new FakeLocationProvider();
    const clock = new FakeClock(1_000_000);
    const controller = new SessionController({
      runtimeProfile: TMR_RUNTIME_PROFILE,
      circuitProfile: TMR_CIRCUIT_PROFILE,
      locationProvider: provider,
      clock,
      repository,
      userId: 'driver-1',
      appVersion: 'apps-mobile-test',
      algorithmVersion: 1,
      restartProvider: () => {},
      coaching: { enabled: false, corners: TMR_CORNERS },
    });
    const facade = new RealSessionFacade(controller);
    const events: FacadeState[] = [];
    facade.subscribe((s) => events.push(s));

    facade.beginCalibration();
    await flush();
    feedSamples(clock, provider, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 602));
    facade.acceptCalibration();
    await controller.flush();
    facade.arm();

    feedSamples(
      clock,
      provider,
      driveLap(TMR_CIRCUIT_PROFILE, {
        seed: 602,
        lapCount: 1,
        sampleRateHz: 2,
        noiseSigmaM: 0,
        accuracyM: 3,
        speedMps: ({ progress }) => 32 + 10 * Math.sin(progress * Math.PI * 2) ** 2,
      }),
    );
    await controller.flush();

    expect(events.every((s) => s.coachCue === null)).toBe(true);
  });

  it('subscribe() replays the latest state to a new listener and unsubscribe stops further delivery', async () => {
    const { provider, clock, controller } = setup();
    const facade = new RealSessionFacade(controller);

    facade.beginCalibration();
    await flush();
    feedSamples(clock, provider, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 511));

    const late: FacadeState[] = [];
    const unsubscribe = facade.subscribe((s) => late.push(s));
    expect(late).toHaveLength(1);
    expect(late[0]!.sessionState).toBe('calibrationReview');

    unsubscribe();
    facade.acceptCalibration();
    await controller.flush();
    expect(late).toHaveLength(1); // no further delivery after unsubscribe
  });

  // -------------------------------------------------------------------
  // C7 -- silent async command failures. A failed async command body
  // (`beginCalibration`/`endSession`) must surface as `FacadeState.lastError`
  // instead of becoming an unhandled rejection with no visible effect.
  // -------------------------------------------------------------------

  it('a failing provider start surfaces as FacadeState.lastError (observable through the same facade subscription a screen uses), and a later successful retry clears it (C7 fix)', async () => {
    const repository = new InMemorySessionRepository();
    const provider = new FlakyStartLocationProvider(1); // first start() fails, subsequent ones succeed.
    const clock = new FakeClock(1_000_000);
    const controller = new SessionController({
      runtimeProfile: TMR_RUNTIME_PROFILE,
      circuitProfile: TMR_CIRCUIT_PROFILE,
      locationProvider: provider,
      clock,
      repository,
      userId: 'driver-1',
      appVersion: 'apps-mobile-test',
      algorithmVersion: 1,
      restartProvider: () => {},
    });
    const facade = new RealSessionFacade(controller);
    const events: FacadeState[] = [];
    facade.subscribe((s) => events.push(s));

    expect(events.at(-1)!.lastError).toBeNull();

    facade.beginCalibration();
    await flush();

    expect(events.at(-1)!.lastError).not.toBeNull();
    expect(events.at(-1)!.lastError).toContain('beginCalibration');
    // The command genuinely failed -- the controller must NOT have silently
    // ended up mid-calibration with no visible error.
    expect(events.at(-1)!.sessionState).toBe('idle');

    // Retry: the provider succeeds this time.
    facade.beginCalibration();
    await flush();

    expect(events.at(-1)!.lastError).toBeNull();
    expect(events.at(-1)!.sessionState).toBe('calibrating');
  });

  it('dispose() detaches from the controller so no further emissions reach this facade (C6 fix)', async () => {
    const { controller } = setup();
    const facade = new RealSessionFacade(controller);
    const events: FacadeState[] = [];
    facade.subscribe((s) => events.push(s));
    const emissionsBeforeDispose = events.length;

    facade.dispose();
    // Idempotent.
    expect(() => facade.dispose()).not.toThrow();

    facade.beginCalibration();
    await flush();
    expect(events.length).toBe(emissionsBeforeDispose); // no further delivery -- dispose() unsubscribed from the controller.
  });
});
