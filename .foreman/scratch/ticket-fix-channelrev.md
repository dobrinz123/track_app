TASK: Fix ALL findings from two reviews of the channel revision: the Codex mobile review (full report: .foreman/scratch/mobile2-verify-out.log — read the tail FAIL section) and 2 core verifier notes restated below. Designs are BINDING.

BINDING DESIGNS:
F1 HIGH service whitelist (three defense layers, all mandatory):
  L1 UI validator (SettingsScreen parseHexPidDraft): a non-empty value is valid ONLY if (compact hex, even length >= 4) AND service byte (first two hex chars) is '21' or '22'. Reject 01/04/08/2F/3E and everything else with a clear inline error string ("Only read services 21/22 allowed").
  L2 provider (buildCustomPids): drop any persisted request that fails the same rule (import ONE shared validator function used by both L1 and L2 — put it in a pure module, e.g. apps/mobile/src/session/customPidValidation.ts) with a console.warn.
  L3 core (elm327Session start): reject customPids entries whose service byte is not 21/22 OR whose channel is 'latG'/'longG' (accelerometer channels, core verifier note a) OR whose compact hex length is odd — skipped with one warning each, never thrown.
  Tests: the validator module imported by tests (no copied regexes — rewrite settingsHexPidDraft.test.ts to import production); table incl. '04', '0101', '015C', '221E1C' ok, '21AB' ok, odd '221E0' rejected, latG-channel rejected at core.
F2 MED sync-throw isolation: core start() must not throw synchronously on bad config (L3 handles config errors as warnings). ADDITIONALLY composition wraps EACH provider start (OBD, G) in its own try/catch so a synchronous throw from one can never prevent the other or wedge running=true — and telemetryProvider.start() resets its own state (running=false, state 'failed' with detail) if session construction throws. Test: a throwing OBD start leaves G running and provider in 'failed', pinned.
F3 MED mode-01 collision: covered by F1 whitelist ('015C' as custom rejected — the standard engineOilC channel already handles 0x5C properly). Test included in the F1 table.
F4 LOW verbatim wording: keep outer-whitespace trim; fix the code comment + test name to say "normalized (outer whitespace) then sent verbatim"; contracts.md stays as-is (trim is not a semantic change).
F5 LOW chart-order test: move the TELEMETRY_CHART_CHANNELS constant into apps/mobile/src/persistence/telemetryRead.ts (pure module), LapDetailScreen imports it; test imports the production constant and pins the addendum order.
CORE-b: decodeCustomResponse odd-length hex tail (e.g. '621E1C8') must be treated as a channel error (like NO DATA), never a misaligned decode. Test with that exact vector.

CONTEXT: Repo D:\CODE\APLICTIE_Circuit. Files: apps/mobile/src/session/{telemetryProvider.ts,composition.ts,customPidValidation.ts(new)}, apps/mobile/src/ui/screens/{SettingsScreen.tsx,LapDetailScreen.tsx}, apps/mobile/src/persistence/telemetryRead.ts, packages/core/src/telemetry/elm327Session.ts, tests. NOTE: other workers own hardware/ and firmware/ — do not touch those dirs.

MUST DO:
1. Every fix pinned by a test importing PRODUCTION code.
2. Gates from repo root with REAL exit codes (cmd > log 2>&1; ec=$?): npm run typecheck, npm test, npm run lint, cd apps/mobile && npx expo export --platform ios. All four reported.
MUST NOT: No subagents. No new deps. Nothing outside WRITE SET. Do not weaken existing tests (rewriting the two named test files to import production is required, not weakening).
WRITE SET: the files listed in CONTEXT plus apps/mobile/test/session/**, apps/mobile/test/persistence/**, packages/core/test/telemetry/**.
OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then per-finding fix + pinning test; four gate exit codes + counts; deviations/concerns.
