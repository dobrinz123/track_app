import type {
  CrossingEvent,
  DeltaUpdate,
  LapRecord,
  LocationSample,
  QualityAssessment,
  QualityLevel,
  ReferenceLap,
  SessionEvent,
  SessionMachineSnapshot,
  SessionState,
  TrackMatch,
} from '../contracts';
import {
  TelemetryQualityEvaluator,
  TrackMatcher,
  type TelemetryQualityConfig,
  type TrackMatcherConfig,
} from '../matching';
import { polylineLength } from '../geometry';
import type { RuntimeProfile } from '../profile';
import { LiveDeltaEngine, type LiveDeltaEngineConfig } from '../reference';
import { createInitialSessionSnapshot, sessionReducer } from '../statemachine';
import {
  CrossingDetector,
  LapTimingEngine,
  type CrossingDetectorConfig,
  type LapTimingEngineConfig,
  type ProjectedGate,
} from '../timing';

/**
 * Shared pipeline wiring used by BOTH the batch `ReplayHarness`
 * (`packages/core/src/replay/replay-harness.ts`) and the live
 * `SessionController` (`packages/core/src/controller/sessionController.ts`).
 *
 * This module exists so the two consumers never independently reimplement
 * (and risk diverging on) how a `LocationSample` moves through quality
 * evaluation -> track matching -> pit/reverse-travel guards -> crossing
 * detection -> state machine -> lap/sector timing -- the binding pipeline
 * order documented in docs/architecture/contracts.md. `SessionPipelineCore`
 * is a faithful, generalized extraction of what was previously inlined in
 * `runSessionPipeline`'s `forEach` loop body: same order of operations, same
 * mutation timing, callable either in a batch loop (replay) or once per
 * incoming sample (live).
 */

export interface PipelineCoreConfig {
  /**
   * Base corridor width (meters) applied to the matcher as
   * `matcher.corridorWidthM` when that field isn't explicitly set in
   * `matcher` -- the wiring for `CircuitProfile.corridorWidthM` (MUST DO #1).
   * An explicit `matcher.corridorWidthM` always wins over this base value.
   */
  corridorWidthM?: number;
  quality?: Partial<TelemetryQualityConfig>;
  matcher?: Partial<TrackMatcherConfig>;
  crossings?: CrossingDetectorConfig;
  timing?: LapTimingEngineConfig;
  delta?: LiveDeltaEngineConfig;
  /** A tMono gap between consecutive samples larger than this is treated as an inferred PAUSE+RESUME (default 30s). */
  pauseGapMs?: number;
  /** A tMono gap larger than this invalidates the active lap as LOW_QUALITY (default 10s). */
  lowQualityGapMs?: number;
  /**
   * When true, `matches`/`rejectedSamples`/`stateHistory` are trimmed to
   * rolling windows (M2 fix) instead of growing for the life of the
   * session -- appropriate for a live, long-running `SessionController`.
   * Batch `runSessionPipeline` replay leaves this unset so its diagnostics
   * arrays stay complete for the (bounded, fixture-sized) session under
   * test. Full counts survive capping via `matchedTotal`/`rejectedTotal`.
   */
  boundedTelemetry?: boolean;
}

export interface MatchedTelemetrySample {
  sampleIndex: number;
  tMono: number;
  distanceM: number;
  unwrappedProgressM: number;
  quality: QualityAssessment;
}

export interface RejectedTelemetrySample {
  sampleIndex: number;
  tMono: number;
  level: QualityAssessment['level'];
  reasons: string[];
}

export interface SampleIngestResult {
  sampleIndex: number;
  assessment: QualityAssessment;
  match: TrackMatch | null;
  rejected: RejectedTelemetrySample | null;
  crossings: CrossingEvent[];
  completedLaps: LapRecord[];
  /**
   * Elapsed ms of the lap that was active when this sample arrived (computed
   * BEFORE any crossing this same sample triggers is applied to the timing
   * engine) -- feed straight to `computeDelta`. `null` when no lap is active.
   */
  currentLapElapsedMs: number | null;
  /** True when this sample's crossings included a forward start/finish (a lap boundary). */
  completingStartFinish: boolean;
}

