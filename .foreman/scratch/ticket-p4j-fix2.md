# Ticket P4j-FIX2 — Codex P4j-REV2 residuals (2 PARTIAL + 3 NEW MEDIUM), tests first, small
Source: `.foreman/scratch/p4jrev2-codex-output.log` (final section). HEAD 82404bc.
V1 DIDs marked `insufficient` in ANY phase are excluded from ranking (rank `insufficient`, listed separately with the failing phases) — never `brakeCandidate` etc. Test: 5/5/5 samples then 3 throttle misses → insufficient, not brakeCandidate.
V2 DidSweepScreen unmount cleanup awaits `stop()` (close + release) before the screen is gone (use an unmount-safe pattern: kick off and keep the promise in a module-level "pendingRelease" the next acquire awaits; or make the reservation acquire wait for a pending release). Test at controller/reservation level: acquire after stop() resolves only after release.
V3 Export reconciles live and persisted samples by `observationId` + sequence (union keyed by observationId/did/phase/seq), never "pick the longer source". Test: A persisted 320, B live 10 / persisted 8 → export has 330.
V4 Export keeps observation groups: series keyed by observationId + did + phase, with the batchIndex of that observation; no merging across observations. Test with a batched A and a focused B on the same DID.
V5 Slice tMs offsets: each slice's samples get `tMs += phaseElapsedAtSliceStart` so phase timestamps are monotone. Test with 5 slices.
Gates (real exit codes): typecheck, test, lint, expo export iOS all 0.
WRITE SET: apps/mobile/src/session/{didSweepController.ts,didSweepExport.ts,enetAdapterReservation.ts}, apps/mobile/src/ui/screens/DidSweepScreen.tsx, packages/core/src/telemetry/enet/didObservationPhases.ts, matching tests (export tests in didSweepExport.test.ts). No commit, no agents, no Expo server. Report DONE/DONE_WITH_CONCERNS/BLOCKED with evidence + totals.
