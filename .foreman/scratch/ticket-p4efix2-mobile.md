# Ticket P4e-FIX2-mobile — Codex P4e-REV2 Part B findings, mobile only
Binding: "poll plan, probe & robustness amendment" (contracts.md, end). Findings: `.foreman/scratch/p4erev2-codex-output.log`
(Part B). Tests first (must fail on HEAD 053c274), then fix, one wave:
H1 structural validation of channel-spec JSON members in `enetSettingsValidation.ts` (never cast; errors surfaced;
   `[null]`, `[{}]`, `[1]`, wrong types → error strings); SettingsScreen blur and TelemetryScreen render must never throw
   (fallback to defaults) — tests.
H2 DidProbeScreen gating: allowed only when telemetryEnabled && adapterType==='enet' AND provider state is
   idle/stopped/failed (read the provider's state; subscribe for changes); otherwise disabled Send + message
   "Stop telemetry first / enable ENET telemetry first"; uses SimulatedEnetTransport when telemetrySimulate (dev).
   Extract the probe logic into a pure module (`didProbe.ts`: build request, gating decision, response correlation,
   50-entry log) so it is testable without RN.
M1 ENET poll plan built from resolved specs using core's `ENET_DEFAULT_CHANNEL_RATES_HZ` (landing in a parallel core
   ticket — if not yet exported when you get there, define the same table locally in telemetryProvider and note it);
   transOilC no longer gated by transOilPidHex on the ENET path; intakeC/engineLoadPct specs are polled. Test.
M2 EnetTcpTransport: remote close/error → closed=true, socket=null; send() after close rejects; second connect()
   rejects; connect-timeout test; duplicate-close single notification test.
M3 Probe response correlation (swapped addresses, SID+0x40 / 0x7F echo, identifier echo); unmatched → logged
   UNMATCHED; test with the review's scenario (request F190 to 0x12; frame from 0x13; positive 62 F1 91).
L1 Settings hydration repair (sqlSettingsStore or settingsStore hydrate path): adapterType enum, port 1–65535,
   tester/target 0–255, specs JSON parsable → defaults otherwise; test with the review's persisted object.
L2 SettingsScreen ENET rows: label flexShrink/wrap, input min width; no horizontal overflow at 360pt/1.3×.
L3 Tests for the listed gaps: provider reconnect on ENET failed, stale-generation callback, stop/failed mapping,
   constructor assertion for elm327 path; probe gating/correlation/cap; hydration repair; a static test that
   apps/mobile/src contains no fetch/XMLHttpRequest/WebSocket/UDP usage in the ENET files.
Gates (real exit codes): `npm run typecheck` 0, `npm test` 0, `npm run lint` 0, `cd apps/mobile && npx expo export --platform ios` 0.
WRITE SET: apps/mobile/src/session/**, apps/mobile/src/persistence/sqlSettingsStore.ts, apps/mobile/src/ui/screens/{SettingsScreen,TelemetryScreen,DidProbeScreen}.tsx, apps/mobile/test/**.
No commit, no agents, never touch packages/core (another worker). OUTPUT: DONE/DONE_WITH_CONCERNS/BLOCKED + per-item status + evidence.
