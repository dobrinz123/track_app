import {
  buildTestLoopCircuit,
  detectLoopClosure,
  DEFAULT_TEST_LOOP_CONFIG,
  polylineLength,
  type LocationSample,
  type TestLoopCircuit,
  type TestLoopFailureReason,
} from '@circuit/core';

/**
 * Ticket P5d T2/T5 -- the LEARN phase of Test Loop mode, as a plain
 * subscribable object.
 *
 * It owns no provider, no database and no navigation: `composition.ts` feeds
 * it the GNSS samples and reacts to `onLearned`, the screen renders
 * `snapshot()`. That keeps every decision here testable with a synthetic
 * trace and nothing else.
 *
 * Cost discipline: `detectLoopClosure` is O(samples), so running it on every
 * fix would be quadratic over a long drive. It is therefore only run when the
 * cheap incremental facts already hold -- the car is back inside the closing
 * radius of the start point AND has driven at least a minimum lap. Everything
 * else is one distance calculation per fix.
 */

export type TestLoopPhase = 'idle' | 'learning' | 'learned' | 'failed';

export interface LearnedTrackSummary {
  circuitId: string;
  displayName: string;
  lengthM: number;
  cornerCount: number;
}

export interface TestLoopFailure {
  reason: TestLoopFailureReason;
  travelledM: number;
}

export interface TestLoopSnapshot {
  phase: TestLoopPhase;
  /** Fixes accepted since `start()`. */
  sampleCount: number;
  /** Distance driven since `start()`, metres. */
  travelledM: number;
  /** How near the start point the car is right now, metres (`null` before the first fix). */
  distanceToStartM: number | null;
  learned: LearnedTrackSummary | null;
  failure: TestLoopFailure | null;
}

export interface TestLoopControllerDeps {
  /** ISO instant the loop was learned. */
  nowUtc: () => string;
  /** A fresh, stable circuit id for the learned loop. */
  makeCircuitId: () => string;
  /** The provisional name a just-learned loop carries until the driver saves it. */
  makeDisplayName: (createdAtUtc: string) => string;
  /**
   * Called ONCE, the moment lap 1 closes, with the learned circuit. Whatever
   * it does (persist, register, select, hand over to the session controller)
   * is the composition layer's business, not this module's.
   */
  onLearned: (circuit: TestLoopCircuit) => void;
  /** Safety valve: a trace longer than this stops learning with an honest failure. */
  maxSamples?: number;
}

const DEFAULT_MAX_SAMPLES = 36_000;

function haversineM(a: LocationSample, b: LocationSample): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const meanLat = ((a.lat + b.lat) / 2) * toRad;
  const east = dLon * Math.cos(meanLat) * R;
  const north = dLat * R;
  return Math.hypot(east, north);
}

export class TestLoopController {
  private phase: TestLoopPhase = 'idle';
  private samples: LocationSample[] = [];
  private travelled = 0;
  private distanceToStart: number | null = null;
  private departed = false;
  private learned: LearnedTrackSummary | null = null;
  private failure: TestLoopFailure | null = null;
  private readonly listeners = new Set<(snapshot: TestLoopSnapshot) => void>();

  constructor(private readonly deps: TestLoopControllerDeps) {}

  subscribe(listener: (snapshot: TestLoopSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): TestLoopSnapshot {
    return {
      phase: this.phase,
      sampleCount: this.samples.length,
      travelledM: this.travelled,
      distanceToStartM: this.distanceToStart,
      learned: this.learned,
      failure: this.failure,
    };
  }

  /** Begins (or restarts) a learn phase. Everything from a previous attempt is dropped. */
  start(): void {
    this.samples = [];
    this.travelled = 0;
    this.distanceToStart = null;
    this.departed = false;
    this.learned = null;
    this.failure = null;
    this.phase = 'learning';
    this.emit();
  }

  /** Feeds one GNSS fix. Ignored unless a learn phase is running. */
  feed(sample: LocationSample): void {
    if (this.phase !== 'learning') return;
    const previous = this.samples[this.samples.length - 1];
    const start = this.samples[0];
    this.samples.push(sample);
    if (previous !== undefined) this.travelled += haversineM(previous, sample);
    if (start !== undefined) {
      const toStartM = haversineM(start, sample);
      this.distanceToStart = toStartM;
      if (toStartM > DEFAULT_TEST_LOOP_CONFIG.closeRadiusM) this.departed = true;
      if (
        this.departed &&
        toStartM <= DEFAULT_TEST_LOOP_CONFIG.closeRadiusM &&
        this.travelled >= DEFAULT_TEST_LOOP_CONFIG.minLapLengthM
      ) {
        this.tryClose();
        if (this.phase !== 'learning') return;
      }
    } else {
      this.distanceToStart = 0;
    }

    if (this.samples.length >= (this.deps.maxSamples ?? DEFAULT_MAX_SAMPLES)) {
      this.fail();
      return;
    }
    this.emit();
  }

  /**
   * Ends the learn phase. A loop that was learned stays learned; one that was
   * not ends in `failed` with the reason the closure test itself gives -- the
   * driver is told which of the three conditions did not hold, never just
   * "something went wrong".
   */
  stop(): TestLoopSnapshot {
    if (this.phase === 'learning') this.fail();
    return this.snapshot();
  }

  /** Drops everything and returns to idle (leaving the screen). */
  reset(): void {
    this.phase = 'idle';
    this.samples = [];
    this.travelled = 0;
    this.distanceToStart = null;
    this.departed = false;
    this.learned = null;
    this.failure = null;
    this.emit();
  }

  private tryClose(): void {
    const result = buildTestLoopCircuit(this.samples, {
      circuitId: this.deps.makeCircuitId(),
      displayName: this.deps.makeDisplayName(this.deps.nowUtc()),
      createdAtUtc: this.deps.nowUtc(),
    });
    if (!result.ok) {
      // Not a loop YET: keep driving. Only `stop()` (or the sample cap) turns
      // a not-yet into a failure.
      return;
    }
    this.phase = 'learned';
    this.learned = {
      circuitId: result.profile.circuitId,
      displayName: result.profile.displayName,
      lengthM: polylineLength(result.runtime.centerline),
      cornerCount: result.corners.length,
    };
    this.deps.onLearned(result);
    this.emit();
  }

  private fail(): void {
    const closure = detectLoopClosure(this.samples);
    this.failure = {
      reason: closure.closed ? 'not-returned' : closure.reason,
      travelledM: closure.closed ? closure.closure.lapLengthM : closure.travelledM,
    };
    this.phase = 'failed';
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}
