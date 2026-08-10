TASK: Extend the @circuit/core telemetry engine for the channel revision, exactly per docs/architecture/contracts.md section "Telemetry addendum — channel revision (2026-08-11, binding)" (read it first).

EXPECTED OUTCOME:
(a) contracts.ts: TelemetryChannelId extended with 'engineOilC' | 'transOilC' | 'latG' | 'longG' (comments per the addendum).
(b) pidCodec.ts: engineOilC = standard mode-01 PID 0x5C, decode A-40 (request '015C', response '41 5C A'). latG/longG are NOT OBD channels — the codec must NOT accept them (encode/decode for them throws or is unreachable by type).
(c) elm327Session.ts: CUSTOM PID support — Elm327Config gains optional `customPids?: Array<{ channel: TelemetryChannelId; request: string; }>` where request is a raw hex command string sent verbatim (e.g. '221E1C'); decode rule fixed: last data byte of the response minus 40 (the addendum's binding rule). A pollPlan entry whose channel matches a customPids entry uses the custom request; a pollPlan entry for 'transOilC' WITHOUT a matching customPids entry is ignored at start (never polled, one warning via onStateChange detail or diagnostics — pick one and document). Custom responses go through the same framing/error taxonomy; errors count toward the same maxConsecutiveErrors.
(d) Poll plan DEFAULTS live mobile-side — core just executes whatever plan it is given; do not hardcode the revised defaults in core (verify none are hardcoded today; report if they are).

CONTEXT: Repo D:\CODE\APLICTIE_Circuit, packages/core/src/telemetry/** (you wrote the original engine). Existing tests in packages/core/test/telemetry/ — extend, do not weaken.

CONSTRAINTS: Pure TS, no new deps, no Date.now/Math.random in src, deterministic tests (fake clock pattern already in the tests).

MUST DO:
1. Tests: engineOilC codec vectors (hand-computed, incl. boundary 0x00 -> -40 and 0xFF -> 215); custom PID: session polls the custom request verbatim, decodes last-byte-minus-40, tolerates multi-byte responses (e.g. '62 1E 1C 87' -> 0x87-40=95), errors on custom channel escalate identically; transOilC-without-config ignored (no request ever sent, pinned); existing 32 telemetry tests stay green.
2. Run: cd packages/core && npx vitest run test/telemetry > /tmp/core2.log 2>&1; ec=$?; report the REAL exit code + counts. If the sandbox denies spawning, say so explicitly (do NOT claim pass) and rely on the LEAD to gate.
3. npx tsc --noEmit in packages/core, same reporting rule.
MUST NOT: No subagents. Touch nothing outside packages/core/src/telemetry/** and packages/core/test/telemetry/**. Do not change simulatedTransport's existing behavior (extend only if a test needs a custom-PID script hook — additive).
WRITE SET: packages/core/src/telemetry/**, packages/core/test/telemetry/**.
OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then: files changed; test/tsc REAL exit codes or exact denial; whether poll-plan defaults were found hardcoded in core; deviations/concerns.
