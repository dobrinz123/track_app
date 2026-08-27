# Review ticket P4e-REV5 — Codex read-only FINAL bounded re-verify of P4e fix wave 4 (reservation)
Prior: `.foreman/scratch/p4erev4-codex-output.log`. Diff: `git diff 3027d94..69b0a31`. Read-only Node/Git path if spawning is denied.
TASK (bounded): verdict FIXED/PARTIAL/NOT FIXED with file:line + failing scenario for the two REV4 HIGHs:
(1) overlapping provider generations (token identity; start awaits in-flight stop; exactly one socket; old stop cannot release gen-2's claim);
(2) exception-path leaks (construction/start throw, retry throw, session.stop rejection → claim released; state 'failed' where applicable).
Then ONLY new defects in the touched functions: ELM327 path behavior must be byte-identical (the worker gated the await on adapterType==='enet' — verify no ELM change), any path where `stopping` never resolves (deadlock of a later start), probe token misuse, reservation module invariants. Nothing else.
OUTPUT: first line PASS / FAIL / PASS_WITH_NOTES; 2-row table; NEW findings; Clean list. Stdout only. No agents.
