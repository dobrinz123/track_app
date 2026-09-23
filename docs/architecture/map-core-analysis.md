# Map — the ANALYSIS half of `packages/core`

> Orientation document. Written 2026-09-22 against `main` @ `4676545`. Covers
> `packages/core/src/{coach,coaching,corners,telemetry,reference,replay,testloop,fixtures,signal,fusion,persistence,persistence-sql}`.
> **Updated 2026-09-23 to `main` @ `4e88d13`**: P17's geometry tiers (`5561364`), the Signal Finder
> cooldown-sleep loop (`8c495b6`), and every anchor re-checked in the files that changed since
> `4676545` — including `ec153ef`'s own P16 fixes, which landed in the same commit as this map.
> It is a **map, not a spec**: where the code and this document disagree, the code wins and this
> document is wrong. Every claim carries a `file:line` anchor so you can check it in one jump.
>
> Sibling documents: `analysis-engine.md` (the binding *design* for `coaching/`),
> `contracts.md` (the binding contracts), `current-state.md` (the whole-repo module map).
> This document is the one that explains **why the code looks like it does**; that reasoning
> otherwise lives only in commit messages and `.foreman/ledger.md`.

---

## 0. The shape of the area in one paragraph

`packages/core` is a pure-TypeScript engine with **no React Native import anywhere**
(`packages/core/package.json` has exactly one runtime dependency, `zod`). The "analysis half"
is everything that turns *what was recorded* into *what it means*: a deterministic,
on-device, no-LLM, no-network pipeline. It splits cleanly in two: **`coaching/` is the offline
analysis engine** (a finished session → per-corner numbers → RO/EN prose), and **`coach/` is the
live, in-car cue engine** (one GNSS match → at most one "BRAKE"/"CORNER AHEAD" cue). Around them
sit the supporting layers: `corners/` (geometry → corner list), `telemetry/` (OBD/ENET transports
and channel decoding), `signal/` + `fusion/` (DSP and IMU attitude), `reference/` (personal-best
and live delta), `persistence/` + `persistence-sql/` (the storage contract and its SQLite
implementation), `testloop/` (learn a circuit from lap 1), and `replay/` + `fixtures/`
(deterministic drives, first-class rather than test-only).

---

## 1. The one-page picture (×2)

### 1a. A completed lap becomes a per-corner analysis

The engine's entry point is `analyzeSession`. Everything upstream of it is *assembly*, and the
assembly lives in `apps/mobile` — see §6 for why.

