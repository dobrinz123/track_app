# Ticket P4f-FIX1 — batched fix wave for Codex P4f-REV1 (core)
Read `.foreman/scratch/p4frev1-codex-output.log` (from `FAIL`) and the "hard bounds & sweep boundary amendment"
(contracts.md, end — BINDING). Tests first (each review scenario as an independent vector; must fail on HEAD 52d7e6e),
then fix, one wave. Items: H1 discovery hard bounds (cap 16; budget/abort close active transports with a 200 ms
close race; hanging close cannot hang the run; abort checked synchronously before send; level-2 frame kinds);
H2 sweep boundary (runner builds 0x22 via assertAllowedRequest; `sendRequest(pdu)` low-level API — BREAKING for
the mobile ticket, document the new signature clearly; real parser + correlation + DID strip; 0x78 extension;
per-request timeout; pause re-check; cursor after result; accumulator across resumes; validated/clipped priority
ranges; pacing clamp); M heuristics (timing-aware temperature/pedal, speed scale fit, steering zero-crossing
semantics + confidence contribution, contradictory evidence); M candidates (canonical IPs, always the phone /24,
remove the invented "skip non-/24" rule and its test); L spec builder validation; tests: hard cap 16, budget
cancellation with an active probe, hanging close, real-parser sweep vectors, 0x78, pause/resume accumulation,
unbounded priority range rejected, the four heuristic counterexamples from the review, independent vectors
replacing simulator round-trips where flagged.
Gates (real exit codes): `npm run typecheck` 0, `npm test` 0 (core; mobile may break on the sweep API — report
which mobile tests fail and why; do NOT edit apps/mobile), `npm run lint` 0. WRITE SET: packages/core/src/telemetry/enet/**,
packages/core/test/telemetry/enet/**. No commit, no agents. OUTPUT: DONE/DONE_WITH_CONCERNS/BLOCKED + per-item evidence,
new sweep API, totals.
