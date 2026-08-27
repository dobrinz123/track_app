/**
 * Phase 5 deterministic analysis engine (`docs/architecture/analysis-engine.md`,
 * contracts.md "Phase 5 REVISION"): pure, on-device, no LLM and no network.
 * Distance-domain alignment -> per-corner metrics -> clean-lap classification ->
 * demonstrated envelope -> session insights -> RO/EN report text.
 */
export {
  DEFAULT_GRID_STEP_M,
  DEFAULT_MAX_BRIDGE_M,
  assertPositiveLength,
  deltaCurveMs,
  deltaOverSegmentMs,
  forwardDistance,
  inDistanceWindow,
  joinTelemetryChannels,
  normalizeDistance,
  projectLapSamples,
  resampleLapToDistanceGrid,
  windowWraps,
} from './distanceDomain';
export type {
  DistanceGrid,
  DistanceGridOptions,
  JoinChannelsOptions,
  ProjectLapOptions,
  ProjectedLap,
} from './distanceDomain';

export { channelAvailability, computeCornerMetrics, cornerWindows } from './cornerMetrics';
export type { CornerMetricsOptions, CornerWindows } from './cornerMetrics';

export { classifyLap } from './cleanLap';
export type { ClassifyLapOptions } from './cleanLap';

export {
  ENVELOPE_APPROACH_EXCLUDING_FLAGS,
  ENVELOPE_CORNER_EXCLUDING_FLAGS,
  buildDemonstratedEnvelope,
} from './envelope';
export type { CornerEnvelope, DemonstratedEnvelope } from './envelope';

export {
  CONSISTENCY_BRAKE_SPREAD_M,
  CONSISTENCY_LAP_SPREAD_MS,
  CONSISTENCY_MIN_SPEED_SPREAD_KPH,
  CONSISTENCY_SECTOR_SPREAD_MS,
  MIN_CLEAN_LAPS_FOR_COMPARISON,
  analyzeSession,
} from './sessionInsights';
export type {
  ConsistencyComponent,
  ConsistencyFinding,
  CornerInsight,
  CornerLapRow,
  LapInsight,
  LapTimeConsistency,
  Limitation,
  LimitationCode,
  SectorLossFinding,
  SessionAnalysisContext,
  SessionInsights,
  SessionLapInput,
  TimeLossCause,
  TimeLossFinding,
} from './sessionInsights';

export { buildReport, renderReport } from './reportText';
export type { CoachReport, ReportLanguage, ReportSection } from './reportText';

export { ANALYSIS_CHANNELS, GRAVITY_MPS2 } from './types';
export type {
  BrakeSource,
  ChannelAvailability,
  ClassifiableLap,
  CleanLapMetrics,
  CoachingChannelId,
  CornerLapSample,
  CornerMetrics,
  CornerQuality,
  CornerQualityFlag,
  LapAnomalyReason,
  LapCheckId,
  LapClassification,
  LapStatus,
  LiftSource,
  ThrottleOnSource,
  TurnInSource,
} from './types';
