# ADR-0002 — Transilvania Motor Ring geometry: OSM community-derived; gates app-defined

Date: 2026-08-06 · Status: Accepted · Decider: Fable 5 (lead architect)

## Context

Circuit research (docs/research/transilvania-motor-ring.md) verified the circuit's existence, location (46.43528°N 24.42694°E), and length (3.708 km) but found **no public authoritative centerline, pit geometry, start/finish line, or sector definitions**. Fabricating geometry is forbidden. A direct Overpass API query (2026-08-06, data timestamp 2026-08-06T12:20:21Z) found:

- **way 488429454** — `highway=raceway`, `name=Transilvania Motor Ring`, `oneway=yes`, `sport=motor`: **150 nodes, closed loop, computed length ≈ 3706 m** — agrees with the independently verified 3.708 km to within 0.05%.
- **way 488429716** — `highway=raceway`, `name=Pit Lane`, `oneway=yes`: 15 nodes, ≈ 720 m, open polyline.

Raw extracts archived at `data/osm/overpass-tmr-geom.json` and `data/osm/overpass-tmr-tags.json`.

## Decision

1. The production TMR circuit profile is built **deterministically from OSM way 488429454** (centerline) and way 488429716 (pit lane) by a checked-in generator script — never hand-edited coordinates. `geometryStatus: 'community-derived'`.
2. **License/attribution:** OpenStreetMap data is © OpenStreetMap contributors, ODbL 1.0. Attribution ships in the profile's `source` field and in the app's circuit-details and About surfaces.
3. **Direction of travel** is derived from the way's node order (`oneway=yes` asserts it), cross-checked against research direction claims; recorded in the profile.
4. **Start/finish and sector gates are APP-DEFINED** (`sectorStatus: 'app-defined'`), never presented as official:
   - Start/finish gate: placed on the main straight adjacent to the pit lane (deterministic rule: centerline point nearest the pit-lane midpoint's abeam position, documented in the generator).
   - Sector gates: 3 app sectors with boundaries at 1/3 and 2/3 of cumulative centerline distance from start/finish (deterministic, versioned via `layoutVersion`).
   - Pit entry/exit gates: perpendicular gates at the pit-lane polyline's first/last points.
5. The length discrepancy tolerance and all gate placements live in the generator script so a future authoritative source (circuit homologation file) can replace them under a new `layoutVersion` without algorithm changes.

## Consequences

- The profile is honest about provenance: advisory-recreational quality, physical on-track validation required (validation checklist doc).
- Turn-count conflict (17 vs 10) is irrelevant to timing; not modeled in MVP.
- If OSM geometry proves inaccurate on-site, the import tool accepts a corrected GeoJSON under a bumped layoutVersion.
