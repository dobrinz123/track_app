import { describe, expect, it } from 'vitest';
import { shouldConfirmCalibrationExit, type CalibrationExitTrigger } from '../../src/session/calibrationEscape';

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
