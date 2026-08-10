import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SqlSessionRepository,
  cleanRecognitionLap,
  multiLapSession,
  type LocationSample,
  type TelemetrySample,
} from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';

/**
 * M2 fix (Codex cross-review finding, `.foreman/scratch/p4b-verify-out.log`):
 * `telemetryShutdown` (composition.ts) was previously cleared ONLY by
 * `startTelemetryRecording()` -- but DevReplay/mock facades never call it (it
 * is wired exclusively into `productionFacadeCallbacks().onSessionStarted`).
 * A settled `telemetryShutdown` left over from an earlier PRODUCTION session
 * therefore stayed sitting in module state across a swap into DevReplay, and
 * `stopTelemetryRecording()`'s `telemetryRecorder === null && telemetryShutdown
 * !== null` reuse branch (F2 fix) handed that STALE promise right back out
 * when the replay's OWN `endSession()` fired -- `facadeWrapper`'s
 * `sessionCompleteBarrier` getter then saw a non-null barrier and created a
 * real `setTimeout` for it, even though the replay never ran telemetry at
 * all (violating the binding "zero added latency, no timer" never-ran
 * guarantee).
 *
 * This test reuses the SAME `bootFresh()` two-part harness
 * `composition.telemetryRecording.test.ts` (a fully test-controlled
 * `telemetryProvider` double, driven by `feedTelemetry()`) and
 * `composition.lifecycle.test.ts` (tracked GNSS + replay `LocationProvider`
 * stubs, driven by `feed()`) each already establish -- both are needed here:
 * telemetry recording to leave a genuinely SETTLED stale `telemetryShutdown`
 * behind, and a full DevReplay session to prove the barrier's `setTimeout`
 * behavior on the OTHER side of the swap.
 */

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
}));

const tracked = vi.hoisted(() => ({
  gnssProviders: [] as StubLocationProviderInstance[],
  replayProviders: [] as StubLocationProviderInstance[],
}));

interface StubLocationProviderInstance {
  push(sample: LocationSample): void;
}

const telemetryDouble = vi.hoisted(() => ({
  sampleListeners: new Set<(s: unknown) => void>(),
  stateListeners: new Set<(s: string, d?: string) => void>(),
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'telemetry-shutdown-reset-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubLocationProviderBase {
    listeners = new Set<(s: LocationSample) => void>();
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    subscribe(cb: (s: LocationSample) => void): () => void {
      this.listeners.add(cb);
      return () => {
        this.listeners.delete(cb);
      };
    }
    push(sample: LocationSample): void {
      for (const listener of [...this.listeners]) listener(sample);
    }
    getDiagnostics(): unknown {
      return {
        samplesEmitted: 0,
        samplesRejectedMocked: 0,
        sampleIntervalHistogramMs: [],
        accuracyDistributionM: { sampleCount: 0, minM: null, p50M: null, p95M: null },
        reducedAccuracy: false,
      };
    }
  }
  class StubGnssLocationProvider extends StubLocationProviderBase {
    constructor() {
      super();
      tracked.gnssProviders.push(this);
    }
  }
  class StubReplayLocationProvider extends StubLocationProviderBase {
    constructor(_samples: unknown, _options: unknown) {
      super();
      tracked.replayProviders.push(this);
    }
  }
  class StubClock {
    now(): number {
      return Date.now();
    }
  }
  return {
    GnssLocationProvider: StubGnssLocationProvider,
    PerformanceNowClock: StubClock,
    ReplayLocationProvider: StubReplayLocationProvider,
    startLifecycleListener: () => {},
  };
});

vi.mock('../../src/persistence/expoSqlDatabase', () => ({
  openAppDatabase: async () => ({ db: seeded.db, repository: seeded.repository }),
}));

/** Fully test-controlled `TelemetryProvider` double, same shape `composition.telemetryRecording.test.ts` uses -- `feedTelemetry()` drives its `onSample` listeners directly. */
vi.mock('../../src/session/telemetryProvider', () => ({
  createTelemetryProvider: () => ({
    start: () => {},
    stop: async () => {},
    onSample: (cb: (s: unknown) => void) => {
      telemetryDouble.sampleListeners.add(cb);
      return () => telemetryDouble.sampleListeners.delete(cb);
    },
    onStateChange: (cb: (s: string, d?: string) => void) => {
      telemetryDouble.stateListeners.add(cb);
      cb('idle');
      return () => telemetryDouble.stateListeners.delete(cb);
    },
    getDiagnostics: () => ({ state: 'idle', observedHzByChannel: {}, errorCount: 0, retriesUsed: 0 }),
  }),
}));

