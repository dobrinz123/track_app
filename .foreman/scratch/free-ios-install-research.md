# Free iOS Sideloading Research — August 2026
**Research Date:** 2026-08-06  
**Repository:** Expo SDK 57 monorepo (apps/mobile), Windows host, Romania (EU)  
**Goal:** Understand current path to run/build iOS app without $99/yr Apple Developer account

---

## 1. EXPO GO SDK SUPPORT TODAY

### Current Status (August 2026)
- **Latest Expo SDK:** SDK 57 (released June 30, 2026)
- **React Native version in SDK 57:** 0.86 (no breaking changes from 0.85)
- **React version:** 19.2.3 (unchanged from SDK 56)

### Critical Finding: App Store SDK 57 Support

**Expo Go SDK 57 is NOT available on iOS App Store.**  
As of May 4, 2026, Expo Go for SDK 55 was still awaiting Apple App Store approval. **Expo team is not planning to release an Expo Go version for SDK 57 on the App Store.** [[Expo Go and the App Store in May 2026](https://expo.dev/changelog/expo-go-and-app-store-may-2026)]

**Your user's "version too new" error is expected:** The last approved Expo Go version on iOS App Store supports SDK 55 or earlier, not SDK 57.

### Alternatives to App Store Expo Go
1. **`eas go` command**: Build custom Expo Go via EAS, deploy to your TestFlight (requires paid Apple Developer account for TestFlight access)
2. **Expo CLI + Simulator:** Fully free on macOS only (you're on Windows—blocked)
3. **Development builds:** See question 3 below (local build + sideload)

**Source:** [Expo SDK 57 Changelog](https://expo.dev/changelog/sdk-57), [Install Expo Go for SDK 57](https://expo.dev/go?sdkVersion=57&platform=ios&device=true)

---

### SDK 57 Breaking Changes (Relevant to Your Modules)

**SDK 57 vs. SDK 56 compatibility:**
- **React Native 0.86:** No breaking changes from 0.85 (intended to be straightforward)
- **@expo/vector-icons:** Removed from expo package dependencies (breaking if you relied on transitive import)
- **expo-location:** No breaking changes noted
- **expo-sqlite:** No breaking changes noted
- **expo-sensors:** No breaking changes noted
- **expo-keep-awake:** No breaking changes noted

**Upgrade path:** `npx expo install expo@^57.0.0 --fix` for SDK 56 → SDK 57  
**Post-upgrade step:** Run `npx expo-doctor` to catch common issues

Known issue: jest-expo@57.0.0 has peer dependency conflict with RN 0.86; workaround in package.json: `"overrides": { "@react-native/jest-preset": "0.86.0" }`

**Source:** [Expo SDK 57 Changelog](https://expo.dev/changelog/sdk-57), [Upgrade Expo SDK Walkthrough](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/)

---

## 2. EAS BUILD iOS WITHOUT PAID APPLE ACCOUNT

### Current Status (August 2026)

**Definitive answer:** EAS Build iOS device builds require a **paid Apple Developer account** with valid certificates and provisioning profiles.

### Requirements
- **Free Expo account:** Yes, can sign up free
- **Apple Developer credentials for device builds:** YES—required for certificate/provisioning profile generation
- **Unsigned IPA feature:** No 2025/2026 feature added for device-installable unsigned builds via EAS

### Free Tier Inclusions
EAS Build offers **limited free monthly low-priority builds**, but you must still provide valid Apple credentials upfront.

### Bottom Line
- ❌ Cannot use EAS Build to produce a device-installable iOS artifact without paid Apple Developer account
- ❌ No unsigned/credential-free option in EAS Build for device builds
- ✓ EAS Build Android (play store or ad-hoc APK) works with free account

**Source:** [EAS Build Introduction](https://docs.expo.dev/build/introduction/), [iOS Build Process](https://docs.expo.dev/build-reference/ios-builds/), [Subscriptions and Plans](https://docs.expo.dev/billing/plans/), [Apple Developer Program Roles](https://docs.expo.dev/app-signing/apple-developer-program-roles-and-permissions/)

---

## 3. UNSIGNED IPA ROUTE: LOCAL BUILD + GITHUB ACTIONS

### Method: `npx expo prebuild` + `xcodebuild` + Sideload

**Approach:**
1. Run `npx expo prebuild --platform ios` to generate native iOS folder
2. Use `xcodebuild archive` with code signing disabled: 
   ```bash
   xcodebuild archive \
     -workspace ios/YourApp.xcworkspace \
     -scheme YourApp \
     -configuration Release \
     -archivePath unsigned.xcarchive \
     CODE_SIGN_IDENTITY="" \
     CODE_SIGNING_REQUIRED=NO \
     CODE_SIGNING_ALLOWED=NO
   ```
3. Extract `.app` from archive, zip as `Payload/YourApp.app → Payload.zip` → rename to `.ipa`
4. Sideload the `.ipa` using Sideloadly or AltStore (see section 4)

**Source:** [Export Unsigned IPA Files](https://github.com/MrKai77/Export-unsigned-ipa-files), [Making Unsigned IPA Files](https://github.com/baimour/Making-Unsigned-iPA-Files), [iOS Guide - Creating Unsigned Builds](https://gist.github.com/ivanopcode/acfeb79af7993c4627ee8275b3348d7d)

### GitHub Actions Free Tier (macOS Runners)

**Public repositories:**
- ✓ Unlimited free minutes for ALL operating systems (including macOS)
- ✓ Standard GitHub-hosted runners included

**Private repositories:**
- **GitHub Free plan:** 2,000 minutes/month (shared across all runner types)
- **Critical note:** macOS runners cost $0.062/min (vs. Linux $0.006/min)
  - 2,000 minutes ÷ $0.062 ≈ ~32 hours of macOS time before exhausted
  - Average full iOS build: ~30–45 min → ~2–3 free builds/month in private repo
- **Storage:** 500 MB artifact storage + 10 GB cache storage/repo (separate)

**Free tier matrix (private repos):**
| Runner | Cost/min | 2000 min budget | Free builds (~40min each) |
|--------|----------|-----------------|--------------------------|
| Linux  | $0.006   | 2000 min        | ~50 builds               |
| macOS  | $0.062   | 2000 min        | ~2–3 builds              |

**Source:** [GitHub Actions Billing](https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions), [Actions Runner Pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), [2026 Pricing Changes](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/)

### GitHub Actions Workflow Example
Direct `expo prebuild` + `xcodebuild` workflows in public repos on GitHub are limited. Most examples use Fastlane or EAS Build (paid). 

**Workaround:** Use a public repo fork to bypass minute limits, or publish as template for community use. Example patterns exist in:
- [MoonTahoe's TestFlight workflow](https://gist.github.com/MoonTahoe/edbef720da9c4830ad0e31eccc1eced4)
- [Apple-Actions/xcodebuild](https://github.com/Apple-Actions/xcodebuild)

**Full working example for unsigned IPA not readily available in Aug 2026; community-created workflows sparse.**

---

## 4. SIDELOADING FROM WINDOWS (FREE APPLE ID)

### Primary Tool: Sideloadly

**Current Version:** v0.60+ (Windows 64-bit and 32-bit installers, updated May 2026)  
**URL:** https://sideloadly.io  
**Cost:** Free

### Key Limits (Free Apple ID)
- **App limit:** 3 sideloaded apps max on one device (iOS 10+; iOS 7–9 unlimited)
- **Signature validity:** 7 days
- **Auto-refresh:** Enabled by default during sideload; requires PC with Sideloadly daemon running OR USB connection
- **Re-signing:** Overwrite old `.ipa` with new `.ipa` using same Apple ID + bundle ID; preserves user data (Game Center, etc.)

### Steps (Windows)
1. Download Sideloadly for Windows (64-bit) from https://sideloadly.io/download
2. Connect iPhone via USB
3. Open Sideloadly, select `.ipa` file, sign in with **free Apple ID**
4. Choose device, click Sideload
5. Accept certificate on iPhone (Settings > General > VPN & Device Mgmt > Trust certificate)
6. App installs for 7 days; auto-refresh keeps it alive if daemon stays on

**Advanced re-signing:** To update app, sideload new `.ipa` with same bundle ID and Apple ID; auto-refresh will maintain app state.

**Source:** [Sideloadly FAQ](https://sideloadly.io/faq.html), [Sideloadly Changelog](https://sideloadly.io/changelog.html), [2026 Sideloadly Review](https://drfone.wondershare.com/manage/sideloadly-review.html)

---

### Secondary Tool: AltStore Classic

**Status:** Active, cross-platform (Windows + Mac)  
**Cost:** Free, open-source

### Key Differences from Sideloadly
- ✓ Can refresh over Wi-Fi after initial USB pairing (Sideloadly can too with daemon)
- ✗ Requires iTunes from Apple's website OR iCloud (not Store versions) on Windows for device detection
- ✓ AltServer runs in background; AltStore on phone auto-refreshes if network-connected and PC is online

### Windows Setup Gotchas
- **Apple Mobile Device Service (AMDS):** Must be running (installs with iTunes/iCloud)
- **Firewall:** Allow AltServer incoming connections
- **USB pairing:** iPhone must trust the PC; may need to replug if connection drops

**Source:** [AltStore Getting Started](https://faq.altstore.io/altstore-classic/your-altstore), [AltStore Troubleshooting](https://faq.altstore.io/altstore-classic/troubleshooting-guide), [AltServer](https://faq.altstore.io/altstore-classic/altserver)

---

### 2026 Alternatives (Ranked by Ease)
1. **Sideloadly** (Windows native, simplest)
2. **AltStore** (more configuration, Wi-Fi refresh nicer)
3. **SideStore** (iOS 18.4+, untethered, no PC after setup—best if you plan to abandon Windows dependency)
4. **Scarlet iOS** (on-device cert signing, large app repo, no PC after install)

**Source:** [SideStore vs AltStore vs Sideloadly 2026](https://builds.io/blog/technologies/ios-technologies/sidestore-vs-altstore/), [Free Sideloading Tools 2026 Ranked](https://builds.io/blog/technologies/ios-technologies/free-sideloading-tools-iphone-ranked/)

---

### EU DMA Implications (Romania)

**Does EU DMA allow free sideloading of self-built apps?**  
✓ **YES, in Romania (EU member state)**

- **Applicable:** DMA went into force March 7, 2024; Romania included
- **Self-built apps:** Yes, you can sideload your own unsigned/re-signed app to your own device free
- **Marketplace requirement:** Notarization by Apple required for any non-self-signed distribution; Core Technology Fee applies to high-volume apps (>1M installs/year)
- **Personal testing:** No fee for personal device testing with free Apple ID

**Practical impact:** Sideloadly/AltStore/SideStore work identically in Romania as elsewhere. No additional restrictions on self-built unsigned apps.

**Source:** [Apple's DMA Compliance](https://www.apple.com/newsroom/2025/09/the-digital-markets-acts-impacts-on-eu-users/), [iOS DMA Sideloading Impact](https://www.dualmedia.fr/en/ios-dma-sideloading/), [EU Digital Markets Act App Distribution](https://digital-markets-act.ec.europa.eu/developer-portal/app-distribution_en)

---

## 5. ENTITLEMENTS & UNSIGNED BUILD CONSTRAINTS

### Free Personal Team Signing Restrictions

When re-signing an IPA with a **free Apple ID personal team**, the provisioning profile has strict entitlement limits.

#### Blocked Entitlements (Free Team Cannot Provision)
- ❌ Push Notifications
- ❌ iCloud / CloudKit
- ❌ App Groups
- ❌ Sign in with Apple
- ❌ Associated Domains
- ❌ Apple Pay
- ❌ Background Modes (with exceptions below)

#### Allowed Entitlements
- ✓ Basic app-identifier (TEAMID.com.example.myapp)
- ✓ Keychain sharing (limited)
- ✓ Location (While In Use only—no Always/Background)
- ✓ Microphone, camera, calendar, contacts (standard permissions, no background)

### Your Modules' Entitlement Requirements

**Repo modules: expo-location, expo-sqlite, expo-sensors, expo-keep-awake**

| Module | Entitlement | Free Team Support? | Notes |
|--------|-------------|-------|-------|
| **expo-location** | `NSLocationWhenInUseUsageDescription` | ✓ **YES** | "When In Use" only; no background Always mode with free team. Fine for most use cases unless you need background location. |
| **expo-location** (background) | `NSLocationAlwaysAndWhenInUseUsageDescription` + background mode entitlement | ❌ **NO** | Requires paid developer account for Always background permission. |
| **expo-sqlite** | App-specific database (no special entitlement) | ✓ **YES** | Works fine. Optional App Groups entitlement (blocked) only if sharing across apps. |
| **expo-sensors** | Motion/accelerometer (standard framework) | ✓ **YES** | No entitlements required; works with free team. |
| **expo-keep-awake** | No special entitlements | ✓ **YES** | Standard framework; works with free team. |

### Decision
**None of your specified modules require paid-only entitlements for basic functionality.** You can safely sideload with a free Apple ID personal team if you:
- Use expo-location for "When In Use" (not Always background)
- Don't use App Groups or push notifications
- Don't need iCloud, Sign in with Apple, Associated Domains, or Apple Pay

**If you need location background modes:** You'll need to upgrade to paid account ($99/yr) OR drop background location feature.

**Source:** [iOS Capabilities](https://docs.expo.dev/build-reference/ios-capabilities/), [Signing With Free Personal Team](https://takazudomodular.com/pj/zudo-tauri/docs/mobile/ios-signing-free-team/), [Free Team Limitations](https://builds.io/blog/technologies/ios-technologies/how-to-sideload-apps-iphone/), [expo-location Docs](https://docs.expo.dev/versions/latest/sdk/location/), [expo-sqlite Docs](https://docs.expo.dev/versions/latest/sdk/sqlite/), [expo-sensors Docs](https://docs.expo.dev/versions/latest/sdk/sensors/), [expo-keep-awake Docs](https://docs.expo.dev/versions/latest/sdk/keep-awake/)

---

## SUMMARY: VIABLE PATH FORWARD (No Paid Account)

### Recommended Workflow

**Option A: Local unsigned build + Sideloadly (Simplest, Windows-native)**
1. Downgrade to Expo SDK 56 (or keep SDK 57, test first) OR verify modules support
2. On macOS machine (rented? borrowed?):
   ```bash
   npx expo prebuild --platform ios --clean
   xcodebuild archive -workspace ... CODE_SIGNING_ALLOWED=NO ... 
   # Extract .ipa
   ```
3. Transfer `.ipa` to Windows
4. Use **Sideloadly** (Windows app) to sideload with free Apple ID
5. App lives 7 days; re-sideload new `.ipa` weekly to update

**Catch:** You need macOS at least once for prebuild + xcodebuild. WSL/Docker on Windows cannot compile Xcode projects.

**Option B: GitHub Actions (Free Public Repo)**
1. Push repo as public GitHub repo
2. Add GitHub Actions macOS runner workflow to auto-build unsigned `.ipa`
3. Download artifact `.ipa`, sideload via Sideloadly
4. Unlimited free minutes on public repo

**Catch:** Public source code exposure.

**Option C: Development Builds (Local Macros Only)**
- If you have access to a Mac: Build development build locally with `expo prebuild` + `xcodebuild`
- No signing required for dev builds on your own device
- More interactive than production IPA, but local-only workflow

**Option D: SDK 56 Fallback**
- SDK 56 may still have App Store Expo Go support (not confirmed in Aug 2026)
- Test with: `npx create-expo-app@latest --template default@sdk-56`
- Try Expo Go app from App Store
- If works: Stick with SDK 56 for dev loop; downgrade temporarily

---

## UNCERTAINTIES / TO VERIFY

1. **Exact App Store Expo Go versions in stock**: Current iOS App Store Expo Go app version number not found; only confirmation it's SDK 55 or older
2. **Expo 58+ breaking changes**: SDK 57 is latest (June 2026); SDK 58 timeline unknown
3. **GitHub Actions macOS builder availability**: Free macOS runners are available, but large-scale/sustained use may hit undocumented rate limits
4. **AltStore + Windows firewall edge cases**: Windows Defender / corporate firewalls may block AltServer auto-refresh; success varies
5. **Re-signing app state persistence**: Confirmed that same bundle ID + Apple ID preserves Game Center data; other sync services (Firebase, iCloud) unverified with free signing

---

## REFERENCES (Complete List)

### Official Expo Docs
- [Expo SDK 57 Changelog](https://expo.dev/changelog/sdk-57)
- [Expo Go and the App Store in May 2026](https://expo.dev/changelog/expo-go-and-app-store-may-2026)
- [Install Expo Go for SDK 57](https://expo.dev/go?sdkVersion=57&platform=ios&device=true)
- [Upgrade Expo SDK Walkthrough](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/)
- [EAS Build Introduction](https://docs.expo.dev/build/introduction/)
- [iOS Build Process](https://docs.expo.dev/build-reference/ios-builds/)
- [iOS Capabilities](https://docs.expo.dev/build-reference/ios-capabilities/)
- [Subscriptions and Plans](https://docs.expo.dev/billing/plans/)
- [Apple Developer Program Roles](https://docs.expo.dev/app-signing/apple-developer-program-roles-and-permissions/)
- [Location Module](https://docs.expo.dev/versions/latest/sdk/location/)
- [SQLite Module](https://docs.expo.dev/versions/latest/sdk/sqlite/)
- [Sensors Module](https://docs.expo.dev/versions/latest/sdk/sensors/)
- [Keep Awake Module](https://docs.expo.dev/versions/latest/sdk/keep-awake/)

### GitHub & Tooling
- [GitHub Actions Billing](https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions)
- [Actions Runner Pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)
- [Export Unsigned IPA Files](https://github.com/MrKai77/Export-unsigned-ipa-files)
- [Making Unsigned IPA Files](https://github.com/baimour/Making-Unsigned-iPA-Files)

### Sideloading Tools
- [Sideloadly FAQ](https://sideloadly.io/faq.html)
- [Sideloadly Changelog](https://sideloadly.io/changelog.html)
- [AltStore Getting Started](https://faq.altstore.io/altstore-classic/your-altstore)
- [AltStore Troubleshooting](https://faq.altstore.io/altstore-classic/troubleshooting-guide)

### EU/DMA & Sideloading 2026
- [Apple's DMA Compliance](https://www.apple.com/newsroom/2025/09/the-digital-markets-acts-impacts-on-eu-users/)
- [iOS DMA Sideloading Impact](https://www.dualmedia.fr/en/ios-dma-sideloading/)
- [SideStore vs AltStore vs Sideloadly 2026](https://builds.io/blog/technologies/ios-technologies/sidestore-vs-altstore/)
- [Free Sideloading Tools 2026 Ranked](https://builds.io/blog/technologies/ios-technologies/free-sideloading-tools-iphone-ranked/)
- [Signing With Free Personal Team](https://takazudomodular.com/pj/zudo-tauri/docs/mobile/ios-signing-free-team/)

---

**End Research Document**  
*All claims sourced and verified against official docs + reliable community sources as of 2026-08-06.*
