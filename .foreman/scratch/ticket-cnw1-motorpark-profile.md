# Ticket CN-W1 — MotorPark România: deterministic profile generator + asset + regression tests

## TASK
Add the second circuit to packages/core: a deterministic generator script that builds the
CircuitProfile asset for **MotorPark România (Adâncata, Ialomița)** from the archived OSM data,
the generated asset itself, and the asset regression test suite — following the existing TMR
pattern exactly (`packages/core/scripts/generate-tmr-profile.ts` +
`packages/core/test/profile/tmr-profile.asset.test.ts` are your reference implementations; read
them first).

## EXPECTED OUTCOME
- `packages/core/scripts/generate-motorpark-profile.ts` — deterministic generator.
- Root `package.json` gains ONE npm script: `"generate:motorpark": "node --experimental-strip-types packages/core/scripts/generate-motorpark-profile.ts"`.
- `packages/core/assets/circuits/motorpark-romania.v1.json` — generated asset, byte-stable.
- `packages/core/test/profile/motorpark-profile.asset.test.ts` — regression suite (details below).
- `.foreman/scratch/motorpark-corners-report.md` — corner-analysis report for LEAD verification.
- All gates green with REAL exit codes.

## CONTEXT
- Read `.foreman/scratch/motorpark-research.md` — ONLY the "LEAD VERIFICATION ADDENDUM" section
  is authoritative for OSM facts; §6 of that file is documented as fabricated. Non-OSM facts
  (published lengths, width, direction) in §§1–5 are citation-backed and usable.
- Input data (already archived, treat as READ-ONLY):
  - `data/osm/overpass-motorpark-geom.json` (raw Overpass, ways with inline `geometry`)
  - `data/osm/overpass-motorpark-tags.json`
- The schema, serialization style, and provenance conventions come from the TMR v2 asset
  `packages/core/assets/circuits/transilvania-motor-ring.v2.json` and its generator. Reuse the
  same serialization approach so byte-stability testing works the same way. You may refactor
  shared helpers into a new module if needed, but TMR's generator, assets, and tests MUST remain
  byte-for-byte untouched and green.

### Binding geometry decisions (verified by LEAD against live Overpass — do not re-derive)
- Full layout splice: way **333031201** (main loop, 83 nodes, closed, 3326.1 m) with the segment
  between its node-index 74 (node 3401455119) and node-index 79 (node 8791129031) REPLACED by
  way **949617051** (26 nodes, same orientation: its first node = main idx 74, last node = main
  idx 79). Result: 103 points, closed loop, computed length ≈ 4056.2 m. Assert these in the
  generator (fail loudly if the archived data ever changes shape).
- Ways 333031200 (120 m chord) is a short-configuration chord — NOT part of the full layout.
- Node order of the spliced loop is CLOCKWISE; `direction: "clockwise"`.
- Start/finish: place the S/F gate at the spliced loop's seam vertex (the main loop's first/last
  node, ≈ 44.77972, 26.47208) — it sits on the main straight between pit entry (SE) and pit exit
  (NW). Gate perpendicular to the centerline, same width rules as TMR. Rotate/normalize the
  centerline if needed so distances are measured from S/F, matching how TMR's asset is laid out.
- Sector gates: apply the TMR **v2 "straight vertex" rule verbatim** (targets 1/3 and 2/3 of lap
  distance, nearest qualifying vertex within ±180 m, straightness = mean |turning| over ±40 m
  window < 0.008 rad/m). Copy the rule text into confidenceNotes adapted for this circuit.
- Pit lane: ways **953930215** (249 m, SE, track-side entry near 44.77690, 26.47614) then
  **953930214** (430 m, NW, rejoins near 44.78067, 26.47028). There is a ~41 m unmapped gap
  between the two ways (garage apron) — bridge it with a straight connector in
  `pitLane.polyline` and say so in confidenceNotes. `entryGate` where 953930215 leaves the
  track, `exitGate` where 953930214 rejoins, kinds/ids following TMR conventions
  (`pit-entry`/`pit-exit`).
