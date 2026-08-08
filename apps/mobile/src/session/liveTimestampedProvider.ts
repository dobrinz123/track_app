import type { LocationProvider, LocationSample, MonotonicClock } from '@circuit/core';

/**
 * Owns the "virtual clock" a dev-replay session runs on:
 *
 *   virtualNow() = virtualStartMono + (realElapsedMs * speedFactor)
 *
 * `realClock` is any real, wall-time `MonotonicClock` (the app passes
 * `PerformanceNowClock`) -- `ReplayTimeSource` reads it once at construction
 * to fix `realStartMono`, then every `virtualNow()` call measures elapsed
 * real time off that anchor and scales it by `speedFactor`.
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
 * Run boundaries (`beginRun()`/`toVirtual()` below) -- the follow-up fix for
 * a second pacing bug: a naive design anchors every `LocationProvider.start()`
 * ("run" -- calibration and, if the provider is ever restarted, the session
 * phase) back to a FIXED epoch (`virtualStartMono`) instead of to "now" on
 * this source. Real time keeps advancing `virtualNow()` continuously
 * regardless of whether a run is actively delivering samples (e.g. while a
 * human reviews the Calibration Result screen before tapping Accept) -- so a
 * later run anchored back at the fixed epoch stamps its samples HUNDREDS of
 * virtual seconds in the PAST relative to `ScaledReplayClock.now()`,
 * producing `currentLapMs = clock.now() - lap.tStart` in the hundreds of
 * seconds within moments of the first crossing, and can even make `tMono`
 * run BACKWARD across the run boundary. `beginRun()` fixes this: each run's
 * anchor is `virtualNow()` at the moment `start()` is called (not the fixed
 * epoch), clamped forward to never fall before the last virtual `tMono` any
 * PRIOR run on this source ever emitted -- so every run's samples land at or
 * after "now" and are monotonic across the whole source's lifetime.
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
  /** The last virtual `tMono` this source has ever handed out (any run) -- the monotonic floor `beginRun()`/`toVirtual()` enforce for every run after the first. `null` until the first sample of the first run is mapped. */
  private lastVirtualTMono: number | null = null;

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
   * Begins a new replay run (call once per `LocationProvider.start()`) and
   * returns the virtual timestamp that run's FIRST sample should be anchored
   * to: `virtualNow()` right now, or -- if a prior run on this source already
   * emitted a later virtual `tMono` (e.g. this run is starting only a moment
   * after the last one ended) -- that later value instead, so this run's
   * samples never land before the previous run's. Callers pass the returned
   * value into every `toVirtual()` call for this run.
   */
  beginRun(): number {
    const now = this.virtualNow();
    return this.lastVirtualTMono === null ? now : Math.max(now, this.lastVirtualTMono);
  }

  /**
   * Maps an original fixture-relative `tMono` into this run's virtual
   * domain: `runAnchorVirtual` (from `beginRun()`, called once at this run's
   * `start()`) plus the ORIGINAL fixture-relative delta from
   * `originAnchorMono` (this run's own first sample's `tMono`) -- preserving
   * the fixture's own inter-sample spacing exactly. Since this is a pure
   * offset (no scaling), it carries none of the timer-scheduling jitter
   * stamping from `virtualNow()` at delivery would. The result is also
   * clamped to never fall below `lastVirtualTMono` (belt-and-suspenders
   * alongside `beginRun()`'s own clamp -- fixture timestamps are expected
   * non-decreasing within a run, but this keeps the guarantee absolute) and
   * recorded as the new floor for any future run.
   */
  toVirtual(originalTMono: number, originAnchorMono: number, runAnchorVirtual: number): number {
    const candidate = runAnchorVirtual + (originalTMono - originAnchorMono);
    const virtual = this.lastVirtualTMono === null ? candidate : Math.max(candidate, this.lastVirtualTMono);
    this.lastVirtualTMono = virtual;
    return virtual;
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
 * Each `start()` begins a new run: `timeSource.beginRun()` fixes this run's
 * anchor virtual timestamp (see its doc comment for why this is `virtualNow()`
 * at that moment, not a fixed epoch), and the first sample observed
 * afterwards anchors the ORIGINAL-time side of the mapping (its own `tMono`
 * maps exactly onto the run anchor); every later sample's `tMono` is offset
 * from that anchor by exactly its original fixture-relative delta.
 */
export class ReplayTimestampedLocationProvider implements LocationProvider {
  private anchorTMono: number | null = null;
  private runAnchorVirtual = 0;

  constructor(
    private readonly inner: LocationProvider,
    private readonly timeSource: ReplayTimeSource,
  ) {}

  async start(): Promise<void> {
    this.anchorTMono = null;
    this.runAnchorVirtual = this.timeSource.beginRun();
    await this.inner.start();
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }

  subscribe(cb: (s: LocationSample) => void): () => void {
    return this.inner.subscribe((sample: LocationSample) => {
      if (this.anchorTMono === null) this.anchorTMono = sample.tMono;
      const virtualTMono = this.timeSource.toVirtual(sample.tMono, this.anchorTMono, this.runAnchorVirtual);
      cb({ ...sample, tMono: virtualTMono });
    });
  }
}
