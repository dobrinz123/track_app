TASK: Fix a REAL, foreman-reproduced defect in the dev-replay pacing: accelerated replay re-stamps samples to the live clock, compressing inter-sample dt by the acceleration factor, so TelemetryQualityEvaluator computes implied speeds ×10 and rejects every sample as IMPOSSIBLE_JUMP — DevReplay calibration stalls at ~8% coverage showing OFF TRACK.

REPRODUCTION (verified live by the foreman in web preview): Settings → Dev Replay → any fixture → Calibrating screen freezes at 8% COVERAGE / OFF TRACK. Root cause chain: apps/mobile/src/session/liveTimestampedProvider.ts stamps tMono = live clock at delivery; delivery pace is 10×; quality evaluator sees dt=100ms for 1000ms-spaced fixture samples → implied speed > 120 m/s → 'invalid'.

EXPECTED OUTCOME: DevReplay scenarios run correctly at 10×: calibration reaches ≥95% coverage and completes; timed laps appear on the dashboard with plausible lap times (equal to the fixture's REAL lap durations, not ÷10); new/updated tests prove the pacing math. `npm run typecheck`, `npm test` (root: core+mobile), `npm run lint`, `npm run export:ios` all green. Paste decisive output.

CONTEXT: Read first: apps/mobile/src/session/liveTimestampedProvider.ts, apps/mobile/src/session/composition.ts (dev-replay path: startDevReplaySession or equivalent — where the controller + provider are constructed), packages/core/src/controller/sessionController.ts (deps.clock: MonotonicClock), apps/mobile/test/session/liveTimestampedProvider.test.ts (existing tests — they asserted re-stamping, which encoded the bug; rewrite them to the new contract), packages/core/src/matching/quality-evaluator.ts (thresholds the fix must satisfy).

CONSTRAINTS: TypeScript strict; no new deps; do NOT touch packages/core production code (the controller already accepts an injected clock — use it); keep the production GNSS path completely unchanged (PerformanceNowClock + raw provider).

MUST DO:
1. Redesign the dev-replay time domain: a shared `ReplayTimeSource` owning a virtual clock: virtualNow = virtualStart + (realElapsed × speedFactor). The provider emits each fixture sample when its ORIGINAL relative time arrives in the virtual domain, stamping tMono with the sample's VIRTUAL timestamp (preserving original inter-sample spacing in virtual time). A `ScaledReplayClock implements MonotonicClock` reads the same time source.
2. composition's dev-replay path constructs controller with the ScaledReplayClock (production path untouched, keeps PerformanceNowClock). Watchdog timeouts remain compatible (virtual gaps = original gaps; document that the signal-loss fixture still triggers the watchdog in virtual time).
3. Tests (apps/mobile/test): (a) pacing math — provider+clock produce samples whose implied speeds through TelemetryQualityEvaluator have ZERO 'IMPOSSIBLE_JUMP'/'invalid' verdicts for the clean lap fixture at factor 10; (b) sample tMono spacing equals original fixture spacing (±1ms) in the virtual domain; (c) clock.now() and sample stamps share the domain (a sample delivered "now" has tMono ≤ clock.now() within a small bound); (d) end-to-end: RealSessionFacade + ScaledReplayClock + provider on the clean recognition lap reaches calibration accepted (coverage ≥95%) — the regression test for THIS bug; (e) rewrite existing liveTimestampedProvider tests to the new contract.
4. Manual-verification note for the foreman: exact steps to re-drive DevReplay in web preview.

MUST NOT: change production GNSS timing; slow replays to 1× (UX requirement: accelerated); weaken quality thresholds; touch packages/core src; no subagents; no git commit.

OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then root-cause confirmation, files changed, commands + pasted results, limitations.

WRITE SET: apps/mobile/src/session/liveTimestampedProvider.ts, apps/mobile/src/session/composition.ts (dev-replay path only), apps/mobile/test/session/**.
