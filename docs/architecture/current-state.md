# Current State

> Living document. Updated as integration groups land. Started 2026-08-06 from an empty repository (see `docs/verification/baseline.md`).

## Target architecture (summary)

Monorepo (npm workspaces):

- `packages/core` — pure TypeScript domain: circuit-profile schema and validation, geometry (local-plane projection, polyline projection, progress unwrapping, directed gate crossing), calibration engine, session state machine, lap/sector timing engines, reference-lap store logic, live-delta engine, telemetry quality evaluation, replay harness. **No React/React Native/Expo imports permitted.** Tested with Vitest (unit + property-based via fast-check) driven by deterministic telemetry fixtures.
- `apps/mobile` — Expo (React Native, TypeScript) application: UI surfaces, view models, platform adapters (`LocationProvider` via expo-location, `MotionProvider` via expo-sensors, persistence via expo-sqlite), session recovery, developer replay screen. Depends on `packages/core` only through its published contracts.

Dependency inversion: the core consumes `LocationSample` streams through the `LocationProvider` interface; production supplies GNSS, tests/dev supply the deterministic `ReplayLocationProvider` streaming fixtures through the **same** pipeline.

Full contracts: `docs/architecture/contracts.md`. Decisions: `docs/decisions/`.

## Status ledger

See `.foreman/ledger.md` for task-by-task status, ownership, and verification state.

## Integration status (WP14)

**Integration complete.** The mock session facade has been replaced with the
real production pipeline end-to-end: `packages/core`'s `SessionController`
drives calibration, arm/out-lap/timing, checkpointing, PB replacement, and
the live delta engine live from a `LocationProvider`; `apps/mobile`'s
`RealSessionFacade` adapts it to the app's `SessionFacade` interface and is
the default composition-root implementation (`apps/mobile/src/session/composition.ts`).
`MockSessionFacade` remains available only behind a `DevReplayScreen`
`__DEV__` toggle for pure UI iteration.

### Module map (`packages/core/src`)

| Module | Owns |
|---|---|
| `geometry/` | Local-plane projection, polyline projection/length, gate segment intersection |
| `profile/` | Circuit-profile schema, validation, migration, JSON loader |
| `matching/` | Telemetry quality evaluation, track matching |
| `calibration/` | The Learn-lap `CalibrationEngine` |
| `timing/` | Crossing detection, lap/sector timing |
| `statemachine/` | The pure `SessionReducer` |
| `persistence/` | In-memory `LocalSessionRepository`, checkpoint codec, reference-lap validation |
| `persistence-sql/` | SQL-backed `LocalSessionRepository` (`SqlSessionRepository`), versioned DDL (v2: adds the app-settings key-value table) |
| `reference/` | Reference-lap building, PB replacement rule, live delta engine |
| `fixtures/` | Deterministic telemetry fixtures + named scenarios (clean lap, multi-lap, PB improvement, noisy GPS, signal loss, pit transit, reverse travel, etc.) |
| `replay/` | `ReplayHarness` — batch-drives a fixture through the production pipeline (`runSessionPipeline`) |
| `controller/` | **New in WP14.** `SessionPipelineCore` (shared per-sample pipeline processing, used by both `runSessionPipeline` and the live controller) and `SessionController` (the production orchestrator) |

`packages/core/src/index.ts` now re-exports every module above (previously
only `contracts.ts`); a small number of concrete classes that share a name
with their `contracts.ts` interface (`TrackMatcher`, `TelemetryQualityEvaluator`,
`CalibrationEngine`, `CrossingDetector`, `LapTimingEngine`, `LiveDeltaEngine`)
are re-exported explicitly rather than via `export *`, which TypeScript
cannot do for an ambiguous name; the interfaces remain reachable via
`@circuit/core`'s re-export of `contracts.ts`.

### `SessionController`

The production orchestrator (`packages/core/src/controller/sessionController.ts`).
Consumes a `LocationProvider` + `MonotonicClock` + `LocalSessionRepository` +
`RuntimeProfile` + `userId`, and composes the SAME five pipeline engines
`runSessionPipeline` uses via the shared `SessionPipelineCore`
(`controller/pipelineCore.ts`) — no duplicated wiring between the batch
replay harness and the live controller. Responsibilities:

- Calibration flow (`start('calibration')` → live `CalibrationEngine.feed`
  per sample → auto-`finish()` once centerline coverage is complete →
  `acceptCalibration`/`rejectCalibration`, the latter reducer-legal even
  mid-lap by first forcing a synthetic `CALIBRATION_FINISHED(accepted:false)`).
