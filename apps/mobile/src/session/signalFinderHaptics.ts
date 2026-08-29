import type { MetronomeStepKind } from '@circuit/core';

/**
 * Signal Finder — metronome haptics (contracts.md "Signal Finder (Phase 4l)"
 * item 3, binding: "the screen paces the driver (PRESS / HOLD / RELEASE with
 * a countdown and haptic)").
 *
 * `expo-haptics` is NOT a dependency of this app (checked against
 * `apps/mobile/package.json` and the workspace `node_modules` before writing
 * this file), and the ticket forbids adding a native dependency silently, so
 * the production implementation here is a deliberate NO-OP: the metronome
 * still paces the driver visually, and nothing crashes on a device without
 * the module.
 *
 * The seam is the point. `SignalFinderHaptics` is injected into the
 * controller, so wiring the real thing later is `npx expo install
 * expo-haptics` plus ONE implementation of this interface -- no change to the
 * controller, the screen, or any test.
 */
export interface SignalFinderHaptics {
  /** Fired once, at the instant a metronome step's prompt changes. Must never throw. */
  step(kind: MetronomeStepKind): void;
}

/** The production implementation while `expo-haptics` is absent: silent, allocation-free, never throws. */
export const noopSignalFinderHaptics: SignalFinderHaptics = {
  step(): void {
    // Intentionally empty -- see this module's own doc comment.
  },
};
