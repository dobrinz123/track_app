/**
 * Field revision 2 (2026-08-27, binding — Phase 4h, "calibration escape"):
 * "calibration started 61 km from MotorPark ... with the Cancel button below
 * the fold and no header back -> user felt stuck." `ActiveCalibrationScreen`
 * now enables the header back button/gesture instead of blocking it
 * entirely — but an accidental tap/swipe must not silently abort a Learn lap
 * in progress, so it is intercepted with a confirm prompt. This module owns
 * the pure "should we intercept and confirm" decision so it's directly
 * unit-testable without mounting the screen or driving React Navigation.
 */

export const CALIBRATION_CANCEL_CONFIRM_TITLE = 'Cancel calibration?';
export const CALIBRATION_CANCEL_CONFIRM_BODY =
  'Your Learn lap progress will be lost. You can restart calibration afterward.';

/**
 * The four ways this screen can be left:
 * - `'header-back'` / `'gesture-back'`: the driver tapping the (now-enabled)
 *   header chevron, or the edge-swipe-back gesture -- both dispatch the SAME
 *   underlying `GO_BACK` navigation action, and both are an IMPLICIT,
 *   possibly-accidental exit that must be confirmed.
 * - `'cancel-button'`: the sticky-footer "Cancel Calibration" long-press
 *   button -- the 1.2s hold IS the explicit confirmation; prompting again
 *   would be redundant and only add friction to the one button this screen
 *   is now specifically NOT supposed to bury below the fold.
 * - `'calibration-complete'`: calibration reached a result naturally (not a
 *   cancellation at all) -- must never be intercepted.
 */
export type CalibrationExitTrigger = 'header-back' | 'gesture-back' | 'cancel-button' | 'calibration-complete';

/**
 * Pure decision: does this exit attempt need a confirm prompt first? Only an
 * implicit back (header chevron or the edge-swipe gesture) does.
 */
export function shouldConfirmCalibrationExit(trigger: CalibrationExitTrigger): boolean {
  return trigger === 'header-back' || trigger === 'gesture-back';
}
