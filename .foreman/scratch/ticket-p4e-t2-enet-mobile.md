# Ticket P4e-T2 — ENET adapter support in apps/mobile (settings, transport, provider, monitor, DID probe)

## TASK
Wire the new `@circuit/core` ENET engine (ticket P4e-T1, committed — see the API surface section
below, filled in by the LEAD) into the mobile app, per the "ENET telemetry addendum" at the end of
`docs/architecture/contracts.md` (BINDING). The ELM327 path must remain byte-identical in behavior
when `adapterType === 'elm327'` (the default).

## EXPECTED OUTCOME
1. **Settings** (`settingsStore.ts`): `adapterType: 'elm327' | 'enet'` (default `'elm327'`),
   `enetHost` (default `''` — the user reads the adapter IP from its web UI; copy explains),
   `enetPort` (default 6801), `enetTesterAddress` (default 0xF4), `enetTargetAddress` (default
   0x12), `enetChannelSpecsJson` (string, default `''` = built-in defaults), all hydrated like the
   other fields. `SettingsScreen`: adapter type segmented control; ENET rows shown only for `enet`;
   host/port/addresses validated on blur (hex bytes 00–FF; port 1–65535); channel-specs JSON
   validated through core's `validateEnetChannelSpecs` with inline warnings; copy: "Close the MHD
   app first — the adapter allows one ECU client at a time." `telemetrySimulate` (dev) applies to
   both adapter types.
2. **Transport** (`apps/mobile/src/session/enetTcpTransport.ts`): `EnetTcpTransport implements
   ObdTransport` over `react-native-tcp-socket` (same lazy-load, closed-flag, connect-timeout and
   single-close-notification discipline as `tcpObdTransport.ts`), delivering raw byte chunks
   (Uint8Array) — HSFZ parsing lives in core. Reuse code with the ELM transport via a shared
   base only if it does not change the ELM transport's behavior.
3. **Provider** (`telemetryProvider.ts`): choose engine + transport by `adapterType`
   (simulate → `SimulatedEnetTransport` for enet); build the ENET config from settings
   (channel specs: parsed JSON or defaults, validated; poll plan reused; tester-present interval
   default). Generation guards, reconnect policy, sample/state fan-out and the recorder path are
   shared and unchanged. Diagnostics exposed for the screens.
4. **Monitor** (`TelemetryScreen`): for enet show adapter type, target address, per-channel rows
   incl. UNSUPPORTED (with NRC) state, ack latency p50/p95, frames tx/rx.
5. **DID probe (dev-only screen, `__DEV__`)**: reachable from Dev Replay or Settings dev section;
   inputs: target address (hex byte), mode (0x22 DID / 0x01 PID), request hex; "Send" runs ONE
   request through the same whitelist-enforced core codec on the live (or simulated) transport and
   shows the raw response hex + parsed NRC if any + round-trip ms; a scrollable log of the last 50
   probes. Nothing outside {0x01, 0x22, 0x3E} can be sent — the whitelist error is shown, not bypassed.
   This is the tool for discovering B58/DSC identifiers empirically.
6. **Tests** (`apps/mobile/test/**`, pure TS): settings hydration/defaults for the new keys;
   provider selects the right engine/transport per adapterType and simulate flag; specs JSON
   validation surface; ELM path unchanged (existing tests) + an explicit test that with
   `adapterType:'elm327'` the ENET code is never constructed; DID-probe pure helper (request
   building + whitelist refusal) tested.

## API SURFACE FROM P4e-T1 (filled by LEAD after T1 collection)
Exported from `@circuit/core` (source: `packages/core/src/telemetry/enet/**`, read the code + tests):
- Engine: `createEnetSession(transport, config)` → `EnetSession` (`start/stop/onSample/onStateChange/getDiagnostics`), `EnetConfig`, `DEFAULT_ENET_CONFIG`, `EnetState` (`idle|connecting|handshake|polling|stopped|failed`), `EnetDiagnostics` (per-channel supported/unsupported + NRC, frames tx/rx, ack latency p50/p95, `lastRawFrameHex`, errorCount/lastError).
- Specs: `EnetChannelSpec`, `EnetChannelDecodeSpec`, `DEFAULT_ENET_CHANNEL_SPECS`, `validateEnetChannelSpecs(specs) → {valid, warnings}`, `decodeEnetChannelValue`.
- Codecs (for the DID probe): `encodeFrame`, `HsfzFrameParser`, `HSFZ_CONTROL`, `buildReadDataByIdentifierRequest`, `buildObdMode01Request`, `buildTesterPresentRequest`, `assertAllowedRequest` (throws `UdsServiceNotAllowed`), `parseUdsResponse`, `bytesToHex`, `UDS_NRC`.
- Simulator: `SimulatedEnetTransport`, `SimulatedEnetTransportConfig`, `DEFAULT_ENET_SCENARIO`, `EnetSimulatedChannelScript`.
- Transport contract: `ObdTransport` (unchanged, byte chunks); `TelemetrySession<TState>` alias.
Note: the transport delivers/accepts raw bytes — the ENET engine expects binary-safe chunks (see `bytesToBinaryString`/`binaryStringToBytes` helpers if the socket layer works in strings; prefer Uint8Array end to end).

## CONSTRAINTS
- No new dependencies (react-native-tcp-socket already present). No changes under `packages/core/**`
  (report NEEDS_CONTEXT if the API is insufficient). Offline mandate: the ENET socket is the only
  network activity, and only while telemetry is enabled + adapterType enet.
- Read-only: the mobile layer never builds UDS PDUs itself — always through core's whitelist codec.
- 360pt/1.3x: new settings rows and the probe screen must not overflow; no driving-screen changes.
- Follow `apps/mobile/AGENTS.md` (read the versioned Expo docs for any Expo API you touch).

## MUST DO
Gates with real exit codes: `npm run typecheck` → 0, `npm test` → 0, `npm run lint` → 0,
`cd apps/mobile && npx expo export --platform ios` → 0. Report totals before/after.

## MUST NOT
Spawn agents; touch files outside the WRITE SET; commit; start/stop the Expo dev server on :8082.

## WRITE SET
`apps/mobile/src/session/{settingsStore.ts, telemetryProvider.ts, enetTcpTransport.ts (new), enetSettingsValidation.ts (new, optional)}`,
`apps/mobile/src/ui/screens/{SettingsScreen.tsx, TelemetryScreen.tsx, DevReplayScreen.tsx (link only), DidProbeScreen.tsx (new)}`,
`apps/mobile/src/ui/navigation/types.ts`, `apps/mobile/App.tsx` (route registration), `apps/mobile/test/**`.

## OUTPUT FORMAT
First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED; then files, gate outputs with exit
codes, totals, deviations flagged CONCERN.
