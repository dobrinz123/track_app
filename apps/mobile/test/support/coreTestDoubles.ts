import type { LocationProvider, LocationSample, MonotonicClock } from '@circuit/core';

/**
 * Small local copies of packages/core/test/controller/testSupport.ts's
 * FakeClock/FakeLocationProvider (`feed` helper included), kept as a local
 * copy per the ticket's explicit fallback rather than a relative import into
 * packages/core/test/**: that tree has only ever been typechecked under
 * core's own tsconfig (module ESNext, noUncheckedIndexedAccess, etc.), and a
 * relative import would pull it into apps/mobile's independently-configured
 * `tsc --noEmit` (Expo's tsconfig.base: module "preserve", moduleResolution
 * "bundler") -- unrelated, unvalidated risk. The app already depends on
 * `@circuit/core`'s production exports directly, so only these two trivial
 * fakes are duplicated.
 */

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

/**
 * Pushes `samples` through `provider` while advancing `clock` by each
 * sample's own `tMono` delta, so `MonotonicClock.now()` and `sample.tMono`
 * stay consistent -- mirrors `GnssLocationProvider`, where both are stamped
 * from the same monotonic source (same pattern as core's own controller
 * tests' local `feed` helper).
 */
export function feedSamples(clock: FakeClock, provider: FakeLocationProvider, samples: readonly LocationSample[]): void {
  let wallClock = clock.now();
  let previousTMono: number | null = null;
  for (const sample of samples) {
    const delta = previousTMono === null ? 0 : Math.max(0, sample.tMono - previousTMono);
    previousTMono = sample.tMono;
    wallClock += delta;
    clock.set(wallClock);
    provider.push(sample);
  }
}