| # | Step | Symbol | Where |
|---|---|---|---|
| 1 | Read the stored session: lap records, per-lap GNSS, per-session OBD rows | `loadAnalysisSession` | `apps/mobile/src/session/analysisSessionLoader.ts:1` (header) |
| 2 | Project each lap's `LocationSample[]` onto the catalog centreline → monotone `CornerLapSample[]` | `projectLapSamples` | `packages/core/src/coaching/distanceDomain.ts:146` |
| 3 | Attach decoded channel values by monotonic time (≤1 s staleness, nothing interpolated forward) | `joinTelemetryChannels` | `coaching/distanceDomain.ts:218` |
| 4 | Per-lap channel-coverage gate (>50 % of that lap's samples, or the channel is stripped **from that lap**) | `ANALYSIS_MIN_CHANNEL_COVERAGE` | `apps/mobile/src/session/analysisAssembly.ts:85` |
| 5 | **The engine.** Everything below is one synchronous call | `analyzeSession` | `coaching/sessionInsights.ts:447` |
| 5a | → classify each lap `clean` / `unverified` / `anomalous` | `classifyLap` | `coaching/cleanLap.ts:617` |
| 5b | → per (lap, corner) metrics on a 1 m distance grid | `computeCornerMetrics` | `coaching/cornerMetrics.ts:1036` |
| 5c | → the driver's demonstrated envelope, **clean laps only** | `buildDemonstratedEnvelope` | `coaching/envelope.ts:124` |
| 5d | → resample every lap to the distance grid, build `Δt(s)` vs the best clean lap | `resampleLapToDistanceGrid`, `deltaCurveMs`, `deltaOverSegmentMs` | `coaching/distanceDomain.ts:564`, `:710`, `:734` |
| 5e | → rankings (time loss, consistency, sector loss) + `limitations[]` honesty gates + the geometry tier | inline in `analyzeSession` | `coaching/sessionInsights.ts:715-894` |
| 6 | `SessionInsights` → RO/EN report sections and plain text | `buildReport` / `renderReport` | `coaching/reportText.ts:822`, `:908` |
| 7 | *(optional, opt-in)* `SessionInsights` → bounded suggestions + sealed cue evidence | `suggestionsFromInsights`, `cueEvidenceFromInsights` | `coaching/suggestions.ts:521`, `:691` |

Real call sites: `apps/mobile/src/session/analysisViewModel.ts:303-315` (the Analysis screen) and
`apps/mobile/src/session/stintCoaching.ts:170-177` (the between-laps stint runner).

Two structural facts worth internalising:

* **Projection is never reimplemented.** `projectLapSamples` drives the production `TrackMatcher`
  (`coaching/distanceDomain.ts:157`), so offline analysis can never disagree with the distances the
  app displayed while driving.
* **`analyzeSession` is deliberately one synchronous unit** and must stay so: its rankings are
  session-global (the consistency *basis* is chosen across all corners,
  `coaching/sessionInsights.ts:729-755`), so splitting by corner or by lap would produce different
  findings. The chunking that keeps the UI responsive happens *around* the call, never inside it —
  see the note at `apps/mobile/src/session/analysisAssembly.ts:675-682`.

### 1b. A telemetry channel gets from a provider into the analysis

```
  transport (TCP/BLE, apps/mobile)         core                                     analysis
  ──────────────────────────────────  ─────────────────────────────────────  ──────────────────────
  ObdTransport ──► Elm327 session ──►  decodeMode01Response ──┐
                   (createElm327Session)                       │
  ObdTransport ──► ENET/HSFZ session ─► decodeEnetChannelValue ├─► TelemetrySample ─┐
                   (createEnetSession)                          │   {channel,value,  │
  expo-sensors ──► gforceProvider ──────────────────────────────┘    tMonoMs}        │
  (latG/longG/yawRateDps; NOT OBD)                                                   │
                                                                                     ▼
                                                            joinTelemetryChannels ──► CornerLapSample.channels
                                                                                     │
                                                            channelAvailability ─────┤ available / unsupported / missing
                                                                                     ▼
                                                            computeCornerMetrics ──► CornerMetrics (+ its estimator's name)
```

| # | Step | Symbol | Where |
|---|---|---|---|
| 1 | The channel vocabulary — one union, documented PID-by-PID | `TelemetryChannelId` | `telemetry/contracts.ts:2` |
| 2 | Transport interface (no platform code in core) | `ObdTransport` | `telemetry/contracts.ts:57` |
| 3a | ELM327 path: framing → mode-01 request/response | `Elm327ResponseFramer`, `encodeMode01Request`, `decodeMode01Response` | `telemetry/elm327Session.ts:28`, `telemetry/pidCodec.ts:120`, `:145` |
| 3b | ENET path: HSFZ frames → UDS PDUs → per-binding decode | `HsfzFrameParser`, `parseUdsResponse`, `decodeEnetChannelValue` | `telemetry/enet/hsfzCodec.ts:313`, `telemetry/enet/udsCodec.ts:90`, `telemetry/enet/enetChannelSpecs.ts:297` |
| 4 | Both emit the same `{channel, value, tMonoMs}` shape on the same monotonic clock | `TelemetrySample` | `telemetry/contracts.ts:50` |
| 5 | Join onto projected samples by time | `joinTelemetryChannels` | `coaching/distanceDomain.ts:218` |
| 6 | What the lap actually carries — `unsupported` beats `present` | `channelAvailability` | `coaching/cornerMetrics.ts:163` |
| 7 | Estimator selection, best available first, always naming itself | `detectBrake`/`detectLift`/`detectThrottleOn`/`detectTurnIn` | `coaching/cornerMetrics.ts:693`, `:630`, `:751`, `:773` |

Device sensors (`latG`, `longG`, `yawRateDps`) are *not* OBD: they come from `expo-sensors` through
`apps/mobile/src/session/gforceProvider.ts` but are recorded down the identical `TelemetrySample`
path (`telemetry/contracts.ts:38-48`), which is why nothing downstream has to know the difference.
`yawRateDps` is only emitted when the `imuFusionEnabled` setting is on, so pre-P6a recordings and
default installs are byte-identical to before.

---

## 2. Module by module

### 2.0 `coach/` vs `coaching/` — READ THIS FIRST

These are **two unrelated engines** that happen to be spelled alike. Nothing in `coach/` imports
anything from `coaching/`, and nothing in `coaching/` imports anything from `coach/` (verified: the
only cross-reference in either direction is a prose comment).

| | `coach/` | `coaching/` |
|---|---|---|
| Runs | **live, in the car**, once per GNSS fix | **offline**, once per finished session (or per lap boundary in the stint runner) |
| Input | one `TrackMatch` + speed | every lap's projected samples + the corner list |
| Output | 0 or 1 `CoachCue` (`BRAKE` / `CORNER_AHEAD`) | `SessionInsights` → ranked findings → RO/EN prose |
| Size | 2 files, ~21 KB | 9 files, ~265 KB |
| Statefulness | stateful class, per-lap memory | pure functions, no clock, no I/O, no randomness |
| Design doc | `contracts.md` "Coaching addendum" (Phase 3) | `analysis-engine.md` (Phase 5) |
| Entry points | `CoachEngine` (`coach/coach-engine.ts:98`), `deriveBrakingZones` (`coach/derive-braking-zones.ts:248`) | `analyzeSession` (`coaching/sessionInsights.ts:447`) |
| Driven by | `SessionController` (`controller/`) | `apps/mobile/src/session/analysisAssembly.ts` |

**Mnemonic:** `coach/` *talks to you now*; `coaching/` *tells you afterwards what happened.*
They meet only through data: `coaching/suggestions.ts` can move the cue points that `coach/`
fires on, but it does so via `apps/mobile/src/session/stintCoaching.ts`, never by import — and
only on `'surveyed'` geometry, the one output P17 deliberately did not unlock (invariant I3).

### 2.1 `coaching/` — the deterministic analysis engine

Nine files, a strict layering, no cycles:

```
types.ts ──► distanceDomain.ts ──► cornerMetrics.ts ──┐
   │                │                                  ├─► sessionInsights.ts ──┬─► reportText.ts
   │                └──► cleanLap.ts ──────────────────┤                        └─► suggestions.ts
   └──────────────────► envelope.ts ───────────────────┘
```

| File | Owns | Public surface (anchors) |
|---|---|---|
| `types.ts` | The vocabulary: channels, sample shape, metric shape, lap status/label/check enums | `CoachingChannelId:21`, `ANALYSIS_CHANNELS:28`, `GRAVITY_MPS2:45`, `CornerLapSample:52`, `CornerMetrics:110`, `LapStatus:209`, `LapClassification:211` |
| `distanceDomain.ts` | Projection, channel join, the 1 m grid, `t(s)`, `Δt(s)` | `projectLapSamples:146`, `joinTelemetryChannels:218`, `resampleLapToDistanceGrid:564`, `deltaCurveMs:710`, `deltaOverSegmentMs:734`, `TIME_INTEGRATION_DRIFT_TOLERANCE:413` |
| `cornerMetrics.ts` | Per (lap, corner) numbers; window derivation; the estimator cascade | `channelAvailability:163`, `cornerWindows:968`, `computeCornerMetrics:1036` |
| `cleanLap.ts` | Three-valued lap status, yaw/ABS/decel evaluation, per-check coverage | `classifyLap:617`, `ClassifyLapOptions:37` |
| `envelope.ts` | The driver's demonstrated bounds, clean laps only | `buildDemonstratedEnvelope:124`, `ENVELOPE_APPROACH_EXCLUDING_FLAGS:17`, `ENVELOPE_CORNER_EXCLUDING_FLAGS:25` |
| `sessionInsights.ts` | The orchestrator + rankings + `limitations[]` + the geometry-provenance tier | `analyzeSession:447`, `SessionInsights:367`, `LimitationCode:315`, consistency constants `:45-53`, `GeometryProvenance:95`, `geometryProvenanceOf:102`, `resolveGeometryProvenance:119` |
| `reportText.ts` | RO/EN template prose. No placeholders, ever | `buildReport:822`, `renderReport:908`, `pitSuggestionLine:980`, `cueUpdateLine:1010`, `cornerName:266` |
| `suggestions.ts` | The bounded suggestion engine + sealed cue evidence | `computeSuggestions:386`, `suggestionsFromInsights:521`, `BLOCKING_LIMITATION_CODES:563`, `sealCueEvidence:675`, `cueEvidenceFromInsights:691`, `SuggestionScope:182` |

Depends on: `contracts.ts` (`Corner`, `CircuitProfile['geometryStatus']`, `CORNER_ANALYSIS_VERSION`), `geometry/`, `matching/`
(`TrackMatcher`), `profile/` (`RuntimeProfile`), `telemetry/contracts`.
Depended on by: `apps/mobile` (`analysisAssembly`, `analysisViewModel`, `stintCoaching`,
`analysisExport`), and `testloop/syntheticCorners.ts:10` for the gravity constant only.

**Distance-domain in one line each.** Distance `s` is metres from the start/finish line,
always normalised to `[0, totalLengthM)` (`normalizeDistance:47`); every window is wrap-aware
(`forwardDistance:53`, `inDistanceWindow:61`, `windowWraps:73`); `t(s)` is the *integral of
`ds/v`* anchored at the crossing, **not** the measured clock — the measured clock only places the
curve and then validates it (`integrateElapsed`, `distanceDomain.ts:434-525`). That is why
`DistanceGrid` reports `timeIntegrationDriftMs` / `timeIntegrationDriftExceeded`
(`distanceDomain.ts:292-298`) and why `analyzeSession` raises a `TIME_INTEGRATION_DRIFT`
limitation from it (`sessionInsights.ts:855-869`).

**Geometry provenance in one paragraph (P17).** The binary "validated / not validated" is now a
three-valued `GeometryProvenance` — `'surveyed' | 'mapped' | 'learned'` (`sessionInsights.ts:95`),
mapped from the catalog by the single function `geometryProvenanceOf` (`:102-108`: `'official'` →
surveyed, `'ad-hoc'` → learned, everything else → mapped) so the app, the analysis and the tests
cannot disagree. It answers *which claims does this line support*, not *is the line right*: a
**self-referential** claim (your laps against each other, through the same windows) survives a
consistently displaced centreline because every lap moves with it; an **absolute** claim (this is
the circuit's Turn 7, the apex is at 1 290 m) needs a survey (`:57-94`). `'mapped'` and `'learned'`
permit identical claims and differ only in what the report must *say*. `geometryValidated` stays
beside it, required, and `resolveGeometryProvenance` (`:119-126`) can only **narrow**: an omitted
provenance becomes `'surveyed'` iff `geometryValidated`, else `'mapped'`; a stated `'surveyed'`
next to `geometryValidated: false` becomes `'mapped'`. So `'surveyed'` *implies*
`geometryValidated` (`:882-888`, `:904-907`) — but not the converse, see Q11. What each tier
unlocks is invariant I3.

### 2.2 `coach/` — the live cue engine

| File | Owns | Public surface |
|---|---|---|
| `coach-engine.ts` | Cue selection per GNSS match; per-lap "already driven past" guard | `CoachEngine:98`, `DEFAULT_COACH_ENGINE_CONFIG:45` |
| `derive-braking-zones.ts` | One advisory braking zone per corner, from the PB reference lap when usable, else from a decel model | `deriveBrakingZones:248`, `DEFAULT_BRAKING_ZONE_CONFIG:15` |

`onMatch` is deliberately **stateless w.r.t. "already shown"** (`coach-engine.ts:85-97`): as long as
a target stays inside the lead window the cue is re-emitted every call with a fresh
`distanceToTargetM`, so the UI gets a real countdown rather than a one-shot flag. The one piece of
per-lap memory is `completedThisLap`, guarded by `EXIT_JUMP_THRESHOLD_M` (`:25`) — biased toward
*under*-detecting "passed", because a false positive would suppress a corner still being approached.
`deriveBrakingZones` falls back to `physicsZone` (`:220`) whenever the reference profile is missing,
uncovered, or implausible (`:284-291`), and every zone says which it was (`source: 'reference' | 'physics'`).

### 2.3 `corners/` — geometry → corner list

`analyzeCorners` (`corners/analyzeCorners.ts:339`) turns a validated `RuntimeProfile` into
deterministic, start/finish-relative `Corner[]`: curvature profile → threshold → gap fill → merge →
**direction split** (a touching left/right chicane is two corners, not one) → severity band +
advisory speed from a lateral-g bucket. `applyObservedSpeeds` (`corners/observedSpeeds.ts:48`)
overlays real onboard apex speeds, capped at +10 % over the model, and marks each corner
`speedSource: 'model' | 'observed'`. `CORNER_ANALYSIS_VERSION` (`contracts.ts:639`, currently **3**)
exists so anything keyed by corner id revalidates when the corner set changes; the version-bump
rationale is recorded at `contracts.ts:620-638`.

Depended on by: `coaching/` (indirectly, via the corner list the caller supplies), `testloop/syntheticCorners.ts`,
`testloop/codec.ts` (as the recovery path for unreadable stored corners).

### 2.4 `telemetry/` — transports and channel decoding

Four sub-areas, all pure (no sockets; `apps/mobile` supplies `ObdTransport`):

| Area | Owns | Anchor |
|---|---|---|
| `contracts.ts` | `TelemetryChannelId`, `TelemetrySample`, `ObdTransport`, `TelemetrySession<TState>` | `telemetry/contracts.ts:2,50,57,103` |
| `pidCodec.ts` + `elm327Session.ts` | SAE J1979 mode-01 request/response; `>`-delimited framing; poll scheduler | `pidCodec.ts:120,145`; `elm327Session.ts:28,456` |
| `enet/**` | BMW ENET: HSFZ framing, UDS PDUs, per-vehicle DID bindings, discovery, DID sweep/observation, VIN read | `enet/hsfzCodec.ts:313`, `enet/udsCodec.ts:90`, `enet/enetChannelSpecs.ts:297`, `enet/enetSession.ts:989`, `enet/enetDiscovery.ts:230`, `enet/didSweep.ts:276`, `enet/vinRead.ts:92` |
| `signalFinder/**` | The target-driven discovery wizard's pure core: target catalogs, the metronome the driver is paced by, per-DID scoring, run planning, one polling round | `signalFinder/targets.ts:347`, `metronome.ts:97`, `scoring.ts:759`, `plan.ts:160`, `runner.ts:403` |
| `simulatedTransport.ts`, `enet/simulatedEnetTransport.ts` | Deterministic fake vehicles for both transports | `simulatedTransport.ts:61`, `enet/simulatedEnetTransport.ts:111` |

Two channels exist **only** through a Signal-Finder-confirmed per-vehicle binding, because no
standard mode-01 PID exists for either: `brakeSwitch` and `brakePct`
(`telemetry/contracts.ts:20-33`). That is the whole reason `signalFinder/` is in core rather than
in the app. `scoring.ts`'s header (`telemetry/signalFinder/scoring.ts:1-65`) is the single best
explanation of why a DID that *moves* is not the same as a DID that *answers the driver*.

**`runFinderRound`'s cooldown sleep is a loop, not one timer** (`signalFinder/runner.ts:577-594`,
commit `8c495b6`). When every entry is backed off, the round sleeps to the next evidence-window
boundary instead of ending (Y3: a back-off is a cooldown for the *current* window). The sleep is a
`setTimeout`, the round's clock is `input.clock.now()` (`Date.now()` in production), and the two are
separate clocks — a timer can fire a millisecond early (22 of 400 wake-ups locally). The old single
`await` then saw `now < boundary`, took that as "the duration ran out" (`:592`), and ended the round
in its first cooldown window, so a DID that recovered moments later scored `insufficient`. Now it
keeps sleeping (≥ 1 ms per iteration) until the clock reaches `min(boundary, endAtMs)` or
`control.stopped` is set; only then does the existing `now < boundary → break` decide. Pinned by
`test/telemetry/signalFinder/runner.test.ts:397` (a clock running 2 % slow, so every wake-up is
early). See Q12 for what the loop does *not* bound.

### 2.5 `signal/` and `fusion/` — DSP and attitude

* `signal/savitzky-golay.ts` — a least-squares polynomial fit over a sliding window.
  `savitzkyGolay:336`, `savitzkyGolayCoefficients:319`, `MAX_SAVITZKY_GOLAY_POLY_ORDER:68`.
  Chosen over a moving average because the braking spike and the apex minimum *are* the signal
  (`:1-16`). Written natively rather than taken as a dependency (dormant packages).
  Only production consumer: G-force channel smoothing on the analysis read path
  (`apps/mobile/src/session/analysisAssembly.ts`, `{windowLength: 9, polyOrder: 2}`).
* `fusion/madgwick.ts` — 6-axis gradient-descent attitude filter. `MadgwickAhrs:83`,
  `DEFAULT_MADGWICK_CONFIG:60` (`beta: 0.1`). `gravity()` (`:225`) is the interesting method:
  subtract it and you have the vehicle's own linear acceleration. Its doc comment (`:203-224`)
  is load-bearing — see invariant I5.

### 2.6 `reference/` — personal best and live delta

| File | Owns | Anchor |
|---|---|---|
| `build-reference-lap.ts` | A completed lap → a `ReferenceLap` on a 10 m grid, with provenance; ≥95 % grid coverage required | `buildReferenceLap:176`, `ReferenceLapBuildError:42` |
| `personal-best.ts` | The PB replacement *rule* (valid, good/degraded, not pit transit, complete ordered sectors, full grid, strictly faster, same layout) | `shouldReplacePb:110` |
| `live-delta-engine.ts` | Live `Δt` vs the stored reference, with deadband, smoothing, sparse/stale gap handling | `LiveDeltaEngine:137`, `referenceCompleteness:58`, `referenceElapsedAt:102` |

The build path returns a **result union, never a throw** (`BuildReferenceLapResult:50`), so a lap
that cannot be a reference is a named outcome the caller reports rather than an exception it swallows.

### 2.7 `replay/` and `fixtures/` — deterministic drives

`replay/replay-harness.ts` batch-drives a fixture through **the production pipeline**, not a copy of
it: `runSessionPipeline:97` composes `SessionPipelineCore` (`controller/pipelineCore.ts`), which is
the exact same per-sample processing `SessionController` runs live (`replay-harness.ts:90-96`).
`runCalibration:80` does the same for the Learn lap.

`fixtures/` generates the drives: `SeededPrng` (`fixtures/prng.ts:2`, a 32-bit LCG with a
Box–Muller gaussian), `driveLap` (`fixtures/drive-lap.ts:126`) which synthesises a GNSS trace along
a real circuit profile, and 15 named scenarios (`fixtures/scenarios.ts:30-363`) each carrying its own
`expectedOutcome` string as fixture metadata. `motorpark-scenarios.ts` are fixed-seed (9_1xx)
wrappers so the second circuit is exercised identically. See §5.4 for why this is not test-only code.

### 2.8 `testloop/` — learning a circuit from lap 1 (Phase 5d)

| File | Owns | Anchor |
|---|---|---|
| `config.ts` | Every tunable, in one frozen object. **Street numbers, not circuit numbers** | `DEFAULT_TEST_LOOP_CONFIG:102`, `MAX_TEST_LOOP_CORNERS:100`, `resolveTestLoopConfig:137` |
| `loopClosure.ts` | "Has the driver come back to where they started, going the way they left?" — three conditions + a quality gate + a stateful run | `detectLoopClosure:289`, `evaluateLoopClosure:303`, `qualifyTrack:202`, `qualifiedLapSamples:242` |
| `centreline.ts` | Lap 1's trace → resampled, lightly smoothed, closed ENU centreline; self-overlap fraction | `buildLoopCentreline:123`, `overlapFractionOf:211` |
| `syntheticCorners.ts` | Corners from **two witnesses**: curvature geometry AND the driver's own speed drops | `deriveTestLoopCorners:430`, `findSpeedDropWindows:271` |
| `testLoopCircuit.ts` | The learned loop as a validated `CircuitProfile` + `RuntimeProfile` | `buildTestLoopCircuit:121`, `TEST_LOOP_GEOMETRY_STATUS:34`, `isLearnedGeometry:40` |
| `codec.ts` | The on-disk envelope, zod-validated on the way back in | `encodeLearnedCircuit:81`, `decodeLearnedCircuit:92`, `LEARNED_CIRCUIT_ENVELOPE_VERSION:27` |

The whole module's honesty hinges on two constructions, both in `testLoopCircuit.ts:18-30`:
`geometryStatus` is written as the constant `'ad-hoc'` and is **never taken from a caller**, and the
built profile is pushed through the same `validateProfile` the bundled assets go through, so an
unusable learned loop is a *named failure*, not a half-built circuit handed to the timing pipeline.
The smoothing is deliberately light (25 m window over 5 m steps, `centreline.ts:17-20`) because a
heavier filter would cut the corners the mode exists to find.

### 2.9 `persistence/` — the storage semantics

| File | Owns | Anchor |
|---|---|---|
| `inMemorySessionRepository.ts` | The **semantic reference implementation** of `LocalSessionRepository`; deep-copy reads, promise-based even over a Map | `InMemorySessionRepository:48` |
| `checkpointCodec.ts` | The checkpoint wire envelope + what "newer" means | `CheckpointCodec:92`, `checkpointGeneration:41`, `checkpointSupersedes:56`, `CHECKPOINT_SCHEMA_VERSION:4` |
| `lapVerdict.ts` | The owner's verdict on the app's verdict; the *one* definition of "unanswered" | `recordLapVerdict:39`, `unansweredLapVerdict:57`, `mergeLapValidityVerdicts:85`, `summarizeLapVerdicts:109` |
| `referenceLap.ts` | Structural validation before a PB is stored | `validateReferenceLap:6` |
| `jsonSerializable.ts` | Guard: reject anything that will not round-trip **before** any I/O begins | `assertJsonSerializable:6` |
| `deleteUserData.ts` | Delete, then **verify empty**, so no success banner fires over a partial wipe | `deleteAllUserData:25` |

`CHECKPOINT_SCHEMA_VERSION` (the *JSON payload* shape) is independent of `SQL_SCHEMA_VERSION` (the
*table* shapes) — stated at `persistence-sql/schema.ts:1-5`.

### 2.10 `persistence-sql/` — SQLite implementation

| File | Owns | Anchor |
|---|---|---|
| `sqlDatabase.ts` | The minimal async DB interface core is written against (satisfied by expo-sqlite and by sql.js) | `SqlDatabase:29` |
| `schema.ts` | Versioned DDL. Version **6** | `SQL_SCHEMA_VERSION:56`, `SQL_DDL:64`, `SQL_DDL_V2:120`, `SQL_ALTERS_V3:137`, `SQL_ALTERS_V4:150`, `SQL_DDL_V5:176`, `SQL_ALTERS_V6:161` |
| `sqlSessionRepository.ts` | The adapter. Must match `InMemorySessionRepository` exactly | `SqlSessionRepository:138`, `migrate:153`, `saveLapCommit:287` |

See §3 for the data model in full.

---

## 3. The data model and its migrations

### 3.1 Tables

All payload columns are JSON TEXT; parsing on every read is what gives deep-copy semantics for free
(`sqlSessionRepository.ts:133-137`).

| Table | Key | Written by | Read by | Added in |
|---|---|---|---|---|
| `schema_migrations` | (none) | `migrate` (`sqlSessionRepository.ts:209,215`) | `migrate` (`:203`) | v1 |
| `sessions` | `sessionId` | `saveSession` (`:328`) | `listSessions` (`:384`), `deleteUserData` | v1; columns added v3, v6 |
| `laps` | `(sessionId, lapNumber)` | `saveSession` — full delete-and-reinsert per session (`:357-364`) | `listSessions` (`:396`, via `parsePayloads` since P16 C1) | v1 |
| `checkpoints` | `sessionId` | `saveCheckpoint` (`:231`, always replaces), `saveLapCommit` (`:306`, **conditional**) | `loadCheckpoint` (`:316`) | v1; `lapCount` added v4 |
| `telemetry` | `(sessionId, lapNumber)` | `saveTelemetry` (`:430`), `saveTelemetryBatch` (`:446`), `saveLapCommit` (`:300`) | `loadTelemetry` (`:464`); raw-trace chunk reader in `controller/` | v1 |
| `reference_laps` | `(userId, circuitId, layoutId, layoutVersion)` | `putReferenceLap` (`:564`, DELETE+INSERT in one transaction) | `getReferenceLap` (`:541`) | v1 |
| `settings` | `key` | `apps/mobile/src/persistence/sqlSettingsStore.ts` (**not** part of the core contract) | same | **v2** |
| `lap_verdicts` | `(sessionId, lapNumber)` | `saveLapValidityVerdict` (`:485`) | `listLapValidityVerdicts{,WithDiagnostics}` (`:498`,`:507`) | **v5** |
| `calibration_attempts` | `attemptId` | `saveCalibrationAttempt` (`:518`) | `listCalibrationAttempts{,WithDiagnostics}` (`:526`,`:531`) | **v5** |

`telemetry` is doing double duty and this is the single most surprising thing in the schema: rows at
a **non-negative** `lapNumber` are a completed lap's fixes; rows at a **negative** `lapNumber` are
raw-trace chunks owned by no lap. See invariant I1.

Two indexes: `idx_sessions_user_circuit` (`schema.ts:82`) and
`idx_calibration_attempts_session` (`schema.ts:191`).

### 3.2 Columns added by ALTER rather than CREATE

`CREATE TABLE IF NOT EXISTS` cannot add a column to a table it did not create, and SQLite has no
`ADD COLUMN IF NOT EXISTS`. So four columns exist in **both** places — in `SQL_DDL`'s CREATE (for a
fresh database) and in an ALTER list (for an existing one):

