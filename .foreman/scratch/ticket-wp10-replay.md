TASK: Implement deterministic telemetry fixture generators and the ReplayHarness that streams fixtures through the PRODUCTION pipeline (quality → matcher → crossings → state machine → lap/sector timing → live delta), plus the integration test suite covering every adversarial scenario. This is the proof that the whole core works end-to-end. No toy timing implementations — the harness must compose the real modules.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` pass from repo root with the new integration suites green. Paste decisive output.

CONTEXT: Read first: docs/architecture/contracts.md (SessionPipelineResult contract; all module contracts); then the module public APIs: packages/core/src/{matching,calibration,timing,statemachine,reference,profile,geometry}/index.ts and their tests for usage patterns. Profiles: makeTestProfile (src/profile/test-fixture.ts) AND the real asset packages/core/assets/circuits/transilvania-motor-ring.v1.json via loadProfileFromJson.

CONSTRAINTS: code in packages/core/src/replay/ (harness) and packages/core/src/fixtures/ (generators), tests in packages/core/test/replay/. Do NOT modify any existing module (read-only consumers); do NOT edit contracts.ts or root index.ts. No new dependencies. Determinism: NO Math.random/Date.now — use an explicit seeded LCG/xorshift PRNG utility you write in fixtures/. TypeScript strict.

MUST DO — fixtures (each a pure generator function returning LocationSample[] with metadata, parameterized by profile + seed):
- driveLap(profile, opts): kinematic simulator following the centerline (or offset racing line via lateralOffsetM fn) at configurable speed profile (default 30-55 m/s varying sinusoidally), sample rate (default 1 Hz), Gaussian noise sigma (default 2.5 m), starting distance, direction. This is the base for everything below.
- Scenario fixtures (exact names, exported from fixtures/index.ts): cleanRecognitionLap, multiLapSession(n laps), pbImprovementSession (lap N faster than all before), slowerLapSession, noisyGpsLap (sigma 8 m), signalLossLap (gap 15 s mid-lap), impossibleJumpLap (one sample teleported 500 m), startLineJitterLap (5 samples oscillating ±3 m around S/F line at low speed), reverseTravelLap, pitLaneTransitLap (follows pit polyline), stoppedOnLineSession (60 s stationary ON the S/F gate mid-session), pauseResumeSession (tMono gap 45 s with position hold), outOfOrderTimestampsLap (2 swapped samples), lowQualitySamplesLap (accuracyM 30-60), wraparoundSession (starts 50 m before S/F so first crossing occurs within seconds).
- Each fixture documents (JSDoc) which pipeline behavior it exercises and the EXPECTED outcome.

MUST DO — ReplayHarness (src/replay/):
- `runSessionPipeline(runtimeProfile, samples, config?) → SessionPipelineResult` composing the REAL production classes; internal wiring: quality evaluator feeds matcher; matcher feeds crossing detector + delta engine; crossings feed state machine (as CROSSING events) and lap engine; pit gates drive PIT_ENTERED/PIT_EXITED; state machine's pendingInvalidReasons feed lapEngine.markInvalid; calibration phase optional via config.calibrateFirst with a recognition-lap sample array. Config: reference lap optional (delta engine engaged when present).
- Also expose `runCalibration(runtimeProfile, samples) → CalibrationResult` (thin wrapper over CalibrationEngine).
- The harness is PRODUCTION code (the app's session controller will reuse it) — clean API, no test-only hacks.

MUST DO — integration tests (test/replay/), each asserting concrete outcomes:
1. cleanRecognitionLap on TMR asset profile → calibration accepted, direction clockwise, coverage ≥ 0.95.
2. multiLapSession(3) on TMR after calibration → exactly 3 LapRecords, all valid, plausible durations (3706 m at avg speed → sanity range), sector times sum ≈ lap time, sessionComplete on END_SESSION.
3. pbImprovementSession → buildReferenceLap from lap 1, shouldReplacePb accepts faster lap N, rejects slower.
4. Delta: run a lap with reference set → delta near zero for identical lap; faster lap → negative delta at end; slower → positive.
5. signalLossLap → lap flagged (LOW_QUALITY or invalid) — never silently valid with a gap.
6. impossibleJumpLap → no phantom crossing; sample rejected; lap not corrupted.
7. startLineJitterLap → exactly ONE start crossing counted (rearm guard).
8. reverseTravelLap → no lap completion; REVERSE_TRAVEL invalidation if lap open.
9. pitLaneTransitLap → PIT_TRANSIT invalid lap; pitEntry/pitExit crossings present; state machine visited inPit.
10. stoppedOnLineSession → no duplicate crossings while stationary on the line.
11. pauseResumeSession → PAUSE_GAP invalidation of the affected lap only; subsequent lap valid.
12. outOfOrderTimestampsLap → offending samples rejected as 'invalid' (non-increasing tMono), pipeline continues.
13. wraparoundSession → first S/F crossing timed correctly (interpolated), progress unwrap correct across 0.
14. Determinism: same seed → byte-identical SessionPipelineResult (JSON.stringify equality); different seeds → different telemetry.
15. Performance guard: full 5-lap session (≈ 400 samples) through the pipeline completes in < 1 s.

MUST NOT: reimplement or shortcut any production module; touch concurrent workers' files (persistence-sql/**, apps/**); add deps; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, assumptions, commands + pasted results (per-test list for the integration suite), limitations, integration notes.

WRITE SET: packages/core/src/replay/**, packages/core/src/fixtures/**, packages/core/test/replay/**.
