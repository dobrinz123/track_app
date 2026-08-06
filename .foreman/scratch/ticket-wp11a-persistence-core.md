TASK: Implement the in-memory reference implementation of LocalSessionRepository in packages/core, plus a session checkpoint/recovery helper, with tests. This is the test double the whole test suite will rely on AND the semantic reference for the later SQLite adapter.

EXPECTED OUTCOME: `npm run typecheck`, `npx vitest run test/persistence` (and full `npm test` not regressing YOUR files), `npm run lint` pass. Paste decisive output. NOTE: unrelated geometry test files may be concurrently under construction by another worker — do not touch them, and report their status separately if they fail.

CONTEXT: Read first: docs/architecture/contracts.md (binding: LocalSessionRepository, SessionSummary, ReferenceLap, SessionMachineSnapshot, LapRecord — in packages/core/src/contracts.ts).

CONSTRAINTS: code under packages/core/src/persistence/ with its own index.ts; tests under packages/core/test/persistence/. Do NOT edit contracts.ts, root index.ts, or any other module (geometry/, statemachine/, timing/, profile/, matching/, calibration/, reference/ — some are being written concurrently by other workers). No new dependencies. TypeScript strict. Async contract respected (Promise-based) even though storage is a Map.

MUST DO:
1. `InMemorySessionRepository implements LocalSessionRepository` — full contract. Semantics (each tested):
   - putReferenceLap: atomic full replace keyed by (userId, circuitId, layoutId, layoutVersion); a failed/partial write is impossible by construction, but validate the ReferenceLap structurally before storing (distanceGridM/elapsedMsAtGrid same length ≥ 2, elapsed non-decreasing, durationMs > 0) and reject invalid input with a thrown Error — never store a corrupt reference.
   - getReferenceLap returns a DEEP COPY (mutation of the returned object must not affect the store — tested).
   - saveCheckpoint/loadCheckpoint: latest checkpoint per sessionId; JSON-serializable enforcement (structuredClone or JSON round-trip; reject functions/undefined-holes).
   - saveTelemetry/loadTelemetry: appends per (sessionId, lapNumber) are NOT allowed — one write per lap key, second write replaces (documented; matches "atomic" semantics upstream).
   - listSessions filtered by userId + circuitId, sorted by startedAtUtc descending.
   - deleteUserData removes that user's sessions, telemetry, checkpoints, and reference laps only (other users untouched — tested with two users).
2. `CheckpointCodec`: serialize/deserialize {snapshot, laps} with a schemaVersion field and a corruption guard (deserialize returns null on malformed JSON or wrong version — never throws) — tests for happy path, truncated JSON, wrong version.
3. Property test (fast-check): for random sequences of putReferenceLap with varying keys, getReferenceLap always returns the last stored value for that exact key and never a value from a different key.

MUST NOT: modify files outside WRITE SET; add dependencies; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, assumptions, commands + pasted results, limitations, integration notes.

WRITE SET: packages/core/src/persistence/**, packages/core/test/persistence/**.
