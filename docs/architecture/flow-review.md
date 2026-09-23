# Flow review — the six real user journeys, traced end to end

> Written 2026-09-22/23 against the working tree at `4676545` (two `hardware/kicad/*` files dirty,
> no source files dirty). Read-only pass: **no builds, no tests, nothing executed.** Every claim
> below is either marked VERIFIED (I followed it in the source and cite `file:line`) or INFERRED
> (a step I could not confirm from source alone — platform runtime behaviour, or scheduler ordering).
>
> Scope: **flow and logic only.** No style, no naming, no coverage, no refactors.
>
> Starting point: the four maps in this directory. Findings already confirmed and in flight are
> excluded by instruction (unguarded `JSON.parse` in `listSessions`, `geometryValidated` defaulting
> to `true`, `markInvalid` off-contract, the CAN transceiver in the hardware doc, `rawSessionShare.ts`,
> `resetTestLoop` having no callers, `deleteLearnedCircuit` having no screen).
>
> Line numbers drift. Every citation also names a symbol or quotes text — search that first.

---

## 0. The one thing to read if you read nothing else

The navigation graph and the session state machine are two separate models of "where the driver is",
and **nothing reconciles them**. Five of the eight highest findings below are the same shape:

- the state machine has states with **no exit that the UI can reach** (`awaitingCalibration`,
  and `sessionComplete` on a controller the preflight gate never gets asked to rebuild);
- the navigator has **back paths that the state machine has no opinion about** (the edge-swipe
  off `SessionResults`, the header back off `TestLoop`);
- and every refusal that results is returned as a value that the screen **logs to the console
  and drops** (`selectCircuit` → `{ok:false, reason:'SESSION_ACTIVE'}`).

The individual guards are all correct in isolation. What is missing is a rule that says *every
refusal reaches the driver*, and a rule that says *every screen that can be reached by a back
gesture is valid in every state the controller can be in when you get there*.

---

## 1. Ranked findings

Ranked by **how likely a real driver is to hit this**, then by damage. F1–F4 are things you hit by
pressing buttons the app offers you; F5–F7 need one unlucky-but-ordinary action; F8+ are narrower.

---

### F1 — Cancel the Learn lap and the app can no longer select *any* circuit. No message, no way out but a force-quit. `HIGH`

**Journey 1 / 6, step: calibration → back out → pick another circuit.**

**What the driver does.** Starts a session, the Learn lap is not going well (the owner's own
documented failure mode — coverage parked at ~83 %, twice, `sessionController.ts:1392-1403`), holds
*Cancel Calibration*, lands back on *Learn Your Line*, and decides to back out and pick the other
circuit instead. Header back → Preflight → back → Circuit → back → the circuit list. Taps
MotorPark. The row greys out, a spinner runs for an instant, **and nothing happens.** Taps again.
Nothing. Taps the circuit they were already on. Nothing. There is no error, no banner, no toast.

**What the code does (VERIFIED).**

1. `ActiveCalibrationScreen.tsx:387-390` (the long-press) and `:137-151` (`confirmCancelExit`, for the
   header/gesture back) both call `facade.rejectCalibration()`.
2. `SessionController.rejectCalibration` (`sessionController.ts:1457`) forces
   `CALIBRATION_FINISHED` then `CALIBRATION_REJECTED` and lands the machine in
   **`awaitingCalibration`** (`:1496-1504`).
3. `selectCircuit` (`composition.ts:2173`) refuses unless the controller is in
   `SELECTABLE_STATES = {idle, sessionComplete, error}` (`composition.ts:2073`,
   `refuseSelectionIfSessionActive` `:2140`). `awaitingCalibration` is not in that set.
4. `CircuitSelectionScreen.tsx:47-51` handles the refusal with
   `console.warn(...)` and `return` — **no state, no UI**. Navigation is skipped.
5. Nothing rebuilds the controller out of `awaitingCalibration`. The preflight gate
   (`composition.ts:3005-3026`) rebuilds only when the state is `sessionComplete`/`error`
   (terminal) or `idle` **and** the circuit changed. `awaitingCalibration` is neither. And
   `RealSessionFacade.startPreflight()` is a deliberate no-op controller-side
   (`realFacade.ts:138-144`), so simply visiting Preflight changes nothing.
6. The reducer offers no transition out of `awaitingCalibration` except `CALIBRATION_STARTED`,
   `FATAL` or `END_SESSION` (`statemachine/reducer.ts:123`, `:88-96`). `endSession()` is reachable
   only from `ActiveDashboardScreen`, which is not in the stack.

