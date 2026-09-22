# `apps/mobile` — architecture map

> Orientation document for a fresh session or a new contributor. Written 2026-09-22 against
> `main` @ `4676545`. Expo SDK 57 / React Native 0.86, iOS, installed by sideloading.
>
> Everything below is grounded in `file:line`. Line numbers drift; the **exported symbol names**
> alongside them do not — search by symbol first, use the line as a hint.
>
> Companions: `docs/architecture/contracts.md` (the binding interface contracts),
> `docs/architecture/current-state.md` (`packages/core` module map),
> `docs/NEXT-CIRCUIT-PLAYBOOK.md` §0 (process, gates), `.foreman/ledger.md` (campaign history,
> ~200 KB, append-only — the "why" for most code comments lives there).

---

## 0. The shape in sixty seconds

```
index.ts → App.tsx  (font gate, NavigationContainer, dark theme)
              │
              └── ui/navigation/RootNavigator.tsx      one native stack, 20 routes
                        │
                        ├── ui/screens/*.tsx            renderers. Almost no decisions.
                        │      │
                        │      ├── ui/hooks/*           useFacadeState, useSettings
                        │      ├── ui/components/*      dumb, untested
                        │      └── ui/screens/*Strings  RO/EN copy tables (pure, tested)
                        │
                        └──────► session/composition.ts   ◄── THE WIRING HUB (4862 lines)
                                        │
                   ┌────────────────────┼────────────────────────┐
                   │                    │                        │
          session/*.ts view models   platform/*             persistence/*
          (pure TS, unit-tested)   GNSS, clock, lifecycle,   expo-sqlite adapter,
          analysisViewModel,       permissions, preflight    write gate, schemas,
          pitViewModel,            (expo-location,           recorder/readers
          lapVerdictViewModel,      react-native AppState)
          stintCoaching,
          telemetryProvider (OBD),
          gforceProvider (IMU),
          enet/tcp transports
                   │
                   └──────────────────► @circuit/core   (pure engine, no RN/Expo — ever)
```

Three rules that explain most of the code you will read:

1. **Screens hold no logic.** Every decision a screen appears to make lives in a pure
   `session/*.ts` module a test can import. See §5.
2. **`composition.ts` owns every lifecycle.** Providers, controllers, database, stores. Screens
   never construct anything; they import singletons and call exported functions.
3. **Anything that touches `react-native` or a native Expo module is quarantined**, because the
   test runner cannot parse React Native's Flow-typed source. See §4 — this is the single most
   common way to get a baffling error here.

Rough size: 44 k lines of TS/TSX under `src/`, 144 test files under `test/`.

---

## 1. The composition root — `src/session/composition.ts`

One file, 4862 lines, and the only place the app is assembled. It is a **module with
module-level side effects**: importing it starts bootstrap. Read it in the order below rather
than top to bottom.

### 1.1 What exists at module load (before any `await`)

These run the instant anything imports the module — including a test file.

| Line | What | Why it is eager |
|---|---|---|
| `composition.ts:35` | `IS_WEB_RUNTIME = typeof document !== 'undefined'` | Web detection *without* importing `react-native` (§4, fence 1). Distinguishes browser preview / Hermes-on-device / node-test correctly. |
| `composition.ts:208` | `lifecycleLock = createLifecycleLock()` | Declared above `SwappableFacade`, because the facade wrapper is itself one of its users. |
| `composition.ts:643-650` | `facade`, `sessionHistoryStore`, `settingsStore` | React components import these synchronously at module load; opening SQLite is async. Each starts on an in-memory placeholder and is *swapped* later. |
| `composition.ts:661` | `startVoiceCoach(facade, settingsStore)` | Subscribes to the stable wrappers, so it survives every inner swap. |
| `composition.ts:1042,1058` | `baseTelemetryProvider` / exported `telemetryProvider` | Long-lived OBD singleton with its own clock, independent of any `SessionController`. |
| `composition.ts:1108` | `gForceProvider` | Accelerometer/IMU singleton on the **same** `telemetryClock` (`:675`) so all telemetry shares one time base. |
| `composition.ts:1395` | `facadeWrapper.setEndSessionSideEffect(...)` | Telemetry shutdown fires the instant `facade.endSession()` is called, regardless of which inner facade is active or whether persistence later fails. |
| `composition.ts:1408` | `facadeWrapper.setSessionCompleteBarrier(...)` | Holds the `sessionComplete` broadcast until telemetry shutdown settles (capped at 2 s, `:192`). |
| `composition.ts:1560` | `startLifecycleListener({ onBackground })` | App-background checkpoint. Registered outside bootstrap so a background transition during boot is a harmless no-op. |
| `composition.ts:794` | settings subscription — active vehicle profile changed | Invalidates the binding cache. |
| `composition.ts:1984` | settings subscription — `coachingEnabled` changed | Rebuilds the controller if (and only if) it is idle/terminal. |
| `composition.ts:2290` | `testLoopController` | Holds no db and no provider, so it is safe before bootstrap. |
| `composition.ts:2314` | `testLoopController.subscribe` — auto-teardown on `failed` | A learn phase that gives up must not leave GNSS running. |
| `composition.ts:3153` | `bootstrapPromise = runBootstrap()` | **Bootstrap starts here.** |
| `composition.ts:4217` | `suggestionJournal` | One per app run — in memory, deliberately (see §9). |
| `composition.ts:4363` | `lapVerdictStore` | Reads `repository()` on demand, so it works before and after bootstrap. |
| `composition.ts:4836` | `facade.subscribe(...)` lap-boundary hook | Drives the between-lap stint pass (`runStintPass`, `:4854`). |

### 1.2 The three swappable wrappers

`composition.ts:168-183` states the reason: screens import stable bindings whose identity never
changes, while the thing behind them is replaced twice — once when SQLite opens, and again for
every DevReplay transition.

| Class | Line | Starts as | Becomes |
|---|---|---|---|
| `SwappableFacade` | `:270` | `PendingFacade` (`:618`) — every command a silent no-op, state frozen | `RealSessionFacade` over the production controller; in `__DEV__`, a replay or `MockSessionFacade` |
| `SwappableSessionHistoryStore` | `:528` | `MockSessionHistoryStore` | `SqlSessionHistoryStore` for the selected circuit |
| `SwappableSettingsStore` | `:544` | `InMemorySettingsStore` | `SqlSettingsStore` |

`PendingFacade` is deliberately **inert**, not a live mock (`:581-593`): an earlier version left a
fully functional `MockSessionFacade` in place on a failed bootstrap, so calibration could start
against a fake timer with no persistence and no visible error.

`SwappableFacade` is more than a delegator. It owns four cross-cutting behaviours:

- **`relaySessionCompleteBarrier`** (`:229`, exported and unit-tested as a free function): every
  state except `sessionComplete` passes straight through; `sessionComplete` is held until the
  telemetry-shutdown promise settles or 2 s elapses, with later states queued behind it in order.
  A `null` barrier creates no timer at all.
- **The preflight gate** (`:296`, installed at `:2989`): every `startPreflight()` runs inside
  `lifecycleLock`, checks whether the production controller is terminal or built for a different
  circuit, rebuilds if so, and *then* forwards — from inside the lock.
- **`runLockedCommand`** (`:426`): `beginCalibration`/`endSession` hold `lifecycleLock` until the
  command's async work has *settled* (`SessionFacade.whenCommandsSettled`), not merely until the
  synchronous dispatch returned.
- **Queued-calibration cancel tokens** (`:467`): `rejectCalibration()` is deliberately *unlocked*
  so a Cancel acts immediately, and it cancels starts still waiting for the lock.

### 1.3 `lifecycleLock` — the one ordering boundary

`src/session/lifecycleLock.ts`. A FIFO mutex replacing three earlier, individually-correct
mechanisms (`selectionChain`, `rebuildInFlight`, `withDevReplayLock`) that did not form a single
ordering boundary.

**The call rule, enforced by convention throughout `composition.ts`:** code already inside a
section calls the `unlocked*` routine, never the locked public wrapper. Re-entering `run()` would
queue behind itself. The synchronously detectable form of that mistake throws
`LifecycleLockReentry` (`lifecycleLock.ts:41`) instead of hanging; the post-`await` form cannot be
detected and is covered only by the structural rule.

**Bootstrap deliberately never takes the lock** (`composition.ts:1875-1879`): locked operations
`await ready()` from *inside* their section, so a bootstrap that held the lock would deadlock
against the first such caller.

