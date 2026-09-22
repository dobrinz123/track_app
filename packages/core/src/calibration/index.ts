export { CalibrationEngine } from './calibration-engine';
export type { CalibrationConfig } from './calibration-engine';
export {
  CALIBRATION_MAX_REJECTED_FRACTION,
  CALIBRATION_MAX_UNCOVERED_GAP_M,
  CALIBRATION_MIN_COVERAGE_FRACTION,
  CALIBRATION_MIN_OBSERVED_RATE_HZ,
  DEFAULT_CALIBRATION_COVERAGE_BIN_M,
} from './calibration-engine';
export {
  buildCalibrationAttemptRecord,
  calibrationThresholds,
  explainCalibrationAttempt,
  resolveCalibrationOutcome,
  uncoveredGapOf,
} from './calibrationAttempt';
export type { CalibrationAttemptInput } from './calibrationAttempt';
