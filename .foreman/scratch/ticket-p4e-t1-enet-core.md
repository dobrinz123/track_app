# Ticket P4e-T1 — ENET/HSFZ + UDS telemetry engine in @circuit/core (pure TS, hardware-free)

## TASK
Implement, in `packages/core/src/telemetry/enet/**`, the second telemetry engine defined by the
"ENET telemetry addendum" at the end of `docs/architecture/contracts.md` (BINDING — read it first,
then `.foreman/scratch/enet-protocol-research.md` for the cited protocol facts). Mirror the structure
and quality bar of the existing ELM327 engine (`elm327Session.ts`, `pidCodec.ts`,
`simulatedTransport.ts`, `customPidValidation.ts` in apps/mobile) — same `ObdTransport` interface
(bytes in/out), same `TelemetrySample` output, same diagnostics style.

## EXPECTED OUTCOME (files, all new; nothing under `elm327*` changes)
1. `hsfzCodec.ts` — pure encode/decode of HSFZ frames: `encodeFrame({control, source, target, payload}) → Uint8Array`,
   incremental `HsfzFrameParser` fed with arbitrary TCP chunks (handles fragmentation and coalescing;
   rejects frames whose declared length is > 65535 or < 2 with a typed error and resynchronises by
   dropping the stream — document the choice). Control-word constants exactly as the addendum.
   Error frames 0x0040–0x0045 decoded to typed errors. NO GPL code copied — write from the addendum.
2. `udsCodec.ts` — build/parse PDUs: ReadDataByIdentifier(0x22, did), ObdMode01(0x01, pid),
   TesterPresent(0x3E, 0x80), positive/negative response parsing (0x7F sid nrc; 0x78 pending),
   `assertAllowedRequest(pdu)` implementing the READ-ONLY whitelist {0x01, 0x22, 0x3E} — throws a typed
   `UdsServiceNotAllowed` for anything else. Unit-test that 0x10/0x27/0x2E/0x31/0x34/0x3D/0x85 are refused.
3. `enetChannelSpecs.ts` — `EnetChannelSpec` type (from the addendum), `DEFAULT_ENET_CHANNEL_SPECS`
   (obd01 for rpm 0C / speedKph 0D / throttlePct 11 / coolantC 05 / engineOilC 5C — reuse `pidCodec`'s
   mode-01 decoders), `validateEnetChannelSpecs(specs)` → {valid, warnings}: rejects latG/longG channels,
   malformed hex, did specs without `decode` or `provenance`, duplicate channels (last wins + warning).
4. `enetSession.ts` — `EnetSessionEngine` implementing the same `Elm327Session`-shaped interface
   (`start/stop/onSample/onStateChange/getDiagnostics`; if the shared interface is named for ELM,
   introduce a neutral `TelemetrySession` alias in contracts without changing existing exports):
   connect → optional handshake (none needed for HSFZ beyond the first successful diag exchange) →
   poll loop with weighted round-robin (copy the scheduler semantics from `Elm327SessionEngine`),
   one request in flight, per-request timeout, ack (0x0002) tracking with latency stats, 0x78 wait
   extension, NRC 0x11/0x12/0x31 → channel UNSUPPORTED (removed from plan, diagnostics), alive-check
   (0x0012) answered as specified, TesterPresent every `testerPresentIntervalMs` (default 2000) while
   polling, `maxConsecutiveErrors` → state 'failed', clean stop. States: idle → connecting →
   handshake → polling → stopped | failed (reuse the ELM state vocabulary so the monitor screen works).
   Diagnostics as in the addendum incl. `lastRawFrameHex`.
5. `simulatedEnetTransport.ts` — `SimulatedEnetTransport implements ObdTransport`: scripted ECU with a
   deterministic scenario table (per DID/PID: value function of time or fixed bytes, NRC injection,
   responsePending N times, alive-check emission every N ms, disconnect-on-request-k, TCP
   fragmentation of responses into 1–3 byte chunks, ack on/off). Same knobs style as
   `SimulatedElm327Transport`.
6. `index.ts` exports; `packages/core/src/index.ts` re-exports the public surface (types, engine
   factory `createEnetSession(transport, config)`, simulator, specs validator, DEFAULT specs).
7. Tests (`packages/core/test/telemetry/enet/**`): codec round-trips incl. fragmentation/coalescing and
   malformed-length recovery; whitelist refusals; UDS parse vectors (positive 0x62, 0x7F+NRC, 0x78);
   spec validation; engine end-to-end on the simulator: samples for the 5 default channels with
   correct decode, unsupported channel dropped after NRC 0x11, tester-present cadence, alive-check
   reply, failure after N errors, stop mid-request is clean (no late samples — generation guard),
   ack latency stats populated. Provide independent test vectors (bytes written by hand from the
   addendum's layout), not vectors produced by the code under test.

## CONSTRAINTS
- Pure TypeScript, no Node/RN APIs, no new dependencies. No changes to the ELM engine, the recorder,
  the mobile app, or `docs/` (contracts are LEAD-owned; if you find the addendum inconsistent, STOP
  and report NEEDS_CONTEXT with the exact issue).
- EMPIRICAL items stay configurable (tester/target addresses, tester-present interval, whether obd01
  is attempted) — never hardcode a guess as a constant without a config override.
- Read-only mandate is absolute: the whitelist lives in the codec and the engine cannot bypass it.

## MUST DO
Gates with real exit codes: `npm run typecheck` → 0, `npm test` → 0, `npm run lint` → 0. Report test
totals before/after and the public API surface (exact exported names) so the mobile ticket can be
written against it.

## MUST NOT
Spawn agents; touch files outside the WRITE SET; commit.

## WRITE SET
`packages/core/src/telemetry/enet/**` (new), `packages/core/src/telemetry/contracts.ts` (additive only:
neutral session alias / new types), `packages/core/src/index.ts` (exports), `packages/core/test/telemetry/enet/**` (new).

## OUTPUT FORMAT
First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED; then files, API surface, gate outputs
with exit codes, totals, deviations flagged CONCERN.
