import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, cleanRecognitionLap, multiLapSession, type LocationSample } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';

/**
 * P4h-FIX1 H6 (after Codex P4h-REV1 HIGH, `TelemetryScreen.tsx:224-238`;
 * `composition.ts:613-624`): "G-provider ownership is not reference-counted.
 * Stop while a driving session is active is guarded correctly, but the
 * reverse transition fails: monitor Start -> driving session reuses the
 * already-running provider -> session end unconditionally calls
 * `gForceProvider.stop()` -> G rows die while the monitor remains open and
 * still expects ownership."
 *
 * Binding fix (ticket P4h-FIX1): composition owns a reference count
 * (`acquireGForce()`/`releaseGForce()`); the monitor screen and the driving
 * session each hold ONE, and the provider stops only at zero. Harness mirrors
 * `composition.telemetry.test.ts` (same mocks, same `bootFresh()` pattern).
 */
(globalThis as { __DEV__?: boolean }).__DEV__ = true;

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
}));

const tracked = vi.hoisted(() => ({
  gnssProviders: [] as StubLocationProviderInstance[],
}));

const gforceDouble = vi.hoisted(() => ({
  sampleListeners: new Set<(s: unknown) => void>(),
  startCalls: 0,
  stopCalls: 0,
}));

vi.mock('../../src/session/gforceProvider', () => ({
  createGForceProvider: () => ({
    start: () => {
      gforceDouble.startCalls += 1;
    },
    stop: async () => {
      gforceDouble.stopCalls += 1;
    },
    onSample: (cb: (s: unknown) => void) => {
      gforceDouble.sampleListeners.add(cb);
      return () => gforceDouble.sampleListeners.delete(cb);
    },
  }),
}));

interface StubLocationProviderInstance {
  startCount: number;
  stopCount: number;
  push(sample: LocationSample): void;
}

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'gforce-ownership-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubLocationProviderBase {
    listeners = new Set<(s: LocationSample) => void>();
    startCount = 0;
    stopCount = 0;
    async start(): Promise<void> {
      this.startCount += 1;
    }
    async stop(): Promise<void> {
      this.stopCount += 1;
    }
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
  class StubClock {
    now(): number {
      return Date.now();
    }
  }
  return {
    GnssLocationProvider: StubGnssLocationProvider,
    PerformanceNowClock: StubClock,
    ReplayLocationProvider: class extends StubLocationProviderBase {},
    startLifecycleListener: () => {},
  };
});

vi.mock('../../src/persistence/expoSqlDatabase', () => ({
  openAppDatabase: async () => {
    return { db: seeded.db, repository: seeded.repository };
  },
}));

vi.mock('../../src/session/tcpObdTransport', () => ({
  TcpObdTransport: class {
    async connect(): Promise<void> {
      throw new Error('adapter unreachable (test double)');
    }
    send(): void {}
    onData(): () => void {
      return () => undefined;
    }
    onClose(): () => void {
      return () => undefined;
    }
    async close(): Promise<void> {}
  },
}));

import { TMR_CIRCUIT_PROFILE } from '../../src/session/tmrProfile';

function flushBootstrap(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function feed(provider: StubLocationProviderInstance, samples: readonly LocationSample[]): void {
  for (const sample of samples) provider.push(sample);
}

async function bootFresh(): Promise<typeof import('../../src/session/composition')> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  await migrateTelemetrySchema(db);
  seeded.db = db;
  seeded.repository = repository;
  tracked.gnssProviders.length = 0;
  gforceDouble.sampleListeners.clear();
  gforceDouble.startCalls = 0;
  gforceDouble.stopCalls = 0;

  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await flushBootstrap();
  return composition;
}

/** Drives a full session (calibration -> lap -> end) on the stub GNSS provider. */
async function runSession(
  composition: Awaited<ReturnType<typeof bootFresh>>,
  seed: number,
): Promise<void> {
  const gnss = tracked.gnssProviders[0]!;
  composition.facade.startPreflight();
  await flushBootstrap();
  composition.facade.beginCalibration();
  await flushBootstrap();
  feed(gnss, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, seed));
  await flushBootstrap();
  composition.facade.acceptCalibration();
  await flushBootstrap();
  composition.facade.arm();
  feed(gnss, multiLapSession(TMR_CIRCUIT_PROFILE, 1, seed + 1));
  await flushBootstrap();
  composition.facade.endSession();
  await flushBootstrap();
  await flushBootstrap();
}

describe('composition.ts: reference-counted G-force provider ownership (P4h-FIX1 H6)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('monitor Start -> driving session -> session END: the G provider keeps running for the monitor', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ telemetryEnabled: true, telemetrySimulate: false });

    // The telemetry monitor's Start button takes a reference.
    composition.acquireGForce();
    expect(gforceDouble.startCalls).toBe(1);

    await runSession(composition, 950_001);

    // The session took and released its OWN reference -- the monitor still
    // holds one, so the provider must NOT have been stopped.
    expect(gforceDouble.stopCalls).toBe(0);

    // Monitor Stop releases the last reference: now it stops.
    await composition.releaseGForce();
    expect(gforceDouble.stopCalls).toBe(1);
  });

  it('with no monitor holding a reference, a session end still stops the provider (unchanged behavior)', async () => {
    const composition = await bootFresh();
    composition.settingsStore.update({ telemetryEnabled: true, telemetrySimulate: false });

    await runSession(composition, 960_001);

    expect(gforceDouble.startCalls).toBe(1);
    expect(gforceDouble.stopCalls).toBe(1);
  });

  it('acquire/release is balanced and idempotent at zero: an extra release never stops a provider nobody holds', async () => {
    const composition = await bootFresh();

    composition.acquireGForce();
    composition.acquireGForce(); // a second holder (e.g. monitor + session).
    expect(gforceDouble.startCalls).toBe(1); // started once, not twice.

    await composition.releaseGForce();
    expect(gforceDouble.stopCalls).toBe(0); // one holder left.
    await composition.releaseGForce();
    expect(gforceDouble.stopCalls).toBe(1);
    await composition.releaseGForce(); // unbalanced extra release.
    expect(gforceDouble.stopCalls).toBe(1);
  });
});
