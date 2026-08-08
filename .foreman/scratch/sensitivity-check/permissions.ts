import * as Location from 'expo-location';

/**
 * Rationale copy to show the user (e.g. in a pre-prompt dialog) before
 * triggering the OS permission prompt via {@link requestForegroundLocationPermission}.
 */
export const LOCATION_PERMISSION_RATIONALE =
  'Circuit Timer needs your location while the app is open, to time your laps and sectors ' +
  'on track. Location is only used during an active session and never in the background.';

export type PermissionState = 'granted' | 'denied' | 'undetermined';

export interface PermissionOutcome {
  state: PermissionState;
  /** false means the user must be sent to OS Settings; the in-app prompt is exhausted. */
  canAskAgain: boolean;
  /**
   * iOS 14+ accuracy authorization (`LocationPermissionResponse.ios.accuracy` per
   * `node_modules/expo-location/build/Location.types.d.ts` — `PermissionDetailsLocationIOS`):
   * `'full'` = precise location granted, `'reduced'` = the user has Precise
   * Location off for this app. `undefined` on Android/web, or before the
   * response includes the `ios` field.
   * @platform ios
   */
  iosAccuracy?: 'full' | 'reduced';
}

/**
 * Accepts `LocationPermissionResponse` (the actual return type of both
 * `requestForegroundPermissionsAsync` and `getForegroundPermissionsAsync`) so
 * the iOS-only `ios.accuracy` field is available; `LocationPermissionResponse`
 * extends `PermissionResponse` so all existing callers are unaffected.
 */
function toOutcome(response: Location.LocationPermissionResponse): PermissionOutcome {
  let state: PermissionState;
  if (response.status === Location.PermissionStatus.GRANTED) state = 'granted';
  else if (response.status === Location.PermissionStatus.DENIED) state = 'denied';
  else state = 'undetermined';
  return { state, canAskAgain: response.canAskAgain, iosAccuracy: response.ios?.accuracy };
}

/**
 * User-facing instructions for turning Precise Location back on, per
 * ADR-0003 §2. Precise location is functionally required (lap/sector timing
 * needs GNSS-grade accuracy, not the ~1900 m reduced-accuracy radius) so this
 * is surfaced as a preflight failure rather than silently degraded — see
 * `preflight.ts`'s `PRECISE_LOCATION_OFF` failure code.
 *
 * Gap (checked against `node_modules/expo-location/build/Location.d.ts`,
 * SDK 57): expo-location exposes no JS equivalent of
 * `CLLocationManager.requestTemporaryFullAccuracyAuthorization(withPurposeKey:)`
 * — no such function is exported. There is nothing to "wire up"; the only
 * available levers are (a) the `NSLocationTemporaryUsageDescriptionDictionary`
 * Info.plist entry (see `app.json`, purpose key `TrackSession`), which lets
 * iOS itself decide whether to prompt for temporary full accuracy when the
 * app requests location, and (b) this preflight message directing the user
 * to Settings when it doesn't.
 */
export const PRECISE_LOCATION_INSTRUCTIONS =
  'Turn on Precise Location for Circuit Timer: Settings > Privacy & Security > Location Services > ' +
  'Circuit Timer > Precise Location.';

/**
 * Foreground location permission flow.
 *
 * MVP scope note (binding for this ticket — see MUST DO #5 and
 * `.foreman/scratch/platform-research.md` §3 "Google Play Background Location
 * Policy (April 2026 Update)" and §1 "Foreground-Only Constraint"):
 * this module deliberately never requests
 * `Location.requestBackgroundPermissionsAsync()`. Reasons:
 *  1. Play policy (enforced from late Oct 2026 for Android 17+ targets)
 *     restricts background location to core-function/user-initiated use and
 *     adds Play Console review friction that is not worth taking on for MVP.
 *  2. It isn't needed: sessions run with the screen on and
 *     `expo-keep-awake` active the entire time, so foreground-only
 *     `watchPositionAsync` covers the full session lifecycle. Background
 *     delivery would only matter if the driver could background the app
 *     mid-session, which the MVP UX does not support (see `lifecycle.ts`,
 *     which pauses/flags the session instead of trying to keep tracking
 *     while backgrounded).
 */
export async function requestForegroundLocationPermission(): Promise<PermissionOutcome> {
  const response = await Location.requestForegroundPermissionsAsync();
  return toOutcome(response);
}

/** Reads current foreground permission state without prompting the user. */
export async function getPermissionState(): Promise<PermissionOutcome> {
  const response = await Location.getForegroundPermissionsAsync();
  return toOutcome(response);
}
