# iOS without a Mac: free sideload workflow (Windows-host, no Apple Developer account)

Canonical guide for building, installing, and running this app on an **iPhone**, entirely
from a **Windows** machine with no Mac and no Xcode, and with **no paid Apple Developer
account**. This guide assumes you have never sideloaded an app before — every step is
spelled out.

Binding source: `docs/decisions/ADR-0005-free-install-path.md` (supersedes the Expo Go
dev-loop portion of `docs/decisions/ADR-0004-no-mac-ios-workflow.md`) and
`docs/decisions/ADR-0003-ios-primary-target.md`. If anything here conflicts with those
ADRs, the ADRs win.

---

## a. What changed

Expo Go — the "scan a QR code, run the app instantly" development app — has been retired
from the App Store for this project's Expo SDK version (SDK 57): Expo stopped submitting
new Expo Go builds after SDK 55, with no SDK 57 release planned (source: Expo changelog,
"Expo Go and the App Store", May 2026 — https://expo.dev/changelog/expo-go-and-app-store-may-2026,
accessed 2026-08-06; full sourced packet: `.foreman/scratch/free-ios-install-research.md`). Since
our app targets SDK 57, Expo Go can no longer run it at all, on any device.

**This means sideloaded builds are now both the dev loop and the on-track path** — there
is no more "fast Expo Go loop for development, standalone build for the track" split.
Instead:

- A GitHub Actions workflow (macOS runner, free/unlimited on public repos) builds two
  **unsigned** `.ipa` files: a Release build (the on-track app) and a dev-client build
  (the fast-iteration dev loop, using `expo-dev-client`).
- You sideload either one to your iPhone from Windows using **Sideloadly** and your
  **free Apple ID** — no $99/yr Apple Developer Program membership required.
- The trade-off: a free-Apple-ID signature is only valid for **7 days**, so sideloaded
  apps need periodic re-signing (§d).

## b. One-time setup

Do these once, in order.

