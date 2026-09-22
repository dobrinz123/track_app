export * from './contracts';

// A trivial, non-domain runtime value (package identity marker). Interfaces and
// type aliases in contracts.ts are erased at compile time, so a pure type-only
// import cannot prove @circuit/core is actually resolved and bundled by a
// consumer's build tool (e.g. Metro). This constant exists solely so
// apps/mobile can perform a real *value* import to verify that wiring.
export const CORE_PACKAGE_ID = '@circuit/core' as const;

// ---------------------------------------------------------------------------
// Module re-exports. `contracts.ts` above carries the binding interfaces;
// everything below is the concrete, tested implementation apps/mobile
// consumes. One place, wired once, per module -- see docs/architecture/
// current-state.md's module map for what each directory owns.
//
// A handful of concrete classes intentionally share a name with the
// `contracts.ts` interface they implement (e.g. the `TrackMatcher` class vs.
// the `TrackMatcher` interface) -- `export *` cannot re-export an ambiguous
// name, so those modules are re-exported explicitly below instead of via
// `export *`, which resolves in favor of the concrete implementation (the
// interfaces remain reachable via `./contracts` for anyone typing against
// the abstract contract). `ProjectedGate` similarly exists as two distinct,
// unrelated shapes in `profile` and `timing`; the `timing` one is renamed on
// the way out to avoid shadowing `profile`'s.
// ---------------------------------------------------------------------------

export * from './geometry';
export * from './signal';
export * from './fusion';
export * from './profile';
export * from './catalog';
export * from './corners';

export {
  CoachEngine,
  DEFAULT_BRAKING_ZONE_CONFIG,
  DEFAULT_COACH_ENGINE_CONFIG,
  deriveBrakingZones,
} from './coach';
export type { BrakingZoneConfig, CoachEngineConfig } from './coach';

export {
  DEFAULT_TELEMETRY_QUALITY_CONFIG,
  TelemetryQualityEvaluator,
  TrackMatcher,
} from './matching';
export type { TelemetryQualityConfig, TrackMatcherConfig } from './matching';

export { CalibrationEngine } from './calibration';
export type { CalibrationConfig } from './calibration';
// Ticket P12 item B: the named acceptance bars and the pure attempt-record
// builder. Exported separately from `export * from './calibration'` because
// that barrel's `CalibrationEngine` collides with the contracts interface of
// the same name (see this file's header comment).
export {
  CALIBRATION_MAX_REJECTED_FRACTION,
  CALIBRATION_MAX_UNCOVERED_GAP_M,
  CALIBRATION_MIN_COVERAGE_FRACTION,
  CALIBRATION_MIN_OBSERVED_RATE_HZ,
  DEFAULT_CALIBRATION_COVERAGE_BIN_M,
  buildCalibrationAttemptRecord,
  calibrationThresholds,
  explainCalibrationAttempt,
  resolveCalibrationOutcome,
  uncoveredGapOf,
} from './calibration';
export type { CalibrationAttemptInput } from './calibration';

export { CrossingDetector, LapTimingEngine } from './timing';
export type {
  CrossingDetectorConfig,
  LapTimingEngineConfig,
  LapTimingProfile,
  ProjectedGate as TimingProjectedGate,
} from './timing';

export * from './statemachine';
export * from './persistence';
export * from './persistence-sql';

export {
  buildReferenceLap,
  shouldReplacePb,
  LiveDeltaEngine,
  referenceCompleteness,
  referenceElapsedAt,
} from './reference';
export type {
  BuildReferenceLapInput,
  BuildReferenceLapResult,
  ReferenceLapBuildError,
  ReferenceLapProvenance,
  ReferenceTelemetrySample,
  PersonalBestCandidate,
  PersonalBestCandidateAliases,
  PersonalBestCandidateInput,
  LiveDeltaEngineConfig,
} from './reference';

export * from './coaching';
export * from './fixtures';
export * from './replay';
export * from './controller';
export * from './telemetry';
// Phase 5d Test Loop mode: learning an ad-hoc circuit from lap 1.
export * from './testloop';
