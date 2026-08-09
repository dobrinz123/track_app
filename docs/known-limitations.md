# Known limitations

An honest list of the app's real constraints — as designed, as coded, and as gaps discovered while
reading the implementation. Nothing here is fixed by this document; where a limitation is a design
decision it links to the ADR that made it, and where it's a code-level gap it cites the file.

## Timing precision and geometry provenance

- **GNSS ~1 Hz bounds timing precision (~±0.3 s vs. pro timing).** `watchPositionAsync` with
  `timeInterval: 0`/`distanceInterval: 0` requests the platform's maximum rate, which tops out
  around 1 Hz in typical foreground conditions (`apps/mobile/src/platform/gnssLocationProvider.ts`).
  Crossing times are linearly interpolated between samples
  (`docs/algorithms/timing-and-crossings.md`), which helps, but the achievable agreement against an
  independent hand/organizer timer is documented as approximately ±0.3 s
  (`docs/verification/real-track-validation-checklist.md` item 10) — a GNSS sampling-rate ceiling,
  not a defect to chase past.
- **Start/finish and sector gates are app-defined, not official.** Placed deterministically by the
  profile generator (main-straight nearest-point rule, 1/3 and 2/3 cumulative-distance sector
  splits) — see `docs/decisions/ADR-0002-circuit-geometry-source.md` and `docs/adding-a-circuit.md`.
  Never presented as sourced from organizer/FIM/FIA documentation.
- **Circuit geometry is community-derived (OpenStreetMap) and unvalidated on-site.** The centerline
  and pit lane come from two OSM ways (`ADR-0002`), and the generated profile's own
  `confidenceNotes` field says as much: *"Start/finish, sector, and pit gates are app-defined from
  OSM geometry and have not been validated on-site."* Physical validation is the
  `docs/verification/real-track-validation-checklist.md` protocol, not yet run against this build.

## Session flow

