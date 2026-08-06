TASK: Implement reference-lap resampling, personal-best acceptance rules, and the live-delta engine in packages/core, with tests.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` pass from repo root; new Vitest suites cover everything below. Paste decisive command output.

CONTEXT: Read first: docs/architecture/contracts.md (binding: ReferenceLap, DeltaUpdate, LiveDeltaEngine, LapRecord, TrackMatch — in packages/core/src/contracts.ts, including the binding "PB replacement rules" section of the doc); packages/core/src/geometry/, src/profile/ (existing — reuse; makeTestProfile for fixtures).

CONSTRAINTS: code under packages/core/src/reference/ with its own index.ts. Do NOT edit other modules or root index.ts. No new deps. Pure logic. TypeScript strict.

MUST DO — reference building:
1. `buildReferenceLap(input)`: from a completed valid LapRecord + its per-sample matched telemetry (array of {tMono, unwrappedProgressM (or distanceM within lap), quality}), produce ReferenceLap with a stable distance grid (gridStepM default 10 m, from 0 to totalLengthM) and elapsedMsAtGrid by monotone linear interpolation of (lapDistance → elapsed). Requirements: elapsedMsAtGrid strictly non-decreasing (enforce; property test); handles sparse/irregular samples and small progress regressions (clamp to monotone); rejects (returns error) if source lap invalid or telemetry covers < 95% of grid.
2. `shouldReplacePb(current: ReferenceLap | null, candidate)` implementing the binding PB rules verbatim (same circuit/layout/layoutVersion; valid; quality good|degraded; not pit; complete ordered sectors; strictly faster; full telemetry). Every rule gets a rejection test; property test: PB durations are monotonically non-increasing over any sequence of candidate applications.

MUST DO — LiveDeltaEngine:
- setReference(ref | null); onMatch(match, lapElapsedMs) → DeltaUpdate.
- deltaMs = lapElapsedMs − refElapsedAt(match.distanceM) with linear interpolation on the grid; wrap-safe near start/finish (distance just below totalLength vs 0).
- Display smoothing: EMA (alpha default 0.3) applied ONLY to displayed deltaMs; raw value retained internally. No smoothing of reference data.
- confidence = min(match.confidence, reference completeness); display 'neutral' when confidence < 0.4 OR no reference OR match quality worse than 'degraded'; else 'faster' (deltaMs < −50), 'slower' (> +50), 'neutral' in the deadband.
- Handles: no reference (neutral, deltaMs 0); progress regression (hold last delta, decay confidence); sparse updates/gaps > 3 s (confidence decay, neutral if stale > 5 s — staleness from sample tMono deltas, not wall clock); reference invalidation mid-lap via setReference(null).
- estimatedLapMs = ref.durationMs + current raw delta, exposed only when confidence ≥ 0.6.
- Sign convention: negative = faster. Test explicitly with a lap run faster than reference.
- Property tests: delta continuity — for 1 Hz synthetic laps with smooth speed profiles, successive displayed deltas differ < 500 ms; interpolation exactness at grid points.

MUST NOT: modify files outside WRITE SET; add deps; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, assumptions, commands + pasted results, limitations, integration notes.

WRITE SET: packages/core/src/reference/** (new files), colocated *.test.ts allowed.
