import type { LocationProvider, LocationSample } from '@circuit/core';

export interface ReplayOptions {
  /** 1 = real-time pace (default), >1 = faster than recorded, <1 = slower. */
  speedFactor?: number;
}

/**
 * App-side dev-tool {@link LocationProvider} that replays a captured
 * `LocationSample[]` at real-time pace (or an accelerated/decelerated
 * `speedFactor`), re-stamped with `source: 'replay'`.
 *
 * This is deliberately a thin UI-feed utility for exercising the app screens
 * with recorded telemetry without a live GNSS fix. It is NOT the production
 * replay harness: `docs/architecture/contracts.md` documents a separate
 * `ReplayHarness` that streams fixtures through the production pipeline
 * (quality → matcher → crossings → state machine → timing → delta) inside
 * `@circuit/core`; that is a core-package concern owned elsewhere and is not
 * duplicated here.
 */
export class ReplayLocationProvider implements LocationProvider {
  private readonly samples: readonly LocationSample[];
  private readonly speedFactor: number;
  private readonly listeners = new Set<(s: LocationSample) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cursor = 0;
  private running = false;

  constructor(samples: LocationSample[], options: ReplayOptions = {}) {
    this.samples = samples;
    this.speedFactor = options.speedFactor && options.speedFactor > 0 ? options.speedFactor : 1;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cursor = 0;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  subscribe(cb: (s: LocationSample) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private scheduleNext(): void {
    if (!this.running || this.cursor >= this.samples.length) {
      this.running = false;
      return;
    }
    const delayMs = this.delayToNextMs();
    this.timer = setTimeout(() => {
      const original = this.samples[this.cursor];
      const replaySample: LocationSample = { ...original, source: 'replay' };
      for (const listener of this.listeners) listener(replaySample);
      this.cursor += 1;
      this.scheduleNext();
    }, delayMs);
  }

  private delayToNextMs(): number {
    if (this.cursor === 0) return 0;
    const prev = this.samples[this.cursor - 1];
    const curr = this.samples[this.cursor];
    const rawDeltaMs = Math.max(0, curr.tMono - prev.tMono);
    return rawDeltaMs / this.speedFactor;
  }
}
