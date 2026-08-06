# ADR-0004 — iOS without a Mac: Expo Go development + EAS cloud builds

Date: 2026-08-06 · Status: Accepted · Decider: user constraint (Windows-only host, iPhone device), implemented by Fable 5

## Context

The user develops on Windows (no Mac, no Xcode) and runs the app on a physical iPhone. Expo makes this viable; this ADR fixes the strategy and its boundaries.

## Dependency audit (2026-08-06, foreman-verified against apps/mobile/package.json)

Every dependency is Expo Go-compatible on SDK 57:

| Dependency | Type | In Expo Go? |
|---|---|---|
| expo-location, expo-sensors, expo-sqlite, expo-keep-awake, expo-task-manager, expo-status-bar | Expo SDK modules | ✅ bundled |
| react-native-screens, react-native-safe-area-context | community native, Go-bundled | ✅ bundled |
| @react-navigation/*, @circuit/core, react, react-native | pure JS / core | ✅ |

**No module breaks Expo Go. No dev client is required for the MVP.** Rule going forward: any new dependency must be checked against Expo Go compatibility first; prefer Expo SDK modules; a dependency that requires custom native code forces the EAS dev-client path and must be justified in a decision record.

## Decision

> **Amendment (2026-08-06, user clarification):** Expo Go is a **development-only** workflow. It is NOT viable on-track (no PC/Metro/Wi-Fi at the circuit). The **primary on-track workflow is a standalone EAS-built iOS app installed on the iPhone from Windows**, running fully offline: the release build embeds the Hermes JS bundle, and the circuit profile is a statically imported JSON asset inlined into that bundle — a timed session requires zero network. Integration (WP14) must verify both properties: static `require`/`import` of the TMR profile (never fetched), and no network calls in any session-critical path.

0. **Install paths for the standalone build (both driven from Windows):**
   - **(a) Paid, recommended:** Apple Developer Program ($99/yr — the only paid dependency) + TestFlight (or ad-hoc/internal distribution with registered UDID). No re-signing churn; builds last per normal App Store Connect rules.
   - **(b) Free:** sideload the EAS-built .ipa with a free Apple ID using **AltStore or Sideloadly on Windows**. Works with no paid account, but Apple limits free-account signatures: **the app expires every 7 days** and must be re-signed/reinstalled (AltStore can auto-refresh when on the same network as its server). Fine for personal testing; unsuitable as a long-term distribution path. 3-app limit per free account applies.
   - eas.json defines `development` (dev client), `preview` (internal-distribution .ipa — the artifact to sideload or ad-hoc install), and `production` (App Store/TestFlight) profiles.

1. **Development workflow (dev only, not on-track): Expo Go on iPhone, Metro on Windows.**
   - `npm install` → `cd apps/mobile` → `npx expo start` (same Wi-Fi) or `npx expo start --tunnel` (restrictive networks).
   - Scan the QR with the iPhone camera → opens in Expo Go. Foreground location, sensors, SQLite, keep-awake, and the full replay/dashboard flow work in Go.
   - Caveats inside Expo Go (documented, acceptable): app.json Info.plist customizations (usage-description copy, temporary-full-accuracy dictionary from ADR-0003) do NOT apply — Expo Go's own Info.plist governs permission prompts; precise-accuracy behavior should be re-verified once on a standalone build. Foreground-only design means no background-mode gaps in Go.
2. **Standalone/production .ipa: EAS Build (cloud macOS builders), no local Xcode.**
   - One-time: `npm i -g eas-cli` (or npx), `eas login`, `eas build:configure` (creates eas.json).
   - Build: `eas build --platform ios --profile production` (or `--profile development` for a dev client if ever needed).
   - **The only paid/credential dependency in the project: an Apple Developer Program membership ($99/yr)** — required by Apple for any distributable iOS build (TestFlight or ad-hoc). EAS can manage certificates/provisioning automatically with those credentials. Distribution to the user's iPhone via TestFlight (recommended) or ad-hoc with the device's UDID registered.
   - EAS free tier queues are sufficient for this project's cadence.
3. **On-track usage builds**: on-track sessions and real-track validation MUST use the standalone EAS-built app (TestFlight, ad-hoc, or sideloaded preview .ipa) — never Expo Go. This is required both for offline operation (no Metro/PC at the circuit) and so ADR-0003's Info.plist and precise-accuracy configuration are actually in effect. The validation checklist assumes a standalone build installed from Windows.
4. Docs are **Windows-host + iPhone-device first**: README quickstart, run instructions, and the real-track validation checklist lead with this path (see docs/ios-no-mac-workflow.md).

## Consequences

- No local iOS native build is ever run on this machine; `npx expo export --platform ios` (Metro bundle) plus typecheck/lint/tests remain the local verification gates, EAS builds the shippable artifact.
- Expo Go's Info.plist caveat is a known, documented validation gap between dev and standalone builds.
