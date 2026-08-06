TASK: FINAL INDEPENDENT VERIFICATION of the Circuit Timer application against its definition of done. You are an adversarial verifier with fresh context: assume every claim is false until you reproduce evidence. You did not author this code.

EXPECTED OUTCOME: A verdict report. First line PASS / FAIL / PASS_WITH_NOTES, then a filled DoD matrix (evidence per row — command output, file:line, or test name; 'UNVERIFIABLE HERE' with reason where on-device hardware is genuinely required), findings ranked by severity.

CONTEXT: Repo root D:\CODE\APLICTIE_Circuit. Read docs/implementation-plan.md, docs/architecture/contracts.md, docs/architecture/current-state.md, README.md first. The repository ledger .foreman/ledger.md tells you what was claimed — verify claims against reality, not against the ledger.

DEFINITION-OF-DONE MATRIX (verify each):
1. `npm run typecheck`, `npm test`, `npm run lint` all pass from repo root — run them; paste summaries.
2. `npx expo export --platform ios` and `--platform android` exit 0 (run in apps/mobile).
3. Transilvania Motor Ring selectable in the app; circuit profile loads + validates (asset test exists AND passes; UI screen wires the real profile — check apps/mobile/src/session/tmrProfile.ts + CircuitSelectionScreen).
4. Learn/calibration processes a full replayed recognition lap through the PRODUCTION pipeline; calibration can succeed AND fail for correct reasons (find and run the specific tests; verify failure paths cover: partial lap, wrong direction, noise, low rate).
5. Track progress + sector identification works (matcher tests + integration).
6. Directed start/finish and sector crossings with interpolated timestamps; duplicate/jitter/reverse/stop-on-line guards (find each test).
7. Complete valid laps timed; invalid laps rejected with machine-readable reasons (verify reason-code coverage: SHORT_LAP, PIT_TRANSIT, LOW_QUALITY, PAUSE_GAP, REVERSE_TRAVEL, MISSED_SECTOR_GATE, DUPLICATE_SECTOR_GATE, RECOVERY).
8. PB stored per user+layout version with full reference telemetry; PB replacement rules enforced (never replaced by invalid/pit/low-quality/slower lap — find the property/unit tests).
9. Live delta computed by matched track progress with neutral-on-low-confidence and correct sign convention.
10. Offline: zero network-call sites in session paths (grep fetch(/XMLHttpRequest/axios/WebSocket in apps/mobile/src + packages/core/src); TMR profile statically bundled (verify the static import in code; the .hbc embedding proof is documented in docs/architecture/current-state.md — confirm the claim is at least consistent with the import mechanism).
11. App-restart recovery: checkpoint save/load, RECOVERY lap invalidation, no cross-launch tMono comparison (find tests + code).
12. Deterministic fixtures for all 15+ adversarial scenarios streamed through the production pipeline (list them from fixtures/scenarios.ts and match against test/replay assertions).
13. Watchdog: provider restart on sample gap (test exists).
14. Security posture: profile input caps, bounded session telemetry, delete-my-data UI wiring, checkpoint corruption safety (verify the fixes exist with tests — .foreman/scratch/security-review-findings.md lists what was found; confirm each M/L is actually fixed at HEAD).
15. Performance: benchmark tests pass; matcher hint-optimization present with measured-ratio assertion.
16. Docs: README quickstart accurate (commands actually exist in package.json files); docs index links resolve; validation checklist assumes standalone iOS build; no doc claims geometry/sectors are official; OSM ODbL attribution present in profile source field AND user-visible UI (find it in a screen).
17. State machine covers all 12 required states; illegal events ignored not thrown (tests).
18. No fabricated circuit data: circuit geometry traces to data/osm/ extracts via the generator (spot-check: regenerate with `npm run generate:tmr` and confirm byte-identical asset via git diff).

You MAY create throwaway probe tests ONLY under packages/core/test/_finalverify/ (run via vitest) — delete them before finishing; final `git status --porcelain` must show no files you created.

MUST NOT: modify any repository file (probes excepted, deleted before exit); spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of PASS / FAIL / PASS_WITH_NOTES. Then the numbered matrix with evidence per row, findings by severity (a DoD row without evidence = FAIL), final git status confirmation.
