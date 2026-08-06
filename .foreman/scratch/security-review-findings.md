# Security & Privacy Review — Track-Session App (Circuit Timer)

Reviewed at HEAD `4f39338`. Scope: `packages/core/src`, `apps/mobile/src`, `app.json`, `package.json` files, per `docs/architecture/contracts.md` and `docs/decisions/ADR-0001..0004`. Read-only review; no files changed except this report.

Context taken as given: offline-first GNSS lap timer, iOS-primary, no accounts, no server, single local user (`local-driver`), community-derived OSM circuit geometry.

---

## CRITICAL

None found.

## HIGH

None found.

## MEDIUM

### M1 — Unbounded circuit-profile arrays enable a CPU-DoS within the existing size guard
**File:** `packages/core/src/profile/schema.ts:46,49,52` (no `.max()` on `centerline`/`sectorGates`/`pitLane.polyline` arrays); `packages/core/src/profile/validation.ts:171-186` (O(n²) pairwise sector-gate proximity check), `:139-161` and `:196-221` (each gate projected against the full centerline via `projectOntoPolyline`, itself O(centerline.length), called with **no hint** at import time).

`loadProfileFromJson` (`loader.ts:8`) only bounds the raw JSON to 5 MB (`MAX_PROFILE_JSON_BYTES`) before parsing; nothing bounds vertex/gate *counts* after parsing. A profile within the 5 MB cap can pack tens of thousands of `LatLon` points into `centerline` and tens of thousands of `Gate` objects into `sectorGates` (rough budget: ~80k centerline points and ~20k gates split across the 5 MB). `validateProfile` then does:
- `O(numGates × centerlineLength)` work projecting every gate endpoint onto the centerline (twice per gate via `endpointNearLine`), and
- an explicit `O(numGates²)` nested loop (`validation.ts:177-185`) checking every sector-gate pair's along-track separation.

At the sizes above this is on the order of 10⁹ operations — enough to freeze the JS thread for tens of seconds to minutes on a mobile device. Worse, `TrackMatcher.match()` (`matching/track-matcher.ts:96-101`) always does one *full* (unhinted) `projectOntoPolyline` call **per incoming GNSS sample**, so an oversized centerline that is accepted keeps paying this O(centerline.length) cost every single fix for the rest of the session, not just once at import.

**Exploit/abuse scenario:** a user imports a hostile or corrupted `.json` circuit-profile file (a plausible future feature — ADR-0002 explicitly anticipates "the import tool accepts a corrected GeoJSON under a bumped `layoutVersion`") and the app hangs/becomes unresponsive during validation, or drains battery/produces visible lag during live timing if the oversized-but-structurally-valid profile is accepted.

**Current reachability:** **low today.** No in-app import UI ships yet — `apps/mobile/src/session/tmrProfile.ts` only ever calls `loadProfileFromJson` on the one first-party bundled asset. `loadProfileFromJson`/`validateProfile` are exported from `@circuit/core`'s public API and are the documented single path "every other profile source uses," so this is latent, not theoretical, and should be fixed before any import feature ships.

