# Transilvania Motor Ring geometry verification

- Projection: local ENU metres, origin at boundingRegion.center (46.43182485800851, 24.423704564497545); north up, east right.
- Centerline bounding box: **703.5 × 1538.4 m** (east–west × north–south).
- Total closed-loop length: **3706.488 m** (asset totalLengthM: 3706.488 m; difference 0.000 m).
- Travel bearing at the centerline segment nearest the S/F gate midpoint: **214.1° (SW)**.
- Perpendicular distance from S/F gate midpoint to nearest pit-lane point: **15.3 m**.
- S/F → sector gate 1 along travel: **1235.5 m** (**0.3333 lap; 33.33%**).
- S/F → sector gate 2 along travel: **2471.0 m** (**0.6667 lap; 66.67%**).
- Signed centerline area: **-165216.5 m²**; negative in east/north Cartesian coordinates means **clockwise**. Computed direction: **clockwise**; declared direction: **clockwise** — **MATCH**.
- Pit-lane length: **720.1 m**.
- Pit-lane side: **right of travel** (median signed lateral offset of internal pit vertices: -15.1 m; positive = left, negative = right).
- Raw OSM input read: **2 element(s)** from data/osm/overpass-tmr-geom.json.

## Sanity assertions

- **PASS** — closed loop (implicit last-to-first closure is 179.4 m)
- **PASS** — S/F gate within 3×corridorWidth of centerline (0.00 m ≤ 45.0 m)
- **PASS** — sector gate 1 at 1/3±2% of lap (33.33%)
- **PASS** — sector gate 2 at 2/3±2% of lap (66.67%)
- **PASS** — declared direction matches signed-area computation (declared clockwise; computed clockwise)

## Measurement notes

All distances are computed after projecting the asset coordinates with the same spherical equirectangular formula and IUGG mean Earth radius used by `createProjection`. The centerline is implicitly cyclic, so length, progress, arrows, area, and SVG rendering include the last-to-first segment. Gate progress is the closest centerline projection of each gate midpoint.