Sections: `selectCircuit` · `resumeRecovery` · `discardRecovery` · `deleteAllStoredUserData` ·
`restoreProductionFacade` · `startDevReplaySession` · `runDevReplayScenario` ·
`useMockFacadeForDevReplay` · `startTestLoop` · `tearDownLearnPhase` · `adoptLearnedCircuit` ·
`deleteLearnedCircuit` · the preflight gate · the coaching rebuild · `beginCalibration` ·
`endSession`.

### 1.4 `runBootstrap()` — the order matters, and every step's order is justified in place

`composition.ts:2879`. Kicked off once at `:3153`; re-invocable via `retryBootstrap()` (`:3170`).

1. `:2884-2893` — clean slate. Every module singleton nulled, so a retry never reuses a
   half-built previous attempt.
2. `:2895-2911` — open storage. Web preview → `InMemorySessionRepository` (expo-sqlite's wasm
   backend throws `disk I/O error` in embedded browsers). Native → `openAppDatabase(DB_NAME)`,
   which returns both the migrated repository and the gated raw handle.
3. `:2919` — prime the vehicle-profile bindings cache (fire and forget).
4. `:2921` — construct `GnssLocationProvider`.
5. `:2932-2949` — hydrate settings **before** building the controller, so `coachingEnabled` and
   `selectedCircuitId` are the persisted values on the very first controller. Then the one-time
   active-profile migration, a second cache refresh, and the unvalidated-matching log.
6. `:2957-2968` — migrate and load learned circuits, then `publishLearnedCircuits()` — *before*
   the controller, so a persisted `selectedCircuitId` naming a learned circuit resolves.
7. `:2971` — `repairInterruptedAdoption(db)`: finish or undo a half-adopted Test Loop.
8. `:2978` — `buildProductionController()` — built but **not activated**.
9. `:2989` — install the preflight gate.
10. `:3033-3043` — build `SqlSessionHistoryStore` for the persisted selection.
11. `:3045-3127` — recovery. Resolve the checkpoint's circuit in binding priority order:
    persisted `activeSessionCircuitId` → `listSessions` scan (legacy) → current selection. An
    explicit-but-unbundled pointer is a hard discard.
12. `:3134-3135` — `activateProductionFacade()`, then `setBootstrapState('ready')`. **This is the
    only line that makes the real facade reachable from the UI.**
13. `:3136-3150` — on any throw: `facade` stays on `PendingFacade`, state flips to `'failed'`,
    `CircuitDetailScreen` shows an inline banner with Retry.

### 1.5 What composition owns the lifecycle of

| Resource | Created | Disposed / stopped |
|---|---|---|
| SQLite `db` + `repository` | `runBootstrap` `:2904-2910` | never (process lifetime); wiped by `deleteAllStoredUserData` |
| `GnssLocationProvider` | `:2921` | `unlockedRebuildProductionController` `:1947` — **composition stops it, not core** (core cannot know who owns a shared provider) |
| production `SessionController` | `createProductionController` `:1694` via `buildProductionController` `:1824` | `unlockedRebuildProductionController` `:1909` |
| `RealSessionFacade` | `:1839` | `staleFacade?.dispose()` `:1910` |
| `TelemetryRecorder` | `startTelemetryRecording` `:1327` | `stopTelemetryRecording` `:1285` |
| OBD `telemetryProvider` | module load `:1058` | `stopTelemetryRecording`; `TelemetryScreen` also start/stops it manually |
| `gForceProvider` | module load `:1108` | **reference counted** — `acquireGForce`/`releaseGForce` `:1142-1158`; two independent users (monitor screen, driving session) |
| `TestLoopLocationProvider` | `startTestLoop` `:2577` | `disposeTestLoopProvider` `:2613`; released at handover `:2753` |
| replay `SessionController` | `unlockedStartDevReplaySession` `:3729` | `flushAndDisposeReplay` `:3596` |
| `SqlLearnedCircuitStore` | `:2960` | — |
| `AnalysisRunner` | lazily, `getAnalysisRunner` `:4175` | never (one cache for the whole app) |
| `StintRunner` / `StintCoach` | lazily, `:4305` / `:4326` | never |

### 1.6 Exported entry points

Everything the UI (or a test) may call. **Screens import only from here**, never from `Mock*`,
`Sql*` or `Real*` directly (`composition.ts:637-642`).

| Export | Line | What it does | Called by |
|---|---|---|---|
| `facade` | 644 | live session state + commands | every session screen |
| `sessionHistoryStore` | 647 | stored sessions + PB | History, PB, LapDetail, Settings |
| `settingsStore` | 650 | app settings (live) | nearly every screen |
| `telemetryProvider` | 1058 | OBD provider singleton (wraps the base with a binding-cache refresh on `start()`) | Telemetry, SignalFinder, DidProbe, TelemetryStrip |
| `gForceProvider` | 1108 | IMU provider singleton | TelemetryScreen |
| `acquireGForce` / `releaseGForce` / `gForceHolderCount` | 1142 / 1153 / 1161 | refcounted G ownership | TelemetryScreen (first two); third is tests only |
| `subscribeBootstrapState` / `BootstrapState` | 1426 / 1416 | gate "Start Session" until ready | CircuitDetailScreen |
| `retryBootstrap` | 3170 | re-run bootstrap from a clean slate | CircuitDetailScreen |
| `subscribeRecovery` / `PendingRecovery` | 1463 / 1439 | crash-recovery banner (carries its own `circuitId`) | CircuitDetailScreen |
| `subscribeRecoveryNotice` | 1487 | one-off recovery error text | CircuitDetailScreen |
| `resumeRecovery` / `discardRecovery` | 3220 / 3361 | resume or terminalize a checkpoint | CircuitDetailScreen |
| `selectCircuit` / `SelectCircuitResult` | 2173 / 2053 | the app's ONE active circuit; refuses mid-session | CircuitSelectionScreen |
| `proceedWithoutCalibration` | 4090 | the calibration escape hatch; returns `armed-accepted` / `armed-unvalidated` / `refused` | ActiveCalibration, CalibrationResult |
| `getLiveCalibrationAttempt` | 4489 | the live controller's Learn-lap record | CalibrationInstructions, CalibrationResult |
| `resolveSessionCalibrationStatus` | 4009 | durable 3-valued provenance of a stored session | History, PB, Analysis |
| `resolveResultsCalibrationStatus` | 4030 | live ∧ stored precedence rule (pure, testable — that is why it is here and not in the screen) | SessionResultsScreen |
| `sessionUnwrittenSampleCount` | 4042 | fixes captured and never written | SessionHistoryScreen |
| `isSessionMatchingUnvalidated` | 4054 | legacy boolean predicate | (referenced only in an AnalysisScreen comment; see §9) |
| `getMostRecentSessionId` | 3971 | `FacadeState` has laps but no session id | SessionResultsScreen |
| `getTelemetryReadDb` | 3952 | raw SQLite handle, read-on-demand; `null` on web | LapDetail, DidSweep, SignalFinder |
| `getSessionRepository` | 3962 | shared repository | internal (analysis loader) |
| `getAnalysisRunner` | 4175 | THE one analysis runner/cache for the app | AnalysisScreen |
| `getStintCoach` / `getStintRunner` / `getTrackdayRecord` | 4326 / 4305 / 4346 | trackday stage | PitViewScreen (`getStintCoach`, `getActiveStintContext`) |
| `getActiveStintContext` | 4814 | `{ sessionId, completedLapCount }` or `null` | PitViewScreen |
| `lapVerdictSupport` / `refreshLapVerdicts` / `getLapVerdicts` / `getUnsavedLapVerdicts` / `getLapVerdictSummary` / `recordLapValidityVerdict` | 4375–4423 | owner's true/false verdict on each lap | SessionResults, LapDetail, History (`summary`) |
| `buildSessionReport` | 4672 | the one complete per-session document | SessionResults, SessionHistory |
| `buildRawSessionExport` | 4130 | raw GNSS + OBD/IMU dump, works with zero laps | internal (`buildSessionReport`) + tests |
| `deleteAllStoredUserData` / `AggregatedDeleteUserDataResult` | 3406 / 3393 | wipe; refuses mid-session and during DevReplay | SettingsScreen |
| `getLiveDiagnostics` / `LiveDiagnosticsSnapshot` / `estimateObservedRateHz` / `getProductionCircuitId` | 3914 / 3891 / 3932 / 3909 | read-on-demand diagnostics (deliberately not a subscription — no polling while timing) | Settings, DevReplay |
| `subscribeTestLoop` / `testLoopSnapshot` / `startTestLoop` / `stopTestLoop` / `retryTestLoopAdoption` | 2484 / 2488 / 2564 / 2593 / 2608 | Test Loop learn phase | TestLoopScreen |
| `resetTestLoop` | 2602 | leave Test Loop mode entirely | **nothing — see §9** |
| `testLoopDiagnostics` | 2493 | who still holds the GNSS watcher | tests |
| `saveLearnedCircuit` / `listLearnedCircuits` / `deleteLearnedCircuit` | 2815 / 2798 / 2837 | learned-circuit registry | `saveLearnedCircuit`: TestLoopScreen. Other two: internal/tests only — see §9 |
| `refreshVehicleProfileBindingsCache` / `getVehicleProfileBindingsCache` / `getActiveVehicleProfileId` | 722 / 732 / 704 | the synchronous binding snapshot the OBD provider reads | SignalFinderScreen (first) |
| `setActiveVehicleProfileIdExplicit` | 883 | the ONLY way a UI profile choice may be written (sets `activeVehicleProfileSource: 'user'` atomically) | SignalFinderScreen |
| `subscribeVinAutoDetectNotice` / `dismissVinAutoDetectNotice` / `VinAutoDetectNotice` | 902 / 911 / 887 | "Detected from VIN — …" banner | SignalFinderScreen |
| `maybeDetectVehicleFromVin` | 996 | one-shot ENET VIN read, never steals the adapter | SignalFinderScreen + `telemetryProvider.start()` |
| `decideVinAutoSelect` / `applyVinAutoSelect` / `maskVin` / `hasUserExplicitlyChosenVehicleProfileThisRun` / `applyInitialActiveVehicleProfile` | 927 / 946 / 968 / 873 / 812 | pure rules + the one-time profile migration | internal + tests |
| `relaySessionCompleteBarrier` | 229 | the settle-or-cap relay, as a free function so it is directly unit-testable | `SwappableFacade` + tests |
| `restoreProductionFacade` / `startDevReplaySession` / `runDevReplayScenario` / `useMockFacadeForDevReplay` / `DevReplayScenarioResult` | 3616 / 3680 / 3802 / 3864 / 3778 | `__DEV__` replay transitions | DevReplayScreen |
| `listUnvalidatedMatchingSessionIds` | 4059 | — | **nothing — see §9** |

