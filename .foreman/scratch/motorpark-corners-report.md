# MotorPark România — analyzeCorners report (for LEAD verification)

Generated from `packages/core/assets/circuits/motorpark-romania.v1.json` via
`analyzeCorners` (CORNER_ANALYSIS_VERSION = 3, unchanged, default config).

- **Total corners found: 10** (plausibility band [10, 18] per ticket CN-W1 — published
  sources say 14 curves / 16 turns; regression test only pins the count into this
  band, NOT the exact sequence, pending LEAD's comparison against the published
  track map).
- **totalLengthM: 4056.261** (computed) vs 4052 m (racingcircuits.info, 0.10% delta)
  vs 4129 m (motorparkromania.ro, 1.76% delta).
- S/F gate midpoint: **lat 44.77972, lon 26.47208** (the OSM main-loop seam vertex).

## Bounding box (from generated centerline)

**minLat 44.7740446, maxLat 44.7843811, minLon 26.4676747, maxLon 26.4790120**

## ASCII sketch hint

North (higher lat) is up; East (higher lon) is right. S/F marked `X` near the bottom-right
of the box (it sits on the main straight, SE-to-NW leg, close to the loop's east/south edge).

```
   lon 26.4677                                        26.4790
lat
44.7844  N ┌──────────────────────────────────────────┐
           │            (loop interior, west knot      │
           │             around 26.468–26.472,          │
           │             clockwise travel)              │
           │                                            │
44.7797    │                                    X (S/F) │  <- seam vertex, main straight
           │                                            │
44.7740  S └──────────────────────────────────────────┘
           W                                          E
```

The loop is roughly a tall, narrow "hairpin-and-loop" shape: a long north–south
run on the west side (~26.468–26.472° lon) connected by a wide east-side extension
(the spliced way 949617051) that swings out to ~26.479° lon before rejoining near
the S/F seam. Corner entry-distance percentages below can be walked against a
published track-map image to confirm sequence/direction.

## Corner table

| idx | dir   | entry (m) | entry (% lap) | arc (deg) | minRadiusM | severity | advisory (kph) |
|-----|-------|-----------|----------------|-----------|------------|----------|-----------------|
| 1   | right |    406.3  |  10.0%         |   112.9   |    54.2    |    5     |   85            |
| 2   | right |   1130.9  |  27.9%         |   139.0   |    32.4    |    5     |   65            |
| 3   | left  |   1554.5  |  38.3%         |    68.1   |    64.9    |    4     |  115            |
| 4   | left  |   1772.2  |  43.7%         |    45.9   |    66.3    |    4     |  120            |
| 5   | right |   1917.4  |  47.3%         |    60.1   |    62.8    |    4     |  115            |
| 6   | right |   2243.7  |  55.3%         |   102.3   |    45.9    |    5     |   80            |
| 7   | left  |   2449.2  |  60.4%         |   135.6   |    30.2    |    5     |   65            |
| 8   | right |   2996.6  |  73.9%         |   198.1   |    49.0    |    5     |   80            |
| 9   | right |   3440.2  |  84.8%         |    19.2   |    95.6    |    4     |  155            |
| 10  | left  |   3619.6  |  89.2%         |    25.3   |    67.5    |    4     |  130            |

Full precision values (JSON) are in the generated asset / can be reproduced by
running `npm run generate:motorpark` then loading the asset through
`analyzeCorners` — nothing here is hand-edited from the tool's actual output.

## Notes for LEAD

- Corner 8 (arc ≈198°) is the widest sweep in the set — worth checking against the
  published map's "hairpin after the straight" description (§8 of the research doc)
  to see whether it should visually correspond to that named feature.
- Corners 9–10 (short, mild) sit just before the S/F straight (84.8%–89.2% of lap),
  consistent with a technical run-in to the main straight.
- This is a PLAUSIBILITY check only (count in [10,18]); exact corner
  identity/sequence pinning is deliberately deferred to LEAD's comparison against
  a published track-map image, per ticket CN-W1.

## LEAD verdict (ticket CN-W1 follow-up)

LEAD verified the 10-corner analysis above is CONSISTENT with the published clockwise
track map (LapMeta CW, 16 numbered turns). Mapping:

| analyzeCorners idx | dir   | published turn(s) |
|---------------------|-------|--------------------|
| C1                  | right | T1                 |
| C2                  | right | T4                 |
| C3                  | left  | T5                 |
| C4                  | left  | T6                 |
| C5                  | right | T7                 |
| C6                  | right | T9                 |
| C7                  | left  | T10                |
| C8                  | right | T13+T14 (same-direction compound) |
| C9                  | right | T15                |
| C10                 | left  | T16                |

T2/T3/T8/T11/T12 are gentle kinks (radius > 125 m) that fall below the
corner-detection curvature threshold by design and correctly have no
corresponding `analyzeCorners` entry.

C8 (T13+T14, arc ≈198°) is a legitimate same-direction compound (both bends
turn the same way, right, with no real gap between them) — this is NOT the
opposite-sign direction-split merge bug that CORNER_ANALYSIS_VERSION 3's
M-direction-split fix guards against (that fix only splits a run when
curvature crosses zero and stays opposite-signed for a sustained span; T13+T14
never changes sign, so it correctly stays one corner).

The regression suite now pins this exact sequence (count === 10, directions in
order, entry distances monotonically increasing, C8 arc > 150°) instead of the
prior [10, 18] plausibility band.