**Why it is wrong.** `CircuitSelection` is the initial route and the *only* door to
`CircuitDetail` — which is in turn the only door to Preflight, Session History and **Settings**
(`RootNavigator.tsx:78-79`, `CircuitDetailScreen.tsx:218/236/247`). With the selection refused, the
driver is parked on the circuit list with every row inert. They cannot start a session, read
history, change settings, or delete their data. Force-quitting is the only exit — and that leaves
the calibration session's active-session pointer set (`composition.ts:1781`, written by
`onSessionStarted` the moment `beginCalibration` resolved), so the next launch offers a crash-recovery
banner for a session that never drove a lap.

The same silent refusal also blocks `startTestLoop` (`composition.ts:2570`, though *that* one does
surface a message) and every post-session Analysis (`analysisViewModel.ts:68-77` —
`awaitingCalibration` counts as "session active").

**Severity: HIGH.** Reachable by pressing one of the three controls the calibration screen offers,
then using the back button. In the paddock this reads as "the app froze".

---

### F2 — "Discard" on the crash-recovery banner destroys the lap times it just told you it recovered. `HIGH`

**Journey 3, step: force-quit mid-lap → relaunch → recovery banner.**

**What the driver sees.** *"Recovered an interrupted session on MotorPark (4 laps). Resume continues
it on MotorPark; lap 4 was invalidated. Or discard it."* — with **Discard** and **Resume** drawn as
two equal buttons side by side (`CircuitDetailScreen.tsx:159-190`). A driver who is done for the day,
or who does not want to resume timing right now, taps Discard expecting to dismiss the banner and
keep the three completed laps.

**What the code does (VERIFIED).**

- The `sessions` row for an in-progress session is written **once, at recording start**, with
  `laps: [...this.core.laps]` — an empty array (`persistInitialSessionRecord`,
  `sessionController.ts:2079-2096`, building `buildSessionSummary` `:2099`).
- `onLapCompleted` (`sessionController.ts:2928`) writes the lap's **telemetry rows**, the
  **checkpoint** and the **PB reference lap**. It never calls `saveSession`. Confirmed by reading
  the whole method and `commitLapTelemetry`/`writeLapCommit`.
- The only other `saveSession` calls are `persistSessionRecord` (`:2126`, provenance only — it
  rebuilds the same summary, so it *would* carry laps, but it is fired only on
  `calibration-accepted`/`calibration-escaped`, i.e. before any lap exists) and `endSession()`
  (`:1579-1580`).
- So between the first lap and `endSession()`, **the completed laps live only in the checkpoint.**
- `discardRecovery` (`composition.ts:3361`) overwrites that checkpoint with
  `{state:'sessionComplete', lapNumber: 0, context: {}}` and `[]`, then clears the active-session
  pointer. Nothing copies the checkpoint's laps into the session row first.

**What is left afterwards.** The session still appears in History with **"0 laps · best —"**
(`SessionHistoryScreen.tsx:169`) and **no warning at all**: `unwritten` comes from the start-time row
and is `0` (`:154`, `sessionUnwrittenSampleCount` → `composition.ts:4042`), so the INCOMPLETE
RECORDING line does not fire. The per-lap GNSS rows are still in the `telemetry` table and the PB
reference lap is still in `reference_laps` — neither is reachable from any screen, because every
screen reads laps off the `sessions` row.

**Why it is wrong.** The banner quantifies what is at stake ("4 laps") and then offers a
destructive action with no confirmation and no statement of what is lost. And the loss is not
"the interrupted lap" — it is *every* lap of that session.

**Severity: HIGH.** Not a hand-corrupted database: one tap, on a banner the app puts in front of you.

---

### F3 — Starting a new session instead of resuming orphans the crashed one permanently, with the same loss. `HIGH`

**Journey 3, same relaunch, different choice.**

The recovery banner lives on `CircuitDetailScreen` (`:150-192`), but the app relaunches at
`CircuitSelection` (`RootNavigator.tsx:67`), which shows **nothing** about an interrupted session.
A driver who relaunches and just taps their circuit → *Start Session* never sees the banner as a
decision; they see it once, scroll past it, and start driving again.

