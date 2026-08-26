# Adding the Next Circuit — Playbook & Lessons Learned

Written 2026-08-16, after the full TMR (Transilvania Motor Ring) campaign: build,
field failure, field fix. **Read this before touching anything.** It encodes what
the codebase alone cannot tell you — why things are the way they are, and what
broke in the real world.

## 0. How to work in this repo (non-negotiable process)

- **Use the fable-foreman skill** (`/fable-foreman`): the lead model plans, writes
  delegation tickets, and verifies; Sonnet-class workers implement; Codex (if
  consented/available) cross-reviews. History shows why: cross-family review found
  25+ real defects across campaigns that same-family testing missed, including a
  destructive-OBD-command HIGH and a fab-killing pin-map error.
- **Gates on REAL exit codes, always**: `cmd > log 2>&1; ec=$?` — never pipe
  through grep (`npm test | grep ...` returns grep's exit code; this shipped two
  red commits before the rule existed). The full gate set:
  `npm run typecheck && npm test && npm run lint` +
  `cd apps/mobile && npx expo export --platform ios`.
- **No facts from memory**: every external fact (OSM data, datasheet pinouts,
  part numbers, API shapes) is verified against the live source and cited. The
  hardware campaign's NO-GO (7 HIGH findings) was largely memory-sourced "facts".
- **Batched fix waves**: one fix worker per findings list, never one per finding.
- **The ledger** (`.foreman/ledger.md`) is append-only campaign history — read its
  tail before starting, append your campaign, keep it honest (failures included).
- **Install slots are precious** (sideloaded iOS, ~9 installs/5-7 days): never
  green-light an install without the full verification pipeline (gates + preview
  E2E + cross-review + ipa forensics). Builds run on GitHub Actions
  ("Build unsigned iOS", dobrinz123/track_app, variant=both); install via Sideloadly.
- **Visual features get visual verification** in the web preview BEFORE any build
  (`.claude/launch.json` -> mobile-web on :8082; DevReplay screen drives the REAL
  production controller with bundled fixtures). The user reviews visually and
  gives an explicit OK before an ipa build. RN-web quirks: clicks under mobile
  emulation need synthetic pointer+mouse+click sequences; long-press needs
  touchstart/touchend held ~2.6s; web has no SQLite (in-memory fallback).

## 1. Architecture map (what a circuit IS in this codebase)

A circuit = one JSON asset + generated runtime artifacts + optional overlays:

- `packages/core/assets/circuits/<circuit>.v2.json` — the **CircuitProfile**:
  centerline (lat/lon list), S/F + sector + pit gates, `corridorWidthM`,
  lengths, provenance/`confidenceNotes`. Schema: `packages/core/src/persistence`
  (`loadProfileFromJson` path); TMR's asset is the reference example.
- **RuntimeProfile** is derived at load: local ENU projection, cumulative
  distances, gate geometry (`createProjection`, `polylineLength`,
  `projectOntoPolyline`).
- **Generator**: the TMR profile was produced by a deterministic script from raw
  OSM data (`data/osm/` holds the archived Overpass JSON; ADR-0002 governs
  geometry sourcing). Asset regression tests pin byte-identical generator output.
- **Corners**: `packages/core/src/corners/analyzeCorners.ts` — curvature
  segmentation with direction-split (bump `CORNER_ANALYSIS_VERSION` on any
  algorithm change), severity from `minRadiusM`, advisory speed from
  angle-bucketed latG (`DEFAULT_CORNER_LAT_G_BUCKETS`, calibrated against real
  M2 Competition onboard data at TMR).
- **Observed speeds overlay** (optional):
  `packages/core/assets/circuits/<circuit>.observed-speeds.v1.json` — user-supplied
  apex speeds keyed by cornerId + `analysisVersion`; overlay rule
  `min(observed, model*1.1)`. Corner IDs REMAP when the analysis version changes —
  re-verify every observation's corner geometrically after any bump.
- **Coaching**: `packages/core/src/coach/` (braking zones from PB telemetry or
  physics fallback; CoachEngine cues) — all derived, no per-circuit code.
- **Voice/telemetry/track-map**: circuit-independent; nothing to do per circuit.

## 2. Step-by-step: adding circuit N+1

