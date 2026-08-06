TASK: Implement the versioned circuit-profile schema, validation, migration framework, and profile loader in packages/core, with tests.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` pass from repo root; new Vitest suites cover acceptance and every rejection rule below. Paste decisive command output.

CONTEXT: Read first: docs/architecture/contracts.md (CircuitProfile, Gate — binding, already in packages/core/src/contracts.ts); packages/core/src/geometry/ (existing — use createProjection, polylineCumulative/length, projectOntoPolyline for validation; do not reimplement).

CONSTRAINTS:
- All code under packages/core/src/profile/ with its own index.ts. Do NOT edit contracts.ts, geometry/**, timing/**, statemachine/**, or packages/core/src/index.ts.
- zod (already a dependency) for structural validation. TypeScript strict. No new dependencies.

MUST DO:
1. `circuitProfileSchema` (zod) mirroring CircuitProfile exactly, CURRENT_SCHEMA_VERSION = 1.
2. Semantic validation `validateProfile(raw: unknown): { ok: true; profile: CircuitProfile; runtime: RuntimeProfile } | { ok: false; errors: string[] }` where RuntimeProfile adds computed local-plane data: projection (origin = boundingRegion.center), centerline in LocalPoint[], cumulative distances, projected gates. Semantic rules (each with a rejection test):
   - centerline ≥ 50 vertices, no consecutive duplicates (< 0.5 m apart), forms a plausible closed loop (gap between last and first vertex < 5% of total length);
   - totalLengthM within ±0.5% of computed closed-loop length;
   - every gate's endpoints within 3 × corridorWidthM of the centerline;
   - gate segments non-degenerate (length ≥ 2 m, ≤ 100 m);
   - sector gates strictly ordered by projected distanceM along the centerline, none within 30 m of another or of start/finish;
   - corridorWidthM in [5, 60]; boundingRegion contains all centerline points;
   - if pitLane present: entry/exit gates near (≤ 3 × corridor) both pit polyline AND centerline; pit polyline ≥ 2 vertices, non-degenerate.
3. Migration framework: `migrateProfile(raw: unknown): unknown` — map of version→migration fn; version 0→1 example migration included (e.g. rename of a field you define for the test); unknown versions → explicit error 'UNSUPPORTED_SCHEMA_VERSION'.
4. `loadProfileFromJson(json: string)` — safe parse (never throws; size guard: reject > 5 MB input with 'PROFILE_TOO_LARGE'), runs migrations then validation. This is the ONLY entry point the app will use, including for user-imported GeoJSON-derived profiles converted upstream.
5. Test fixtures: build a synthetic ~2 km rounded-rectangle test circuit ("dev-test-ring", geometryStatus 'dev-only', sectorStatus 'app-defined', 3 sectors) via a helper `makeTestProfile(options)` exported for other test suites to reuse. Clearly NOT a real circuit: circuitId 'dev-test-ring', displayName 'Dev Test Ring (synthetic)'. Do NOT create any profile named or located as Transilvania Motor Ring in this ticket (real-circuit profile authoring is a separate, provenance-controlled task).
6. Round-trip property test: serialize → loadProfileFromJson → deep-equal profile (timing-critical numeric fields preserved exactly).

MUST NOT: fabricate real-world circuit data; modify files outside WRITE SET; add dependencies; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, assumptions, commands + pasted results, limitations, integration notes (public API surface incl. RuntimeProfile shape).

WRITE SET: packages/core/src/profile/** (new files), colocated *.test.ts allowed.
