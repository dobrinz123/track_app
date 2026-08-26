# Review ticket CN-REV3 — Codex read-only RE-VERIFY of the CN-FIX2 fix wave (mobile)

You are the same adversarial READ-ONLY reviewer role as CN-REV2 (your prior report:
`.foreman/scratch/cnrev2-codex-output.log`, verdict FAIL with H1–H3, M1–M4, L1–L3). The fix wave
landed in commit `5d7bcb2` (diff: `git diff 529078f..5d7bcb2 -- apps/mobile docs/architecture/contracts.md`).
The binding spec is the "recovery amendment" at the end of `docs/architecture/contracts.md`.
Sandbox note: if process spawning is denied, use your read-only Node/Git access as you did before
and say so.

## TASK
For EACH prior finding H1, H2, H3, M1, M2, M3, M4, L1, L2, L3: verdict `FIXED` / `PARTIAL` /
`NOT FIXED`, with file:line evidence and, for anything not FIXED, the concrete failing scenario.
Then hunt for NEW defects introduced by the fixes — especially:
- `selectionChain` + `rebuildInFlight` + `withDevReplayLock` interplay: any deadlock or ordering
  hole (e.g. `selectCircuit` awaiting `rebuildInFlight` while a rebuild awaits the selection chain;
  DevReplay `runScenario` calling `selectCircuit` after `restoreProductionFacade`).
- `setActiveSession()` transaction vs the SQL write gate (`sqlWriteGate.ts`, `gateSqlTransactions`)
  — nested transaction / self-deadlock risk like the historical N1 finding; ordering vs
  `startTelemetryRecording(sessionId)`.
- Recovery order persisted-circuit → scan → selection: unbundled id path clears BOTH keys; web
  preview (`db === null`) path; `resumeRecovery()` reassert semantics.
- `selectCircuit` refusal path leaves settings/history untouched and the UI never navigates.
- Delete-all aggregation: verify-empty still enforced per circuit; `errorText` cannot leak
  anything sensitive; telemetry step still runs when a circuit rejects.
- Any TMR-default behavior change (bootstrap ordering, gate behavior, history) vs `529078f`.
- Tests: are the new tests (composition.circuitSelection.test.ts, circuit.test.ts) meaningful —
  would they fail on the original bugs?

## OUTPUT FORMAT
First line: `PASS` / `FAIL` / `PASS_WITH_NOTES`. Then the per-finding table, then NEW findings by
severity with file:line + scenario + evidence, then a Clean list. Stdout only. No agents.
