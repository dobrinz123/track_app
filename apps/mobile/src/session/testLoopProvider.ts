import type { LocationProvider, LocationSample } from '@circuit/core';

/**
 * Ticket P5d-FIX1 H1 (Codex P5d-REV1 HIGH 1) -- the provider that makes the
 * learn phase and the timed session ONE continuous recording.
 *
 * The problem it solves: a `SessionController` needs a circuit up front, and
 * during lap 1 there is no circuit yet -- lap 1 is what creates one. The old
 * flow therefore learned with a bare GNSS subscription, stopped the provider,
 * rebuilt everything and asked the driver to press "Start timing": lap 1 was
 * never part of the session, and the fixes between closure and that tap were
 * simply lost.
 *
 * This wrapper keeps every fix instead:
 *
 *  - LEARNING: it subscribes to the real provider, hands each fix to the learn
 *    callback, and keeps them all.
 *  - HANDOVER (from the moment lap 1 closes until the new controller is armed):
 *    fixes keep arriving and keep being kept, but nothing is delivered yet --
 *    so the controller can never see a live fix BEFORE the backlog that
 *    precedes it, which would break the pipeline's monotonic time assumption.
 *  - LIVE: `flushBuffered()` replays the whole backlog in order into the
 *    controller (lap 1 first, then everything driven since), and every later
 *    fix passes straight through.
 *
 * The upstream provider is never stopped by any of this -- `stop()` is only
 * ever the session's own end, exactly as for a bundled circuit.
 */

export type TestLoopProviderPhase = 'learning' | 'handover' | 'live';

export class TestLoopLocationProvider implements LocationProvider {
  private phase: TestLoopProviderPhase = 'learning';
  private buffer: LocationSample[] = [];
  private dropped = 0;
  /** True while `flushBuffered()` is draining -- new fixes queue behind the backlog. */
  private draining = false;
  private upstreamUnsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<(sample: LocationSample) => void>();

  constructor(
    private readonly upstream: LocationProvider,
    /** Where every fix goes while the track is still being learned. */
    private readonly onLearnSample: (sample: LocationSample) => void,
    /** Hard bound on the backlog (a fix per 100 ms for three hours). */
    private readonly maxBuffered = 108_000,
  ) {}

  /**
   * Starts the underlying provider (idempotent -- the composition layer may
   * already have it running) and attaches this wrapper's single upstream
   * subscription.
   */
  async start(): Promise<void> {
    await this.upstream.start();
    this.upstreamUnsubscribe ??= this.upstream.subscribe((sample) => this.ingest(sample));
  }

  /** Detaches and stops the underlying provider. Only the session's end calls this. */
  async stop(): Promise<void> {
    this.upstreamUnsubscribe?.();
    this.upstreamUnsubscribe = null;
    await this.upstream.stop();
  }

  subscribe(cb: (sample: LocationSample) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Lap 1 has closed: stop feeding the learner, keep every fix, deliver none yet. */
  beginHandover(): void {
    if (this.phase === 'learning') this.phase = 'handover';
  }

  /**
   * The controller is armed: replay the backlog in order -- the learning lap
   * first, then everything driven while the handover ran -- and go live.
   *
   * P5d-FIX2 N2 (Codex P5d-REV2 HIGH 2): the backlog is drained INCREMENTALLY
   * and the phase flips to live only once it is empty. Two consequences the
   * previous version got wrong: a listener that throws can no longer take the
   * un-emitted tail with it (each delivery is isolated, and the cursor moves
   * only after the attempt), and a fix that arrives DURING the drain is still
   * appended to the backlog -- so it is delivered after the fixes that precede
   * it, never ahead of them.
   */
  flushBuffered(): void {
    this.draining = true;
    try {
      while (this.buffer.length > 0) {
        const sample = this.buffer[0];
        if (sample === undefined) break;
        this.emit(sample);
        this.buffer.shift();
      }
      this.phase = 'live';
    } finally {
      this.draining = false;
    }
  }

  /** The learning lap's own fixes, in order (the trace that becomes the centreline). */
  bufferedSamples(): LocationSample[] {
    return [...this.buffer];
  }

  /** Fixes dropped because the backlog hit its bound -- never silently zero. */
  droppedSamples(): number {
    return this.dropped;
  }

  currentPhase(): TestLoopProviderPhase {
    return this.phase;
  }

  private ingest(sample: LocationSample): void {
    if (this.phase === 'live' && !this.draining) {
      this.emit(sample);
      return;
    }
    if (this.buffer.length >= this.maxBuffered) {
      this.dropped += 1;
    } else {
      this.buffer.push(sample);
    }
    if (this.phase === 'learning') this.onLearnSample(sample);
  }

  /** Delivers one fix, isolating each listener: one throwing consumer never stops the replay. */
  private emit(sample: LocationSample): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(sample);
      } catch (error) {
        console.warn('[testLoopProvider] a sample listener threw; continuing the replay', error);
      }
    }
  }
}
