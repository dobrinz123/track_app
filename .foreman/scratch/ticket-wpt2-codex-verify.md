You are a read-only cross-family verifier. The repo is at commit 6e83281. A Claude worker implemented the mobile telemetry wiring for Phase 4 P4a. Your job: try to find what unit tests and the implementer missed. Assume it is broken until proven otherwise. Verdict-first output.

BINDING SPEC: docs/architecture/contracts.md, section "Telemetry addendum" (read it first).
ORIGINAL TICKET: .foreman/scratch/ticket-wpt2-mobile.md (read it second).
DIFF SCOPE (commit 6e83281, mobile parts): apps/mobile/src/session/{tcpObdTransport.ts,telemetryProvider.ts,composition.ts,settingsStore.ts}, apps/mobile/src/persistence/{telemetrySchema.ts,telemetryRecorder.ts,expoSqlDatabase.ts}, apps/mobile/src/ui/screens/{TelemetryScreen.tsx,SettingsScreen.tsx}, apps/mobile/src/ui/navigation/{RootNavigator.tsx,types.ts}, apps/mobile/app.json, apps/mobile/package.json.

HUNT SPECIFICALLY FOR (beyond generic review):
1. Lifecycle races: session start/end vs provider start/stop vs the 3s single-retry timer — can a retry fire after endSession and resurrect a connection or leak a timer? Can rapid session restart double-start the provider or double-subscribe onSample?
2. The binding rule "telemetry NEVER gates lap timing": any await/throw path from telemetry code that can reach the controller/facade flow (including recorder flush errors during endSession's Promise.all — does a rejected telemetry flush break session end or lap persistence?).
3. Recorder correctness: batching boundary math (25/1s), lap_number tagging vs actual lap transitions (off-by-one when a sample arrives between crossing and facade state emission?), cap semantics (exactly stops at 200k? off-by-batch?), SQL injection/typing of channel strings, migration idempotence (re-running migrateTelemetrySchema on an existing DB).
4. TcpObdTransport: 5s timeout path — does a timed-out socket still fire callbacks later (double-settle of connect promise)? Is close() safe before/after connect? Partial ascii chunks with multi-byte boundary (should be ascii-only, but defensive)? Listener leaks on retry (old socket listeners detached?).
5. Settings: hydration of new fields on an existing settings blob (old installs), port parsing (string input -> number, invalid values), simulate toggle visible only in dev builds.
6. Background/foreground: what happens to the TCP socket and the poll loop when the app backgrounds mid-session (session keeps running by design) — any crash or unbounded error spam path?
7. Offline/read-only mandates: confirm zero network calls other than the local socket, zero non-mode-01 commands anywhere, no telemetry data leaving the device.
8. app.json: NSLocalNetworkUsageDescription present and plausible; no other plist/permission regressions.

RULES: Read-only sandbox. Do not modify anything. Cite file:line for every finding. Severity per finding: HIGH (would malfunction on track or corrupt data), MEDIUM (degraded/edge), LOW (style/hardening). No speculative findings without a concrete failure path.

OUTPUT FORMAT: First line exactly PASS / FAIL / PASS_WITH_NOTES (FAIL if any HIGH). Then findings list (severity, file:line, concrete failure scenario, suggested fix direction), then a short "checked and clean" list of the hunt areas above that came back clean.
