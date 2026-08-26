# Ticket CN-FIX1 — batched fix wave: Codex core cross-review findings (MotorPark)

## TASK
Fix ALL four findings from the Codex read-only review (`.foreman/scratch/cnrev1-codex-output.log`,
verdict FAIL) in one wave, with LEAD-binding designs below. Core scope only.

## Findings + binding designs
**F1 (HIGH) — pit polyline out-and-back.** LEAD reproduced from `data/osm/overpass-motorpark-geom.json`:
way 953930215 nodes end at `8829181316`; way 953930214 nodes are
`[8829250717, 8829181316, 8829181315, …, 8829181310]`. The two pit ways SHARE node `8829181316`;
there is NO unmapped gap (the LEAD addendum's "~41 m gap" claim was wrong — it compared endpoint
coordinates instead of node ids). Node `8829250717` (first of way 214) lies on the main loop and is
a short-configuration pit connection, NOT part of the full layout's pit lane. Way 215's first node
`8829250724` lies on extension way 949617051 (i.e. on the full-layout centerline) = pit entry;
way 214's last node `8829181310` lies on the main loop = pit exit.
Design: `pitLane.polyline = way215.geometry ++ way214.geometry.slice(1)` (dedupe the shared
node; drop `8829250717`). Generator asserts (fail loud): shared node identity, 215[0] ∈ ext-way
nodes, 214[last] ∈ main-loop nodes, and no consecutive backtracking (no vertex i where the
heading reverses by >150° between segments i-1→i and i→i+1). Entry/exit gates at those true
endpoints (unchanged positions if already there — verify). Replace the confidenceNotes text about
the "gap bridge" with the true topology (shared node; short-config connector excluded).
Regenerate the asset (`npm run generate:motorpark`). Expected pit polyline length ≈ 637.5 m.

**F2 (MED) — tests don't independently pin splice / S/F.** In
`packages/core/test/profile/motorpark-profile.asset.test.ts` add assertions that read the RAW
archived Overpass JSON directly (NOT via the generator's helpers): (a) rebuild the spliced loop
by node ids (main 333031201 indices 0..74, ext 949617051 interior, main 79..82) and assert the
asset centerline equals it point-for-point after rotation to the S/F seam (tolerance 1e-7 deg);
(b) S/F gate midpoint = the main-loop seam node coordinates (±1e-6 deg) — the seam node id is
`main.nodes[0]`; (c) pit polyline first point = way-215 first node coords, last point = way-214
last node coords, no two consecutive identical points, no backtracking, haversine length within
±2 m of 637.5; (d) keep the byte-stable pin. Remove or strengthen the vacuous
"centerline/cumulativeDistances lengths match" assertion (assert cumulative last value ≈
totalLengthM instead).

**F3 (LOW) — soak weakened.** `packages/core/test/soak/motorparkTrackDayScenario.soak.test.ts`
restore the TMR original's `< 200_000` ms valid-lap bound (expected cool lap ≈ 169 s).

**F4 (INFO) — reversed comment.** `packages/core/src/fixtures/scenarios.ts:~222` — the comment
has the seam projections swapped (TMR S/F projects ≈ totalLength, MotorPark ≈ 0). Fix the
comment only; the unwrap logic is correct and must not change.

Also: update `.foreman/scratch/motorpark-research.md` LEAD addendum "Main straight / S-F zone"
paragraph — replace the "~41 m gap" sentence with the correct shared-node topology (mark the
edit "corrected after Codex CN-REV1").

## CONSTRAINTS
- Centerline, S/F, sector gates, corner analysis must NOT change (the corner pin test and the
  10-corner sequence must still pass; only the pit polyline/notes/tests change). TMR untouched.
- No changes under apps/mobile (another worker is active there). No new deps.

## MUST DO
Gates with real exit codes (`cmd; echo EXIT=$?`, never piped through grep):
`npm run typecheck` → 0, `npm test` → 0, `npm run lint` → 0. Report test totals, pit polyline
length before/after, and confirm the centerline JSON section is byte-identical before/after
(diff the asset and show only `pitLane`/`confidenceNotes`/`updatedAtUtc`-class changes — note:
keep timestamps fixed/deterministic; do not bump dates).

## MUST NOT
Spawn agents; touch files outside the WRITE SET; commit.

## WRITE SET
- `packages/core/scripts/generate-motorpark-profile.ts`
- `packages/core/assets/circuits/motorpark-romania.v1.json` (regenerated)
- `packages/core/test/profile/motorpark-profile.asset.test.ts`
- `packages/core/test/soak/motorparkTrackDayScenario.soak.test.ts`
- `packages/core/src/fixtures/scenarios.ts` (comment only)
- `.foreman/scratch/motorpark-research.md` (one paragraph)

## OUTPUT FORMAT
First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED; then per-finding status
(F1–F4 FIXED/NOT), gate outputs with exit codes, totals, evidence (lengths, diff summary).
