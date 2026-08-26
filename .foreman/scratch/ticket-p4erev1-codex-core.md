# Review ticket P4e-REV1 — Codex read-only cross-review: ENET/HSFZ + UDS core engine

Adversarial READ-ONLY reviewer (verifier role). Assume the work is broken until you find evidence otherwise.
Scope: commit `f069a4f` (diff: `git diff 708e5b3..f069a4f`), i.e. `packages/core/src/telemetry/enet/**` and
its tests. Binding spec: "ENET telemetry addendum" at the end of `docs/architecture/contracts.md`; protocol
facts with citations: `.foreman/scratch/enet-protocol-research.md`. If process spawning is denied, use the
read-only Node/Git path and say so.

## Attack list (file:line + concrete failing input → wrong output)
1. HSFZ framing vs the verified layout: 4-byte length = payload bytes incl. src+tgt (NOT the control word),
   2-byte control, src, tgt, UDS PDU. Check encode and the incremental parser with hand-made byte vectors:
   fragmentation at every boundary, two frames in one chunk, a frame split inside the length field,
   length 0/1/65536, error frames 0x0040–0x0045, alive check 0x0012 with/without payload. Resync behavior
   after a malformed length — can the parser desync permanently or loop?
2. READ-ONLY whitelist: is `assertAllowedRequest` the ONLY path to the wire? Can the engine, the specs
   decoder, or the simulator config inject a PDU that bypasses it (e.g. a `did` spec whose requestHex is
   crafted to change the SID byte, tester-present suppression byte, functional addressing)? Try to construct
   a spec that makes the engine send 0x10/0x2E/0x31/0x3D/0x85.
3. UDS parsing: positive 0x62 with DID echo, 0x41 mode-01 with PID echo, 0x7F NRC, 0x78 pending then
   final, malformed short responses, response for a different DID than requested (must not be decoded
   as the in-flight channel), multi-frame not applicable (HSFZ carries whole PDUs) — confirm no
   ISO-TP assumptions leak in.
4. Engine correctness: single in-flight request guarantee under timeouts + late responses; generation
   guard on stop (no samples after stop); tester-present fire-and-forget cannot starve the poll loop or
   be confused with a channel response; NRC 0x11/0x12/0x31 → unsupported removal; `maxConsecutiveErrors`
   → failed; ack (0x0002) handling when the adapter does NOT send acks; alive-check reply correctness.
5. Decoding: obd01 path reuses pidCodec via a synthetic response — any unit/scale mismatch? `did` decode
   with byteOffset/byteLength/signed/scale/offset — off-by-one, sign handling, NaN/Infinity guards.
6. Determinism and tests: are the 68 tests substantive (would they fail on plausible bugs) and do the
   hand-written vectors match the addendum? Any test that only round-trips through the code under test?
7. Licensing: any code that looks copied from scapy/ediabaslib (compare structure/comments)?
8. Regressions: ELM engine untouched (diff), `contracts.ts`/`index.ts` additive only.

## OUTPUT FORMAT
First line `PASS` / `FAIL` / `PASS_WITH_NOTES`; findings by severity with file:line + scenario + evidence;
Clean list. Stdout only. No agents.