1. **Create a free GitHub account**, if you don't already have one: go to
   [github.com/join](https://github.com/join) and follow the signup flow.

2. **Create a GitHub repository** for this project.
   - **Recommended: make it PUBLIC.** GitHub Actions macOS runners are free and
     effectively unlimited on public repositories.
   - If you'd rather keep it **private**, that's fine too — private repos get roughly
     **200 free macOS Actions minutes/month**, which is enough for a build every few
     days but not unlimited. (The repo contains no secrets or credentials — see
     `docs/decisions/ADR-0005-free-install-path.md` §Consequences.)

3. **Push this repo to your new GitHub remote.** From the repo root, on Windows:

   ```
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```

   (Replace `<your-username>/<your-repo>` with your actual GitHub path, and `main` with
   your default branch name if different.)

4. **Enable Actions** on the repository (usually on by default for a repo you created
   and pushed to yourself; if you forked instead, go to the **Actions** tab and click
   the button to enable workflows).

5. **Run the build workflow:**
   - Go to the **Actions** tab on GitHub.
   - Click **"Build unsigned iOS"** in the left-hand workflow list.
   - Click **"Run workflow"** (top-right dropdown button).
   - Choose the branch and the `variant` input (`release`, `dev-client`, or `both` —
     `both` is the default and what you want the first time).
   - Click the green **"Run workflow"** button.
   - Wait for the run to finish — a macOS runner building both variants typically takes
     somewhere in the range of 10–20 minutes; watch the run's progress on the Actions
     tab.

6. **Download the `.ipa` artifact(s):** once the run finishes (green check), open the
   run's summary page and scroll to the **Artifacts** section at the bottom.
   Download `CircuitTimer-release-unsigned` and/or `CircuitTimer-devclient-unsigned`
   (each is a zip containing the `.ipa`) to your Windows machine and unzip it.

7. **Install Sideloadly** on Windows: go to [sideloadly.io](https://sideloadly.io) and
   download/install the Windows build.

8. **Install iTunes from Apple's website** if you don't already have it —
   `apple.com/itunes` (or Apple's support download page). **Important:** Sideloadly
   needs the classic desktop iTunes installer, **not** the Microsoft Store version of
   iTunes — the Store version doesn't expose the drivers Sideloadly needs to talk to
   your iPhone over USB.

9. **Connect your iPhone to the Windows PC via USB cable.** Unlock the phone. When the
   **"Trust This Computer?"** prompt appears on the iPhone, tap **Trust** and enter your
   passcode if asked.

## c. Installing / re-signing with Sideloadly

Do this the first time you install a build, and again every time you re-sign (§d).

1. Open **Sideloadly** on Windows, with the iPhone still connected via USB.
2. **Drag and drop the `.ipa` file** (e.g. `CircuitTimer-release-unsigned.ipa`) into the
   Sideloadly window.
3. Confirm your iPhone is selected in the device dropdown near the top of the window.
4. In the **Apple ID** field, enter the email address of your free Apple ID.
5. Click **Start**.
6. Sideloadly will prompt for your Apple ID password to sign the app. **If your Apple
   ID has two-factor authentication (2FA) enabled** (it should), a normal password
   prompt may fail — generate an **app-specific password** at
   [appleid.apple.com](https://appleid.apple.com) (Sign-In and Security →
   App-Specific Passwords) and use that instead.
7. Wait for Sideloadly to finish signing and installing — it shows progress in the
   window; this normally takes well under a minute once the password is accepted.

**First-install phone steps** (only needed the first time you install this specific
Apple ID's signature on the device, not on every re-sign):

8. On the iPhone: **Settings → General → VPN & Device Management** (sometimes labeled
   **"Profiles & Device Management"**).
9. Tap your Apple ID entry under **"Developer App"**.
10. Tap **"Trust [your Apple ID]"**, then confirm **Trust** in the popup.
11. Launch the app from the Home Screen — it should open normally now.

**Notes:**

- **3-app limit:** a free Apple ID can have at most **3 apps** signed/installed via
  sideloading at once. If Sideloadly reports you're at the limit, remove an older
  sideloaded app first (**Settings → General → VPN & Device Management**, or delete it
  from the Home Screen) and try again.
- If 2FA keeps rejecting your normal password, that's the app-specific-password step
  above — it's the most common first-time snag.

## d. The 7-day cycle

A free Apple ID signature is only valid for **7 days** from the day you sign/install.

- **What expiry looks like:** the app icon stays on the Home Screen exactly as before.
  Tapping it either fails silently (brief launch flash, then back to the Home Screen)
  or shows an "Unable to Install/Verify App" style message. This is expected — it does
  not mean anything is broken.
- **The re-sign routine (~2 minutes):** repeat §c with the same `.ipa` file you already
  have (or a freshly downloaded one from a new workflow run — see §b step 5–6). Either
  way, as long as the app's **bundle identifier stays the same across builds**, your app
  data (settings, personal-best laps, session history) and any PBs are preserved across
  re-signs — iOS treats it as an update to the same app, not a new install.
  - The app's bundle identifier is set explicitly to `app.circuittimer.tmr` in
    `apps/mobile/app.json` — do not change it, or iOS will treat the next sideload as a
    brand-new app and your history/PBs will not carry over.
- **Suggestion:** set a **recurring calendar reminder every 6 days** (a one-day buffer
  before the hard 7-day cutoff) so you never show up at the circuit with an expired
  build. The night before a track day is a natural time to re-sign regardless.

## e. Dev loop with the dev-client build

This restores the fast-iteration "edit code, see it instantly on the phone" loop that
Expo Go used to provide — but now via a real sideloaded build.

1. Sideload the **dev-client** variant once, following §c
   (`CircuitTimer-devclient-unsigned.ipa`).
2. On Windows, from the repo root:

   ```
   cd apps/mobile
   npx expo start
   ```

   With `expo-dev-client` installed, this starts Metro in dev-client mode automatically.

3. Open the **sideloaded dev-client app** on the iPhone (not the release build — they're
   separate installs). It shows a "connect to server" screen; scan the QR code Metro
   printed, or enter the URL manually.
   - Phone and Windows machine must be on the **same Wi-Fi network** for local
     discovery to work.
   - On a restrictive network (corporate/guest Wi-Fi, hotel, isolated SSID), use
     `npx expo start --tunnel` instead.

4. **What works vs. the release build:** the dev-client build gives you Metro's fast
   refresh / hot reload and the dev menu, same as Expo Go used to — but unlike Expo Go,
   it's a real standalone build, so ADR-0003's actual Info.plist and precise-accuracy
   location configuration are in effect (no more "generic permission copy" caveat).
   It still needs Metro/PC/Wi-Fi to do anything, so it remains **development-only, not
   viable on-track**. It also carries the same free-Apple-ID **7-day signature expiry**
   as the release build (§d) — re-sign it the same way when it lapses.

## f. Paid alternative (optional): TestFlight / EAS

If you'd rather not deal with the 7-day re-sign cycle, an **Apple Developer Program**
membership ($99/yr) unlocks EAS-built TestFlight distribution with no signature expiry.
This is entirely optional and not part of the free path documented above — see
`apps/mobile/eas.json` for the existing build profiles (`development`, `preview`,
`production`) if you want to pursue this later. Not covered further here; the free
Sideloadly path above is the reference install path for this project.

## Offline on-track operation

Once installed via §c, the app needs **no PC, no Wi-Fi, and no Metro** to run a timed
session (this applies to the Release build; the dev-client build still needs Metro, see
§e):

- The release build embeds the Hermes JS bundle — there is no Metro server to reach at
  runtime.
- The Transilvania Motor Ring circuit profile is a **statically imported JSON asset**,
  compiled into that bundle at build time (never fetched over the network at session
  start or during a lap).
- A timed session makes **zero network calls** on any session-critical path.

The real-track validation checklist (`docs/verification/real-track-validation-checklist.md`)
includes an airplane-mode-with-GPS test as the on-site confirmation of this property.

## Troubleshooting

**Sideloaded app stopped launching / icon present but nothing happens:**
- Expected after 7 days on a free Apple ID sideload (§d) — re-sign via Sideloadly (§c).

**Sideloadly can't see my iPhone:**
- Confirm the iPhone is unlocked and you tapped **Trust** on the "Trust This Computer?"
  prompt (§b step 9). Try a different USB cable/port — some cables are charge-only.
- Confirm iTunes (the Apple.com installer, not the Microsoft Store one) is installed —
  Sideloadly depends on its drivers (§b step 8).

**Sideloadly rejects my Apple ID password:**
- If your Apple ID has 2FA (it should), use an app-specific password from
  [appleid.apple.com](https://appleid.apple.com) instead of your normal password (§c
  step 6).

**Sideloadly reports the 3-app signature limit:**
- Remove an older sideloaded app first (**Settings → General → VPN & Device
  Management** on the iPhone, or delete it from the Home Screen), then retry (§c note).

**Dev-client app shows "connect to server" but nothing loads:**
- Confirm the iPhone and Windows machine are on the same Wi-Fi network; corporate,
  guest, or isolated networks often block device-to-device discovery.
- Switch to the tunnel variant: `npx expo start --tunnel` (§e).

**Permission prompt copy looks generic, not the app's custom copy:**
- Shouldn't happen on either sideloaded build (Release or dev-client) — both are real
  standalone builds with ADR-0003's Info.plist in effect. If you see generic copy,
  double-check you're not accidentally running an old Expo Go install (Expo Go is
  retired for this SDK, see §a, and should be uninstalled).

**GitHub Actions workflow run fails or times out:**
- Check the failing step's log in the Actions tab. The workflow
  (`.github/workflows/build-unsigned-ios.yml`) has per-step timeouts and comments
  explaining each stage (prebuild, archive, package, upload) — the log output combined
  with those comments should localize the failure. This workflow's first real run on
  GitHub's macOS runners has not been executed as part of this change; only its YAML
  validity and the local `expo prebuild` config-plugin resolution have been verified —
  see the workflow file's own header comment for the scheme/workspace derivation this
  depends on.

## See also

- `docs/decisions/ADR-0005-free-install-path.md` — the binding decision this guide
  implements: unsigned CI builds + Sideloadly, replacing the Expo Go dev loop.
- `docs/decisions/ADR-0004-no-mac-ios-workflow.md` — prior ADR (Expo Go + EAS); its
  dev-loop portion is superseded by ADR-0005, its standalone-build/offline-operation
  reasoning still applies.
- `docs/decisions/ADR-0003-ios-primary-target.md` — iOS platform configuration
  (Location accuracy, Info.plist, permissions).
- `docs/verification/real-track-validation-checklist.md` — physical on-track validation
  protocol (requires a standalone build — Sideloaded or TestFlight).
- `.github/workflows/build-unsigned-ios.yml` — the CI workflow that builds the unsigned
  `.ipa` artifacts referenced throughout this guide.
- Root `README.md` — quickstart and full docs index.
