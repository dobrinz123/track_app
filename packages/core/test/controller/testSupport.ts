import { readFileSync } from 'node:fs';

import type { CircuitProfile, LocationProvider, LocationSample, MonotonicClock } from '../../src/contracts';
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
