import type { LocationProvider, LocationSample, MonotonicClock } from '@circuit/core';

/**
 * Wraps a `LocationProvider` so every sample it emits is re-stamped with the
 * CURRENT `MonotonicClock` reading at delivery time, discarding whatever
 * `tMono` the inner provider originally attached.
 *
 * `GnssLocationProvider` already does this itself (`tMono = performance.now()`
 * at receipt). `ReplayLocationProvider` (`../platform/replayLocationProvider.ts`)
 * deliberately does NOT: it re-emits a fixture's own recorded `tMono` values
 * unchanged, which is correct for `packages/core`'s deterministic batch
 * replay tests but wrong for driving `SessionController` live on
 * `DevReplayScreen` (MUST DO #6) -- the controller's `currentLapMs` display
 * reads `MonotonicClock.now() - lap.tStart`, and mixing a small
 * fixture-relative `tMono` with the app's real, large `performance.now()`
 * origin would make that subtraction meaningless. This adapter is the fix:
 * it keeps `ReplayLocationProvider`'s own delivery cadence (including its
 * `speedFactor` acceleration) but re-anchors every sample's `tMono` to the
 * SAME clock the rest of the live pipeline uses, exactly like a real GNSS
 * fix would be stamped.
 */
export class LiveTimestampedLocationProvider implements LocationProvider {
  constructor(
    private readonly inner: LocationProvider,
    private readonly clock: MonotonicClock,
  ) {}

  start(): Promise<void> {
    return this.inner.start();
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }

  subscribe(cb: (s: LocationSample) => void): () => void {
    return this.inner.subscribe((sample: LocationSample) => {
      cb({ ...sample, tMono: this.clock.now() });
    });
  }
}