| Column | Table | Version | ALTER list | Nullable means |
|---|---|---|---|---|
| `calibrationStatus` | `sessions` | v3 | `SQL_ALTERS_V3:138` | `'unknown'` — never `'validated'` |
| `traceUnwritten` | `sessions` | v3 | `SQL_ALTERS_V3:139` | unknown |
| `traceFailedWrites` | `sessions` | v3 | `SQL_ALTERS_V3:140` | unknown |
| `lapCount` | `checkpoints` | v4 | `SQL_ALTERS_V4:150` | generation unknown → treated as `-1` → superseded by anything |
| `traceFinalized` | `sessions` | v6 | `SQL_ALTERS_V6:161` | UNKNOWN — never "finalised" |

### 3.3 How migration actually runs

`SqlSessionRepository.migrate()` (`sqlSessionRepository.ts:153-217`) does the same thing on **every**
open, in this order:

1. `PRAGMA journal_mode = WAL` in a `try/catch` — sql.js has no VFS and throws; that failure is
   expected and ignored (`:158-162`).
2. `SQL_DDL`, then `SQL_DDL_V2`, then `SQL_DDL_V5` — all `CREATE … IF NOT EXISTS`, all unconditional.
3. `SQL_ALTERS_V3`, `SQL_ALTERS_V4`, `SQL_ALTERS_V6` — **each statement on its own, each failure
   caught and ignored**. "Duplicate column name" is the expected failure.