`onSessionStarted` (`composition.ts:1779-1784`) then calls
`setActiveSession(db, {sessionId: <new>, circuitId, startedAtUtc})`, which **replaces** the pointer in
one transaction (`setActiveSession` `:1618-1645`). The crashed session's checkpoint is now
unreferenced: bootstrap only ever looks up `ACTIVE_SESSION_SETTINGS_KEY`
(`getActiveSessionId` `:1580`, used at `composition.ts:3130`). It is never offered again, and by F2's
mechanism its laps were only ever in that checkpoint. Same total loss, reached without touching
Discard at all. (VERIFIED.)

**Severity: HIGH**, and it compounds F2 rather than duplicating it: the two together mean
*the only way a crashed session's laps survive is Resume-then-End.*

---

### F4 — Learn a track, forget to name it, and the session you just drove is unreachable forever. `HIGH`

**Journey 4 / 5 / 6.**

**What the driver does.** Circuit list → *Circuit nou* → Start → drives a lap → the banner says the
track was learned and timing has started → taps **"Open dashboard"** (which sits *above* the name
field, `TestLoopScreen.tsx:233-272`) → drives → ends the session → looks at the results → *Back to
Circuit* → back to the circuit list → taps Transilvania Motor Ring to check something.

**What the code does (VERIFIED).**

- `adoptLearnedCircuit` (`composition.ts:2633`) persists the circuit with **`saved: false`**
  (`putLearnedCircuitWithFreshId` → `store.insert({..., saved:false})`, `composition.ts:2774`) and
  then `unlockedApplySelection(entry)` (`:2751`), which writes `selectedCircuitId` to it
  (`applySelectedCircuit` `:2086`).
- `publishLearnedCircuits` maps `listed: entry.record.saved` (`composition.ts:2276`), and
  `circuitCatalog.list()` filters `entry.listed` (`circuitCatalog.ts:171-173`). So the circuit is
  **resolvable** (`get()`, `:177`) but **not listed**.
- The name field and Save button exist only while `snapshot.phase === 'learned'`
  (`TestLoopScreen.tsx:231`). `testLoopController` is module state created at load
  (`composition.ts:2284`), so after an app restart the phase is `idle` and **the Save control no
  longer exists anywhere**. `listLearnedCircuits` / `deleteLearnedCircuit` have no screen.
- Tapping TMR calls `selectCircuit('transilvania-motor-ring')`, which persists the new selection.
  The learned circuit is now neither selected nor listed.

**Result.** Its sessions, its laps, its PB, its Analysis and its one-tap export are all gone from
the UI — `SessionHistoryScreen` and `PersonalBestScreen` read `sessionHistoryStore`, which is built
per-selected-circuit (`sqlSessionHistoryStore.ts:32-45`, rebuilt by
`rebuildHistoryForSelection` `composition.ts:2089`). There is no "all sessions" view. The data is
intact on disk and unreachable.

**Severity: HIGH.** The whole point of Test Loop is to drive an unregistered track; the save step
is a text field below the primary action, on a screen the driver is about to leave for the dashboard.

---

### F5 — Deny location permission on first run and the app has no way forward and no way to fix itself. `HIGH`

**Journey 1, step: the very first permission prompt.**

**What the driver sees.** Fresh install → circuit → *Start Session* → Preflight → iOS prompt → they
tap **Don't Allow** (or *Allow Once* and come back tomorrow). The screen shows
`Location permission granted: FAIL`, the bullet *"Grant Circuit Timer permission to use your
location."*, and exactly one button: **Retry**. Retry re-runs, iOS does not prompt a second time,
and the screen says the same thing forever.

**What the code does (VERIFIED).**

- `PreflightScreen.tsx:115` calls `requestForegroundLocationPermission()` once per `runToken`.
- `PermissionOutcome.canAskAgain` is computed (`permissions.ts:39`) and **read by nothing** —
  grep over `apps/mobile/src` finds the field only at its own declaration and assignment.
- There is **no `Linking.openSettings()` anywhere in `apps/mobile/src`** (verified by grep for
  `Linking|openSettings`). The failure copy for `LOCATION_PERMISSION_NOT_GRANTED`
  (`PreflightScreen.tsx:56`) gives no instructions, unlike `PRECISE_LOCATION_OFF`, which at least
  spells out the Settings path (`permissions.ts:59-61`).
- With `report.pass === false`, the Continue button is not rendered at all
  (`PreflightScreen.tsx:330`), and `evaluatePreflightProximity` returns
  `continueAnywayAvailable: false` when `preflightPassed` is false
  (`circuitProximity.ts:130-139`), so **"Continue anyway" is not offered either**.

