import { describe, expect, it } from 'vitest';
import {
  createCalibrationExitInterceptor,
  shouldConfirmCalibrationExit,
  type CalibrationExitTrigger,
} from '../../src/session/calibrationEscape';

/**
 * Field revision 2 (2026-08-27, binding — Phase 4h, P4h ticket item 2):
 * "calibration escape" -- the header back button/gesture is now enabled on
 * ActiveCalibrationScreen (previously fully blocked), gated by a confirm
 * prompt so an accidental tap/swipe doesn't silently abort a Learn lap.
 */
describe('shouldConfirmCalibrationExit (Field revision 2, binding: calibration escape)', () => {
  it('a header back tap requires confirmation', () => {
    expect(shouldConfirmCalibrationExit('header-back')).toBe(true);
  });

  it('an edge-swipe gesture back requires confirmation', () => {
    expect(shouldConfirmCalibrationExit('gesture-back')).toBe(true);
  });

  it('the sticky "Cancel Calibration" long-press button does NOT require a second confirmation -- the hold itself is the confirmation', () => {
    expect(shouldConfirmCalibrationExit('cancel-button')).toBe(false);
  });

  it('calibration completing naturally into a result is never intercepted', () => {
    expect(shouldConfirmCalibrationExit('calibration-complete')).toBe(false);
  });

  it('exhaustively covers every trigger kind (no silent default)', () => {
    const triggers: CalibrationExitTrigger[] = ['header-back', 'gesture-back', 'cancel-button', 'calibration-complete'];
    const results = triggers.map((t) => shouldConfirmCalibrationExit(t));
    expect(results).toEqual([true, true, false, false]);
  });
});

/**
 * P4h-FIX1 H1 (after Codex P4h-REV1 HIGH, `ActiveCalibrationScreen.tsx:73-98`):
 * "confirming header/gesture cancellation cannot navigate away. `beforeRemove`
 * intercepts every `GO_BACK`; `confirmCancelExit()` redispatches that same
 * action without an allow-once flag, so the listener prevents it again and
 * reopens the confirm card. Scenario: Back -> 'Cancel Calibration' -> card
 * immediately returns; repeat indefinitely."
 *
 * The screen keeps this interceptor in a ref and asks it on every
 * `beforeRemove` event; confirming arms a ONE-SHOT bypass so the replayed
 * action passes straight through, and only that one.
 */
describe('createCalibrationExitInterceptor (P4h-FIX1 H1: allow-once replay of the intercepted back action)', () => {
  it('intercepts the first GO_BACK (the confirm card opens)', () => {
    const interceptor = createCalibrationExitInterceptor();
    expect(interceptor.shouldIntercept('GO_BACK')).toBe(true);
  });

  it('after allowNext() the replayed GO_BACK passes through -- navigation proceeds, no re-intercept loop', () => {
    const interceptor = createCalibrationExitInterceptor();
    expect(interceptor.shouldIntercept('GO_BACK')).toBe(true); // Back tapped: confirm card opens.
    interceptor.allowNext(); // "Cancel Calibration" confirmed.
    expect(interceptor.shouldIntercept('GO_BACK')).toBe(false); // the redispatched action is NOT intercepted again.
  });

  it('the bypass is ONE-SHOT: a later, unrelated back tap is intercepted again', () => {
    const interceptor = createCalibrationExitInterceptor();
    interceptor.allowNext();
    expect(interceptor.shouldIntercept('GO_BACK')).toBe(false);
    expect(interceptor.shouldIntercept('GO_BACK')).toBe(true);
  });

  it('double-tapping "Cancel Calibration" (allowNext twice) still only lets ONE back through', () => {
    const interceptor = createCalibrationExitInterceptor();
    interceptor.allowNext();
    interceptor.allowNext();
    expect(interceptor.shouldIntercept('GO_BACK')).toBe(false);
    expect(interceptor.shouldIntercept('GO_BACK')).toBe(true);
  });

  it('"Keep Calibrating" (reset) disarms an armed bypass -- the next back is intercepted', () => {
    const interceptor = createCalibrationExitInterceptor();
    expect(interceptor.shouldIntercept('GO_BACK')).toBe(true);
    interceptor.allowNext();
    interceptor.reset();
    expect(interceptor.shouldIntercept('GO_BACK')).toBe(true);
  });

  it('the screen\'s own programmatic REPLACE navigations are never intercepted, armed or not', () => {
    const interceptor = createCalibrationExitInterceptor();
    expect(interceptor.shouldIntercept('REPLACE')).toBe(false);
    interceptor.allowNext();
    expect(interceptor.shouldIntercept('REPLACE')).toBe(false);
    // A REPLACE must not CONSUME the armed one-shot either -- the pending
    // confirmed back still has to get through.
    expect(interceptor.shouldIntercept('GO_BACK')).toBe(false);
  });
});