### 1.7 Test Loop mode — the one flow that consumes GNSS before a controller exists

`composition.ts:2199-2223` is the best summary in the codebase; read it. The short version: lap 1
*creates* the circuit, so the recording pipeline must run before any `SessionController` can
exist. `TestLoopLocationProvider` (`src/session/testLoopProvider.ts`) wraps the GNSS singleton
and **buffers every fix**; when lap 1 closes, `adoptLearnedCircuit` (`:2633`) persists the
geometry, selects it, builds a controller *on the buffering provider*, starts and arms a session,
and replays the whole backlog in order. Nothing is stopped and nothing is dropped.

Two durability mechanisms hang off it and are easy to miss:

- **The adoption ledger** (`adoptionProgress`, `:2246`) — each of the six steps is skipped if the
  ledger says it already happened, so a retry *resumes* rather than inserting a second circuit.
- **The adoption journal** (`src/session/adoptionJournal.ts`, staged at `:2363`) — on disk before
  the first side effect, claimed by compare-and-swap at the next launch
  (`repairInterruptedAdoption`, `:2431`), with an attempt budget. Geometry on disk → complete the
  adoption; geometry missing → delete the orphan session and circuit row in one transaction.

---

## 2. Screen by screen

One native stack, `src/ui/navigation/RootNavigator.tsx`, initial route `CircuitSelection`.
Route params: `src/ui/navigation/types.ts`. Dark theme is the default and is not a preference
(`App.tsx:19-23`).

| Screen | File | Shows | Reads | Can do | Reached from → goes to |
|---|---|---|---|---|---|
| **CircuitSelection** (S1) | `CircuitSelectionScreen.tsx:24` | N-row catalog list (bundled + learned, labelled differently), logo/wordmark | `circuitCatalog.list()`, `settingsStore` | tap a circuit (persists selection *before* navigating); enter Test Loop | app start → `CircuitDetail`, `TestLoop` |
| **CircuitDetail** (S2) | `CircuitDetailScreen.tsx:38` | circuit metadata, provenance, corners, ODbL + advisory notice; **recovery banner**; **bootstrap-failed banner with Retry** | `subscribeRecovery`, `subscribeRecoveryNotice`, `subscribeBootstrapState` | Start Session (disabled until `bootstrapState==='ready'`), Resume/Discard recovery, Retry bootstrap | Selection → `Preflight`, `SessionHistory`, `Settings`, `ActiveDashboard` (after resume) |
| **Preflight** (S3) | `PreflightScreen.tsx` | the six checks (location services, permission, precise location, GNSS fix, battery, keep-awake) + circuit proximity | `runPreflightChecks()` from `platform/preflight.ts`, `evaluatePreflightProximity` | request permission, re-run, proceed anyway | Detail → `CalibrationInstructions` |
| **CalibrationInstructions** (S4) | `CalibrationInstructionsScreen.tsx:24` | the four Learn-lap steps **and, unasked, the report of the attempt that just failed** | `getLiveCalibrationAttempt()` → `buildCalibrationReport()` | Start Calibration (`facade.beginCalibration()`) | Preflight, or a Cancel/Retry from calibration → `ActiveCalibration` |
| **ActiveCalibration** (S5) | `ActiveCalibrationScreen.tsx` | coverage ring, live track map, status banner | `useFacadeState(facade)` | Cancel (long-press, intercepts the back gesture via `calibrationEscape.ts`), **"Start session anyway"** (`proceedWithoutCalibration`) | → `CalibrationResult`, `CalibrationInstructions`, `ActiveDashboard` |
| **CalibrationResult** (S6) | `CalibrationResultScreen.tsx` | accept/reject verdict, per-reason plain-language copy, the full calibration report card | `useFacadeState`, `getLiveCalibrationAttempt` | Accept & arm, Retry, "Start session anyway" | → `ActiveDashboard`, `CalibrationInstructions` |
| **ActiveDashboard** (S7) | `ActiveDashboardScreen.tsx:33` | THE driving screen: dominant delta, lap time, sector bar, quality pill, coach strip, telemetry strip, calibration chip. No scroll, no modals, `useKeepAwake()` | `useFacadeState`, `settingsStore` | End Session (2 s long-press) only; Pit View entry **only while stopped** (`inPit`/`paused`) and only with `suggestionsEnabled` | → `SessionResults`, `PitView` |
| **SessionResults** (S8) | `SessionResultsScreen.tsx` | lap table, sector bests, calibration status, per-lap verdict controls, unsaved-verdict warnings | `useFacadeState`, `getMostRecentSessionId`, verdict fns, `resolveResultsCalibrationStatus` | record verdicts, **Share report** (`shareSessionReport`), open Analysis | ← Dashboard → `Analysis`, `SessionHistory`, `CircuitDetail` |
| **SessionHistory** (S9) | `SessionHistoryScreen.tsx` | past sessions for the selected circuit, UNCALIBRATED / unknown-provenance / test-loop labels, verdict summaries, unwritten-sample warnings | `sessionHistoryStore`, `resolveSessionCalibrationStatus`, `getLapVerdictSummary` | Share a session report, open a lap, open Analysis, open PB | ← Detail/Results → `LapDetail`, `Analysis`, `PersonalBest` |
| **LapDetail** (S10) | `LapDetailScreen.tsx` | one lap: time, sectors, quality, invalid reasons, verdict control, **telemetry sparklines** bucketed from `telemetry_samples` | `sessionHistoryStore`, `getTelemetryReadDb()` + `telemetryRead.ts`, verdict fns | record a verdict | ← History, PB. Leaf. |
| **PersonalBest** (S11) | `PersonalBestScreen.tsx:36` | the PB lap with provenance, **plus its own calibration qualification** (copy from `ui/calibrationNotice.ts`) | `sessionHistoryStore.getPersonalBest()`, `resolveSessionCalibrationStatus(pb.sessionId)` | open the PB lap | ← History → `LapDetail` |
| **Analysis** (S14) | `AnalysisScreen.tsx:43` | post-session corner analysis: corner rows with badges, expanding into per-lap numbers, the envelope visual and the engine's own sentence | `getAnalysisRunner()` + `createAnalysisController`, `getTrackdayRecord`, `facade` | expand rows, export (`shareAnalysisExport` / `shareAnalysisJson`) | ← Results, History. Leaf. Ordinary product route, no dev gate. |
| **PitView** (S15) | `PitViewScreen.tsx:32` | between-stint view: corners costing the most time, each expanding into the same corner visual; bounded suggestions only when opted in | `getActiveStintContext()`, `getStintCoach()` → `buildPitViewState` | acknowledge/apply a suggestion, back | ← Dashboard (while stopped). Read-only over the running session. |
| **TestLoop** | `TestLoopScreen.tsx:33` | learn-phase progress, the "track learned" banner, a name field to save it | `subscribeTestLoop`, `testLoopSnapshot` | start/stop learning, retry adoption, `saveLearnedCircuit` | ← Selection → `ActiveDashboard` |
| **Settings** (S12) | `SettingsScreen.tsx` (1474 lines) | units, delta deadband, coaching + voice, suggestions, IMU fusion/gyro/smoothing, telemetry + adapter config (ELM327/ENET host/port/target/PIDs), language, diagnostics, About, **Delete all my data** (two-step, hidden during an active session) | almost everything | edit every setting, run adapter discovery, wipe all data; **hidden developer section** via `registerDevTap` | ← Detail → `Telemetry`, and (dev only) `DevReplay`, `DidProbe`, `DidSweep`, `SignalFinder` |
| **Telemetry** | `TelemetryScreen.tsx` | manual OBD monitor: per-channel live values, provider state, ENET diagnostics (frames, NRCs, latency percentiles), G-force summary, network info | `telemetryProvider` + `gForceProvider` directly | Start/Stop the provider (takes its own G reference via `acquireGForce`) | ← Settings. Leaf. |
| **SignalFinder** | `SignalFinderScreen.tsx` (992 lines) | guided channel discovery: target catalog, metronome pacing, candidate scores, confirm-a-binding, profile chips, VIN banner | `signalFinderController`, `didSweepStore`, VIN/profile fns | run a finder session, confirm a binding (then `refreshVehicleProfileBindingsCache()`), switch profile, export | ← Settings (dev-gated entry) → `DidSweep` with a range |
| **DidSweep** | `DidSweepScreen.tsx` (1449 lines) | raw DID range sweep, responder table, resumable runs, tag-as-channel, export | `didSweepController`, `didSweepStore`, `facade` (refuses during a session) | start/pause/resume/stop a sweep, export | ← Settings, SignalFinder, DidProbe. Leaf. |
| **DidProbe** | `DidProbeScreen.tsx` (539 lines) | one-shot UDS request/response log against a chosen ECU/DID | `didProbe.ts` gating, `enetAdapterReservation` | send one request | ← Settings → `DidSweep` |
| **DevReplay** (S13) | `DevReplayScreen.tsx:40` | bundled fixture scenarios with expected outcomes, live diagnostics | `getLiveDiagnostics`, `DEV_REPLAY_SCENARIOS` | run a scenario through the **real** production pipeline at 10×, toggle the scripted mock, restore production | ← Settings. **`__DEV__` only, and the route itself is behind an inline `require()`** (§4, fence 5) |

