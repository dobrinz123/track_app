# Review ticket P4e-REV3 — Codex read-only RE-VERIFY of P4e fix wave 2 (bounded)

Same reviewer role as P4e-REV2 (prior: `.foreman/scratch/p4erev2-codex-output.log`). Diff: `git diff 053c274..2e73057`.
Binding: "poll plan, probe & robustness amendment" at the end of `docs/architecture/contracts.md`. Read-only
Node/Git path if spawning is denied — say so.

## TASK (bounded)
Per prior item — Part A H2 residual (malformed correct-address response; idle-slot late response), Part B H1
(structural JSON validation never throws), H2 (probe gating + one-client rule + simulate), M1 (spec-derived poll
plan, transOilC ungated on ENET), M2 (one-shot transport), M3 (probe correlation), L1 (hydration repair),
L2 (360pt), L3 (tests) — verdict FIXED / PARTIAL / NOT FIXED with file:line and a failing scenario if not.
Then ONLY new defects introduced by this diff (regressions in touched functions, test weakening, ELM path
behavior change). Nothing else.

## OUTPUT FORMAT
First line `PASS` / `FAIL` / `PASS_WITH_NOTES`; per-item table; NEW findings with file:line + scenario; Clean list.
Stdout only. No agents.
