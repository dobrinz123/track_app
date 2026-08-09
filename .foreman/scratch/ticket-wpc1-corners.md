TASK: Implement the deterministic corner-analysis module in packages/core: segment the circuit centerline into numbered corners with severity classes and advisory speeds, per the Coaching addendum contracts.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` green from repo root; new suite green. CRITICAL VALIDATION: on the real TMR v2 profile the analysis must find a corner count in the 8-12 range (the external reference map shows 10 numbered turns — T1..T10; our segmentation should land close; assert 8<=n<=12 and report the exact per-corner table in your output).

CONTEXT: Read first: docs/architecture/contracts.md §"Coaching addendum" (binding: Corner, CornerSeverity, CORNER_ANALYSIS_VERSION — materialize into contracts.ts verbatim, additive only); packages/core/scripts/generate-tmr-profile.ts (existing curvature math: turning angle per meter over ±40 m window — EXTRACT this into a shared reusable function in packages/core/src/geometry/curvature.ts and refactor the generator to use it; generator output must stay BYTE-IDENTICAL — the asset regression tests prove it); packages/core/src/profile/ (RuntimeProfile), test/soak/ helpers, .foreman/scratch/tmr-geometry-check.md (geometry facts).

CONSTRAINTS: code in packages/core/src/corners/ (+ the shared curvature util in geometry/); tests in test/corners/; contracts.ts additive edits only; root index.ts add re-exports. No new deps. TypeScript strict. Deterministic (no Date.now/random).

MUST DO:
1. geometry/curvature.ts: `curvatureProfile(centerlineLocal, cumulative, closed, windowM)` → per-vertex curvature rad/m (signed: + = left turn). Generator refactored onto it; `npm run generate:tmr` byte-identity must hold (run and prove).
2. corners/analyzeCorners(runtime, config?): segmentation — a corner = maximal run where |curvature| >= cornerThreshold (default 0.008 rad/m, same as sector-snapping straight threshold) with hysteresis (allow gaps < gapToleranceM default 25 m inside one corner; merge runs closer than mergeDistanceM default 30 m with same sign); per Corner compute entry/apex/exit/length, minRadiusM = 1/maxAbsCurvature (clamp radius to [8, 2000]), totalAngleDeg = integral of |curvature| ds, direction from sign at apex, severity buckets by minRadiusM: >=300→1, >=180→2, >=110→3, >=60→4, >=30→5, <30→6 (config table), advisorySpeedKph = 3.6*sqrt(latG*9.81*minRadiusM) with latG default 0.85, rounded to 5 km/h. IDs numbered 1..n in travel order from S/F.
3. Wrap handling: a corner spanning the S/F line must be one corner (unwrap-aware segmentation).
4. Tests: dev-test-ring synthetic profile (makeTestProfile — known geometry: rounded rectangle → expect exactly its 4 arcs found, severity uniform, directions consistent with its orientation); TMR v2: 8..12 corners, all severities in 1..6, entries strictly increasing, corner 1 after S/F, advisory speeds monotone in radius (property: larger minRadius → >= advisorySpeed), determinism (two runs deep-equal), wrap test (rotate profile datum so a corner spans S/F → same corner count).
5. Report the full TMR corner table (id, entry m, minRadius, angle, direction, severity, advisory kph) in your output for foreman cross-check against the reference map.

MUST NOT: modify generator OUTPUT (byte-identity), timing/matching/controller modules, or profile schema; no subagents; no git commit.

OUTPUT FORMAT: first line DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED; TMR corner table; files changed; commands + pasted results.

WRITE SET: packages/core/src/corners/**, packages/core/src/geometry/curvature.ts, packages/core/src/geometry/index.ts (re-export), packages/core/scripts/generate-tmr-profile.ts (refactor onto shared util only), packages/core/src/contracts.ts (additive), packages/core/src/index.ts (re-export), packages/core/test/corners/**.
