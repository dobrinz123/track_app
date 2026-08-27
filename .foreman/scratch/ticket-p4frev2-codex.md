# Review ticket P4f-REV2 — Codex read-only: re-verify P4f-FIX1 (core) + review P4f-T2 (mobile)
Adversarial READ-ONLY reviewer. Prior: `.foreman/scratch/p4frev1-codex-output.log`. Diff: `git diff 52d7e6e..91c23d0`.
Binding: "ENET auto-discovery & DID sweep addendum" + "hard bounds & sweep boundary amendment" (contracts.md, end).
Read-only Node/Git path if spawning is denied — say so.
## Part A — REV1 items (H1 discovery bounds, H2 sweep boundary, M candidates, M level-2 kinds, M abort timing, M pause/resume, M ranges/pacing, M heuristics, L spec builder, tests): FIXED/PARTIAL/NOT FIXED + file:line + failing scenario.
## Part B — mobile (apps/mobile) attack list
1. expo-network usage matches SDK 57 docs (API names, permissions); `networkInfo.ts` never throws on web/null; no other new raw network APIs (static test coverage).
2. Find adapter: probe factory transports tolerate close() during connect (no unhandled rejection), reservation 'discovery' acquired/released on every path incl. cancel and throw; results applied only on tap; provenance persisted; ELM path never runs discovery.
3. Auto-connect: exactly once per start (no-host and first-failure paths), never loops with the retry policy, respects `enetAutoDiscover=false` byte-identically to the previous policy, reservation ordering with the provider's own claim (discovery inside the provider's claim vs separate owner — deadlock?).
4. DidSweep controller: state machine (start/pause/resume/stop) vs core accumulator semantics; `sendRequest` implementation = one HSFZ diagnostic frame with correlation of the response to the request (address swap, SID) before returning bytes; reservation 'sweep' exclusivity; observation phase re-poll timing; tag-as-spec merges/validates JSON and persists with provenance; cancellation leaves no socket open.
5. Settings hydration/repair for new keys; 360pt overflow risk on new rows/screens.
6. Tests: substantive? which paths above have none?
OUTPUT: first line PASS / FAIL / PASS_WITH_NOTES; Part A table; Part B findings by severity with file:line + scenario + evidence; Clean list. Stdout only. No agents.
