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
}

function toOutcome(response: Location.PermissionResponse): PermissionOutcome {
  let state: PermissionState;
  if (response.status === Location.PermissionStatus.GRANTED) state = 'granted';
  else if (response.status === Location.PermissionStatus.DENIED) state = 'denied';
  else state = 'undetermined';
  return { state, canAskAgain: response.canAskAgain };
}

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
