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

/**
 * P5d-FIX1 H3 (Codex P5d-REV1 HIGH 3): `learned` is reached ONLY after the
 * learned circuit has been persisted, registered and selected. While that is
 * in flight the phase is `adopting`; if it fails, the phase is `error` (with a
 * retry), never `learned` -- a driver told the track was learned while the app
 * quietly kept the previously selected circuit would then be timed, and
 * coached, on the wrong geometry.
 */
export type TestLoopPhase = 'idle' | 'learning' | 'adopting' | 'learned' | 'failed' | 'error';

export interface LearnedTrackSummary {
  circuitId: string;
  displayName: string;
  lengthM: number;
  cornerCount: number;
}

export interface TestLoopFailure {
  reason: TestLoopFailureReason;
  travelledM: number;
  /**
   * P5d-FIX2 N6: set when the learn phase gave up because it hit its own fix
   * cap -- the number of fixes it consumed. Structured, not prose: the screen
   * renders it in the driver's language.
   */
  sampleCap?: number;
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
  /** P5d-FIX1 H3: why keeping the just-learned track failed, in the driver's words. */
  adoptError: string | null;
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
   * it does (persist, register, select, roll the session into timing) is the
   * composition layer's business, not this module's -- but it is AWAITED
   * (P5d-FIX1 H3): the phase stays `adopting` until it resolves, and a
   * rejection becomes `error`, never `learned`.
   */
  onLearned: (circuit: TestLoopCircuit) => void | Promise<void>;
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
  /** Whether the previous fix was inside the closing radius -- the exit edge is what triggers a closure test. */
  private wasInside = true;
  /** The last fix that passed the quality gate -- what distance and the radius edge are measured against. */
  private lastQualified: LocationSample | null = null;
  /** The first QUALIFIED fix: the loop is anchored there, exactly as the core anchors it. */
  private qualifiedStart: LocationSample | null = null;
  /** The QUALIFIED fixes of the learned lap (P5d-FIX2 N7), kept for the session out-lap trace. */
  private lapSamples: LocationSample[] = [];
  private learned: LearnedTrackSummary | null = null;
  private failure: TestLoopFailure | null = null;
  /** P5d-FIX1 H3: the learned circuit waiting to be kept -- retried, never re-derived. */
  private pendingCircuit: TestLoopCircuit | null = null;
  private adoptError: string | null = null;
  /** Minted once per learn phase, not once per closure ATTEMPT -- the id belongs to this drive. */
  private circuitId: string | null = null;
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
      adoptError: this.adoptError,
    };
  }

  /** Begins (or restarts) a learn phase. Everything from a previous attempt is dropped. */
  start(): void {
    this.samples = [];
    this.travelled = 0;
    this.distanceToStart = null;
    this.departed = false;
    this.wasInside = true;
    this.lastQualified = null;
    this.qualifiedStart = null;
    this.lapSamples = [];
    this.learned = null;
    this.failure = null;
    this.pendingCircuit = null;
    this.adoptError = null;
    this.circuitId = null;
    this.phase = 'learning';
    this.emit();
  }

  /**
   * Feeds one GNSS fix. Ignored unless a learn phase is running.
   *
   * P5d-FIX3 F8 (Codex P5d-REV3 HIGH): only a fix that would pass the CORE's
   * own quality gate is allowed to move this state machine. An urban-canyon
   * reflection that lands 500 m away is not a departure, not a metre driven,
   * and above all not the exit that confirms a lap: letting it flip
   * `wasInside` consumed the one edge that triggers the closure test, and the
   * loop then could not be learned until a whole further lap had been driven.
   * The raw fix is still buffered -- the core re-qualifies the whole trace
   * when it builds the circuit -- it simply proves nothing on its own.
   */
  feed(sample: LocationSample): void {
    if (this.phase !== 'learning') return;
    const start = this.qualifiedStart;
    this.samples.push(sample);

    if (this.qualifies(sample)) {
      const previous = this.lastQualified;
      if (previous !== null) this.travelled += haversineM(previous, sample);
      this.lastQualified = sample;
      this.qualifiedStart ??= sample;

      if (start !== null && start !== undefined) {
        const toStartM = haversineM(start, sample);
        this.distanceToStart = toStartM;
        const insideNow = toStartM <= DEFAULT_TEST_LOOP_CONFIG.closeRadiusM;
        if (!insideNow) this.departed = true;
        // P5d-FIX2 N1: the closure is evaluated the moment the car drives back
        // OUT of the closing radius after a pass through it -- which is exactly
        // when the geometry becomes decidable.
        const leftTheRadius = this.wasInside && !insideNow;
        this.wasInside = insideNow;
        if (
          this.departed &&
          leftTheRadius &&
          this.travelled >= DEFAULT_TEST_LOOP_CONFIG.minLapLengthM
        ) {
          this.tryClose();
          if (this.phase !== 'learning') return;
        }
      } else {
        this.distanceToStart = 0;
        this.wasInside = true;
      }
    }

    const cap = this.deps.maxSamples ?? DEFAULT_MAX_SAMPLES;
    if (this.samples.length >= cap) {
      // P5d-FIX2 N6: say what happened, in numbers the driver can act on.
      this.fail(cap);
      return;
    }
    this.emit();
  }

  /**
   * The same gate `qualifyTrack` applies in `@circuit/core` (P5d-FIX3 F8):
   * accurate enough, actually moving, and reachable from the previous accepted
   * fix at a plausible speed. Kept deliberately in step with that function --
   * if the two ever disagree, the controller triggers a closure test the core
   * then refuses, which is the exact bug this guards against.
   */
  private qualifies(sample: LocationSample): boolean {
    const config = DEFAULT_TEST_LOOP_CONFIG;
    const accuracyM = sample.accuracyM;
    if (accuracyM !== undefined && Number.isFinite(accuracyM) && accuracyM > config.maxAccuracyM) {
      return false;
    }
    const speedMps = sample.speedMps;
    if (speedMps !== undefined && Number.isFinite(speedMps) && speedMps < config.minSpeedMps) {
      return false;
    }
    const previous = this.lastQualified;
    if (previous === null) return true;
    const gapMs = sample.tMono - previous.tMono;
    const plausibleM =
      gapMs > 0
        ? Math.min(config.maxSegmentM, (config.maxSegmentSpeedMps * gapMs) / 1000)
        : config.maxSegmentM;
    return haversineM(previous, sample) <= plausibleM;
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
    this.wasInside = true;
    this.lastQualified = null;
    this.qualifiedStart = null;
    this.lapSamples = [];
    this.learned = null;
    this.failure = null;
    this.pendingCircuit = null;
    this.adoptError = null;
    this.circuitId = null;
    this.emit();
  }

  private tryClose(): void {
    this.circuitId ??= this.deps.makeCircuitId();
    const result = buildTestLoopCircuit(this.samples, {
      circuitId: this.circuitId,
      displayName: this.deps.makeDisplayName(this.deps.nowUtc()),
      createdAtUtc: this.deps.nowUtc(),
    });
    if (!result.ok) {
      // Not a loop YET: keep driving. Only `stop()` (or the sample cap) turns
      // a not-yet into a failure.
      return;
    }
    this.lapSamples = result.lapSamples;
    this.adopt(result);
  }

  /** The QUALIFIED fixes of the learned lap -- what the session stores as its out-lap trace. */
  learnedLapSamples(): LocationSample[] {
    return [...this.lapSamples];
  }

  /**
   * P5d-FIX1 H3: the learned track is handed over and only THEN announced.
   * `adopting` is a real, visible phase -- the driver is not told the track was
   * learned while the app is still deciding whether it could keep it.
   */
  private adopt(circuit: TestLoopCircuit): void {
    this.pendingCircuit = circuit;
    this.phase = 'adopting';
    this.adoptError = null;
    this.emit();
    void Promise.resolve()
      .then(() => this.deps.onLearned(circuit))
      .then(() => {
        this.phase = 'learned';
        this.learned = {
          circuitId: circuit.profile.circuitId,
          displayName: circuit.profile.displayName,
          lengthM: polylineLength(circuit.runtime.centerline),
          cornerCount: circuit.corners.length,
        };
        this.adoptError = null;
        this.emit();
      })
      .catch((error: unknown) => {
        // Never `learned`: the track exists in memory but nothing else knows
        // about it, so timing it would be timing the wrong circuit.
        this.phase = 'error';
        this.learned = null;
        this.adoptError = error instanceof Error ? error.message : String(error);
        this.emit();
      });
  }

  /**
   * Retries the handover of a track that WAS learned but could not be kept
   * (P5d-FIX1 H3). The geometry is not re-derived -- it is the same lap.
   */
  retryAdopt(): void {
    const circuit = this.pendingCircuit;
    if (this.phase !== 'error' || circuit === null) return;
    this.adopt(circuit);
  }

  private fail(sampleCap?: number): void {
    const closure = detectLoopClosure(this.samples);
    this.failure = {
      reason: closure.closed ? 'not-returned' : closure.reason,
      travelledM: closure.closed ? closure.closure.lapLengthM : closure.travelledM,
      ...(sampleCap === undefined ? {} : { sampleCap }),
    };
    this.phase = 'failed';
    // P5d-FIX2 N6: a learn phase that gave up holds no trace. The buffers are
    // released here, not left to grow until the screen happens to be dismissed.
    this.samples = [];
    this.lapSamples = [];
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}
