TASK: Produce a visual + numeric verification packet for the Transilvania Motor Ring circuit profile so the foreman can compare it against an external reference map (racingcircuits.info layout with turns T1–T10, start/finish on the main bottom straight, clockwise travel).

EXPECTED OUTCOME: (1) an SVG rendering at .foreman/scratch/tmr-geometry-check.svg; (2) a numeric report at .foreman/scratch/tmr-geometry-check.md. No repository source files modified.

CONTEXT: Read: packages/core/assets/circuits/transilvania-motor-ring.v1.json (the shipped profile: centerline LatLon[], startFinishGate, sectorGates, pitLane with entry/exit gates, direction), data/osm/overpass-tmr-geom.json (raw OSM source), packages/core/src/geometry/ (createProjection etc. — you may import from the package in a scratch script run with `node --experimental-strip-types`).

MUST DO:
1. Write a standalone script .foreman/scratch/render-tmr-check.ts (run it; paste how you ran it) that:
   - Loads the asset, projects centerline + pit lane + all gates to local ENU meters (projection origin = boundingRegion.center).
   - Emits an SVG (north up, x=east): centerline as a closed path; pit lane dashed; start/finish gate drawn as a bold segment labeled S/F; sector gates labeled S1→S2 and S2→S3 boundaries; pit entry/exit labeled; THREE direction arrows placed along the centerline at 10%, 40%, 70% of lap distance showing travel direction (derived from vertex order); a 500 m scale bar; aspect ratio true to meters.
2. Numeric report with: bounding-box width×height (m); total length; bearing of travel (degrees, cardinal) on the segment containing the S/F gate; perpendicular distance from S/F gate midpoint to the nearest pit-lane point; distance along track from S/F to sector gate 1 and gate 2 (and fractions of total length); direction (clockwise/ccw) recomputed from signed area — state whether it matches the asset's declared `direction`; pit-lane length; which side of the centerline the pit lane sits (left/right of travel direction).
3. Sanity assertions in the script (print PASS/FAIL each): closed loop; S/F gate within 3×corridorWidth of centerline; sector gates at 1/3±2% and 2/3±2% of length; declared direction matches signed-area computation.

MUST NOT: modify anything outside .foreman/scratch/**; no subagents; no git commit.

OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then the numeric report inline (verbatim), the PASS/FAIL assertion list, and both artifact paths.

WRITE SET: .foreman/scratch/render-tmr-check.ts, .foreman/scratch/tmr-geometry-check.svg, .foreman/scratch/tmr-geometry-check.md