Routes registered in **every** build, dev-gated only at their Settings entry point:
`DidProbe`, `DidSweep`, `SignalFinder` (`RootNavigator.tsx:34-53`). Only `DevReplay` is
dev-gated at the route.

---

## 3. The provider layer

### 3.1 The generation-guard idiom — read this once

Every provider here has the same problem: `start()` and `stop()` are async, they can overlap, and
a `stop()` (or a newer `start()`) that lands while an older `start()` is still awaiting a lazy
native import must prevent that stale attempt from installing anything afterwards.

The idiom:

```ts
let generation = 0;                       // module/closure-scoped counter
// in start():
const myGeneration = ++generation;        // claim
await somethingAsync();
if (myGeneration !== generation) return;  // superseded — install nothing, emit nothing
```

Three properties make it work, and all three are load-bearing:

1. **Claim before the first `await`**, so the claim is atomic with respect to the JS event loop.
2. **Re-check after *every* `await`**, not just the first — including after teardown, not only
   before it. `didSweepController.ts:1094` and `:1126-1138` record the review finding that made
   this explicit.
3. **A stale generation owns nothing.** Whoever bumped the counter owns teardown, the final state
   emission and any shared reservation. A superseded continuation must not release a token, close
   a transport, or emit a state — it would be clobbering the *new* generation's.

Where it appears:

| Site | Counter | Guards |
|---|---|---|
| `session/gforceProvider.ts:599` | `generation` | a `stop()` racing an in-flight sensor start |
| `session/telemetryProvider.ts:980` (`generationCounter`) and the `SessionGeneration` object at `:922-948` | per-generation transport + reservation token | a stale generation closing a *newer* one's socket, or never closing its own |
| `session/telemetryProvider.ts` `lifecycleGeneration` (`:1275`, `:2490`) | user-intent generation | a pedal-fallback relaunch continuation running after the user pressed Stop |
| `session/didSweepController.ts:675` | `generation` | every await point in the sweep/observation loops (most heavily guarded module in the app) |
| `session/analysisViewModel.ts:239` (runner) and `:428` (controller) | epoch | a superseded analysis pass publishing, and a result landing after the screen left |
| `composition.ts:2256` `teardownGeneration` | learn-phase teardown | a teardown queued for a learn phase that has since restarted |
| `DevReplayScreen.tsx` run generation → `runDevReplayScenario(scenario, isCancelled)` | screen generation | installing a replay into a screen that is already gone |

### 3.2 GNSS — `src/platform/gnssLocationProvider.ts`

- **Start:** `start()` (`:168`) appends onto a serialization chain `op` (`:166`) so overlapping
  `start`/`stop` execute in invocation order — never two `watchPositionAsync` calls in flight.
  The chain survives a rejected op (`:174`), otherwise one failed start would wedge every later
  call. `doStart()` (`:184`) no-ops if already subscribed, snapshots iOS accuracy authorization
  once, then opens the watcher with `BestForNavigation`, `timeInterval: 0`, `distanceInterval: 0`.
- **Stop:** `doStop()` (`:202`) removes the subscription. Idempotent.
- **Failure:** there is no internal retry. Recovery is the core watchdog's job via
  `restartProvider` (wired in `createProductionController`, `composition.ts:1708`).
- **Absent / dies mid-session:** the ADR-0003 §1 watchdog in `SessionController` restarts the
  provider; `FacadeState.gnssQuality` degrades and the dashboard's quality pill and banner show
  it. Lap timing simply has no input — nothing crashes.
- **Ownership:** composition stops it after a controller rebuild (`composition.ts:1947`), because
  `SessionController.dispose()` deliberately will not stop a possibly-shared provider. The one
  exception is a Test Loop handover, where the watcher is genuinely still owned.
- **Mocked samples:** Android's `location.mocked` rejects the sample and counts it (`:232`); iOS
  has no equivalent flag — a documented platform gap.
- **Diagnostics:** rolling 300-sample interval histogram + accuracy min/p50/p95 (`:215`),
  surfaced through `composition.getLiveDiagnostics()` and rendered as Hz by
  `estimateObservedRateHz`.

### 3.3 OBD telemetry over TCP — `src/session/telemetryProvider.ts` (2586 lines)

Two adapter families behind one interface: **ELM327** (ASCII, `TcpObdTransport`) and **BMW ENET**
(HSFZ binary, `EnetTcpTransport`). The provider builds the session from `@circuit/core`
(`createElm327Session` / `createEnetSession`) and owns only lifecycle and policy.

- **Start** (`:2394`): returns immediately if `telemetryEnabled` is false. Then, in order —
  coalesce into any in-flight start (`starting !== null`); if `running`, no-op **only** if the
  generation is non-terminal *and* the config fingerprint still matches (`:2419-2421`), otherwise
  tear down and relaunch; if a teardown is in flight, queue behind it (`:2454`); else
  `launchFresh()`.
- **Config fingerprint** (`currentConfigFingerprint`, `:576`): adapter type/host/port/etc. A
  settings subscription (`:2287`) stops a live generation the moment the fingerprint changes,
  emitting `'stopped'` with detail `'settings changed'` — guarded by generation so it cannot
  overwrite a newer attempt's state.
- **Reconnection** (`:643-665`): indefinite for the life of one `start()`..`stop()`, backing off
  3 s → 6 s → 12 s → 24 s → 30 s and holding at the cap. The backoff resets the moment a
  generation reaches `'polling'`. This replaced a single-retry policy that turned one WiFi hiccup
  into "no OBD for the rest of the stint" — the adapter is a consumer dongle in a moving car.
- **Adapter exclusivity:** the MHD ENET adapter accepts one ECU client. `enetAdapterReservation.ts`
  is the single atomic arbiter, with opaque symbol tokens and **no same-owner reacquire** — five
  owners: `provider`, `probe`, `discovery`, `sweep`, `signalFinder`. A blocked start emits
  `'idle'` with detail `'adapter reserved by probe'` rather than failing.
- **Transport close race** (`:1219`): the graceful `session.stop()` is raced against a 200 ms
  timeout; if the timeout wins, *this generation's own* transport is force-closed. This is the
  "socket left open" driveway-test bug.
