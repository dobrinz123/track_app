import type {
  CalibrationResult,
  DeltaUpdate,
  LocationSample,
  QualityAssessment,
  ReferenceLap,
  SessionEvent,
  SessionMachineSnapshot,
  SessionPipelineResult,
  TrackMatch,
} from '../contracts';
import { CalibrationEngine, type CalibrationConfig } from '../calibration';
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

export interface ReplayHarnessConfig {
  calibrateFirst?: readonly LocationSample[];
  referenceLap?: ReferenceLap | null;
  quality?: Partial<TelemetryQualityConfig>;
  matcher?: Partial<TrackMatcherConfig>;
  crossings?: CrossingDetectorConfig;
  timing?: LapTimingEngineConfig;
  delta?: LiveDeltaEngineConfig;
  pauseGapMs?: number;
  lowQualityGapMs?: number;
  endSession?: boolean;
}

export interface ReplayMatchedTelemetry {
  sampleIndex: number;
  tMono: number;
  distanceM: number;
  unwrappedProgressM: number;
  quality: QualityAssessment;
}

export interface ReplayRejectedSample {
  sampleIndex: number;
  tMono: number;
  level: QualityAssessment['level'];
  reasons: string[];
}

const DEFAULT_PAUSE_GAP_MS = 30_000;
const DEFAULT_LOW_QUALITY_GAP_MS = 10_000;

function projectedGates(runtime: RuntimeProfile): ProjectedGate[] {
  const gates = [runtime.startFinishGate, ...runtime.sectorGates];
  if (runtime.pitLane !== undefined) {
    gates.push(runtime.pitLane.entryGate, runtime.pitLane.exitGate);
  }
  return gates.map(({ gate, a, b }) => ({ gate, aLocal: a, bLocal: b }));
}

function alreadyCalibratedResult(runtime: RuntimeProfile): CalibrationResult {
  return {
    accepted: true,
    confidence: 1,
    failureReasons: [],
    appliedBias: { e: 0, n: 0 },
    diagnostics: {
      coverageFraction: 1,
      samplesAccepted: 0,
      samplesRejected: 0,
      rejectionReasons: {},
      meanLateralM: 0,
      p95LateralM: 0,
      estimatedBias: { e: 0, n: 0 },
      directionDetected: inferredDirection(runtime),
      observedRateHz: 0,
    },
  };
}

function inferredDirection(runtime: RuntimeProfile): 'clockwise' | 'counterclockwise' {
  let twiceArea = 0;
  for (let index = 0; index < runtime.centerline.length; index += 1) {
    const current = runtime.centerline[index];
    const next = runtime.centerline[(index + 1) % runtime.centerline.length];
    if (current !== undefined && next !== undefined) {
      twiceArea += current.e * next.n - next.e * current.n;
    }
  }
  return twiceArea < 0 ? 'clockwise' : 'counterclockwise';
}

/** Runs the production calibration engine over a deterministic replay stream. */
export function runCalibration(
  runtimeProfile: RuntimeProfile,
  samples: readonly LocationSample[],
  config: Partial<CalibrationConfig> = {},
): CalibrationResult {
  const engine = new CalibrationEngine(runtimeProfile, config);
  for (const sample of samples) engine.feed(sample);
  return engine.finish();
}

/**
 * Streams samples through the production quality, matching, crossing, state,
 * lap/sector timing, and live-delta modules in their application order.
 */
