# Adding a circuit

How a future circuit profile should be onboarded, following the same pattern Transilvania Motor
Ring was built with. This is a process document, not a how-to-write-code tutorial — it describes
the requirements a new `CircuitProfile` must satisfy and the rules that keep provenance honest.
Reference implementation: `packages/core/scripts/generate-tmr-profile.ts` and
`docs/decisions/ADR-0002-circuit-geometry-source.md`.

## Profile schema requirements

Every field in `CircuitProfile` (`packages/core/src/contracts.ts`) is schema-validated by
`circuitProfileSchema` (`packages/core/src/profile/schema.ts`, Zod, `.strict()` at every object
level — unknown extra fields are rejected, not silently ignored) and then structurally validated
by `validateProfile()` (`packages/core/src/profile/validation.ts`). A profile must pass **both**
before it is usable; `validateProfile` is what the app's loader
(`packages/core/src/profile/loader.ts`) and every fixture/test call, and it's what a new circuit
must be run through before it's trusted.

Required shape, at a glance:

- **Identity**: `schemaVersion` (must equal `CURRENT_SCHEMA_VERSION`, currently `1`; see
  `docs/persistence-model.md`'s and `profile/migration.ts`'s schema-version handling for how an
  older profile is migrated forward), `circuitId` (stable slug), `displayName`, `country`,
  `locality`, `layoutId`, `layoutVersion` (integer — see "layoutVersion discipline" below).
- **Provenance**: `source: {name, url?, license?, retrievedAt?}`, `geometryStatus`
  (`'official' | 'community-derived' | 'dev-only'`), `sectorStatus`
  (`'official' | 'app-defined'`) — see "Provenance rules" below.
- **Geometry**: `direction` (`'clockwise' | 'counterclockwise'`), `centerline: LatLon[]` (closed
  loop implied — do not duplicate the first point as the last), `totalLengthM` (must match the
  computed cumulative length within 0.5%), `startFinishGate`/`sectorGates: Gate[]` (each a directed
  `a -> b` segment — see `docs/algorithms/timing-and-crossings.md` for the forward-crossing
  convention), optional `pitLane: {polyline, entryGate, exitGate}`.
- **Bounds**: `boundingRegion: {center, radiusM}`, `corridorWidthM` (used by profile validation's
  own bound/gate-distance checks — see the wiring caveat in `docs/known-limitations.md` about it
  *not* automatically flowing into the live matcher/calibration corridor width).
