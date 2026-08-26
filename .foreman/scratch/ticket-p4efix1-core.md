# Ticket P4e-FIX1 — batched fix wave for Codex P4e-REV1 (ENET core)

## TASK
Fix ALL findings in `.foreman/scratch/p4erev1-codex-output.log` (from the `FAIL` line) in one wave, per the
new "framing & correlation amendment" at the end of `docs/architecture/contracts.md` (BINDING). Write the
failing tests FIRST (they must fail on HEAD f069a4f), then fix. Another worker is editing apps/mobile
against the current public API — keep the public API ADDITIVE/backward-compatible (existing exported
names and function signatures keep working; add new fields/types instead of renaming).

## Items
H1 control-specific HSFZ layouts: `HsfzFrame` becomes a discriminated union by control word (diagnostic
   {src,tgt,payload}; aliveCheck {form:'short'|'long', src?, tgt?, identification?}; error {code, expected,
   received, raw}; other {control, payload}); encoder accepts the specific shapes; alive-check reply per the
   amendment; MAX payload 4096 (not 65535) with the cited-vector tests from the review (`[00 00 00 02 00 40 AA BB]`,
   `[00 00 00 03 00 12 41 42 43]`, short alive request/reply). Replace the fabricated error-frame test.
H2 response correlation: match by swapped addresses + SID (+0x40 / 0x7F echo) + identifier echo before
   resolving the in-flight request; unmatched → diagnostics counters (`unmatchedResponses`), slot untouched;
   NRC marks a channel unsupported only when the echoed SID+identifier match it; the review's three executed
   scenarios become tests (late RPM response during speed request; delayed `7F 3E 31` during a poll;
   different-DID positive response).
M1 corrupted length → fatal: parser raises a fatal error, engine closes the transport and goes through the
   normal reconnect/failure path (state and diagnostics), never "clear buffer and continue". Test with the
   review's sequence (`[00 00 00 00]` then `[00 00 00 20]` then a valid alive frame).
M2 spec validation: channel↔PID consistency table for obd01 (reject `speedKph` with `0C`, reject channels
   without a mode-01 decoder such as transOilC), integer byteOffset ≥ 0, byteLength ∈ {1,2}, finite
   scale/offset, decoded value must be finite else dropped + `decodeErrors` counter (no error-counter reset).
L1 TesterPresent: clamp interval ≥ 500 ms; guarantee at least one channel poll between two TesterPresent
   frames (no starvation) — test with a tiny interval.
L2 ACK latency attributed only when the echoed head matches the last diagnostic request (ignore ACKs for
   TesterPresent/alive replies); test.
Also: reduce self-consistency risk — where a session test feeds the simulator through the same codec, add at
least the hand-written wire vectors from the review as independent inputs.

## CONSTRAINTS
Core only (`packages/core/src/telemetry/enet/**`, its tests, `contracts.ts` additive); no ELM changes; no
new deps; no GPL code. Gates with real exit codes: `npm run typecheck` → 0, `npm test` → 0, `npm run lint` → 0.
Report per-item status with pre-fix failing evidence, totals, and the exact list of public API changes
(must be additive). Do not commit. No agents.

## OUTPUT FORMAT
First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED.