- **Absent / dies mid-session:** nothing. `MUST NOT interact with lap timing` is stated at
  `composition.ts:664-673` and enforced structurally — the provider never calls into `facade` or
  `SessionController`; composition only subscribes to its samples outbound. A dead adapter means
  no OBD rows; the session, laps, PB and analysis are unaffected.
- **Vehicle-profile bindings:** read **synchronously** by `buildEnetConfig`, so composition keeps
  an async-refreshed cache (`composition.ts:708-734`). Refreshed (a) when bootstrap resolves `db`,
  (b) when the Signal Finder confirms a channel, (c) defensively on every `start()` — (c) affects
  the *next* start, not the one it is called from.

### 3.4 Device sensors — `src/session/gforceProvider.ts` (1177 lines)

- **Start** (`:1101`): claims a generation, lazily imports `expo-sensors`, checks
  `isAvailableAsync()`, subscribes at ~25 Hz (40 ms). Re-checks `running && myGeneration` after
  every await. A throw anywhere is swallowed — an absent accelerometer means no data, never a
  failure.
- **Stop** (`:1132`): bumps the generation and unsubscribes.
- **Ownership:** refcounted in composition (`acquireGForce`/`releaseGForce`, `:1142-1158`) because
  there are two independent users — the Telemetry monitor screen and a driving session. The
  session's own hold is tracked separately (`sessionHoldsGForce`, `:1182`) so a session that
  *never acquired* (telemetry disabled, web, recovery) cannot release the monitor's reference.
- **Portrait mount is assumed** and not detected (`gforceProvider.ts:27-33`). `latG` = device X,
  `longG` = device Y.
- **Units:** `expo-sensors` already reports g, not m/s². Dividing by 9.81 would shrink every value
  tenfold; `gforceProvider.ts:34-48` and a dedicated "no re-scaling" test pin this.
- **Accelerometer rest vector** differs between iOS (down) and Android (up) and decides the sign
  of `yawRateDps`. It is resolved inside the provider by a lazy `import('react-native')`
  (`:422`), *not* in composition — see §4, fence 1.
- **Opt-in IMU fusion** (`imuFusionEnabled`, default off) swaps the low-pass gravity estimate for
  `MadgwickAhrs` and emits `yawRateDps`. Read once per `start()` and frozen for that run, so the
  estimator never changes under a lap being recorded. Gyro *capture* is a separate setting, on by
  default. Gaps: a gyro reading older than 120 ms is treated as zero rotation; an accelerometer
  gap over 500 ms **reseeds** rather than integrates; sustained slow delivery integrates and
  raises a `degraded` flag instead of reseeding every sample.

### 3.5 The other two providers

- **`TestLoopLocationProvider`** (`src/session/testLoopProvider.ts`) — wraps the GNSS singleton,
  keeps every fix, and replays the backlog into the controller at handover. §1.7.
- **`ReplayLocationProvider`** (`src/platform/replayLocationProvider.ts`) + the virtual-clock
  wrappers in `src/session/liveTimestampedProvider.ts` — the DevReplay path. Samples are
  **re-stamped into a scaled virtual time domain** so the fixture's own inter-sample spacing
  survives the 10× delivery pace; otherwise the quality evaluator's implied-speed check reads
  compressed speeds. `restartProvider` must restart the *wrapper*, not the inner provider — only
  the wrapper re-anchors the time source (`composition.ts:3669-3679`).

---

## 4. The platform fences

This is the section that bites people. Each fence has a symptom you will actually see.

### Fence 1 — `react-native` may not be reached from anything vitest imports

**Rule.** No module in `composition.ts`'s import graph — static `import` *or* `require` — may
reference `react-native`. Vite resolves React Native's Flow-typed source and the whole file fails
to parse.

**Symptom.** `Expected 'from', got 'typeOf'` (or a similar Flow parse error) from vitest, naming a
file deep inside `node_modules/react-native`, and **every** suite that transitively imports
`composition.ts` goes red at once — currently ~23 test files.

