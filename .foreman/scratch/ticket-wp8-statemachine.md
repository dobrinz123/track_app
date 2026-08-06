TASK: Implement the session state machine for a GNSS lap-timing app in packages/core as a pure, deterministic reducer, with exhaustive unit tests.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` pass from repo root; new Vitest suite covers every legal and illegal transition listed below. Paste decisive command output.

CONTEXT: Read first: docs/architecture/contracts.md — SessionState, SessionEvent, SessionMachineSnapshot, SessionReducer are already defined in packages/core/src/contracts.ts and are binding.

CONSTRAINTS:
- All code under packages/core/src/statemachine/ with its own index.ts. Do NOT edit packages/core/src/index.ts, contracts.ts, or any geometry/ files.
- Pure function only: no Date.now, no timers, no randomness, no I/O. Time arrives inside events.
- TypeScript strict; no new dependencies.

MUST DO — semantics:
- States: idle, preflight, awaitingCalibration, calibrating, calibrationReview, armed, outLap, timing, inPit, paused, sessionComplete, error.
- Happy path: idle → preflight (START_PREFLIGHT) → awaitingCalibration (PREFLIGHT_PASSED) → calibrating (CALIBRATION_STARTED) → calibrationReview (CALIBRATION_FINISHED) → armed (CALIBRATION_ACCEPTED) → … → timing → sessionComplete (END_SESSION).
- Arming/lap-start semantics: from `armed`, a forward startFinish CROSSING transitions to `timing` with lapNumber=1; any other (non-startFinish) forward crossing while `armed` transitions to `outLap`; from `outLap`, a forward startFinish CROSSING transitions to `timing` with lapNumber=1. While `timing`, each subsequent forward startFinish crossing increments lapNumber.
- calibrationReview --CALIBRATION_REJECTED--> awaitingCalibration (retry allowed).
- PREFLIGHT_FAILED → stays preflight with failure reasons in context (retry allowed via START_PREFLIGHT).
- PIT_ENTERED from timing/outLap → inPit; PIT_EXITED → outLap (current lap becomes invalid — record 'PIT_TRANSIT' in context.pendingInvalidReasons).
- PAUSE from any active state (calibrating, armed, outLap, timing, inPit) → paused, remembering the prior state in context; RESUME{gapMs} → returns to the remembered state; if gapMs > 30000 while timing, the in-progress lap gains pendingInvalidReasons 'PAUSE_GAP'.
- GNSS_LOST while timing → stay timing but context.gnssDegraded=true; GNSS_RECOVERED clears it. (Lap invalidation on quality is the timing engine's job; the machine only tracks the flag.)
- FATAL from anywhere → error. END_SESSION from any non-idle state → sessionComplete.
- Illegal events for a state are ignored (return the same snapshot, identical reference) — never throw. This must be tested.
- Reverse-direction startFinish crossings never start/complete laps.
- context is a plain serializable object (checkpoint-friendly); include lapNumber, priorState (for pause), pendingInvalidReasons: string[], gnssDegraded: boolean, calibrationConfidence?: number.

MUST DO — tests: table-driven full transition matrix (every state × representative event set), pause/resume round-trip preserving lapNumber, pit-transit invalidation flag, ignored-illegal-event identity, determinism (same inputs → deep-equal outputs), serializability (JSON round-trip of snapshot preserves behavior).

MUST NOT: modify files outside WRITE SET; add dependencies; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, assumptions, commands + pasted results, limitations, integration notes.

WRITE SET: packages/core/src/statemachine/** (new files), colocated *.test.ts allowed.