1. **Source geometry**: find the OSM way(s) (Overpass; archive raw JSON in
   `data/osm/`). Record way IDs + license (ODbL attribution is MANDATORY in the
   asset's provenance and must remain user-visible in the app's About; never
   label anything "official").
2. **Generate the profile**: follow the TMR generator pattern (deterministic
   script -> v-numbered JSON asset). Sector gates: use the v2 "straight vertex"
   rule documented in TMR's `confidenceNotes` (gates on timing-stable straights,
   not corners). Set `corridorWidthM` = researched track width + GNSS margin
   (TMR uses 15).
3. **Pin it with tests**: asset regression (byte-identical generator output),
   profile-load sanity (length vs researched length), corner-count plausibility
   vs the circuit's published map, gate positions.
4. **Corners + advisories**: run `analyzeCorners`; sanity-check corner count and
   directions against a published track map. Observed speeds only if real
   onboard data exists — provenance string required.
5. **App catalog**: add the circuit to the selection screen (`CircuitSelectionScreen`
   / catalog module) — the UI was built for multiple circuits from day one.
6. **Fixtures**: add replay fixtures for the new circuit (see
   `packages/core/src/fixtures/` + `drive-lap`) so DevReplay and the soak tests
   can exercise it hardware-free. Port the acceptance soak
   (`userTrackDayScenario.soak.test.ts` pattern: hard/cool laps, pit transit,
   long pause, watchdog recovery, no recalibration on resume).
7. **Gates + preview E2E** (calibrate -> laps -> PB/delta -> results -> history on
   the new circuit), THEN build.

## 3. The field lessons (this is the section that saves you)

**Lesson 1 — OSM geometry is NOT ground truth.** TMR's centerline is traced from
aerial imagery and was never validated on-site. In the field, calibration stalled
at 81-90% coverage on every lap and the app showed "off track" on the racing
line: a contiguous stretch of centerline sits laterally offset beyond the 15m
corridor. **Assume the same for every new circuit until proven otherwise.**

