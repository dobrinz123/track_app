# iOS without a Mac: Windows-host development and on-track workflow

Canonical guide for developing and running this app on an **iPhone**, entirely from a **Windows** machine with no Mac and no Xcode. This is the primary supported workflow (see `docs/decisions/ADR-0004-no-mac-ios-workflow.md`); Android remains supported and documented second (see the root `README.md`).

Binding source: `docs/decisions/ADR-0004-no-mac-ios-workflow.md` (including its Amendment) and `docs/decisions/ADR-0003-ios-primary-target.md`. If anything here conflicts with those ADRs, the ADRs win.

**Two distinct workflows, don't mix them up:**

- **Development (Expo Go)** — fast iteration loop while building. Requires Metro running on your Windows machine and the iPhone on the same Wi-Fi (or a tunnel). **Not viable at the circuit** — there is no PC, Metro, or Wi-Fi on-track.
- **On-track (standalone EAS build)** — the app you actually drive with. Installed once from Windows via EAS, then runs **fully offline**: no PC, no Wi-Fi, no Metro needed for a session. This is the primary on-track workflow and the build type required for the real-track validation checklist.

---

## 1. Prerequisites (Windows)

- Windows 11 (or 10), no Xcode/macOS required.
- **Node.js 24.x** and **npm 11.x**.
- The **Expo Go** app installed on your iPhone from the App Store (for the development loop only).
- For the standalone build: either an Apple Developer Program account, or a free Apple ID plus AltStore or Sideloadly on Windows (see §5).

## 2. Install

From the repo root:

```
npm install
```

This installs and links all workspaces (`packages/core`, `apps/mobile`) from the root — do not run `npm install` inside `apps/mobile` directly.

## 3. Development loop: Expo Go on the iPhone, Metro on Windows

Use this for day-to-day development and replay verification. **Development-only — not viable on-track** (no PC/Metro/Wi-Fi at the circuit).

From the repo root:

```
cd apps/mobile
npx expo start
```

This starts the Metro bundler and prints a QR code in the terminal.

- Open the iPhone's **Camera app** (not Expo Go directly) and point it at the QR code.
- Tap the notification banner that appears — it opens the project in **Expo Go**.

### Tunnel variant (restrictive networks)

If the iPhone and the Windows machine cannot reach each other on the local network (corporate/guest Wi-Fi, VPN, hotel networks, isolated SSIDs), use a tunnel instead:

```
npx expo start --tunnel
```

This routes the connection through Expo's tunnel service instead of relying on LAN discovery. Slower to connect and slightly higher latency on reload, but works across networks that block local device discovery.

### What works in Expo Go, and the Info.plist caveat

Per the dependency audit in ADR-0004: **every dependency in `apps/mobile/package.json` is Expo Go-compatible on SDK 57.** No custom native code, no dev client required for the MVP. In Expo Go you get the full app — foreground GNSS location, motion sensors, local persistence, screen keep-awake, the full replay/dashboard flow, and the dev replay screen.

**Caveat (documented, acceptable per ADR-0004): the Info.plist customizations in `app.json` do NOT apply inside Expo Go.** Expo Go is itself a signed app with its own bundled Info.plist, so:

- The custom `NSLocationWhenInUseUsageDescription` copy (ADR-0003 §2) is **not** shown — the permission prompt uses Expo Go's own generic copy instead.
- The temporary full-accuracy request (`NSLocationTemporaryUsageDescriptionDictionary`, purpose key `TrackSession`, ADR-0003 §2) does **not** trigger through Expo Go's Info.plist.

Precise-accuracy behavior and the exact permission copy **must be verified on a standalone build** — see §4–6. Foreground-only design (no `UIBackgroundModes: location`, per ADR-0003 §1) means there is no background-mode gap between Expo Go and a standalone build.

### Running the dev replay screen on-device

The dev replay screen streams a deterministic fixture through the production pipeline (matcher → crossings → state machine → timing → delta) so you can validate app behavior without driving. With Metro running and the app open in Expo Go on the iPhone: navigate to the dev replay screen, select a fixture, and start playback. This is the fastest iteration loop for UI and state-machine work and requires no track time.

## 4. Building the standalone app: EAS Build

The on-track app is built in Expo's cloud (EAS) — no local Xcode is ever needed. `eas.json` defines three profiles:

| Profile | Purpose | Output |
|---|---|---|
| `development` | Dev-client build, only if a custom dev client is ever needed (not required for the MVP) | Installable dev-client app |
| `preview` | Internal-distribution `.ipa` | The artifact used for **free sideloading** (§5b) or ad-hoc install |
| `production` | App Store / TestFlight distribution build | The artifact submitted to TestFlight (§5a) |

One-time setup:

```
npm i -g eas-cli
eas login
eas build:configure
```

`eas build:configure` creates `eas.json` in the project.

Build the artifact for your chosen install path:

```
eas build --platform ios --profile production   # for TestFlight/ad-hoc, §5a
eas build --platform ios --profile preview       # for free sideloading, §5b
```

Once a build completes, EAS provides a download link (or, for `production`, a submission path to App Store Connect via `eas submit`) — download the resulting `.ipa` for sideloading, or submit it for TestFlight.

## 5. Installing the standalone build (two paths, both from Windows)

### (a) Paid, recommended: Apple Developer Program + TestFlight

