# Review ticket P4f-REV1 — Codex read-only cross-review: discovery / DID sweep / heuristics (core)
Adversarial READ-ONLY reviewer. Diff: `git diff 3b8d173..52d7e6e`. Binding: "ENET auto-discovery & DID sweep addendum" (contracts.md, end). Read-only Node/Git path if spawning is denied.
Attack list (file:line + concrete failing input → wrong output):
1. `buildDiscoveryCandidates`: ordering per addendum, dedupe, /24 derivation from ipv4+mask (non-/24 masks, malformed inputs, phone IP excluded, cap 260), port ordering.
2. `runDiscovery`: concurrency bound actually enforced; budget truncation and abort stop new probes AND close open sockets; a probe that never resolves cannot hang the run; level-2 requires a VALID HSFZ frame (not any bytes); the TesterPresent goes through `assertAllowedRequest`; per-host errors never reject; deterministic result ordering; RTT measured correctly.
3. `runDidSweep`: resumable plan correctness (from/to inclusive, priority ranges, lastDid), pause/stop semantics without losing a DID, adaptive pacing bounds (min/max), 0x78 handling, NRC classification, only 0x22 reachable (injected request), no unbounded memory (responders list vs 65536 DIDs).
4. `classifyResponders`: decode widths, false positives on noise, monotonic-drift detection with jitter, speed correlation math with GNSS context, steering sign-change logic, confidence monotonic with evidence, determinism; `enetSpecsFromSuggestion` provenance format and validation against `validateEnetChannelSpecs`.
5. Simulator: DID scenario time functions deterministic; discovery probe factory shape matches `ObdTransport`.
6. Tests: substantive? vectors independent of the code under test? Any test that only round-trips?
7. Regressions: existing enet files additive only (diff); whitelist untouched.
OUTPUT: first line PASS / FAIL / PASS_WITH_NOTES; findings by severity with file:line + scenario + evidence; Clean list. Stdout only. No agents.
