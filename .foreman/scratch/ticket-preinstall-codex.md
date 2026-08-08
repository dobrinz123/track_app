TASK: Read-only adversarial cross-review of the mobile session layer before the user consumes a limited Apple sideload slot. Hunt for defects that would surface ON THE PHONE (not in tests): lifecycle, async races, subscription leaks, state divergence between screens.

SCOPE (read thoroughly): apps/mobile/src/session/{composition.ts,realFacade.ts,liveTimestampedProvider.ts,facade.ts,sqlSessionHistoryStore.ts,circuitCatalog.ts,tmrProfile.ts}, apps/mobile/src/persistence/{expoSqlDatabase.ts,sqlSettingsStore.ts}, apps/mobile/src/platform/{gnssLocationProvider.ts,preflight.ts,lifecycle.ts}, apps/mobile/App.tsx, and the screens that drive sessions: ui/screens/{ActiveDashboardScreen,DevReplayScreen,CircuitDetailScreen,PreflightScreen}.tsx. Context: packages/core/src/controller/sessionController.ts for the contract.

HUNT SPECIFICALLY FOR:
1. Races between the async composition bootstrap and early user navigation (user taps Start Session before SQLite opens — what happens end-to-end?).
2. The swappable facade wrappers: subscription leaks or stale-state emissions when DevReplay swaps facades mid-app; double-subscribe on re-entry.
3. GnssLocationProvider start/stop idempotence under the watchdog's restartProvider (rapid stop/start; start while starting).
4. RealSessionFacade onSessionStarted/onSessionEnded callback timing vs controller state emissions (can history refresh read the repo BEFORE saveSession commits?).
5. Recovery flow: resumeRecovery on a checkpoint whose sessionId no longer has telemetry; discardRecovery double-tap.
6. App backgrounding during active session: lifecycle.ts checkpointNow wiring — anything that throws with no active controller?
7. iOS-specific: keep-awake activation path on the dashboard; anything web-only leaking into native (IS_WEB_RUNTIME guard correctness under Hermes).
8. Memory: subscriptions added in screens without cleanup on unmount (grep useEffect return values in the four screens).

MUST NOT: modify ANY file. No commands that write. This is advisory review only.

OUTPUT FORMAT: First line PASS / FAIL / PASS_WITH_NOTES (verifier vocabulary — you are reviewing a release candidate). Then findings ranked CRITICAL/HIGH/MEDIUM/LOW/INFO with file:line and concrete on-phone failure scenario each; explicit 'NONE' for empty classes. End with a one-line install verdict: SAFE TO INSTALL or DO NOT INSTALL + why.
