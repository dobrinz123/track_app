# Ticket CN-W3 — Selected-circuit plumbing (make MotorPark actually driveable)

## TASK
Implement the "Multi-circuit selection addendum" appended to
`docs/architecture/contracts.md` (read it first — it is BINDING). Today the app lists two circuits
but every production session, history store, delete-all, coaching corner set, calibration track
map, CircuitDetail and PB screen hardcode TMR. After this ticket, tapping MotorPark România drives
the whole flow (detail → preflight → calibration → laps → results → history) on MotorPark, and TMR
behaves exactly as before when selected (default).

## EXPECTED OUTCOME (binding designs — implement these, don't redesign)
1. **Settings**: `apps/mobile/src/session/settingsStore.ts` — add `selectedCircuitId: string` to
   `AppSettings` (+ `DEFAULT_SETTINGS` = TMR's circuitId). Persist/hydrate exactly like the other
   fields (check `SqlSettingsStore` handles a newly-added key with the default when absent).
2. **Catalog carries corners**: `apps/mobile/src/session/circuitCatalog.ts` — entries become
   `{ profile, runtime, corners }`. TMR corners = the existing `TMR_CORNERS` (observed-speeds
   overlay applied, unchanged); MotorPark corners = `analyzeCorners(MOTORPARK_RUNTIME_PROFILE)`
   with NO overlay. Add `resolveSelectedCircuit(settings): BundledCircuit` (unknown id → TMR +
   `console.warn`). Keep `tmrProfile.ts` exports intact (other modules/tests import them).
3. **composition.ts**:
   - `coachingConfig(circuit)` uses `circuit.corners`; `createProductionController()` resolves
     the selected circuit from `settingsStore.getSettings().selectedCircuitId` and passes its
     profile/runtime/corners; remember `productionControllerCircuitId`.
   - Preflight gate (`setPreflightGate`, ~line 1055): rebuild also when
     `productionControllerCircuitId !== selectedCircuitId && state === 'idle'`. Never rebuild
     in `outLap`/`timing`/`inPit`/`paused` (contracts). Reuse `rebuildProductionController()`
     (serialized, F3).
   - Export `async function selectCircuit(circuitId: string): Promise<void>`: validates via
     catalog, updates settings, rebuilds `SqlSessionHistoryStore` for that circuit
     (`historyWrapper.setInner` + `refresh()`, same as bootstrap), so History/PB show it.
     Bootstrap builds the history store for the persisted selection, not TMR.
   - Recovery at bootstrap (~line 1073): resolve the active session's circuit by looking
     `activeSessionId` up in `repository.listSessions(LOCAL_USER_ID, circuitId)` across catalog
     entries; if found and it differs from the selection, apply `selectCircuit(thatId)` BEFORE
     the controller is (re)built/resumed; if not found in any bundled circuit, treat as a vanished
     checkpoint (clear pointer, warn, no recovery banner). `resumeRecovery()` must resume on the
     controller built for that circuit (add a guard/rebuild if the controller's circuit differs).
   - `deleteAllStoredUserData()`: loop over ALL catalog entries calling core `deleteAllUserData`
     per (circuitId, layoutId, layoutVersion); aggregate (success only if every circuit verified
     empty); keep the telemetry-samples step unchanged.
   - `startDevReplaySession(samples, circuit)` (CN-W2) stays; make the DevReplay controller use
     `circuit.corners`-aware coaching too (currently `coachingConfig()` hardcodes TMR corners for
     replay as well) — resolve corners from the catalog by the replay circuit's id.
4. **Navigation + screens**:
   - `ui/navigation/types.ts`: `CircuitDetail: { circuitId: string }`.
   - `CircuitSelectionScreen`: on row press → `await selectCircuit(circuit.circuitId)` then
     `navigate('CircuitDetail', { circuitId })`. Remove the "only one row exists today" comment.
   - `CircuitDetailScreen`: render from the catalog profile via `route.params.circuitId`
     (displayName, locality, country, length km, layoutId, direction, geometryStatus,
     sectorStatus, provenance text built from `profile.source` (name/url/license/retrievedAt) +
     `confidenceNotes` first note, ODbL attribution `© OpenStreetMap contributors (ODbL)`,
     `ADVISORY_NOTICE`), corners list = that circuit's `corners`. Replace `ui/data/circuit.ts`'s
     TMR constant usage with a `circuitDisplayData(profile)` helper in that file (keep the file,
     keep `ADVISORY_NOTICE`; TMR-specific extras like openedYear/county may remain in an optional
     per-circuitId extras map — do NOT invent extras for MotorPark beyond what's in its asset).
     "Start Session" unchanged (the selection is already persisted).
   - `ActiveCalibrationScreen`: centerline / S/F / corridorWidthM from the selected circuit
     (resolve via `resolveSelectedCircuit(settingsStore.getSettings())` — subscribe to settings
     if the store exposes a subscription, else read at mount).
   - `PersonalBestScreen` + `SessionHistoryScreen` headers: selected circuit's displayName ·
     layoutId (not the TMR constant).
5. **Tests** (`apps/mobile/test/**`, pure TS — no RN imports): (a) `resolveSelectedCircuit`
   fallback + warn; (b) catalog: MotorPark corners length 10 and NO observed-speed overlay, TMR
   corners identical to `TMR_CORNERS`; (c) `circuitDisplayData` for both circuits (never contains
   the word "official"); (d) composition-level tests following the existing
   `composition.lifecycle`/preflight-gate test pattern: gate rebuilds on circuit change when idle,
   does NOT rebuild when mid-session, delete-all touches both circuits (assert the per-circuit
   calls), recovery resolves the circuit from `listSessions` and discards an unbundled one. If a
   composition path is genuinely untestable in the current harness, say which and why.

## CONTEXT
- Repo D:\CODE\APLICTIE_Circuit, HEAD contains CN-W1/W2 (catalog with both circuits, DevReplay
  circuit-aware). Scout findings with exact lines: CircuitSelectionScreen.tsx:42,
  CircuitDetailScreen.tsx:39/185/189, navigation/types.ts:3, composition.ts:807-808 (coaching),
  819-844 (createProductionController), 1055-1071 (gate + history store), 1073+ (recovery),
  1248-1256 (delete-all), ActiveCalibrationScreen.tsx:58/70/138-139, PersonalBestScreen.tsx:29.
- `loadCheckpoint` returns `{ snapshot, laps }` only (no circuitId) — hence the `listSessions`
  lookup design; do NOT change `@circuit/core` persistence.
- Web preview: `db === null` → in-memory settings/repository; everything must work there too.
- Offline mandate: no network, static imports only.

## CONSTRAINTS
- No new dependencies. No changes under `packages/core/**` (if you believe one is unavoidable,
  STOP and report NEEDS_CONTEXT with the reason). No changes to calibration/matching thresholds,
  the dashboard/driving screen, voice, telemetry.
- TMR default path must remain behaviorally identical (existing tests are the proof).
- 360pt-wide / 1.3x font-scale rule: CircuitDetail must not overflow; keep the existing styles.

## MUST DO
- Gates with real exit codes (`cmd; echo EXIT=$?`, never piped through grep):
  `npm run typecheck` → 0, `npm test` → 0, `npm run lint` → 0,
  `cd apps/mobile && npx expo export --platform ios` → 0.
- Report test totals before/after and list every hardcoded TMR reference that remains in
  `apps/mobile/src` (excluding `tmrProfile.ts` itself and the catalog) with justification.

## MUST NOT
- Spawn agents. Touch files outside the WRITE SET. Commit. Trigger any build/CI.

## WRITE SET
- `apps/mobile/src/session/{settingsStore.ts, circuitCatalog.ts, composition.ts, tmrProfile.ts (comment-only if at all)}`
- `apps/mobile/src/session/selectedCircuit.ts` (new, optional helper module)
- `apps/mobile/src/ui/navigation/types.ts`, `apps/mobile/App.tsx` (only if navigator typing requires)
- `apps/mobile/src/ui/screens/{CircuitSelectionScreen,CircuitDetailScreen,ActiveCalibrationScreen,PersonalBestScreen,SessionHistoryScreen,SettingsScreen}.tsx` (SettingsScreen only if the delete flow's result shape changes)
- `apps/mobile/src/ui/data/circuit.ts`
- `apps/mobile/test/**`

## OUTPUT FORMAT
First line: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, gate outputs
with exit codes, test totals, remaining-hardcode list, deviations (each flagged CONCERN).
