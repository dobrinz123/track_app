TASK: Implement the production SQLite persistence adapter: an SQL-backed LocalSessionRepository in packages/core (testable in Node via sql.js) plus the thin expo-sqlite binding in apps/mobile, with the SAME semantic guarantees as the in-memory reference implementation — proven by a shared contract test suite run against both.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` pass from repo root; the shared contract suite runs green against BOTH InMemorySessionRepository and SqlSessionRepository(sql.js). Paste decisive output.

CONTEXT: Read first: docs/architecture/contracts.md (LocalSessionRepository — binding); packages/core/src/persistence/ (existing in-memory reference — its semantics are the spec: deep-copy reads, atomic PB replace, structural ReferenceLap validation, last-write-wins telemetry, checkpoint codec); packages/core/test/persistence/ (existing tests); .foreman/scratch/platform-research.md §expo-sqlite (SQLiteProvider/openDatabaseAsync API, WAL).

CONSTRAINTS: New code in packages/core/src/persistence-sql/ and apps/mobile/src/persistence/. You MAY refactor packages/core/test/persistence/** to extract a reusable `runRepositoryContractTests(name, makeRepo: () => Promise<LocalSessionRepository>)` suite — semantics must not weaken (every existing assertion preserved or strengthened). You MAY add `sql.js` (+ @types if needed) as devDependency of packages/core ONLY (wasm, no native build). Do NOT touch matching/, calibration/, geometry/, timing/, statemachine/, profile/, contracts.ts, root index.ts (concurrent worker in matching/calibration). TypeScript strict.

MUST DO:
1. `SqlDatabase` minimal async interface in persistence-sql/: execAsync(sql), runAsync(sql, params) → {changes}, getAllAsync<T>(sql, params) → T[], withTransactionAsync(fn) — shaped to be trivially satisfied by expo-sqlite's async API (verify names against platform-research.md; document any adaptation).
2. `SqlSessionRepository implements LocalSessionRepository` over SqlDatabase:
   - DDL + migration table (user_version or schema_migrations), WAL pragma attempted (ignore failure — sql.js lacks it).
   - Tables: sessions, laps (JSON payload per lap OK), telemetry (BLOB/TEXT JSON per (sessionId, lapNumber), replace-on-rewrite), checkpoints (latest per sessionId), reference_laps (keyed userId+circuitId+layoutId+layoutVersion).
   - putReferenceLap: structural validation identical to in-memory (reuse the same validateReferenceLap function — import it), then transactional DELETE+INSERT (atomic replace).
   - getReferenceLap/loadCheckpoint/loadTelemetry: deep-copy semantics come free from JSON parse — ensure no shared references.
   - deleteUserData: transactional; deletes sessions/laps/telemetry/checkpoints via sessions-join AND reference_laps by userId; additionally deletes orphan checkpoints/telemetry whose sessionId begins with `${userId}--` (document: app generates sessionIds as `${userId}--<random>`; this covers active sessions not yet saved — cite the WP11a concern).
   - JSON serialization guards reused from persistence/ (assertJsonSerializable) before writes.
3. Contract test extraction: existing in-memory tests refactored into `runRepositoryContractTests` + in-memory-specific extras; new test file persistence-sql.contract.test.ts running the suite against SqlSessionRepository backed by a sql.js-based SqlDatabase test adapter you write in test utilities. Add SQL-specific tests: migration idempotence (open twice), transactional atomicity of putReferenceLap (inject a failure mid-transaction via a validation error → previous PB intact).
4. apps/mobile/src/persistence/expoSqlDatabase.ts: adapter from expo-sqlite (openDatabaseAsync) to SqlDatabase + `createSqliteSessionRepository(dbName)` factory. Typecheck/lint/export only (no device).
5. Tests live under packages/core/test/persistence-sql/ (root vitest discovers test/**/*.test.ts only).

MUST NOT: weaken existing tests; touch concurrent workers' modules; add deps beyond sql.js (+types) in packages/core devDeps; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, assumptions, commands + pasted results, limitations, integration notes.

WRITE SET: packages/core/src/persistence-sql/**, packages/core/test/persistence/** (refactor only), packages/core/test/persistence-sql/**, packages/core/package.json (sql.js devDep), package-lock.json, apps/mobile/src/persistence/**.
