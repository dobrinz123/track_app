# Review ticket P4g-REV3 — Codex read-only FINAL bounded re-verify of P4g fix wave 2
Prior: `.foreman/scratch/p4grev2-codex-output.log`. Diff: `git diff d992353..3e687b2`. Read-only Node/Git path if spawning is denied.
TASK (bounded): verdict FIXED/PARTIAL/NOT FIXED + file:line + failing scenario for: (1) `starting` latch clears after every launch attempt (success, failure, queued) — trace both call sites; (2) stale 'stopped' emission guarded by generation across teardown → discovery. Then ONLY new defects in the touched functions (e.g. a Start during the teardown-then-relaunch branch, generation counter races). Nothing else.
OUTPUT: first line PASS / FAIL / PASS_WITH_NOTES; 2-row table; NEW findings; Clean list. Stdout only. No agents.
