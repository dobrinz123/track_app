# Map: the timing engine half of `packages/core`

> Orientation map for `packages/core/src/{contracts.ts, geometry, matching, timing, calibration, controller, statemachine, profile, catalog}`.
> Written 2026-09-22 against the working tree at commit `4676545`. Every reference is `path:line` **plus** an exported symbol name — when a line has drifted, search the symbol.
> Scope note: `coach/`, `coaching/`, `corners/`, `reference/`, `fusion/`, `signal/`, `telemetry/`, `persistence*/`, `replay/`, `testloop/`, `fixtures/` are the *other* half of `packages/core` and are described here only where the timing path touches them.

---

## 0. The shape of the area in one paragraph

`contracts.ts` is a single flat file of interfaces and type aliases with **no runtime code of its own** — it is the spine, and everything else in this list is an implementation of, or a consumer of, something declared there. The timing path is a straight line of five stateful engines (`TelemetryQualityEvaluator` → `TrackMatcher` → `CrossingDetector` → `LapTimingEngine`, with `LiveDeltaEngine` hanging off the side), all constructed in exactly one place (`createPipelineComponents`), driven by exactly one per-sample method (`SessionPipelineCore.ingest`), and wrapped by exactly one orchestrator (`SessionController`). `geometry/` is pure functions with no state; `profile/` and `catalog/` are the load-time half (validate JSON → build a projected `RuntimeProfile`); `calibration/` is a parallel consumer of the same matcher used only during the Learn lap; `statemachine/` is one pure reducer.

---

## 1. The one-page picture: GNSS sample → persisted `LapRecord`

| # | What happens | Where |
|---|---|---|
| 1 | Platform GNSS emits. `LocationProvider.subscribe(cb)` hands over a `LocationSample` (`tMono` from the injected `MonotonicClock`, never `Date.now()`). | `contracts.ts:590` `LocationProvider`; `contracts.ts:13` `LocationSample`; impl `apps/mobile/src/platform/gnssLocationProvider.ts` |
| 2 | `SessionController` subscribed this callback inside `ensureProviderRunning()`, and only *after* `provider.start()` resolved. | `controller/sessionController.ts:1812` `ensureProviderRunning`; subscription is captured in `providerUnsubscribe` (`:966`) |
| 3 | `handleSample(sample)`. Stamps `lastSampleAtMono` (watchdog), returns early if paused, then **records the raw trace unconditionally** — above the mode branch, so a Learn lap that never completes still leaves its fixes on disk. | `controller/sessionController.ts:1846` `handleSample`; `:2372` `recordRawTrace` |
| 4 | If `mode === 'calibrating'`: the sample goes to `CalibrationEngine.feed()` and **never reaches the timing pipeline**. Coverage ≥ 0.98 force-finishes the Learn lap. Returns. | `calibration/calibration-engine.ts:215` `feed`; `sessionController.ts:349` `CALIBRATION_COMPLETE_COVERAGE_FRACTION`; `:1360` `finishCalibrationNow` |
| 5 | If `mode === 'live'`: `SessionPipelineCore.ingest(sample)` — the single canonical ordering, shared with the batch replay harness. | `controller/pipelineCore.ts:260` `ingest` |
| 6 | **Quality.** `TelemetryQualityEvaluator.assess(sample, prev)` → `QualityAssessment {level, reasons}`. Accuracy, sample gap, duplicate/non-increasing timestamp, implied-speed teleport. | `matching/quality-evaluator.ts:49` class, `:56` `assess`; thresholds `:18` `DEFAULT_TELEMETRY_QUALITY_CONFIG` |
| 7 | **Gap handling.** A `tMono` gap > `pauseGapMs` (30 s) synthesises `PAUSE` + `RESUME`; a gap > 3 s synthesises `GNSS_LOST`/`GNSS_RECOVERED` and, past `lowQualityGapMs` (10 s), marks the active lap `LOW_QUALITY`. | `pipelineCore.ts:268-289` |
| 8 | **Match.** `TrackMatcher.match(sample)` projects lat/lon into the profile's local ENU frame, projects onto the centerline (hinted window, `windowM` 150 m), and returns a `TrackMatch` — or `null` when quality is `invalid`. | `matching/track-matcher.ts:254` class, `:307` `match`; `contracts.ts:74` `TrackMatch` |
| 9 | A `null` match is recorded as a `RejectedTelemetrySample` and `ingest` returns. Nothing downstream sees it. | `pipelineCore.ts:292-313` |
| 10 | **Pit / reverse guards.** A pending forward `pitEntry` crossing plus ≥2 consecutive `onPitLane` matches with `|lateralM| ≥ 5` dispatches `PIT_ENTERED`. A ≥30 m drop in `unwrappedProgressM` marks `REVERSE_TRAVEL`. | `pipelineCore.ts:326-352` |
| 11 | **Crossings.** `CrossingDetector.update(prevMatch, currMatch, prevSample, currSample)`. Feeds the along-track filter and the pit-evidence machine first (before any guard can return), refuses implausible steps, then tests every projected gate with `segmentIntersection` + `crossingDirection`, and times each hit with `safeCrossingTime`. Returns `CrossingEvent[]`. | `timing/crossing-detector.ts:832` `update`; `geometry/intersection.ts:24` `segmentIntersection`, `:73` `crossingDirection`, `:112` `interpolateCrossingTime`, `:206` `kinematicCrossingFraction` |
| 12 | `currentLapElapsedMs` is read **before** any crossing from this sample is applied, so the live delta belongs to the lap that was running. | `pipelineCore.ts:358-359` |
| 13 | Per crossing, in emission order: append to `crossings`, `dispatch({type:'CROSSING', event})` into the reducer, update pit pending/exit state, then `LapTimingEngine.onCrossing(event, match.quality.level, state==='inPit')`. | `pipelineCore.ts:362-384`; reducer `statemachine/reducer.ts:84` `sessionReducer` |
| 14 | **Lap assembly.** `LapTimingEngine` starts a lap on a forward start/finish crossing, accumulates sector times and invalid reasons, and on the *next* forward start/finish returns the completed `LapRecord` and immediately opens the next lap. | `timing/lap-timing-engine.ts:144` `onCrossing`, `:187` `startLap`, `:265` `completeLap`; `contracts.ts:318` `LapRecord` |
| 15 | Completed laps are pushed onto `SessionPipelineCore.laps` and returned in `SampleIngestResult.completedLaps`. | `pipelineCore.ts:378-381`, `:100` `SampleIngestResult` |
| 16 | `SessionController` reacts: clears the stale delta/cue on a lap boundary, recomputes the live delta otherwise, feeds `CoachEngine`, then fires `onLapCompleted(lap)` asynchronously per completed lap. | `sessionController.ts:1892-1985` |
| 17 | **Persistence.** `onLapCompleted` builds the lap's telemetry entries and the recovery checkpoint and commits them through `writeLapCommit` — `repository.saveLapCommit` when the store offers it (one transaction), otherwise checkpoint-first-then-telemetry. | `sessionController.ts:2928` `onLapCompleted`, `:2820` `writeLapCommit`; contract `contracts.ts:543` `saveLapCommit` |
| 18 | **Session record.** `endSession()` stops the provider, concludes any open calibration attempt, does the *final* raw-trace flush, awaits `flush()`, sets `recordingFinalized`, writes `SessionSummary` (laps + calibration provenance + trace shortfall) and a terminal checkpoint. | `sessionController.ts:1544` `endSession`, `:2099` `buildSessionSummary`; `contracts.ts:425` `SessionSummary` |

**Read this line if you read nothing else:** the pipeline order is `quality → matcher → pit/reverse guards → crossings → state machine → timing → delta`, it exists exactly once (`SessionPipelineCore.ingest`), and both the live controller and the batch replay harness drive it.

---

## 2. Module by module

### `contracts.ts` — the spine (675 lines, no runtime code except three consts)

Owns every binding interface and the vocabulary the rest of the repo speaks. Three runtime values live here: `CALIBRATION_ATTEMPT_RECORD_VERSION` (`:194`), `CORNER_ANALYSIS_VERSION` (`:639`), and nothing else — everything else is erased at compile time. That erasure is why `index.ts:8` exports `CORE_PACKAGE_ID`, a dummy value import so a consumer's bundler can prove `@circuit/core` actually resolved.

