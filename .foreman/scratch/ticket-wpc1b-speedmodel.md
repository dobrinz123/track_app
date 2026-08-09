TASK: Advisory-speed model v2 for corner analysis, calibrated against real observed apex speeds supplied by the user (M2 Competition onboard at TMR), plus an observed-speeds overlay layer. Corners module only.

EXPECTED OUTCOME: gates green from root; new/updated tests green; the model reproduces the observed anchors within tolerance (table below); CORNER_ANALYSIS_VERSION bumped to 2.

CONTEXT: Read packages/core/src/corners/analyzeCorners.ts (v1: advisorySpeedKph = 3.6*sqrt(latG*9.81*minRadius), latG 0.85 flat) and test/corners/. USER-OBSERVED DATA (apex minimum speeds, M2 Competition, TMR; provenance = community-observed onboard estimate, NOT official):
map T1≈80, T2≈75 (our C1 merges them), T3=159 (our C2), T4=65 (C3), T5 apex UNKNOWN (only exit≈115 known — exclude from fit/overlay), T6=74 (C5), T7=170 (C6), T8=105-110 (C7, use 107), T9=65 (C8), T10=112 (C9).

MUST DO:
1. Model v2 (physics, angle-aware): effective latG bucketed by totalAngleDeg — >=100°: 1.05g; 45-100°: 1.5g; <45°: 2.0g (rationale in code: racing-line straightening grows as corner angle shrinks; anchored to observed data). Config-overridable buckets. Keep result rounded to 5 kph. Validation test: |modelV2 - observed| / observed <= 0.18 for every anchored corner (C2,C3,C5,C6,C7,C8,C9; C1 excluded as merged, C4 excluded as unknown-apex), AND modelV2 <= observed for at least 5 of 7 (advisory stays on the safe side).
2. Observed-speeds overlay: new optional input to analyzeCorners (or a decorator fn applyObservedSpeeds(corners, observations)) taking Array<{cornerId, apexSpeedKph, source: string}>; when present, advisorySpeedKph = min(observed, modelV2*1.1) with sourceTag 'observed' vs 'model' added to Corner (contracts.ts additive: Corner.speedSource?: 'model' | 'observed'). Ship the TMR observations as a checked-in data file packages/core/assets/circuits/transilvania-motor-ring.observed-speeds.v1.json with provenance block (source: "user-supplied onboard observation, M2 Competition, 2026-08-10; advisory, unofficial"); loader util + validation (cornerId must exist, speeds 20..320).
3. Update existing corner tests to model v2 expectations; add overlay tests (observed wins; missing corners fall back to model; C4/T5 absent from data file).
4. CORNER_ANALYSIS_VERSION = 2.

MUST NOT: touch coach/ (concurrent worker), matcher/timing/UI; no new deps; no subagents; no git commit.

OUTPUT FORMAT: status first line; per-corner table (id, radius, angle, modelV1, modelV2, observed, final overlay value); files; commands + results.

WRITE SET: packages/core/src/corners/**, packages/core/src/contracts.ts (additive), packages/core/assets/circuits/transilvania-motor-ring.observed-speeds.v1.json, packages/core/test/corners/**.
