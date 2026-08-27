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

/**
 * P4h-FIX1 H1 (binding, after Codex P4h-REV1 HIGH,
 * `ActiveCalibrationScreen.tsx:73-98`): "confirming header/gesture
 * cancellation cannot navigate away. `beforeRemove` intercepts every
 * `GO_BACK`; `confirmCancelExit()` redispatches that same action without an
 * allow-once flag, so the listener prevents it again and reopens the confirm
 * card." The screen holds ONE of these (in a ref) for its whole lifetime and
 * asks it on every `beforeRemove` event; confirming arms a ONE-SHOT bypass so
 * the replayed action -- and only that one -- passes straight through.
 */
export interface CalibrationExitInterceptor {
  /** `true` -> `e.preventDefault()` + open the confirm card. Consumes an armed bypass when the action is an implicit back. */
  shouldIntercept(actionType: string): boolean;
  /** "Cancel Calibration" confirmed: the next implicit back is allowed through. */
  allowNext(): void;
  /** "Keep Calibrating" / dismiss: disarms any armed bypass. */
  reset(): void;
}

export function createCalibrationExitInterceptor(): CalibrationExitInterceptor {
  let allowOnce = false;
  return {
    shouldIntercept(actionType: string): boolean {
      // A programmatic navigation (`REPLACE`, from the sticky Cancel button or
      // the calibration-complete effect) is never intercepted -- and never
      // consumes the armed one-shot either, so a confirmed back still gets
      // through if one happens to interleave.
      if (!shouldConfirmCalibrationExit(actionType === 'GO_BACK' ? 'header-back' : 'calibration-complete')) {
        return false;
      }
      if (allowOnce) {
        allowOnce = false;
        return false;
      }
      return true;
    },
    allowNext(): void {
      allowOnce = true;
    },
    reset(): void {
      allowOnce = false;
    },
  };
}
