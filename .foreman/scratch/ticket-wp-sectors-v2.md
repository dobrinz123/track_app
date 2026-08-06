TASK: Improve the app-defined sector boundaries for Transilvania Motor Ring: snap the two sector gates from exact 1/3 and 2/3 lap distance to the nearest LOW-CURVATURE (straight) stretch of centerline, so crossings happen on straights like real timing sectors. Deterministic, versioned as layoutVersion 2.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` pass from repo root; `npm run generate:tmr` regenerates the v2 asset byte-identically on repeat runs; the old v1 asset file REMAINS in the repo untouched (PB keying depends on layoutVersion — v1 history stays valid under v1). Paste decisive output including the new gates' distances and fractions.

CONTEXT: Read first: docs/decisions/ADR-0002 (current placement rules), packages/core/scripts/generate-tmr-profile.ts (generator — deterministic, no Date.now), packages/core/assets/circuits/transilvania-motor-ring.v1.json, packages/core/src/geometry/ (curvature can be derived from consecutive segment bearings), packages/core/test/profile/tmr-profile.asset.test.ts, .foreman/scratch/tmr-geometry-check.md (current numeric layout). App-side: apps/mobile/src/session/tmrProfile.ts statically imports the v1 filename — update the import to v2.

CONSTRAINTS: Generator changes only in the script + a new committed asset transilvania-motor-ring.v2.json; keep the v1 asset file. TypeScript strict, no new deps. All existing non-sector assertions must stay green; sector-fraction assertions update to the documented tolerance.

MUST DO:
1. Curvature metric in the generator: for each centerline vertex, turning angle per meter over a ±40 m window (deterministic, from the polyline itself). A vertex qualifies as "straight" if curvature < 0.008 rad/m (~ <0.46°/m — tune if needed, document the chosen threshold and why).
2. Gate placement rule v2: for each target fraction (1/3, 2/3), find the nearest qualifying straight vertex within ±180 m of the target distance; place the gate there (perpendicular, same width rules as v1). If no qualifying vertex exists in the window (should not happen — report), fall back to the exact fraction and note it in confidenceNotes.
3. Also snap-check the S/F gate: verify it already lies on a straight (it's on the main straight — assert curvature at S/F below threshold; do not move it).
4. Profile v2 fields: layoutVersion 2; confidenceNotes documents the v2 sector rule verbatim; everything else identical to v1 rules (ODbL source, geometryStatus community-derived, sectorStatus app-defined).
5. Generator emits transilvania-motor-ring.v2.json; `generate:tmr` writes BOTH v1 (unchanged rule → byte-identical to committed v1) and v2, OR takes a version argument — your choice, document it; determinism test covers v2 (two runs → identical bytes).
6. Update apps/mobile/src/session/tmrProfile.ts static import to the v2 asset (one-line change; the validation path is version-agnostic).
7. Tests: tmr-profile.asset.test.ts extended for v2 — validates ok; sector gates on straights (assert curvature at each gate < threshold); fractions within [28%, 39%] and [61%, 72%] respectively (wide tolerance — snapping window); gates ordered; v1 asset still byte-stable. Report the ACTUAL v2 fractions and distances in your output.
8. Update the replay integration test fixture loading IF it hardcodes v1 (check test/replay/ — it reads the v1 filename; switch to v2 so the pipeline tests run on what the app ships; keep one v1 load test for regression).

MUST NOT: alter centerline/pit/S-F geometry or any algorithm outside the generator + named tests + the one import line; touch UI beyond tmrProfile.ts; delete the v1 asset; spawn subagents; git commit.

OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then: v2 gate distances/fractions + curvature at each gate, files changed, commands + pasted results, limitations.

WRITE SET: packages/core/scripts/generate-tmr-profile.ts, packages/core/assets/circuits/transilvania-motor-ring.v2.json (new), packages/core/test/profile/tmr-profile.asset.test.ts, packages/core/test/replay/replay-harness.integration.test.ts (fixture path only), apps/mobile/src/session/tmrProfile.ts (import line only), root package.json (generate:tmr script arg if needed).
