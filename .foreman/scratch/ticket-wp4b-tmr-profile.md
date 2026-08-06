TASK: Implement the deterministic Transilvania Motor Ring profile generator: a checked-in Node script that converts the archived OSM extracts into a validated CircuitProfile JSON asset, plus tests.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` pass; running `npm run generate:tmr` (add this root script) regenerates `packages/core/assets/circuits/transilvania-motor-ring.v1.json` byte-identically (deterministic); a Vitest suite loads the generated asset through loadProfileFromJson and asserts it validates with zero errors.

CONTEXT: Read first: docs/decisions/ADR-0002-circuit-geometry-source.md (binding placement rules), docs/architecture/contracts.md, packages/core/src/profile/ (validateProfile, loadProfileFromJson — existing), packages/core/src/geometry/ (existing). Input data: data/osm/overpass-tmr-geom.json (way 488429454 = closed centerline 150 nodes; way 488429716 = pit lane 15 nodes), data/osm/overpass-tmr-tags.json.

CONSTRAINTS: Generator in packages/core/scripts/generate-tmr-profile.ts (run via tsx or vitest-independent node --loader; pick what works with existing tooling without new heavy deps — a tiny devDependency like tsx at root IS allowed here if needed, document it). Output asset committed to packages/core/assets/circuits/. No hand-edited coordinates anywhere. TypeScript strict.

MUST DO — generator rules (all deterministic, all from ADR-0002):
1. Centerline: way 488429454's nodes in way order, dropping the duplicated closing node; direction of travel = node order (oneway=yes). Compute the profile `direction` (clockwise/counterclockwise) from the signed area in local ENU and record it.
2. totalLengthM = computed closed-loop length (do NOT hard-code 3708; assert computed value is within 1% of 3708 and fail generation otherwise, citing the research doc).
3. Start/finish gate: find the pit-lane polyline midpoint; project it onto the centerline; the S/F gate is the perpendicular gate at that centerline point, width = 2 × corridorWidthM. corridorWidthM = 15 (track width 11–14 m [PLAUSIBLE] + GNSS margin; document).
4. Distance datum: rotate the centerline array so index 0 is the S/F point (interpolate a vertex there if needed); all distances measured from S/F in travel direction.
5. Sector gates: perpendicular gates at 1/3 and 2/3 of totalLengthM (sectorIndex 1 and 2 starts; sector 0 starts at S/F). kind 'sector'.
6. Pit lane: polyline from way 488429716 in node order; pitEntry gate perpendicular at its first node projected to centerline vicinity, pitExit at its last node likewise (kind 'pitEntry'/'pitExit'). Determine from geometry which end is entry vs exit using travel direction (the end whose centerline projection has GREATER distance from S/F going backward... derive it properly: entry = the pit end whose adjacent centerline distance comes FIRST along travel direction when approaching the pit; document the rule in code).
7. Profile fields: schemaVersion 1, circuitId 'transilvania-motor-ring', layoutId 'main', layoutVersion 1, geometryStatus 'community-derived', sectorStatus 'app-defined', source = { name: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/way/488429454', license: 'ODbL 1.0', retrievedAt: '2026-08-06' }, boundingRegion = centroid + max distance + 500 m margin, confidenceNotes stating gates are app-defined and unvalidated on-site, createdAtUtc/updatedAtUtc = '2026-08-06T00:00:00Z' fixed (determinism — never new Date()).
8. Tests: generated asset passes loadProfileFromJson with ok:true; totalLength within 1% of 3708; sector gates ordered; direction matches signed-area computation; S/F gate within 60 m of the pit-lane midpoint's abeam point; regeneration determinism (run generator function twice → deep equal).

MUST NOT: fabricate/hand-tune coordinates; modify profile/geometry/timing/matching modules; edit contracts.ts or root index.ts; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, assumptions, commands + pasted results, limitations, integration notes.

WRITE SET: packages/core/scripts/**, packages/core/assets/**, root package.json (generate:tmr script + tsx devDep only), colocated test file under packages/core/src/profile/ named tmr-profile.asset.test.ts.
