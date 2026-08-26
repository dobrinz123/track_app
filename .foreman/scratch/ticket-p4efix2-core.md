# Ticket P4e-FIX2-core — H2 residual (correlation completeness), core only
Per the "poll plan, probe & robustness amendment" (contracts.md, end) and `.foreman/scratch/p4erev2-codex-output.log`
Part A H2 PARTIAL: (1) with a request pending, a correct-address diagnostic payload that fails `parseUdsResponse`
(e.g. `[]`, `[7F 01]`) must NOT clear/reject the pending request — count `malformedResponses` (new EnetDiagnostics
field, additive) and keep waiting (timeout or the real response resolves it); (2) a diagnostic response arriving
while `pending === null` increments `unmatchedResponses`. Also add a rate table export `ENET_DEFAULT_CHANNEL_RATES_HZ`
(rpm/speedKph/throttlePct 5, coolantC 0.2, engineOilC/transOilC 0.5, intakeC/engineLoadPct 1, fallback 1) so the
mobile layer can build the poll plan from specs. Tests first (fail on HEAD 053c274): the two review scenarios + rates
table shape. Gates (real exit codes): typecheck 0, core tests 0, lint 0. WRITE SET: packages/core/src/telemetry/enet/**,
packages/core/test/telemetry/enet/**. API additive only. No commit, no agents, never touch apps/mobile (another worker).
OUTPUT: DONE/DONE_WITH_CONCERNS/BLOCKED + evidence.