- `arm()` → live sample ingestion begins; out-lap → timing happens
  organically as the state machine reacts to real crossings.
- Lap completion → `repository.saveTelemetry` + `saveCheckpoint`, and PB
  evaluation (`shouldReplacePb` + `buildReferenceLap` + `putReferenceLap`,
  atomic write-new-then-swap) immediately when a lap beats the stored PB —
  not deferred to session end.
- The live delta engine is fed from the stored reference lap, loaded at
  session start (or immediately on `start('session')`, the recovery-resume
  path).
- `sessionId` format `${userId}--<random>` (WP11b convention).
- **Watchdog (ADR-0003 §1, binding):** if no sample arrives for
  `watchdogTimeoutMs` (default 5000ms) while active and unpaused, the
  configured `restartProvider` callback is invoked (the app passes
  `GnssLocationProvider`'s own stop/start) and a `watchRestarts` diagnostic
  increments. Polled via an injectable `WatchdogScheduler` so it is testable
  with a fake clock/scheduler in `packages/core/test/controller/`.
- **Recovery (ADR-0003 §3, binding):** `restoreFromCheckpoint` restores
  historical laps from a persisted checkpoint; because a `tMono` from a
  previous process launch is never comparable to a new one
  (`platform/clock.ts`'s binding rule), an in-flight lap open at checkpoint
  time is appended as a zero-duration, explicitly-invalid `RECOVERY` lap
  rather than a fabricated real time, and the session re-enters
  `awaitingCalibration` (a fresh Learn lap). `start('session')` is the
  separate, explicit "resume without recalibrating" path used only after a
  successful `restoreFromCheckpoint`, arming directly off the last stored PB.

### App-side wiring (`apps/mobile/src`)

- `session/composition.ts` is the sole composition root. `facade` /
  `sessionHistoryStore` / `settingsStore` are stable, swappable wrapper
  objects: each starts backed by an in-memory placeholder (screens import
  synchronously; opening SQLite is async) and is swapped to its real
  implementation once the on-device database opens. The same swap mechanism
  lets `DevReplayScreen` point `facade` at a replay-backed
  `SessionController` for its demo without any other screen knowing.
- `session/realFacade.ts` — `RealSessionFacade`, a thin `SessionFacade`
  adapter over `SessionController`.
- `session/sqlSessionHistoryStore.ts`, `persistence/sqlSettingsStore.ts` —
  real `SessionHistoryStore`/`SettingsStore` implementations backed by
  `SqlSessionRepository` and the v2 `settings` key-value table respectively.
- `session/tmrProfile.ts` — the TMR profile is loaded via a **static**
  `import` of the bundled JSON asset (Metro inlines `.json` as a source
  module, never a runtime fetch/`fs` read), validated through the same
  `loadProfileFromJson` path every other profile source uses.
- `session/liveTimestampedProvider.ts` — re-stamps replayed samples' `tMono`
  to the live clock at delivery, so `DevReplayScreen`'s accelerated replay
  drives the same clock-based `currentLapMs` display a live GNSS session does.
- `ui/screens/DevReplayScreen.tsx` — lists real bundled `@circuit/core`
  fixture scenarios; selecting one drives the actual production
  `SessionController` through the real calibration/dashboard screens.
- `ui/screens/PreflightScreen.tsx` — calls the real collectors
  (`platform/preflight.ts`), shows human-readable failure copy, including
  `PRECISE_LOCATION_OFF` instructions.
- `ui/screens/CircuitDetailScreen.tsx` — inline (non-modal) recovery banner
  when an incomplete checkpoint is found at launch.

### Verification evidence (WP14)

- `npm run typecheck`, `npm run lint`, `npm run test` — all green (484
  core tests, 0 lint errors, 0 type errors) from the repo root.
- `npx expo export --platform ios` / `--platform android` — both exit 0.
- Static-bundle proof: `npx expo export --platform ios --source-maps` was
  run and the compiled Hermes bytecode (`.hbc`) was scanned for
  JSON-payload-only strings from the TMR profile asset (e.g. the OSM
  license string `"ODbL 1.0"`, present only in the asset JSON and the
  (non-bundled) generator script) — found embedded, confirming the profile
  is statically inlined rather than fetched.
- Offline audit: zero `fetch(`/`XMLHttpRequest`/`axios`/`WebSocket`
  occurrences anywhere in `apps/mobile/src` or `packages/core/src`; no
  `expo-updates`/analytics/network-library imports or dependencies.
- `apps/mobile/eas.json` defines `development`/`preview`/`production`
  profiles per ADR-0004 (not run, per that work package's scope).
