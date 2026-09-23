# Review ticket P18-REV4 — Codex read-only cross-review of P18-FIX3
Adversarial READ-ONLY reviewer. The fix is commit `939b93f` on branch `p18-fix1-delete-all`: `git diff 1dee7b2..939b93f` (small). Cumulative delete-all rework: `git diff 6d6f90b..939b93f`.
It answers your P18-REV3 review (`.foreman/scratch/p18-codex-rev3-out.txt`, final section after the last `codex` line): MEDIUM 1 (fence-only return strands VIN detection at 'attempting' after a refused delete), LOW 2 (Settings draft not reset when delete-all rejects), the history-freshness qualification, and the policy qualifications (selected circuit, adopting-phase "stop").
Binding: HANDOFF.md item 1 (a VIN is personal data; delete-all must remove it), docs/legal/privacy-policy.*.md §3.3 and §7.
1. For EACH REV3 finding/qualification: CLOSED / PARTIAL / OPEN with file:line and a concrete failing sequence if not closed.
2. Attack the new `maybeDetectVehicleFromVin` branch (`deviceWipeInProgress` with unchanged generation -> `vinDetectionState = 'idle'`): can it let delete-all return `ok: true` with the VIN in memory or on disk, allow two concurrent reads, or re-arm when it must not?
3. The history refresh now keyed on `result.ok` (per-circuit wipe) — any stale or wrong history shown?
4. SettingsScreen `finally` draft reset — any state bug (unmounted component, stale closure)?
5. Does the new test in `composition.deleteAllVinFence.test.ts` pin M1 (it fails on 1dee7b2)?
6. A final sweep over the cumulative diff for any remaining HIGH.
OUTPUT: first line PASS / FAIL / PASS_WITH_NOTES; per-finding status; new findings by severity with file:line + scenario + evidence; Clean list. Stdout only. No agents.