- **Timestamps and notes**: `createdAtUtc`, `updatedAtUtc`, optional `confidenceNotes` (free text —
  use it for exactly the kind of honest caveat TMR's profile carries, see below).

## Provenance rules — never fabricate

This is the binding rule from ADR-0002, restated as a checklist for any new circuit:

1. **Never hand-edit or invent coordinates.** Geometry must come from a real, checkable source
   (survey data, an authoritative circuit homologation file, or a community source like
   OpenStreetmap) and be transformed into the profile **deterministically by a checked-in generator
   script** — never typed in by hand, never adjusted "by eye" to look right.
2. **`geometryStatus` and `sectorStatus` must be honest, not aspirational.** `'official'` requires
   an actual authoritative source (an organizer/FIM/FIA homologation document) — do not mark a
   community-derived source `'official'` because it happens to be accurate. TMR's profile uses
   `geometryStatus: 'community-derived'` and `sectorStatus: 'app-defined'` precisely because that's
   what it is: real OSM geometry, but gates the app invented deterministically, not sourced from
   any official document.
3. **License/attribution is mandatory whenever the source requires it.** `source.license` and
   `source.name` must be filled in accurately (TMR: `"© OpenStreetMap contributors"` /
   `"ODbL 1.0"`), and the same attribution must be surfaced in-app (TMR's copy lives in
   `SettingsScreen.tsx`'s About card and the README's License/attribution section) — attribution in
   the data file alone is not sufficient.
4. **Say what you don't know, in `confidenceNotes`.** TMR's profile states plainly that gates
   "have not been validated on-site" and flags an unverified track-width figure as `[PLAUSIBLE]`.
   A new circuit's `confidenceNotes` should carry the same kind of explicit uncertainty rather than
   silence.
5. **If a better source later becomes available, bump `layoutVersion` rather than mutating history**
   — see below.

## The generator-script pattern

`packages/core/scripts/generate-tmr-profile.ts` is the reference implementation: a standalone,
directly-runnable TypeScript script (`node --experimental-strip-types
packages/core/scripts/generate-tmr-profile.ts`, wired as `npm run generate:tmr` at the repo root)
that:

1. Reads raw source data from a checked-in, unmodified archive (`data/osm/overpass-tmr-geom.json`,
   `data/osm/overpass-tmr-tags.json` for TMR) — never mutates the archive, never fetches live at
   runtime.
2. Validates structural assumptions about the source **before** trusting it — e.g. TMR's generator
   throws if `oneway=yes` isn't present on both ways, if node/geometry array lengths mismatch, or if
   the centerline isn't explicitly closed by a duplicated final node.
3. Derives every profile field programmatically: local ENU projection centered on the data's own
   centroid, cumulative distances, start/finish placement (a documented deterministic rule — TMR's
   is "centerline point nearest the pit lane midpoint's abeam position"), sector splits (TMR: 1/3
   and 2/3 of cumulative distance), pit entry/exit gates (perpendicular gates at the pit polyline's
   first/last points), and a computed `boundingRegion` that provably contains every centerline/pit
   point plus a safety margin.
4. **Cross-checks a known-good external fact before writing output.** TMR's generator throws if the
   computed centerline length isn't within 1% of the independently-researched 3,708 m figure
   (`docs/research/transilvania-motor-ring.md`) — a real sanity gate, not a formality.
5. Writes a versioned, deterministic output file (`packages/core/assets/circuits/<circuitId>.v<layoutVersion>.json`)
   that the app imports **statically** (a compile-time `import`/`require`, never a runtime fetch —
   see `apps/mobile/src/session/tmrProfile.ts` and the static-bundle proof in
   `docs/architecture/current-state.md`).

A new circuit's generator should follow the same shape: raw-source-in, structural
assertions-before-trust, deterministic derivation with every placement rule documented in code
comments (not tribal knowledge), a cross-check against at least one independently-verifiable fact,
and a versioned static output file.

## Validation gates a new profile must pass

Beyond the Zod schema, `validateProfile()` (`packages/core/src/profile/validation.ts`) runs
structural checks that reject an invalid profile outright — a new circuit's generated profile must
clear every one of these (error codes as emitted):

| Check | Error code |
|---|---|
| At least 50 centerline vertices | `CENTERLINE_TOO_FEW_VERTICES` |
| No consecutive centerline vertices closer than 0.5 m | `CENTERLINE_CONSECUTIVE_DUPLICATE` |
| The closed loop's first/last points are within 5% of computed length of each other | `CENTERLINE_NOT_PLAUSIBLY_CLOSED` |
| `totalLengthM` matches the computed cumulative length within 0.5% | `TOTAL_LENGTH_MISMATCH` |
| `corridorWidthM` is between 5 and 60 m | `CORRIDOR_WIDTH_OUT_OF_RANGE` |
| Every centerline point is within `boundingRegion.radiusM` of its center | `BOUNDING_REGION_EXCLUDES_CENTERLINE` |
| Every gate endpoint lies within `corridorWidthM * 3` of the centerline | `GATE_ENDPOINT_TOO_FAR_FROM_CENTERLINE` |
| Every gate is between 2 and 100 m long | `GATE_TOO_SHORT` / `GATE_TOO_LONG` |
| Sector gates are strictly ordered by along-track distance | `SECTOR_GATES_NOT_STRICTLY_ORDERED` |
| No sector gate within 30 m of start/finish or another sector gate | `SECTOR_GATE_TOO_CLOSE_TO_START_FINISH` / `SECTOR_GATES_TOO_CLOSE` |
| (if `pitLane` present) at least 2 pit-polyline vertices, non-degenerate length | `PIT_POLYLINE_TOO_FEW_VERTICES` / `PIT_POLYLINE_DEGENERATE` |
| (if `pitLane` present) pit entry/exit gate endpoints lie near both the centerline and the pit polyline | `PIT_GATE_ENDPOINT_TOO_FAR_FROM_REQUIRED_LINE` |

All errors are collected and de-duplicated, not fail-fast on the first one — a rejected profile
comes back with the full list of what's wrong so a generator author can fix everything in one pass.
The generator script's own pre-flight assertions (source-data shape, the length cross-check) are a
separate, earlier layer — a profile can be well-formed enough to pass `validateProfile` while still
having failed one of the generator's own sanity checks if those were bypassed; both layers matter.

## `layoutVersion` discipline

`layoutVersion` exists specifically so a corrected or improved circuit definition never silently
overwrites history: `docs/architecture/contracts.md` and `docs/persistence-model.md`'s
`reference_laps` table both key on `(circuitId, layoutId, layoutVersion)` — a personal-best lap
recorded against `layoutVersion: 1` is never compared against, or accidentally replaced by, a lap
recorded against `layoutVersion: 2`'s different geometry (`shouldReplacePb`'s first rule in
`docs/algorithms/live-delta.md` explicitly refuses to compare across a `layoutVersion` mismatch).
Bump `layoutVersion` whenever gate placement, sector boundaries, or the centerline itself changes
meaningfully — never mutate an already-shipped `layoutVersion`'s geometry in place. ADR-0002 §5
states this plainly: "a future authoritative source... can replace [current gate placements] under
a new `layoutVersion` without algorithm changes."

## Real-world validation checklist reuse

`docs/verification/real-track-validation-checklist.md` is written to be circuit-agnostic in
structure even though its current instance is filled in for Transilvania Motor Ring — every
checklist item (GNSS update frequency, accuracy distribution, recognition-lap acceptance,
start/finish detection across ≥10 laps, sector consistency, stop-on-line debounce, PB replacement,
offline operation, etc.) exercises app behavior, not TMR-specific geometry. Onboarding a new
circuit should produce a **new copy of this checklist** (same items, new circuit name/location
header) and run it physically on-site before treating that circuit's profile as validated — the
same way TMR's own checklist exists as the reference pass for TMR's profile (ADR-0003
"Consequences": "Physical validation on an iPhone is the reference validation pass").
