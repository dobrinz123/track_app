import type { LocationProvider, LocationSample, MonotonicClock } from '@circuit/core';

/**
 * Owns the "virtual clock" a dev-replay session runs on:
 *
 *   virtualNow() = virtualStartMono + (realElapsedMs * speedFactor)
 *
 * `realClock` is any real, wall-time `MonotonicClock` (the app passes
 * `PerformanceNowClock`) -- `ReplayTimeSource` reads it once at construction
 * to fix `realStartMono`, then every `virtualNow()`/`toVirtual()` call
 * measures elapsed real time off that anchor and scales it by `speedFactor`.
 *
 * This is the fix for the DevReplay pacing bug: previously
 * `LiveTimestampedLocationProvider` re-stamped every sample with the REAL
 * clock reading at delivery time, which compresses inter-sample spacing by
 * `speedFactor` (a fixture's 1000ms-spaced samples, delivered 10x faster,
 * landed 100ms apart in real time) -- `TelemetryQualityEvaluator` then reads
 * that 100ms gap, computes an implied speed 10x too high, and rejects every
 * sample as `IMPOSSIBLE_JUMP`. Anchoring both the clock (`ScaledReplayClock`
 * below) and every emitted sample's `tMono` (`ReplayTimestampedLocationProvider`
 * below) to this SAME virtual time source keeps inter-sample spacing exactly
 * equal to the fixture's own recorded spacing, in a domain
 * `SessionController`'s `clock.now() - lap.tStart` arithmetic can still use
 * directly, while still delivering samples at wall-clock `speedFactor`x pace.
 *
 * Watchdog compatibility (ADR-0003 §1): `SessionController`'s watchdog
 * compares `deps.clock.now()` gaps against `watchdogTimeoutMs` (default
 * 5000ms). Because `clock` here is a `ScaledReplayClock` reading this same
 * virtual time source, a gap in the fixture's own recorded timeline (e.g.
 * the `signalLossLap` fixture's 15s gap) still reads as a ~15s gap to the
 * watchdog -- exceeding the default 5000ms threshold and triggering a
 * provider restart, same as it would watching a real 15s GNSS outage. The
 * watchdog's *poll interval* (`watchdogPollMs`, default 1000ms) is unscaled
 * real time (it drives `WatchdogScheduler.setInterval`, a real timer) -- at
 * `speedFactor` 10 that polls roughly every 10s of virtual time, which is
 * frequent enough relative to a clean fixture's ~1s sample spacing that it
 * never observes a false gap.
 */
export class ReplayTimeSource {
  private readonly realStartMono: number;

  constructor(
    private readonly realClock: MonotonicClock,
    private readonly speedFactor: number,
    private readonly virtualStartMono: number = 0,
  ) {
    this.realStartMono = realClock.now();
  }

  /** Current virtual time: `virtualStartMono` plus real-elapsed-time scaled by `speedFactor`. */
  virtualNow(): number {
    const realElapsedMs = this.realClock.now() - this.realStartMono;
    return this.virtualStartMono + realElapsedMs * this.speedFactor;
  }

  /**
   * Maps an original fixture-relative `tMono` into this source's virtual
   * domain, anchored so that `originalTMono === originAnchorMono` (the
   * fixture's own first-sample `tMono`) lands exactly on `virtualStartMono`.
   * Since this is a pure offset (no scaling), the spacing BETWEEN samples in
   * the fixture's own recorded time is preserved exactly -- unlike stamping
   * from `virtualNow()` at delivery, which would additionally carry any
   * timer-scheduling jitter from the accelerated real-time delivery.
   */
  toVirtual(originalTMono: number, originAnchorMono: number): number {
    return this.virtualStartMono + (originalTMono - originAnchorMono);
  }
}

/** A `MonotonicClock` that reads a shared `ReplayTimeSource`'s virtual time -- see the module doc comment above. */
export class ScaledReplayClock implements MonotonicClock {
  constructor(private readonly timeSource: ReplayTimeSource) {}

  now(): number {
    return this.timeSource.virtualNow();
  }
}

/**
 * Wraps a `LocationProvider` (in practice `ReplayLocationProvider`,
 * `../platform/replayLocationProvider.ts`) so every sample it emits is
 * re-stamped into `timeSource`'s virtual domain instead of the fixture's own
 * small, fixture-relative `tMono` origin -- see the module doc comment above
 * for why this preserves original inter-sample spacing and how it keeps
 * `SessionController`'s watchdog and `currentLapMs` arithmetic meaningful
 * against a `ScaledReplayClock` reading the SAME `timeSource`.
 *
 * The first sample observed after each `start()` anchors the mapping (its
 * own `tMono` becomes `timeSource`'s `virtualStartMono`); every later
 * sample's `tMono` is offset from that anchor by exactly its original
 * fixture-relative delta.
 */
export class ReplayTimestampedLocationProvider implements LocationProvider {
  private anchorTMono: number | null = null;

  constructor(
    private readonly inner: LocationProvider,
    private readonly timeSource: ReplayTimeSource,
  ) {}

  async start(): Promise<void> {
    this.anchorTMono = null;
    await this.inner.start();
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }

  subscribe(cb: (s: LocationSample) => void): () => void {
    return this.inner.subscribe((sample: LocationSample) => {
      if (this.anchorTMono === null) this.anchorTMono = sample.tMono;
      const virtualTMono = this.timeSource.toVirtual(sample.tMono, this.anchorTMono);
      cb({ ...sample, tMono: virtualTMono });
    });
  }
}