const DEFAULT_PAUSE_GAP_MS = 30_000;
const DEFAULT_LOW_QUALITY_GAP_MS = 10_000;
/** Rolling-window caps applied only when `boundedTelemetry` is set (M2 fix). */
const MAX_MATCHES = 2_000;
const MAX_REJECTED_SAMPLES = 500;
const MAX_STATE_HISTORY = 200;

export interface PipelineComponents {
  qualityEvaluator: TelemetryQualityEvaluator;
  matcher: TrackMatcher;
  crossingDetector: CrossingDetector;
  timingEngine: LapTimingEngine;
  deltaEngine: LiveDeltaEngine;
}

function projectedGates(runtime: RuntimeProfile): ProjectedGate[] {
  const gates = [runtime.startFinishGate, ...runtime.sectorGates];
  if (runtime.pitLane !== undefined) {
    gates.push(runtime.pitLane.entryGate, runtime.pitLane.exitGate);
  }
  return gates.map(({ gate, a, b }) => ({ gate, aLocal: a, bLocal: b }));
}

/** Builds the five stateful pipeline engines from a runtime profile + config. The ONE place both consumers construct them, so they can never drift apart. */
export function createPipelineComponents(
  runtimeProfile: RuntimeProfile,
  config: PipelineCoreConfig = {},
): PipelineComponents {
  const qualityEvaluator = new TelemetryQualityEvaluator(config.quality);
  const matcher = new TrackMatcher(runtimeProfile, {
    ...(config.corridorWidthM === undefined ? {} : { corridorWidthM: config.corridorWidthM }),
    ...config.matcher,
    quality: { ...config.matcher?.quality, ...config.quality },
  });
  const crossingDetector = new CrossingDetector(
    projectedGates(runtimeProfile),
    runtimeProfile.projection,
    config.crossings,
  );
  const timingEngine = new LapTimingEngine(
    {
      totalLengthM: polylineLength(runtimeProfile.centerline),
      startFinishGate: runtimeProfile.startFinishGate.gate,
      sectorGates: runtimeProfile.sectorGates.map(({ gate }) => gate),
    },
    config.timing,
  );
  const deltaEngine = new LiveDeltaEngine(config.delta);
  return { qualityEvaluator, matcher, crossingDetector, timingEngine, deltaEngine };
}

/**
 * Stateful, event-driven processor for ONE session's worth of telemetry.
 * Owns the state-machine snapshot and the five pipeline engines, and exposes
 * `ingest()` to push exactly one `LocationSample` through the full
 * production order. Used two ways:
 *  - `replay/replay-harness.ts`'s `runSessionPipeline` drives it synchronously
 *    over a whole fixture array (batch).
 *  - `controller/sessionController.ts`'s `SessionController` drives it one
 *    sample at a time as a `LocationProvider` emits them (live).
 */
export class SessionPipelineCore {
  private readonly components: PipelineComponents;
  private readonly pauseGapMs: number;
  private readonly lowQualityGapMs: number;
  private readonly boundedTelemetry: boolean;

  private snapshot: SessionMachineSnapshot = createInitialSessionSnapshot();
  private previousQualitySample: LocationSample | undefined;
  private previousMatchedSample: LocationSample | null = null;
  private previousMatch: TrackMatch | null = null;
  private lowQualitySince: number | null = null;
  private pendingPitEntryProgressM: number | null = null;
  private pitEvidenceSamples = 0;
  private sampleCount = 0;

