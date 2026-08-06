import type {
  CalibrationResult,
  DeltaUpdate,
  LocationSample,
  QualityAssessment,
  ReferenceLap,
  SessionPipelineResult,
} from '../contracts';
import { CalibrationEngine, type CalibrationConfig } from '../calibration';
import { type TelemetryQualityConfig, type TrackMatcherConfig } from '../matching';
import type { RuntimeProfile } from '../profile';
import { type LiveDeltaEngineConfig } from '../reference';
import {
  SessionPipelineCore,
  type MatchedTelemetrySample,
  type RejectedTelemetrySample,
} from '../controller/pipelineCore';
import { type CrossingDetectorConfig, type LapTimingEngineConfig } from '../timing';

export interface ReplayHarnessConfig {
  calibrateFirst?: readonly LocationSample[];
  referenceLap?: ReferenceLap | null;
  /**
   * Base corridor width (meters) -- `CircuitProfile.corridorWidthM` wiring
   * (MUST DO #1). Applied as the base for BOTH the live matcher (via
   * `SessionPipelineCore`'s `PipelineCoreConfig.corridorWidthM`) and, when
   * `calibrateFirst` is set, the recognition-lap `CalibrationEngine`
   * (`runCalibration`'s own `corridorWidthM` config). An explicit
   * `matcher.corridorWidthM` still wins for the matcher.
   */
  corridorWidthM?: number;
  quality?: Partial<TelemetryQualityConfig>;
  matcher?: Partial<TrackMatcherConfig>;
  crossings?: CrossingDetectorConfig;
  timing?: LapTimingEngineConfig;
  delta?: LiveDeltaEngineConfig;
  pauseGapMs?: number;
  lowQualityGapMs?: number;
  endSession?: boolean;
}

/** @deprecated kept as a name-compatible alias -- see `MatchedTelemetrySample` in `../controller/pipelineCore`. */
export type ReplayMatchedTelemetry = MatchedTelemetrySample;
/** @deprecated kept as a name-compatible alias -- see `RejectedTelemetrySample` in `../controller/pipelineCore`. */
export type ReplayRejectedSample = RejectedTelemetrySample;

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
 * lap/sector timing, and live-delta modules in their application order, via
 * the shared `SessionPipelineCore` (`../controller/pipelineCore`) -- the same
 * per-sample processing `SessionController` drives live, so the two can never
 * diverge on pipeline behavior.
 */
export function runSessionPipeline(
  runtimeProfile: RuntimeProfile,
  samples: readonly LocationSample[],
  config: ReplayHarnessConfig = {},
): SessionPipelineResult {
  const core = new SessionPipelineCore(runtimeProfile, {
    corridorWidthM: config.corridorWidthM,
    quality: config.quality,
    matcher: config.matcher,
    crossings: config.crossings,
    timing: config.timing,
    delta: config.delta,
    pauseGapMs: config.pauseGapMs,
    lowQualityGapMs: config.lowQualityGapMs,
  });
  core.setReference(config.referenceLap ?? null);

  const deltas: DeltaUpdate[] = [];
  const qualityAssessments: Array<{ sampleIndex: number; assessment: QualityAssessment }> = [];

  core.dispatch({ type: 'START_PREFLIGHT' });
  core.dispatch({ type: 'PREFLIGHT_PASSED' });
  core.dispatch({ type: 'CALIBRATION_STARTED' });
  const calibration =
    config.calibrateFirst === undefined
      ? alreadyCalibratedResult(runtimeProfile)
      : runCalibration(
          runtimeProfile,
          config.calibrateFirst,
          config.corridorWidthM === undefined ? {} : { corridorWidthM: config.corridorWidthM },
        );
  core.dispatch({ type: 'CALIBRATION_FINISHED', result: calibration });
  core.dispatch({ type: calibration.accepted ? 'CALIBRATION_ACCEPTED' : 'CALIBRATION_REJECTED' });

  for (const sample of samples) {
    const result = core.ingest(sample);
    qualityAssessments.push({
      sampleIndex: result.sampleIndex,
      assessment: { level: result.assessment.level, reasons: [...result.assessment.reasons] },
    });
    if (
      result.match !== null &&
      result.currentLapElapsedMs !== null &&
      !result.completingStartFinish &&
      config.referenceLap != null
    ) {
      deltas.push(core.computeDelta(result.match, result.currentLapElapsedMs));
    }
  }

  if (config.endSession !== false) core.dispatch({ type: 'END_SESSION' });

  return {
    laps: core.laps,
    finalState: core.state.state,
    crossings: core.crossings,
    ...(config.calibrateFirst === undefined ? {} : { calibration }),
    deltas,
    diagnostics: {
      calibrationMode:
        config.calibrateFirst === undefined ? 'precalibrated-profile' : 'recognition-lap',
      qualityCounts: core.qualityCounts,
      qualityAssessments,
      rejectedSamples: core.rejectedSamples,
      matches: core.matches,
      stateHistory: core.stateHistory,
      reverseTravelDetected: core.reverseTravelDetected,
      appliedInvalidReasons: [...core.appliedInvalidReasons],
      activeLap: core.currentLap()?.lapNumber ?? null,
      samplesProcessed: samples.length,
    },
  };
}
