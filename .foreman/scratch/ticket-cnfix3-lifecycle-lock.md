# Ticket CN-FIX3 — single lifecycle lock (Codex CN-REV3 findings), frontier seat

## TASK
Implement the "lifecycle lock amendment" at the end of `docs/architecture/contracts.md` (binding)
and close every open item from `.foreman/scratch/cnrev3-codex-output.log` (read the full report):
H3 PARTIAL, M3 PARTIAL, M4 PARTIAL, L2 PARTIAL, and NEW N1 (HIGH), N2 (HIGH), N3 (HIGH), N4 (MED),
N5 (MED), N6 (LOW), N7 (LOW, tests). Mobile scope only. This is the third wave on this area;
concurrency correctness is the whole point — design the critical sections deliberately and prove
each with a test that fails on HEAD (`5d7bcb2`) behavior.

## Binding design
1. **`lifecycleLock`** (`apps/mobile/src/session/lifecycleLock.ts`, pure TS, unit-tested): a
   re-entrancy-SAFE async mutex — `run<T>(fn: () => Promise<T>): Promise<T>` with FIFO ordering; an
   operation already holding the lock may call an `unlocked*` inner routine but MUST NOT call
   `run` again (document + assert in dev via a held-flag, throw `LifecycleLockReentry`). Replace
   `selectionChain` and `rebuildInFlight` with it; keep `withDevReplayLock` ONLY if you make it
   the same lock (preferred: it becomes `lifecycleLock.run`).
2. **Critical sections** (each one `lifecycleLock.run`): `selectCircuit`; `rebuildProductionController`
   (all three triggers — the coaching-settings subscriber must call the locked rebuild and SKIP if
   the controller is not idle/terminal at the time it acquires the lock); the preflight gate —
   restructure `SwappableFacade.setPreflightGate` so the gate receives a `forward` callback and the
   gate implementation calls it INSIDE the lock after (re)building; `resumeRecovery` and
   `discardRecovery` end-to-end (checkpoint read → rebuild for the recovery circuit → restore →
   start → reassert both keys); `deleteAllStoredUserData`; DevReplay `startDevReplaySession`
   (acquire lock FIRST, then `ready()`), `restoreProductionFacade`, and the screen's
   restore→select→start sequence as ONE locked operation (expose a composition-level
   `runDevReplayScenario(scenario)` that does all three inside one `run`, so the screen calls one
   function).
3. **N1 recovery circuit wins**: `PendingRecovery` gains `circuitId` (from the persisted
   `activeSessionCircuitId` / scan result at bootstrap). `resumeRecovery()` inside the lock: if
   the selection ≠ recovery circuit → apply the selection change with the unlocked inner routine
   (settings + history), rebuild for the recovery circuit, restore, start, reassert both keys with
   the RECOVERY circuit. The recovery banner text should name the circuit (displayName).
4. **N2**: covered by 2 (the controller is captured and used inside the same critical section as
   the rebuild decision; coaching rebuilds queue behind).
5. **N3**: covered by 2 (forward inside the lock; a queued selection then sees a non-idle
   controller and is refused with `SESSION_ACTIVE`).
6. **N4**: telemetry deletion + verify-empty ALWAYS runs; aggregate `ok = circuitsOk && telemetryOk`;
   `errorText` names failed circuit ids and/or "telemetry" — no exception text.
7. **N5**: DevReplayScreen owns `runGeneration` (increment on each run and on unmount); the
   composition-level `runDevReplayScenario` takes an `isCancelled: () => boolean` and checks it
   before installing the replay controller and before returning; on cancel it leaves production
   restored and installs nothing. Unmount cleanup = `lifecycleLock.run(restoreProductionFacade)`.
8. **N6**: `statusLabel('official')` → `'source-declared'`; test: for every schema-permitted status
   value the label never matches /official/i. Keep the negated disclaimers.
9. **N7 tests** (`apps/mobile/test/**`, pure TS, using the existing composition test harness):
   (a) N1: crash on MotorPark → after bootstrap select TMR → resumeRecovery → controller circuit
   is MotorPark, persisted `activeSessionCircuitId` = MotorPark; (b) N2: delayed `loadCheckpoint`
   + coaching toggle mid-recovery → resumed controller is the live production controller (facade
   state reflects it); (c) N3: MotorPark then TMR selections with delayed history + startPreflight
   in between → the preflight'd controller's circuit equals the persisted selection at the moment
   the session starts and the later selection is refused `SESSION_ACTIVE`; (d) N4: circuit
   rejection + seeded telemetry rows → telemetry deleted and verified; (e) N5: scenario started
   then cancelled before install → no replay controller installed, production facade intact;
   (f) lock unit tests: FIFO, re-entry throws, error propagation releases the lock; (g) keep all
   existing tests green (adjust only those that encoded the wrong behavior — list them).

## CONSTRAINTS
- No changes under `packages/core/**`; no new deps; no calibration/matching/corner/dashboard
  changes; TMR default path behavior identical for a user who never selects (existing tests +
  a bootstrap-ordering test prove it). Web preview (`db === null`) must keep working.
- Keep the SQL write gate semantics (`sqlWriteGate.ts`) untouched; the active-session transaction
  stays a single `withTransactionAsync`.

## MUST DO
Gates with real exit codes (`cmd; echo EXIT=$?`, never piped through grep): `npm run typecheck` →
0, `npm test` → 0, `npm run lint` → 0, `cd apps/mobile && npx expo export --platform ios` → 0.
Before writing fixes, write the N1/N2/N3/N4/N5 tests and RUN them against HEAD to confirm they fail
(report the failure lines) — then fix. Report per-item status (H3, M3, M4, L2, N1–N7) with
file:line, and test totals before/after.

## MUST NOT
Spawn agents; touch files outside the WRITE SET; commit; start/stop the Expo dev server on :8082.

## WRITE SET
- `apps/mobile/src/session/{composition.ts, lifecycleLock.ts (new), devReplayScenarios.ts, circuitCatalog.ts}`
- `apps/mobile/src/ui/screens/{DevReplayScreen,CircuitSelectionScreen,CircuitDetailScreen,SettingsScreen,PreflightScreen}.tsx` (Preflight/Settings only if the recovery banner or delete result shape needs it)
- `apps/mobile/src/ui/data/circuit.ts`, `apps/mobile/src/ui/components/**` (recovery banner only)
- `apps/mobile/test/**`

## OUTPUT FORMAT
First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED; then per-item status table, the
pre-fix failing test evidence, gate outputs with exit codes, totals, deviations flagged CONCERN.
