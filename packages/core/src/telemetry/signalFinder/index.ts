/**
 * Signal Finder (contracts.md "Signal Finder (Phase 4l, 2026-08-29)",
 * binding) — the pure core of the target-driven discovery wizard: target
 * definitions (data), the metronome timeline the driver is paced by, and the
 * per-DID scoring that turns the resulting samples into verdicts.
 *
 * No I/O, no clock, no transport: the mobile controller
 * (`apps/mobile/src/session/signalFinderController.ts`) owns every wire-level
 * concern and reuses `runDidObservation` for the polling itself.
 */
export * from './targets';
export * from './metronome';
export * from './scoring';
export * from './plan';
