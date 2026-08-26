# Ticket CN-W2 — MotorPark România: app catalog entry + replay fixtures + acceptance soak + DevReplay

## TASK
Wire the new circuit asset `packages/core/assets/circuits/motorpark-romania.v1.json`
(circuitId `motorpark-romania`, produced by ticket CN-W1 — already in the tree) into the
runtime: the mobile circuit catalog, hardware-free replay fixtures, the acceptance soak test
pattern, and the DevReplay screen so the preview E2E can exercise the new circuit end to end.

## EXPECTED OUTCOME
1. **Catalog (mobile)**: `apps/mobile/src/session/circuitCatalog.ts` `ENTRIES` gains the MotorPark
   profile + runtime (same load path as TMR: static import of the JSON asset so it is inlined in
   the Hermes bundle, never fetched — offline mandate). `CircuitSelectionScreen` must list both
   circuits with correct displayName / locality / country / length; do not restyle it.
   If `packages/core` exports a typed TMR constant (e.g. `TMR_CIRCUIT_PROFILE`), add the
   analogous MotorPark export in the same module following the identical pattern.
2. **Fixtures (core)**: in `packages/core/src/fixtures/` add MotorPark scenarios built with the
   existing profile-parametrized `driveLap` (no new fixture engine): at minimum
   `motorparkCleanRecognitionLap`, `motorparkMultiLapSession` (3 laps), and
   `motorparkPitLaneTransitLap` — mirroring the TMR fixture set's naming/metadata
   (`withFixtureMetadata`, seeds fixed, expectedOutcome set). Export them from the fixtures index.
3. **Acceptance soak (core)**: add `packages/core/test/soak/motorparkTrackDayScenario.soak.test.ts`
   porting `userTrackDayScenario.soak.test.ts` to the MotorPark profile: calibrate once, hard/cool
   laps, pit transit lap flagged PIT_TRANSIT, 1-hour silence with watchdog recovery, 2 post-pause
   laps, NO recalibration after resume. Reuse the existing rig helpers (`controllerRig`,
   `SampleTimeline`, etc.) — extract shared helpers into a common test module ONLY if the import
   graph forces it, and keep the TMR soak byte-identical in behavior.
4. **DevReplay (mobile)**: `apps/mobile/src/ui/screens/DevReplayScreen.tsx` currently runs every
   scenario against `TMR_CIRCUIT_PROFILE` (hardcoded). Make it run against the profile of the
   scenario's circuit: add the MotorPark scenarios to `SCENARIOS` with a `circuitId` field (TMR
   scenarios keep `circuitId` of TMR) and resolve the profile via the catalog. Labels must make the
   circuit obvious in the list (e.g. prefix "MotorPark — "). Behavior for TMR scenarios must not
   change.
5. **Catalog test (core)**: extend `packages/core/test/catalog/catalog.test.ts` (or add a new test
   file) so the catalog lists BOTH circuits with distinct keys and `get("motorpark-romania")`
   returns a profile+runtime with matching centerline/cumulativeDistances lengths.
6. **About/legal**: verify the ODbL attribution text shown in the app's About/legal screen covers
   BOTH circuits (it must remain user-visible; if the copy names only TMR, generalize the wording
   to "circuit geometry" without deleting anything). Report what you found.

## CONTEXT
- Repo: D:\CODE\APLICTIE_Circuit. Read `docs/NEXT-CIRCUIT-PLAYBOOK.md` §1–2 first.
- The core catalog (`packages/core/src/catalog/catalog.ts`, `createCircuitCatalog`) is already
  multi-circuit; the mobile `AppCircuitCatalog` (`list()`/`get(circuitId)`) is the surface to extend.
- The soak tests are the acceptance proof that the whole controller works hardware-free on this
  circuit; they must pass with the production calibration engine and its CURRENT thresholds
  (0.85 coverage / 250 m max gap, 40 m learn corridor) — do NOT touch calibration/matching code or
  thresholds. If the MotorPark soak cannot pass without threshold changes, STOP and report
  DONE_WITH_CONCERNS with the exact numbers (coverage, gaps) — that is a geometry finding for the
  LEAD, not something to paper over.
- Web preview has no SQLite (in-memory fallback) — nothing here should depend on it.

## CONSTRAINTS
- No new dependencies. No changes to `packages/core/src/corners/**`, `calibration/**`,
  `matching/**`, TMR assets/generator/tests, `data/osm/**`.
- Settings/UI defaults unchanged; no driving-screen changes.
- Keep TMR behavior byte-identical (existing tests are the proof).

## MUST DO
- Gates with real exit codes (`cmd; echo EXIT=$?`, never piped through grep):
  `npm run typecheck` → 0, `npm test` → 0, `npm run lint` → 0,
  `cd apps/mobile && npx expo export --platform ios` → 0 (confirm the MotorPark asset JSON is
  inlined in the exported bundle: grep the dist output for `motorpark-romania` and report the hit
  count — this is evidence, run it as a separate command after the export gate).
- Report test totals before/after.

## MUST NOT
- Spawn other agents/workers. Touch files outside the WRITE SET. Trigger any CI/ipa build.
- Invent circuit facts — everything comes from the asset JSON.

## WRITE SET
- `apps/mobile/src/session/circuitCatalog.ts`
- `apps/mobile/src/ui/screens/DevReplayScreen.tsx`
- `apps/mobile/src/ui/screens/CircuitSelectionScreen.tsx` (only if a change is strictly required — report why)
- `apps/mobile/src/**/About*` / legal copy file (attribution wording only, if needed)
- `apps/mobile/test/**` (new/extended tests for catalog + DevReplay resolution)
- `packages/core/src/fixtures/**` (new MotorPark fixture file + index export)
- `packages/core/src/index.ts` and `packages/core/src/profile/**` ONLY for the analogous MotorPark profile constant export
- `packages/core/test/soak/motorparkTrackDayScenario.soak.test.ts` (new) + a shared soak helper module if extraction is unavoidable
- `packages/core/test/catalog/**`

## OUTPUT FORMAT
Open with exactly one status: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED.
Then: files changed, gate outputs with exit codes, test totals, soak results (calibration
coverage/gap numbers for MotorPark), bundle grep evidence, About/attribution finding, deviations
(each flagged CONCERN).
