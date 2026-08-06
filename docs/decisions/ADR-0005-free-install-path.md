# ADR-0005 — Free iOS install path: GitHub Actions unsigned .ipa + Sideloadly (Expo Go retired)

Date: 2026-08-06 · Status: Accepted · Supersedes the Expo Go dev-loop portion of ADR-0004 · Decider: user constraint (no paid Apple Developer account), facts verified in .foreman/scratch/free-ios-install-research.md

## Context (verified 2026-08-06)

1. **Expo Go is no longer a viable iPhone dev loop**: Expo stopped submitting Expo Go to the App Store (last supported SDK ≤55, per Expo's May 2026 changelog; no SDK 57 release planned). Our app is SDK 57 (current latest) — the mismatch is unfixable by upgrading or downgrading.
2. **EAS Build for iOS devices requires a paid Apple Developer account** — no unsigned-build option exists. EAS is removed from the free path (eas.json retained for a future paid option).
3. **Unsigned .ipa route works**: `expo prebuild` + `xcodebuild archive CODE_SIGNING_ALLOWED=NO` on a macOS runner produces an unsigned .ipa; GitHub Actions macOS runners are free-unlimited on public repos (~200 macOS min/month effective on private free tier).
4. **Sideloadly (Windows, v0.60+) signs any .ipa with a free Apple ID** over USB: 7-day signature validity, 3-app limit, re-signing with the same bundle ID preserves app data. EU/DMA status (Romania) changes nothing for self-built apps.
5. **Free personal-team signing supports every entitlement we use** (when-in-use location, SQLite, sensors, keep-awake). Blocked entitlements (background modes, push, App Groups) are ones the app deliberately does not use (ADR-0003 foreground-only).

## Decision

1. **On-track builds (free path)**: a GitHub Actions workflow (`.github/workflows/build-unsigned-ios.yml`) builds an **unsigned Release .ipa** from the repo on a macOS runner; the user downloads the artifact and installs it with **Sideloadly + free Apple ID** on Windows. Re-sign every ≤7 days (data preserved).
2. **Dev loop**: the same workflow also builds an **unsigned dev-client .ipa** (expo-dev-client). Sideloaded once, it connects to `npx expo start` on the Windows host over Wi-Fi — restoring the fast-iteration loop Expo Go provided.
3. `ios/` native projects remain generated (CNG/prebuild) — never committed.
4. Docs (workflow guide + validation checklist) updated: Sideloadly is the reference install path; TestFlight/EAS documented as the optional paid alternative.

## Consequences

- Requires a GitHub account; a **public** repo is recommended for unlimited free macOS minutes (the repo contains no secrets — verified; ODbL data is redistributable with attribution).
- Weekly re-sign ritual (~2 min, USB) is the accepted cost of the free path.
- The CI workflow cannot be executed on this Windows machine; it is verified by YAML validity, a local `expo prebuild --platform ios --no-install` config check, and must be confirmed by the first real GitHub Actions run (user step).
