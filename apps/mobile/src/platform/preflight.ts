import * as Location from 'expo-location';
import { isAvailableAsync as isKeepAwakeAvailableAsync } from 'expo-keep-awake';
import { getPermissionState } from './permissions';

/** GNSS fix acquisition timeout, per MUST DO #6. */
export const GNSS_FIX_TIMEOUT_MS = 30_000;
/** GNSS fix "acquired" accuracy threshold, per MUST DO #6. */
export const GNSS_FIX_ACCURACY_THRESHOLD_M = 25;
/** Below this fraction (15%), battery is treated as critically low. */
export const BATTERY_CRITICAL_THRESHOLD = 0.15;

export interface BatteryCheckResult {
  /** Whether an optional battery module was resolvable at runtime. */
  available: boolean;
  criticallyLow: boolean;
}

export interface GnssFixResult {
  acquired: boolean;
  accuracyM: number | null;
}

/**
 * Inputs to the pure decision function {@link evaluatePreflight}, gathered by
 * the async collectors below. Kept as a plain data shape (no promises, no I/O)
 * so `evaluatePreflight` is trivially unit-testable per MUST DO #6.
 */
export interface PreflightInputs {
  locationServicesEnabled: boolean;
  permissionGranted: boolean;
  gnssFix: GnssFixResult;
  battery: BatteryCheckResult;
  keepAwakeActivatable: boolean;
}

export interface PreflightDecision {
  pass: boolean;
  failures: string[];
}

export type PreflightReport = PreflightInputs & PreflightDecision;

/**
 * Pure, synchronous decision function — no expo/async imports — so it can be
 * exercised with plain fixtures without mocking any native module.
 */
export function evaluatePreflight(inputs: PreflightInputs): PreflightDecision {
  const failures: string[] = [];
  if (!inputs.locationServicesEnabled) failures.push('LOCATION_SERVICES_DISABLED');
  if (!inputs.permissionGranted) failures.push('LOCATION_PERMISSION_NOT_GRANTED');
  if (!inputs.gnssFix.acquired) failures.push('GNSS_FIX_TIMEOUT');
  if (inputs.battery.available && inputs.battery.criticallyLow) failures.push('BATTERY_CRITICALLY_LOW');
  if (!inputs.keepAwakeActivatable) failures.push('KEEP_AWAKE_UNAVAILABLE');
  return { pass: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Async collectors — each isolates one native-module call so a single failing
// check can't take down the rest of the report.
// ---------------------------------------------------------------------------

export async function collectLocationServicesEnabled(): Promise<boolean> {
  try {
    return await Location.hasServicesEnabledAsync();
  } catch {
    return false;
  }
}

export async function collectPermissionGranted(): Promise<boolean> {
  const outcome = await getPermissionState();
  return outcome.state === 'granted';
}

/**
 * Subscribes to `watchPositionAsync` and resolves as soon as a sample with
 * `accuracyM <= GNSS_FIX_ACCURACY_THRESHOLD_M` arrives, or after
 * `timeoutMs` — whichever is first (MUST DO #6).
 */
export function collectGnssFix(
  timeoutMs: number = GNSS_FIX_TIMEOUT_MS,
  accuracyThresholdM: number = GNSS_FIX_ACCURACY_THRESHOLD_M,
): Promise<GnssFixResult> {
  return new Promise<GnssFixResult>((resolve) => {
    let settled = false;
    let subscription: Location.LocationSubscription | null = null;

    const finish = (result: GnssFixResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.remove();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ acquired: false, accuracyM: null }), timeoutMs);

    Location.watchPositionAsync(
      { accuracy: Location.LocationAccuracy.BestForNavigation, timeInterval: 0, distanceInterval: 0 },
      (location) => {
        const accuracyM = location.coords.accuracy;
        if (accuracyM !== null && accuracyM <= accuracyThresholdM) {
          finish({ acquired: true, accuracyM });
        }
      },
    )
      .then((sub) => {
        subscription = sub;
        if (settled) subscription.remove();
      })
      .catch(() => finish({ acquired: false, accuracyM: null }));
  });
}

/**
 * Minimal shape of the subset of `expo-battery`'s API this check needs.
 * Not imported from the `expo-battery` package — see {@link loadOptionalBatteryModule}.
 */
interface BatteryModuleLike {
  getBatteryLevelAsync(): Promise<number>;
}

/**
 * Attempts to load `expo-battery` WITHOUT it being a declared dependency
 * (MUST DO #6 / MUST NOT: no dependency beyond the five listed). The module
 * id is passed through a variable rather than a string literal so neither
 * TypeScript nor Metro statically resolve/bundle it as a hard dependency;
 * at runtime, if the package isn't installed, the dynamic import rejects and
 * this resolves `null`, and the battery check is skipped entirely.
 */
async function loadOptionalBatteryModule(): Promise<BatteryModuleLike | null> {
  const optionalModuleId = 'expo-battery';
  try {
    const mod = (await import(optionalModuleId)) as unknown as Partial<BatteryModuleLike>;
    if (typeof mod?.getBatteryLevelAsync !== 'function') return null;
    return mod as BatteryModuleLike;
  } catch {
    return null;
  }
}

export async function collectBatteryCheck(): Promise<BatteryCheckResult> {
  const battery = await loadOptionalBatteryModule();
  if (!battery) return { available: false, criticallyLow: false };
  try {
    const level = await battery.getBatteryLevelAsync();
    return { available: true, criticallyLow: level >= 0 && level < BATTERY_CRITICAL_THRESHOLD };
  } catch {
    return { available: false, criticallyLow: false };
  }
}

export async function collectKeepAwakeActivatable(): Promise<boolean> {
  try {
    return await isKeepAwakeAvailableAsync();
  } catch {
    return false;
  }
}

/** Runs every async collector and folds the result through {@link evaluatePreflight}. */
export async function runPreflightChecks(): Promise<PreflightReport> {
  const [locationServicesEnabled, permissionGranted, gnssFix, battery, keepAwakeActivatable] = await Promise.all([
    collectLocationServicesEnabled(),
    collectPermissionGranted(),
    collectGnssFix(),
    collectBatteryCheck(),
    collectKeepAwakeActivatable(),
  ]);

  const inputs: PreflightInputs = {
    locationServicesEnabled,
    permissionGranted,
    gnssFix,
    battery,
    keepAwakeActivatable,
  };
  const decision = evaluatePreflight(inputs);
  return { ...inputs, ...decision };
}