**Also (VERIFIED):** `runPreflightChecks` runs every collector in one `Promise.all`
(`preflight.ts:238-248`) with no short-circuit on a denied permission, and `collectGnssFix`
(`:136-183`) resolves only on a qualifying fix, an abort, a `watchPositionAsync` rejection, or the
30 s timer. **INFERRED:** if expo-location's `watchPositionAsync` does not reject outright without
permission on iOS SDK 57, every Retry burns the full 30 seconds before showing the same failure. I
could not determine that from source.

**Why it is wrong.** This is the one failure that stops the product working at all, and it is the
one the app has no remedy for. The `canAskAgain: false` case is exactly the case that needs a
deep link, and the field is already being read off the platform and thrown away.

**Severity: HIGH.** A meaningful fraction of first-run users deny a location prompt.

---

### F6 — Edge-swipe back off the Results screen, tap "Start Calibration", and you drive a whole Learn lap that cannot arm — and it rewrites the finished session's provenance to UNKNOWN. `HIGH`

**Journey 2, step: session over, driver pokes around.**

**The stack (VERIFIED).** Every transition inside a session uses `replace`, not `push`:
`ActiveCalibration → CalibrationResult` (`ActiveCalibrationScreen.tsx:82`),
`ActiveCalibration → ActiveDashboard` (`:168`),
`CalibrationResult → ActiveDashboard` (`CalibrationResultScreen.tsx:159`, `:203`),
`ActiveDashboard → SessionResults` (`ActiveDashboardScreen.tsx:55`). So when the driver reaches
Results the stack is `CircuitSelection → CircuitDetail → Preflight → CalibrationInstructions →
SessionResults`, and **the screen behind Results is "Learn Your Line".**

`SessionResults` sets `headerBackVisible: false` but **does not set `gestureEnabled: false`**
(`RootNavigator.tsx:97`) — unlike `ActiveCalibration` (`:89`) and `ActiveDashboard` (`:95`), which
both do. The iOS edge-swipe works.

**What then happens (VERIFIED).** `CalibrationInstructionsScreen.tsx:67` calls
`facade.beginCalibration()` — and `beginCalibration` **does not go through the preflight gate**.
The gate is installed on `startPreflight()` only (`composition.ts:342`, `:363-407`, installed at
`:2989`), and `PreflightScreen` is its only caller (grep: `startPreflight` appears in
`PreflightScreen.tsx:100` and nowhere else in the UI). `beginCalibration` takes the plain
`runLockedCommand` path (`composition.ts:469-480`). **The terminal controller is therefore never
rebuilt.**

`SessionController.start('calibration')` on a `sessionComplete` controller:

| line | what happens |
|---|---|
| `:1207` | not disposed — proceeds |
| `:1213` | `this.sessionId !== null`, so `assignedSessionIdHere === false` → **the finished session's id is reused** |
| `:1310-1311` | `START_PREFLIGHT` / `PREFLIGHT_PASSED` are dispatched into `sessionComplete`, which the reducer ignores (`reducer.ts:235-238`) |
| `:1323` | `this.calibrationStatus = 'unknown'` |
| `:1325-1326` | `CALIBRATION_STARTED` ignored; `this.mode = 'calibrating'` anyway |
| `:1349` | `persistInitialSessionRecord()` → `saveSession(buildSessionSummary(...))` |

`buildSessionSummary` (`:2099`) reads `this.calibrationStatus`, which is now `'unknown'`. `saveSession`
is a full delete-and-reinsert per session (`persistence-sql/sqlSessionRepository.ts:286`,
`:315-322`). **The completed, validated session's stored `calibrationStatus` is overwritten with
`'unknown'`**, and its terminal checkpoint is rewritten. From then on History, Personal Best and
every export of that session say *"CALIBRATION UNKNOWN — treat its lap times as unverified"*
(`SessionHistoryScreen.tsx:183-195`, `PersonalBestScreen.tsx:42-43`).

Meanwhile the driver sees a coverage ring that fills normally (`handleSample` branches on
`this.mode`, `:1859-1883`, and `mode` *is* `'calibrating'`), drives a full Learn lap, gets
*Calibration Accepted*, taps **Continue** → `acceptCalibration()` returns immediately because the
state is not `calibrationReview` (`:1376`) → `replace('ActiveDashboard')` → the dashboard's mount
effect sees `sessionState === 'sessionComplete'` and **replaces straight back to Session Results**
(`ActiveDashboardScreen.tsx:52-57`).

