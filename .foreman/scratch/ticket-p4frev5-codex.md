# Review ticket P4f-REV5 — Codex read-only FINAL bounded re-verify of P4f fix wave 4
Prior: `.foreman/scratch/p4frev4-codex-output.log`. Diff: `git diff 4dd9990..199ff67`. Read-only Node/Git path if spawning is denied.
TASK (bounded): verdict FIXED/PARTIAL/NOT FIXED + file:line + failing scenario for: (1) sync/async close() failures contained + unconditional release (sweep controller); (2) observation tMs relative to start (+startedAtMs) consistent with the UI's GNSS series; (3) pacing wait rechecks stopped/deadline/paused (no extra send). Then ONLY new defects in the touched functions. Nothing else.
OUTPUT: first line PASS / FAIL / PASS_WITH_NOTES; 3-row table; NEW findings; Clean list. Stdout only. No agents.