- `corridorWidthM: 16` (published width 11–16 m + GNSS margin; note rationale in confidenceNotes).
- Identity: `circuitId: "motorpark-romania"`, `displayName: "MotorPark România"`,
  `country`/`locality` following TMR's field style (locality "Adâncata, Ialomița"),
  `layoutId: "full"`, `layoutVersion: 1`.
- Provenance/source: OpenStreetMap, ODbL, retrievedAt 2026-08-26, way IDs listed. ODbL
  attribution text mandatory. NOTHING may be labeled "official" — gates are app-defined
  (ADR-0002). confidenceNotes MUST record: published length 4052 m (racingcircuits.info) vs
  4129 m (motorparkromania.ro) vs computed 4056.2 m; geometry traced from OSM aerial mapping and
  NOT validated on-site; the splice rule; the pit-gap bridge; corridor rationale.

## Regression tests (motorpark-profile.asset.test.ts, mirror TMR's suite)
1. Byte-stable pin: re-running the generator reproduces the checked-in asset exactly.
2. Length sanity: |totalLengthM − 4052| / 4052 ≤ 0.01.
3. All timing gates (S/F, sector-1, sector-2, pit entry/exit) sit on straights below the same
   curvature threshold used by TMR's gate test (0.008 rad/m).
4. Profile loads through the production load path (same loader TMR's test uses) and yields a
   runtime with matching centerline/cumulativeDistances lengths.
5. Corner-count PLAUSIBILITY only: run `analyzeCorners` on the profile and assert the corner
   count is within [10, 18] (published sources say 14 curves / 16 turns; the exact pin happens
   AFTER LEAD verifies against the published map — do NOT pin exact sequence or count now).
6. TMR suite untouched and still green (byte-stable pins prove no cross-contamination).

## Corners report (for LEAD)
Write `.foreman/scratch/motorpark-corners-report.md`: for each corner from `analyzeCorners`
(current CORNER_ANALYSIS_VERSION, unchanged): index, direction (left/right), entry distance from
S/F (m and % of lap), arc angle (deg), minRadiusM, severity, advisory speed. Plus total corner
count and a one-line ASCII/coordinate sketch hint (bounding box + S/F position) so the LEAD can
compare against the published track map.

## CONSTRAINTS
- Deterministic output: no timestamps from clock (use the fixed retrievedAt/createdAt dates),
  stable key order, same number formatting as TMR serialization.
- Do NOT modify: `analyzeCorners.ts` (no version bump — no algorithm change), TMR generator/
  assets/tests, `data/osm/**`, calibration/matching thresholds, anything in apps/mobile.
- No new dependencies.

## MUST DO
- Gates, each with real exit codes (`cmd; echo EXIT=$?` style, never piped through grep):
  `npm run typecheck` → 0, `npm test` → 0 (all workspaces), `npm run lint` → 0.
- Report the exact test totals before/after.

## MUST NOT
- Spawn other agents/workers.
- Touch files outside the WRITE SET.
- Invent any external fact — every external number you need is in the research addendum; if
  something is missing, report NEEDS_CONTEXT instead of guessing.

## WRITE SET
- `packages/core/scripts/generate-motorpark-profile.ts` (new)
- `packages/core/scripts/**` new shared helper module ONLY if strictly needed (never edit the TMR script)
- `packages/core/assets/circuits/motorpark-romania.v1.json` (new, generated)
- `packages/core/test/profile/motorpark-profile.asset.test.ts` (new)
- root `package.json` (one script line)
- `.foreman/scratch/motorpark-corners-report.md` (new)

## OUTPUT FORMAT
Open with exactly one status: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED.
Then: files created/changed, gate outputs with exit codes, test counts, corner count found,
computed totalLengthM, and any deviations from this ticket (each flagged as a CONCERN).
