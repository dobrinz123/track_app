import { describe, expect, it } from 'vitest';

import type { LocationProvider, LocationSample } from '../../src/contracts';
import { SessionController, type WatchdogScheduler } from '../../src/controller';
import { InMemorySessionRepository } from '../../src/persistence';

import { FakeClock, tmr } from './testSupport';

/**
 * P4h-FIX1 M2 (after Codex P4h-REV1 MEDIUM, `ActiveCalibrationScreen.tsx:91-100,255-261`;
 * `CalibrationInstructionsScreen.tsx:48-51`; `sessionController.ts:431-492,523-537`):
 * "cancellation can race the locked asynchronous calibration start. The UI
 * navigates to ActiveCalibration immediately, while `beginCalibration()` may
 * still be awaiting GNSS startup and the controller still reports idle.
 * Cancel then calls `rejectCalibration()`, which is a no-op in idle; the
 * sticky button nevertheless replaces the screen. Startup can subsequently
 * finish, leaving an invisible calibrating session/watchdog/provider running."
 *
 * Binding fix (ticket P4h-FIX1): `rejectCalibration()` cancels an IN-FLIGHT
 * `start('calibration')` -- the startup finishes, tears itself down, and ends
 * idle with no orphan watchdog, no session id, and no sample subscription.
 */

/** A `LocationProvider` whose `start()` parks until the test releases it -- the exact window Cancel has to be able to interrupt (mirrors `sessionControllerDisposeDuringStart.test.ts`'s own gate). */
class GatedLocationProvider implements LocationProvider {
  private readonly listeners = new Set<(s: LocationSample) => void>();
  startCount = 0;
  stopCount = 0;
  subscribeCount = 0;
  running = false;
  private pendingStarts: Array<() => void> = [];
  private gateOpen = false;

  async start(): Promise<void> {
    this.startCount += 1;
    if (!this.gateOpen) {
      await new Promise<void>((resolve) => {
        this.pendingStarts.push(resolve);
      });
    }
    this.running = true;
  }

  release(): void {
    this.gateOpen = true;
    const pending = this.pendingStarts;
    this.pendingStarts = [];
    for (const resolve of pending) resolve();
  }

  emit(sample: LocationSample): void {
    for (const listener of [...this.listeners]) listener(sample);
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.running = false;
  }

  subscribe(cb: (s: LocationSample) => void): () => void {
    this.subscribeCount += 1;
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** Counts watchdog registrations -- a cancelled start must never leave one running. */
class CountingScheduler implements WatchdogScheduler {
  setIntervalCalls = 0;
  clearIntervalCalls = 0;
  setInterval(): unknown {
    this.setIntervalCalls += 1;
    return 1;
  }
  clearInterval(): void {
    this.clearIntervalCalls += 1;
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function build(provider: GatedLocationProvider, scheduler: CountingScheduler): SessionController {
  const { profile, runtime } = tmr();
  return new SessionController({
    runtimeProfile: runtime,
    circuitProfile: profile,
    locationProvider: provider,
    clock: new FakeClock(1_000_000),
    repository: new InMemorySessionRepository(),
    userId: 'local-driver',
    appVersion: 'test',
    algorithmVersion: 1,
    restartProvider: () => {},
    config: { scheduler },
  });
}

describe('SessionController: cancel during an in-flight calibration start (P4h-FIX1 M2)', () => {
  it('rejectCalibration() while start() is parked in provider.start(): the start unwinds, the controller ends idle, no watchdog, no session id, no subscription', async () => {
    const provider = new GatedLocationProvider();
    const scheduler = new CountingScheduler();
    const controller = build(provider, scheduler);

    let state = '';
    const unsubscribe = controller.subscribe((s) => {
      state = s.sessionState;
    });

    const starting = controller.start('calibration');
    await tick();
    expect(provider.startCount).toBe(1);
    expect(state).toBe('idle'); // the controller still reports idle for this whole window -- the review's exact hole.

    // The driver taps Cancel on ActiveCalibration while startup is still in flight.
    controller.rejectCalibration();

    provider.release();
    await starting;
    await tick();

    expect(state).toBe('idle');
    expect(controller.diagnostics().sessionId).toBeNull();
    expect(scheduler.setIntervalCalls).toBe(0); // no orphan watchdog.
    expect(provider.listenerCount).toBe(0); // no orphan sample subscription.
    expect(provider.subscribeCount).toBe(0);
    unsubscribe();
    await controller.dispose();
  });

  it('a cancelled start leaves no calibrating session behind: samples fed afterwards change nothing', async () => {
    const provider = new GatedLocationProvider();
    const scheduler = new CountingScheduler();
    const controller = build(provider, scheduler);

    let state = '';
    const unsubscribe = controller.subscribe((s) => {
      state = s.sessionState;
    });

    const starting = controller.start('calibration');
    await tick();
    controller.rejectCalibration();
    provider.release();
    await starting;
    await tick();

    provider.emit({ tMono: 1_000, lat: 45.65, lon: 25.6, accuracyM: 5, source: 'gnss' });
    await tick();
    expect(state).toBe('idle');

    unsubscribe();
    await controller.dispose();
  });

  it('the cancel is ONE-SHOT: a later, uncancelled start still enters calibration normally', async () => {
    const provider = new GatedLocationProvider();
    const scheduler = new CountingScheduler();
    const controller = build(provider, scheduler);

    let state = '';
    const unsubscribe = controller.subscribe((s) => {
      state = s.sessionState;
    });

    const cancelled = controller.start('calibration');
    await tick();
    controller.rejectCalibration();
    provider.release();
    await cancelled;
    await tick();
    expect(state).toBe('idle');

    await controller.start('calibration');
    await tick();

    expect(state).toBe('calibrating');
    expect(controller.diagnostics().sessionId).not.toBeNull();
    expect(provider.listenerCount).toBe(1);
    unsubscribe();
    await controller.dispose();
  });
});