| Section | Key declarations |
|---|---|
| Geo & samples | `LatLon` `:2`, `LocalPoint` `:3`, `GeoProjection` `:5`, `LocationSample` `:13`, `QualityAssessment` `:25` |
| Profile | `Gate` `:35`, `CircuitProfile` `:43` (`geometryStatus` `:57`) |
| Matching | `TrackMatch` `:74`, `TrackMatcher` `:86` |
| Crossings | `CrossingEvent` `:92` (`pitAmbiguous` `:121`), `CrossingDetector` `:124` |
| Calibration | `CalibrationDiagnostics` `:130`, `CalibrationResult` `:162`, `CalibrationEngine` `:170`, `CalibrationThresholds` `:220`, `CalibrationAttemptRecord` `:247` |
| State machine | `SessionState` `:299`, `SessionEvent` `:303`, `SessionMachineSnapshot` `:313`, `SessionReducer` `:314` |
| Timing | `SectorTime` `:317`, `LapRecord` `:318`, `LapTimingEngine` `:368`, `LapValidityVerdict` `:344` |
| Reference/delta | `ReferenceLap` `:375`, `DeltaUpdate` `:386`, `LiveDeltaEngine` `:393` |
| Persistence | `SessionCalibrationStatus` `:423`, `SessionSummary` `:425`, `StoredRecordRead<T>` `:483`, `LocalSessionRepository` `:489` |
| Providers | `LocationProvider` `:590`, `MonotonicClock` `:594` |

### The interface-vs-class naming rule (read this once, then stop being surprised)

Several concrete classes deliberately **share a name with the `contracts.ts` interface they implement**. TypeScript's `export *` cannot re-export an ambiguous name, so `packages/core/src/index.ts` handles those modules with **explicit named re-exports instead of `export *`**, and the explicit export resolves in favour of the **concrete class**.