4. Read `schema_migrations`. `0` → INSERT the current version. `< SQL_SCHEMA_VERSION` → UPDATE it.
   Nothing else is touched.

**Why the ALTERs are written to tolerate repetition.** Not for tidiness — for crash safety. If a
build bumped `schema_migrations` and then died before its ALTER landed, a version-gated migration
would never run that ALTER again and the column would be missing forever. Applying them
unconditionally on every open makes the recorded version an *observation* rather than a
*precondition*, so the schema converges regardless of where a previous run was interrupted. The
reasoning is written out at `schema.ts:127-136` and re-stated for each later ALTER list.

**What a device upgrading from an older version sees.** Nothing dramatic, by design:

* **v1 → 6**: gets `settings`, `lap_verdicts`, `calibration_attempts` created; gets all five
  ALTER'd columns added, every one of them NULL; existing rows in every other table are untouched.
  Pinned by "upgrades a pre-P10A (v2-shaped) sessions table in place, keeping its rows and reading
  them as unknown provenance" (`test/persistence-sql/sqlSessionRepository.contract.test.ts:77`).
* **Every NULL reads as *unknown*, never as the good value.** `decodeCalibrationStatus`
  (`sqlSessionRepository.ts:49`) maps anything unrecognised to `'unknown'`; `traceFinalized` NULL is
  left **absent** from the returned object rather than becoming `false` (`:422`). Stated as binding
  at `schema.ts:152-160`: "a session whose recording nobody can vouch for must not be able to present
  itself afterwards as one that finished cleanly."
* **v5 tables are purely additive** — nothing existing reads or writes them (`schema.ts:46-47`), so
  a database that predates them upgrades simply by having them created.
* **There is no downgrade path.** A newer database opened by an older build keeps its higher
  `schema_migrations` value and its extra columns; the older code just never selects them.

Migration idempotence is pinned by `test/persistence-sql/sqlSessionRepository.contract.test.ts:44`,
which opens the same underlying store twice and asserts both that nothing throws and that
previously-written data survives untouched.

---

## 4. The invariants, and what breaks if you violate them

### I1 — Raw GNSS chunks live at a negative `lapNumber`, and a completed lap "reclaims" them

**Rule.** While driving, the controller flushes captured fixes into `telemetry` rows keyed by a
*negative* `lapNumber`. When a lap completes, its own row is written at its real (positive) lap
number **and the chunk rows are rewritten with the samples in `tStart..tEnd` removed** — that is
"reclaim". Samples belonging to no lap (out-lap, cool-down, pit) deliberately stay in the chunks.

**Keys.** `-(runBase * STRIDE + sequence)`, `TRACE_CHUNK_KEY_STRIDE = 10_000`
(`controller/sessionController.ts:426`), `runBase` = milliseconds since `TRACE_KEY_EPOCH_MS`
(`:451`). Flush cadence: 25 samples or 1 000 ms, whichever first (`:390`, `:406`).

**Why negative.** It makes chunk rows *unreachable through the ordinary contract*: no reader that
asks for a real lap number can ever see one (pinned: `test/controller/sessionControllerRawTrace.test.ts:280`).

**Why banded by start instant.** A session id can legally be driven twice — ADR-0003 §3 recovery
resumes the *same* id in a new process — and a plain `-1, -2, -3…` sequence would overwrite the
pre-crash trace, i.e. exactly the data the resume exists to protect. A read-back probe could not
help: `loadTelemetry` returns `[]` for both "no row" and "row emptied by reclaim"
(`sessionController.ts:409-424`). Pinned: `sessionControllerRawTrace.test.ts:324`.

**Why reclaim instead of not-writing.** Durability first: a force-quit must lose at most one flush
interval. Double-ownership is then removed afterwards rather than prevented by withholding the write
(`sessionController.ts:380-389`).

**What breaks if violated.** The lap row and the chunk both hold the same fixes and the raw export
reports one drive twice — which is why `saveTelemetryBatch` must be atomic
(`contracts.ts:534-549`, `sqlSessionRepository.ts:441-462`). In the other direction, if the lap row
commits and the checkpoint does not, the resumed run re-allocates the same lap number and *replaces*
the row; the P10B reviewer measured that at **93 lost fixes**
(`sqlSessionRepository.ts:242-258`). Hence `saveLapCommit`.

### I2 — `'empty'` must never be produced where `'unavailable'` is true

**Rule.** Every part of a session report declares one of four states — `'present'`, `'empty'`,
`'unavailable'`, `'failed'` (`apps/mobile/src/session/sessionReport.ts:75`). `'empty'` means *we
read it and there genuinely was nothing*. `'unavailable'` means *this device cannot answer*.
`'failed'` means *a read was attempted and threw*. Collapsing any of these into `'empty'` turns "we
could not look" into "we looked and there was nothing" — the exact ambiguity the whole reporting
ticket exists to remove (`sessionReport.ts:61-74`).

**Where it is enforced.** The `note()` helper (`sessionReport.ts:252-267`) is the single decision
point: a recorded failure → `'failed'`; a `null` input → `'unavailable'`; an array → `'empty'` or
`'present'` by length. The inputs are typed to carry the distinction: `calibrationAttempts` and
`lapVerdicts` are `readonly T[] | null`, and the doc says so (`sessionReport.ts:230-233`).

**The core-side half.** `StoredRecordRead<T>` (`contracts.ts:523-528`) carries `unreadableCount`
alongside `records`, and `parsePayloads` (`sqlSessionRepository.ts:71-82`) counts the rows it
skipped. The skip is the right trade (one corrupt answer must not cost the rest); **the silence was
not** — the pre-P14 version returned survivors and told nobody, so a table of unreadable rows came
back as `[]` and read as `'empty'`.

**What breaks if violated.** An export says "the owner never judged these laps" about laps whose
verdict rows are sitting on disk unreadable. Pinned:
`apps/mobile/test/session/sessionReport.test.ts:309-336`,
`sessionReportP14.test.ts:195-223`, and `sessionReportP15Prose.test.ts:119-300` (which pins the
*prose*, both directions: a failed section never reads as "nothing was there", and a genuinely empty
one still does).

**Sibling invariant.** `LapStatus` is three-valued for the same reason (`coaching/types.ts:202-209`):
`'unverified'` is the honest middle — no anomaly found, but a required check could not run, so the
lap is **not** established as clean and never feeds the reference or the envelope.

### I3 — Geometry provenance decides how far the engine may go: pit advice on any *stated* line, live cues only on `'official'`

**Rule (P17, replacing the binary gate).** `geometryStatus` is one of
`'official' | 'community-derived' | 'dev-only' | 'ad-hoc'` (`contracts.ts:57`), mapped to a
`GeometryProvenance` tier by `geometryProvenanceOf` (`coaching/sessionInsights.ts:102-108`; see the
§2.1 paragraph). The app states **both** facts from the catalog:
`geometryValidated: geometryStatus === 'official'` and `geometryProvenance: geometryProvenanceOf(…)`
(`apps/mobile/src/session/analysisAssembly.ts:552`, `:557`). `computeSuggestions` then resolves what
the input *established* (`statedGeometry`, `coaching/suggestions.ts:279-287`) and gates in three steps
(`:395-398`):

| Input states | `gate` | `scope` (`SuggestionScope`, `suggestions.ts:182`) | Pit suggestions | Cue moves |
|---|---|---|---|---|
| nothing (no `geometry`, `geometryValidated !== true`) | `'geometry-unvalidated'` | `'closed'` | none | none |
| `'mapped'` or `'learned'` (or `'surveyed'` beside an explicit `geometryValidated: false`, narrowed to `'mapped'`) | `'open'` | `'self-referential'` | yes, bounded by the envelope as before | none — every cued corner recorded in `skipped` as `'geometry-self-referential'` (`:425-428`) |
| `'surveyed'`, or `geometryValidated: true` with no `geometry` | `'open'` | `'surveyed'` | yes | yes |

The opt-in gate (`enabled`) and `insufficient-clean-laps` still come first/after exactly as before;
`suggestionsFromInsights` passes `insights.geometryProvenance` so the analysis is the one source of
truth (`:537-540`). **P16 C2 survives**: silence is still not a licence — the unlock needs an explicit
statement, which only a caller holding the profile can make.

**Defence in depth, unchanged in strength (for every input the app produces — see Q11).**
`cueEvidenceFromInsights` was deliberately *not* widened:
it still keys on `insights.geometryValidated` alone and seals an **empty** evidence set otherwise
(`suggestions.ts:697-707`), so a caller that skipped `computeSuggestions` still has nothing the cue
source will accept. `cueUpdateLine` names its corner unqualified *because* a `CueUpdate` can only exist
on surveyed scope (`reportText.ts:1012-1015`).

**What the report says per tier.** On anything but `'surveyed'`, `analyzeSession` raises
`GEOMETRY_UNVALIDATED` carrying `geometry: 'mapped' | 'learned'` (`sessionInsights.ts:882-888`,
field at `:346-353`), and the prose (`reportText.ts`) states where the line came from, that the corner
numbers and positions are the app's, and that comparisons between the driver's own laps are unaffected
(`geometryLimitation`, `:339`/`:389`; a pre-P17 limitation without `geometry` reads as `'mapped'`,
`:576-583`). Every place a corner is *named* — headings, ranked time-loss and consistency lines, pit
suggestions — goes through `cornerName` (`:266-273`) and gets "(our numbering)" /
"(numerotarea noastră)"; positions read "on the line we traced" / "learned from your own lap"
(`cornerPosition`, `:316`/`:366`); each corner ends with `cornerGeometryNote` (`:807-809`).
`pitSuggestionLine` takes the tier as a third argument, **defaulting to `'surveyed'`** (`:980-984`);
real callers pass `insights.geometryProvenance` (`apps/mobile/src/session/pitViewModel.ts:201`,
`analysisExport.ts:603`).

