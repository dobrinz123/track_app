# Review ticket CN-REV4 — Codex read-only RE-VERIFY of CN-FIX3 (lifecycle lock), mobile

Same adversarial READ-ONLY reviewer role as CN-REV2/REV3 (prior report: `.foreman/scratch/cnrev3-codex-output.log`).
The fix landed in commit `1e0f8c9` (diff: `git diff 5d7bcb2..1e0f8c9 -- apps/mobile docs/architecture/contracts.md`).
Binding spec: the "lifecycle lock amendment" at the end of `docs/architecture/contracts.md`.
If process spawning is denied in your sandbox, use the read-only Node/Git path as before and say so.

## TASK
1. For each prior item — H3, M3/N4, M4/N1, L2/N6, N2, N3, N5, N7 — verdict FIXED / PARTIAL / NOT FIXED
   with file:line evidence and a concrete failing scenario for anything not FIXED. Note the worker's
   declared deviation for N3: instead of "refuse a selection queued behind the preflight gate", it
   enforces "an idle production controller is always built for the resolved selection, rebuilt in the
   same critical section as the settings/history write" + a selectable-state allow-list. Judge whether
   that invariant actually closes N3 (session starts on the geometry of the persisted selection).
2. Hunt NEW defects in `apps/mobile/src/session/lifecycleLock.ts` and its use in `composition.ts`:
   - deadlock: any path where a lock holder awaits something that itself needs the lock (facade
     callbacks, settings subscribers, `onSessionEnded`, DevReplay restore, `ready()` inside a section,
     recovery banner UI calls); re-entrancy assert is synchronous-only — find a post-await re-entry.
   - starvation/ordering: FIFO guarantee under thrown errors; lock released on every error path.
   - the preflight-gate `forward` inside the lock: does the facade still emit state to the UI in the
     right order; can a gate exception wedge the facade?
   - `runDevReplayScenario` cancellation: side effects after `isCancelled()` turns true (navigation,
     replay install, selection write).
   - recovery: `PendingRecovery.circuitId` for an unbundled id; `resumeRecovery` with `db === null`;
     keys reasserted with the recovery circuit; discard path clears both keys.
   - delete-all: aggregate semantics, telemetry step always runs, no exception text leaks.
   - TMR default path unchanged vs `529078f` for a user who never selects.
   - Tests: are the new `lifecycleLock.test.ts` / `composition.lifecycleLock.test.ts` substantive?

## OUTPUT FORMAT
First line `PASS` / `FAIL` / `PASS_WITH_NOTES`; per-item table; NEW findings by severity with
file:line + scenario + evidence; Clean list. Stdout only. No agents.