- The rule: `import { X } from '@circuit/core'` gives you the **implementation**; `import type { X } from '@circuit/core/contracts'` (or via the root's `export * from './contracts'` when unambiguous) gives you the **interface**. Type against the interface when you are writing a consumer or a test double; construct the class when you are wiring the pipeline.
- Where it is written down: `index.ts:10-25` (the header comment stating the rule), then `index.ts:42-47` (matching), `:49-67` (calibration), `:69-75` (timing), `:81-98` (reference).
- Each implementing file names the import to keep both visible in one scope, e.g. `TrackMatcher as TrackMatcherContract` (`matching/track-matcher.ts:6`), `CrossingDetector as CrossingDetectorContract` (`timing/crossing-detector.ts:2`), `CalibrationEngine as CalibrationEngineContract` (`calibration/calibration-engine.ts:3`).
- One name collides *between two implementation modules*, not with a contract: `ProjectedGate` exists as two unrelated shapes — `profile/validation.ts:11` (gate + local endpoints + `distanceM` along the centerline) and `timing/crossing-detector.ts:28` (gate + `aLocal`/`bLocal` only). The root barrel re-exports the timing one renamed: `ProjectedGate as TimingProjectedGate` (`index.ts:74`).

---

### `geometry/` — pure functions, no state, no I/O

**Owns:** the local ENU projection, polyline projection and progress unwrapping, directed segment intersection and crossing direction, crossing-time interpolation, curvature, centerline densification.

**Barrel (`geometry/index.ts`):** `createProjection`; `polylineCumulative`, `polylineLength`, `projectOntoPolyline`, `unwrapProgress`, types `PolylineProjection`/`ProjectionHint`; `crossingDirection`, `interpolateCrossingTime`, `segmentIntersection`, type `SegmentIntersection`; `curvatureAtDistance`, `curvatureProfile`; `densifyClosedCenterline` + its types.

**Not in the barrel:** `kinematicCrossingFraction` (`intersection.ts:206`) — reached by deep import from `timing/crossing-detector.ts:11`; and all of `geometry/validation.ts` (`assertFiniteNumber`, `assertLatLon`, `assertLocalPoint`, `checkedHypot`), which is internal.

| File | What it owns |
|---|---|
| `projection.ts:24` `createProjection` | Spherical equirectangular local frame about a fixed origin. Deliberately not ellipsoidal — circuits are small (`:4-6`). Refuses an origin near a pole (`:28`). |
| `polyline.ts` | `polylineCumulative` `:31` (per-vertex distances, closing segment is **not** a vertex), `polylineLength` `:51` (includes the implicit wrap), `projectOntoPolyline` `:132` (nearest point, optional wrapping hint window), `unwrapProgress` `:219` (lift a wrapped distance to the nearest equivalent of the previous unwrapped value). |
| `intersection.ts` | `segmentIntersection` `:24` (inclusive, orientation determinants, `null` for parallel/collinear/degenerate), `crossingDirection` `:73`, `interpolateCrossingTime` `:112`, `kinematicCrossingFraction` `:206`. |
| `curvature.ts` | `curvatureAtDistance` `:113`, `curvatureProfile` `:151`. Signed turning-angle density, `+` = left. Used by `corners/` and the circuit generators, not by the timing path. |
| `densify.ts` | `densifyClosedCenterline` `:227`. Arc-aware resampling of a traced OSM centerline so a long chord across a curve stops reading as lateral offset (`:3-45`). Build-time/asset-generation, not runtime. Kept dependency-free on purpose (`:118-120`) because the generators load it directly under `node --experimental-strip-types`. |

**Depends on:** `contracts.ts` types only. **Depended on by:** `profile/validation`, `matching/track-matcher`, `timing/crossing-detector`, `calibration/calibration-engine`, `controller/pipelineCore`, `corners/`, `coaching/distanceDomain`, `fixtures/`, `testloop/`.

---

### `matching/` — "where on the track is this fix, and can I believe it"

**Owns:** GNSS quality grading, centerline matching, and the 1-D along-track Kalman filter.

**Barrel (`matching/index.ts`):** `TelemetryQualityEvaluator` + `DEFAULT_TELEMETRY_QUALITY_CONFIG` + type `TelemetryQualityConfig`; `TrackMatcher` + type `TrackMatcherConfig`; `AlongTrackFilter` + types `AlongTrackEstimate`/`AlongTrackFilterConfig`/`AlongTrackObservation`.

> The package **root** re-exports only the first two groups (`index.ts:42-47`). `AlongTrackFilter` is reachable inside `packages/core` but **not** from `@circuit/core` — see Questions §7.1.

| File | Notes |
|---|---|
| `quality-evaluator.ts:49` `TelemetryQualityEvaluator` | Stateless per call (takes `prev` as an argument). Four levels, ranked `good < degraded < unreliable < invalid` (`:28`); the worst trigger wins but **every** triggered reason is kept. Reason codes are machine-readable strings, e.g. `ACCURACY_ABOVE_25M`, `SAMPLE_GAP_ABOVE_3000MS`, `IMPOSSIBLE_JUMP`. |
| `track-matcher.ts:254` `TrackMatcher` | Stateful. Holds `lastMatch`, `previousPoint`, `lost`, `offCorridorCount`, and an audit counter. Projects with a **hinted** window (`:321`) around the last match, and every `auditIntervalSamples` (default 25) re-runs the **full** unhinted projection to measure `hintDisagreementM`, which feeds confidence (`:330-342`, `:391`). Confidence is an EMA (`confidenceEmaAlpha` 0.25) of a product of lateral, accuracy, hint-agreement, quality and regression scores. `onPitLane` is decided by `isOnPitLane` `:443`. |
| `along-track-filter.ts:217` `AlongTrackFilter` | Two-state linear Kalman filter (`s`, `v`) on the matcher's `unwrappedProgressM`. The 120-line header comment (`:1-124`) is the design document: why the **velocity** update is applied before the position update, where each noise constant comes from, and the measured `kappa` sweep table (`:85-91`). Every abnormal input **resets** rather than rejecting forever (`:114-123`); a reset clears `converged`, and an unconverged estimate is required by contract to be ignored. |

**Depends on:** `geometry/`, `profile/` (`RuntimeProfile`), `contracts.ts`. **Depended on by:** `controller/pipelineCore`, `calibration/calibration-engine`, `replay/replay-harness`, `coaching/distanceDomain`, and `timing/crossing-detector` (deep import of the filter).

---

### `timing/` — "did the car cross a line, when, and what lap does that make"

**Owns:** crossing detection (incl. the pit-ambiguity machine and crossing-instant refinement) and lap/sector assembly.

**Barrel (`timing/index.ts`):** `CrossingDetector` + types `CrossingDetectorConfig`/`PitAssessment`/`ProjectedGate`; `LapTimingEngine` + `PIT_AMBIGUOUS_REASON` + types `LapTimingEngineConfig`/`LapTimingProfile`.

> The package root re-exports the two classes and three types, renaming `ProjectedGate` → `TimingProjectedGate` (`index.ts:69-75`). `PIT_AMBIGUOUS_REASON` and `PitAssessment` do **not** reach the root — see Questions §7.1.

`crossing-detector.ts` (978 lines) is the densest file in the area. Its layout:

| Lines | Content |
|---|---|
| `:34-103` | `CrossingDetectorConfig` — every knob, each documented against the constant that defaults it. |
| `:105-300` | The constants, each with the measurement that justifies it. `DEFAULT_MIN_REARM_DISTANCE_M` 50 `:105`; `DEFAULT_MAX_STEP_M` 120 `:111`; `DEFAULT_MAX_STEP_SPEED_MPS` 90 `:128`; `DEFAULT_MAX_STEP_CEILING_M` 500 `:136`; `UNRELIABLE_CONFIDENCE_CAP` 0.3 `:137`; `DEFAULT_MAX_ALONG_TRACK_CORRECTION_M` 9 `:146`; the pit-evidence block `:147-300`. |
| `:331-418` | Class fields — the pit-evidence state machine is eleven of them. |
| `:545` `allowedStepM` | `min(ceiling, max(flat, speed × elapsed))`. |
| `:586` `resolvePitEvidence` / `:608` `observePitLane` | The evidence machine. |
| `:719` `observeAlongTrack` | Feeds the filter, swallowing any throw. |
| `:754` `crossingTime` / `:819` `safeCrossingTime` | Instant refinement, each branch degrading to the previous one. |
| `:832` `update` | The one public method beyond `reset()`. |

`lap-timing-engine.ts:102` `LapTimingEngine` — holds at most one `ActiveLap` (`:36`). Lap validity is a `Set<string>` of reason codes accumulated as the lap runs: `PIT_TRANSIT`, `PIT_AMBIGUOUS`, `REVERSE_TRAVEL`, `LOW_QUALITY`, `MISSED_SECTOR_GATE`, `DUPLICATE_SECTOR_GATE`, `SHORT_LAP`, plus anything pushed in through `markInvalid` (`:140` — e.g. `PAUSE_GAP` from the reducer, `LOW_QUALITY` from the pipeline's gap handling). `valid` is simply `invalidReasons.size === 0` (`:299`).

**Depends on:** `geometry/`, `matching/along-track-filter`, `contracts.ts`. **Depended on by:** `controller/pipelineCore`, `replay/replay-harness`.

---

### `calibration/` — the Learn lap

**Owns:** the `CalibrationEngine` (coverage, bias estimation, the acceptance verdict) and the pure builder for the durable attempt record.

**Barrel (`calibration/index.ts`):** `CalibrationEngine` + type `CalibrationConfig`; the four named acceptance bars + `DEFAULT_CALIBRATION_COVERAGE_BIN_M`; `buildCalibrationAttemptRecord`, `calibrationThresholds`, `explainCalibrationAttempt`, `resolveCalibrationOutcome`, `uncoveredGapOf` + type `CalibrationAttemptInput`. All of it reaches the package root (`index.ts:49-67`), with the constants exported separately because `CalibrationEngine` collides with the contract name.

`calibration-engine.ts:128` `CalibrationEngine` runs its **own private `TrackMatcher`** (`:452` `createMatcher`) rather than sharing the pipeline's. It keeps two accept sets:

- **tight** — `|lateralM| ≤ corridorWidthM`, capped at `MAX_ACCEPTED_POINTS` 10 000 (`:62`); overflow sets a sticky `calibrationOverrun` that force-fails `finish()`;
- **wide** — `|lateralM| ≤ LEARN_WIDE_CORRIDOR_M` 40 m (`:73`), retained so `finish()` can estimate a systematic bias and recompute coverage against bias-corrected positions. This is the D1 field fix for the 81–90 % coverage failure on an unvalidated OSM centerline.

`finish()` (`:362`) picks the bias estimator by sample count (`< 50` tight points → the median-anchored wide estimator `:589`, else the trimmed least-squares one `:552`), re-projects every wide sample with the bias subtracted, and recomputes coverage/lateral stats from whatever now falls inside the tight corridor. Only then does it apply the bars.

`calibrationAttempt.ts` is deliberately pure: *nothing in it reads a clock, a threshold table or a config* (`:26-30`). `SessionController` owns **when** an attempt starts/progresses/concludes; this file owns **what the row says**, so a record can be rebuilt verbatim from its own fields.

**Depends on:** `geometry/`, `matching/`, `profile/`, `contracts.ts`. **Depended on by:** `controller/sessionController`.

---

### `controller/` — the two orchestrators

**Barrel (`controller/index.ts`):** `createPipelineComponents`, `SessionPipelineCore` + 5 types; `SessionController`, `CUE_POSITION_TOLERANCE_M`, `TRACE_CHUNK_KEY_STRIDE`, `VOICE_LIFT_MAX_SEVERITY`, `decodeTraceChunkKey` + 10 types. Re-exported wholesale by the root (`index.ts:103`).

**`pipelineCore.ts` (401 lines).** Exists so the batch replay harness and the live controller can never drift on pipeline order (`:32-46`). `createPipelineComponents` (`:141`) is the *only* place the five engines are constructed. `SessionPipelineCore` (`:178`) owns the state-machine snapshot plus the engines, and exposes `ingest()` (`:260`), `dispatch()` (`:238`), `computeDelta()`, `currentLap()`, `setReference()`. Diagnostic arrays (`matches`, `rejectedSamples`, `stateHistory`) grow unbounded by default and are capped only when `boundedTelemetry` is set — the live controller sets it, replay does not (`:65-73`).

**`sessionController.ts` (3393 lines).** The production orchestrator. Roughly six concerns in one class, and the file is organised by them:

| Concern | Anchors |
|---|---|
| Live facade state | `FacadeStateCore` `:52`, `snapshotState` `:1055`, `subscribe` `:1042`, `emit` `:1050` |
| Session lifecycle | `start` `:1194`, `arm` `:1508`, `pause` `:1514`, `resume` `:1523`, `endSession` `:1544`, `dispose` `:1609`, `restoreFromCheckpoint` `:1651` |
| Calibration lifecycle | `finishCalibrationNow` `:1360`, `acceptCalibration` `:1375`, `proceedWithoutValidatedCalibration` `:1426`, `rejectCalibration` `:1457`, attempt records `:2154`/`:2192`/`:2213`/`:2235` |
| Sample handling | `handleSample` `:1846` |
| Raw-trace persistence | `TRACE_CHUNK_KEY_STRIDE` `:426`, `decodeTraceChunkKey` `:442`, `beginTraceRun` `:1995`, `flushRawTraceInternal` `:2403`, retry/retain `:2479-2586` |
| Durable writes | `persistInitialSessionRecord` `:2079`, `buildSessionSummary` `:2099`, `onLapCompleted` `:2928`, `writeLapCommit` `:2820`, checkpoint watermark `:2884` |

Also present and easy to miss: a GNSS watchdog (`WatchdogScheduler` `:313`, default 5 s timeout / 1 s poll) that restarts the provider on a stale sample, and the coaching-cue plumbing (`CUE_POSITION_TOLERANCE_M` `:260`, `VOICE_LIFT_MAX_SEVERITY` `:252`, `applyCueUpdates`) which belongs to the *other* half of core and is only hosted here.

**Depends on:** everything above, plus `coach/`, `coaching/suggestions`, `reference/`, `persistence/checkpointCodec`. **Depended on by:** `apps/mobile/src/session/realFacade.ts` and `composition.ts` only.

---

### `statemachine/` — one pure reducer

**Barrel:** `sessionReducer`, `createInitialSessionSnapshot`, types `SessionContext`/`SessionSnapshot`. `export *`'d by the root (`index.ts:77`).

240 lines, no dependencies beyond `contracts.ts`. `SessionContext` (`:37`) extends the contract's opaque `Record<string, unknown>` with `lapNumber`, `priorState`, `pendingInvalidReasons`, `gnssDegraded`, `calibrationConfidence`, `preflightFailureReasons`, `fatalMessage`. The header comment (`:1-33`) documents every decision the contract did not dictate.

**Depended on by:** `controller/pipelineCore` only.

---

### `profile/` — load-time validation and the projected runtime companion

**Barrel:** `CURRENT_SCHEMA_VERSION`, `circuitProfileSchema`, `migrateProfile`, `loadProfileFromJson`, `MAX_PROFILE_JSON_BYTES`, `validateProfile`, `makeTestProfile` + types `ProfileValidationResult`/`ProjectedGate`/`RuntimeProfile`/`TestProfileOptions`. `export *`'d by the root (`index.ts:30`).

The pipeline: `loadProfileFromJson` (`loader.ts:6`) → byte cap (1 MB, `:4`) → `JSON.parse` → `migrateProfile` (`migration.ts:23`) → `validateProfile` (`validation.ts:79`) → zod structural parse (`schema.ts:26`) → geometric checks → `{profile, runtime}`.

`RuntimeProfile` (`validation.ts:18`) is the *computed* companion: the `GeoProjection`, the centerline in local ENU, `cumulativeDistancesM`, and every gate projected with its `distanceM` along the centerline. It is what every engine actually consumes. It deliberately **drops** `corridorWidthM`, which is why `SessionControllerDeps` also carries the raw `CircuitProfile` (`sessionController.ts:531`, comment at `:215-222` of the head block).

Geometric acceptance rules, all in `validation.ts:96-197`: ≥50 centerline vertices; no consecutive vertices under 0.5 m; closing gap < 5 % of length; `totalLengthM` within 0.5 % of computed; `corridorWidthM` in [5, 60]; every gate endpoint within `3 × corridorWidthM` of the centerline; gates 2–100 m long; sector gates strictly ordered, ≥30 m apart and ≥30 m from start/finish; pit gate endpoints near **both** the centerline and the pit polyline.

`schemaVersion` is currently `1` and the only migration is `0 → 1` (`migration.ts:26-34`, renames `trackName` → `displayName`).

**Depended on by:** almost everything — `matching`, `calibration`, `catalog`, `controller`, `corners`, `coaching`, `replay`, `testloop`, `fixtures`.

---

### `catalog/` — the circuit registry

**Barrel:** `CircuitCatalogError`, `circuitCatalogKey`, `createCircuitCatalog`, `summarize` + types. `export *`'d by the root (`index.ts:31`).

139 lines. `createCircuitCatalog(entries)` (`catalog.ts:86`) re-serialises each raw entry and runs it through **the production loader** — so a bundled asset, a dev fixture and a device-learned `'ad-hoc'` circuit all pass the same validation. It is **fail-fast and all-or-nothing**: any invalid entry, or any duplicate `(circuitId, layoutId)`, throws `CircuitCatalogError` carrying every error (`:116`). Keys are `JSON.stringify([circuitId, layoutId])` (`:50`), chosen so punctuation in an id cannot collide. `get(circuitId)` without a `layoutId` succeeds **only when exactly one layout exists** (`:133-136`).

**Depended on by:** `apps/mobile` only — no other core module imports it.

---

## 3. The invariants, and what breaks if you violate them

### 3.1 One monotonic clock, per-process, never wall-clock

**Rule.** `LocationSample.tMono` (`contracts.ts:14`) and `TelemetrySample.tMonoMs` (`telemetry/contracts.ts:53`, "SAME monotonic clock as LocationSample — injected, never `Date.now()`") are the *same* clock. It is `MonotonicClock` (`contracts.ts:594`), implemented in the app as `performance.now()` (`apps/mobile/src/platform/clock.ts:31` `PerformanceNowClock`). `tUtc` exists on `LocationSample` but is explicitly *metadata only* (`contracts.ts:15`).

**Why.** `Date.now()` can jump backwards on an NTP correction. Under Hermes on iOS `performance.now()` derives from `mach_continuous_time()` — monotonic, and still advancing through brief device sleep (`clock.ts:12-17`).

**The sharp corollary: the origin resets every process launch** (`clock.ts:18-22`). A `tMono` from before an app kill and one from after are on different timelines and must never be subtracted.

**What breaks.**
- Two channels on different clocks → the OBD/GNSS join is silently misaligned and every derived channel-vs-distance number is wrong.
- Resuming an in-flight lap by diffing a fresh `performance.now()` against a stored `tMono` → an arbitrary, plausible-looking lap time. This is why `restoreFromCheckpoint` refuses to resume an open lap at all (see §5).
- Raw-trace chunks from two launches of the same session cannot be ordered by timestamp, which is why the chunk **key band** carries the ordering instead (`sessionController.ts:442` `decodeTraceChunkKey`, comment `:110-123`: discarding the band is what produced a chronologically scrambled export).

**Pinned by.** `quality-evaluator.ts:86-87` triggers `DUPLICATE_TIMESTAMP` / `NON_INCREASING_TIMESTAMP` as `invalid`; `interpolateCrossingTime` throws on `tCurr < tPrev` (`intersection.ts:114`).

### 3.2 A gate is directed; forward is right-to-left across A→B

**Rule.** `Gate.a`/`Gate.b` form a *directed* segment (`contracts.ts:38-39`). `crossingDirection(gateA, gateB, motionFrom, motionTo)` returns `'forward'` when `cross(B−A, motion) > 0` — i.e. motion from the gate's **right** half-plane to its **left** (`intersection.ts:73`, doc `:66-71`). It **throws** rather than guessing when the gate is degenerate, the motion is zero-length, or the motion is parallel to the gate (`:88-93`).

**Why.** A lap timer that counted both directions would double-count a car that wobbles across the line, and would count an out-lap rejoining backwards.

**What breaks.** Swap a gate's `a` and `b` in an asset and every lap on that circuit stops being counted: `LapTimingEngine.onCrossing` returns immediately for a non-forward event (`lap-timing-engine.ts:145`), and the reducer ignores reverse crossings in `armed`/`outLap`/`timing` (`reducer.ts:156`, `:171`, `:189`). Nothing errors; laps simply never appear.

**Pinned by.** `test/geometry/intersection.test.ts:83` "defines right-to-left motion across directed gate A->B as forward"; `test/statemachine/reducer.test.ts:459` "reverse-direction startFinish crossings never start or complete laps".

### 3.3 The honesty gates: `geometryStatus`, and what `'official'` unlocks

**Rule.** `CircuitProfile.geometryStatus ∈ {'official', 'community-derived', 'dev-only', 'ad-hoc'}` (`contracts.ts:57`, schema `profile/schema.ts:46`) is *the* field every honesty gate reads. `'ad-hoc'` means geometry **learned on device from one lap of driving** — never surveyed, never validated on track (`contracts.ts:50-56`).

| Consumer | Rule |
|---|---|
| `apps/mobile/src/session/analysisAssembly.ts:551` | `geometryValidated: circuit.profile.geometryStatus === 'official'` — **only `'official'`** unlocks advice. |
| `apps/mobile/src/session/testLoopGuards.ts:14,35` | The same predicate, named, for the live-cue gate. |
| `apps/mobile/src/session/sessionReport.ts:456` | Anything other than `'official'` adds an explicit caveat line to the exported report. |
| `packages/core/src/testloop/testLoopCircuit.ts:40` `isLearnedGeometry`, `:189` | A learned circuit writes `'ad-hoc'` as a **constant**, not a parameter. |

A learned circuit may be **timed and analysed but never advised on**. It still goes through `loadProfileFromJson` and the full validator, because the point is that one validation path serves every source (`profile/schema.ts:44-46`, `testloop/codec.ts:109`).

**A separate, parallel honesty gate:** `SessionCalibrationStatus` (`contracts.ts:423`) is three-valued — `'validated'` / `'unvalidated'` / `'unknown'` — precisely because the previous single boolean in a side log conflated "we know this ran on accepted calibration" with "we could not read the label". **The binding rule for every reader: `'unknown'` is never rendered, exported or summarised as calibrated** (`contracts.ts:420-422`). `'validated'` is assigned in exactly one place (`sessionController.ts:1375` `acceptCalibration`).

**What breaks.** Loosen the `=== 'official'` predicate anywhere and the app starts giving braking advice computed against a centerline traced from a single noisy lap. Default a missing `calibrationStatus` to `'validated'` and a session driven past a *rejected* calibration comes back from a crash wearing no warning at all — which is a bug the reviewer actually reproduced (`contracts.ts:400-422`, `sessionController.ts:1651` options doc).

### 3.4 A crossing is never deleted, only marked

**Rule.** `CrossingDetector` **always emits** a start/finish or sector crossing. Where any pit evidence bears on it, the event carries `pitAmbiguous: true` (`contracts.ts:121`), and `LapTimingEngine` turns that into a `PIT_AMBIGUOUS` invalid reason on **both** the lap the boundary closes and the lap it opens (`lap-timing-engine.ts:195` and `:226`).

**Why (this is the single most expensive lesson in the file).** `crossing-detector.ts:147-213` records three failed attempts to *decide* the question:

| Attempt | What it did | How it failed |
|---|---|---|
| P9 | Suppressed on one flagged fix | Deleted real laps — MotorPark lost one in six, silently, nothing stored |
| P9-FIX1 | Sustained evidence + timeout release | Broke both ways: a 6000 ms perturbation invented two laps from one 233.777 s pit transit; the same timeout deleted a real 101.453 s boundary |
| P9-FIX2 | Occupancy latch confirmed by a forward `pitEntry` | 27 invented unmarked laps one way, 34 deletions the other |

Each round the reviewer found a wider perturbation. The pit lane runs 12.4 m from the start/finish gate at MotorPark — *inside* the circuit's own 16 m corridor — and the OSM pit way and centerline way **share junction nodes**, so the question is not hard, it is **undecidable from the fixes**. Every threshold placed inside it trades one silent failure for the other.

**What that buys.** Not a better threshold — the removal of a failure class. "A real boundary can never be deleted" is trivially true because there is no code path left that deletes one (`:181-186`). Only "is it marked" remains, and that is a local decision on evidence the step already carries.

**What breaks if you re-add a `continue`.** `crossing-detector.ts:912-920` marks the exact line that used to read `if (assessment === 'pit') continue;`. Restore it and you restore the whole P9 family of silent lap loss.

**Also: any evidence marks, and absence of evidence is not clearance.** `stepAssessment` (`crossing-detector.ts:886`) ORs six independent signals: the raw flag at either bracketing fix, standing evidence at either bracketing fix, a pending `pitEntry`, or a forward `pitEntry` crossed earlier in this same step. Reading "one flagged fix with no latch behind it" as clearance was the reviewer's first HIGH.

**Pinned by.** `test/timing/p11c-pit-never-deletes.test.ts:399` "(a) no perturbation deletes a real boundary, on either circuit" (a swept property test) and `:440` "(b) added boundaries are marked, except the nine disclosed above"; `test/timing/p11c-pit-marking.test.ts:167` "the pit rule changes marks, never boundaries", `:416` "one flagged fix on the line: the lap is kept AND marked".

### 3.5 The calibration acceptance bars are named constants, and the record states them

**Rule.** The four bars live in `calibration/calibration-engine.ts` as exported constants and are applied in `finish()`:

| Constant | Value | Failure reason | Applied |
|---|---|---|---|
| `CALIBRATION_MIN_COVERAGE_FRACTION` `:85` | 0.85 | `INSUFFICIENT_COVERAGE` | `:431` |
| `CALIBRATION_MAX_UNCOVERED_GAP_M` `:87` | 250 m | `COVERAGE_GAP` | `:435` |
| `CALIBRATION_MIN_OBSERVED_RATE_HZ` `:89` | 0.5 Hz | `RATE_TOO_LOW` | `:434` |
| `CALIBRATION_MAX_REJECTED_FRACTION` `:91` | 0.5 | `POOR_GNSS` | `:433` |

Plus two more verdicts with no constant: `WRONG_DIRECTION` (`:432`) and `CALIBRATION_OVERRUN` (`:436`, the sticky 10 000-point cap). And separately, `CALIBRATION_COMPLETE_COVERAGE_FRACTION = 0.98` (`sessionController.ts:349`) — the **controller's** force-finish trigger, not an acceptance bar.

**Why named.** Every value is the literal that was already inline; nothing changed by extracting them (`:75-84`). They are exported so `CalibrationAttemptRecord.thresholds` (`contracts.ts:220`) can state *the numbers this attempt was judged against* rather than a copy that could drift. `calibrationThresholds()` (`calibrationAttempt.ts:281`) is the one place they are assembled.

**What breaks.** Restate a bar as a literal anywhere else and a stored record can contradict the refusal it explains — which is the specific failure `uncoveredGapLengthM` was added to fix (`contracts.ts:146-158`: exporting the *clamped* span as "the gap" under-reports a gap that wraps the start/finish line, so the record said one thing and the engine judged another).

**Corollary invariant — every attempt leaves a record.** `contracts.ts:178-193`: the owner lost a track day to a Learn lap parked at ~83 % coverage that produced no verdict and wrote nothing. A row is now written when the lap **starts**, rewritten every 5 % of coverage (`sessionController.ts:503` `CALIBRATION_ATTEMPT_COVERAGE_STEP`), and rewritten on conclusion — whatever the conclusion, **including Cancel**, which is recorded as an outcome and never as an absence (`contracts.ts:209-211`, `sessionController.ts:1457`).

**Pinned by.** `test/calibration/calibration-engine.test.ts:271` (insufficient/discontinuous coverage), `:282` (wrong direction), `:292` (POOR_GNSS relaxed to the wide accept set), `:320` (rate), `:354` (`CALIBRATION_OVERRUN`), `:507` (a genuine 700 m dropout still fails, gap pointing at the missing stretch).

### 3.6 Optional repository methods mean "cannot", never "there were none"

**Rule.** `LocalSessionRepository` (`contracts.ts:489`) has four *required* methods and several **optional** ones: `saveLapCommit?` `:543`, `saveLapValidityVerdict?` `:561`, `listLapValidityVerdicts?` `:563`, `listLapValidityVerdictsWithDiagnostics?` `:570`, `saveCalibrationAttempt?` `:577`, `listCalibrationAttempts?` `:579`, `listCalibrationAttemptsWithDiagnostics?` `:581`.

**Why optional.** Not every store can offer them — a test double, or the web preview's stand-in. Both first-party repositories implement them.

**The binding reader rule.** A reader that finds one absent must report the data as **UNAVAILABLE**, never as empty (`contracts.ts:555-559`). `'unanswered'` and "we could not ask the store" are different facts. The `*WithDiagnostics` variants exist for exactly the same reason one level down: `StoredRecordRead<T>` (`contracts.ts:483`) returns `unreadableCount` so a caller can say "this section FAILED" rather than "this section is empty".

**What breaks.** Report an absent optional as an empty list and a corrupt database looks like a clean one. `saveLapCommit` in particular: with it, a lap's telemetry and its checkpoint commit atomically; without it, the controller falls back to **checkpoint-first, telemetry-second** — the safe order, because a checkpoint naming a lap whose telemetry never landed merely reserves a lap number, whereas the reverse leaves a committed lap row the next run's numbering overwrites. The reviewer measured that overwrite at **93 lost fixes** (`contracts.ts:513-526`).

### 3.7 The checkpoint is monotonic, and the comparison is inside the transaction

**Rule.** An implementer of `saveLapCommit` **must** replace the stored checkpoint only when the incoming one supersedes it — strictly more laps — and **must** make that comparison inside the same transaction as the write (`contracts.ts:527-541`). `checkpointSupersedes` in `persistence/checkpointCodec` is the shared predicate; the controller mirrors it with a per-session watermark (`sessionController.ts:2884` `noteCheckpointGeneration`, `:2820` `writeLapCommit`).

**What breaks.** The controller **retries** a failed lap commit with the checkpoint it captured at the time. Without the rule, a lap-1 retry landing after lap 2 committed rolls the stored checkpoint back to `[1]`, and the next launch re-makes the completed lap 2 as a zero-duration `RECOVERY` lap.

---

## 4. Things that will surprise you

### 4.1 `interpolateCrossingTime` has a *strict-interior* contract, enforced by bit-twiddling

`geometry/intersection.ts:112`. For `t ∈ (0,1)` and `tCurr > tPrev`, the result is guaranteed **strictly** between the endpoints — and IEEE-754 rounding can collapse a mathematically interior result onto an endpoint, so the function nudges it to the adjacent representable float via `adjacentFloat` (`:98`, a `DataView`/`BigUint64` ULP step) and throws if the interval has no representable interior at all (`:128`).

Why it matters: `tCross === tPrev` would make a lap boundary coincide with the previous sample, and `LapTimingEngine` rejects `event.tCross < lap.lastEventTime` (`lap-timing-engine.ts:154`) and `tCross <= lap.tStart` (`:155`). A collapsed interpolation silently drops a lap boundary. Pinned by `test/geometry/intersection.test.ts:115` "is strictly inside the timestamp interval for every t in (0, 1)" (a fast-check property).

### 4.2 The crossing-*time* refinement refuses to run without real Doppler — the filter itself does not

This is subtler than it sounds and worth getting right.

- The `AlongTrackFilter` **is position-capable**: it works with no speed channel at all, "just more slowly and less well" (`test/matching/along-track-filter.test.ts:178`), and `CrossingDetector.observeAlongTrack` feeds it every fix regardless (`crossing-detector.ts:719`).
- The **gate** is in `crossingTime` (`crossing-detector.ts:754`, comment `:815-822` of the source / `:61-70` of the method body): if `usableDopplerMps` is `null` at **either** bracketing raw sample, the instant is bit-identical pre-P8 linear interpolation and *neither* refinement runs.
- **Why the gate is there and not lower:** the stated contract was "no valid Doppler at both fixes ⇒ identical to linear". It wasn't true — at 10 Hz with no speed channel the filter still *converged* and fed its own **inferred** velocities into the kinematic model, producing 9946.9 ms where linear gave 9938.5 ms, with both diagnostic counters incremented. Neither refinement may run on inferred speed.
- `usableSpeed`/`usableDopplerMps`: iOS reports `CLLocation.speed = -1` when it has no Doppler solution and the provider copies it through verbatim, so **negative and zero speeds reach these modules**; anything not finite-and-positive counts as absent (`intersection.ts:142-147`, `crossing-detector.ts:301-310`, `along-track-filter.ts:210-215`).

### 4.3 The step ceiling: what it protects, and what it costs

`crossing-detector.ts:545` `allowedStepM` = `min(500, max(120, 90 × elapsedSeconds))`.

- **Flat 120 m** (`:111`) is the nominal-interval bound: at 1 Hz that is ~432 km/h.
- **Time-scaled at 90 m/s** (`:128`) exists because the flat bound *was the bug*: at 150 km/h a 3 s dropout is ~126 m, so the step was discarded, the segment containing the start/finish line was never tested, and **the lap was silently lost**. Widening the flat constant would have weakened the check for every 0.1 s step too.
- **The 500 m ceiling** (`:136`) is the cost. Past ~10 s of dropout the straight line between two fixes stops approximating a driven path at all — it can chord across a chicane or an infield and intersect a gate the car never went near. Beyond the ceiling the step is refused **however plausible its implied speed**. So: a >10 s GNSS outage across the line loses that lap boundary, deliberately, to avoid inventing one.
- Refusals are no longer silent: `skippedSteps` / `widestSkippedStepM` (`:346-347`, read via `stepDiagnostics()` `:518`). **Nothing consumes them yet** — `SessionPipelineCore` owns the detector privately.

Pinned by `test/timing/crossing-detector.test.ts:124` — the whole `P7M M4` block, including `:133` "the SAME 126 m step across a nominal 1 s interval is still refused" and `:145` "past the 500 m ceiling a step is refused even at a plausible implied speed".

### 4.4 The re-arm gate is keyed on *forward* progress but suppresses *both* directions

`crossing-detector.ts:932`, the `lastForwardProgressByGate` check inside `update`. Only a forward crossing writes the map, but the suppression test applies to every crossing on that gate. So a reverse crossing occurring less than `minRearmDistanceM` (50 m) of along-track progress after a forward one is **not emitted**. A reverse crossing with no prior forward one *is* emitted. Both behaviours are pinned: `test/timing/crossing-detector.test.ts:87` line 91 (reverse suppressed inside the rearm window) and `:98` "reports reverse crossings without consuming forward rearm state".

### 4.5 Pit detection exists in *three* independent places with three different rules

| Where | Rule | Purpose |
|---|---|---|
| `TrackMatcher.isOnPitLane` `matching/track-matcher.ts:443` | Single-sample geometry: within `pitCorridorWidthM`, **and** nearer the pit polyline than the centerline **by more than `pitPreferenceMarginM` = 4 m**. No debounce at all. | Sets `TrackMatch.onPitLane` |
| `SessionPipelineCore` `controller/pipelineCore.ts:326-345` | A forward `pitEntry` crossing arms a pending state; **≥2** consecutive `onPitLane` matches with `|lateralM| ≥ 5` then dispatch `PIT_ENTERED`; the pending state expires after 200 m of progress. | Drives the `inPit` **session state** |
| `CrossingDetector.observePitLane` `timing/crossing-detector.ts:608` | Standing evidence: flag up for 2000 ms across ≥2 fixes; released only by a forward `pitExit` **or** 200 m (800 m while a `pitEntry` is pending) of progress with the flag continuously down across ≥3 fixes over 6000 ms. | Decides `pitAmbiguous` marking |

The 4 m margin is chosen from measured asset geometry from both sides (`track-matcher.ts:34-63`): below the smallest margin any fix of a genuine pit transit shows (TMR 4.9 m, MotorPark 5.1 m), above ~1σ of the ambiguity it rejects. A **negative** margin is refused at construction (`:286-293`) because that is the one direction this must never go. The 800 m confirmed-clear range (`crossing-detector.ts:294`) is bounded above *and* below by the two circuits — 720 m (longest pit lane) < 800 < 881.5 m (TMR pit exit to next timing gate) — a 161 m window, so it is not a tuning parameter with a comfortable value picked out of it.

And the deliberate asymmetry in `sessionController.ts:1892-1960`: cue **display** suppression uses the conservative OR (`confirmedInPit || match.onPitLane`), but the **stint latch** reacts *only* to the debounced session state, because one noisy sample latching and un-latching re-armed the one-change-per-corner allowance with no real pit stop at all.

### 4.6 `LapTimingEngine.markInvalid` is not on the contract

`contracts.ts:368` declares only `reset`, `onCrossing`, `currentLap`. The concrete class adds `markInvalid(reason)` (`lap-timing-engine.ts:140`), which is how the pipeline injects `LOW_QUALITY` on a sample gap and how the reducer's `pendingInvalidReasons` (e.g. `PIT_TRANSIT`, `PAUSE_GAP`) reach a lap at all (`pipelineCore.ts:245` `invalidateActiveLap`, `:251` `syncInvalidReasons`). Anyone typing against the interface loses that path entirely.

### 4.7 The matcher periodically doubts itself, on purpose

Hinted projection is an optimisation, but a hint that has walked away from reality would never be caught by a hinted search. So every `auditIntervalSamples` (default 25) the matcher runs the **full** unhinted projection and records the disagreement (`track-matcher.ts:330-342`). That disagreement is not an error path — it is folded into confidence as `disagreementScore` (`:391`), floored at 0.15 (`:399`). Lost tracking (`offCorridorLimit` = 5 consecutive off-corridor fixes, `:366`) drops the hint entirely until a match lands back inside.

### 4.8 `CalibrationEngine` is a *parallel* consumer, not a pipeline stage

It builds its own `TrackMatcher` and its own `TelemetryQualityEvaluator` (`calibration-engine.ts:452`, `:185`) and is fed directly from `handleSample` before the pipeline branch. During `mode === 'calibrating'` **no sample reaches `SessionPipelineCore` at all** (`sessionController.ts:1859-1883`). Consequences: the crossing detector, the timing engine and the state machine see nothing of the Learn lap, and `progress().coverageFraction` (tight corridor, live) can legitimately be **lower** than the final `finish()` coverage (bias-corrected) — documented at `calibration-engine.ts:293-303`.

### 4.9 `projectOntoPolyline` returns `0`, not `totalLength`, at the wrap point

`polyline.ts:198`: `closed && rawDistance >= totalLength ? 0 : rawDistance`. Callers that compare distances near the start/finish line must use circular distance, not subtraction — which is why `circularDistance` is reimplemented locally in `polyline.ts:97`, `track-matcher.ts:98` and `profile/validation.ts:74`.

### 4.10 The reducer's `context` is contractually opaque and structurally typed into shape

`SessionMachineSnapshot.context` is `Record<string, unknown>` (`contracts.ts:313`). `SessionContext` (`reducer.ts:37`) adds real fields plus an index signature (`:47`) purely to stay assignable. Consumers therefore read `snapshot.context.pendingInvalidReasons` with a runtime `Array.isArray` check (`pipelineCore.ts:252`) rather than trusting the type.

### 4.11 `lapNumber` is carried redundantly at two levels, kept in sync by hand

`SessionMachineSnapshot.lapNumber` and `context.lapNumber` (`reducer.ts:8-10`, `:72-74`). And the live display number is offset separately again — `SessionController.lapNumberOffset` (assigned `sessionController.ts:1737`, applied in `snapshotState` `:1055`) — because a recovered session must not renumber back to 1. Three places, one number.

---

## 5. State and lifecycle

### 5.1 The session state machine

Twelve states (`contracts.ts:299`), sixteen event types (`:303`). The reducer is pure, deterministic, never mutates its input, and returns the **same object reference** for an illegal event (`reducer.ts:31-33`).

```
idle ──START_PREFLIGHT──▶ preflight ──PREFLIGHT_PASSED──▶ awaitingCalibration
                             ▲ PREFLIGHT_FAILED (self)              │
                                                       CALIBRATION_STARTED
                                                                    ▼
                          calibrationReview ◀──CALIBRATION_FINISHED── calibrating
                            │            │                              │
             CALIBRATION_   │            │ CALIBRATION_REJECTED         │ PAUSE
             ACCEPTED       ▼            └──────────▶ awaitingCalibration
                          armed
                            │ CROSSING fwd startFinish ──▶ timing (lap 1)
                            │ CROSSING fwd other       ──▶ outLap
                            ▼
   outLap ──CROSSING fwd startFinish──▶ timing ──CROSSING fwd startFinish──▶ timing (lap+1)
      │                                    │
      │ PIT_ENTERED                        │ PIT_ENTERED / GNSS_LOST / GNSS_RECOVERED (self)
      ▼                                    ▼
    inPit ──PIT_EXITED──▶ outLap (+ PIT_TRANSIT)
```

| From | Event | To | Line |
|---|---|---|---|
| `idle` | `START_PREFLIGHT` | `preflight` | `reducer.ts:101` |
| `preflight` | `PREFLIGHT_PASSED` / `PREFLIGHT_FAILED` / `START_PREFLIGHT` | `awaitingCalibration` / `preflight` / `preflight` | `:110-115` |
| `awaitingCalibration` | `CALIBRATION_STARTED` | `calibrating` | `:123` |
| `calibrating` | `CALIBRATION_FINISHED` / `PAUSE` | `calibrationReview` / `paused` | `:132-135` |
| `calibrationReview` | `CALIBRATION_ACCEPTED` / `CALIBRATION_REJECTED` | `armed` / `awaitingCalibration` | `:143-146` |
| `armed` | forward `startFinish` `CROSSING` / other forward `CROSSING` / `PAUSE` | `timing` (lap 1) / `outLap` / `paused` | `:154-161` |
| `outLap` | forward `startFinish` / `PIT_ENTERED` / `PAUSE` | `timing` (lap 1) / `inPit` / `paused` | `:169-179` |
| `timing` | forward `startFinish` / `PIT_ENTERED` / `PAUSE` / `GNSS_LOST` / `GNSS_RECOVERED` | `timing` (lap+1) / `inPit` / `paused` / `timing` / `timing` | `:187-201` |
| `inPit` | `PIT_EXITED` / `PAUSE` | `outLap` (+`PIT_TRANSIT`) / `paused` | `:209-212` |
| `paused` | `RESUME` | `context.priorState` (+`PAUSE_GAP` if resuming into `timing` with `gapMs > 30000`) | `:220-228` |
| any | `FATAL` | `error` | `:88-90` |
| any non-`idle` | `END_SESSION` | `sessionComplete` | `:93-96` |
| `sessionComplete`, `error` | anything but `FATAL` | unchanged | `:235-238` |

Notes worth knowing:
- `ARMED` is a **declared event with no semantics anywhere** — the happy path reaches `armed` via `CALIBRATION_ACCEPTED`. It is treated as illegal in every state (`reducer.ts:21-23`).
- `GNSS_LOST`/`GNSS_RECOVERED` are meaningful **only while `timing`**; ignored elsewhere (`:24-26`).
- `pendingInvalidReasons` is cleared only when a *new* lap begins (`startLap` `:80-82`), so a `PIT_TRANSIT` recorded during a pit stop survives the stop and lands on the next lap that actually starts timing.
- `PAUSE_GAP` is strictly `> 30000` (pinned: `test/statemachine/reducer.test.ts:565`).

**Who drives transitions.** Only `SessionPipelineCore.dispatch` (`pipelineCore.ts:238`) calls `sessionReducer`. Its callers: `ingest` (synthesised `PAUSE`/`RESUME`/`GNSS_*` from timestamp gaps, `CROSSING` per detected event, `PIT_ENTERED`/`PIT_EXITED` from the pit logic) and `SessionController` (`START_PREFLIGHT`, `PREFLIGHT_PASSED`, `CALIBRATION_*`, `PAUSE`/`RESUME`, `END_SESSION`).

### 5.2 Cold start vs recovery resume

**Cold start** — `SessionController.start('calibration')` (`sessionController.ts:1194`):
1. `disposed` re-checked after **every** await (`:1207`, `:1272`, `:1294`) — a start is not instantaneous and the controller reports `idle` for the whole window, so a circuit change or delete-all can legally dispose mid-start.
2. Mint session id, reset stint/cue state, `beginTraceRun()`, `resetTrackMatch()`.
3. `await ensureProviderRunning()` — **and only after it resolves** are any state-machine dispatches or the mode change performed (`:1170-1192` explains why: doing it the other way round left a failed start mutated into `'calibrating'` with a duplicate sample listener on retry).
4. `START_PREFLIGHT` → `PREFLIGHT_PASSED` → new `CalibrationEngine` → `calibrationStatus = 'unknown'` → `CALIBRATION_STARTED` → `mode = 'calibrating'` → `beginCalibrationAttempt()` (the attempt row is durable from **here**, not from its conclusion).
5. Start watchdog, `persistInitialSessionRecord()` — the session is discoverable from the first fix, not from the first lap.

**A cancel that lands during that window** is recorded, not dropped: `rejectCalibration()` sets `calibrationStartCancelled` while `calibrationStartInFlight` (`:1457`, `:1462-1468`), and `start()` consumes it at its next await checkpoint and unwinds identically to a disposal (`:1281-1296`).

**Recovery** — `restoreFromCheckpoint(sessionId, snapshot, laps, options)` (`sessionController.ts:1651`). What it does **differently**:

| | Cold start | Recovery |
|---|---|---|
| In-flight lap | n/a | **Never resumed.** A lap open at checkpoint time (state `outLap`/`timing`/`inPit`, or `paused` with one of those as `priorState`) is appended as a zero-duration, explicitly invalid `RECOVERY` lap rather than a fabricated time — because the old `tMono` is on a dead timeline (§3.1). |
| Lap numbering | `initialLapNumber` 1 | `lapNumberOffset = max(checkpoint lap numbers, in-flight lap number, **storedLapNumbers**) `; the new pipeline is built with `timing.initialLapNumber = offset + 1`. `storedLapNumbers` is what storage actually holds — a database interrupted before the atomicity fix can hold lap 1's fixes with a checkpoint naming no laps, and reusing lap 1 would replace that row. |
| Calibration provenance | `'unknown'` until accepted | `mergeCalibrationStatus(carriedStatus, options.calibrationStatus)` (`:1749`). **Monotonic**: an incoming `'validated'`/`'unvalidated'` always wins; an incoming `'unknown'` can never overwrite a known carried value, because `'unknown'` is absence of information, not information. The option is **mandatory**, not optional, so a caller that forgets it is a compile error. |
| Checkpoint watermark | starts at nothing | seeded from the restored checkpoint's generation (`checkpointGeneration(laps)`), **raised never lowered** |
| Trace keys | new run band | **new run band, same session id** — which is what stops this run's chunks overwriting the pre-crash ones |
| Coaching/cue state | fresh | explicitly cleared: `currentCue = null`, `coachEngine.reset()`, `cueGeneration += 1`, `stintIndex = 0`, overrides cleared |
| Resulting state | `calibrating` | `awaitingCalibration` — **a fresh Learn lap is required before timing resumes** |

**Resume without recalibrating** is a *separate* call: `start('session')` (`sessionController.ts:1263-1277`). It loads the stored reference lap, then synthesises `CALIBRATION_STARTED` → `CALIBRATION_FINISHED(recoverySkippedCalibrationResult())` → `CALIBRATION_ACCEPTED` to reach `armed` legally, and sets `calibrationStatus = restoredCalibration ?? 'unknown'` — it performs no calibration, so it makes no new claim about one.

**The calibration escape hatch** — `proceedWithoutValidatedCalibration()` (`:1426`). Covers **two** states, not one, and the doc comment (`:1389-1425`) explains why: a Learn lap stuck below the 0.85 acceptance bar never reaches `calibrationReview` at all, because review requires 0.98 coverage. It does not fail; it simply never finishes, and the only control left is Cancel. That is the failure that cost a track day. So from `calibrating` it force-finishes through the engine's own `finish()` (no threshold lowered or skipped), then: engine accepted → ordinary `acceptCalibration()`, labelled nothing special; engine rejected → `calibrationStatus = 'unvalidated'`, persisted immediately, session armed anyway.

**Teardown** — `endSession()` order is binding (`:1533-1542`): conclude any open calibration attempt (as `'stalled'`) → stop provider → `END_SESSION` → **final** raw-trace flush (forces one last attempt on every retained batch, ignoring backoff and attempt caps) → `await flush()` → `recordingFinalized = true` → `saveSession` → terminal checkpoint. `flush()` rejecting **propagates** rather than being swallowed, so it reaches the facade's error path instead of leaving `sessionComplete` un-emitted.

---

## 6. What is *not* here

| Concern | Lives in | Why not in core |
|---|---|---|
| GNSS acquisition | `apps/mobile/src/platform/gnssLocationProvider.ts` | `LocationProvider` is a dependency-inverted interface; core never imports Expo |
| The monotonic clock impl | `apps/mobile/src/platform/clock.ts` (`PerformanceNowClock`) | `MonotonicClock` is injected; core must stay testable with a fake clock |
| Permissions, preflight checks | `apps/mobile/src/platform/permissions.ts`, `preflight.ts` | Platform APIs |
| App lifecycle / background | `apps/mobile/src/platform/lifecycle.ts` | Platform APIs |
| SQLite driver, DDL execution | `apps/mobile/src/persistence/expoSqlDatabase.ts`, `telemetrySchema.ts` | `packages/core/src/persistence-sql` holds the *portable* SQL repository; the driver is platform |
| The circuit assets themselves | `apps/mobile` asset bundle, loaded through `createCircuitCatalog` | Core validates; the app supplies bytes |
| Honesty gate *enforcement* | `apps/mobile/src/session/analysisAssembly.ts:551`, `testLoopGuards.ts`, `sessionReport.ts:456` | Core supplies `geometryStatus`; the app decides what to render or unlock |
| The session facade / view models | `apps/mobile/src/session/facade.ts`, `realFacade.ts`, `composition.ts` | `FacadeStateCore` (`sessionController.ts:52`) is the core-side projection the app maps 1:1 |
| Recovery orchestration (which session to offer, reading `storedLapNumbers`) | `apps/mobile/src/session/composition.ts` `resumeRecovery()` | Core exposes `restoreFromCheckpoint`; deciding *whether* to resume is a UX decision |
| Invalid-reason display copy | `apps/mobile/src/ui/screens/invalidReasonCopy.ts` | Core emits machine codes only |
| Learned-circuit capture | `packages/core/src/testloop/` (still core, different half) | Produces a `'ad-hoc'` `CircuitProfile` through the same loader |
| Corner analysis, braking zones, coaching cues | `packages/core/src/{corners,coach,coaching}/` | The *other* half of core; hosted by `SessionController` but not part of the timing path |
| Reference lap, PB rule, live delta | `packages/core/src/reference/` | Consumes `LapRecord`s; downstream of timing |
| OBD/telemetry channels | `packages/core/src/telemetry/`, `signal/`, `fusion/` | Shares only the clock invariant (§3.1) |

---

## 7. Questions and suspicions

> Recorded, **not fixed**. Each is evidence plus a specific question, for another phase to investigate.

**7.1 — Three timing-module exports do not reach the package root, and the app has duplicated one by hand.**
`timing/index.ts:1-8` exports `PIT_AMBIGUOUS_REASON` and the `PitAssessment` type, but the root barrel (`index.ts:69-75`) re-exports only `CrossingDetector`, `LapTimingEngine`, and four types. Likewise `matching/index.ts:8-13` exports `AlongTrackFilter` and its three types, and the root (`index.ts:42-47`) does not. Consequence observed: `apps/mobile/src/ui/screens/invalidReasonCopy.ts:28` hardcodes the string literal `PIT_AMBIGUOUS` as an object key rather than importing the constant. Nothing is broken today — the literal matches — but the constant and its only consumer can now drift silently. **Question:** is the omission deliberate (keeping `AlongTrackFilter` internal is defensible; keeping `PIT_AMBIGUOUS_REASON` internal seems less so), or an oversight when the explicit re-export lists were written? *Risk: low-to-moderate — a string-literal coupling across a package boundary with no compile-time link.*

**7.2 — A doc comment states the wrong acceptance bar.**
`sessionController.ts:335-347` (the claim is at `:337-339`): "Deliberately set ABOVE `CalibrationEngine.finish()`'s own **>=95%** `INSUFFICIENT_COVERAGE` bar ... finishing the instant coverage first crosses **95%** cuts the lap short". The actual bar is `CALIBRATION_MIN_COVERAGE_FRACTION = 0.85` (`calibration-engine.ts:85`, applied `:431`). The 0.98 constant and its *reasoning* are unaffected — 0.98 > 0.85 just as it is > 0.95 — but the comment is the only place a reader learns the relationship between the two numbers, and it names a value that does not exist. The 0.85/0.98 gap is also exactly the gap that produces the "never finishes, only Cancel is left" failure the escape hatch exists for (`sessionController.ts:1399-1402`, which *does* quote 0.85 correctly). **Question:** was the acceptance bar lowered from 0.95 to 0.85 (the D-series field fixes) without updating this comment? *Risk: documentation only, but it is documentation someone will reason from.*

**7.3 — `stepDiagnostics()` has no consumer.**
`crossing-detector.ts:337-341` says so explicitly: "Nothing consumes it yet (`SessionPipelineCore` owns the detector privately and is outside this ticket's write set); it exists so the next investigation of a missing lap can be answered instead of guessed at." Same for `pitEvidenceDiagnostics()` (`:489`) and `timingDiagnostics()` (`:528`) — I found no reader in `packages/core/src` or `apps/mobile/src`. So the record that a fix gap big enough to have skipped the line actually happened exists in memory and is discarded at session end. **Question:** should these reach `SessionControllerDiagnostics` (`sessionController.ts:262`) and the session export? *Risk: moderate — this is the instrumentation for the exact failure mode (§4.3) that has already cost laps, and it currently cannot be read off a device.*

**7.4 — `WideSample.distanceM` / `lateralM` / `unwrappedProgressM` look unread.**
`calibration-engine.ts:39-44` defines four fields; `finish()` (`:378-410`) and `wideObservations()` (`:616`) both re-project from `localPoint` alone. I traced no read of the other three. If correct, `recordWideSample` (`:639`) is storing three numbers per fix, up to 10 000 fixes, for nothing. **Question:** dead fields, or a reader I missed? *Risk: low (memory only), but worth confirming before trusting the struct's doc comment, which describes them as load-bearing.*

**7.5 — `pointAtDistanceM` has a suspicious terminal branch.**
`calibration-engine.ts:342-360`. The loop condition `if (normalized <= endM || index === centerline.length - 1)` means the **last** iteration always returns regardless of `normalized`, and the trailing `return centerline[0] as LocalPoint` is unreachable except for an empty centerline (where the cast lies). The function is used only for the live track-map dot, so a wrong answer is cosmetic — but the `as LocalPoint` cast on a possibly-`undefined` value is the kind of thing that survives until it doesn't. **Question:** intended, or a leftover from an earlier loop shape? *Risk: low.*

**7.6 — `LapTimingEngine.markInvalid` is load-bearing and off-contract.**
Stated as a surprise in §4.6, repeated here as a question: `contracts.ts:368` does not declare it, yet `PAUSE_GAP`, `PIT_TRANSIT` and gap-derived `LOW_QUALITY` reach a lap **only** through it. Any alternative implementation written against the published interface would silently produce laps that are never invalidated for those reasons. **Question:** should the contract declare it (required or optional-with-a-documented-reader-rule, as §3.6 does elsewhere)? *Risk: moderate — it is a real hole in the binding interface, in a codebase that is otherwise meticulous about exactly this.*

**7.7 — `LapRecord.invalidReasons` has no enumerated type.**
It is `string[]` (`contracts.ts:324`) with examples in a comment. The producers are spread across `lap-timing-engine.ts` (7 codes), `pipelineCore.ts`, `reducer.ts` (`PIT_TRANSIT`, `PAUSE_GAP`) and `sessionController.ts` (`RECOVERY`). The consumer that must render all of them is `apps/mobile/src/ui/screens/invalidReasonCopy.ts`. **Question:** is a union type wanted, or is open-endedness deliberate so a new reason cannot break a stored record's round-trip? *Risk: low — but it is the mechanism behind 7.1.*

---

## 8. What I did not read, and what I am not sure of

Stated plainly so nobody mistakes a blank for a clean bill of health.

- **`controller/sessionController.ts` beyond the structural skim.** I read the header block, the constants, `start`, `finishCalibrationNow`, `acceptCalibration`, `proceedWithoutValidatedCalibration`, `rejectCalibration`, `endSession`, `restoreFromCheckpoint`, `handleSample`, `writeLapCommit` and the method index. I did **not** read line-by-line: the coaching-cue update machinery (`applyCueUpdates`, `verifyCueEvidence` integration, `CueUpdateRejection` paths, roughly `:2950-3393`), `snapshotState`, the watchdog implementation, `flushRawTraceInternal` and the retain/retry helpers in detail, `loadReferenceForSession`, or the PB-replacement path. Anything I say about those is from doc comments, not from the code.
- **`geometry/densify.ts` and `geometry/curvature.ts`** I read only the header and the exported signatures. They are asset-generation code, off the runtime timing path; I did not verify their algorithms.
- **`profile/test-fixture.ts`** I did not read (70 lines, test-only).
- **`calibration/calibrationAttempt.ts:124-295`** — I read `explainCalibrationAttempt`'s doc and opening but not all of its sentence construction, nor `buildCalibrationAttemptRecord` in full.
- **Test files** I read only names and a handful of bodies (the direction convention, the rearm/reverse behaviour, the strict-interior property). Where I cite a test as "pinning" an invariant, I am citing its **name and location**, which I verified; I did not in every case read its assertions.
- **I ran no builds and no tests**, per the task constraints. Nothing here is verified by execution.
- **Line numbers** were taken from the working tree at `4676545` with two files (`hardware/kicad/*`) modified and no source files dirty. Where a number came from arithmetic on a concatenated dump rather than a direct grep, I re-verified it against `grep -n` on the exported symbol; the few in-method line references inside `crossing-detector.ts`'s `update` and `sessionController.ts`'s long methods are approximate and should be located by the quoted comment text instead.
- **`fusion/`, `signal/`, `replay/`, `persistence/`, `persistence-sql/`, `reference/`, `coach/`, `coaching/`, `corners/`, `testloop/`, `fixtures/`** were out of scope. I touched them only to establish who depends on the modules in scope. The claim "`catalog/` is consumed only by `apps/mobile`" and the dependency lists in §2 come from `grep` over import paths and are as good as that method — a dynamic or re-exported import would not show up.
