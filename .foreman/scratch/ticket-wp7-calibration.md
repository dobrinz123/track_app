TASK: Implement the telemetry quality evaluator, continuity-constrained track matcher, and Learn/calibration engine in packages/core, with tests.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` pass from repo root; new Vitest suites cover acceptance and every rejection path below. Paste decisive command output.

CONTEXT: Read first: docs/architecture/contracts.md (binding: TelemetryQualityEvaluator, TrackMatcher, TrackMatch, CalibrationEngine, CalibrationResult, CalibrationDiagnostics — in packages/core/src/contracts.ts); packages/core/src/geometry/ and src/profile/ (existing, tested — use RuntimeProfile, projectOntoPolyline with hint, unwrapProgress; do not reimplement). Use profile's makeTestProfile for fixtures.

CONSTRAINTS: code under packages/core/src/matching/ (quality evaluator + matcher) and packages/core/src/calibration/, each with its own index.ts. Do NOT edit contracts.ts, geometry/**, profile/**, timing/**, statemachine/**, or root index.ts. No new deps. Pure logic, no Date.now. TypeScript strict.

MUST DO — TelemetryQualityEvaluator (configurable thresholds, defaults given):
- 'invalid': missing/NaN coords, non-increasing tMono, accuracyM > 50, implied speed from prev > 120 m/s ('IMPOSSIBLE_JUMP'), duplicate timestamp.
- 'unreliable': accuracyM > 25, implied speed > 85 m/s, sample gap > 3000 ms.
- 'degraded': accuracyM > 12, gap > 1500 ms.
- else 'good'. reasons[] carries machine codes for every triggered rule.

MUST DO — TrackMatcher (continuity-constrained):
- Constructor takes RuntimeProfile + config. Maintains last match; uses hinted projection (windowM default 150) when a previous match exists and confidence > threshold; full search on reset/lost.
- Returns null (reject) for 'invalid'-quality samples. Off-corridor (|lateralM| > corridorWidthM): confidence decays; after offCorridorLimit (default 5) consecutive off-corridor samples, matcher enters lost mode (full search until re-acquired within corridor).
- onPitLane: if profile has a pit polyline and the sample is nearer to it than to the centerline AND within pit corridor, set onPitLane=true (lateral vs centerline still reported).
- confidence in [0,1]: decreasing in lateralM/corridorWidthM, accuracy, and hint disagreement; smooth (EMA) so single glitches don't crater it.
- unwrappedProgressM via unwrapProgress. Progress regression beyond 30 m without matching reverse evidence lowers confidence and flags quality reason 'PROGRESS_REGRESSION'.

MUST DO — CalibrationEngine (Learn):
- Purpose: observe ONE complete recognition lap on a KNOWN circuit; establish alignment/confidence. It never creates geometry.
- feed(): runs quality evaluator + matcher internally (constructor takes RuntimeProfile); accumulates: coverage bitmap over centerline in coverageBinM (default 25 m) bins; accepted/rejected counts + reason histogram; lateral stats (mean, p95); direction votes from signed progress deltas; observed rate.
- Lateral deviation alone is NOT an error (racing line ≠ centerline): samples within corridor count as covered regardless of lateral offset.
- Bias estimation: robust mean (trimmed 20%) of the perpendicular offset vector (E,N) over accepted samples, applied ONLY if |bias| ∈ [1.5 m, 8 m] and lateral p95 after correction improves ≥ 20%; otherwise zero. Never larger than 8 m ('bounded, session-level').
- finish() → CalibrationResult. accepted requires ALL: coverageFraction ≥ 0.95; direction matches profile.direction ('WRONG_DIRECTION' failure otherwise); rejectedFraction ≤ 0.3 ('POOR_GNSS'); observedRateHz ≥ 0.5 ('RATE_TOO_LOW'); continuous coverage — longest uncovered run ≤ 100 m ('COVERAGE_GAP'). confidence blends coverage, quality ratio, lateral tightness.
- progress() live view per contract.
- Failure paths tested individually: partial lap (coverage), wrong direction, heavy noise (rejectedFraction), pit/paddock loitering (off-corridor samples don't cover bins), low rate.
- Acceptance test: synthetic clean lap around makeTestProfile centerline with ±3 m lateral noise at 1 Hz → accepted, confidence ≥ 0.7, bias ≈ injected bias when a constant 3 m offset is added (test both with and without offset).

MUST NOT: modify files outside WRITE SET; add deps; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, assumptions, commands + pasted results, limitations, integration notes (public API + config shapes).

WRITE SET: packages/core/src/matching/**, packages/core/src/calibration/** (new files), tests go in packages/core/test/<module>/ (root vitest only discovers test/**/*.test.ts).
