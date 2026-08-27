# Ticket P4f-T1 — discovery orchestrator, DID sweep planner, heuristics (packages/core, pure)

## TASK
Implement the "ENET auto-discovery & DID sweep addendum" (contracts.md, end — BINDING) in
`packages/core/src/telemetry/enet/` as pure, injectable, fully tested modules. Mirror the style of the
existing enet engine. No RN/Node APIs.

## EXPECTED OUTCOME
1. `enetDiscovery.ts`: `buildDiscoveryCandidates({configuredHost?, configuredPort?, phoneIpv4?, subnetMask?})`
   → ordered `{host, port}[]` per the addendum (dedupe; /24 only; skip the phone; cap 260). 
   `runDiscovery({candidates, probe, clock, concurrency=16, connectTimeoutMs=300, replyTimeoutMs=500, budgetMs=8000, testerAddress, targetAddress})`
   where `probe` is an injected `(host, port) => ObdTransport`; level-1 = connect resolved; level-2 = a
   valid HSFZ frame received after ONE TesterPresent built through `assertAllowedRequest`. Returns
   `{results: {host, port, level, rttMs}[], scanned, elapsedMs, truncated}` deterministically ordered.
   Cancellation via an `AbortSignal`-like `{aborted}` object. Never throws on per-host errors.
2. `didSweep.ts`: `createDidSweepPlan({from=0, to=0xFFFF, priorityRanges?})` (resumable iterator),
   `runDidSweep({plan, request: (did) => Promise<UdsParsedResponse|'timeout'>, clock, pacing, onProgress, control:{paused, stopped}})`
   producing `{responders: {did, raw, length, rttMs}[], nrcCounts, timeouts, lastDid}` with adaptive pacing
   (min interval from measured RTT, cap requests/s configurable). Uses only 0x22 via the codec.
3. `didHeuristics.ts`: `classifyResponders(series: {did, samples: {tMs, raw}[]}[], context?: {gnssSpeedKph?: {tMs, v}[]})`
   → ranked `{did, kind: 'temperature'|'speed'|'pedal'|'steering'|'unknown', confidence, decode, rationale}[]`
   per the addendum's signal shapes; decodes tried: u8−40, u16÷10, u8 raw, i16 raw. Deterministic.
4. `enetSpecsFromSuggestion(suggestion, channel, date)` → `EnetChannelSpec` with provenance
   `in-car sweep <date>, DID <hex>, decode <…>`.
5. Simulator: extend `SimulatedEnetTransport`/scenario with a small DID table (e.g. 3 responders with
   time-varying values shaped like temperature/pedal/steering) and a `SimulatedDiscoveryProbeFactory`
   (answers level-2 on exactly one host, level-1 on another, refuses the rest) for tests and the preview.
6. Exports via `enet/index.ts` + `@circuit/core`. Tests (`packages/core/test/telemetry/enet/**`): candidate
   ordering/dedupe/cap; discovery levels, concurrency bound, budget truncation, abort, ordering; sweep
   resume/pause/stop, pacing, NRC classification, 0x78; heuristics on synthetic series (each kind,
   plus noise → 'unknown'); spec builder provenance; simulator DID table.

## CONSTRAINTS
Whitelist untouched (all requests through `assertAllowedRequest`). No new deps. No changes to existing
enet files except additive exports and the simulator extension. Gates (real exit codes): `npm run typecheck` 0,
`npm test` 0, `npm run lint` 0. Report API surface. No commit, no agents.
WRITE SET: packages/core/src/telemetry/enet/**, packages/core/test/telemetry/enet/**, packages/core/src/index.ts (exports).
OUTPUT: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED + files, API, gates, totals.
