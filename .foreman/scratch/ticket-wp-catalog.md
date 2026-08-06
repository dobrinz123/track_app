TASK: Implement a typed multi-circuit catalog in packages/core so the app can list and load any number of circuit profiles (today: one — Transilvania Motor Ring), with tests.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` pass from repo root with new tests green. Paste decisive output.

CONTEXT: Read first: docs/architecture/contracts.md (CircuitProfile), packages/core/src/profile/ (loadProfileFromJson, validateProfile, RuntimeProfile), packages/core/assets/circuits/ (transilvania-motor-ring.v1.json), apps/mobile/src/session/tmrProfile.ts (current single-circuit static import — do NOT modify it; a concurrent worker owns apps/).

CONSTRAINTS: code under packages/core/src/catalog/ with its own index.ts + export wired into packages/core/src/index.ts (you may edit ONLY to add the catalog re-export line). Tests in packages/core/test/catalog/. No new deps. TypeScript strict. No RN/Expo imports.

MUST DO:
1. Types: `CircuitSummary` { circuitId, displayName, country, locality, lengthM, layoutId, layoutVersion, geometryStatus, sectorStatus } — derivable from a validated CircuitProfile.
2. `createCircuitCatalog(entries: Array<{ raw: unknown }>): CircuitCatalog` — validates every entry through the existing loadProfileFromJson/validateProfile path at construction (invalid entries are rejected with collected errors, never silently dropped); exposes: `list(): CircuitSummary[]` (sorted by displayName), `get(circuitId): { profile, runtime } | null`, `summaries` keyed lookup. Multiple layouts of the same circuit = separate entries keyed (circuitId, layoutId) — design the key accordingly and document it.
3. `summarize(profile: CircuitProfile): CircuitSummary` exported standalone.
4. Tests: catalog with the real TMR asset (read via fs in tests) + a makeTestProfile synthetic entry → list returns 2 sorted summaries; get returns validated runtime; an intentionally corrupted entry → constructor error listing the failing circuitId; duplicate (circuitId, layoutId) → explicit error.
5. Keep it dependency-inversion friendly: the catalog takes raw JSON objects; it does NOT know about Metro/static imports (the app supplies its statically imported assets).

MUST NOT: touch apps/**, other core modules (beyond the single index.ts re-export line), or docs; no subagents; no git commit.

OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, commands + pasted results, integration notes (exact API surface).

WRITE SET: packages/core/src/catalog/**, packages/core/test/catalog/**, packages/core/src/index.ts (one re-export line only).