**Severity: HIGH.** Silent durable data corruption plus a wasted lap, triggered by a gesture iOS
users make reflexively. The fix shape is obvious (the gate belongs on `beginCalibration` too, and
`start()` should refuse a terminal controller) but I am not fixing anything here.

---

### F7 — Backing out of the Test Loop screen does not stop learning, and the app can start timing a session the driver never asked for. `HIGH`

**Journey 4, step: "the driver gives up halfway".**

`TestLoopScreen` has a single effect — `useEffect(() => subscribeTestLoop(setSnapshot), [])`
(`TestLoopScreen.tsx:41`). There is **no unmount cleanup, no blur handler and no `beforeRemove`
interceptor** (contrast `ActiveCalibrationScreen.tsx:118-135`, which has one). The route registers no
`gestureEnabled: false` and no `headerBackVisible: false` (`RootNavigator.tsx:115-119`), so the header
back and the edge-swipe both work. (VERIFIED.)

So: *Start learning* → drive → change your mind → press back. `stopTestLoop()` is never called.
`testLoopProvider` keeps the GNSS watcher open and keeps buffering every fix
(`startTestLoop` `composition.ts:2564-2586`). The only automatic teardown is on phase `'failed'`
(`composition.ts:2314-2319`), i.e. the sample cap.

If the driver then happens to complete a loop — which is exactly what "I gave up and drove back to
the paddock" looks like on a circuit — `adoptLearnedCircuit` (`composition.ts:2633`) fires with no
screen showing it: it inserts a circuit, **changes the app's selected circuit**, builds a controller,
`start('session')` + `arm()`, starts telemetry recording, writes the active-session pointer, and
replays the backlog. The driver is now in a live timed session on a circuit they did not choose,
looking at the circuit list. And because the controller is now mid-session, every row on that list
is silently inert — F1's trap, by a second route.

**Severity: HIGH.** Medium likelihood, but the failure is invisible and self-compounding.

---

### F8 — Every session end shows "CALIBRATION UNKNOWN" on the Results screen until an unordered background refresh lands. `MEDIUM`

**Journey 5, step: the moment the session ends.**

`SessionResultsScreen.tsx:119-124` calls
`resolveResultsCalibrationStatus(state.calibrationStatus, getMostRecentSessionId())`.
`resolveResultsCalibrationStatus` (`composition.ts:4030-4040`) requires **both** the live status and
the stored status to be `'validated'`; `resolveSessionCalibrationStatus` (`:4008`) reads
`historyStore?.getSession(sessionId)?.calibrationStatus` — the **in-memory cache**
(`sqlSessionHistoryStore.ts:86-88`), which is only repopulated by `refresh()`.

Ordering (VERIFIED as far as the code states it):

1. `SessionController.endSession()` finishes its writes and calls `this.emit()` (`:1596`).
2. `relaySessionCompleteBarrier` holds `sessionComplete` only if `telemetryShutdown` is non-null
   (`composition.ts:1408`, `relaySessionCompleteBarrier` `:229-268`). **`telemetryEnabled` defaults to
   `false`** (`settingsStore.ts:424`), so on the default install the barrier is `null` and
   `sessionComplete` is broadcast with zero delay.
3. Only *after* `controller.endSession()` resolves does `RealSessionFacade`'s guard call
   `onSessionEnded` (`realFacade.ts:167-170`), whose `controllerPersistence` does
   `setActiveSession(null)` **then** `historyStore?.refresh()` (`composition.ts:1800-1803`).

So the Results screen mounts and reads the cache before the refresh that would put the just-ended
session into it. `stored` resolves to `'unknown'`, and the screen renders the block
*"CALIBRATION UNKNOWN — No record of whether this session's calibration was validated. Treat its
lap and sector times as unverified."* above the lap times — on a session that was properly
calibrated.

**INFERRED, and I want to be explicit about the limit of what I checked:** whether this is a brief
flash or a permanent wrong banner depends on scheduler ordering between `historyStore.refresh()` and
the screen's own `refreshLapVerdicts` effect (`SessionResultsScreen.tsx:144-156`), whose `setVerdicts`
is the only thing that triggers a re-render afterwards. If the shared SQL write gate serialises them
in issue order the refresh wins and the banner corrects itself; **nothing in the code establishes
that ordering**, and if `setActiveSession` rejects, `refresh()` never runs at all (the failure is
swallowed into a `Promise.allSettled` + `console.warn`, `:1805-1811`) and the wrong banner is
permanent.

