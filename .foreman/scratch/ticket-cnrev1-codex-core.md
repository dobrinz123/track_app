# Review ticket CN-REV1 — Codex read-only cross-review: MotorPark România circuit (core scope)

You are an independent, adversarial READ-ONLY reviewer (verifier role). Assume the work is broken
until you personally find evidence otherwise. Do not trust commit messages, comments, or test
names — read the code and the data. You cannot modify anything; you may run read-only commands
(`git`, `node -e`, `npx vitest run <file>` if the sandbox allows execution — if it does not, say so
and reason from source).

## Scope (commits 6de8dd8, 1a10ec5, 6df7ebd on top of 14067bc — review ONLY the core parts here)
- `packages/core/scripts/generate-motorpark-profile.ts` (new deterministic generator)
- `packages/core/assets/circuits/motorpark-romania.v1.json` (generated asset)
- `packages/core/test/profile/motorpark-profile.asset.test.ts`
- `packages/core/src/fixtures/motorpark-scenarios.ts`, `packages/core/src/fixtures/index.ts`
- `packages/core/src/fixtures/scenarios.ts` (bug fix in `pitLaneTransitLap` — S/F at seam)
- `packages/core/test/soak/motorparkTrackDayScenario.soak.test.ts`
- `packages/core/test/catalog/catalog.test.ts`
- `package.json` (one script line)
- Inputs: `data/osm/overpass-motorpark-geom.json`, `data/osm/overpass-motorpark-tags.json`
  (raw Overpass responses, ODbL). Reference implementation: `generate-tmr-profile.ts` +
  `transilvania-motor-ring.v2.json` + `tmr-profile.asset.test.ts`.
- Context docs: `docs/NEXT-CIRCUIT-PLAYBOOK.md`, `.foreman/scratch/motorpark-research.md`
  (ONLY its "LEAD VERIFICATION ADDENDUM" section is authoritative for OSM facts).

## Binding facts to check against (LEAD-verified from live Overpass)
- Full layout = way 333031201 (83 nodes, closed, 3326.1 m) with the arc between its node-index 74
  (node 3401455119) and node-index 79 (node 8791129031) replaced by way 949617051 (26 nodes, same
  orientation). Expected ~4056 m (published 4052 m racingcircuits.info; 4129 m official site).
- Node order clockwise. S/F at the main-loop seam vertex (~44.77972, 26.47208) on the main straight
  between pit entry (way 953930215, SE) and pit exit (way 953930214, NW); ~41 m unmapped gap
  between the two pit ways, bridged straight.
- Sector gates by the TMR v2 "straight vertex" rule (1/3, 2/3 targets, ±180 m search, straightness
  mean|turn| over ±40 m < 0.008 rad/m). corridorWidthM 16.
- Corner analysis (CORNER_ANALYSIS_VERSION 3 unchanged) must yield exactly 10 corners
  R R L L R R L R R L; corner 8 is a same-direction compound >150° (verified vs published map).

## What to attack (be concrete: file:line + failing input/state → wrong output)
1. Splice correctness: does the generator really produce the loop described, in the right
   orientation, without duplicated/missing vertices at the two junctions or at the seam? Recompute
   the length independently from the raw JSON (`node -e`) and compare to the asset's totalLengthM.
2. Determinism: any source of nondeterminism (object key order, Date, float formatting,
   locale, Map iteration, path separators)? Would a second run on another OS differ?
3. Gate geometry: S/F, sector, pit gates — are `a`/`b` endpoints on the correct side/width, is the
   gate perpendicular, does every gate sit on a straight per the test's own threshold; are pit
   entry/exit gates placed where the pit ways actually leave/rejoin the track (not at arbitrary
   endpoints)? Could the pit exit gate be crossed by cars on the racing line (false pit detection)?
4. Direction/timing semantics vs TMR: anything the matcher/timing engine assumes about the S/F
   being at distance 0 or at the seam (cumulative distance wrap, `pitLaneTransitLap` fix in
   `scenarios.ts`) — is the fix correct for BOTH circuits, and TMR byte/behavior-neutral?
5. Test strength: would each test in `motorpark-profile.asset.test.ts` actually fail if the
   asset were regenerated with a wrong splice / wrong direction / shifted S/F? Name any test that
   is vacuous. Is the byte-stable pin real (does it call the generator, not just re-read the file)?
6. Provenance/licensing: ODbL attribution present in `source`; nothing labeled "official";
   confidenceNotes record both published lengths, the not-validated-on-site caveat, splice, pit
   bridge, corridor rationale.
7. Soak test: does it genuinely exercise the production calibration engine with UNMODIFIED
   thresholds on MotorPark (calibrate once, hard/cool laps, pit transit flagged, 1 h pause +
   watchdog, no recalibration), or does it weaken/skip any assertion relative to the TMR original?
8. Regressions: any change in behavior for TMR anywhere in scope (fixtures index exports, shared
   helpers, catalog test)?

## OUTPUT FORMAT
First line: exactly one of `PASS` / `FAIL` / `PASS_WITH_NOTES`.
Then findings ordered by severity (CRITICAL/HIGH/MED/LOW/INFO), each with: file:line, the concrete
failure scenario (input → wrong output), and evidence (what you ran/read). Then a "Clean" list of
attack angles you checked and found sound. Write nothing outside stdout. Do not spawn agents.