**Fix:** add `.max()` bounds to `centerline`, `sectorGates`, and `pitLane.polyline` in `circuitProfileSchema` (e.g. a few thousand points is generous for a real circuit — TMR's is ~150 nodes per ADR-0002), and/or cap `MAX_PROFILE_JSON_BYTES` much lower for a profile (a real circuit profile is a few KB, not 5 MB). Consider making the O(n²) sector-gate check O(n log n) (sort by `distanceM` and compare only neighbors) regardless.

---

### M2 — Unbounded in-memory telemetry accumulation for the life of a session
**File:** `packages/core/src/controller/sessionController.ts:187` (`rawSamples: LocationSample[] = []`, pushed at `:476`, never trimmed); `packages/core/src/controller/pipelineCore.ts:162-166` (`crossings`, `laps`, `matches`, `rejectedSamples`, `stateHistory` — all plain arrays, pushed to on every sample/event, never capped or rotated).

One `SessionController`/`SessionPipelineCore` pair lives for an entire session (constructed once in the `SessionController` constructor; only replaced by `restoreFromCheckpoint` on recovery). `matches` and `rejectedSamples` grow by one entry per GNSS fix for the whole session; `rawSamples` likewise, and is **never pruned** even though each entry is only needed until its lap's `saveTelemetry` completes at `onLapCompleted` (`sessionController.ts:493`) — old samples for already-saved laps stay in the array forever. `onLapCompleted` does `this.rawSamples.filter(...)` over the **entire accumulated history** every time a lap completes (`:493`), so total cost across an n-lap session is O(total_samples × laps), not O(total_samples).

**Abuse/impact scenario:** a long track day (multiple hours, BestForNavigation GNSS at up to ~1 Hz per `platform-research.md`) or a session left running (e.g. paused overnight, or a stuck/looping state) grows these arrays without bound, increasing memory pressure and per-lap CPU cost over the course of a session on memory-constrained iPhones. Not attacker-triggerable from outside the device (no untrusted input involved) — this is a robustness/DoS-via-long-running-session issue, not an injection vector.

**Fix:** trim `rawSamples` to just the current in-flight lap (or a bounded rolling window) instead of the whole session; consider capping/rotating `matches`/`rejectedSamples`/`stateHistory` similarly, or making them summary counters where the full detail isn't needed downstream (`qualityCounts` already does this correctly for one of these).

---

### M3 — Precise-location history has no user-facing deletion path
**File:** `packages/core/src/persistence-sql/sqlSessionRepository.ts:218-253` (`deleteUserData` — implemented correctly for `laps`/`checkpoints`/`telemetry`/`sessions`/`reference_laps`, including an orphan sweep by `sessionId` prefix); **but** grep of `apps/mobile/src` for `deleteUserData` returns **zero matches** — it is never called from any screen. `SettingsScreen.tsx` and `SessionHistoryScreen.tsx` have no "delete my data" or per-session delete control.

Raw per-lap GNSS telemetry (`saveTelemetry`, `sqlSessionRepository.ts:158-167`, storing full `LocationSample[]` including `lat`/`lon`) is written to the on-device SQLite database and kept indefinitely — there is no retention limit and no automatic pruning anywhere in `packages/core/src` or `apps/mobile/src` (confirmed by grep for `prune`/`retention`/`expire`, no hits). The only way to remove this data today is uninstalling the app (which relies on the user knowing iOS wipes the app sandbox on uninstall — not documented in-app).

**Privacy impact:** for an offline, no-accounts app this is a completeness gap rather than an exfiltration risk (data never leaves the device — see INFO section), but the app records where a specific device/user has physically driven, indefinitely, with no in-app control to remove it.

**Fix:** wire a "Delete my data" (or per-session delete) action in `SettingsScreen`/`SessionHistoryScreen` to the already-correct `LocalSessionRepository.deleteUserData`.

---

## LOW

### L1 — `CalibrationEngine.acceptedPoints` grows unbounded for the duration of calibration
**File:** `packages/core/src/calibration/calibration-engine.ts:74,163` — `acceptedPoints` is pushed to on every accepted sample and never capped; `estimateBias()` (`:299-328`) does an O(n log n) sort over it and `lateralValuesAfterBias` (`:353-365`) is O(n), called twice per `finish()`.

Normal usage is one short Learn lap (thousands of samples at most), so real-world impact is minor. Nothing bounds it if calibration is left running indefinitely (e.g. app resumed into a stuck `calibrating` state without a timeout). Low severity given the short expected duration and no attacker control over input.

**Fix:** cap `acceptedPoints` (e.g. to a bounded reservoir or drop-oldest window) or add a hard calibration-duration/sample-count ceiling that force-fails calibration.

### L2 — Checkpoint deserialization validates the envelope, not per-lap field types
**File:** `packages/core/src/persistence/checkpointCodec.ts:19-28` (`isSerializedCheckpoint` checks `schemaVersion`/`snapshot.state`/`snapshot.lapNumber`/`snapshot.context`/`Array.isArray(laps)`, but does not validate the shape of individual `LapRecord` entries in `laps`).

`deserialize` correctly never throws on truncated/malformed JSON (returns `null`, verified against `checkpointCodec.test.ts`'s stated guarantee) — this is not a crash-safety bug. But a structurally-valid-JSON row whose `laps` array contains objects that don't match `LapRecord` (e.g. `{}`) would pass `isSerializedCheckpoint` and flow into `SessionController.restoreFromCheckpoint` (`sessionController.ts:409-443`), producing `undefined`/`NaN` values downstream in lap display rather than being rejected outright. Every consumer touching restored laps I traced (`restoreFromCheckpoint`'s `lastLap?.durationMs ?? null`) uses safe optional-chaining, so no crash path was found — this is a data-integrity nicety, not a stability bug.

**Attack surface:** requires an attacker who can already write to the app's sandboxed SQLite file (i.e., a compromised/jailbroken device) — not remotely triggerable. Severity kept LOW/informational for that reason.

**Fix (optional hardening):** validate each `laps[i]` against a minimal shape check (numeric `durationMs`, etc.) in `isSerializedCheckpoint`, falling back to `null` (already-established safe behavior) on mismatch.

### L3 — Unused native dependency (`expo-task-manager`) increases attack surface for no functional benefit
**File:** `apps/mobile/package.json:15` declares `expo-task-manager`; grep of `apps/mobile/src` shows it is referenced **only in a doc comment** (`platform/gnssLocationProvider.ts:97`), never imported or used.

This is exactly the module a future background-location task would need, and its presence contradicts the project's stated foreground-only, least-privilege posture (ADR-0003 §1) even though it is currently inert. Not exploitable as shipped (dead code, no wiring), but unnecessary supply-chain surface and bundle weight.

**Fix:** remove the dependency until a background-location feature is actually built and deliberately decided on (per ADR-0004's own rule: "any new dependency must be checked against Expo Go compatibility first ... a dependency that requires custom native code forces the EAS dev-client path and must be justified in a decision record" — this one is currently unjustified because unused).

---

## INFO

### I1 — GNSS spoofing / mock-location detection is Android-only (documented gap); low practical impact given current single-player scope
**File:** `apps/mobile/src/platform/gnssLocationProvider.ts:135-139,197-201` — Android's `location.mocked === true` samples are dropped before reaching the pipeline (never handed to subscribers) and counted in `GnssDiagnostics.samplesRejectedMocked`; iOS exposes no equivalent flag in the current expo-location SDK, explicitly documented as a known platform gap in the class doc comment. `TelemetryQualityEvaluator.assess()` (`matching/quality-evaluator.ts:94-107`) does add an `IMPOSSIBLE_JUMP`/`IMPLIED_SPEED_ABOVE_85MPS` heuristic that would catch crude GPS "teleports," but a smooth spoofed/replayed track (e.g. replaying a previously recorded real lap through a GPS-spoofing tool) would pass all quality/matching checks undetected on either platform.
`ReferenceLap` provenance (`reference/build-reference-lap.ts:244-261`) records `userId`/`sessionId`/`device`/`appVersion`/`algorithmVersion`/`recordedAtUtc` — enough to say *who/when/what build* produced a PB, but nothing anti-spoofing-specific (no flag distinguishing whether any Android-mocked samples were encountered/rejected during the session, no raw-sample audit trail retained beyond the resampled `distanceGridM`/`elapsedMsAtGrid`).
Given the app is local-only, single-user, with no accounts and no shared leaderboard (per project scope), the practical impact of undetected spoofing today is limited to a user fabricating their own local PB display — self-deception, not a multi-user integrity issue. **Revisit if any future feature adds sharing/leaderboards/export of PBs to a shared context.**

### I2 — No prototype-pollution vector in profile import
`packages/core/src/profile/migration.ts` (object-spread on parsed JSON) and `profile/schema.ts` (`.strict()` on every zod object) were checked specifically for this. Both `JSON.parse` and object-spread (`{...obj}`) create a literal *own data property* named `__proto__` in V8/Hermes rather than invoking the legacy `Object.prototype.__proto__` accessor — no polluted-prototype path exists via this route, and `.strict()` schemas reject any unrecognized key (including a literal `__proto__` key) during `validateProfile` regardless. No finding.

### I3 — No network exfiltration paths found
Grep of `apps/mobile/src` and `packages/core/src` for `fetch(`/`XMLHttpRequest`/`WebSocket`/`axios` returns zero matches (matches the WP14 "Offline audit" already recorded in `docs/architecture/current-state.md:136-138`). Neither `package.json` lists any analytics, crash-reporting, or `expo-updates` dependency. No `console.*` calls exist anywhere in `apps/mobile/src` or `packages/core/src` (confirmed by grep — zero hits), so no coordinate-bearing log lines exist to leak via device logs. No diagnostics-export/share feature exists in the app today (`expo-sharing`/`expo-file-system`/`Share`/`Clipboard` all grep-clean), so there is no export-content surface to review.

### I4 — SQL injection: not found
Every query in `packages/core/src/persistence-sql/sqlSessionRepository.ts` uses `?` parameter binding exclusively (verified line-by-line, `schema.ts`'s DDL is the only non-parameterized SQL and contains no interpolated values). `deleteUserData`'s orphan sweep deliberately uses `substr(sessionId,1,length(?))=?` (plain equality) specifically to avoid `LIKE`-wildcard-escaping pitfalls — a good pattern, called out in its own comment. Database file name (`apps/mobile/src/persistence/expoSqlDatabase.ts`) is a hardcoded constant (`DB_NAME`, `composition.ts:234`), never derived from user or network input — no path-injection surface.

### I5 — Permissions posture (app.json): least-privilege, honest usage strings
`apps/mobile/app.json` requests only `NSLocationWhenInUseUsageDescription` + the reduced-accuracy `NSLocationTemporaryUsageDescriptionDictionary` purpose key on iOS — no `NSLocationAlwaysUsageDescription`/Always keys, no `UIBackgroundModes: location`, matching ADR-0003 §2 exactly. Android requests `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION`/`FOREGROUND_SERVICE`/`FOREGROUND_SERVICE_LOCATION` with `isAndroidBackgroundLocationEnabled: false` and `locationAlwaysAndWhenInUsePermission: false` — foreground service is justified for reliable continuous updates during an active session (aggressive OEM battery management can throttle foreground GNSS on Android without it) and does not itself grant background access. Usage-string copy is specific and honest about on-track-only use. No finding beyond L3's note that the unused `expo-task-manager` dependency is the missing piece a real background-location feature would need.

### I6 — PB replacement rules faithfully enforced
`packages/core/src/reference/personal-best.ts`'s `shouldReplacePb` and `build-reference-lap.ts`'s `buildReferenceLap` were cross-checked against `docs/architecture/contracts.md`'s binding PB rules (same circuit/layout/version, `valid===true`, quality good/degraded only, no pit-transit, complete ordered sectors, strictly faster, full telemetry, atomic write-new-then-swap, mandatory provenance) — all checks are present and match. No finding.

---

## Empty severity classes
- **CRITICAL:** none.
- **HIGH:** none.

## Summary counts
MEDIUM: 3 (M1 profile-import CPU-DoS via unbounded arrays, M2 unbounded session-telemetry accumulation, M3 no user-facing data-deletion path) · LOW: 3 (L1 unbounded calibration-point accumulation, L2 shallow checkpoint validation, L3 unused `expo-task-manager` dependency) · INFO: 6 (spoofing-detection gap with low current impact, prototype-pollution — none found, network exfiltration — none found, SQL injection — none found, permissions posture — clean, PB rules — faithfully enforced).

No CRITICAL or HIGH findings. The most actionable items are M1 (bound profile array sizes before any import feature ships) and M3 (wire the already-correct `deleteUserData` to a Settings-screen control) — both are small, contained fixes.
