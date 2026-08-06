import type { MonotonicClock } from '@circuit/core';

/**
 * {@link MonotonicClock} backed by the global `performance.now()`.
 *
 * Platform caveat (see `.foreman/scratch/platform-research.md` §5, "Timestamps &
 * Monotonic Time"): `performance.now()` in React Native / Hermes is monotonically
 * increasing, microsecond-precision (falls back to 1ms), and immune to clock skew
 * or NTP adjustments — unlike `Date.now()`, which can jump backward. This is why
 * every `tMono` in the app is stamped via this clock and never from wall-clock time.
 *
 * iOS monotonicity semantics (ADR-0003 §3, ios-primary-target — binding):
 *  - Under Hermes/JSI on iOS, `performance.now()` is derived from
 *    `mach_continuous_time()`, which is monotonic and — unlike the older
 *    `mach_absolute_time()` — keeps advancing through device sleep, so it does
 *    not silently stall if the OS suspends the app briefly.
 *  - **Per-launch origin**: the clock's zero point is reset every time the JS
 *    engine (re)starts — i.e. every fresh app launch, not every foreground
 *    resume. `tMono` values are therefore only comparable to each other
 *    *within the same process launch*; a `tMono` recorded before an app kill
 *    and one recorded after are on different timelines and must never be
 *    subtracted from one another.
 *  - **Recovery rule**: session/lap recovery after a crash or relaunch must
 *    treat any persisted lap as historical data (its stored durations are
 *    already-computed deltas, safe to keep) and must never attempt to resume
 *    an in-flight lap by diffing a new `performance.now()` reading against a
 *    `tMono` value stamped in the previous launch. `lifecycle.ts` /
 *    persistence-layer recovery flows must re-anchor any live timer to a
 *    fresh `tMono` from the new launch rather than reusing an old one.
 */
export class PerformanceNowClock implements MonotonicClock {
  now(): number {
    return performance.now();
  }
}