**Evidence.** `composition.ts:31-35` (web detection via `typeof document` rather than
`Platform.OS`), `composition.ts:1093-1106` (the platform accelerometer read deliberately does not
live in composition; measured on that exact change), `rawSessionExport.ts:54`,
`sessionReportShare.ts:21`, `.foreman/ledger.md:799` ("broke 136 composition tests by pulling
react-native into composition's graph").

**How the codebase complies.** Three techniques, in order of preference:

1. **Type-only imports** — erased at compile time, therefore safe. `tcpObdTransport.ts:7`,
   `enetTcpTransport.ts:7`, `voiceCoach.ts:12`, `ui/theme/index.ts:1`.
2. **Lazy dynamic `import()` inside the function that needs it.** The complete list:

   | File:line | Lazily loads |
   |---|---|
   | `session/tcpObdTransport.ts:21` | `react-native-tcp-socket` |
   | `session/enetTcpTransport.ts:14` | `react-native-tcp-socket` |
   | `session/gforceProvider.ts:390`, `:434` | `expo-sensors` (Accelerometer, Gyroscope) |
   | `session/gforceProvider.ts:422` | `react-native` (`Platform`) |
   | `session/voiceCoach.ts:53`, `:77` | `expo-speech`, `expo-audio` |
   | `platform/preflight.ts:204` | an optional battery module |

3. **Splitting the module.** `rawSessionExport.ts` (pure document/loader, imported by
   composition) vs `rawSessionShare.ts` (`expo-file-system` + `expo-sharing`, imported only by
   screens). Same split: `sessionReport.ts` / `sessionReportShare.ts`.

**What is allowed.** `expo-constants` is imported statically by `composition.ts:1` — it is plain
JS and tests mock it anyway (22 test files do). Pure `@circuit/core` imports are always fine.

**Where the boundary currently sits.** Static `react-native` importers are exactly: every
`ui/components/*.tsx`, every `ui/screens/*.tsx`, `ui/theme/index.ts` (type-only) and
`platform/lifecycle.ts`. `platform/lifecycle.ts` is the interesting one — it *is* in
composition's graph via `platform/index.ts`, which is why **every composition test mocks
`../../src/platform` wholesale** (23 test files do exactly that).

### Fence 2 — `expo export` must run from `apps/mobile`, never the repo root

**Rule.** `cd apps/mobile && npx expo export --platform ios`
(`docs/NEXT-CIRCUIT-PLAYBOOK.md:19`; the mobile `package.json` script is `export:ios`).

**Symptom from the repo root.** There is no `app.json`, no `metro.config.js` and no `expo`
dependency at the root (`package.json` there has only `typecheck`/`test`/`lint`/`format`/
`generate:*`). Expo either refuses to find a project or resolves the wrong project root, and the
monorepo `watchFolders`/`nodeModulesPaths` wiring in `apps/mobile/metro.config.js:10-21` — which
is what makes `@circuit/core` resolvable at all — never applies.

**Why it matters beyond convenience.** `expo export` is a **gate**, not a build step: it is the
only thing in the pipeline that proves the Metro graph actually resolves and that release-only
bundling (fence 5) behaves. The playbook's gate set is
`npm run typecheck && npm test && npm run lint` (root) **plus** the export (from `apps/mobile`).

### Fence 3 — gates are read from real exit codes, never through a pipe

**Rule.** `cmd > log 2>&1; ec=$?`. Never `npm test | grep ...` — that returns *grep's* exit code.

**Symptom.** A green-looking campaign note over a red tree. `docs/NEXT-CIRCUIT-PLAYBOOK.md:14-18`
records that this shipped two red commits before the rule existed.

### Fence 4 — some modules are deliberately pure so tests can import them

**Rule.** If a piece of logic is a *decision*, it belongs in a `session/*.ts` (or `ui/*.ts`)
module with no `react-native` and no native Expo import, and the `.tsx` becomes a renderer.

**Symptom of crossing it.** You cannot write a test for your change at all, and the reviewer asks
where the test is. There is no render harness to fall back on (§5).

Explicitly-documented cases: `resolveResultsCalibrationStatus` lives in composition rather than
`SessionResultsScreen` "so the precedence rule is testable — `SessionResultsScreen.tsx` reaches
into react-native and cannot be imported by the test runner" (`composition.ts:4026-4029`); the
telemetry-strip tint/visibility rules live in `telemetryProvider.ts:737-745` rather than
`TelemetryStrip.tsx`; the calibration copy lives in `ui/calibrationNotice.ts`; the learned-circuit
default name lives in `ui/screens/testLoopStrings.ts` even though composition mints it
(`composition.ts:116-118`).

### Fence 5 — `__DEV__`-only code must be behind an inline `require()`, not a top-level import

**Rule.** Gating the `<Stack.Screen>` registration is **not** enough.

**Symptom.** `DevReplayScreen` and its `@circuit/core` fixture-scenario dependencies enter the
release bundle's dependency graph anyway — a top-level `import` reaches the module at bundle time
regardless of which runtime branch uses it. Metro constant-folds `__DEV__` and drops
statically-unreachable code, **but only when the module boundary is inside the folded branch**.

**Evidence and the working pattern.** `RootNavigator.tsx:54-58` (no top-level import) and
`:150-168` (the `__DEV__ ? <Stack.Screen component={(require('../screens/DevReplayScreen') as
typeof import('../screens/DevReplayScreen')).DevReplayScreen} .../> : null`). `typeof import(...)`
gives full type-checking with zero runtime footprint.

### Fence 6 — never re-enter the SQL write gate

**Rule.** `openAppDatabase()` returns a handle that acquires the gate around **every** call made
through it. Inside a `withTransactionAsync` callback you must use the `tx` handle it hands you,
never the outer handle; and you must never wrap a gated statement in your own `gate.exclusive()`.

**Symptom.** A hang with no error — the statement queues behind the transaction that is waiting
for it. `sqlWriteGate.ts:5-42` records both halves: the original every-call FIFO self-deadlocked
every repository transaction, and the over-correction ("gate only transactions") let a standalone
write join, and be rolled back by, an unrelated open transaction — nine chunk rows reported
persisted and then silently lost.

**Corollary.** `TelemetryRecorder` issues **zero** `BEGIN`s ever (`telemetryRecorder.ts:32-41`): a
flush is one parameterized multi-row `INSERT`, because a nested transaction on the same connection
threw "cannot start a transaction within a transaction" and broke lap persistence.

### Fence 7 — never re-enter `lifecycleLock`

**Rule.** Inside a section, call the `unlocked*` routine. See §1.3.

**Symptom.** Either `LifecycleLockReentry` (synchronous case — you get a clear error) or a
**permanent silent hang** (post-`await` case — undetectable by construction).

### Fence 8 — Metro needs literal, static `require()` for assets

**Rule.** Bundled assets (the voice-clip mp3s) must appear as literal `require('...')` calls.

**Symptom.** Under vitest, vite-node tries to parse the mp3 as JavaScript and 24 tests go red
(`.foreman/ledger.md:96` — three config-level workarounds were tried and all reverted).

**The fix in place.** `session/voiceClips.gen.ts:20-26` wraps each literal require in
`safeRequire(() => require(...))`; Metro still statically collects the literal, and vitest gets
`undefined` (reproducing the pre-generation empty-map behaviour tests were written against). The
file is generated by `scripts/generate-voice-pack.mjs` — **do not hand-edit it.**

### Fence 9 — the offline mandate is enforced by a static source-text test

**Rule.** No `fetch`, `XMLHttpRequest`, `WebSocket`, `dgram`, `react-native-udp` or `createSocket(`
may appear in the *source text* of any ENET-related file. `EnetTcpTransport` is the app's one
network-capable module.

**Symptom.** `test/session/enetNoRawNetworkApis.test.ts` fails by filename. Note that it is a
**grep over source text, not an AST check** — it will also fire on a comment or a variable named
`fetch`.

### Fence 10 — the web preview has no SQLite

`composition.ts:2895-2902`: `IS_WEB_RUNTIME` falls back to `InMemorySessionRepository`. So
`getTelemetryReadDb()` is permanently `null` there, learned circuits live in memory only
(`memoryLearnedCircuits`, `:2228`), and nothing survives a reload. This is the surface the visual
review uses (`.claude/launch.json` → mobile-web on :8082) — every session flow works, nothing
persists. Related RN-web quirks are listed in `docs/NEXT-CIRCUIT-PLAYBOOK.md:30-35`.

---

## 5. Testing reality

**There is no React Native render harness in this repository, and adding one has been repeatedly
declined.** `apps/mobile/vitest.config.ts` says it plainly: *"PURE-TS session/persistence modules
only — no React Native test renderer, no expo runtime"*, `environment: 'node'`,
`include: ['test/**/*.test.ts']` — note `.ts`, not `.tsx`.

### What that means in practice

**No `.tsx` file is ever imported by a test.** Not one. Zero components and zero screens are
rendered, mounted, or snapshotted, ever.

Consequences, and how the codebase lives with them:

| Concern | How it is actually verified |
|---|---|
| Does a decision produce the right answer? | A pure module under `session/` or `ui/` is unit-tested directly. This is where essentially all coverage lives. |
| Does a screen wire that decision up correctly? | **Typecheck + bundling only.** `tsc --noEmit` catches shape errors; `expo export` catches resolution errors. Nothing catches "the screen calls the right function with the wrong argument". |
| Does a screen show the right *words*? | Static **source-text** assertions. `test/session/analysisStrings.test.ts:75` reads `AnalysisScreen.tsx` as a *string* and asserts it "holds no prose of its own". |
| Is a route registered / gated correctly? | Same technique: `test/session/analysisRouteGating.test.ts:23` greps `RootNavigator.tsx` source; likewise `hiddenDeveloperModeRouteGating.test.ts`, `signalFinderRouteGating.test.ts`. |
| Does it look right? | Human visual review in the web preview, before any ipa build (`docs/NEXT-CIRCUIT-PLAYBOOK.md:30-35`). Layout is explicitly *not* tested — `.foreman/ledger.md:245` logs "L2 label flexShrink + narrower hex inputs (**not layout-tested — no RN renderer**)". |

### The test doubles

| Double | File | Notes |
|---|---|---|
| `../../src/platform` | mocked in 23 test files | Whole-module mock. Required because `platform/lifecycle.ts` imports `react-native`. |
| `expo-constants` | mocked in 22 files | `composition.ts:1` imports it statically for `appVersion()`. |
| `../../src/persistence/expoSqlDatabase` | mocked in 22 files | Replaced with a `sql.js`-backed handle. |
| `sql.js` `SqlDatabase` | `test/support/sqlJsDatabase.ts` | **Applies the same write gate as production** (`:18-30`) — an ungated double hid a real "cannot start a transaction within a transaction" collision. |
| `FakeClock` / `FakeLocationProvider` | `test/support/coreTestDoubles.ts` | Local copies, not imports from `packages/core/test/**`, because that tree is only typechecked under core's own tsconfig. |
| harnesses | `test/support/{analysisHarness,didSweepHarness,signalFinderHarness,testLoopTraces}.ts` | |

Also mocked where needed: `expo-file-system`, `expo-sharing` (9 each), `gforceProvider`,
`enetTcpTransport` (9 each), `telemetryProvider`, `tcpObdTransport` (4 each), `@circuit/core` (6).

### How to structure new UI so it stays testable

1. **Write the decision first, in a `.ts` module with no `react-native` import.** A view-model
   function taking plain data and returning plain data. Existing exemplars:
   `analysisViewModel.ts` (`buildAnalysisScreenState`), `pitViewModel.ts` (`buildPitViewState`),
   `lapVerdictViewModel.ts` (`buildLapVerdictRows`, `verdictControlEnabled`,
   `verdictTapFeedback`), `calibrationReportViewModel.ts` (`buildCalibrationReport`),
   `ui/calibrationNotice.ts`, `ui/format.ts`, `ui/data/circuit.ts`, `session/trackMapModel.ts`.
2. **Put every visible string in a `*Strings.ts` table**, keyed RO/EN, with a
   `resolve*Strings(language)` function (`analysisStrings`, `testLoopStrings`,
   `signalFinderStrings`, `trackdayStrings`, `lapVerdictStrings`, `sessionReportStrings`,
   `calibrationReportStrings`, `imuSettingsStrings`, `invalidReasonCopy`). Unknown language → EN.
3. **The `.tsx` then contains only JSX, styles and `useState`/`useEffect` plumbing.** If you find
   yourself writing an `if` about *driving* in a `.tsx`, it is in the wrong file.
4. **If you must pin something about the `.tsx`, assert over its source text** with
   `readFileSync` — that is the established pattern, not a workaround.

There is no i18n framework. "i18n" here means the string tables above plus
`settingsStore.defaultLanguageForLocale()` (`settingsStore.ts:37`), which reads the device locale
through `Intl` — chosen specifically because it needs no native module and no `react-native`
import.

---

## 6. State that crosses the boundary

### The shape

`FacadeStateCore` is `@circuit/core`'s UI-facing projection of live session state.
`FacadeState` (`src/session/facade.ts:19`) is the app's copy of it, plus one app-owned field.

`RealSessionFacade.mapState()` (`realFacade.ts:4-27`) is the **only** mapper, and it is
deliberately field-for-field 1:1 for everything except `lastError`:

| `FacadeState` field | Source |
|---|---|
| `sessionState`, `lapNumber`, `currentLapMs`, `lastLapMs`, `pbMs`, `delta`, `sector`, `gnssQuality`, `calibration`, `calibrationResult`, `laps`, `speedKph`, `coachCue`, `trackMatch`, `recording`, `matchingUnvalidated`, `calibrationStatus` | mirrored 1:1 from `FacadeStateCore` |
| `lastError` | **owned by the facade**, not core — set by `guard()` (`realFacade.ts:110`) when an async command rejects, cleared only on the controller's next genuinely successful state change (`:76-93`) |

`facade.ts:19-24` states the rule: this interface is deliberately smaller than the domain
`SessionMachineSnapshot`, and **UI code must never reach past the facade** into core's
timing/geometry/state-machine types.

Commands are fire-and-forget `void` methods — screens dispatch and observe, never await. The one
async affordance is the optional `whenCommandsSettled()` (`facade.ts:130-149`), which exists
solely so `SwappableFacade` can hold `lifecycleLock` across a command's real async work.

### The trio

| Implementation | File | Role |
|---|---|---|
| `RealSessionFacade` | `session/realFacade.ts:50` | Adapts `SessionController`. Owns no pipeline logic; every command is a pass-through. Fires `onSessionStarted` (session id known) and `onSessionEnded` (summary saved) — the two hooks composition uses for the active-session pointer, telemetry recording and history refresh. `dispose()` detaches the subscription without disposing the controller, which composition owns. |
| `MockSessionFacade` | `session/mockFacade.ts` | A **scripted** facade: three deterministic lap scripts cycled indefinitely, a fake calibration timer, a fixed initial PB. Reaches nothing — no provider, no repository, no clock beyond `setInterval`. |
| `PendingFacade` | `composition.ts:618` | Inert. Every command a no-op, one frozen state (`PENDING_FACADE_STATE`, `:595`). |

**Why the mock still exists.** One reason only, and it is stated at `composition.ts:582-592`: pure
UI/style iteration on the DevReplay screen's `__DEV__` toggle
(`useMockFacadeForDevReplay`, `:3864`). It produces plausible laps and deltas with no GNSS, no
adapter and no database, which is what you want when you are adjusting a font size. It is **not**
a test double — no test uses it — and it is **not** a fallback: the "bootstrap failed → live mock"
behaviour was removed precisely because it let calibration start against a fake timer with no
persistence and no visible error.

`MockSessionHistoryStore` (`session/mockHistory.ts`) plays the same role for past sessions and is
the initial inner of `SwappableSessionHistoryStore` until bootstrap swaps in `SqlSessionHistoryStore`.

Every facade swap point clears `telemetryShutdown` (`:3634`, `:3762`, `:3875`) so a settled promise
from a previous session cannot be mistaken for the new facade's in-flight shutdown.

---

## 7. What is not here

`packages/core` is **pure TypeScript with no React, React Native or Expo import permitted**
(`docs/architecture/current-state.md:9`). The dependency inversion is the point: core consumes
`LocationSample` streams through the `LocationProvider` interface, and production (GNSS), dev
replay (fixtures) and tests all feed the *same* pipeline.

| Lives in `packages/core` | Why not here |
|---|---|
| Circuit-profile schema, validation, migration, JSON loader | Platform-independent data. The app only *selects* a circuit. |
| Geometry (local-plane projection, polyline projection, progress unwrapping, gate crossing) | Pure maths, property-tested with fast-check. |
| `CalibrationEngine` — the Learn lap, its 0.85 / 250 m thresholds and its verdict | The thresholds must be identical in replay and on device. The app may only *escape* the gate (`proceedWithoutCalibration`), never move it. |
| `SessionReducer` (state machine), `CrossingDetector`, `LapTimingEngine`, `LiveDeltaEngine`, `TrackMatcher`, `TelemetryQualityEvaluator` | The timing pipeline. Deterministic, fixture-driven. |
| `SessionController` — the production orchestrator, checkpointing, PB replacement, the ADR-0003 §1 watchdog, lap persistence | It must be drivable by the replay harness with no app present. |
| `SqlSessionRepository` + versioned DDL (`persistence-sql`) | The session/lap/checkpoint schema. `apps/mobile` only supplies the connection and adds **its own** additive tables (see below). |
| Corner analysis, the deterministic coaching/analysis engine, report prose in RO/EN | The sentences the driver reads are generated by the engine, not written in a screen. |
| Fixtures + `ReplayHarness` | Shared by core tests and the app's DevReplay screen. |
| ELM327 / ENET / HSFZ / UDS protocol: framing, parsing, PID decode, poll plans, discovery, signal scoring | Protocol knowledge. The app supplies only a byte pipe (`TcpObdTransport`, `EnetTcpTransport`) and lifecycle policy. |
| `MadgwickAhrs`, `deleteAllUserData`, `matchVehicleProfilesByVin`, `readVinFromChannel`, signal-target catalogs | Pure algorithms and data. |

**What `apps/mobile` owns that core does not know about at all:** the `telemetry_samples` table
(`persistence/telemetrySchema.ts`), the DID-sweep tables (`didSweepSchema.ts`), the learned-circuit
table (`learnedCircuitSchema.ts`), the per-session vehicle snapshot
(`sessionVehicleSnapshot.ts`), and the `settings` key-value rows the app writes. Each is an
additive migration with its own version row applied over the *same* connection. This is why
`deleteAllStoredUserData` has to delete `telemetry_samples` itself (`composition.ts:3496-3543`) —
core's `deleteAllUserData` has never heard of it.

---

## 8. Module quick index

**`src/session/` — composition, view models, providers, transports (all pure TS unless noted)**

| Module | Owns |
|---|---|
| `composition.ts` | §1 |
| `facade.ts` / `realFacade.ts` / `mockFacade.ts` / `mockHistory.ts` | §6 |
| `lifecycleLock.ts` | the FIFO mutex (§1.3) |
| `circuitCatalog.ts` | bundled (TMR + MotorPark) + learned circuits; `resolveSelectedCircuit` |
| `tmrProfile.ts` | the reference bundled circuit, loaded through `loadProfileFromJson` |
| `settingsStore.ts` | `AppSettings`, defaults, `defaultLanguageForLocale`, `registerDevTap`, `chooseInitialActiveVehicleProfileId` |
| `sqlSessionHistoryStore.ts` | SQL-backed history/PB cache for one circuit |
| `telemetryProvider.ts` | OBD lifecycle + reconnect + bindings + strip tint rules (§3.3) |
| `gforceProvider.ts` | accelerometer/IMU (§3.4) |
| `tcpObdTransport.ts` / `enetTcpTransport.ts` | byte pipes over `react-native-tcp-socket` |
| `enetAdapterReservation.ts` | the single-client adapter arbiter |
| `enetSettingsValidation.ts` / `customPidValidation.ts` / `networkInfo.ts` | adapter config validation, the read-only PID allowlist, phone network info |
| `pedalNormalization.ts` | 0x49 rest-offset learning |
| `didProbe.ts` / `didSweepController.ts` / `didSweepExport.ts` | one-shot probe; the sweep state machine (most generation-guarded module); sweep export |
| `signalFinderController.ts` / `signalFinderExport.ts` / `signalFinderHaptics.ts` | guided channel discovery; export; a **deliberate no-op haptics seam** (`expo-haptics` is not a dependency) |
| `analysisViewModel.ts` / `analysisAssembly.ts` / `analysisSessionLoader.ts` / `analysisExport.ts` | the analysis screen's every decision; the runner + cache; the read path; export (touches `expo-file-system`) |
| `stintCoaching.ts` / `pitViewModel.ts` | the trackday stage; the pit view's every decision |
| `lapVerdictStore.ts` / `lapVerdictViewModel.ts` | the owner's verdict on each lap; the control's every decision |
| `sessionReport.ts` / `reportExtras.ts` / `sessionReportShare.ts` | the complete per-session document; the tool roll-call; the share half |
| `rawSessionExport.ts` / `rawSessionShare.ts` | the raw dump; the share half (**see §9**) |
| `calibrationEscape.ts` / `calibrationReportViewModel.ts` | back-gesture interception + confirm copy; the calibration report |
| `testLoopController.ts` / `testLoopProvider.ts` / `testLoopGuards.ts` / `learnedCircuitStore.ts` / `adoptionJournal.ts` | Test Loop mode (§1.7) |
| `liveTimestampedProvider.ts` / `devReplayScenarios.ts` | replay virtual clock; the fixture list |
| `circuitProximity.ts` / `trackMapModel.ts` | preflight "are you at the track?"; map fitting/auto-rotation |
| `voiceCoach.ts` / `voiceClips.gen.ts` | voice cues (lazy `expo-speech`/`expo-audio`); the generated clip map |

**`src/platform/` — device adapters** (`index.ts` re-exports all): `clock.ts`
(`PerformanceNowClock`, with the per-launch-origin rule), `gnssLocationProvider.ts` (§3.2),
`replayLocationProvider.ts`, `permissions.ts` (foreground only, by design),
`preflight.ts`, `lifecycle.ts` (**the one `react-native` importer here**), `motionCapture.ts`
(**see §9**).

**`src/persistence/`** — `expoSqlDatabase.ts` (`openAppDatabase`, the one place the connection is
opened and all migrations applied), `sqlWriteGate.ts` (fence 6), `telemetrySchema.ts` +
`telemetryRecorder.ts` + `telemetryRead.ts`, `didSweepSchema.ts` + `didSweepStore.ts` (also holds
the vehicle-profile binding store), `learnedCircuitSchema.ts`, `sessionVehicleSnapshot.ts`,
`sqlSettingsStore.ts`.

**`src/ui/`** — `navigation/`, `screens/` (§2) + `*Strings.ts`, `components/` (16 dumb
components), `hooks/` (`useFacadeState`, `useSettings`), `theme/index.ts` (colors, spacing,
radii, typography, `fontFamily`), `format.ts`, `data/circuit.ts`, `calibrationNotice.ts`,
`branding.ts` (`APP_NAME = 'TRACE'`).

---

## 9. Questions and suspicions

Recorded, **not fixed**. Each carries its evidence so a later phase can investigate cheaply.

### S1 — `rawSessionShare.ts` is dead code (CONFIRMED)

`src/session/rawSessionShare.ts` exports exactly one symbol, `shareRawSessionExport` (`:50`).
A repo-wide search finds **no importer** — not a screen, not a test, not another `src` module.
The only other occurrences are doc-comment references in `rawSessionExport.ts:54` and
`sessionReportShare.ts:21` (both citing it as the *example* of the split-for-testability pattern),
plus three `.foreman/` history entries.

`buildRawSessionExport` (`composition.ts:4130`) is alive, but only as the `loadRaw` dependency of
`buildSessionReport` (`:4686`) and in two tests. Both share buttons in the UI call
`shareSessionReport` (`sessionReportShare.ts`), from `SessionResultsScreen.tsx:21` and
`SessionHistoryScreen.tsx:18`.

**Reading:** consistent with the stated belief — the session report (P12 item C / P13B) replaced
the standalone raw-export button, and the share half of the raw export was left behind. The
`.md`/`.json` file-naming helpers it uses (`rawSessionExportFileName`,
`buildRawSessionSummaryMarkdown`) *are* still tested directly by
`test/session/rawSessionExport.test.ts`, so deleting `rawSessionShare.ts` alone would break
nothing. **Risk: low. Confidence: high.**

### S2 — `resetTestLoop` and `listUnvalidatedMatchingSessionIds` have zero callers

`composition.ts:2602` (`resetTestLoop`) and `composition.ts:4059`
(`listUnvalidatedMatchingSessionIds`): each has exactly one occurrence in the whole repo — its own
declaration. No screen, no test, no internal use.

`resetTestLoop`'s doc comment says "Leaves Test Loop mode entirely (screen dismissed without a
learned track)", but `TestLoopScreen.tsx` imports `stopTestLoop`, not `resetTestLoop`. So the
controller's `reset()` is never called — a learn phase that failed may leave the screen in its
terminal snapshot on re-entry. **Worth checking against the actual screen behaviour before
deleting either.** Risk: low, but the Test Loop one is a possible real UX bug rather than mere
dead code.

