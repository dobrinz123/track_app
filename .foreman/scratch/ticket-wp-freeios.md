TASK: Implement the free iOS install path per ADR-0005: GitHub Actions workflow producing unsigned Release + dev-client .ipa artifacts, plus a complete beginner-proof Windows/Sideloadly guide. The user has never sideloaded before — the guide must assume zero prior knowledge.

EXPECTED OUTCOME: (1) `.github/workflows/build-unsigned-ios.yml` exists, YAML-valid, and follows current GitHub Actions syntax; (2) `npx expo prebuild --platform ios --no-install` succeeds on this Windows machine (config-plugin validation) and the generated ios/ folder is NOT committed (add to .gitignore); (3) expo-dev-client added and `npm run typecheck`/`npm test`/`npm run lint`/`npm run export:ios` still green; (4) docs/ios-no-mac-workflow.md rewritten per ADR-0005; (5) validation checklist precondition updated. Paste decisive output for every gate.

CONTEXT: Read first: docs/decisions/ADR-0005-free-install-path.md (binding), .foreman/scratch/free-ios-install-research.md (sourced facts — use its Sideloadly/AltStore specifics), docs/ios-no-mac-workflow.md (current), apps/mobile/app.json (bundle id/scheme/name — derive xcodebuild scheme from actual config, do not guess), apps/mobile/package.json, docs/verification/real-track-validation-checklist.md.

CONSTRAINTS: TypeScript/config changes minimal: add expo-dev-client via `npx expo install expo-dev-client` (Expo-managed version; lockfile update allowed). Do NOT touch packages/core/**. Monorepo note: the workflow must npm ci at repo ROOT (workspaces) then operate in apps/mobile.

MUST DO:
1. Workflow `.github/workflows/build-unsigned-ios.yml`:
   - trigger: workflow_dispatch (manual) with an input `variant` (release | dev-client | both, default both); also on push tags `build-*`.
   - runner: macos-latest; steps: checkout, setup-node 24 with npm cache, `npm ci` at root, then in apps/mobile: `npx expo prebuild --platform ios` (installs pods on macOS), then for release: `xcodebuild -workspace <derived>.xcworkspace -scheme <derived> -configuration Release -destination 'generic/platform=iOS' -archivePath build/app.xcarchive archive CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""`, then package `build/app.xcarchive/Products/Applications/*.app` into `Payload/` → zip → `CircuitTimer-release-unsigned.ipa`; for dev-client: same with `-configuration Debug` → `CircuitTimer-devclient-unsigned.ipa`. Upload both via actions/upload-artifact@v4 with 90-day retention. Derive scheme/workspace name from app.json's `name`/expo config (state your derivation in a workflow comment). Add `timeout-minutes` guards and a concurrency group.
   - Keep the workflow self-documenting with comments; no secrets used anywhere.
2. Run `npx expo prebuild --platform ios --no-install` locally (Windows) to prove config plugins resolve; report the generated scheme/workspace names (they inform the workflow); then delete the ios/ folder and add `apps/mobile/ios/` and `apps/mobile/android/` to .gitignore (CNG rule).
3. expo-dev-client: install in apps/mobile; confirm `npm run export:ios` still exits 0 and typecheck/lint/test green at root.
4. Rewrite docs/ios-no-mac-workflow.md per ADR-0005 with this structure:
   a. "What changed" note: Expo Go retired from App Store (cite changelog URL from research packet) — sideloaded builds are now BOTH the dev loop and the on-track path.
   b. One-time setup (step-by-step, beginner-proof, numbered): create free GitHub account; create repo (recommend PUBLIC for unlimited macOS minutes; private = ~200 macOS min/month, state both); push this repo (exact git commands incl. remote add); enable Actions; run the workflow (Actions tab → Build unsigned iOS → Run workflow) and download the .ipa artifact; install Sideloadly from sideloadly.io on Windows (note: needs iTunes from Apple's website, NOT the Microsoft Store version — per research packet); connect iPhone via USB, trust the computer.
   c. Installing/re-signing with Sideloadly (numbered, exact UI fields per research packet): drag .ipa in, enter free Apple ID, Start; first-install phone steps: Settings → General → VPN & Device Management → trust your Apple ID cert; note the 3-app limit and app-specific password hint if 2FA prompts.
   d. The 7-day cycle: what expiry looks like (app icon still present, launch fails), the ~2-min re-sign routine (same .ipa or freshly built one, SAME bundle id → data and PBs preserved), calendar-reminder suggestion.
   e. Dev loop with the dev-client build: sideload dev-client variant → `npx expo start` on Windows → open app → connect to Metro over same Wi-Fi (or `--tunnel`); what works vs release build.
   f. Paid alternative (TestFlight/EAS) kept as a short final section (link eas.json), explicitly optional.
   5. Update docs/verification/real-track-validation-checklist.md precondition line: build type = "unsigned Release .ipa, Sideloadly-signed (free Apple ID)" as the reference free path OR TestFlight build (paid); add one checklist item: "signature age < 7 days at session start (sideloaded builds)".
6. README: adjust the quickstart pointer (Expo Go references replaced by dev-client sideload path pointer to the workflow doc; keep it short).

MUST NOT: commit generated ios/ or android/ folders; add EAS/paid-path requirements to the free flow; touch packages/core; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, the derived scheme/workspace names, commands + pasted results, honest UNVERIFIED list (the macOS CI run itself), limitations.

WRITE SET: .github/workflows/**, apps/mobile/package.json, package-lock.json, .gitignore, docs/ios-no-mac-workflow.md, docs/verification/real-track-validation-checklist.md, README.md, apps/mobile/app.json (only if dev-client needs a scheme entry).
