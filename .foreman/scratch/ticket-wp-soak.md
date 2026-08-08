TASK: Endurance/adversarial soak testing of the production pipeline on the real TMR v2 profile — the "will it survive a real track day" suite. Find bugs BEFORE the user's first circuit visit; if you find real defects, FIX them (behavior-preserving for existing tests) and prove the fix.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` green from repo root with the new soak suite included (keep total runtime of the new suite < 60 s — use coarse sample rates where possible). Paste decisive output + a findings section (defects found: NONE or list with fixes).

CONTEXT: Read first: packages/core/src/{controller,replay,fixtures,timing,matching,calibration,reference,persistence-sql}/, test/replay/replay-harness.integration.test.ts, test/controller/, test/persistence-sql/sqlJsDatabase.ts, assets/circuits/transilvania-motor-ring.v2.json.

CONSTRAINTS: tests in packages/core/test/soak/. Fixes (if any) in the owning module with a clear comment. Deterministic (seeded PRNG only). No new deps. TypeScript strict.

MUST DO — scenarios (each a test with concrete assertions):
1. Track-day session: 90 minutes simulated at 1 Hz (~5400 samples) through SessionController with sql.js-backed SqlSessionRepository and fake clock: 20+ laps mixing clean/noisy/pit-transit/slow laps; assert: lap count correct, every valid lap persisted with telemetry, checkpoint present after each lap, PB chain monotone non-increasing, memory-bounded internals (rawSamples ≤ current-lap window, matches capped), no exception anywhere.
2. Multi-session day: 3 sessions sequentially on the SAME sql.js DB (new controller each), asserting PB carries across sessions, history accumulates, reference lap loaded at session start yields deltas in session 2+.
3. Recovery torture: run a session, checkpoint mid-lap N, simulate process death (new controller + restoreFromCheckpoint from DB), resume, complete more laps: lap numbering continuous, RECOVERY lap invalid, PB unaffected by the invalid lap, tMono never mixed (assert no negative/absurd durations anywhere).
4. GNSS chaos lap-storm: 30 laps where every lap gets a random adversity (seeded pick: noise burst, 5-8 s gap, single teleport, brief off-corridor excursion, low-accuracy stretch): assert pipeline never throws, no lap has negative/zero duration, no duplicate lap numbers, every invalid lap carries at least one machine-readable reason, valid-lap sector sums ≈ durations.
5. Watchdog under repeated gaps: gaps > watchdog timeout at random points across 10 laps → restartProvider invocations counted correctly, session continues, no double-arming.
6. Calibration marathon: 10 consecutive calibrate→reject→recalibrate cycles then accept → state machine healthy, no residue (fresh coverage each attempt), accepted calibration works normally after.
7. Delta stability soak: full session vs a reference lap with per-sample delta recorded: assert no NaN/Infinity ever, displayed delta changes bounded (<1500 ms/sample on smooth laps), delta neutral during degraded windows.
8. SQLite growth: after scenario 1, assert DB page/byte size stays under a sane bound (< 15 MB for the 90-min session) and deleteUserData leaves zero rows across all tables.

MUST NOT: weaken existing tests; introduce wall-clock/nondeterminism; exceed ~60 s suite runtime (tune sample counts if needed, document); no subagents; no git commit.

OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then FINDINGS (defects + fixes, or explicit NONE), files changed, per-scenario results, commands + pasted output, suite runtime.

WRITE SET: packages/core/test/soak/**, plus minimal fixes in packages/core/src/** ONLY for real defects found (each justified in the report).