### S3 — learned circuits can be created but not deleted from any screen

`deleteLearnedCircuit` (`composition.ts:2837`) is a careful, fully-tested function — it refuses
while the circuit is in use, falls back to the default selection, and is exercised by
`test/session/composition.testLoop.test.ts:207-226`. **No screen imports it.** Nor does any screen
import `listLearnedCircuits` (`:2798`) — the selection list gets learned circuits through
`circuitCatalog.list()` instead, and the only other reader is the session report's extras
roll-call (`:4588`).

So a driver can learn a track, save it, and then has no way to remove it. That looks like an
unfinished surface rather than a bug, but it is a user-visible gap. **Risk: medium (product), low
(code).**

### S4 — `platform/motionCapture.ts` is unused and eagerly imports `expo-sensors`

`createMotionCapture` has no caller anywhere in `src` or `test`. It is re-exported from
`platform/index.ts:22-27`, which `composition.ts:36-42` imports from, and it imports
`expo-sensors` **eagerly at module top level** (`motionCapture.ts:1`).

`gforceProvider.ts:15-26` explains that it deliberately did *not* reuse this module, for exactly
that reason plus its buffer-and-poll shape. The eager import is currently invisible because every
composition test mocks `../../src/platform` wholesale — but it means the barrel file cannot be
un-mocked, and it is one more native module pulled into the bundle for nothing. **Risk: low, but
it makes fence 1 harder to reason about than it needs to be.**

