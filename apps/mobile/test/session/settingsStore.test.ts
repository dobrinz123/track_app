import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DEV_TAP_THRESHOLD, DEV_TAP_WINDOW_MS, registerDevTap, type DevTapState } from '../../src/session/settingsStore';

/**
 * Field revision (2026-08-27, binding, "hidden developer mode"): "toggled by
 * 7 taps on the About version text in Settings (toast 'Developer mode
 * on/off')". `registerDevTap` is the pure tap-counter `SettingsScreen.tsx`
 * drives from its `onPress` handler -- extracted here (rather than kept
 * inline in the screen) so the counting/reset/threshold logic is directly
 * unit-testable (the screen itself, importing `react-native`, cannot be
 * imported under this project's plain-Node vitest environment).
 */
describe('registerDevTap (field revision, 2026-08-27, binding: hidden developer mode)', () => {
  it('developerModeEnabled defaults to false', () => {
    expect(DEFAULT_SETTINGS.developerModeEnabled).toBe(false);
  });

  it('the first tap (state null) starts a count of 1 and never toggles', () => {
    const { state, toggled } = registerDevTap(null, 1_000);
    expect(state).toEqual({ count: 1, firstTapAtMs: 1_000 });
    expect(toggled).toBe(false);
  });

  it(`accumulates taps within the window, toggling on exactly the ${DEV_TAP_THRESHOLD}th`, () => {
    let state: DevTapState | null = null;
    let toggled = false;
    let nowMs = 0;
    for (let tap = 1; tap <= DEV_TAP_THRESHOLD; tap += 1) {
      nowMs += 100; // well within the window between each tap.
      ({ state, toggled } = registerDevTap(state, nowMs));
      if (tap < DEV_TAP_THRESHOLD) {
        expect(toggled).toBe(false);
        expect(state.count).toBe(tap);
      }
    }
    expect(toggled).toBe(true);
    expect(state!.count).toBe(0); // reset -- so a fresh run of 7 more taps is needed to toggle again.
  });

  it('a tap OUTSIDE the window restarts the count at 1 rather than accumulating indefinitely', () => {
    let state: DevTapState | null = null;
    ({ state } = registerDevTap(state, 0)); // tap 1.
    ({ state } = registerDevTap(state, 100)); // tap 2, within window.
    ({ state } = registerDevTap(state, 200)); // tap 3, within window.
    expect(state.count).toBe(3);

    // A tap long after the window elapsed -- restarts at 1, not 4.
    const { state: restarted, toggled } = registerDevTap(state, 200 + DEV_TAP_WINDOW_MS + 1);
    expect(restarted.count).toBe(1);
    expect(toggled).toBe(false);
  });

  it('a tap exactly at the window boundary still counts as within it (inclusive)', () => {
    const { state } = registerDevTap({ count: 3, firstTapAtMs: 1_000 }, 1_000 + DEV_TAP_WINDOW_MS);
    expect(state.count).toBe(4);
  });

  it('does not toggle again on subsequent taps immediately after a toggle -- the reset count must build back up from 1', () => {
    // Simulate having JUST toggled (count reset to 0 by the threshold tap).
    const afterToggle: DevTapState = { count: 0, firstTapAtMs: 5_000 };
    const { state, toggled } = registerDevTap(afterToggle, 5_050);
    expect(toggled).toBe(false);
    expect(state.count).toBe(1);
  });

  it('a custom threshold/window is honored (not hardcoded)', () => {
    let state: DevTapState | null = null;
    let toggled = false;
    for (let tap = 1; tap <= 3; tap += 1) {
      ({ state, toggled } = registerDevTap(state, tap * 10, 3, 500));
    }
    expect(toggled).toBe(true);
  });

  // P4g-FIX1 (binding): the 2s window must span the WHOLE 7-tap sequence
  // (first tap -> seventh tap <= windowMs), not merely each consecutive
  // inter-tap gap. Codex P4g-REV1 found the pre-fix implementation measured
  // the window between consecutive taps only, so 7 taps spaced 1.9s apart
  // (each individually "recent") toggled after ~11.4s despite the declared
  // 2-second window.
  it('7 taps spaced 1.9s apart do NOT toggle -- the window is measured from the FIRST tap of the run, not each consecutive pair', () => {
    let state: DevTapState | null = null;
    let toggled = false;
    let nowMs = 0;
    for (let tap = 1; tap <= 7; tap += 1) {
      ({ state, toggled } = registerDevTap(state, nowMs));
      expect(toggled).toBe(false);
      nowMs += 1_900;
    }
    expect(toggled).toBe(false);
  });

  it('7 taps that DO land within the 2s window (measured first-to-last) toggle on the 7th', () => {
    let state: DevTapState | null = null;
    let toggled = false;
    let nowMs = 0;
    for (let tap = 1; tap <= 7; tap += 1) {
      ({ state, toggled } = registerDevTap(state, nowMs));
      nowMs += 300; // 6 gaps of 300ms = 1_800ms total, within the 2_000ms window.
    }
    expect(toggled).toBe(true);
  });

  it('a tap that arrives after the RUN\'s window (anchored to the first tap) elapsed restarts the anchor, even if it is within windowMs of the PREVIOUS tap', () => {
    let state: DevTapState | null = null;
    ({ state } = registerDevTap(state, 0)); // tap 1 -- anchor = 0.
    ({ state } = registerDevTap(state, 1_900)); // tap 2 -- within 2_000ms of the anchor.
    // tap 3 at 3_800: only 1_900ms after the PREVIOUS tap, but 3_800ms after
    // the anchor (0) -- the run's window elapsed, so this restarts as a
    // fresh anchor rather than accumulating to count 3.
    const { state: afterTap3 } = registerDevTap(state, 3_800);
    expect(afterTap3).toEqual({ count: 1, firstTapAtMs: 3_800 });
  });
});
