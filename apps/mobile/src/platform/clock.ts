import type { MonotonicClock } from '@circuit/core';

/**
 * {@link MonotonicClock} backed by the global `performance.now()`.
 *
 * Platform caveat (see `.foreman/scratch/platform-research.md` §5, "Timestamps &
 * Monotonic Time"): `performance.now()` in React Native / Hermes is monotonically
 * increasing, microsecond-precision (falls back to 1ms), and immune to clock skew
 * or NTP adjustments — unlike `Date.now()`, which can jump backward. This is why
 * every `tMono` in the app is stamped via this clock and never from wall-clock time.
 */
export class PerformanceNowClock implements MonotonicClock {
  now(): number {
    return performance.now();
  }
}
