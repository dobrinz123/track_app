import { describe, expect, it } from 'vitest';

import type { LocationProvider, LocationSample } from '../../src/contracts';
import { SessionController, type WatchdogScheduler } from '../../src/controller';
import { cleanRecognitionLap } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';

import { FakeClock, tmr } from './testSupport';

/**
 * contracts.md's "Multi-circuit selection — facade boundary amendment"
 * (binding, ticket CN-FIX4, item B): `start()` re-checks `disposed` after
 * every await and aborts WITHOUT subscribing to the provider, entering a
 * session, or persisting anything.
 *
 * The hole this pins: `start()` awaits `locationProvider.start()`, and the
 * controller reports `idle` for that whole window. A composition-level
 * rebuild (circuit change, coaching toggle, delete-all) can therefore
 * `dispose()` the controller mid-await; before this fix the awaited start
 * then resumed, installed a sample subscription on the SHARED provider that
 * `dispose()` had just detached, moved the disposed controller into
 * calibration, and persisted a session pointer for it.
 */

/** A `LocationProvider` whose `start()` parks until the test releases it -- the exact window `dispose()` has to be able to interrupt. */
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

  /** Releases every parked `start()` and lets later ones resolve immediately -- models the real provider's serialized start queue. */
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

/** Counts watchdog registrations -- a controller that never really started must never have started its watchdog. */
class CountingScheduler implements WatchdogScheduler {
  setIntervalCalls = 0;
  setInterval(): unknown {
    this.setIntervalCalls += 1;
    return 1;
  }
  clearInterval(): void {}
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SessionController.start() aborts when disposed mid-start (ticket CN-FIX4, facade boundary amendment)', () => {
  it('dispose() during the provider-start await: no subscription, no session state change, nothing persisted', async () => {
    const { profile, runtime } = tmr();
    const repository = new InMemorySessionRepository();
    const provider = new GatedLocationProvider();
    const scheduler = new CountingScheduler();

    const saveCheckpointCalls: string[] = [];
    const originalSaveCheckpoint = repository.saveCheckpoint.bind(repository);
    repository.saveCheckpoint = async (sessionId, snapshot, laps) => {
      saveCheckpointCalls.push(sessionId);
      return originalSaveCheckpoint(sessionId, snapshot, laps);
    };

    const controller = new SessionController({
      runtimeProfile: runtime,
      circuitProfile: profile,
      locationProvider: provider,
      clock: new FakeClock(1_000_000),
      repository,
      userId: 'local-driver',
      appVersion: 'test',
      algorithmVersion: 1,
      restartProvider: () => {},
      config: { scheduler },
    });

    let state = '';
    const unsubscribe = controller.subscribe((s) => {
      state = s.sessionState;
    });
    expect(state).toBe('idle');

    // start() parks inside provider.start()...
    const starting = controller.start('calibration');
    await tick();
    expect(provider.startCount).toBe(1);
    expect(provider.listenerCount).toBe(0);

    // ...and the controller is disposed while it is parked.
    await controller.dispose();
    provider.release();
    await starting;
    await tick();

    // No subscription was installed on the (shared) provider: the disposed
    // controller can never ingest another sample.
    expect(provider.listenerCount).toBe(0);
    expect(provider.subscribeCount).toBe(0);
    // CN-FIX5 item 2 (contracts.md's closing amendment, binding): the
    // aborted start does NOT stop the provider. Ownership of a SHARED
    // provider is not knowable in core -- a replacement controller may
    // already have started it -- so stopping here would pull the native
    // watcher out from under whoever legitimately owns it now. The provider
    // is stopped by the controller that ends its own session (or by
    // `dispose()` when that controller genuinely had it running).
    expect(provider.stopCount).toBe(0);
    expect(provider.running).toBe(true);
    // No session was begun: no state change, no session id, no watchdog.
    expect(controller.diagnostics().sessionId).toBeNull();
    expect(scheduler.setIntervalCalls).toBe(0);
    // And nothing was persisted for a session that never really started.
    expect(saveCheckpointCalls).toEqual([]);
    unsubscribe();
  });

  it('two controllers sharing ONE provider: A disposed mid-start never stops the provider B has taken over -- B keeps receiving samples (ticket CN-FIX5)', async () => {
    const { profile, runtime } = tmr();
    const provider = new GatedLocationProvider();
    const deps = {
      runtimeProfile: runtime,
      circuitProfile: profile,
      locationProvider: provider,
      clock: new FakeClock(1_000_000),
      repository: new InMemorySessionRepository(),
      userId: 'local-driver',
      appVersion: 'test',
      algorithmVersion: 1,
      restartProvider: () => {},
      config: { scheduler: new CountingScheduler() },
    };
    const a = new SessionController(deps);
    const b = new SessionController(deps);

    // A parks inside the shared provider's start...
    const startingA = a.start('calibration');
    await tick();
    // ...is disposed, and B (its replacement) starts on the SAME provider.
    await a.dispose();
    const startingB = b.start('calibration');
    await tick();

    provider.release();
    await Promise.all([startingA, startingB]);
    await tick();

    // Before CN-FIX5, A's disposed continuation called `provider.stop()`,
    // which -- on the real serialized GNSS provider -- ran AFTER B's start
    // and tore down the native watcher B depends on.
    expect(provider.stopCount).toBe(0);
    expect(provider.running).toBe(true);
    // Exactly one live subscription: B's.
    expect(provider.listenerCount).toBe(1);

    let bState = '';
    const unsubscribe = b.subscribe((s) => {
      bState = s.sessionState;
    });
    expect(bState).toBe('calibrating');
    expect(b.diagnostics().sessionId).not.toBeNull();
    expect(a.diagnostics().sessionId).toBeNull();

    // And B genuinely ingests samples from the shared provider: a full Learn
    // lap drives it all the way to an accepted calibration result.
    for (const sample of cleanRecognitionLap(profile, 500_001)) provider.emit(sample);
    await tick();
    expect(bState).toBe('calibrationReview');

    unsubscribe();
    await b.dispose();
  });

  it('a normal (undisposed) start still subscribes, enters calibration, and keeps its session id', async () => {
    const { profile, runtime } = tmr();
    const provider = new GatedLocationProvider();
    const controller = new SessionController({
      runtimeProfile: runtime,
      circuitProfile: profile,
      locationProvider: provider,
      clock: new FakeClock(1_000_000),
      repository: new InMemorySessionRepository(),
      userId: 'local-driver',
      appVersion: 'test',
      algorithmVersion: 1,
      restartProvider: () => {},
      config: { scheduler: new CountingScheduler() },
    });

    let state = '';
    const unsubscribe = controller.subscribe((s) => {
      state = s.sessionState;
    });

    const starting = controller.start('calibration');
    await tick();
    provider.release();
    await starting;

    expect(provider.listenerCount).toBe(1);
    expect(state).toBe('calibrating');
    expect(controller.diagnostics().sessionId).not.toBeNull();
    unsubscribe();
    await controller.dispose();
  });
});