export function runSessionPipeline(
  runtimeProfile: RuntimeProfile,
  samples: readonly LocationSample[],
  config: ReplayHarnessConfig = {},
): SessionPipelineResult {
  const qualityEvaluator = new TelemetryQualityEvaluator(config.quality);
  const matcher = new TrackMatcher(runtimeProfile, {
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
  deltaEngine.setReference(config.referenceLap ?? null);

  const crossings: SessionPipelineResult['crossings'] = [];
  const laps: SessionPipelineResult['laps'] = [];
  const deltas: DeltaUpdate[] = [];
  const matches: ReplayMatchedTelemetry[] = [];
  const rejectedSamples: ReplayRejectedSample[] = [];
  const qualityAssessments: Array<{ sampleIndex: number; assessment: QualityAssessment }> = [];
  const stateHistory: SessionMachineSnapshot['state'][] = [];
  const appliedInvalidReasons = new Set<string>();
  const qualityCounts: Record<QualityAssessment['level'], number> = {
    good: 0,
    degraded: 0,
    unreliable: 0,
    invalid: 0,
  };
  let snapshot: SessionMachineSnapshot = createInitialSessionSnapshot();
  let previousQualitySample: LocationSample | undefined;
  let previousMatchedSample: LocationSample | null = null;
  let previousMatch: TrackMatch | null = null;
  let lowQualitySince: number | null = null;
  let reverseTravelDetected = false;
  let pendingPitEntryProgressM: number | null = null;
  let pitEvidenceSamples = 0;

  const invalidateActiveLap = (reason: string): void => {
    if (timingEngine.currentLap() === null) return;
    appliedInvalidReasons.add(reason);
    timingEngine.markInvalid(reason);
  };

  const syncInvalidReasons = (): void => {
    const reasons = snapshot.context.pendingInvalidReasons;
    if (!Array.isArray(reasons)) return;
    for (const reason of reasons) {
      if (typeof reason === 'string') invalidateActiveLap(reason);
    }
  };
  const dispatch = (event: SessionEvent): void => {
    snapshot = sessionReducer(snapshot, event);
    stateHistory.push(snapshot.state);
    syncInvalidReasons();
  };

  dispatch({ type: 'START_PREFLIGHT' });
  dispatch({ type: 'PREFLIGHT_PASSED' });
  dispatch({ type: 'CALIBRATION_STARTED' });
  const calibration =
    config.calibrateFirst === undefined
      ? alreadyCalibratedResult(runtimeProfile)
      : runCalibration(runtimeProfile, config.calibrateFirst);
  dispatch({ type: 'CALIBRATION_FINISHED', result: calibration });
  dispatch({ type: calibration.accepted ? 'CALIBRATION_ACCEPTED' : 'CALIBRATION_REJECTED' });

  const pauseGapMs = config.pauseGapMs ?? DEFAULT_PAUSE_GAP_MS;
  const lowQualityGapMs = config.lowQualityGapMs ?? DEFAULT_LOW_QUALITY_GAP_MS;

  samples.forEach((sample, sampleIndex) => {
    const assessment = qualityEvaluator.assess(sample, previousQualitySample);
    qualityCounts[assessment.level] += 1;
    qualityAssessments.push({
      sampleIndex,
      assessment: { level: assessment.level, reasons: [...assessment.reasons] },
    });

    const gapMs =
      previousQualitySample === undefined ? 0 : sample.tMono - previousQualitySample.tMono;
    if (gapMs > pauseGapMs) {
      dispatch({ type: 'PAUSE' });
      dispatch({ type: 'RESUME', gapMs });
    }
    if (gapMs > 3_000) {
      dispatch({ type: 'GNSS_LOST' });
      if (gapMs > lowQualityGapMs) invalidateActiveLap('LOW_QUALITY');
      dispatch({ type: 'GNSS_RECOVERED' });
    }

    const lowQuality = assessment.level === 'unreliable' || assessment.level === 'invalid';
    if (lowQuality) {
      lowQualitySince ??= sample.tMono;
      if (sample.tMono - lowQualitySince > lowQualityGapMs) invalidateActiveLap('LOW_QUALITY');
    } else {
      if (lowQualitySince !== null && sample.tMono - lowQualitySince > lowQualityGapMs) {
        invalidateActiveLap('LOW_QUALITY');
      }
      lowQualitySince = null;
    }

    const match = matcher.match(sample);
    if (match === null) {
      rejectedSamples.push({
        sampleIndex,
        tMono: sample.tMono,
        level: assessment.level,
        reasons: [...assessment.reasons],
      });
      if (assessment.level !== 'invalid') previousQualitySample = sample;
      return;
    }

    matches.push({
      sampleIndex,
      tMono: match.tMono,
      distanceM: match.distanceM,
      unwrappedProgressM: match.unwrappedProgressM,
      quality: { level: match.quality.level, reasons: [...match.quality.reasons] },
    });
    if (pendingPitEntryProgressM !== null && snapshot.state !== 'inPit') {
      if (match.onPitLane && Math.abs(match.lateralM) >= 5) {
        pitEvidenceSamples += 1;
        if (pitEvidenceSamples >= 2) {
          dispatch({ type: 'PIT_ENTERED' });
          invalidateActiveLap('PIT_TRANSIT');
          pendingPitEntryProgressM = null;
          pitEvidenceSamples = 0;
        }
      } else if (!match.onPitLane || Math.abs(match.lateralM) < 3) {
        pitEvidenceSamples = 0;
      }
      if (
        pendingPitEntryProgressM !== null &&
        match.unwrappedProgressM - pendingPitEntryProgressM > 200
      ) {
        pendingPitEntryProgressM = null;
        pitEvidenceSamples = 0;
      }
    }
    if (
      previousMatch !== null &&
      previousMatch.unwrappedProgressM - match.unwrappedProgressM > 30
    ) {
      reverseTravelDetected = true;
      invalidateActiveLap('REVERSE_TRAVEL');
    }

    const detected = crossingDetector.update(previousMatch, match, previousMatchedSample, sample);
    const completingStartFinish = detected.some(
      (event) => event.kind === 'startFinish' && event.direction === 'forward',
    );
    const currentLap = timingEngine.currentLap();
    if (currentLap !== null && !completingStartFinish && config.referenceLap != null) {
      deltas.push(deltaEngine.onMatch(match, currentLap.elapsedMs(sample.tMono)));
    }

    for (const event of detected) {
      crossings.push(event);
      dispatch({ type: 'CROSSING', event });
      if (event.kind === 'pitEntry' && event.direction === 'forward') {
        pendingPitEntryProgressM = event.lapDistanceM;
        pitEvidenceSamples = 0;
      } else if (
        event.kind === 'pitExit' &&
        event.direction === 'forward' &&
        snapshot.state === 'inPit'
      ) {
        dispatch({ type: 'PIT_EXITED' });
        pendingPitEntryProgressM = null;
        pitEvidenceSamples = 0;
      }
      const completed = timingEngine.onCrossing(
        event,
        match.quality.level,
        snapshot.state === 'inPit',
      );
      if (completed !== null) laps.push(completed);
      if (event.kind === 'startFinish' && event.direction === 'forward') deltaEngine.reset();
      syncInvalidReasons();
    }

    previousQualitySample = sample;
    previousMatchedSample = sample;
    previousMatch = match;
  });

  if (config.endSession !== false) dispatch({ type: 'END_SESSION' });
  return {
    laps,
    finalState: snapshot.state,
    crossings,
    ...(config.calibrateFirst === undefined ? {} : { calibration }),
    deltas,
    diagnostics: {
      calibrationMode:
        config.calibrateFirst === undefined ? 'precalibrated-profile' : 'recognition-lap',
      qualityCounts,
      qualityAssessments,
      rejectedSamples,
      matches,
      stateHistory,
      reverseTravelDetected,
      appliedInvalidReasons: [...appliedInvalidReasons],
      activeLap: timingEngine.currentLap()?.lapNumber ?? null,
      samplesProcessed: samples.length,
    },
  };
}
