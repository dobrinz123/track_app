# Review ticket P4e-REV2 — Codex read-only: re-verify P4e-FIX1 (core) + review P4e-T2 (mobile ENET wiring)

Adversarial READ-ONLY reviewer. Prior report: `.foreman/scratch/p4erev1-codex-output.log`. Diff under review:
`git diff f069a4f..053c274`. Binding specs: "ENET telemetry addendum" + "framing & correlation amendment" at the
end of `docs/architecture/contracts.md`. Use the read-only Node/Git path if spawning is denied, and say so.

## Part A — re-verify REV1 items (H1 framing union, H2 correlation, M1 fatal framing, M2 spec validation,
L1 TesterPresent, L2 ACK attribution): FIXED / PARTIAL / NOT FIXED with file:line and a failing scenario if not.

## Part B — mobile wiring (apps/mobile), attack list
1. Byte safety end to end: `EnetTcpTransport` with react-native-tcp-socket — Uint8Array in/out, no
   'ascii'/utf8 coercion anywhere (grep), `bytesToBinaryString`/`binaryStringToBytes` round-trip correctness
   for bytes 0x80–0xFF; partial writes; close semantics (single notification, closed flag), connect timeout.
2. Provider selection: with `adapterType:'elm327'` the ENET code is never constructed (prove from source);
   with 'enet' + telemetrySimulate (dev) the `SimulatedEnetTransport` is used; generation guards and reconnect
   policy apply to the ENET engine identically; ENET→Elm327State mapping cannot mislabel 'failed'/'stopped'.
3. Read-only guarantee at the mobile layer: no path builds a UDS PDU without `assertAllowedRequest`
   (DID probe screen, provider, settings validation) — try to craft settings/probe input that sends 0x10/0x2E.
4. Settings hydration and validation: new keys default correctly when absent; hex byte parsing (00–FF),
   port bounds, channel-specs JSON errors surfaced not thrown; ELM fields untouched.
5. DID probe screen: __DEV__-only registration (RootNavigator), whitelist error shown, request/response hex
   correctness, 50-entry log bound, no probe while a session is polling (or a defined rule) — say what it does.
6. Telemetry monitor: ENET diagnostics rendering (UNSUPPORTED + NRC, ack p50/p95, frames tx/rx) cannot
   crash on undefined diagnostics before first poll; 360pt/1.3x overflow risk on new Settings rows.
7. Offline mandate: the ENET socket is the only network activity and only when telemetry enabled + enet.
8. Tests: are the 31 mobile tests substantive? Which of the above have NO test?

## OUTPUT FORMAT
First line `PASS` / `FAIL` / `PASS_WITH_NOTES`; Part A table; Part B findings by severity with file:line +
scenario + evidence; Clean list. Stdout only. No agents.
