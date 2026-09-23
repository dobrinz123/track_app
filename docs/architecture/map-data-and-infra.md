# Map: data, assets and infrastructure

> Updated to HEAD `4e88d13` on 2026-09-23 (originally written at `ec153ef`, 2026-09-22).

Everything in this repo that is **not** application logic: the circuit assets and the generators
that produce them, the archived field and OSM data, CI, the firmware and board, the shipped `.ipa`
files, and the two parked backlogs. Written so a fresh session can rebuild, regenerate or ship
without archaeology.

Scope note: this document deliberately does **not** describe the timing/geometry/analysis code.
For that, see `docs/architecture/contracts.md`, `docs/architecture/current-state.md` and
`docs/architecture/analysis-engine.md`.

Everything below was verified against the working tree at the time of writing. Where something
looks stale or wrong it is recorded in [§8 Questions and suspicions](#8-questions-and-suspicions),
not fixed.

---

## 0. Repository shape at a glance

```
package.json                  npm workspaces root: packages/*, apps/*  (name: circuit-timer)
tsconfig.base.json            strict TS options every workspace inherits
tsconfig.json                 root: extends expo/tsconfig.base, empty compilerOptions
eslint.config.mjs             flat config, one file for the whole repo
.github/workflows/            build-unsigned-ios.yml, security-and-ci.yml
.gitleaksignore               1 allowlisted false-positive fingerprint
.pre-commit-config.yaml       opt-in local gitleaks hook (mirrors CI)
.claude/                      launch.json (web-preview target), settings.local.json (tracked; §8 S14)
packages/core/                @circuit/core — pure TS domain package
  assets/circuits/            the generated circuit profile JSON assets
  scripts/                    the two generator scripts
apps/mobile/                  mobile — Expo SDK 57 app
data/                         archived inputs + field evidence (read-only)
  osm/                        Overpass extracts (generator INPUTS)
  field/signal-finder/        guided-observation captures (evidence)
  field/sweeps/               DID sweep captures (evidence)
  vehicle-profiles/           draft vehicle profile (reference document)
firmware/                     ESP32-C3 OBD dongle firmware (PlatformIO)
hardware/                     DESIGN.md, schematic/, kicad/, enclosure/
builds/                       GITIGNORED — shipped .ipa files + test protocols
docs/                         see §7 for the index of what already exists
.foreman/ledger.md            append-only campaign history; the source of truth for
                              "what happened and why" on every build
```

**Workspaces.** Two only: `packages/core` (`@circuit/core`, `private`, `type: module`, entry
`src/index.ts` — consumed as TypeScript source, never built) and `apps/mobile` (`mobile`). A
single `package-lock.json` at the root. `npm install` is run from the root only; the README says
explicitly not to install inside individual packages.

**TypeScript.** `tsconfig.base.json` holds the strict flags (`strict`, `noUncheckedIndexedAccess`,
`isolatedModules`, `moduleResolution: Bundler`, ES2020/ESNext). Each workspace has its own
`tsconfig.json` and its own `typecheck` script; the root `npm run typecheck` fans out via
`--workspaces --if-present`. Note the version skew: core pins `typescript ^5.6.3`, mobile pins
`typescript ~6.0.3`.

**ESLint.** One flat config at the root. The load-bearing rule is the third block:

```js
files: ['packages/core/**/*.ts'],
rules: { 'no-restricted-imports': [... group: ['react', 'react-dom', 'react-native', 'expo', 'expo-*'] ] }
```

This is what mechanically keeps `@circuit/core` a pure domain package — the constraint the whole
architecture rests on, enforced by lint rather than by discipline. Ignores cover `node_modules`,
`dist`, `dist-export`, `.expo`, and the generated native projects `apps/mobile/{ios,android}`.

**Root scripts.** `typecheck`, `test`, `lint`, `format`, `generate:tmr`, `generate:motorpark`.
There is no root `build` — the app is bundled by Expo/Metro, the core is consumed as source.

---

## 1. The circuit assets

`packages/core/assets/circuits/` — four files, all generated or hand-curated data, none of them
hand-drawn geometry:

| File | Points | Bytes | What it is |
|---|---|---|---|
| `transilvania-motor-ring.v1.json` | 150 centerline | 12,698 | TMR, layoutVersion 1 (superseded, kept byte-stable) |
| `transilvania-motor-ring.v2.json` | 150 centerline | 13,246 | TMR, layoutVersion 2 — **what the app ships** |
| `motorpark-romania.v1.json` | 230 centerline | 22,442 | MotorPark România, layoutVersion 1 — **what the app ships** |
| `transilvania-motor-ring.observed-speeds.v1.json` | — | — | Optional overlay: user/community apex speeds keyed by cornerId |

Both profiles are statically imported into the Hermes bundle — a compile-time `import`, never a
runtime fetch:

- `apps/mobile/src/session/tmrProfile.ts` → `@circuit/core/assets/circuits/transilvania-motor-ring.v2.json`
  (plus the observed-speeds overlay)
- `apps/mobile/src/session/circuitCatalog.ts` → `@circuit/core/assets/circuits/motorpark-romania.v1.json`

Both go through the same `loadProfileFromJson` validation path. MotorPark ships **no** observed-speeds
overlay, so its corner set is purely model-derived.

### 1.1 Transilvania Motor Ring

- **Source data:** OpenStreetMap way `488429454` (circuit, 150 nodes, closed) and way `488429716`
  (pit lane), retrieved 2026-08-06, archived at `data/osm/overpass-tmr-geom.json` and
  `data/osm/overpass-tmr-tags.json`.
- **Generator:** `packages/core/scripts/generate-tmr-profile.ts` (`npm run generate:tmr`).
- **Cross-check:** the generator throws if the computed centerline length isn't within 1% of the
  independently researched 3,708 m (`docs/research/transilvania-motor-ring.md`). Computed:
  3,706.49 m.
- **`confidenceNotes` (v2) claims:** gates are app-defined from OSM geometry and *have not been
  validated on-site*; `corridorWidthM=15` combines a researched 11–14 m `[PLAUSIBLE]` track width
  with GNSS margin; and it states the v2 sector rule verbatim (nearest qualifying "straight vertex"
  within ±180 m of the 1/3 and 2/3 target distances, straightness = mean absolute turning angle over
  a ±40 m window < 0.008 rad/m, with a documented fallback that was not needed).

### 1.2 MotorPark România (Adâncata, Ialomița)

- **Source data:** OSM way `333031201` (main loop, 83 raw nodes incl. the closing duplicate,
  3,326.1 m closed) spliced with way `949617051` (26-node full-layout extension) between node-index
  74 (node `3401455119`) and node-index 79 (node `8791129031`). The short-configuration chord way
  `333031200` (120 m) is **deliberately excluded** and never read by the script. Pit lane: way
  `953930215` then way `953930214`, sharing node `8829181316`; way 214's node[0]
  (`8829250717`) is a short-config connector and is excluded. Retrieved 2026-08-26; archived at
  `data/osm/overpass-motorpark-geom.json` / `-tags.json`.
- **Generator:** `packages/core/scripts/generate-motorpark-profile.ts` (`npm run generate:motorpark`).
- **Cross-check:** computed closed length 4,058.13 m vs published 4,052 m (racingcircuits.info,
  0.15% delta) and 4,129 m (motorparkromania.ro, 1.72% delta). Both published figures are recorded
  in `confidenceNotes`; the generator asserts against the 4,052 m figure at 1% tolerance.
- **`confidenceNotes` claims** (the longest and most important text in the repo — read it in full
  before trusting anything about this circuit):
  - ODbL attribution is **mandatory wherever this circuit is shown**.
  - Traced from OSM aerial mapping, **not validated on-site**. Nothing in the asset is "official".
  - **"CENTERLINE IS RESAMPLED, AND MOST OF ITS POINTS ARE INTERPOLATED — NOT SURVEYED."** The 102
    mapped OSM vertices are all still present, unmoved and in order; **128 further points were
    computed between them and carry no independent evidence.** See §2.3.
  - Method, numbers and guard rails for the resampling: 59 of 102 source segments bent, largest
    lateral shift anywhere 3.57 m, longest spacing now 22 m.
  - **"NONE OF THIS VALIDATES THE GEOMETRY."**
  - Sector gates are placed against the **pre-densification** mapped vertices, so resampling cannot
    move a gate.
  - `corridorWidthM=16` from a published 11–16 m `[PLAUSIBLE]` width plus GNSS margin.
  - A correction is recorded in the notes themselves: an earlier "~41 m pit-lane gap" claim was
    wrong (it compared endpoint coordinates instead of node ids) and was fixed after review.

### 1.3 `geometryStatus` and `sectorStatus` — the honesty gate

These are **not metadata**. They are the safety gate that stops the app coaching a driver on a track
it has never validated.

Defined in `packages/core/src/contracts.ts:57-58`, Zod-enforced in
`packages/core/src/profile/schema.ts:46-47`:

```ts
geometryStatus: 'official' | 'community-derived' | 'dev-only' | 'ad-hoc';
sectorStatus:   'official' | 'app-defined';
```

| Value | Meaning | What it permits downstream |
|---|---|---|
| `geometryStatus: 'official'` | Geometry from an authoritative source (organizer / homologation document). | **The only value that sets `geometryValidated: true`** in `apps/mobile/src/session/analysisAssembly.ts:552`, and the only one that maps to provenance `'surveyed'` (`geometryProvenanceOf()`, `packages/core/src/coaching/sessionInsights.ts:102`). Since P17 this gates only **live cue moves** (voice cues at speed); everything else runs on any stated provenance. |
| `'community-derived'` | Real third-party geometry (OSM), transformed deterministically, unvalidated on site. **Both shipped circuits.** | Provenance `'mapped'`: timing, analysis **and, since P17, pit suggestions** run, with corners labelled as "our numbering" and positions as "on the line we traced"; live cue moves stay off. `sessionReport.ts:456` injects a caveat into every exported report: *"The circuit geometry is … not an officially surveyed layout. Lap boundaries and sector splits were computed against it and inherit its uncertainty."* |
| `'dev-only'` | Synthetic test fixture (`packages/core/src/profile/test-fixture.ts`). | Test/replay use only. |
| `'ad-hoc'` | Geometry **learned from one lap of driving** (the Test Loop / learned-circuits feature). | `packages/core/src/testloop/testLoopCircuit.ts` writes this as a **constant, never taken from a caller** — a learned circuit can never present itself as surveyed. Provenance `'learned'` (pit suggestions allowed, live cue moves off). `isLearnedGeometry()` is the single predicate every honesty check reads; the UI adds a distinct badge and note (`analysisViewModel.ts:1101-1102`) and the selection list labels learned circuits differently from bundled ones. |
| `sectorStatus: 'official'` | Sector splits from the sanctioning body. | Nothing in the repo currently sets this. |
| `'app-defined'` | Gates the app invented deterministically. **Both shipped circuits.** | Reported as such in the session report (`- Circuit geometry: <status> (sectors <sectorStatus>)`) and in the circuit-detail UI. Never labelled "Official". |

The binding rule (ADR-0002, restated as a checklist in `docs/adding-a-circuit.md`): *`'official'`
requires an actual authoritative source — do not mark a community-derived source `'official'`
because it happens to be accurate.* Until P17 (commit `5561364`, 2026-09-23, shipped in build 14)
the consequence was that **on both real circuits the honesty gate kept coaching suggestions off**.
P17 replaced the binary gate with three tiers (`surveyed` / `mapped` / `learned`), on the argument,
pinned by `packages/core/test/coaching/geometryTiers.test.ts`, that the analysis is
self-referential: every lap is measured through the same windows, so a displaced centerline moves
every lap equally and the comparison is unaffected. Pit suggestions now run on any **stated**
provenance (an unstated one still refuses); live cue moves stay on `'official'`. `'official'` is
still never set by anything in the repo, and the rule above is unchanged. The reasoning is in the
P17 commit message and in `docs/architecture/public-release-plan.md` §3.

The same file (`circuitCatalog.ts:78-85`) records the invariant that keeps it honest at runtime:
the only way `geometryStatus` changes is a **new, re-reviewed catalog asset at build time** — it is
never mutated by the app.

### 1.4 ODbL attribution — the obligation and where it is discharged

OSM data is © OpenStreetMap contributors under the **Open Database License (ODbL) 1.0**.
Attribution is mandatory and — per `docs/adding-a-circuit.md` rule 3 — *attribution in the data file
alone is not sufficient*; it must be surfaced in-app.

Discharged in four places:

1. **In the asset**, `source: { name: "© OpenStreetMap contributors", license: "ODbL 1.0", url, retrievedAt }`,
   plus the leading sentence of MotorPark's `confidenceNotes`.
2. **In the app's About card** — `apps/mobile/src/ui/screens/SettingsScreen.tsx:1084`:
   *"Circuit geometry data © OpenStreetMap contributors, available under the Open Database License
   (ODbL)…"*
3. **In the circuit-detail screen** — `apps/mobile/src/ui/screens/CircuitDetailScreen.tsx:376`
   (ODbL attribution + advisory disclaimer, condensed), built from
   `apps/mobile/src/ui/data/circuit.ts:5` (`OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)'`)
   which composes a per-circuit provenance line including way ids and retrieval date.
4. **In the README**, License/attribution section.

Guarded by `apps/mobile/test/ui/data/circuit.test.ts:62`, and by `expo export` forensics — every
`.ipa` forensic pass in the ledger greps the Hermes bundle for `ODbL=1`.

The ledger records that a UI-cleanup request to delete the legal text was **refused as
licence-required** and the text relocated instead (About / CircuitDetail). Do not delete it.

---

## 2. The generators

Two scripts, one per circuit, both run through Node's type stripping:

```
npm run generate:tmr        # node --experimental-strip-types packages/core/scripts/generate-tmr-profile.ts
npm run generate:motorpark  # node --experimental-strip-types packages/core/scripts/generate-motorpark-profile.ts
```

### 2.1 What they read and write

| | `generate-tmr-profile.ts` | `generate-motorpark-profile.ts` |
|---|---|---|
| Reads | `data/osm/overpass-tmr-geom.json`, `data/osm/overpass-tmr-tags.json` | `data/osm/overpass-motorpark-geom.json`, `data/osm/overpass-motorpark-tags.json` |
| Also imports | `../src/geometry/curvature.ts` | `../src/geometry/curvature.ts`, `../src/geometry/densify.ts` |
| Writes | `packages/core/assets/circuits/transilvania-motor-ring.v<N>.json` | `packages/core/assets/circuits/motorpark-romania.v1.json` |
| CLI args | `--layout-version=1|2` (or `--layout-version 1`); **defaults to 2** | none |
| Size | 24,431 bytes | 39,167 bytes |

Neither fetches anything at runtime. Neither mutates its input archive. The MotorPark script
deliberately **duplicates** the small geometry-helper set from the TMR script rather than importing
it — the stated reason, in a comment at the top of the file, is that the TMR script must stay
byte-for-byte untouched so `transilvania-motor-ring.v*.json` cannot drift as a side effect of
MotorPark work. Treat that duplication as intentional, not as cleanup waiting to happen.

`npm run generate:tmr` with no arguments regenerates **v2**. To reproduce v1 without touching v2:
`npm run generate:tmr -- --layout-version=1`.

### 2.2 What is deterministic about them

Both scripts assert their inputs before trusting them, then derive everything programmatically
(local ENU projection on the data's own centroid, cumulative distances, perpendicular gates,
computed bounding region). Output is `JSON.stringify(profile, null, 2) + '\n'` from an exported
`serialize*Profile()` — so the bytes are pinned, not just the values.

The pins are real tests, not documentation:

- `packages/core/test/profile/tmr-profile.asset.test.ts:119` — *"is deterministic across
  independent v2 generation calls and matches checked-in bytes"*, `expect(serializeTmrProfile(first)).toBe(v2AssetJson)`;
  line 126 does the same for v1 under the unchanged v1 rule.
- `packages/core/test/profile/motorpark-profile.asset.test.ts:66` — same pin for MotorPark, and the
  test file re-reads the raw Overpass archive **itself**, not via the generator's helpers, so the
  check on the asset is independent of the generator's own parsing.

MotorPark's generator additionally carries hard shape guards that make it fail loudly rather than
silently ship changed geometry: `EXPECTED_MAIN_LOOP_NODE_COUNT = 83`, `EXPECTED_MAIN_LOOP_LENGTH_M
= 3326.1` (±0.5%), the two splice node ids and their expected indices, `EXPECTED_EXTENSION_NODE_COUNT
= 26`, `EXPECTED_SPLICED_POINT_COUNT = 103`, `EXPECTED_DENSIFIED_POINT_COUNT = 230`, and
`DENSIFY_MAX_LATERAL_SHIFT_M = 8` — described in the source as *"Guard, not a tuning knob"*, with
the measured worst case at 3.57 m.

### 2.3 What would change if someone re-ran them today — and the 102 → 230 resampling

**Re-running today changes nothing**, as long as `data/osm/` is untouched: the inputs are archived
snapshots, not live Overpass queries, and the byte-identity tests would catch any drift. The only
way output changes is if someone re-fetches from Overpass (OSM has moved on since 2026-08-06 /
2026-08-26) — at which point the generators' assertions are designed to fail rather than quietly
emit a different track.

**The densification (ticket P7G, shipped in build 12).** MotorPark's centerline went from **102
source points to 230**. This matters and is recorded in three places:

1. **The asset's own `confidenceNotes`** — in capitals: *"CENTERLINE IS RESAMPLED, AND MOST OF ITS
   POINTS ARE INTERPOLATED — NOT SURVEYED. The 102 mapped OSM vertices are all still here, unmoved
   and in order; 128 further points were computed between them and carry no independent evidence."*
2. **`packages/core/src/geometry/densify.ts`** module header — *"WHAT THIS DOES NOT DO. It adds no
   information. Every emitted point that is not an input vertex is INTERPOLATED from the input
   vertices, never surveyed."*
3. **The generator's constants block**, `DENSIFY_MAX_SPACING_M = 22` / `DENSIFY_MAX_LATERAL_SHIFT_M
   = 8` / `EXPECTED_DENSIFIED_POINT_COUNT = 230`, with the full rationale in the comment above them.

**Why it was done:** the raw trace averaged 39.8 m between points, with 8 chords over 100 m and a
longest of 237.1 m. A straight chord across a real curve cuts *inside* the arc, so a car on the real
track reads as laterally displaced and — past `corridorWidthM` — as **off track**, which leaves
calibration coverage bins permanently unreachable. The ledger's build-12 entry records the measured
effect: **missed-crossing 16.00% → 0.00%**.

**How it stays conservative:** a segment is bent only by curvature that *both* of its neighbourhoods
agree on (both three-point circle fits must exist, sit on the same side of the chord, and be tighter
than 2000 m radius); the arc used is the **flatter** of the two. One-sided evidence buys no bend, so
a corner apex mapped as a single sharp vertex followed by a long straight does not bow that straight.
A segment whose flanking segments are much shorter than itself is left alone entirely, because a
three-point fit there is an artefact of the lever arm, not an estimate. Segments left straight are
subdivided along their exact chord, shifting nothing. Sector gates are placed against the
pre-densification vertices, so resampling cannot move a gate.

**The honest bottom line, in the asset's own words:** *"It is the same OSM trace, read less lossily;
it is still unverified on-site and still has no survey behind it, and the true radius of any corner
here remains unknown until someone drives it."*

### 2.4 Adding a third circuit

`docs/adding-a-circuit.md` is the process document (profile schema requirements, the provenance
rules, the generator-script pattern, and the full table of `validateProfile()` error codes a new
asset must clear). `docs/NEXT-CIRCUIT-PLAYBOOK.md` is the lessons-learned companion written after
the TMR campaign — read its §0 before the first change and each later section before touching the
area it covers (scoping added by the 2026-09-23 prompt audit); it encodes what the code cannot tell
you.

---

## 3. Field data (`data/`)

Everything here is **archived and read-only**. Two categories that must not be confused.

### 3.1 Generator inputs

| File | Bytes | Retrieved | Role |
|---|---|---|---|
| `data/osm/overpass-tmr-geom.json` | 11,322 | 2026-08-06T12:20:21Z | **INPUT** to `generate:tmr` |
| `data/osm/overpass-tmr-tags.json` | 727 | 2026-08-06T12:20:21Z | **INPUT** to `generate:tmr` (tag assertions, e.g. `oneway=yes`) |
| `data/osm/overpass-motorpark-geom.json` | 19,953 | 2026-08-26T16:03:21Z | **INPUT** to `generate:motorpark` |
| `data/osm/overpass-motorpark-tags.json` | 932 | 2026-08-26T16:04:22Z | **INPUT** to `generate:motorpark` |

All four are raw Overpass API 0.7.62.11 responses, each carrying its own
`osm3s.copyright` ODbL statement and `timestamp_osm_base`. Do not edit them; regenerating the assets
from a *different* snapshot is a `layoutVersion` bump, not an in-place change (ADR-0002 /
`docs/adding-a-circuit.md` rule 5).

### 3.2 Evidence kept for reference (not read by any build step)

**`data/field/signal-finder/`** — exports from the in-app Signal Finder, the guided
press-the-brake/press-the-pedal observation flow. Each capture is a `schemaVersion: 4`,
`kind: "trace-signal-finder"` JSON (session id, target channel, engine requirement, measured
req/s, the metronome step plan with its prompts, per-DID candidates/edges/baselines, confirmed
bindings, diagnostics), and some have a human-readable `.md` twin produced by the same one-tap
export. Nine JSON captures 2026-08-29 → 2026-08-31 (brake switch, brake pressure, accelerator pedal,
two steering-angle attempts), plus four `2026-08-30-test7-photo-*.jpeg` dashboard photos.

**`data/field/sweeps/`** — five `schemaVersion: 1` DID-sweep exports (run id, adapter type, target
ECU address, hex range, visited/responder/timeout/NRC counters, responders with raw hex,
observation series, suggestions). Ranges swept: DME `0x12` over `0x1000-0x1FFF`, `0x4000-0x4FFF`,
`0x5000-0x5FFF`; ECU `0x29` over `0x4000-0x4FFF` and `0x5000-0x58F2`.

**`data/vehicle-profiles/toyota-supra-b58.draft.json`** — a **draft reference document**, not a
loaded asset. Its own `$comment` says: *"DRAFT vehicle profile — data only, never constants in
generic code… Every channel carries provenance; status 'hypothesis' until field-confirmed."* It
records the ECU map (DME `0x12` field-confirmed; `0x29` "answers", ident `AG2RBFR0200`, publicly
mapped to DSC on BMW F/G chassis) and per-channel DID candidates with status. The **string**
`toyota-supra-b58` is a live profile id in the app (`activeVehicleProfileId`, binding storage,
ruled-out storage) — but the app's bindings live in its own SQLite store, not in this file. Treat
the file as the human-maintained record of what the field tests established.

**What is NOT here.** As the ledger states plainly: *"data/field/ holds only signal-finder and
sweeps — zero session or lap data."* Every field test to date (tests 3–11) was OBD/signal work on
street or driveway. At the time of writing no lap has been timed on a real circuit by this app.
That is the single biggest blank area in this map.

---

## 4. CI and build

Two workflows, deliberately separate.

### 4.1 `.github/workflows/build-unsigned-ios.yml` — "Build unsigned iOS"

- **Triggers:** `workflow_dispatch` with a `variant` choice (`release` / `dev-client` / `both`,
  default `both`), and `push` on tags matching `build-*`. Tag pushes have no `inputs`, so the
  workflow resolves the variant to `both`.
- **Runner:** `macos-latest`, 60-minute timeout, `permissions: contents: read`, concurrency group
  per ref with `cancel-in-progress`. **No secrets are used anywhere** — the `.ipa` is unsigned by
  design (`CODE_SIGNING_ALLOWED=NO`).
- **Steps:** `actions/checkout@v4` → `actions/setup-node@v4` (Node 24, npm cache keyed on the root
  `package-lock.json`) → `npm ci` **from the repo root** (monorepo) → `npx expo prebuild --platform
  ios` in `apps/mobile` → `xcodebuild archive` → zip `Payload/` into an `.ipa` →
  `actions/upload-artifact@v4` (90-day retention).
- **Scheme derivation:** `-workspace TRACE.xcworkspace -scheme TRACE`. The workflow header explains
  the derivation at length: `app.json`'s `expo.name` is sanitized by `@expo/config-plugins`'
  `sanitizedName()`; "TRACE" survives unchanged. **`expo prebuild --platform ios` cannot run on
  Windows** (Expo CLI 57 skips iOS on win32), so this macOS job is the only place the derivation
  gets a live check.
- **Artifacts:** `CircuitTimer-release-unsigned.ipa` and `CircuitTimer-devclient-unsigned.ipa`.
- **Getting an artifact into `builds/ipa/`:** there is **no automation for this step**. The operator
  downloads the artifact from the completed run (GitHub UI or `gh run download`; the exact commands
  used for build 14 are in §7 steps 6–7), unzips it, renames
  it to the project's convention `TRACE-v<N>-<slug>-release-<YYYY-MM-DD>.ipa`, and drops it in
  `builds/ipa/` alongside a hand-written `TEST-<N>-PROTOCOL.md`. The ledger entry for each build
  records the run id, the source commit, the byte size and the md5 — that is the audit trail
  (`builds/` is gitignored, so the ledger is the only in-repo record that a build exists).

### 4.2 `.github/workflows/security-and-ci.yml` — "Security and CI gates"

Added 2026-09-21 (commit `989e4a6`). Before it, **the repo had no CI for typecheck/lint/test at
all**. Triggers on every `push` and `pull_request`. Four jobs:

| Job | Tool | Licence | Status today |
|---|---|---|---|
| `gates` | `npm run typecheck` / `npm run lint` / `npm test` | — | **green** |
| `gitleaks` | `gitleaks/gitleaks` v8.30.1 CLI | MIT | **green** |
| `osv-scan` | `google/osv-scanner-action` reusable workflow v2.6.0 | Apache-2.0 | **fails — expected, see §6.2** |
| `license-policy` | `npx @onebeyond/license-checker scan --allowOnly …` | MIT (npm devDependency) | **fails — expected, see §6.1** |

**Two jobs are expected to fail today, by design.** The ticket that created this workflow
(`.foreman/scratch/p6c-ticket.md`, item D) said explicitly: *"if the existing dependency tree
already violates the policy, DO NOT loosen the policy to make it pass — report the violations as a
concern and configure the job so the violations are visible."* The ledger records the verified first
run (`CI RUN 35624656015` on `989e4a6`): gates SUCCESS, gitleaks SUCCESS, osv-scan FAILURE, license
policy FAILURE — **both failures confirmed as real findings, not config errors**. The osv-scan job
also successfully uploaded SARIF to the repo's Security tab, which was the one part that could not
be validated locally. A red pipeline here is the known state, not a broken pipeline.

**Pinned action SHAs.** Every third-party action is pinned to a full commit SHA with a trailing
comment recording exactly how it was resolved — `git ls-remote --tags <repo> <tag>`, cross-checked
against the GitHub REST API's tags endpoint:

```
actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1          # v7.0.1
actions/setup-node@820762786026740c76f36085b0efc47a31fe5020        # v7.0.0
google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@a345acffa64b0eaede81a3d9aae6141214d9c8fc  # v2.6.0
```

**Why gitleaks is not an action.** The natural CI target `gitleaks/gitleaks-action` is a *different
repository* from the accredited `gitleaks/gitleaks` (NOASSERTION licence with its own EULA requiring
a licence key for org-owned repos, ~650 stars, vs MIT and ~29k stars). The accredited CLI ships no
`action.yml`, so it cannot be `uses:`-pinned. The workflow downloads the pinned v8.30.1 release
binary and verifies it with `sha256sum -c` against the project's own published checksums file — the
honest supply-chain equivalent. `.gitleaksignore` allowlists exactly one fingerprint (a fabricated
`token=` value in an export-redaction test fixture, verified against the commit diff).
`.pre-commit-config.yaml` offers the same hook locally, opt-in via `pre-commit install`.

**Permissions.** Repo-level `contents: read`. Only `osv-scan` widens it, at job level
(`actions: read`, `contents: read`, `security-events: write`) so the reusable workflow can upload
SARIF.

### 4.3 The gate set, and the `expo export` working directory

The project's standing verification gate — the one every delegation ticket and the playbook repeat
— is four commands, and **the fourth must be run from `apps/mobile`, not the repo root**:

```
npm run typecheck                                 # repo root
npm test                                          # repo root
npm run lint                                      # repo root
cd apps/mobile && npx expo export --platform ios  # NOT the repo root
```

`docs/NEXT-CIRCUIT-PLAYBOOK.md:20` states it, and every ticket in `.foreman/scratch/` repeats it.
`apps/mobile/package.json` also exposes it as `npm run export:ios` from within that workspace.
The playbook adds one more rule with a scar behind it: **gates must be taken from real exit codes**
(`cmd > log 2>&1; ec=$?`), never piped through grep — `npm test | grep …` returns grep's exit code,
and that shipped two red commits before the rule existed.

The export is also what proves the circuit assets are statically bundled: forensics on each build
grep the Hermes bundle for `motorpark-romania`, `transilvania-motor-ring`, `ODbL` and the build's
new UI strings. Note the recurring finding, recorded twice in the ledger: **Romanian strings with
diacritics and em-dashes are stored UTF-16 in the Hermes bundle**, so `strings -a` will not find
them — byte-search UTF-16-LE instead of concluding a string is missing.

### 4.4 `builds/` (gitignored)

`builds/ipa/` holds 28 shipped `.ipa` files (2026-08-06 → 2026-09-23) plus ten
`TEST-<N>-PROTOCOL.md` field-test protocols (3–11 and 13; build 12's protocol was renamed
`TEST-13-PROTOCOL.md` for build 13, and build 14 added none) and unpacked `inspect/Payload/` and
`coach/inspect/` trees used for forensics. The three newest, from the ledger and checked against
the files on disk:

| Build | File | Run | Commit | Bytes | md5 |
|---|---|---|---|---|---|
| 12 | `TRACE-v12-data-collection-release-2026-09-22.ipa` | `35776004295` | `cb7dee1` | 14,442,637 | `02dc5a80aa4191d217108c1532baef7e` |
| 13 | `TRACE-v13-flow-fixes-release-2026-09-23.ipa` | `35821677110` | `c462af2` | 14,448,092 | `7252beb9631491480bd17162ab8a0922` |
| 14 | `TRACE-v14-delete-all-release-2026-09-23.ipa` | `35892924777` | `3c6c342` | 14,457,445 | `84127f5234393defbd7168093a984ad0` |

Build 13 carried the mapping job's fixes and the flow-review fixes; its Codex cross-verification
could not complete (quota), which the ledger records. Build 14 carried the cloud session's work
(delete-all now wipes VIN, vehicle data and learned circuits; Signal Finder early-wake fix; prompt
audit), P17's coaching tiers, and the P18 fix waves, and went through the full chain: gates →
Codex P18-REV4 0 HIGH → headless preview E2E → forensics. None of this is in git — **if the working copy is lost, the `.ipa` files are
gone**; only the ledger's per-build record survives.

Two process rules from the ledger apply to anything that lands here:

- **User rule, binding (2026-08-30):** no `.ipa` build and no delivery without the final
  verifications — all gates → cross-review with **0 HIGH** → E2E → only then build → forensics →
  deliver. Build 6 was triggered in parallel with a review that then found 3 HIGH; its `.ipa` was
  withdrawn from `builds/ipa/`.
- **Install slots are precious** — sideloaded iOS via Sideloadly with a free Apple ID gives roughly
  9 installs per 5–7 days, and a signature lasts 7 days. See `docs/ios-no-mac-workflow.md` and
  ADR-0005.

---

## 5. Hardware and firmware

### 5.1 What the trace-dongle is today

An **ESP32-C3 OBD-II dongle that speaks a minimal ELM327-compatible subset over its own WiFi
SoftAP**, with CAN (TWAI) on the vehicle side. It exists so the shipped TRACE app connects
**unmodified** — it is the server side of exactly the client in
`packages/core/src/telemetry/elm327Session.ts` / `apps/mobile/src/session/tcpObdTransport.ts`.

- SSID `TRACE-OBD-XXXX` (last 4 hex of the factory MAC), WPA2-PSK, **default password `tracetrace`
  — documented as a known default that must be changed** (`src/wifi_ap.cpp`, `kApPasswordDefault`).
- Static IP `192.168.4.1`, TCP port `35000`, **single client only** (a second connection is refused,
  per the "one adapter ↔ one phone" design).
- **No OTA, no BLE, no web UI.** Explicitly a rev-A prototype, not a product.
- **It has no GNSS module. There is no GPS receiver anywhere in this hardware.** Position still
  comes from the phone. The planned successor — a standalone battery-powered high-rate GNSS timing
  device — is specified in `docs/hardware/gnss-device-design.md` (2026-09-21, *"design deliverable,
  not a build order; nothing here is committed to hardware yet"*). Its headline recommendation is to
  **build the protocol before the box**: implement a RaceBox-protocol BLE client first, field-validate
  at both circuits, and only then build hardware that speaks that protocol verbatim. Note its
  uncomfortable conclusion: GNSS-to-phone alignment lands at ±2–5 ms, but **OBD-to-phone alignment is
  ±30–60 ms and that, not GNSS, is the binding constraint on any fused brake/position claim**.

### 5.2 Firmware modules (`firmware/`)

Arduino framework on PlatformIO. The deliberate split is between framework-free C (host-testable)
and ESP32 C++:

| Module | Kind | What it does |
|---|---|---|
| `pid_codec.{h,c}` | framework-free | mode-01 PID table + response formatting |
| `elm_line_parser.{h,c}` | framework-free | incoming byte stream → command-line framer |
| `elm_server_core.{h,c}` | framework-free | ELM dispatch (echo, AT commands, `>` prompt) |
| `read_only_guard.{h,c}` | framework-free | **the single CAN-transmit chokepoint** |
| `can_response_match.{h,c}` | framework-free | response correlation |
| `can_obd.{h,cpp}` | ESP32 | TWAI driver, `0x7DF` request / `0x7E8-0x7EF` response |
| `wifi_ap.{h,cpp}` | ESP32 | SoftAP + TCP server on port 35000 |
| `elm_server.{h,cpp}` | ESP32 | `WiFiClient` ↔ `elm_server_core` wiring |
| `status_led.{h,cpp}` | ESP32 | IO8 blink-pattern state machine |
| `main.cpp` | ESP32 | `setup()`/`loop()`, single-client accept policy |

**The read-only guard is the safety-critical module.** `guard_can_transmit()` in
`read_only_guard.c` is the *only* place allowed to decide whether a CAN frame reaches the vehicle
bus; `can_obd.cpp`'s single `twai_transmit()` call site is gated behind it. Whitelist: mode `01`
plus the two read-only UDS services the app's custom-PID contract uses, `21`/`22`. Explicitly
rejected and logged: `04` (clear DTCs), `08` (actuation), `2F` (IO control), `3E` (tester present).
The full table is pinned by `test/test_read_only_guard/`.

### 5.3 Building and testing the firmware

`firmware/platformio.ini` defines three environments:

```sh
pio run  -e esp32c3          # cross-compile firmware
pio run  -e esp32c3-sniff    # SNIFF_ONLY listen-only build (-D SNIFF_ONLY=1)
pio test -e native           # host unit tests — NO ESP32 hardware required
```

`env:native` compiles only the five framework-free `.c` modules (its `build_src_filter` excludes
everything that pulls in `Arduino.h` or `driver/twai.h`) with `-std=gnu++14 -Wall -Wextra`. Four
test suites live under `firmware/test/`. **None of this runs in CI** — the firmware is not built or
tested by either GitHub workflow.

Flashing is manual via J2 (1×6 2.54 mm header: 3V3, GND, TX, RX, IO9/BOOT, EN) with SW1 held for
UART download mode; the full procedure is in `firmware/README.md`.

`SNIFF_ONLY` (S pin held HIGH, TWAI installed in `TWAI_MODE_LISTEN_ONLY`, transmit chokepoint never
transmits) exists as a compile-time flag for a future fully-passive build but is **not** the
default — normal operation actively polls the ECU.

### 5.4 The KiCad project and the rest of `hardware/`

```
hardware/DESIGN.md                        binding rev-A design: architecture, LCSC part table,
                                          the BINDING netlist (§3), PCB constraints (§4),
                                          deliverables map (§5), honest limitations (§6),
                                          plus §7/§8 amendments
hardware/ORDERING-RO.md                   ordering notes (Romania)
hardware/schematic/generate_schematic.py  schemdraw generator
hardware/schematic/trace-dongle.svg       rendered schematic for human review
hardware/enclosure/trace-dongle-case.scad OpenSCAD source
hardware/enclosure/*.stl, preview-*.png   generated body/lid + renders
hardware/kicad/trace-dongle/
  generate_board.py                       66 KB pcbnew script — builds the .kicad_pcb FROM SCRATCH
  generate_production_csv.py              BOM/CPL emitter
  trace-dongle.kicad_pcb                  generated board (326 KB)
  trace-dongle.kicad_pro / .kicad_prl     KiCad project/local settings
  fp-lib/TRACE-Custom.pretty/             ESP32-C3-MINI-1 custom footprint
  drc-all.json, trace-dongle-drc.rpt      DRC results
  production/                             gerbers.zip + 18 gerber/drill layers, bom.csv, cpl.csv
  review-top.svg, review-bottom.svg, render-top.png
```

**The board is generated, not drawn.** `generate_board.py` is run with KiCad 10's bundled Python
and is explicitly deterministic: *"delete + re-run reproduces the same board."* It builds the PCB
from DESIGN.md §3's binding netlist as amended by §7 and §8.

**DRC is clean:** `trace-dongle-drc.rpt` (2026-08-11) reports **0 violations, 0 unconnected pads, 0
footprint errors**; `drc-all.json` (KiCad 10.0.5) has empty `violations`, `unconnected_items` and
`schematic_parity` arrays, with five checks explicitly ignored (missing courtyard, track-not-centered-
on-via, tuning profiles, footprint-filter and footprint-type mismatches).

**Two part changes are recorded in `generate_board.py`'s REV A3 header and matter if you read
DESIGN.md §2 alone:** the TPS54202DDCR pin map was corrected against the live TI datasheet
(1=GND, 2=SW, 3=VIN, 4=FB, 5=EN, 6=BOOT), and **U2 was replaced: TJA1051T/3 → TCAN330DR**, because
the TJA1051T/3 needs 4.5–5.5 V VCC and this design has only a 3.3 V rail. DESIGN.md §2's table
(with the reasoning in §8.4) and `firmware/README.md` were brought into line in `ec153ef` — see §8 S4.

**Honest limitation, stated in both DESIGN.md §6 and firmware/README.md:** **no physical validation
yet**. No board has been fabricated or brought up.

---

## 6. The known backlogs (parked — do not lose these)

Both were opened in RUN P7 and then **deliberately parked** so a verified build could ship before a
track day. The ledger records the reason: *"zero relevance to a track day, and both touch the root
manifest/lockfile, which is the last thing to churn before a build the user depends on trackside."*
Both are listed under "OPEN, for the owner" at the close of RUN P6.

Detail lives in `.foreman/ledger.md` (the P6c and RUN P7 sections) and
`.foreman/scratch/p6c-ticket.md`.

### 6.1 Licence-policy backlog (was ticket P7E)

**Policy in force** (`.github/workflows/security-and-ci.yml`, `license-policy` job):

```
--allowOnly MIT Apache-2.0 BSD-2-Clause BSD-3-Clause ISC 0BSD CC0-1.0 Unlicense Python-2.0 BlueOak-1.0.0
```

AGPL and GPL must fail. **9 packages currently fall outside the allowlist; none is AGPL or GPL:**

| Package(s) | Licence | Class |
|---|---|---|
| 3× `@expo-google-fonts/*` (inter, jetbrains-mono, space-grotesk) | MIT AND OFL-1.1 | font files |
| `caniuse-lite` | CC-BY-4.0 | data |
| `lightningcss` + its win32 binary | MPL-2.0 | file-level copyleft |
| `spdx-exceptions`, `spdx-expression-validate`, `spdx-ranges` | CC-BY-3.0 | data — **transitive deps of the licence checker itself** |

The job's first CI run enumerated the violating buckets and exited 1: 2× MPL-2.0, 1× CC-BY-3.0,
2× "MIT AND CC-BY-3.0", plus the OFL/CC-BY-4.0 ones.

**The scope is wider than the 9 packages.** The P7E plan line reads: *"9 packages outside the
allowlist + **3 UNLICENSED workspace packages** + the **App Store NOTICES obligation**"* — the three
workspace `package.json` files (`circuit-timer`, `@circuit/core`, `mobile`) carry no `license` field,
and the app is heading to the EU App Store, where an open-source NOTICES obligation makes this real
rather than theoretical.

**The framing the LEAD set for whoever picks this up** (verbatim from the ledger): the earlier "do
not loosen the policy" rule existed so the findings would be *understood* before being admitted.
They now are — none is AGPL/GPL; the classes are OFL-1.1 (font files), CC-BY (data), MPL-2.0
(file-level copyleft). **The correct answer is a deliberate documented policy plus a NOTICES file
that discharges attribution — not a silent widening.** Every admission must carry its reason so the
owner can veto any single line.

**Since 2026-09-23 a draft exists for the NOTICES half:** `docs/legal/oss-notices.md` (1.0-draft,
for lawyer review) states that the app has **no** open-source notices screen, that the About-card
sentence does not discharge the MIT/BSD/Apache, OFL or CC attribution obligations, and proposes
how to generate the notices. It also says the ODbL obligation **is** discharged (§1.4). Nothing
from it is implemented yet, and the CI policy itself is unchanged.

### 6.2 Dependency-advisory backlog (was ticket P7F)

**29 advisories** over the full tree: 1 critical, 10 high, 18 moderate. `npm audit --omit=dev`
reports 22 (8 high, 14 moderate) against production deps. The single critical is in `vitest` and
**is** dev-only. Most of the rest are transitive through `expo`/`metro`.

**The correction that matters** — a worker's report described the advisories as "all in dev-only
chains" and the LEAD rejected that as unsupportable:

> npm's prod/dev split is not the same question as what ships in an Expo binary — `metro`,
> `@expo/metro` and `vite` are build tooling that Expo declares as *production* dependencies.
> Neither "dev-only" nor "ships" is provable without inspecting the bundle; **recorded as an open
> question.**

So the first task for whoever picks this up is not `npm audit fix` — it is establishing which of
these actually reach the shipped Hermes bundle. The routing note flags the risk: *"dependency-
resolution changes can break an Expo build; needs judgement about what is safely fixable vs what
must be accepted with reasons."*

Live SARIF results are in the repo's Security tab:
`https://github.com/dobrinz123/track_app/security/code-scanning?query=is:open+branch:main+tool:osv-scanner`

### 6.3 A third open item, for completeness

`osv-scan` and `license-policy` currently **block** the pipeline. The ledger records that the
blocking-vs-advisory decision was **not delegated** and stays with the owner — with the note that it
*"evaporates if P7E and P7F actually clear the backlogs — that is the outcome to aim for, rather
than reaching for `continue-on-error`."*

---

## 7. Runbook: clean clone → running app → shipped build

Prerequisites: **Node 24.x / npm 11.x**. No Xcode, no Android SDK, no KiCad and no PlatformIO are
needed for anything up to and including triggering a build. A GitHub account is needed for the
build; Sideloadly + a free Apple ID for the install.

**1. Install (repo root only).**
```
npm install
```
Never `npm install` inside a workspace — one lockfile, one node_modules root.

**2. Verify (the standing gate set — take real exit codes, never pipe through grep).**
```
npm run typecheck
npm test
npm run lint
cd apps/mobile && npx expo export --platform ios
```
Note the fourth command's working directory. Expect roughly 3,413 tests as of build 14 (1,787 core
+ 1,626 mobile); a count that drops is a regression, not noise. To keep the real exit code:
`npm test > test.log 2>&1; echo $?` (the form `docs/HANDOFF-2026-09-23-cloud.md` uses).

**3. Run it locally, for visual work.**
The fastest loop is the web preview: `.claude/launch.json` defines a `mobile-web` target on port
8082, and the in-app DevReplay screen drives the **real production controller** with bundled
fixtures. Web has no SQLite (in-memory fallback), and RN-web under mobile emulation needs synthetic
pointer+mouse+click sequences; long-press needs touchstart/touchend held ~2.6 s.
For the pre-build E2E, use the **headless `agent-browser` CLI** against `npx expo start --web`
(from `apps/mobile`), at 360x640, as build 14's E2E did (playbook Lesson 10; the Chrome-extension
preview can be occluded and throttle the replay). Its mechanics, as exercised on 2026-09-23:
- `agent-browser open <url>` **hangs**, because Metro never fires `load`. Navigate with
  `agent-browser eval "location.href='http://localhost:<port>/'"` instead, then poll (`eval`) until
  the app's rendered divs exist.
- Long-press (e.g. hold-to-end) is `agent-browser mouse down`, a wait, then `mouse up`.
- Give screenshot paths as absolute paths (the daemon's cwd is not yours).
- The web preview has **no SQLite and no GPS**. On-disk behaviour (e.g. the delete-all wipe) and
  anything GPS-driven outside DevReplay is covered only by tests, and the ledger entry must say so.

For a device loop: `npx expo start` from `apps/mobile` against an installed dev-client build.
**Expo Go does not work** for this SDK / the native TCP module.

**4. (Only if the circuit assets must change.) Regenerate.**
```
npm run generate:tmr         # rewrites transilvania-motor-ring.v2.json  (add -- --layout-version=1 for v1)
npm run generate:motorpark   # rewrites motorpark-romania.v1.json
```
Then `npm test` — the byte-identity asset tests will fail if anything moved. A *different* OSM
snapshot is a `layoutVersion` bump, not an in-place rewrite. Read §1.3 and `docs/adding-a-circuit.md`
before touching `geometryStatus`.

**5. Before any build — the binding order.**
> gates → cross-review with **0 HIGH** → E2E → build → forensics → deliver.

This is a standing user rule (2026-08-30). Do not trigger a build in parallel with a review to save
time; build 6 did exactly that and its `.ipa` was withdrawn. Visual features get visual verification
in the web preview and an explicit user OK **before** a build.

The cross-review is Codex, read-only, fed a ticket on stdin:
```
codex exec --sandbox read-only -C <repo> - < .foreman/scratch/ticket-<id>-codex.md > .foreman/scratch/<id>-out.txt
```
(`docs/HANDOFF.md`, "Codex is the release reviewer"). Fix wave → re-review on the fix diff, until
0 HIGH; P18 took four rounds. Codex has hit its quota mid-review twice — a partial run is **not** a
pass (build 13's ledger entry records exactly that).

**6. Build the `.ipa`.**
Run the **Build unsigned iOS** workflow in `dobrinz123/track_app` — either `workflow_dispatch` with
`variant` (`release` / `dev-client` / `both`), or push a `build-*` tag. It runs on a free macOS
runner, takes ~14–15 minutes, needs no secrets. Output artifacts:
`CircuitTimer-release-unsigned` and/or `CircuitTimer-devclient-unsigned`. From the CLI (as for
build 14):
```
gh workflow run build-unsigned-ios.yml --ref main -f variant=release
gh run list --workflow build-unsigned-ios.yml     # take the run id
gh run watch <run-id>
```

**7. Forensics, then file the build.**
```
gh run download <run-id> -n CircuitTimer-release-unsigned -D <dir>
```
Unzip the `.ipa` and grep the Hermes bundle at `Payload/TRACE.app/main.jsbundle`: bundle id `app.circuittimer.tmr`
unchanged; the build's new UI strings present (**byte-search UTF-16-LE for anything with diacritics
or em-dashes — `strings -a` will not find them**); `motorpark-romania`, `transilvania-motor-ring`
and `ODbL` present; expected native symbols (`TcpSocket`, `ExpoLocation`, `ExpoFileSystem`, …).
Then rename to `TRACE-v<N>-<slug>-release-<YYYY-MM-DD>.ipa`, drop it in `builds/ipa/` with a
`TEST-<N>-PROTOCOL.md`, and **append the run id, commit, byte size and md5 to `.foreman/ledger.md`**
— `builds/` is gitignored, so the ledger is the only record that survives.

**8. Install on the iPhone.**
Sideloadly + a free Apple ID on Windows; full beginner-proof guide in
`docs/ios-no-mac-workflow.md`, rationale in ADR-0004 and ADR-0005. Signatures last 7 days and
you get ~9 installs per 5–7 days — **do not spend a slot on an unverified build.**

**Firmware, if you need it** (independent of all the above, and not in CI):
```
cd firmware
pio test -e native      # host unit tests, no hardware
pio run  -e esp32c3     # cross-compile
```
Flashing procedure: `firmware/README.md`.

### Documentation index (point here, don't duplicate)

| Topic | Document |
|---|---|
| Start here: state, rules, what to do next | `docs/HANDOFF.md`, then `docs/HANDOFF-2026-09-23-cloud.md` (cloud session of 2026-09-23: prompt audit, delete-all, Signal Finder early wake) |
| The other architecture maps / flow review / public-release plan | `docs/architecture/map-core-timing.md`, `map-core-analysis.md`, `map-mobile-app.md`, `flow-review.md`, `public-release-plan.md` |
| Module contracts | `docs/architecture/contracts.md` |
| What is built today | `docs/architecture/current-state.md` |
| Analysis engine | `docs/architecture/analysis-engine.md` |
| Adding a circuit (process + validation error codes) | `docs/adding-a-circuit.md` |
| Lessons learned before touching a circuit | `docs/NEXT-CIRCUIT-PLAYBOOK.md` |
| Stack / geometry source / iOS target / no-Mac / free install | `docs/decisions/ADR-0001…0005` |
| iOS build + sideload guide | `docs/ios-no-mac-workflow.md` |
| Timing, calibration, live delta | `docs/algorithms/*.md` |
| Known limitations | `docs/known-limitations.md` |
| Persistence / privacy / voice pack / testing & replay | `docs/persistence-model.md`, `docs/privacy.md`, `docs/voice-pack.md`, `docs/testing-and-replay.md` |
| TMR research packet (per-claim confidence tags) | `docs/research/transilvania-motor-ring.md` |
| Verification baseline / final report / performance / track checklist | `docs/verification/*.md` |
| Planned GNSS device | `docs/hardware/gnss-device-design.md` |
| Legal drafts (privacy policy RO/EN, terms, App Store labels, permission strings, OSS notices, compliance checklist) | `docs/legal/*.md` — privacy policy §3.3/§7 and checklist item 3.5 (DONE) describe the build-14 delete-all |
| Agent instruction files and their audit | `apps/mobile/AGENTS.md` (loaded via `apps/mobile/CLAUDE.md`), `docs/HANDOFF.md`, `docs/NEXT-CIRCUIT-PLAYBOOK.md` §0, `.claude/settings.local.json`; audit in `docs/audits/prompt-audit-2026-09-23.md` (+ `.patch`), applied in full |
| Board design (binding) | `hardware/DESIGN.md` |
| Firmware | `firmware/README.md` |
| Campaign history, every build, every decision | `.foreman/ledger.md` |

---

## 8. Questions and suspicions

Recorded, **not fixed**. Each with the evidence that raised it. Status re-checked against
`4e88d13` on 2026-09-23: S4 is **answered**; S1, S2, S3, S5, S6, S8–S10, S12, S13 are still open as
written; S7 and S11 are updated in place; S14 is new.

**S1 — `docs/adding-a-circuit.md` lists a stale `geometryStatus` enum.** It documents
`'official' | 'community-derived' | 'dev-only'`; `packages/core/src/contracts.ts:57` and
`packages/core/src/profile/schema.ts:46` both carry a fourth value, `'ad-hoc'` (learned circuits,
added in P5d/build 11). Since this document is the process guide for the honesty gate, the omission
matters: someone following it would not know the learned-geometry value exists.

**S2 — the MotorPark densification is not in `docs/known-limitations.md`.** That file's circuit
section still describes only "community-derived and unvalidated on-site" and quotes TMR's
`confidenceNotes`. The fact that **128 of MotorPark's 230 centerline points are interpolated** is
recorded in the asset, in `densify.ts` and in the generator — but not in the document a reader would
consult for limitations. Also, the quoted `confidenceNotes` text in that file is TMR's; MotorPark's
is much stronger and is not quoted anywhere in `docs/`.

**S3 — `docs/NEXT-CIRCUIT-PLAYBOOK.md` states the asset path as `<circuit>.v2.json`.** MotorPark
ships as `motorpark-romania.v1.json`. The `.v2` in the playbook is a generalisation from TMR, and a
new circuit author following it literally would produce a mismatched filename. Minor, but it is the
first document a new-circuit campaign reads.

**S4 — ANSWERED (fixed in `ec153ef`, the commit this map was written in; shipped in build 13).**
DESIGN.md §2's U2 row now reads TCAN330DR, states it matches `production/bom.csv`, and points to
§8.4 for the TJA1051T/3 withdrawal; `firmware/README.md` no longer names the TJA1051T/3. Original
finding kept below for the record.
**S4 — `hardware/DESIGN.md` §2 and `firmware/README.md` still name the TJA1051T/3.**
`generate_board.py`'s REV A3 header records that **U2 was replaced by a TCAN330DR** because the
TJA1051T/3 requires 4.5–5.5 V VCC and the design has only a 3.3 V rail — with the pin map verified
against the live TI datasheet and a note that the remediation ticket's own proposed pin map was
itself wrong. The DESIGN.md component table (the "binding" document) and the firmware README's
flashing/architecture prose have not been updated to match. The generated board is presumably
correct — this is a documentation/authority conflict, and DESIGN.md calls itself binding.
**Rank: real risk** if anyone orders or hand-assembles from the DESIGN.md table rather than from
`production/bom.csv`.

**S5 — the trace-dongle WiFi AP ships a documented default password.** `tracetrace`, WPA2-PSK,
stated in `firmware/README.md` with a "**change this**" warning. Any dongle flashed as-is is open to
anyone within WiFi range who has read this repo, and the dongle sits on the vehicle CAN bus. The
`read_only_guard` whitelist limits the damage to read-only services, which is the mitigating factor
— but this is a shipped-default credential.

**S6 — `hardware/kicad/trace-dongle/{kicad_pro,kicad_prl}` have uncommitted modifications.**
`git diff --stat` shows +44/−5 across the two, dated 2026-08-31 (the board and DRC artefacts are from
2026-08-11). These are KiCad project/local-settings files that change simply from opening the project
in the GUI, so this is most likely incidental — but the working tree has carried them dirty across
multiple campaigns (the RUN P7 baseline line explicitly says *"clean except hardware/kicad/*
(pre-existing)"*). Worth confirming no design intent is sitting uncommitted there. Still dirty at
`4e88d13`; the 2026-09-23 sessions treated it as the owner's uncommitted work and left it alone.

**S7 — `builds/` is gitignored and holds the only copies of 28 shipped `.ipa` files** (24 when
first written; builds 13 and 14 added since, and the count on disk is 28). Losing the
working copy loses every shipped artifact and all ten `TEST-*-PROTOCOL.md` field protocols. The
ledger keeps run ids, commits, sizes and md5s, and the GitHub artifacts have 90-day retention — so
anything older than 90 days is **not reproducible without re-running the build from its commit**.
**Rank: real risk**, and cheap to mitigate.

**S8 — `graphify-out/` is tracked in git** (`git ls-files graphify-out` returns
`.graphify_labels.json`, `.graphify_python`, `.graphify_root`, …) while `dist/` and `builds/` are
ignored. It is tooling output from the graphify skill, not project source. Not harmful; probably
unintended.

**S9 — TypeScript version skew across workspaces.** Root devDependency and `packages/core` pin
`typescript ^5.6.3`; `apps/mobile` pins `typescript ~6.0.3`. `npm run typecheck` therefore runs two
different compilers over a shared source graph (core is consumed as `.ts` source, not built output).
It passes today; it is a latent source of "it typechecks in one workspace but not the other".

**S10 — the osv/licence split is an *open question*, not a finding.** Worth restating so nobody
closes it prematurely: whether the 29 advisories reach the shipped Hermes bundle **has never been
determined**, because `metro`, `@expo/metro` and `vite` are declared production dependencies by
Expo. Any triage that starts from `npm audit --omit=dev` is answering a different question.

**S11 — blank area: no lap has ever been timed on a real circuit by this app.** Every field test to
date (3–11) was OBD/signal work on street or driveway; `data/field/` contains signal-finder and sweep
captures only, and zero session or lap data. Build 12 was shipped specifically as a data-collection
build for the first real circuit session. Everything in this repo about lap boundaries, sector
splits, corridor matching and calibration coverage at a real track is therefore **validated in
replay against synthetic and derived fixtures, not against a real lap**. That is the honest state.
Still true at `4e88d13` (no new files under `data/`). The first real circuit session is planned
for **Monday 28 Sep 2026 at MotorPark România**, following `builds/ipa/TEST-13-PROTOCOL.md`
(`docs/HANDOFF.md`). Note that the reason once given here, "the `geometryStatus` gate keeps
coaching suggestions off", no longer holds: since P17 pit suggestions run on mapped geometry (§1.3).
Only live cue moves wait for `'official'`.

**S12 — blank area: no hardware has been fabricated.** DESIGN.md §6 and `firmware/README.md` both
state "no physical validation yet". DRC is clean and production files exist, but no board has been
built or brought up, and the firmware has never talked to a real vehicle bus through this board.

**S13 — the firmware is not covered by CI.** `pio test -e native` exists and has four suites
(including the read-only guard whitelist, the safety-critical one), but neither GitHub workflow
builds or runs it. A firmware regression would be caught only by whoever remembers to run it
locally.

**S14 — `.claude/settings.local.json` is tracked in git** (`git ls-files .claude` lists it next to
`launch.json`). `*.local.json` files are normally per-machine. The prompt audit
(`docs/audits/prompt-audit-2026-09-23.md`, finding 7) pruned 14 one-off entries but deliberately kept
the file tracked, because untracking it would delete it from existing clones on their next pull.
Any session that adds a permission locally changes a committed file. Low risk; recorded so that a
diff there is not mistaken for project configuration.
