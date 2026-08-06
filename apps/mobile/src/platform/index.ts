/**
 * Mobile platform integration layer: adapts device GNSS, motion sensors, the
 * monotonic clock, permissions, preflight checks, and app-lifecycle events to
 * the `@circuit/core` provider contracts (`docs/architecture/contracts.md`).
 *
 * Platform evidence backing the choices in this directory is recorded in
 * `.foreman/scratch/platform-research.md` (Expo SDK 57); individual modules
 * cite the specific section their caveat comes from.
 */

export { PerformanceNowClock } from './clock';

export { GnssLocationProvider, type GnssDiagnostics } from './gnssLocationProvider';

export { ReplayLocationProvider, type ReplayOptions } from './replayLocationProvider';

export {
  createMotionCapture,
  type MotionCapture,
  type MotionCaptureOptions,
  type MotionSample,
} from './motionCapture';

export {
  LOCATION_PERMISSION_RATIONALE,
  requestForegroundLocationPermission,
  getPermissionState,
  type PermissionState,
  type PermissionOutcome,
} from './permissions';

export {
  GNSS_FIX_TIMEOUT_MS,
  GNSS_FIX_ACCURACY_THRESHOLD_M,
  BATTERY_CRITICAL_THRESHOLD,
  evaluatePreflight,
  runPreflightChecks,
  collectLocationServicesEnabled,
  collectPermissionGranted,
  collectGnssFix,
  collectBatteryCheck,
  collectKeepAwakeActivatable,
  type PreflightInputs,
  type PreflightDecision,
  type PreflightReport,
  type GnssFixResult,
  type BatteryCheckResult,
} from './preflight';

export { startLifecycleListener, type LifecycleCallbacks, type LifecycleController } from './lifecycle';
