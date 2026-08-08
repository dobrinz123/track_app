TASK: Close the app-side automated-testing gap: add a vitest setup to apps/mobile for its PURE-TS modules (no React/RN rendering) and write tests for the untested session-layer logic, so app wiring bugs surface before a track day.

EXPECTED OUTCOME: `npm test` from repo root now ALSO runs an apps/mobile suite (workspaces script picks it up) with all tests green; existing core suite untouched and green; `npm run typecheck`/`lint`/`export:ios` green. Paste decisive output.

CONTEXT: Read first: apps/mobile/src/session/{realFacade.ts,composition.ts,circuitCatalog.ts,sqlSessionHistoryStore.ts,tmrProfile.ts,liveTimestampedProvider.ts,facade.ts}, apps/mobile/src/persistence/{expoSqlDatabase.ts,sqlSettingsStore.ts}, packages/core test patterns (test/controller/testSupport.ts has fake clock/provider; test/persistence-sql/sqlJsDatabase.ts has the sql.js adapter). The core package's vitest config is the model.

CONSTRAINTS: NO React component rendering tests (no RN test renderer — out of scope); test ONLY pure-TS modules. Mock expo-* imports minimally via vitest alias/mock where a module under test imports them (e.g. expo-sqlite in expoSqlDatabase — do NOT test that file's expo binding itself; test SqlSettingsStore/history store against the sql.js SqlDatabase adapter from core's tests instead). devDeps allowed in apps/mobile: vitest, @vitest/coverage-v8 optional, sql.js reuse via workspace root. TypeScript strict.

MUST DO — test at minimum:
1. RealSessionFacade: full session lifecycle against a real SessionController with in-memory repository + fake clock/provider (reuse core testSupport via a small local copy or relative import if package exports don't expose it — if you need core to export testSupport, add a `@circuit/core/testing` subpath export carefully without touching production exports): subscribe emits correct FacadeState transitions for calibration→accept→arm→3 laps; speedKph populated; lastLapMs/pbMs update; endSession persists summary; commands before start are safe no-ops (no throw).
2. sqlSessionHistoryStore against SqlSessionRepository(sql.js): refresh lists sessions newest-first; lap detail retrieval; empty-state behavior.
3. SqlSettingsStore (sql.js): set/get round-trip, defaults, persistence across store re-instantiation on same DB.
4. circuitCatalog: list/get contract on the real v2 TMR asset (validated load, summary fields).
5. LiveTimestampedLocationProvider: re-stamps tMono monotonically at delivery pace (fake timers), preserves order, stop() ceases emission.
6. tmrProfile module: loads + validates v2 asset, exports non-null runtime (import works under vitest — configure vitest to handle the .json import consistent with Metro semantics).
7. composition.ts recovery decision logic: if directly testable without expo-sqlite, test the pure parts (e.g. midSessionState/lap-count math); document what remains untestable and why.

MUST NOT: touch packages/core production code (a `/testing` subpath export of EXISTING test-support code is the single allowed exception, additive only); no React rendering; no expo runtime in tests; don't weaken/skip existing tests; no subagents; no git commit.

OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, per-area test counts, commands + pasted results, what remains untestable and why.

WRITE SET: apps/mobile/vitest.config.ts, apps/mobile/test/**, apps/mobile/package.json (test script + devDeps), package-lock.json, packages/core/package.json (only if adding the /testing subpath export), packages/core/src/testing/** (only re-exporting existing test-support, if needed).