**Severity: MEDIUM**, but it fires on *every* session end on a default install, and it is precisely
the honesty notice ticket P10A H7 added. A warning that cries wolf every time is a warning the
driver stops reading.

---

### F9 — `PAUSE_GAP` and `RECOVERY` have no plain-language copy, so the two commonest "why is this lap invalid" answers render as raw codes. `MEDIUM`

**Journeys 2 and 3: the phone locks, a call arrives, or the app is force-quit.**

When the app is backgrounded, GNSS delivery stops; on resume `SessionPipelineCore.ingest` sees the
`tMono` gap and synthesises `PAUSE` + `RESUME` (`pipelineCore.ts:270-273`), and the reducer attaches
`'PAUSE_GAP'` to the running lap for a gap over 30 s (`statemachine/reducer.ts:227`). A recovered
in-flight lap is appended with `invalidReasons: ['RECOVERY']` (`sessionController.ts:1782`).

`INVALID_REASON_COPY` (`ui/screens/invalidReasonCopy.ts:22-35`) has entries for `PIT_TRANSIT`,
`PIT_AMBIGUOUS`, `MISSED_SECTOR_GATE`, `SHORT_LAP`, `LOW_QUALITY`, `REVERSE_TRAVEL` and
`DUPLICATE_SECTOR_GATE` — **and neither `PAUSE_GAP` nor `RECOVERY`.** `explainInvalidReason` (`:38-40`)
falls through to `reason.replace(/_/g, ' ').toLowerCase()`, so the driver reads
*"• pause gap"* and *"• recovery"* beside fully-worded siblings, on both
`SessionResultsScreen.tsx:380-385` and `LapDetailScreen`. The file's own header calls that fallback
"a gap to close, not a design to rely on". (VERIFIED.)

**Why it matters for flow, not copy:** these are the two codes that answer "what happened when my
phone rang?" and "what did the crash cost me?". The app knows; it just doesn't say.

---

### F10 — On a learned circuit the dashboard always draws three sectors, and the Pit View can never open. `MEDIUM`

`buildTestLoopCircuit` writes **`sectorGates: []`** for every learned circuit
(`packages/core/src/testloop/testLoopCircuit.ts:200`). Consequences (VERIFIED):

- `ActiveDashboardScreen.tsx:24` hard-codes `const SECTOR_COUNT = 3; // Transilvania Motor Ring`,
  and passes it to `SectorBar` unconditionally (`:215`). On a learned circuit the driver watches a
  three-segment sector bar with segment 1 permanently lit and nothing ever advancing.
  `SessionResultsScreen.tsx:273-287` likewise always renders S1/S2/S3, all `—`.
- The Pit View entry is gated on `stopped = sessionState === 'inPit' || 'paused'`
  (`ActiveDashboardScreen.tsx:40`, `:246-259`). **`'paused'` is unreachable in production**: nothing in
  the UI calls `facade.pause()`/`resume()` (verified by grep over `apps/mobile/src` — the only hits
  are the facade plumbing itself, `composition.ts:521/524`, `realFacade.ts:174/178`), and `ingest`
  dispatches `PAUSE` and `RESUME` back-to-back in the same call (`pipelineCore.ts:270-273`).
  `'inPit'` requires a forward `pitEntry` crossing plus two consecutive on-pit-lane matches
  (`pipelineCore.ts:326-345`) — impossible without pit geometry.
  So on a learned circuit the driver sees a permanently greyed "pit view" button that can never
  enable, and the whole between-stint suggestion stage is unreachable.

The dashboard's "Session paused." banner (`ActiveDashboardScreen.tsx:107-108`) is dead code by the
same argument.

---

### F11 — The Personal Best can link to a lap the app then says does not exist. `MEDIUM-LOW`

`SqlSessionHistoryStore.refresh()` falls back to `syntheticLapFromReference(ref)` when the PB's
originating session does not list the lap (`sqlSessionHistoryStore.ts:77-79`) — which is exactly the
state F2/F3 leave behind (a crashed session whose `sessions` row has `laps: []` but whose
`reference_laps` row survived `maybeReplacePb`). `PersonalBestScreen.tsx:123` then links to
`LapDetail` with that `sessionId`/`lapNumber`, and `LapDetailScreen.tsx:143-144` resolves the lap out
of the same (empty) `session.laps`, so `:225-236` renders **"Lap not found."** — a dead end reached
from the app's proudest number. (VERIFIED.)

