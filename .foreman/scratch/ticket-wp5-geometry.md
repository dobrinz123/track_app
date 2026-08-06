TASK: Implement the geometry core for a GNSS lap-timing app in packages/core of the npm-workspaces repo at the current directory. This is pure TypeScript domain code with exhaustive unit + property-based tests.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` all pass from repo root, with new Vitest suites covering every function below, including fast-check property tests. Paste the decisive tail of each command's output.

CONTEXT: Read first: docs/architecture/contracts.md (binding contracts — types already exist in packages/core/src/contracts.ts), docs/decisions/ADR-0001-stack.md. The centerline is a closed loop of WGS84 vertices; circuits are ≤ ~10 km across, so a local tangent-plane approximation is acceptable and required for speed.

CONSTRAINTS:
- All code under packages/core/src/geometry/ plus a packages/core/src/geometry/index.ts re-exporting the public API. Do NOT edit packages/core/src/index.ts or contracts.ts (the foreman wires root exports).
- No new npm dependencies. No react/react-native/expo imports. TypeScript strict.
- Numerical robustness: no NaN/Infinity escapes; degenerate inputs (zero-length segments, duplicate vertices) must be handled or rejected explicitly.

MUST DO — implement and test:
1. `createProjection(origin: LatLon): GeoProjection` — equirectangular local ENU (meters) around origin with cos(lat0) scaling; round-trip error < 1e-6 deg for points within 20 km. Property test: round-trip.
2. `polylineCumulative(points: LocalPoint[]): number[]` and `polylineLength(closedLoop)` — cumulative distances; closed-loop total includes the wrap segment.
3. `projectOntoPolyline(p: LocalPoint, line: LocalPoint[], cumulative: number[], closed: boolean, hint?: {distanceM: number; windowM: number})` → { distanceM, lateralM (signed, left-of-travel positive), segmentIndex, point }. With a hint, search only segments within the window around hint (wrapping across start/finish for closed loops); without hint, full search. Property test vs brute-force full search: with a valid hint containing the true nearest segment, results are identical.
4. `unwrapProgress(prevUnwrappedM: number, newDistanceM: number, totalLengthM: number): number` — chooses the wrap that minimizes |delta|; forward crossings of start/finish increase the unwrapped value past k*totalLength. Property: output is within totalLength/2 of prevUnwrapped + shortest signed delta; monotone under small forward steps.
5. `segmentIntersection(p1, p2, q1, q2)` → null | { t: number (param along p1->p2 in [0,1]), u: number, point } — robust orientation-based; collinear/parallel → null (documented).
6. `crossingDirection(gateA, gateB, motionFrom, motionTo)` → 'forward' | 'reverse' via sign of cross(gateVec, motionVec); define forward as motion crossing from the gate's right half-plane to left (document the convention in code and make it match contracts.md).
7. `interpolateCrossingTime(tPrev, tCurr, t)` — linear; property: result strictly within [tPrev, tCurr] for t in (0,1).
8. Micro-benchmark guard (plain vitest test, generous threshold): hinted projection on a 500-vertex loop must run 10,000 calls in < 2 s.

MUST NOT: modify any file outside the WRITE SET; add dependencies; weaken existing tests/config; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then: files changed, assumptions, commands run + pasted results, known limitations, integration notes (exact public API surface for the foreman to re-export).

WRITE SET: packages/core/src/geometry/** (new files only), packages/core/test/geometry/** or colocated *.test.ts under src/geometry.