What now exists because of that (don't regress it):
- **Bias-adaptive calibration** (`calibration-engine.ts`): quality-ok samples up
  to 40m (`LEARN_WIDE_CORRIDOR_M`) are retained; bias is estimated, coverage is
  recomputed bias-corrected; acceptance thresholds 0.85 coverage / 250m max gap;
  `POOR_GNSS` judged against the wide set. The live "on track" indicator uses the
  wide corridor; tight-corridor stats stay internal.
- **Failure diagnostics**: on calibration failure the result screen names the
  uncovered stretch in km-from-S/F and top rejection reasons.
- **Track map** (`TrackMapView` + `trackMapModel`, calibration screen): circuit
  outline with live raw-GPS dot vs on-track projection dot + lateral offset
  readout — the on-site tool for SEEING geometry mismatches. Pure-View rendering
  (no SVG dep); auto-rotates portrait tracks; loop is closed explicitly (OSM
  endpoints at TMR sit ~179m apart); joints make the line smooth; content-aspect
  sizing + 6% margin keep it framed on a phone.

**Field protocol for the new circuit's first visit**: run a calibration lap
watching the map + offset readout. If offset grows systematically in one zone,
the OSM line is wrong there — capture where (the km readout), then correct the
asset geometry from that evidence rather than guessing.

**Lesson 2 — direction-split matters.** TMR's initial corner analysis merged
opposite-direction S-complexes into single fake corners (9 vs the real 12).
`analyzeCorners` now splits on sustained opposite-sign curvature; verify the new
circuit's corner list against a published map before trusting severities.

**Lesson 3 — every UI feature is verified at 360pt width with large fonts.**
The telemetry strip once pushed "Hold to End Session" off a 360x640 screen at
1.3x font scale (caught in cross-review). Driving-screen elements must never
reflow timing elements — overlay in dead space, fixed slots, or don't ship.

**Lesson 4 — settings are OFF by default** for anything new (coaching, voice,
telemetry all follow this); the driving screen stays GT-minimal (3-word voice
vocabulary: "Brake hard."/"Brake."/"Lift." — beginners can't parse sentences at
speed).

## 3b. Lessons from circuit N+1 (MotorPark România, 2026-08-26)

**Lesson 5 — scouts fabricate "raw" data.** A web-research scout returned an "Overpass raw
JSON" that was a synthesized summary (fields Overpass never emits, wrong lengths). The
LEAD must fetch Overpass itself (`curl -d '<query>' https://overpass-api.de/api/interpreter`),
archive the real response in `data/osm/`, and treat every scout number as a claim.

**Lesson 6 — topology by node IDs, never by coordinates.** The LEAD's own "41 m unmapped
pit gap" was wrong: the two pit ways SHARE a node; concatenating by endpoint coordinates
produced an 82 m out-and-back. Join ways by shared node ids; assert junctions in the generator
(fail loud); pin splice / S-F / pit polyline in tests that read the RAW archived JSON, not the
generator's helpers (Codex cross-review caught this — same-family tests had blessed it).

**Lesson 7 — modular circuits.** OSM may map a modular circuit as one closed loop + open
extension ways + short chords. Verify the published full-layout length against the spliced
loop (MotorPark: 3326 m loop − 137 m chord + 867 m extension = 4056 m vs 4052 m published),
and expect pit entries on the extension for the full layout (short-config connectors must be
excluded).

**Lesson 8 — corner counts differ from published maps by design.** Detection threshold
0.008 rad/m ignores kinks with radius > 125 m and merges same-direction back-to-back bends
(MotorPark: 10 detected vs 16 numbered). Verify by overlaying detected corners on the geometry
next to the published map (render an SVG from the asset) and pin the exact direction sequence.

**Lesson 9 — the app was single-circuit end to end.** "Built for multiple circuits" was true
only of the list. The production controller, history store, delete-all, coaching corners,
calibration map, CircuitDetail and PB screens all hardcoded TMR. The multi-circuit selection
addenda in contracts.md (selectedCircuitId, catalog entries carry corners, ONE lifecycleLock,
facade commands inside the lock, recovery circuit persisted transactionally) are now the
binding model — read them before touching `composition.ts`. Four review rounds
(Codex + cloud ultrareview) were needed to close the concurrency holes; write failing tests
first for every lifecycle race.

**Lesson 10 — preview E2E mechanics.** The Chrome-extension preview window can be occluded
(`document.hidden === true`) → Chrome throttles timers → replay stalls while the 10x virtual
clock runs (looks like a lap-timer bug; it is not). Use the headless `agent-browser` flow
(`scratchpad/e2e-motorpark.sh` pattern: bounded `open` because Metro never fires load,
absolute screenshot paths, DOM `.click()` for buttons the a11y locator reports as covered,
360x640 viewport). Seam laps of a re-looped fixture are INVALID (pause gap / reverse travel)
by design.

## 4. Current feature inventory (shipped & verified)

GNSS lap/sector timing on monotonic time; Learn-lap calibration (bias-adaptive);
PB reference + live delta; session history/recovery (pit + hour-long pauses, no
recalibration); 12-corner coaching w/ observed-speed advisories; braking-zone
cues (visual + ElevenLabs voice clips, bundled offline, expo-speech fallback);
OBD telemetry over WiFi TCP (ELM327-compatible; oil temps on strip, custom PID
whitelisted to read services 21/22 only); phone-accelerometer G-forces (recorded,
lap-detail charts); calibration track map. Hardware: ESP32-C3 OBD dongle rev A4
(GO-verdict PCB + firmware + enclosure in `hardware/`, `firmware/`) awaiting
fabrication + bench tests.

## 5. Where to look

- `.foreman/ledger.md` — full campaign history, decisions, failures.
- `docs/architecture/contracts.md` — binding module contracts (calibration,
  coaching, telemetry addenda). Amend it BEFORE implementing, as the LEAD.
- `docs/adding-a-circuit.md` — the original (pre-field-lessons) circuit guide;
  this playbook supersedes it where they disagree.
- `graphify-out/` — knowledge graph of the whole codebase
  (`/graphify query "<question>"` answers architecture questions cheaply).
- Memory (`~/.claude/projects/.../memory/`) — cross-session facts incl. hard
  constraints (offline mandate, bundle id `app.circuittimer.tmr`, nothing
  labeled "official", ODbL attribution never deleted).