**The only paid/credential dependency in this entire project: an Apple Developer Program membership ($99/yr)** — required by Apple for any distributable iOS build (TestFlight or ad-hoc). EAS can manage signing certificates and provisioning profiles automatically once you supply those Apple Developer credentials during `eas build`. EAS's free tier build queue is sufficient for this project's cadence.

1. Build with `--profile production` (§4).
2. Submit to App Store Connect / TestFlight (via `eas submit` or by following the prompts from `eas build`).
3. On the iPhone, install the **TestFlight** app from the App Store if not already present.
4. Accept the TestFlight invite (email or public link) associated with the build.
5. Install the app through TestFlight.

No re-signing churn — builds last per normal App Store Connect / TestFlight rules. This is the recommended path for anything beyond short-term personal testing, and it's the build type the real-track validation checklist expects by default.

### (b) Free: sideloading with AltStore or Sideloadly

No paid account required — works with a free Apple ID. Trade-off: Apple limits free-account app signatures to **7 days**, after which the app expires and stops launching.

1. Build with `--profile preview` (§4) to get the internal-distribution `.ipa`.
2. Download the `.ipa` to your Windows machine.
3. Install **AltStore** or **Sideloadly** on Windows and sideload the `.ipa` to the iPhone using your free Apple ID.
4. **The app expires every 7 days** and must be re-signed/reinstalled:
   - AltStore can **auto-refresh** the signature, but only while the iPhone is on the **same network as the AltStore server** (your Windows machine, or wherever AltServer is running) — it will not auto-refresh at the circuit.
   - Without auto-refresh, re-sideload manually before the 7-day window lapses (e.g. the night before a track day).
5. **3-app limit** applies per free Apple ID — sideloading counts against Apple's per-account free-signature app cap, so free-account users may need to remove other sideloaded apps to make room.

Fine for personal testing; not a suitable long-term or team distribution path — prefer (a) for anything beyond short-term use.

## 6. On-track usage builds

Per ADR-0004 §3: **on-track sessions and the real-track validation pass MUST use the standalone EAS-built app (TestFlight, ad-hoc, or a sideloaded preview `.ipa`) — never Expo Go.** This is required for two independent reasons:

1. **Offline operation** — there is no Metro/PC/Wi-Fi at the circuit; Expo Go depends on all three.
2. **Configuration correctness** — only a standalone build has ADR-0003's Info.plist and precise-accuracy configuration actually in effect (see the Expo Go caveat in §3).

The real-track validation checklist (`docs/verification/real-track-validation-checklist.md`) assumes a standalone build installed from Windows via one of the two paths in §5, and records which path was used.

## 7. Offline on-track operation

Once installed via §5, the app needs **no PC, no Wi-Fi, and no Metro** to run a timed session. Per the ADR-0004 Amendment:

- The release build embeds the Hermes JS bundle — there is no Metro server to reach at runtime.
- The Transilvania Motor Ring circuit profile is a **statically imported JSON asset**, compiled into that bundle at build time (never fetched over the network at session start or during a lap).
- A timed session makes **zero network calls** on any session-critical path.

Integration (WP14) is the point where both properties are verified: static `require`/`import` of the TMR profile, and no network calls anywhere in the session-critical path. The real-track validation checklist includes an airplane-mode-with-GPS test (§8 below, and see the checklist itself) as the on-site confirmation of this property.

## 8. Troubleshooting

**QR code scans but nothing happens / "can't connect" in Expo Go (development loop only):**
- Confirm the iPhone and the Windows machine are on the same Wi-Fi network. Corporate, guest, or isolated networks often block device-to-device discovery.
- Switch to the tunnel variant: `npx expo start --tunnel` (see §3).

**Expo Go shows a version mismatch / "this project requires a newer version of Expo Go" (or older):**
- This app targets **Expo SDK 57**. Expo Go on the iPhone must support SDK 57 — update Expo Go from the App Store to the latest version.
- If Expo Go's latest App Store version no longer supports SDK 57 (Expo Go typically supports only the current and a small number of recent SDKs), the standalone build (§4–5) becomes the only way to run the app on that device; note this as a limitation for future SDK upgrades.

**Metro starts but the app never loads / times out (development loop only):**
- Re-scan the QR code; Metro's QR encodes a session-specific URL that can go stale after a restart.
- Try the tunnel variant even on a shared network — some routers block the mDNS/LAN discovery Expo Go relies on for local connections.

**Permission prompt copy looks generic, not the app's custom copy:**
- Expected inside Expo Go — see the Info.plist caveat in §3. This is not a bug; verify the real copy on a standalone build instead.

**Sideloaded app stopped launching:**
- Expected after 7 days on a free Apple ID sideload (§5b) — re-sign/reinstall via AltStore/Sideloadly, or switch to the paid TestFlight path (§5a) to avoid the recurring expiry.

## See also

- `docs/decisions/ADR-0004-no-mac-ios-workflow.md` — the binding decision this guide implements, including the Amendment on standalone-build-primary and sideloading.
- `docs/decisions/ADR-0003-ios-primary-target.md` — iOS platform configuration (Location accuracy, Info.plist, permissions).
- `docs/verification/real-track-validation-checklist.md` — physical on-track validation protocol (requires a standalone build).
- Root `README.md` — quickstart and full docs index.
