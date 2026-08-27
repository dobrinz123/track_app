# Ticket P4i-FIX2 — Codex REV3 residuals (sweep persistence/observation), tests first, bounded
Source: `.foreman/scratch/p4hrev3-codex-output.log` (final "codex" section: H3 PARTIAL + 5 NEW MEDIUM). HEAD ccb2cfc.
R1 (H3 partial) Stop/Pause/complete must AWAIT the terminal flush (public `stop()/pause()` resolve after the checkpoint is committed; screen shows "Saving…" until then). The ≤ 1 s batch window re-send on a hard kill is ACCEPTED — document it in a comment + contracts-facing note in the export meta (`resumeBound: "≤1s of DIDs may be re-sent after a hard kill"`).
R2 guidedSamples cleared on every fresh sweep start / resume and keyed by runId; export takes samples only when `samples.runId === run.id`. Test: run A guided → run B shared without guided → empty series.
R3 no double-count: a flush snapshot advances `lastPersistedResponderIndex` (or a `pendingUpTo` marker) at SNAPSHOT time, not after write; on write failure roll the marker back. Test: stalled periodic flush + forced flush → sampleCount 1.
R4 `flushRunProgress` verifies the run row exists inside the transaction (no orphan responders); add FK or explicit check; retention delete + late flush → no-op. Test.
R5 keep-alive ticker: `void channel.keepAlive().catch(handler)`; a failure ends the guided sequence with a visible error and closes/releases cleanly (no unhandled rejection). Test with a rejecting transport.
R6 pre-pass snapshot: real phase duration (2 rounds + gap, scaled by candidate count) and advancing elapsed/countdown; UI shows the correct remaining seconds. Test.
Gates (real exit codes): typecheck, test, lint, expo export iOS all 0.
WRITE SET: apps/mobile/src/persistence/didSweep*.ts, apps/mobile/src/session/{didSweepController.ts,didSweepExport.ts}, apps/mobile/src/ui/screens/DidSweepScreen.tsx, packages/core/src/telemetry/enet/didObservationPhases.ts, matching tests. No commit, no agents, leave the Expo server alone. Report DONE/DONE_WITH_CONCERNS/BLOCKED with evidence + totals.
