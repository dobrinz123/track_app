TASK: Cross-family re-verification of the lifecycle fix wave you previously triggered. Your earlier review (.foreman/scratch/preinstall-codex-output.log) found 11 findings (C1-C11) at commit 7f892a4 and concluded DO NOT INSTALL. A Sonnet worker has since implemented fixes for all of them plus 3 blind-verifier findings (B1 PB-capture pinning, B2 flush-propagation pinning, B4 DevReplay release gating). Verify the fixes are REAL and COMPLETE — you wrote the findings; you are the best judge of whether they are actually addressed.

SCOPE: `git diff 7f892a4..361b708` is the fix-wave delta. Read the current state of: packages/core/src/controller/{sessionController.ts,pipelineCore.ts}, apps/mobile/src/session/{composition.ts,realFacade.ts}, apps/mobile/src/platform/{gnssLocationProvider.ts,preflight.ts}, apps/mobile/src/ui/screens/{ActiveCalibrationScreen,CircuitDetailScreen,DevReplayScreen,PreflightScreen}.tsx, apps/mobile/src/ui/navigation/RootNavigator.tsx, and the new tests: apps/mobile/test/session/composition.lifecycle.test.ts, apps/mobile/test/platform/*.test.ts, packages/core/test/soak/personalBestEviction.soak.test.ts, packages/core/test/controller/sessionController.test.ts.

FOR EACH of your original C1-C11: verdict FIXED / PARTIALLY FIXED / NOT FIXED / FIX INTRODUCES NEW DEFECT, with file:line evidence. Hunt especially for:
- C1: is the fresh-controller swap race-free (startPreflight during an in-flight swap? gate() promise error path)? Does dispose truly detach the sample listener AND watchdog (double-fire after dispose)?
- C2: can any command still reach PendingFacade in a harmful way? bootstrapState 'failed' handling on retry?
- C3: is the op-chain airtight (rejection in doStart poisoning the chain forever)?
- C4: does the flush-before-save ordering deadlock if a pending write awaits something that endSession blocks?
- C5/C10: pointer re-affirm + lock interplay — any path clearing the pointer early or deadlocking the lock?
- C6: restoreProductionFacade during an ACTIVE replay session mid-lap — clean?
- NEW defects introduced anywhere in the delta (regressions in previously-working paths).

MUST NOT: modify any file; advisory only.

OUTPUT FORMAT: First line PASS / FAIL / PASS_WITH_NOTES. Then the C1-C11+B1/B4 verdict table with evidence, any NEW findings ranked by severity, and a final line: SAFE TO INSTALL or DO NOT INSTALL.