**Why the line falls there.** Every suggestion is self-referential: bounded by the driver's own best
clean lap, compared against the median of their own clean laps, through the same `cornerWindows` on
the same centreline. A displaced centreline moves every lap identically, so the difference cancels —
only the window's *name* is wrong. What a survey buys is the absolute claims: corner numbering,
absolute positions, advisory speeds. A pit suggestion is read stationary and hands over its evidence
in the same sentence; a cue is a bare imperative the app *acts on in the world*, at speed, and depends
on the distance→position round-trip at that exact spot being right — which is precisely what an
unsurveyed line has never had checked (`suggestions.ts:158-181`). This is still safety-contract rule 5
(ticket P5c-FIX1 E4), now graduated.

**Proven rather than argued.** `test/coaching/geometryTiers.test.ts:128-267` runs the whole MotorPark
analysis twice, the second time with the distance origin displaced 137 m: per-corner measurements,
rankings, clean laps and suggestions come back equal (`INVARIANCE_TOLERANCE = 1e-6`, `:79`),
the rendered pit-suggestion sentences identical (`:227-229`), while apex distances move by exactly 137 m (`:232`).

**What breaks if violated.** Widen the cue path and the app speaks "brake" at a point in the world it
has never had checked. Narrow the pit path back and the engine is dead on every shipped circuit (both
are `'community-derived'`) and every learned one — the state P17 existed to end. Drop the naming
qualifier and the report claims the app's "Corner 7" is the circuit's Turn 7. Pinned on **real catalog
geometry, both circuits**: `test/coaching/suggestionsHonesty.test.ts:59-166` — MotorPark: gate open,
`scope: 'self-referential'`, pit suggestions produced, zero cue updates, every skip
`'geometry-self-referential'` (`:72`), empty sealed evidence (`:136`); a caller stating no provenance
still gets a closed gate (`:109`); a contradictory `'surveyed'` cannot talk it open (`:123`);
Transilvania Motor Ring, same session and engine, produces suggestions with the gate open (`:149`).
Careful with that last one: the test harness *loads TMR as validated* (`load('transilvania-motor-ring.v2.json', true)`,
`test/coaching/circuits.ts:45`), but the shipped asset says `"geometryStatus": "community-derived"`,
as does MotorPark's. In production **no circuit is `'surveyed'` today**, so live cue moves are
unreachable for every user until a track is surveyed — by design, not by accident. The per-tier prose
is pinned at `geometryTiers.test.ts:269-357` and `circuits.analysis.test.ts`.

**Related:** `testloop/testLoopCircuit.ts:34` hard-codes `'ad-hoc'` for every learned circuit, so a
learned loop is `'learned'` by construction: pit suggestions yes, cue moves never, and the report says
the line is the driver's own lap (`geometryTiers.test.ts:330`).

### I4 — Savitzky–Golay `polyOrder` is capped at 7, and the bound is measured

**Rule.** `MAX_SAVITZKY_GOLAY_POLY_ORDER = 7` (`signal/savitzky-golay.ts:68`); anything higher is
**refused** with a `RangeError` (`:125-131`).

**The measurement behind it.** The design matrix is the *raw* Vandermonde of the centred window
(`A[j][k] = (j − halfWindow)^k`) and the fit is solved through the **normal equations**
`(AᵀA)⁻¹Aᵀ`, which squares an already badly scaled matrix. Partial pivoting reorders a system; it
does not rescale one. The worst absolute error in reproducing each monomial of degree ≤ `polyOrder`,
swept over every odd `windowLength` from 3 to 101 and every edge offset:

| order | error | order | error | order | error |
|---|---|---|---|---|---|
| 0 | 2.2e-15 | 4 | 5.0e-13 | 8 | **9.0e-9** |
| 1 | 3.1e-15 | 5 | 4.2e-12 | 9 | 2.5e-8 |
| 2 | 1.4e-14 | 6 | 3.5e-11 | 10 | 1.4e-6 |
| 3 | 2.8e-14 | 7 | 7.1e-10 | 11 | 4.7e-6 |

The library's tolerance is 1e-9 absolute. Order 7 is the last order inside it; order 8 is already
nine times past it. The triggering observation: smoothing 25 constant samples with
`{windowLength: 25, polyOrder: 20}` returned **0.9737744** at both endpoints instead of 1 — silently.

**Why refuse rather than re-derive in an orthogonal basis.** Re-deriving would change, however
slightly, every number a currently-valid configuration produces, and those numbers are read by a
shipped, field-confirmed analysis. A validation gate changes none of them. The shipped
configuration is `{windowLength: 9, polyOrder: 2}`, measured error 1.4e-14.

**What breaks if violated.** A plausible-looking wrong number with no error anywhere.
Pinned: `test/signal/savitzkyGolayConditioning.test.ts:24` (the exact reviewer scenario now throws),
`:32` (order 7 accepted, order 8 refused), `:43` (everything inside the bound reproduces its own
polynomials to better than 1e-9), `:74` (the shipped config is unaffected).

### I5 — Madgwick here is 6-axis, with no magnetometer, and `yawRad` is not a heading

**Rule.** `MadgwickAhrs` implements the IMU (gyro + accelerometer) form only
(`fusion/madgwick.ts:1-25`). Roll and pitch are observable and trustworthy; **yaw is dead-reckoned
from the gyro and drifts**. `yawRad` must never be treated as a compass heading (`:185-187`).

**Why.** A phone inside a steel car body sits in a badly distorted magnetic field, and on track there
is already a better heading source in GNSS course-over-ground. Feeding a distorted magnetometer into
the filter would corrupt roll and pitch too — so the fix would be worse than the problem.
(Secondary reason for writing it natively: the candidate npm package ships contradictory licence
metadata, Apache-2.0 in LICENSE and APSL-2.0 in package.json.)

**The trap.** `gravity()` returns the estimated vertical **in sensor coordinates**, and the filter
has no opinion about which way is up — it drives that vector toward whatever the normalised
accelerometer reads. The two platforms disagree: Android's `TYPE_ACCELEROMETER` reads +1 g along the
skyward axis (vector points **up**); iOS Core Motion reads z = −1 face-up (vector points **down**),
and expo-sensors does not reconcile them (`fusion/madgwick.ts:203-224`).

**What breaks if violated.** A caller that assumes a direction when projecting the gyro onto this
vector to build a mount-independent yaw axis gets **every measured rotation silently reversed**. The
consumer that must get this right is `apps/mobile/src/session/gforceProvider.ts`. (Note the
subtraction `raw − gravity·g` to isolate linear acceleration is unaffected by the convention.)
Pinned: `test/fusion/madgwick.test.ts:89` (gravity matches the accelerometer it settled on),
`:103` (constant yaw rate integrates when no gravity reference is supplied), `:114` (yaw is
untouched by the accelerometer correction).

### I6 — A held (state) channel is resampled by zero-order hold, never interpolated

**Rule.** `STEP_HELD_CHANNELS = {brakeSwitch}` (`coaching/cornerMetrics.ts:329`). On the metre grid
these take the last *observed* sample (`:397-406`), not a linear blend.

**Why.** A brake switch reads 0 or 100 and nothing between; there is no "half pressed". Interpolating
invented a ramp across the sampling interval, and `detectBrake`'s 5 % threshold then fired ~5 % into
that ramp: with an ECU answering at 1 Hz at 40 m/s, **an onset up to ~38 m before the pedal was ever
observed pressed** — and that number then fed the demonstrated *latest-brake safety bound*.

**What remains is honest ignorance, and it is reported.** `brakeOnsetUncertaintyM`
(`coaching/types.ts:130`, computed at `cornerMetrics.ts:1136-1139`) is the distance covered over one
sampling interval of the source channel — non-null only for a held channel, `null` for a continuously
sampled pressure channel which is already at grid resolution. The envelope then takes the
**pessimistic edge** for the safety bound only: `latestBrakeStartM` uses
`brakeStartM + uncertainty` (`envelope.ts:166-169`), i.e. further from the corner = braking earlier.
Every other statistic keeps the measured value.

**What breaks if violated.** The app tells a driver they have already braked 38 m later than they
ever did.

### I7 — Only clean laps feed the reference and the demonstrated envelope

**Rule.** Safety-contract rule 2. `buildDemonstratedEnvelope` takes `CleanLapMetrics[]`
(`envelope.ts:124`) and `analyzeSession` feeds it only `lapInsights.filter(lap => lap.clean)`
(`sessionInsights.ts:498-501`). A lap that is `'unverified'` counts as not-clean.

**Plus a second filter inside the envelope**: per-corner quality flags exclude a lap's numbers even
from a clean lap — `ENVELOPE_APPROACH_EXCLUDING_FLAGS` (`envelope.ts:17`) for brake/lift/decel and
`ENVELOPE_CORNER_EXCLUDING_FLAGS` (`:25`) for in-corner speeds. A truncated window or a poor-GNSS
window cannot become a bound.

**What "clean" means, post-REVISION-2.** Anomalous *only* for `'incomplete' | 'offTrack' | 'gnssPoor'`
(`coaching/types.ts:189`). Heavy braking, ABS-like oscillation and a yaw/slide excursion are **normal
circuit driving** and became informative `LapLabel`s instead (`types.ts:197`,
`cleanLap.ts:772-794`). The measurement that forced the change: the user recorded 1.3 g lateral in a
GR86, and cars reach 1.3–1.5 g longitudinal on a circuit, so the old thresholds excluded good laps.
Pinned: `test/coaching/cleanLap.test.ts:137` ("is clean at 1.3 g (GR86 field fact)…") and `:151`
("never puts yawSpike or decelSpike in reasons any more").

**What breaks if violated.** The demonstrated envelope — the ceiling on every suggestion — is built
from a lap that went off track or was recorded through a 40 m fix. "Brake later than you ever have"
stops being impossible by construction.

### I8 — The checkpoint only ever moves forward, and the comparison is one statement

**Rule.** A checkpoint's *generation* is `laps.length` and nothing else (`checkpointGeneration`,
`persistence/checkpointCodec.ts:41`); `checkpointSupersedes` requires **strictly greater**, and
treats a missing or undecodable stored checkpoint as always superseded (`:56-62`).

