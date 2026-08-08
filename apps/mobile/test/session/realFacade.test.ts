import { describe, expect, it } from 'vitest';
import { InMemorySessionRepository, SessionController, cleanRecognitionLap, pbImprovementSession } from '@circuit/core';
import { RealSessionFacade } from '../../src/session/realFacade';
import type { FacadeState } from '../../src/session/facade';
import { TMR_CIRCUIT_PROFILE, TMR_RUNTIME_PROFILE } from '../../src/session/tmrProfile';
import { FakeClock, FakeLocationProvider, feedSamples } from '../support/coreTestDoubles';

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
});