import { TMR_CIRCUIT_PROFILE } from '../../src/session/tmrProfile';

function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function feed(provider: StubLocationProviderInstance, samples: readonly LocationSample[]): void {
  for (const sample of samples) provider.push(sample);
}

function feedTelemetry(sample: TelemetrySample): void {
  for (const cb of [...telemetryDouble.sampleListeners]) cb(sample);
}

async function bootFresh(): Promise<typeof import('../../src/session/composition')> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  await migrateTelemetrySchema(db);
  seeded.db = db;
  seeded.repository = repository;
  tracked.gnssProviders.length = 0;
  tracked.replayProviders.length = 0;
  telemetryDouble.sampleListeners.clear();
  telemetryDouble.stateListeners.clear();

  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

function latestFacadeState(composition: Awaited<ReturnType<typeof bootFresh>>): unknown {
  let latest: unknown;
  const unsubscribe = composition.facade.subscribe((s) => {
    latest = s;
  });
  unsubscribe();
  return latest;
}

describe('composition.ts telemetryShutdown reset at facade swap-in (M2 fix)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a settled telemetryShutdown left by a prior PRODUCTION session is cleared when a DevReplay facade is installed -- the replay session then completes on the synchronous, timer-free barrier path', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ telemetryEnabled: true });

    // ---- Production session: actually records telemetry, so `endSession()`
    //      leaves a genuinely SETTLED (not merely non-null) `telemetryShutdown`
    //      promise sitting in composition.ts's module state. ----
    composition.facade.startPreflight();
    await flushBootstrap();
    composition.facade.beginCalibration();
    await flushBootstrap();
    feedTelemetry({ channel: 'rpm', value: 900, tMonoMs: 1 });
    feed(tracked.gnssProviders[0]!, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 820_001));
    await flushBootstrap();
    composition.facade.acceptCalibration();
    await flushBootstrap();
    composition.facade.arm();
    feed(tracked.gnssProviders[0]!, multiLapSession(TMR_CIRCUIT_PROFILE, 1, 820_002));
    await flushBootstrap();
    composition.facade.endSession();
    await flushBootstrap();
    await flushBootstrap();

    const afterProduction = latestFacadeState(composition) as { sessionState: string };
    expect(afterProduction.sessionState).toBe('sessionComplete'); // sanity: the barrier itself worked and let it through.

    // ---- DevReplay swap-in: never runs telemetry (no onSessionStarted hook
    //      wires `startTelemetryRecording()` for it) -- the M2 fix must clear
    //      the stale promise HERE, at swap-in, not rely on a start hook that
    //      doesn't exist for this facade. ----
    await composition.startDevReplaySession(cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 820_003));
    const replay = tracked.replayProviders[0]!;

    composition.facade.beginCalibration();
    await flushBootstrap();
    feed(replay, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 820_003));
    await flushBootstrap();
    composition.facade.acceptCalibration();
    await flushBootstrap();
    composition.facade.arm();
    feed(replay, multiLapSession(TMR_CIRCUIT_PROFILE, 1, 820_004));
    await flushBootstrap();

    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    composition.facade.endSession();
    await flushBootstrap();

    const afterReplay = latestFacadeState(composition) as { sessionState: string };
    expect(afterReplay.sessionState).toBe('sessionComplete');

    // The 2000ms session-complete barrier timer must NEVER have been created
    // for this replay's own sessionComplete relay -- proves the barrier read
    // `telemetryShutdown === null` (the genuine "nothing to wait for" /
    // timer-free path), not the stale settled promise left by the earlier
    // production session (which, pre-fix, still creates a timer even though
    // it happens to already be settled -- `relaySessionCompleteBarrier`
    // unconditionally calls `setTimeout` whenever `getBarrier()` returns
    // non-null).
    const barrierTimerCalls = timeoutSpy.mock.calls.filter(([, delay]) => delay === 2_000);
    expect(barrierTimerCalls).toHaveLength(0);

    timeoutSpy.mockRestore();
  });
});