**Why the lap count.** Not a timestamp (two writes in one millisecond are indistinguishable, and a
monotonic clock does not survive a relaunch) and not a writer-supplied counter (a retry replays
whatever it captured, so its counter is exactly as stale as the rest of it). The lap list is the one
part of a checkpoint derived from *committed work* that can only grow — `restoreFromCheckpoint`
rehydrates it, so the count does not reset across a relaunch either (`checkpointCodec.ts:19-40`).

**Why one statement.** `saveLapCommit` writes the checkpoint as a conditional UPSERT whose `WHERE`
SQLite evaluates as part of the same write (`sqlSessionRepository.ts:306-311`), not a SELECT followed
by an INSERT sharing the transaction. Two statements would put a second `await` point inside the
`BEGIN..COMMIT` span, and any write that interleaves there lands between the read and the write that
trusted it. `COALESCE(checkpoints.lapCount, -1)` is the legacy row.

**What breaks if violated.** The failure the P11 reviewer reproduced: lap 1's commit fails, lap 2
commits (checkpoint at `[1,2]`), the retained lap-1 commit retries 2 s later and replaces it with
`[1]`; a restart then re-makes the completed lap 2 as a zero-duration `RECOVERY` lap, **with its 927
fixes still on disk and nothing pointing at them** (`sqlSessionRepository.ts:259-285`).

**Asymmetry worth knowing:** `saveCheckpoint` (`:231`) *always* replaces — it is the authoritative
write, whose callers pass the session's live lap list. `saveLapCommit` is the one that is guarded.

### I9 — Nothing fabricates a channel value, and every metric names its estimator

**Rule.** Stated three times in three files and enforced structurally: `joinTelemetryChannels` never
interpolates forward and simply omits a stale channel (`distanceDomain.ts:211-217`);
`resampleLapToDistanceGrid` marks grid points outside the sampled range or inside a gap wider than
`maxBridgeM` as `null` with `covered[k] === false` (`:559-563`); `CornerMetrics` has **no "0 means
missing"** — every field is a real measurement or `null` (`types.ts:104-109`); and every estimated
quantity carries its source (`liftSource`, `brakeSource`, `throttleOnSource`, `turnInSource`,
`maxLatGSource`).

**The estimator cascade is a preference order, not a fallback-on-failure order.** `detectBrake`
(`cornerMetrics.ts:693`) tries `brakePct` (pressure — says how *hard*), then `brakeSwitch` (says
*whether*, but its edge is the best onset available: it fires when the pedal moves, before the car
has slowed enough for the IMU or GPS to notice), then `longG`, then the GPS speed derivative. The IMU
branch has a cross-check that is easy to miss: a sustained negative longitudinal g is only accepted
as braking if the speed actually dropped by ≥ `BRAKE_SPEED_DROP_KPH` over the sustain window, because
**a tilted phone in a cradle reads a steady negative longitudinal g while the GPS speed does not
move at all** (`:106`, `:722-732`). A *missing* speed is not a confirmation — the IMU estimator stands
down and the speed-derivative estimator gets its turn.

**"Sustained" is always a duration, never a sample count** (`firstSustained`, `cornerMetrics.ts:560`),
so no answer changes with the sample rate.

**What breaks if violated.** The report compares a measured lap against a fallback-estimated one and
presents the difference as driving.

### I10 — Every window is wrap-aware, and a corner that straddles start/finish is one pass

**Rule.** Distance arithmetic goes through `normalizeDistance` / `forwardDistance` /
`inDistanceWindow` / `windowWraps` (`distanceDomain.ts:47-75`) — never bare subtraction.

**The subtle part.** A corner straddling start/finish is recorded as the *end* of the series (its
entry half) and the *start* (its exit half). `buildWindow` joins those two runs
(`cornerMetrics.ts:473-496`) — otherwise every such corner is permanently "truncated" and drops out
of the envelope. But the join is **virtual**: the entries either side of it are a lap apart, so the
seam is excluded from every time and distance computation — `firstSustained` breaks at it
(`:576-578`), `runDurationMs` skips it (`:1021`), the steering derivative restarts after it
(`:1219-1227`), and full-throttle distance does not count it (`:1289-1292`).

**The delta-curve half.** `deltaOverSegmentMs` (`distanceDomain.ts:734`) treats a wrapping segment as
**two stretches summed**, not as `delta[end] − delta[start]`. Subtracting across the line would
report a slower-everywhere lap as having *gained almost a full lap's delta* on that sector
(`:721-733`). Both terms only mean anything because each grid's `t(s)` is anchored at its own
start/finish crossing — which is what `chooseAnchorDu` (`:534`) exists for.

**What breaks if violated.** Sector 1 of every circuit reads nonsense, and the corner nearest the
line silently never appears in the envelope.

---

## 5. Things that will surprise someone

### 5.1 Some repository methods are optional — and which ones, tells you something

`LocalSessionRepository` (`contracts.ts:529-626`) has six optional methods. The pattern is
deliberate: **a method is optional when a store that cannot offer it still has a correct, safe
fallback, and the absence is itself reportable.**

| Method | Optional because | Fallback when absent |
|---|---|---|
| `saveLapCommit` (`:583`) | not every store can do a cross-table transaction | `SessionController` writes the **checkpoint first**, telemetry second — the safe order: a checkpoint naming a lap whose telemetry never landed merely reserves the lap number (fixes are still in the chunks), whereas the reverse loses the row |
| `saveLapValidityVerdict` / `listLapValidityVerdicts` (`:601`, `:603`) | a test double or the web preview's stand-in need not store owner verdicts | the reader must say verdicts are **UNAVAILABLE** — never that there were none |
| `listLapValidityVerdictsWithDiagnostics` (`:610`) | pre-P14 stores do not count unreadable rows | the caller knows only that it cannot tell an unreadable row from an absent one — *which is itself a fact worth reporting* |
| `saveCalibrationAttempt` / `listCalibrationAttempts` / `…WithDiagnostics` (`:617`, `:619`, `:621`) | same terms as the verdict trio | same |

Both first-party repositories implement all of them.

### 5.2 Failures that are deliberately surfaced rather than swallowed

* **`parsePayloads` counts what it skipped** (`sqlSessionRepository.ts:71-82`). The skip is the right
  trade; the silence was not. `unreadableCount > 0` is what turns a report section from `empty` into
  `failed`.
* **`savitzkyGolay` throws on a series shorter than one window** rather than truncating
  (`signal/savitzky-golay.ts:334-346`): "a silently shortened telemetry trace is worse than a
  rejected one."
* **`buildDemonstratedEnvelope` throws** on a duplicate lap number or mixed
  `CORNER_ANALYSIS_VERSION`s (`envelope.ts:130-141`); `analyzeSession` throws on a duplicate lap
  number in the session (`sessionInsights.ts:464-470`) — a duplicate would silently make one lap
  stand for two different drives.
* **`assertJsonSerializable` runs before any I/O** (`sqlSessionRepository.ts:293-298`): a
  non-serializable snapshot must not be able to abort a transaction half-way, it must never open one.
* **`validateReferenceLap` runs before the transaction** in `putReferenceLap` (`:569`), so a failed
  validation leaves a previously stored PB completely untouched.
* **`deleteAllUserData` verifies emptiness afterwards** (`persistence/deleteUserData.ts:32-41`) so no
  success banner fires over a partial wipe.
* **`timeIntegrationDriftExceeded`** (`distanceDomain.ts:293-298`) surfaces a disagreement between
  the integrated `t(s)` and the recorded clock as a stated `TIME_INTEGRATION_DRIFT` limitation rather
  than letting the delta curve quietly be wrong.
* **Contrast — deliberately *not* fatal:** raw-trace write failures are counted and logged but never
  thrown (`controller/sessionController.ts:791`, `noteTraceFailure`), because losing the drive to an
  exception is worse than losing a chunk of it; and `CheckpointCodec.deserialize` never throws,
  returning `null` for corrupt or legacy rows (`persistence/checkpointCodec.ts:89-91`), because a
  corrupt checkpoint must be *replaceable* or a session could never recover from one.

### 5.3 Caches, and what invalidates them

There is **no cache inside `packages/core`'s analysis path**. Every function there is pure and
recomputes. The one cache in the analysis pipeline lives in the app:

* `LapProjectionCache` (`apps/mobile/src/session/analysisAssembly.ts:346`) — per-lap projections of
  one outing, keyed by lap number.
* **Invalidated by fingerprint, not by time**: `recordingFingerprint` (`:357`) hashes
  `durationMs : valid : locationSamples.length : telemetry.length : first.tMono : last.tMono`, and
  `projectionFingerprint` (`:376`) appends `:sg` when G-force smoothing is on — so a cache filled
  while `analysisSmoothingEnabled` was off is never served to a pass that asked for smoothing.
  A lap re-read with more samples re-projects.
* Everything else that looks like caching is memoisation-free by design: `analyzeSession` rebuilds
  every grid and every delta curve on each call (`sessionInsights.ts:537-554`), which is why the
  stint runner's per-boundary cost grows with the session and why the projection cache exists at all.
* The `CoachEngine`'s per-lap `completedThisLap` set is state, not a cache; it is cleared on a lap
  index increase (`coach/coach-engine.ts:158-162`) and preserved across a mid-lap braking-zone
  refresh only when `configure({preserveEmitted: true})` is passed (`:139-144`).

### 5.4 `fixtures/` is not test-only, and that is the point

`fixtures/` ships in the package's public surface (`packages/core/src/index.ts:101`). Three reasons:

1. **The dev replay screen drives them through the real pipeline.**
   `apps/mobile/src/ui/screens/DevReplayScreen.tsx` lists the bundled scenarios and selecting one
   drives the actual production `SessionController` through the real calibration and dashboard
   screens — not a mock facade (`current-state.md`, "App-side wiring").
2. **Determinism is the test oracle.** `SeededPrng` (`fixtures/prng.ts:2`) is a fixed LCG, so a
   scenario is byte-reproducible; each fixture carries its own `expectedOutcome` string as
   non-enumerable metadata (`fixtures/drive-lap.ts:41-50`), which is the assertion, written down next
   to the data rather than in a test file.
3. **Both circuits, same code.** `motorpark-scenarios.ts` are thin fixed-seed wrappers (seeds in the
   9_1xx band) so MotorPark is exercised exactly as TMR is — no second fixture engine. This is the
   "Phase 5 scope: both circuits" rule made mechanical.