  readonly crossings: CrossingEvent[] = [];
  readonly laps: LapRecord[] = [];
  readonly matches: MatchedTelemetrySample[] = [];
  readonly rejectedSamples: RejectedTelemetrySample[] = [];
  readonly stateHistory: SessionState[] = [];
  readonly appliedInvalidReasons = new Set<string>();
  /** Full lifetime counts, unaffected by `boundedTelemetry` trimming the arrays above -- see M2 fix. */
  matchedTotal = 0;
  rejectedTotal = 0;
  readonly qualityCounts: Record<QualityLevel, number> = {
    good: 0,
    degraded: 0,
    unreliable: 0,
    invalid: 0,
  };
  reverseTravelDetected = false;

  constructor(
    readonly runtimeProfile: RuntimeProfile,
    config: PipelineCoreConfig = {},
  ) {
    this.components = createPipelineComponents(runtimeProfile, config);
    this.pauseGapMs = config.pauseGapMs ?? DEFAULT_PAUSE_GAP_MS;
    this.lowQualityGapMs = config.lowQualityGapMs ?? DEFAULT_LOW_QUALITY_GAP_MS;
    this.boundedTelemetry = config.boundedTelemetry ?? false;
  }

  get state(): SessionMachineSnapshot {
    return this.snapshot;
  }

  setReference(reference: ReferenceLap | null): void {
    this.components.deltaEngine.setReference(reference);
  }

  currentLap(): ReturnType<LapTimingEngine['currentLap']> {
    return this.components.timingEngine.currentLap();
  }

  computeDelta(match: TrackMatch, lapElapsedMs: number): DeltaUpdate {
    return this.components.deltaEngine.onMatch(match, lapElapsedMs);
  }

  dispatch(event: SessionEvent): void {
    this.snapshot = sessionReducer(this.snapshot, event);
    this.stateHistory.push(this.snapshot.state);
    if (this.boundedTelemetry && this.stateHistory.length > MAX_STATE_HISTORY) this.stateHistory.shift();
    this.syncInvalidReasons();
  }

  private invalidateActiveLap(reason: string): void {
    if (this.components.timingEngine.currentLap() === null) return;
    this.appliedInvalidReasons.add(reason);
    this.components.timingEngine.markInvalid(reason);
  }

  private syncInvalidReasons(): void {
    const reasons = this.snapshot.context.pendingInvalidReasons;
    if (!Array.isArray(reasons)) return;
    for (const reason of reasons) {
      if (typeof reason === 'string') this.invalidateActiveLap(reason);
    }
  }