- **No calibration-stall timeout.** If centerline coverage never reaches the 98% live auto-finish
  threshold (`docs/algorithms/calibration.md`), the Learn lap keeps running indefinitely — there is
  no automatic abort. The only way out is the driver's manual long-press cancel
  (`ActiveCalibrationScreen.tsx`'s `LongPressButton` → `rejectCalibration()`).
- **Lap numbering resets to 1 after a recovery resume.** `SessionController.restoreFromCheckpoint()`
  builds a fresh `SessionPipelineCore` whose internal `LapTimingEngine` always starts
  `nextLapNumber` at 1 (`packages/core/src/timing/lap-timing-engine.ts`), and the state machine's
  `armed` → forward-start/finish transition always opens `lapNumber: 1`
  (`packages/core/src/statemachine/reducer.ts`) regardless of how many historical laps were
  restored. The next lap timed after a resume is therefore labeled "Lap 1" again even if the
  session already has, say, five prior laps in `core.laps` — a real numbering collision, not merely
  a display quirk, since `LapRecord.lapNumber` itself repeats.
- **App backgrounding mid-lap is not directly wired to invalidate the lap.** `platform/lifecycle.ts`
  exports `startLifecycleListener()` with an `onBackground` callback, and its own doc comment says
  the "checkpoint-on-background behavior it will drive... is out of scope here and left for the
  session-orchestration work package" — but no later work package ever calls
  `startLifecycleListener()` from `App.tsx`/`composition.ts` (confirmed: zero call sites outside
  `lifecycle.ts`/`platform/index.ts`'s re-export). In practice, backgrounding still degrades/
  invalidates a lap only *indirectly*, through the unrelated 5-second sample watchdog
  (`SessionController`'s `checkWatchdog`, ADR-0003 §1) once GNSS delivery actually stops, not
  through an explicit AppState transition. The real-track validation checklist's item 13
  ("app backgrounding mid-lap → documented recovery behavior") should be read with this in mind.

## Platform gaps

- **iOS mocked-location rejection gap.** `GnssLocationProvider` drops Android's
  `LocationObject.mocked === true` samples and counts them in diagnostics; iOS exposes no
  equivalent flag in the current SDK, so mock-location rejection is Android-only
  (`apps/mobile/src/platform/gnssLocationProvider.ts`'s "Mock-location handling" doc comment).
- **Foreground-only — no background timing.** No `UIBackgroundModes: location` is requested by
  design (ADR-0003 §1); a session backgrounded mid-lap stops receiving samples until foregrounded
  again. `expo-keep-awake` is used instead of background location to keep the screen (and thus GNSS
  delivery) alive during a session.
- **Expo Go dev caveats.** `app.json`'s Info.plist customizations (usage-description copy, the
  temporary-full-accuracy purpose-key dictionary from ADR-0003 §2) do **not** apply inside Expo Go
  — Expo Go's own Info.plist governs permission prompts there. Precise-accuracy behavior should be
  re-verified on a standalone build, never assumed from an Expo Go session
  (`docs/decisions/ADR-0004-no-mac-ios-workflow.md` §1).
- **Thermal-state API unavailable.** Neither `expo-constants` nor `expo-device` expose
  `ProcessInfo.thermalState` in the current SDK generation, and adding a new dependency for it is
  out of scope; `collectThermalState()` always returns `{available: false, state: null}`
  (`apps/mobile/src/platform/preflight.ts`) — never fabricated. Preflight does not gate on thermal
  state; the validation checklist calls for manual on-device thermal observation instead.
- **Native builds require EAS cloud.** No Android SDK or Xcode exists on the Windows build machine;
  `npx expo export --platform ios/android` (Metro bundle) plus typecheck/lint/test are the only
  locally-verifiable gates. Shippable native binaries (APK/IPA) are built via EAS Build in the
  cloud, documented in `docs/ios-no-mac-workflow.md` (`docs/decisions/ADR-0001-stack.md`,
  `ADR-0004-no-mac-ios-workflow.md`).

## Accounts and data

- **No per-user accounts (single local user).** The app has one hardcoded local user id,
  `'local-driver'` (`apps/mobile/src/session/composition.ts`) — every session, checkpoint, and
  reference lap on a device belongs to that one identity. See `docs/privacy.md` and
  `docs/persistence-model.md`.
- **No "delete my data" UI affordance.** `LocalSessionRepository.deleteUserData(userId)` is fully
  implemented and covered by contract tests in both the in-memory and SQL-backed repositories
  (`docs/persistence-model.md`), but nothing in `apps/mobile/src` calls it — there is no delete
  button on `SettingsScreen` or anywhere else. Deletion is currently reachable only
  programmatically, not from the app UI.
- **No diagnostics screen.** `GnssLocationProvider.getDiagnostics()` collects a real rolling window
  of sample-interval and accuracy statistics plus the mocked-sample/reduced-accuracy counters
  (`apps/mobile/src/platform/gnssLocationProvider.ts`), but no screen in `apps/mobile/src/ui/screens`
  ever calls `getDiagnostics()` or renders it — confirmed zero call sites outside the platform
  module itself. The real-track validation checklist's item 15 ("diagnostics screen export...
  screenshot attached") currently has no corresponding UI to screenshot.

## Configuration wiring

- **Live corridor width does not use the profile's `corridorWidthM`.** The circuit profile's own
  `corridorWidthM` (15 m for Transilvania Motor Ring) is used only by profile *validation*
  (`packages/core/src/profile/validation.ts`'s bound check and gate-endpoint-distance tolerance).
  `CalibrationEngine` and `TrackMatcher` each default their own, independent `corridorWidthM` to
  20 m and neither is ever overridden with the profile's value anywhere in
  `apps/mobile/src/session/composition.ts` — both calibration and live matching run against the
  20 m default in production, not the profile's narrower 15 m corridor. See
  `docs/algorithms/calibration.md`.
- **Calibration failure copy is stale for most codes.** `CalibrationResultScreen.tsx`'s
  `REASON_COPY` map only has bespoke user-facing text for `INSUFFICIENT_COVERAGE`; the three other
  entries it defines (`ACCURACY_ABOVE_20M`, `DIRECTION_UNCERTAIN`, `LOW_SAMPLE_RATE`) are never
  emitted by `CalibrationEngine.finish()`, whose real codes for those situations
  (`POOR_GNSS`, `WRONG_DIRECTION`, `RATE_TOO_LOW`, plus `COVERAGE_GAP`/`CANCELLED`) all fall
  through to a generic underscore-to-space humanizer instead. See `docs/algorithms/calibration.md`.

## Mission constraint

- **Thresholds must stay configurable, not tuned to one device.** Per the validation checklist's
  footer: quality/accuracy/timing thresholds documented throughout `docs/algorithms/` are current
  defaults, not hard-coded universal constants — they must remain overridable per the various
  `*Config` interfaces (`TelemetryQualityConfig`, `TrackMatcherConfig`, `CalibrationConfig`,
  `LapTimingEngineConfig`, `LiveDeltaEngineConfig`) rather than baked into a single on-site
  validation session's readings.

## Residual edge cases accepted after the pre-install verification campaign (2026-08-09)

Two narrow residues from the dual-review campaign are accepted as documented
limitations rather than blockers (full evidence: `.foreman/scratch/final-codex-verify-output.log`):

1. **Stale facade after a failed controller replacement (F2 residue).** If the
   fresh-controller swap itself fails (its `dispose()`/rebuild throws — a
   double-failure path), the previous terminal facade stays installed and only
   `startPreflight` is gated. Practical impact is minimal: a terminal
   `SessionController` ignores all session commands by design (illegal events
   return identity), and the failure surfaces via `lastError`. Recovery: app
   restart.
2. **Dev-replay transition races under adversarial storming (F4 residue).** A
   replay start that entered before an unmount-restore can interleave
   out-of-order, and work enqueued during a flush window may miss persistence
   before disposal. Affects only the `__DEV__` replay tool (excluded from
   release builds entirely); the production GNSS path has no such path.
