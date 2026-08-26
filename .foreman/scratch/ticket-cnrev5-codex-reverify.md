# Review ticket CN-REV5 — Codex read-only RE-VERIFY of CN-FIX4 (facade boundary), mobile + one core file

Same adversarial READ-ONLY reviewer role as CN-REV4 (prior report: `.foreman/scratch/cnrev4-codex-output.log`).
Fix landed in commit `a2681e3` (diff: `git diff fd9a5c6..a2681e3`). Binding spec: the "facade boundary amendment"
at the end of `docs/architecture/contracts.md`. Use the read-only Node/Git path if spawning is denied, and say so.

## TASK
1. Per prior item — N3 residual (async facade start), delete-all vs async persistence (both sub-cases), N5
   cancelled-run selection, unbundled recovery discard, test gaps — verdict FIXED / PARTIAL / NOT FIXED with
   file:line evidence and a concrete failing scenario for anything not FIXED.
2. Hunt NEW defects introduced by FIX4, especially:
   - `SwappableFacade.runLockedCommand` + `whenCommandsSettled`: deadlock/re-entry (a locked command whose
     inner work triggers a settings subscriber, `onSessionEnded` callback, history refresh or DevReplay restore
     that itself takes the lock); a facade command issued while the lock is held by a long section (recovery,
     delete-all) — does the UI hang or queue correctly; `endSession` telemetry side-effect ordering (F2
     semantics) preserved; error in a locked command releases the lock and surfaces `lastError`.
   - `SessionController.start()` disposed re-checks (`packages/core/src/controller/sessionController.ts`):
     un-minting the session id — any observer that already saw the id (facade callbacks, checkpoint)? Provider
     stop on abort — does it stop a provider that another controller now owns (shared gnssProvider singleton)?
     TMR/DevReplay/soak behavior unchanged (core tests 653 green — verify nothing weakened).
   - Delete-all controller rebuild: interaction with `productionControllerCircuitId`, history store, pending
     recovery, Results screen state, DevReplay-active guard; web preview `db === null` path.
   - Background checkpoint hook: `MID_SESSION_STATES` includes `paused`? A paused session must still checkpoint.
   - Any TMR-default behavior change vs `529078f` for a user who never selects.
   - Are the new tests (`composition.facadeBoundary.test.ts`, `sessionControllerDisposeDuringStart.test.ts`)
     substantive — would they fail on the original bugs?

## OUTPUT FORMAT
First line `PASS` / `FAIL` / `PASS_WITH_NOTES`; per-item table; NEW findings by severity with file:line +
scenario + evidence; Clean list. Stdout only. No agents.
