# Review ticket CN-REV6 — Codex read-only FINAL re-verify of CN-FIX5 (4 items only)

Same adversarial READ-ONLY reviewer as CN-REV5 (prior report: `.foreman/scratch/cnrev5-codex-output.log`).
Fix landed in commit `12e413d` (diff: `git diff a2681e3..12e413d`). Binding spec: the "closing amendment" at the
end of `docs/architecture/contracts.md`. Use the read-only Node/Git path if spawning is denied, and say so.

## TASK (bounded — do not re-review the whole campaign)
For each of the four REV5 items give FIXED / PARTIAL / NOT FIXED with file:line evidence, and a concrete
failing scenario for anything not FIXED:
1. queued `endSession()` telemetry re-stop inside the locked section (F2 guarantee when the command queued);
2. core `SessionController.start()` abort-on-dispose never stops the shared provider (2-controller test);
3. delete-all refused `DEV_REPLAY_ACTIVE` while a replay controller is installed, before any deletion;
4. DevReplay cancellation honored only before the selection write; mid-write cancel leaves settings/history/
   controller consistent; install/navigation skipped; no rollback.
Then ONLY: any NEW defect introduced by this diff (regressions in the touched functions, test weakening,
TMR default path). Nothing else.

## OUTPUT FORMAT
First line `PASS` / `FAIL` / `PASS_WITH_NOTES`; 4-row table; NEW findings (if any) with file:line + scenario;
Clean list. Stdout only. No agents.