The soak tests (`test/soak/*.soak.test.ts`) and the perf benchmark
(`test/perf/core-pipeline.benchmark.test.ts`) are built on the same fixtures.

### 5.5 Other asymmetries worth ten seconds each

* **`cleanLap` reports what a check *saw* even when the check is unavailable.** An off-track
  excursion observed over the first 100 m is a fact; thin coverage only removes the right to call the
  lap *clean* (`cleanLap.ts:756-767`).
* **Coverage is measured in metres of bridgeable track, not in "a fix landed in this bucket".**
  90 isolated readings spread one per bucket across a 6.1 km lap would otherwise read as ~90 %
  covered with zero bridgeable metres between any of them (`channelCoverageFraction`,
  `cleanLap.ts:581-610`; pinned at `test/coaching/cleanLap.test.ts:263`).
* **The yaw check picks its signal per *window*, not per lap** (`evaluateYaw`,
  `cleanLap.ts:354-455`). The old lap-level `useGyro = gyroCount >= 2` handed the entire lap to the
  gyro as soon as two finite samples existed anywhere in it, so two stray zero-yaw samples silently
  deleted a real 250 °/s rotation from the report. A lap can legitimately report `source: 'mixed'`.
* **Gyro coverage of a window is 100 % or nothing** (`integratedGyroTurn`, `cleanLap.ts:320-337`).
  The turn is an *integral*; a window 80 % covered does not give an 80 %-confident turn, it gives one
  silently *short* by whatever happened in the other 20 %. Falling back to GNSS heading — which did
  observe the whole window — is strictly better evidence than an invented rate.
* **Corner windows are derived per corner from its own speed drop**, not fixed
  (`approachLengthM`/`exitLengthM`, `cornerMetrics.ts:906`, `:931`), and clipped so they can never
  reach back into the neighbouring corner. A 250→80 km/h braking zone is hundreds of metres; a kink
  that costs no speed gets a short window instead of swallowing 300 m of straight.
* **When a lap is handed in with a lead-in from the previous lap**, the window that belongs to *this*
  lap is the **later** pass (`cornerMetrics.ts:432-438`), and quality gaps are counted only between
  runs that *continue* each other — a run that rewinds to already-covered distance is a second pass,
  not a hole (`:1067-1104`).
* **The comparison lap is not always the median.** With exactly the two clean laps the honesty gate
  requires, the median *is* the reference, so the other clean lap becomes the representative one —
  otherwise the minimum passing session produces an empty priority-1 report
  (`sessionInsights.ts:520-534`).
* **Consistency scores are only ranked against scores built from the same evidence basis**
  (`sessionInsights.ts:724-758`). A score from corner time alone and one from brake point + minimum
  speed + corner time are not the same measurement.
* **The cue-evidence checksum is integrity, not authenticity.** FNV-1a, unkeyed, recomputable by
  anyone holding the module (`suggestions.ts:656-674`). It catches truncation/mutation in transit.
  The real defence is architectural: the controller only seals evidence it derived itself, and every
  bound is **re-derived from the sealed entries at apply time** rather than trusted from the
  `CueUpdate`'s own numbers.
* **`suggestionsEnabled` defaults OFF**, and with it off `computeSuggestions` is "indistinguishable
  from not existing" (`suggestions.ts:388-390`) — the opt-in gate is checked before anything else.
* **`sessions.calibrationStatus` is written as the string `'unknown'`, not as NULL**, when absent
  (`sqlSessionRepository.ts:343-346`): the row states the fact rather than leaving the reader to
  infer it. `traceFinalized`, by contrast, *stays* NULL (`:349-352`) — only a caller that actually
  knows the recording finished may claim it did.
* **`ReplayHarnessConfig` exports two `@deprecated` aliases** (`replay/replay-harness.ts:43-45`) kept
  purely for name compatibility; new code should use `MatchedTelemetrySample` /
  `RejectedTelemetrySample` from `controller/pipelineCore`.

---

## 6. What is not here (and why)

