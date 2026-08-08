import { readFileSync } from 'node:fs';

import type {
  CircuitProfile,
  LapRecord,
  LocalSessionRepository,
  LocationProvider,
  LocationSample,
  MonotonicClock,
  ReferenceLap,
  SessionMachineSnapshot,
  SessionSummary,
} from '../../src/contracts';
import { loadProfileFromJson, type RuntimeProfile } from '../../src/profile';
import type { WatchdogScheduler } from '../../src/controller';

export interface TmrFixture {
  profile: CircuitProfile;
  runtime: RuntimeProfile;
}

export function tmr(): TmrFixture {
  const json = readFileSync(
    new URL('../../assets/circuits/transilvania-motor-ring.v1.json', import.meta.url),
    'utf8',
  );
  const loaded = loadProfileFromJson(json);
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return { profile: loaded.profile, runtime: loaded.runtime };
}

/** Deterministic fake `MonotonicClock` fully under a test's control. */
export class FakeClock implements MonotonicClock {
  private t: number;
  constructor(startAt = 0) {
    this.t = startAt;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

/** Push-based `LocationProvider` test double: `push()` synchronously delivers one sample to every subscriber. */
export class FakeLocationProvider implements LocationProvider {
  private readonly listeners = new Set<(s: LocationSample) => void>();
  running = false;
  startCount = 0;
  stopCount = 0;

  async start(): Promise<void> {
    this.running = true;
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopCount += 1;
  }

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

/** Captures the watchdog's poll callback so a test can invoke it manually against a `FakeClock` it fully controls, instead of racing real timers. */
export class FakeWatchdogScheduler implements WatchdogScheduler {
  private handles = new Map<number, () => void>();
  private nextHandle = 1;

  setInterval(fn: () => void): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.handles.set(handle, fn);
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.handles.delete(handle as number);
  }

  /** Invokes every currently-registered interval callback once. */
  tick(): void {
    for (const fn of [...this.handles.values()]) fn();
  }
}

/**
 * Wraps a `LocalSessionRepository`, letting a test defer and/or fail
 * `saveTelemetry` on demand to pin `endSession()`'s ordering and
 * error-propagation contract (C4 fix / blind-verifier B2): every other
 * method is a plain pass-through delegate.
 */
export class ControllableRepository implements LocalSessionRepository {
  /** When set, every `saveTelemetry` call awaits this before proceeding -- lets a test observe that `endSession()`/`flush()` has NOT yet resolved while a write is still pending. */
  saveTelemetryGate: Promise<void> | null = null;
  /** When true, `saveTelemetry` rejects instead of delegating -- pins that `endSession()` propagates the failure (Promise.all, not allSettled). */
  saveTelemetryShouldReject = false;
  readonly saveTelemetryCalls: Array<{ sessionId: string; lapNumber: number }> = [];

  constructor(private readonly delegate: LocalSessionRepository) {}

  saveCheckpoint(sessionId: string, snapshot: SessionMachineSnapshot, laps: LapRecord[]): Promise<void> {
    return this.delegate.saveCheckpoint(sessionId, snapshot, laps);
  }

  loadCheckpoint(sessionId: string): Promise<{ snapshot: SessionMachineSnapshot; laps: LapRecord[] } | null> {
    return this.delegate.loadCheckpoint(sessionId);
  }

  saveSession(s: SessionSummary): Promise<void> {
    return this.delegate.saveSession(s);
  }

  listSessions(userId: string, circuitId: string): Promise<SessionSummary[]> {
    return this.delegate.listSessions(userId, circuitId);
  }

  async saveTelemetry(sessionId: string, lapNumber: number, samples: LocationSample[]): Promise<void> {
    this.saveTelemetryCalls.push({ sessionId, lapNumber });
    if (this.saveTelemetryGate !== null) await this.saveTelemetryGate;
    if (this.saveTelemetryShouldReject) throw new Error('saveTelemetry failed (test double)');
    return this.delegate.saveTelemetry(sessionId, lapNumber, samples);
  }

  loadTelemetry(sessionId: string, lapNumber: number): Promise<LocationSample[]> {
    return this.delegate.loadTelemetry(sessionId, lapNumber);
  }

  getReferenceLap(
    userId: string,
    circuitId: string,
    layoutId: string,
    layoutVersion: number,
  ): Promise<ReferenceLap | null> {
    return this.delegate.getReferenceLap(userId, circuitId, layoutId, layoutVersion);
  }

  putReferenceLap(ref: ReferenceLap): Promise<void> {
    return this.delegate.putReferenceLap(ref);
  }

  deleteUserData(userId: string): Promise<void> {
    return this.delegate.deleteUserData(userId);
  }
}