---

### F12 — The recovery banner's lap sentence is wrong when nothing was mid-lap. `LOW`

`recoveryLapCount = checkpoint.laps.length + (midSessionState(checkpoint.snapshot) ? 1 : 0)`
(`composition.ts:3113`). A crash while `armed` or `calibrating` — including the F1 aftermath —
gives `0`, and `CircuitDetailScreen.tsx:159-161` renders *"Recovered an interrupted session on X
(0 laps). Resume continues it on X; lap 0 was invalidated."* The sentence is unconditional; there is
no branch for "no lap was in progress". (VERIFIED.)

---

### F13 — Changing car is a developer-mode feature. `LOW` (product), but relevant to journey 6

`setActiveVehicleProfileIdExplicit` (`composition.ts:883`) is the only sanctioned write of
`activeVehicleProfileId`, and its only caller is `SignalFinderScreen`, whose Settings entry point is
behind `isDev || settings.developerModeEnabled` (`SettingsScreen.tsx:1291-1294`, unlocked by seven
taps via `registerDevTap` `:191`). OBD channel bindings are stored **per profile**
(`refreshVehicleProfileBindingsCache` `composition.ts:722-729`), so a driver with two cars in a
release build has no non-hidden way to switch, and will silently record the other car's channel
bindings. VIN auto-select exists (`applyVinAutoSelect` `:946`) but its catalog's `vinPatterns` are
documented as empty, so it never fires today (`:938-944`). (VERIFIED as code paths; the "never fires"
claim is the source comment's, not something I confirmed against the catalog data.)

---

## 2. Correct but confusing — product work, not bug fixes

These are places where I traced the code, found it right, and still think a driver misreads it.
They matter more for a public release than half the list above.

1. **The calibration ring has no target.** The acceptance bar is 0.85
   (`calibration-engine.ts:85`) but review only opens at 0.98
   (`sessionController.ts:349`, `CALIBRATION_COMPLETE_COVERAGE_FRACTION`). A lap that finishes at
   90 % is *good enough to be accepted* and will nevertheless sit on the ring forever, because
   nothing finishes it. The screen shows `90% COVERAGE` and says *"Drive one steady lap"* — it never
   says what number ends the lap. The escape hatch exists precisely for this
   (`sessionController.ts:1389-1425`) and is correct; the ring is what makes the driver need it.
   (Note: the doc comment at `sessionController.ts:337-339` names the bar as 95 %, which is wrong —
   already recorded as §7.2 of `map-core-timing.md`.)

2. **"Start session anyway" looks the same at 5 % as at 95 %.** `ActiveCalibrationScreen.tsx:374-383`
   offers it from the first frame with fixed copy (`CALIBRATION_ESCAPE_COPY`, `:51-63`). The
   consequence card says timing "may be wrong or may not appear at all" whether the lap covered
   almost nothing or almost everything. The engine knows the difference; the card does not use it.

3. **"LAP 0" on the out lap.** `snapshotState` deliberately returns `0` before a lap is running
   (`sessionController.ts:1058-1064`). Correct. It reads, in a helmet, as a broken counter.

4. **Session History is silently filtered to one circuit.** `SqlSessionHistoryStore.refresh()`
   filters on `circuitId`, `layoutId` **and** `layoutVersion` (`sqlSessionHistoryStore.ts:43-45`), and
   the screen's only hint is a subtitle naming the circuit (`SessionHistoryScreen.tsx:122-127`). A
   driver who switched circuits and sees "No sessions recorded yet." will conclude their data was
   deleted. There is no all-circuits view and no "N sessions on other circuits" line.

5. **The recovery banner is global but reads as local.** It is rendered on *every* circuit's detail
   screen and names its own circuit twice (`CircuitDetailScreen.tsx:150-192`) — which is correct and
   deliberate (N1 fix) — but it sits inside a screen whose whole header is a different circuit's
   name.

6. **"Discard" and "Resume" are the same weight.** `CircuitDetailScreen.tsx:163-190` gives Discard
   equal size and position. Only one of the two is non-destructive. (See F2 for why that matters.)

7. **Both shipped circuits can never unlock coaching suggestions, and nothing says so.**
   `geometryStatus` is `community-derived` for TMR and MotorPark
   (`map-data-and-infra.md` §1.3), only `'official'` sets `geometryValidated`
   (`analysisAssembly.ts:551`), and `suggestionsEnabled` is off by default
   (`settingsStore.ts:423`). A driver who turns the setting on and waits for advice will wait
   forever. The Analysis screen adds per-corner caveats, but nothing anywhere says *"no circuit in
   this app currently has geometry good enough for suggestions."*

8. **The Pit View button is drawn disabled with no explanation** (`ActiveDashboardScreen.tsx:246-259`).
   The driver cannot discover that it needs a detected pit-lane entry — and on a learned circuit it
   can never enable at all (F10).

9. **A Test Loop session with no dashboard open is still timing.** If the driver stays on
   `TestLoopScreen` after the "track learned" banner instead of tapping *Open dashboard*, laps are
   being timed with no timer visible anywhere (`adoptLearnedCircuit` arms the session at
   `composition.ts:2760`). The banner says *"timing started"*; nothing says *"you are looking at the
   wrong screen"*.

10. **Everything OBD is behind seven taps.** Telemetry is off by default
    (`settingsStore.ts:424`) and the Signal Finder — the only way to bind the brake channels the
    analysis engine's best estimators need (`telemetry/contracts.ts:20-33`) and the only way to pick
    a vehicle profile — is developer-gated (F13). For a public release the analysis quality tier a
    user lands in is decided by a hidden menu.

---

## 3. What I could not trace, and what I deliberately did not

Stated plainly so nothing here is mistaken for a clean bill of health.

- **No code was executed.** No build, no test, no app run. Every "what the driver sees" is read off
  the source.
- **Platform runtime behaviour.** Whether `expo-location`'s `watchPositionAsync` rejects immediately
  or silently never delivers when foreground permission is denied (F5's 30-second question); whether
  iOS keeps or drops the watcher across a background/foreground cycle; whether `performance.now()`
  advances across a genuine iOS suspend (the clock header claims it does,
  `platform/clock.ts:12-22`, and I took that at its word). All three change what the driver
  experiences in journeys 1 and 2 and none of them is answerable from this repository.
- **React commit ordering** in F8. I established the *code's* ordering (barrier null → emit before
  `onSessionEnded`) but not which of two in-flight SQL reads resolves first, and the code does not
  constrain it.
- **`SettingsScreen.tsx` (1474 lines), `SignalFinderScreen.tsx` (992), `DidSweepScreen.tsx` (1449),
  `DidProbeScreen.tsx` (539), `TelemetryScreen.tsx` (559)** were read only for their entry-point
  gating and their navigation edges. There may be flow problems inside the OBD screens; I did not
  look for them. Journey 6's OBD half is therefore covered only at the profile-selection boundary.
- **`AnalysisScreen` and `PitViewScreen` internals.** I traced how they are *reached* and what
  refuses them (`sessionIsActive`, `getActiveStintContext`), not their own state machines.
- **DevReplay paths** (`__DEV__` only) were skipped entirely.
- **The web preview** (`IS_WEB_RUNTIME`) was skipped: it has no SQLite, so its journeys are
  different by design.
- **I did not verify any of the "pinned by" test claims** in the four maps; where a map's conclusion
  fed a finding above, I re-derived it from the source myself.

---

## 4. Appendix — the state-machine states the UI can strand you in

Compiled while tracing F1/F6; useful as a checklist.

| controller state | reachable with no screen showing it? | `selectCircuit` | rebuilt by the preflight gate? | how the driver gets out |
|---|---|---|---|---|
| `idle` | yes (between sessions) | allowed | on circuit change | — |
| `preflight` | never (the controller never enters it; `startPreflight` is a no-op app-side) | — | — | — |
| `awaitingCalibration` | **yes — after any Cancel** | **refused, silently** | **no** | **only a new accepted calibration, or a force-quit** (F1) |
| `calibrating` | yes (back out of ActiveCalibration is intercepted, but the Test Loop path can arm one invisibly) | refused, silently | no | Cancel / escape hatch |
| `calibrationReview` | yes (edge-swipe off CalibrationResult) | refused, silently | no | Accept / Retry / escape hatch — all recover correctly |
| `armed` | briefly | refused, silently | no | the dashboard arms it |
| `outLap` / `timing` / `inPit` | no (dashboard has no back) | refused, silently | no | End Session |
| `paused` | **unreachable in production** (F10) | refused | no | — |
| `sessionComplete` | yes | allowed | **yes, but only via `startPreflight`** — `beginCalibration` bypasses it (F6) | Start Session |
| `error` | yes | allowed | yes | Start Session |