| Lives in `apps/mobile` | Why not in core |
|---|---|
| `session/analysisAssembly.ts` — projection + join + the per-lap channel-coverage gate, the `AssembledAnalysis` the engine consumes | It answers *what did this device store for this session*, which is a question about the app's persistence and catalog, not about driving. The stated division: "this module ASSEMBLES, the engine DECIDES" (`analysisAssembly.ts:31-32`). It is still pure TypeScript and vitest-importable. |
| `session/sessionReport.ts` — the four-valued `SessionReportPartState` and the whole report document | It is an *availability* statement about this device's stores, several of which (settings, trackday record, adoption journal) core knows nothing about. Core supplies the pieces (`StoredRecordRead`, `mergeLapValidityVerdicts`, `summarizeLapVerdicts`). |
| `session/rawSessionExport.ts`, `analysisExport.ts`, `sessionReportShare.ts` | Export file formats and sharing. |
| `session/analysisViewModel.ts`, `analysisSessionLoader.ts`, `stintCoaching.ts`, `pitViewModel.ts` | Screen state, async chunking, and the stint/cue application loop. |
| `session/gforceProvider.ts` | `expo-sensors`. The platform boundary (and the one place that must get `MadgwickAhrs.gravity()`'s sign convention right — see I5). |
| `session/tcpObdTransport.ts`, `enetTcpTransport.ts` | Sockets. Core defines `ObdTransport` (`telemetry/contracts.ts:57`) and never opens one. |
| `persistence/expoSqlDatabase.ts`, `sqlWriteGate.ts`, `sqlSettingsStore.ts` | expo-sqlite, and the write gate that serialises a shared connection. Core defines `SqlDatabase` (`persistence-sql/sqlDatabase.ts:29`) and is agnostic. |
| The `settings` table's reader/writer | Created by core's v2 DDL but deliberately **not** part of the `LocalSessionRepository` contract (`schema.ts:114-119`). |
| `geometryStatus === 'official'` → `geometryValidated`, and `geometryProvenanceOf(geometryStatus)` → `geometryProvenance` | The *catalog* decides; the app states both facts (`apps/mobile/src/session/analysisAssembly.ts:552`, `:557`). Since P17 the status→tier *mapping* is core's (`coaching/sessionInsights.ts:102`), so the app cannot drift from the analysis — only the reading of the catalog stays in the app. |

Also not in core, anywhere: `fetch`, `XMLHttpRequest`, `WebSocket`, `Date.now()` on any analysis
path (clocks are injected), and any LLM. Phase 5 is a **deterministic** engine by decision, not by
accident.

---

## 7. Questions and suspicions

> Recorded, **not fixed**. Each one has evidence; a later phase should investigate. Ranked roughly by
> how much I would worry.

**Q1 — ANSWERED (`ec153ef`, P16 C2; reshaped by P17 `5561364`).** *Was:* `geometryValidated` failed
OPEN in core — `analyzeSession` defaulted it to `true` and `computeSuggestions` closed only on an
explicit `false`. *Now:* `SessionAnalysisContext.geometryValidated` is **required**
(`coaching/sessionInsights.ts:164`) and carried through with no `?? true` (`:904`); in
`computeSuggestions` an input that states neither `geometry` nor `geometryValidated: true` gets
`gate: 'geometry-unvalidated'`, `scope: 'closed'` (`statedGeometry`, `suggestions.ts:279-287`,
`:396`). The old pin was inverted rather than deleted: "omitting geometryValidated is NOT consent"
(`test/coaching/suggestionsHonesty.test.ts:236`) and "SessionAnalysisContext requires the geometry
fact" (`:264`). P17 then *deliberately* opened pit suggestions on a stated `'mapped'`/`'learned'` line
(I3) — an argued widening on explicit input, not a default. Residual shapes of the same concern are
Q11 and Q13.

**Q2 — ANSWERED (`ec153ef`, P16 C1).** *Was:* `listSessions`, `loadTelemetry`, `getReferenceLap`
parsed unguarded, so one corrupt row cost the whole session list. *Now:* `listSessions` reads each
session's laps through `parsePayloads` and reports `unreadableLapCount`
(`persistence-sql/sqlSessionRepository.ts:400-411`); the two single-value reads, whose `[]`/`null`
already mean "there was nothing", **fail loud** with `StoredPayloadUnreadableError` naming the row
(`:84-124`, used at `:476`, `:557`) — returning empty would export a driven lap as traceless, and
`null` would let a slower lap overwrite a PB still on disk. Pinned by
`test/persistence-sql/sqlRepositoryCorruptLapRowsP16.test.ts:72`, `:105`, `:120`, `:131`, `:155`.

**Q3 — Two different values of standard gravity.** `coaching/types.ts:45` exports
`GRAVITY_MPS2 = 9.80665` and describes itself as "the single conversion constant for g ↔ m/s²";
`corners/analyzeCorners.ts:6` declares a private `GRAVITY_MPS2 = 9.81`. Both feed corner advisory
speeds — `analyzeCorners` computes them, and `testloop/syntheticCorners.ts:10` imports the *other*
constant while working with corners produced by `analyzeCorners`. The discrepancy is ~0.034 %, so
nothing will be visibly wrong; it is a correctness smell and a trap for whoever next tries to make
advisory speeds reproducible across the two paths.

**Q4 — The time-loss ranking key mixes two different measurements.** `sessionInsights.ts:718-722`
sorts by `a.deltaMs ?? a.sectorLossMs ?? -Infinity`. `deltaMs` is the delta-curve contribution over
`approachStart → exit` against the reference lap; `sectorLossMs` is the comparison lap's corner time
minus the *best* corner time on any clean lap. Both are milliseconds, so the sort compiles and looks
sane, but a corner whose delta is unavailable is ranked against other corners' deltas using a
quantity with a different baseline. Whether this ever reorders the top 5 in practice, I did not test.

**Q5 — `PitSuggestion` compares a pessimistic bound against an optimistic typical.**
`distanceSuggestion` (`coaching/suggestions.ts:332`) takes `typicalValue` from
`corner.medianBrakeStartM`, which is the **raw** median (`envelope.ts:199`), and
`demonstratedValue` from `latestBrakeStartM`, which is the **uncertainty-inflated** value
(`envelope.ts:166-169`, invariant I6). `deltaValue = typicalValue − targetValue` therefore mixes the
two bases. The inflation is conservative in the safe direction (it *reduces* the suggested move), so
this is not a safety hole — but the number the driver is shown is not a like-for-like difference, and
the comment at `envelope.ts:157-165` says only that "every other statistic keeps the measured value"
without addressing the comparison.

**Q6 — `SuggestionSkip.point` is always `'brake'` for corner-level skips.**
`suggestions.ts:430`, `:434`, `:438` push `{point: 'brake'}` for `honesty-gate`,
`insufficient-data` and `already-updated-this-stint`, which are all *corner*-level decisions that
also suppressed the lift cue. A consumer grouping `skipped` by point will report that the lift cue
was fine when it was equally blocked. P17's `geometry-self-referential` (`:427`) copies the same
shape — and it is now the skip every user on every shipped circuit sees.

**Q7 — Session-wide `availability` under-reports what the per-lap gate did.**
`channelAvailability` is computed over all laps flattened (`sessionInsights.ts:503-506`), while the
coverage gate that actually strips channels is applied **per lap** in the app
(`analysisAssembly.ts:71-85`). So a channel present on lap 1 and absent on lap 2 appears in
`availability.available` and raises no `MISSING_CHANNELS` limitation, even though lap 2's metrics
fell back to tier-0 estimators. The app compensates with its own `AnalysisExcludedChannel` reporting,
but `SessionInsights.availability` read on its own is misleading — and `reportText.ts` renders the
core's version.

**Q8 — `schema_migrations` has no primary key or uniqueness constraint.**
`schema.ts:65-67` creates it as a bare `version INTEGER NOT NULL`; `migrate` reads it with
`LIMIT 1` and writes `UPDATE schema_migrations SET version = ?` with no `WHERE`
(`sqlSessionRepository.ts:203-216`). If two rows ever existed, the read is arbitrary and the write
flattens both. There is no code path that inserts twice today (the INSERT is gated on
`currentVersion === 0`), so this is latent rather than live — but it is the kind of thing a
concurrent first-open on a shared connection could produce.

**Q9 — Duplicated grid constants.** `coaching/distanceDomain.ts:31,38` export
`DEFAULT_GRID_STEP_M = 1` and `DEFAULT_MAX_BRIDGE_M = 60`; `coaching/cornerMetrics.ts:148-149`
hard-codes the same two numbers as literal defaults in `resolveOptions`, and
`cleanLap.ts:633` hard-codes `checkBridgeM ?? 60` as a third copy. They agree today. Nothing makes
them agree tomorrow, and the three of them are supposed to describe the same physical assumption
("1.5 s at 150 km/h").

**Q10 — `driveLap`'s fixture surface has grown past what its options document.**
`DriveLapOptions` (`fixtures/drive-lap.ts:21-33`) has twelve fields, none of them with doc comments,
against a module whose scenarios all carry prose `expectedOutcome` strings. Low risk, but it is the
one file in the area with no explanatory header, and it is the file everyone writing a new test will
have to read.

**Q11 — (new, P17) `'surveyed'` ⇔ `geometryValidated` is claimed but only half-enforced.** The
`SessionInsights.geometryProvenance` doc (`coaching/sessionInsights.ts:375-377`) and the comment at
`:905-906` say `'surveyed'` holds *exactly when* `geometryValidated` is true.
`resolveGeometryProvenance` (`:119-126`) enforces only one direction: `geometryValidated: true` with a
stated `'mapped'` or `'learned'` returns that value unchanged, so the insights say
`geometryValidated: true` **and** `geometryProvenance: 'mapped'`. The two I3 layers then disagree:
`computeSuggestions` (via `suggestionsFromInsights`) resolves `'mapped'` and moves no cue, while
`cueEvidenceFromInsights` keys on `geometryValidated` alone (`suggestions.ts:703-707`) and seals a
**full** evidence set. The first layer still holds, so no cue moves; defence in depth quietly becomes
single-layered for that input. The one app caller derives both fields from the same `geometryStatus`
(`analysisAssembly.ts:552`, `:557`), so this is unreachable today — the same "latent, not live" shape
as Q8. Either the resolver should narrow `geometryValidated` too, or the doc should say "implies".

**Q12 — (new, `8c495b6`) the Signal Finder cooldown loop has no independent time bound.** The loop at
`telemetry/signalFinder/runner.ts:589-591` exits only when `input.clock.now()` reaches
`min(boundary, endAtMs)` or `control.stopped` is set. A clock that never advances waits forever unless
stopped — advancing timers alone cannot finish it (Codex P18-REV1, `.foreman/scratch/p18-codex-rev1-out.txt`,
"B — Pause/frozen clocks", reproduced with a frozen-clock probe). Production supplies `Date.now()`, so a
backward wall-clock adjustment lengthens the wait by that amount. Separately, and **pre-existing**,
`control.paused` is never read anywhere in `runFinderRound` — only `stopped` is (`:484`, `:589`) —
although `DidSweepControl` carries it (`telemetry/enet/didSweep.ts:163`) and `didSweep` honours it.
Codex also notes the new regression test (`test/telemetry/signalFinder/runner.test.ts:397`) is not
deterministic proof: a late enough timer crosses the boundary without the fix. Open question: should the
runner take a monotonic clock, and does the app ever rely on `paused` reaching a round?

**Q13 — (new, P17) `pitSuggestionLine` defaults its tier to `'surveyed'`.** The third argument
(`coaching/reportText.ts:980-984`) defaults to the one value that renders an *unqualified*
"Corner 7" — the absolute claim P17 exists to stop making on unsurveyed geometry. The default is
documented as backward-compatibility (`:976-979`) and both real callers pass
`insights.geometryProvenance` (`apps/mobile/src/session/pitViewModel.ts:201`,
`analysisExport.ts:603`), so nothing ships wrong today; but a new caller that forgets the argument now
gets advice on a mapped circuit labelled as the circuit's own corner. It is Q1's old shape
(fail-open default), moved from the gate into the copy.

**Q14 — (new, P17, from the commit's own "Known and left") the one geometry-sensitive verdict left.**
Off-track classification still compares lateral offset against the traced line with a fixed 15 m
corridor (`coaching/cleanLap.ts:623`, `:762-763`). On an unsurveyed line that verdict *is* absolute.
It fails closed (an `offTrack` lap is anomalous and never feeds the envelope, I7), so its cost is lost
evidence, not wrong advice — but it is the one place where "self-referential claims survive a
displaced line" does not hold, and a systematic offset on part of a trace could quietly exclude every
lap's worth of a corner. The same commit records that MotorPark's corner list yields a 158 m "corner"
with a 324 m brake distance — true, odd-reading, a segmentation-resolution question rather than a
gate one. Neither was verified here beyond the commit message and the corridor constant.

### Blank areas — stated rather than guessed

* I did **not** read `coaching/reportText.ts` in full (46 KB, mostly the RO/EN vocabulary tables).
  I read its header, `buildReport`, `renderReport`, `pitSuggestionLine`, `cueUpdateLine`, and (for
  the 2026-09-23 update) every P17 change: `cornerName`, the per-tier `TEXT` entries, the
  `GEOMETRY_UNVALIDATED` limitation line, `timeLossLine`'s label and `cornerSection`. The claim "no output can ever contain `undefined` or `NaN`"
  (`reportText.ts:21-23`) is the module's own; I did not verify it against every template.
* `telemetry/enet/**` and `telemetry/signalFinder/**` (~14 files, ~150 KB) are summarised at the
  level of *what each file owns*. I read their headers, contracts and the scoring rationale, not
  their bodies. They are a discovery subsystem with their own invariants (edge ordering,
  per-DID baseline rules, batching/pacing budgets) that deserve their own map. The one exception is
  `runFinderRound`'s cooldown branch (`runner.ts:577-594`), read in full for `8c495b6`. No other map
  covers these core files (`map-mobile-app.md` covers only the app-side Signal Finder screen and
  controller).
* `reference/live-delta-engine.ts`'s smoothing/deadband/regression behaviour below line 140 is not
  covered here.
* I did not run builds or tests (constraint). Every "pinned by" reference names a test by
  `file:line` and its title; I did not execute any of them.
* `.foreman/ledger.md` (~200 KB) was **not** read. Where a ticket id appears in this document
  (P4l-FIX4 N3, P5c-FIX1 E4, P10A H6, P10B H4-B, P11C, P12, P14 H3/H5, P15 F1, P5d-FIX1/FIX2, P6a-FIX1 M4,
  P7D R3, P7M M1/M6) it was taken from the source comment that cites it, not from the ledger.

---

## 8. Test index for this area

| Area | Tests |
|---|---|
| `coaching/` | `test/coaching/{cleanLap,cornerMetrics,distanceDomain,envelope,reportText,sessionInsights,suggestions,suggestionsHonesty,circuits.analysis,brakeSwitchChannel,brakeSwitchResampling,gyroYawChannel,yawSourcePerWindow,geometryTiers}.test.ts` — `geometryTiers` (P17) is the 137 m displaced-origin invariance proof and the three tiers' prose (see I3) |
| `coach/` | `test/coach/{braking-zones,coach-engine,coach.replay}.test.ts` |
| `corners/` | `test/corners/analyzeCorners.test.ts` (carries the TMR 9→12 regression pin) |
| `signal/` | `test/signal/{savitzky-golay,savitzkyGolayConditioning}.test.ts` |
| `fusion/` | `test/fusion/madgwick.test.ts` |
| `reference/` | `test/reference/{build-reference-lap,live-delta-engine,personal-best}.test.ts` |
| `replay/` | `test/replay/replay-harness.integration.test.ts` |
| `testloop/` | `test/testloop/{loopClosure,closureHardening,geometryHardening,codec}.test.ts` |
| `telemetry/` | `test/telemetry/**` (elm327, pidCodec, framing property, simulated transport, 13× `enet/`, 6× `signalFinder/`; `signalFinder/runner.test.ts:397` pins the cooldown loop) |
| `persistence/` | `test/persistence/{checkpointCodec,deleteUserData,inMemorySessionRepository,lapVerdict,referenceLap.property}.test.ts` |
| `persistence-sql/` | `test/persistence-sql/{sqlSessionRepository.contract,sqlRepositoryUnreadableRowsP14,sqlRepositoryCorruptLapRowsP16}.test.ts` |
| Whole-pipeline (uses `fixtures/`) | `test/soak/{track-day,motorparkTrackDayScenario,userTrackDayScenario,personalBestEviction}.soak.test.ts`, `test/perf/core-pipeline.benchmark.test.ts` |
