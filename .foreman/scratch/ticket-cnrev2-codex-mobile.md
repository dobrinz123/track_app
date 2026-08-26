# Review ticket CN-REV2 — Codex read-only cross-review: multi-circuit selection (mobile scope)

You are an independent, adversarial READ-ONLY reviewer (verifier role). Assume the work is broken
until you personally find evidence otherwise. Read code and tests; do not trust comments/commit
messages. You may run read-only commands (`git`, `node -e`, `npx vitest run <file>` if the sandbox
allows; if not, say so and reason from source).

## Scope
The "Multi-circuit selection addendum" at the end of `docs/architecture/contracts.md` (binding
spec) and its implementation — everything changed under `apps/mobile/**` between commit `d829ce8`
and HEAD (`git diff d829ce8..HEAD --stat -- apps/mobile`), plus the CN-W2 mobile changes in
`6df7ebd` (`circuitCatalog.ts`, `composition.ts` `startDevReplaySession` circuit param,
`devReplayScenarios.ts`, `DevReplayScreen.tsx`). Reference context: `docs/NEXT-CIRCUIT-PLAYBOOK.md`,
`.foreman/scratch/ticket-cnw3-selected-circuit.md` (the implementation ticket).

## What to attack (concrete: file:line + input/state → wrong output)
1. **Controller/circuit consistency**: can a production `SessionController` ever run with a
   circuit different from the persisted selection? Walk every build path: bootstrap,
   preflight-gate rebuild (terminal OR circuit-changed-when-idle), coaching-settings rebuild,
   recovery resume, DevReplay swap/restore. Race: `selectCircuit()` called while a rebuild is in
   flight (`rebuildInFlight` serialization) or while a DevReplay controller is active.
2. **Mid-session protection**: is a rebuild impossible in `outLap`/`timing`/`inPit`/`paused`?
   Can the selection change while a session runs (navigation reachable? back-stack?) and what
   happens then — refused (spec) or applied?
3. **History/PB**: is `SqlSessionHistoryStore` rebuilt on selection AND at bootstrap for the
   persisted selection? Does `historyStore` (module variable used by `onSessionEnded` refresh)
   point at the NEW store after a switch, or does a stale reference refresh the wrong circuit?
   PB reference lookups keyed by circuit/layout/version — any path still using TMR's?
4. **Recovery**: circuit resolved via `listSessions` scan — correct when the active session
   belongs to the non-selected circuit; when it belongs to no bundled circuit (discard + pointer
   clear, no banner); when `db === null` (web preview). Does `resumeRecovery()` resume on the
   controller built for the checkpoint's circuit, or can it resume TMR's controller with a
   MotorPark checkpoint (or vice versa)?
5. **Delete-all**: spans every catalog entry with per-circuit verify-empty; aggregated result
   semantics (partial failure reported as failure?); telemetry step preserved.
6. **Settings hydration**: `selectedCircuitId` default when the persisted row lacks the key;
   unknown id → fallback + warn (never throw); the settings write path persists it.
7. **Screens**: `CircuitDetailScreen` renders from the catalog profile for BOTH ids; any leftover
   TMR constants in `ActiveCalibrationScreen` (corridor width, centerline, S/F),
   `PersonalBestScreen`, `SessionHistoryScreen`, `CircuitSelectionScreen` navigation param;
   the word "official" must not appear in circuit copy; ODbL attribution present.
   360pt-wide/1.3x font-scale overflow risk on CircuitDetail from longer MotorPark text.
8. **Coaching**: production AND DevReplay controllers get the circuit's own corners; MotorPark
   receives NO observed-speeds overlay; TMR's overlay unchanged.
9. **Offline/static bundle**: all profile JSON via static import; no dynamic import/fetch.
10. **Tests**: are the new mobile tests meaningful (would they fail on the bugs above), or
    tautological? Name any vacuous test.
11. **Regressions for TMR default**: with selection = TMR, is behavior byte-identical to before
    (bootstrap order, gate behavior, history)?

## Known gap (already identified — do not spend effort re-finding it; DO assess the planned fix)
`@circuit/core` writes the `sessions` row only in `endSession()`, so a crashed in-progress session
is never in `listSessions` → the implemented `resolveRecoveryCircuitId` falls back to the persisted
selection (which was persisted at select time, before the session started). Residual edge case:
user switches circuit after a crash and before tapping resume. Planned fix (next wave, mobile-only):
persist `activeSessionCircuitId` in the mobile `settings` table beside `activeSessionId` in
`onSessionStarted`, read it first at bootstrap recovery, fall back to the scan, then to the
selection. Tell us if that design has a hole (e.g. ordering vs `setActiveSessionId`, clearing on
session end/discard, delete-all).

## OUTPUT FORMAT
First line: exactly one of `PASS` / `FAIL` / `PASS_WITH_NOTES`. Then findings ordered by severity
(CRITICAL/HIGH/MED/LOW/INFO) with file:line, concrete failure scenario and evidence; then a
"Clean" list of attack angles checked and found sound. Stdout only. Do not spawn agents.
