# Ticket P4f-FIX2-mobile — REV2 Part B findings + E2E findings (mobile)
Binding: "sweep transport interface & lifecycle amendment" (contracts.md, end). Review: `.foreman/scratch/p4frev2-codex-output.log` Part B.
The core sweep interface is changing in parallel to `{ send(pdu): Promise<void>; nextResponse(timeoutMs): Promise<Uint8Array|'timeout'>; keepAlive(pdu): Promise<void> }` (runner does SID/DID correlation, 0x78 extension, keep-alive cadence). Build against that; if not yet in the tree when you integrate, code to this shape and note it.
Tests first (fail on HEAD 91c23d0), then fix, one wave:
H1/H2 sweep lifecycle: the CONTROLLER owns the transport — acquire 'sweep' → open a FRESH `EnetTcpTransport` (or simulated) → run → close → release (release strictly after close on every path: complete, stop, throw). Start refused unless idle/complete (no generation bump before acquire). Screen no longer connects itself. Tests: refused start opens no socket; complete/stop close before release; second start uses a new transport; reentrant start neither leaks nor bumps generation.
H3 `sendRawUdsRequest` → implement the new interface over the transport: `send` frames one HSFZ diagnostic request; `nextResponse` returns the next diagnostic PDU from the target with swapped addresses (no SID/DID correlation — the runner does it), honoring timeoutMs; `keepAlive` frames TesterPresent. Tests with hand-built frames (wrong-SID then correct 0x62 in one chunk → both delivered in order).
M1 provider auto-discovery abortable: `stop()` aborts in-flight discovery (abort signal), awaits it, releases the provider token. Test: stop during scan → no sockets remain, token released, immediate start proceeds.
M2 observation from paused reuses the held claim (no second acquire). Test.
M3 observation cadence: round-robin ~1 Hz per responder, degraded cadence reported; pass GNSS speed context if a live speed source exists in the app (check the session facade / telemetry provider for a cheap speed feed; if none is cheap, leave omitted and state it in the UI). Test cadence math.
E2E-a simulate mode: Find adapter + auto-connect use `createSimulatedDiscoveryProbeFactory` under telemetrySimulate (dev) so the preview shows a level-2 hit. Test.
L 360pt: sweep progress text flexShrink/wrap.
Tests for every item; extend the no-raw-network static test to new files.
Gates (real exit codes): `npm run typecheck` 0, `npm test` 0, `npm run lint` 0, `cd apps/mobile && npx expo export --platform ios` 0.
WRITE SET: apps/mobile/src/session/**, apps/mobile/src/ui/screens/{DidSweepScreen,SettingsScreen,TelemetryScreen}.tsx, apps/mobile/test/**. No commit, no agents, never touch packages/core (parallel worker).