  /** Pushes one `LocationSample` through the full pipeline order (quality -> matcher -> pit/reverse-travel guards -> crossings -> state machine -> timing). */
  ingest(sample: LocationSample): SampleIngestResult {
    const sampleIndex = this.sampleCount;
    this.sampleCount += 1;
    const { qualityEvaluator, matcher, crossingDetector, timingEngine } = this.components;

    const assessment = qualityEvaluator.assess(sample, this.previousQualitySample);
    this.qualityCounts[assessment.level] += 1;

    const gapMs =
      this.previousQualitySample === undefined ? 0 : sample.tMono - this.previousQualitySample.tMono;
    if (gapMs > this.pauseGapMs) {
      this.dispatch({ type: 'PAUSE' });
      this.dispatch({ type: 'RESUME', gapMs });
    }
    if (gapMs > 3_000) {
      this.dispatch({ type: 'GNSS_LOST' });
      if (gapMs > this.lowQualityGapMs) this.invalidateActiveLap('LOW_QUALITY');
      this.dispatch({ type: 'GNSS_RECOVERED' });
    }

    const lowQuality = assessment.level === 'unreliable' || assessment.level === 'invalid';
    if (lowQuality) {
      this.lowQualitySince ??= sample.tMono;
      if (sample.tMono - this.lowQualitySince > this.lowQualityGapMs) this.invalidateActiveLap('LOW_QUALITY');
    } else {
      if (this.lowQualitySince !== null && sample.tMono - this.lowQualitySince > this.lowQualityGapMs) {
        this.invalidateActiveLap('LOW_QUALITY');
      }
      this.lowQualitySince = null;
    }

    const match = matcher.match(sample);
    if (match === null) {
      const rejected: RejectedTelemetrySample = {
        sampleIndex,
        tMono: sample.tMono,
        level: assessment.level,
        reasons: [...assessment.reasons],
      };
      this.rejectedSamples.push(rejected);
      this.rejectedTotal += 1;
      if (this.boundedTelemetry && this.rejectedSamples.length > MAX_REJECTED_SAMPLES) this.rejectedSamples.shift();
      if (assessment.level !== 'invalid') this.previousQualitySample = sample;
      return {
        sampleIndex,
        assessment,
        match: null,
        rejected,
        crossings: [],
        completedLaps: [],
        currentLapElapsedMs: null,
        completingStartFinish: false,
      };
    }

    const matched: MatchedTelemetrySample = {
      sampleIndex,
      tMono: match.tMono,
      distanceM: match.distanceM,
      unwrappedProgressM: match.unwrappedProgressM,
      quality: { level: match.quality.level, reasons: [...match.quality.reasons] },
    };
    this.matches.push(matched);
    this.matchedTotal += 1;
    if (this.boundedTelemetry && this.matches.length > MAX_MATCHES) this.matches.shift();

    if (this.pendingPitEntryProgressM !== null && this.snapshot.state !== 'inPit') {
      if (match.onPitLane && Math.abs(match.lateralM) >= 5) {
        this.pitEvidenceSamples += 1;
        if (this.pitEvidenceSamples >= 2) {
          this.dispatch({ type: 'PIT_ENTERED' });
          this.invalidateActiveLap('PIT_TRANSIT');
          this.pendingPitEntryProgressM = null;
          this.pitEvidenceSamples = 0;
        }
      } else if (!match.onPitLane || Math.abs(match.lateralM) < 3) {
        this.pitEvidenceSamples = 0;
      }
      if (
        this.pendingPitEntryProgressM !== null &&
        match.unwrappedProgressM - this.pendingPitEntryProgressM > 200
      ) {
        this.pendingPitEntryProgressM = null;
        this.pitEvidenceSamples = 0;
      }
    }
    if (
      this.previousMatch !== null &&
      this.previousMatch.unwrappedProgressM - match.unwrappedProgressM > 30
    ) {
      this.reverseTravelDetected = true;
      this.invalidateActiveLap('REVERSE_TRAVEL');
    }

    const detected = crossingDetector.update(this.previousMatch, match, this.previousMatchedSample, sample);
    const completingStartFinish = detected.some(
      (event) => event.kind === 'startFinish' && event.direction === 'forward',
    );
    const currentLap = timingEngine.currentLap();
    const currentLapElapsedMs = currentLap !== null ? currentLap.elapsedMs(sample.tMono) : null;

    const completedLaps: LapRecord[] = [];
    for (const event of detected) {
      this.crossings.push(event);
      this.dispatch({ type: 'CROSSING', event });
      if (event.kind === 'pitEntry' && event.direction === 'forward') {
        this.pendingPitEntryProgressM = event.lapDistanceM;
        this.pitEvidenceSamples = 0;
      } else if (
        event.kind === 'pitExit' &&
        event.direction === 'forward' &&
        this.snapshot.state === 'inPit'
      ) {
        this.dispatch({ type: 'PIT_EXITED' });
        this.pendingPitEntryProgressM = null;
        this.pitEvidenceSamples = 0;
      }
      const completed = timingEngine.onCrossing(event, match.quality.level, this.snapshot.state === 'inPit');
      if (completed !== null) {
        this.laps.push(completed);
        completedLaps.push(completed);
      }
      if (event.kind === 'startFinish' && event.direction === 'forward') this.components.deltaEngine.reset();
      this.syncInvalidReasons();
    }

    this.previousQualitySample = sample;
    this.previousMatchedSample = sample;
    this.previousMatch = match;

    return {
      sampleIndex,
      assessment,
      match,
      rejected: null,
      crossings: detected,
      completedLaps,
      currentLapElapsedMs,
      completingStartFinish,
    };
  }
}