### S5 — `isSessionMatchingUnvalidated` is documented as superseded and still exported

`composition.ts:4046-4056` says every screen has been moved off it in favour of
`resolveSessionCalibrationStatus`, and the code agrees: the only UI occurrence is inside a
*comment* at `AnalysisScreen.tsx:98`. It still has a test
(`composition.p10aZeroLapRecovery.test.ts:197`). Harmless, but it is a trap — the predicate cannot
express the difference between `unknown` and `validated`, which is the exact mistake the P10A
wave was about.

### S6 — the trackday suggestion journal is in-memory only, and the report says so honestly

`suggestionJournal` (`composition.ts:4217`) does not survive a restart. `sessionReportExtras`
handles this correctly — `:4514-4526` reports `unavailable` with an explicit explanation rather
than claiming the stage did nothing. Flagging it not as a defect but because it is a genuine data
gap a reader of an exported report needs to know about, and because it is the kind of thing that
gets "fixed" by someone who has not read that comment.

### S7 — `AggregatedDeleteUserDataResult.ok` does not cover the unvalidated-matching log

`composition.ts:3554-3559`: the log clear is best-effort and, if it fails, only logs a warning —
the aggregate `ok` stays `true`. This is deliberate and commented ("a stale label on a deleted
session must never turn a successful wipe into a failed one"), and it is almost certainly right.
Recording it only so nobody "discovers" it later and changes it without reading the reasoning.

### S8 — `recoveryOperationInFlight` shares a promise across mixed return types

`composition.ts:3199-3211`: `runRecoveryOperation<T>` returns the in-flight promise cast to
`Promise<T>`, so a concurrent `discardRecovery()` (returns `void`) and `resumeRecovery()` (returns
`boolean`) share one value. The comment acknowledges this: *"the cast is unsound in theory but
safe in practice — the only typed consumer treats a non-true result as 'do not navigate'."*
`CircuitDetailScreen.tsx:93` (`if (resumed) navigation.navigate('ActiveDashboard')`) confirms the
claim holds today. It is an invariant held by one call site, not by the type system.

### S9 — `composition.ts` is 4862 lines and carries ~40 distinct responsibilities

Not a defect — the ordering guarantees are the reason it is one file, and every section documents
why it sits where it does. But it is the single largest comprehension cost in the app, the file
with by far the most test files pointed at it (23 `composition.*.test.ts`), and the place where a
missed `unlocked*` call hangs the app silently (fence 7). If anything here is ever split, the
`lifecycleLock` sections must stay together.

### Stated gaps in this document

- **`SettingsScreen.tsx` (1474 lines), `DidSweepScreen.tsx` (1449) and `SignalFinderScreen.tsx`
  (992) were surveyed, not read line by line.** Their §2 rows describe their surface accurately,
  but there may be logic embedded in them that ought to live in a pure module (fence 4). Worth a
  dedicated pass.
- **`didSweepController.ts` (2756 lines) and `telemetryProvider.ts` (2586)** — the lifecycle,
  generation-guard and reconnect behaviour documented in §3 was read directly; the protocol-level
  sweep/observation phase logic was not, and is not described here.
- **`packages/core` was not read** for this document. §7 is assembled from
  `docs/architecture/current-state.md`, `composition.ts`'s imports and the contracts cited in
  comments. Treat it as a pointer, not an authority.
- **No builds or tests were run** (read-only constraint). Every claim above is from source text,
  not from observed behaviour. In particular, the *symptoms* in §4 are quoted from the code
  comments and ledger entries that recorded them, not reproduced.
