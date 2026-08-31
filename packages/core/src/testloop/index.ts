/**
 * Test Loop mode (Phase 5d) -- learning a circuit from lap 1.
 *
 * Pure geometry and arithmetic: no persistence, no UI, no session wiring.
 * `apps/mobile` drives this module with a live GNSS trace; the tests drive it
 * with synthetic ones. See `docs/architecture/contracts.md` "Test Loop mode
 * (Phase 5d)".
 */
export {
  DEFAULT_TEST_LOOP_CONFIG,
  MAX_TEST_LOOP_CORNERS,
  resolveTestLoopConfig,
} from './config';
export type { TestLoopConfig, TestLoopConfigOverrides } from './config';

export {
  detectLoopClosure,
  evaluateLoopClosure,
  headingDifferenceDeg,
  qualifiedLapSamples,
  qualifyTrack,
  toLocalTrack,
} from './loopClosure';
export type {
  LoopClosure,
  LoopClosureFailureReason,
  LoopClosureResult,
  QualifiedFix,
  QualifiedTrack,
} from './loopClosure';

export { buildLoopCentreline, overlapFractionOf } from './centreline';
export type { LoopCentreline } from './centreline';

export { deriveTestLoopCorners, findSpeedDropWindows } from './syntheticCorners';
export type { SpeedDropWindow, TestLoopCornerDerivation } from './syntheticCorners';

export {
  TEST_LOOP_GEOMETRY_STATUS,
  TEST_LOOP_LAYOUT_ID,
  TEST_LOOP_LAYOUT_VERSION,
  buildTestLoopCircuit,
  isLearnedGeometry,
} from './testLoopCircuit';
export type {
  BuildTestLoopCircuitOptions,
  BuildTestLoopCircuitResult,
  TestLoopCircuit,
  TestLoopFailureReason,
} from './testLoopCircuit';

export {
  LEARNED_CIRCUIT_ENVELOPE_VERSION,
  decodeLearnedCircuit,
  encodeLearnedCircuit,
} from './codec';
export type { DecodedLearnedCircuit, LearnedCircuitEnvelope } from './codec';
