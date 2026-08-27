# Ticket P4f-T2 — auto-discovery, auto-connect, DID sweep screen (apps/mobile)

## TASK
Wire the P4f core modules (ticket P4f-T1, committed — API surface below) into the app per the
"ENET auto-discovery & DID sweep addendum" (contracts.md, end — BINDING). ELM327 path byte-identical.

## EXPECTED OUTCOME
1. **Network awareness**: add `expo-network` (SDK 57 — read the versioned docs per `apps/mobile/AGENTS.md`;
   `npx expo install expo-network` so the version matches; package.json + lockfile). A small
   `apps/mobile/src/session/networkInfo.ts` returning `{ipv4, subnetMask}` or null (web preview → null,
   never throws). Telemetry screen shows the phone IP/subnet and, when no adapter answers, the hint
   "Join the adapter's WiFi (MHD_XXXX) first".
2. **Find adapter** (Settings, ENET section): button runs core `runDiscovery` with a real probe factory
   (`EnetTcpTransport` per host/port, tight timeouts) + candidates from `buildDiscoveryCandidates`
   (configured host/port, phone subnet); shows results (host, port, level, rtt); one tap applies host/port
   (persisted, provenance `discovered <date>` in a new `enetHostProvenance` setting). Cancel button.
   Runs only under the adapter reservation (`tryAcquire('discovery')` — extend the owner union; refused
   while provider/probe hold it).
3. **Auto-connect** (`telemetryProvider.ts`, ENET only): on start, if no host configured or the first
   connect fails, run discovery ONCE (bounded), apply a level-2 hit and connect; otherwise 'failed' with
   diagnostics `discovery: scanned N, none answered`. Never loops. Setting `enetAutoDiscover` (default true).
4. **DID sweep screen** (`__DEV__`, route `DidSweep`, linked from Settings dev section and the DID probe):
   range inputs (hex), Start/Pause/Resume/Stop, progress (DID, responders, NRC counts, req/s), responders
   list with raw hex; after the sweep (or on demand) an observation phase re-polls responders at ~1 Hz for
   a user-chosen window (default 60 s) and shows core heuristics suggestions (kind, confidence, decode,
   rationale); "Tag as <channel>" picker writes the spec via `enetSpecsFromSuggestion` into
   `enetChannelSpecsJson` (merge, validate, persist) with provenance. Uses the simulated transport when
   `telemetrySimulate`. Exclusive via the reservation (`'sweep'` owner). Extract all logic into a pure
   `apps/mobile/src/session/didSweepController.ts` (testable without RN).
5. **Tests** (pure TS): candidates from networkInfo shapes; discovery apply/persist + provenance; auto-connect
   once-only behavior (success, none-found, reservation refused); sweep controller state machine (start/
   pause/resume/stop, tagging writes a valid spec, reservation exclusivity); no-raw-network static test
   extended to the new files; ELM path unchanged (existing tests + explicit "elm327 never runs discovery").

## API SURFACE FROM P4f-T1
<<T1_API>>

## CONSTRAINTS
Only new dependency: `expo-network` (LEAD-approved). Whitelist untouched (core codec). Offline mandate: all new
network activity confined to telemetry-enabled + adapterType 'enet' or the dev sweep/probe. 360pt/1.3×:
new screens/rows must not overflow. Read `apps/mobile/AGENTS.md`.

## MUST DO
Gates (real exit codes): `npm run typecheck` 0, `npm test` 0, `npm run lint` 0, `cd apps/mobile && npx expo export --platform ios` 0.
Report totals before/after and the exact expo-network version installed.

## MUST NOT
Spawn agents; touch packages/core (report NEEDS_CONTEXT if the API is insufficient); commit; touch the Expo dev server.

## WRITE SET
apps/mobile/package.json + package-lock.json (expo-network only), apps/mobile/src/session/{networkInfo.ts, didSweepController.ts, enetAdapterReservation.ts (owner union), telemetryProvider.ts, settingsStore.ts, enetSettingsValidation.ts}, apps/mobile/src/persistence/sqlSettingsStore.ts (repair rules for new keys), apps/mobile/src/ui/screens/{SettingsScreen,TelemetryScreen,DidProbeScreen,DidSweepScreen (new)}.tsx, apps/mobile/src/ui/navigation/{types.ts,RootNavigator.tsx}, apps/mobile/test/**.

## OUTPUT FORMAT
DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED + files, gates with exit codes, totals, deviations.
