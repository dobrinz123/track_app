TASK: Close three test-coverage gaps in packages/core telemetry (found by blind verification) with ONE new test file. Tests only — zero src changes.

EXPECTED OUTCOME: packages/core/test/telemetry/simulatedTransport.test.ts covering:
(1) SimulatedElm327Transport determinism: two instances with the same (scenario, seed) produce identical response streams for the same command sequence.
(2) Each fault-injection knob: chunkFragmentation (responses arrive byte-split yet a createElm327Session on top still decodes samples correctly — this doubles as the session-level split-tolerance end-to-end test), noDataOnChannels (channel errors counted, other channels keep flowing), disconnectAfterNCommands (session reaches 'failed', no unhandled rejection), garbagePrefixBytes (samples still decode).
(3) 'UNABLE TO CONNECT' during init leads to state 'failed' (drive via a minimal scripted transport local to the test if the simulator cannot script it).

CONTEXT: Repo D:\CODE\APLICTIE_Circuit. Read packages/core/src/telemetry/simulatedTransport.ts, elm327Session.ts, contracts.ts and the existing tests in packages/core/test/telemetry/ for the fake-clock driving pattern — reuse it, do not invent a new harness.

CONSTRAINTS: Deterministic only (no wall-clock waits, no Math.random/Date.now). Follow existing test style.

MUST DO: Run cd packages/core && npx vitest run test/telemetry > /tmp/wptcov.log 2>&1; ec=$?; report the REAL exit code and pass/fail counts.

MUST NOT: No subagents. Touch NOTHING except the single new file packages/core/test/telemetry/simulatedTransport.test.ts. No src edits — if a knob proves untestable without src changes, report it as a concern instead of changing src.

WRITE SET: packages/core/test/telemetry/simulatedTransport.test.ts (one new file).

OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then: what each test pins, exit code and counts, concerns.
