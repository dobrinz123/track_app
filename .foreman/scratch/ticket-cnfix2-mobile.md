# Ticket CN-FIX2 — batched fix wave: Codex CN-REV2 (mobile) + blind-verifier notes

## TASK
Fix ALL findings below in one wave, per the LEAD-binding designs and the new contracts amendment
"Multi-circuit selection — recovery amendment" at the end of `docs/architecture/contracts.md`
(read it first). Mobile scope only. Full Codex report: `.foreman/scratch/cnrev2-codex-output.log`
(after the line `FAIL`).

## Findings + binding designs
**H1 — selection during bootstrap lost** (`composition.ts` selectCircuit early-returns while
`repository === null`; `CircuitSelectionScreen` navigates anyway). Design: `selectCircuit()`
`await ready()` first, then applies to the REAL settings store; `CircuitSelectionScreen` awaits
`selectCircuit` before navigating (disable the row / show a pending state while awaiting; on
`{ok:false}` do not navigate and `console.warn`). Test: select before bootstrap resolves →
after bootstrap the persisted setting, history store and controller circuit are the selected one.

**H2 — mid-session selection applied.** Design: `selectCircuit()` reads the active controller's
state (`currentControllerState(activeController)`); if in `outLap`/`timing`/`inPit`/`paused` →
return `{ ok: false, reason: 'SESSION_ACTIVE' }` WITHOUT touching settings/history. Rewrite the
test at `composition.circuitSelection.test.ts:174-208` to assert refusal (settings unchanged,
history store unchanged).

**H3 — `rebuildInFlight` race.** Design: preflight gate and `resumeRecovery()` begin with
`if (rebuildInFlight) await rebuildInFlight;` (loop until null) BEFORE reading controller state or
circuit; keep existing serialization for the rebuild itself. Test: toggle coaching (starts a
rebuild) then immediately `startPreflight()` → preflight lands on the fresh controller, never the
disposed one.

**M1 — concurrent selections not serialized.** Design: module-level `selectionChain: Promise<void>`;
`selectCircuit` chains onto it (`selectionChain = selectionChain.then(run, run)`), so calls apply
in order and the last one wins for settings AND history store. Test: two rapid selects with a
slow first history refresh → final history store is the last selection's.

**M2 — DevReplay does not select the circuit.** Design: `DevReplayScreen.runScenario` (or
`startDevReplaySession`) awaits `selectCircuit(scenario.circuitId)` before starting the replay;
if refused (`SESSION_ACTIVE`) abort the run with a visible error message. Calibration map, history
and detail then agree with the replay controller (dev-only path; document in the screen comment).

**M3 — delete-all aborts on rejection.** Design: per-circuit `try/catch`; continue with the
remaining circuits; aggregate `ok = every circuit ok && no rejections`; include failed circuit ids
in the result's error text. Test: first circuit rejects → second still attempted, result `ok:false`.

**M4 — recovery circuit persistence (planned fix, now binding per contracts amendment).**
Design: new settings key `activeSessionCircuitId` (mobile `settings` table, same helpers as
`activeSessionId`); write BOTH in one transaction in `onSessionStarted` (capture the circuit of
the controller that started the session — pass it into `productionFacadeCallbacks(circuitId)`);
clear both together in every place `setActiveSessionId(db, null)` is called (session end,
discard, vanished checkpoint, delete-all). Bootstrap recovery order: persisted circuit id →
`listSessions` scan → selection (warn). Not-bundled id → discard with warning. `resumeRecovery()`
reasserts both after resuming. If a single-transaction write isn't possible with the existing
helper, write circuit BEFORE id and clear id BEFORE circuit, and say so in the report. Tests:
crash on MotorPark, switch selection to TMR, resume → controller is MotorPark; unbundled id →
discarded; keys cleared on end/discard.

**L1 — gate compares raw setting.** Compare `productionControllerCircuitId` against
`resolveSelectedCircuit(settings).profile.circuitId` (resolved), so an unknown persisted id does
not cause a rebuild on every preflight. Test it.

**L2 — "official" render branches** (also blind-verifier finding): remove the
`CircuitDetailScreen.tsx:186-187` branch that can render "Official" as a geometry/sector status
(render the raw status string or a neutral label — never the capitalized "Official" label); keep
the negated disclaimers ("not an official …") — they are required copy. Test: for both circuits'
`circuitDisplayData` and the status-label helper, every occurrence of /official/i is immediately
preceded by "not an " (regex `/not an official/i` count === /official/i count).

**L3 — vacuous provenance test.** `circuit.test.ts:47-53` must assert license AND
`retrievedAt` appear. Also tidy `circuitDisplayData`'s provenance text: ONE attribution line
(`© OpenStreetMap contributors · ODbL 1.0 · way <ids> · retrieved <date>`) — do NOT append the
raw `confidenceNotes[0]` verbatim (it duplicated the attribution on screen).

## CONSTRAINTS
- No changes under `packages/core/**`, no new deps, no calibration/matching/corner changes, no
  driving-screen layout changes. TMR default behavior unchanged (existing tests prove it).
- Web preview (`db === null`): every path must still work (settings in memory, no persisted keys).

## MUST DO
Gates with real exit codes (`cmd; echo EXIT=$?`, never piped through grep): `npm run typecheck` →
0, `npm test` → 0, `npm run lint` → 0, `cd apps/mobile && npx expo export --platform ios` → 0.
Report per-finding status (H1–H3, M1–M4, L1–L3: FIXED / NOT), test totals before/after.

## MUST NOT
Spawn agents; touch files outside the WRITE SET; commit.

## WRITE SET
- `apps/mobile/src/session/{composition.ts, circuitCatalog.ts, settingsStore.ts, devReplayScenarios.ts}`
- `apps/mobile/src/ui/screens/{CircuitSelectionScreen,CircuitDetailScreen,DevReplayScreen,ActiveCalibrationScreen,SettingsScreen}.tsx`
- `apps/mobile/src/ui/data/circuit.ts`, `apps/mobile/src/ui/components/CornersList.tsx` (only if a status label lives there)
- `apps/mobile/test/**`

## OUTPUT FORMAT
First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED; then per-finding status, gate
outputs with exit codes, totals, deviations flagged CONCERN.
